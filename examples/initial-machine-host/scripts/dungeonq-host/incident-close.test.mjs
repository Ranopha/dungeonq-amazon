// DQ-HANDOFF-015 M7 結束協調器測試（C-1～C-5）。全部使用暫存目錄與人工合成資料；錨點只用測試建立的本機倉庫；
// 不寄任何通知（通知與真人核准都是假實作），不呼叫模型，不連外。
// 執行：node --import tsx --test scripts/dungeonq-host/incident-close.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dungeonqTargetRelativePath } from '../../plugins/dungeonq-host-integration/src/contracts.ts';
import { startFileOrigin } from '../../plugins/dungeonq-host-integration/src/file-origin.ts';
import { createDungeonqResponseExecutors, openDungeonqResponseConnector } from '../../plugins/dungeonq-host-integration/src/response-actions.ts';
import { captureTargetWitness, installHostLayout } from '../../plugins/dungeonq-host-integration/src/target-witness.ts';
import { openRuntimeStore } from '../../vendor/dungeonq-runtime/runtime/store.mjs';
import { worldDigest } from '../../vendor/dungeonq-runtime/world/kernel.mjs';
import { generateSealKey, SEAL_PUBLIC_KEY } from './evidence-sealer.mjs';
import { CASE_FILES, CONTEXT_ACCOUNT_ASSET_PREFIX, createM1SealerPort, decideFenceDisposition, deriveAffectedRecipients, INCIDENT_CLOSE_STEPS,
  openIncidentClose, readCloseJournal, readIncidentCloseStatus, verifyIncidentCase } from './incident-close.mjs';
import { createJournalWorldPort, createLegitConsumerPort, createRuntimeRevocationPort } from './incident-local-ports.mjs';
import { RESPONSE_WIRING_CONTEXT_ACCOUNT_PREFIX } from './response-wiring.mjs';
import { openDungeonqWorkOrderStore } from './work-order.mjs';
import { buildDrillCandidate, buildIncidentTraces, buildRuleCandidates, canonicalJson, checkSensitiveContent, evaluateRule, extractAttackPattern,
  openCandidateStore, POST_INCIDENT_SECTIONS, reportHeadings, sectionHeading } from './incident-review.mjs';

const INCIDENT = 'inc-m7-unit';
const CLOSE_SCRIPT = fileURLToPath(new URL('./incident-close.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../../docs/templates/dungeonq-post-incident.md', import.meta.url));
const token = () => randomBytes(32).toString('base64url').replaceAll('-', 'x');
const healthy = () => ({ measuredAt: new Date().toISOString(), sampleCount: 10, baseline: { successRate: 1, p95LatencyMs: 10 },
  current: { successRate: 1, p95LatencyMs: 10 } });
const legitReport = () => {
  const segment = { count: 10, successes: 10, successRate: 1, p50LatencyMs: 3, p95LatencyMs: 5 };
  return { schemaVersion: 'dungeonq.legit-consumer-report/v1', consumerId: 'legit-1', startedAt: new Date(Date.now() - 60_000).toISOString(),
    probe: { operation: 'read', intervalMs: 1000 }, sampleCount: 30, segments: { BEFORE: segment, DURING: segment, AFTER: segment }, complete: true };
};
const rootCause = Object.fromEntries(['detection', 'wrongTicket', 'notification', 'response', 'documentation'].map(key => [key,
  { finding: `合成測試的${key}發現`, improvement: `合成測試的${key}改善`, owner: 'DungeonQ 維護者' }]));

function closeInput({ incidentId = INCIDENT, contexts = ['ctx-a'], verdict = 'REAL_INTRUSION', flaggedOwners = [] } = {}) {
  return { incidentId, contexts, verdict, severity: 'HIGH', identityConfirmed: false, isolation: 'LOCAL_PROOF_KERNEL', rootCause,
    followUps: [{ item: '把 FENCE 去留規則移入處置動作政策', owner: 'DungeonQ 維護者', due: '2026-11-30' }],
    notification: { contact: 'DungeonQ 值班管理員', directory: { legitimateConsumers: [{ recipientId: 'owner-legit-1', consumerId: 'legit-1' }],
      flaggedSubjectOwners: flaggedOwners } } };
}

/**
 * 一個合成事件：ctx-a 被導入假世界，依序 snapshot → read → issue-ticket → use-ticket（每步相隔 1 秒）。
 * extra：同一事件另外仍在運作的 context；legit：掛上合法消費者替身（記錄停止順序與健康量測當下是否仍在運作）。
 */
function lab(t, { verdict = 'REAL_INTRUSION', operations = true, flaggedOwners = [], extra = [], legit = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dq-m7-close-')); chmodSync(root, 0o700);
  const db = join(root, 'host', 'runtime.sqlite'); const sealDir = join(root, 'sealer'); const anchor = join(root, 'anchor');
  const caseDir = join(root, 'case');
  mkdirSync(anchor); execFileSync('git', ['init', '-q', '-b', 'main', anchor]);
  generateSealKey(sealDir);
  let fake = Date.now() - 60_000;
  const store = openRuntimeStore({ path: db, clock: () => fake ?? Date.now() });
  const contextToken = token();
  store.registerContext({ contextId: 'ctx-a', tenantId: 'reference', worldId: 'world', disposition: 'DIVERT', token: contextToken });
  for (const contextId of extra) store.registerContext({ contextId, tenantId: 'reference', worldId: 'world', disposition: 'DIVERT', token: token() });
  let wire = null; let acceptedAt = null;
  if (operations) {
    const step = (requestId, operation, args = {}) => { fake += 1000; return store.execute({ contextId: 'ctx-a', family: 'http', requestId, operation, args }); };
    step('op-1', 'snapshot'); step('op-2', 'read', { key: 'welcome' });
    wire = step('op-3', 'issue-ticket', { maxUses: 2 }).ticket; step('op-4', 'use-ticket', { ticket: wire }); acceptedAt = fake;
  }
  fake = null;
  let intakeOpen = true;
  const log = [];
  let consumerRunning = true;
  const intake = { stop: async () => { log.push(['world.freeze', consumerRunning]); intakeOpen = false; }, isStopped: () => !intakeOpen };
  const registry = { registryId: 'm7-unit', registryVersion: '1', entries: ['ctx-a', ...extra].flatMap(id => [
    { targetId: `target:${id}`, kind: 'FLAGGED_CONTEXT', assetId: `context:${id}`, boundIncidentId: INCIDENT },
    { targetId: `account:${id}`, kind: 'ACCOUNT', assetId: `${CONTEXT_ACCOUNT_ASSET_PREFIX}${id}`, boundIncidentId: INCIDENT }]) };
  // 合法消費者替身：健康量測只在消費者仍運作時回傳即時數字；停止後回傳過期量測（政策判定為 UNKNOWN）。
  const legitHealth = async () => { log.push(['health', consumerRunning]); return consumerRunning ? healthy()
    : { ...healthy(), measuredAt: new Date(Date.now() - 120_000).toISOString() }; };
  const escalations = [];
  const connector = openDungeonqResponseConnector({ directory: join(root, 'ledger'), registry: () => registry,
    executors: createDungeonqResponseExecutors({ runtimeFence: store,
      fileOrigin: { origin: 'http://127.0.0.1:9', controlToken: 'c'.repeat(32), credentialAssetId: 'credential:file-origin-business' } }),
    health: { measure: async () => healthy() }, escalate: async escalation => { escalations.push(escalation); }, sleep: async () => {}, observationMs: 5000 });
  const evidence = {
    collect: async ({ contexts }) => {
      const recorded = store.evidence();
      return { facts: { realAssetReads: 0 }, artifacts: [
        { name: 'runtime-journal', data: { events: recorded.events, verifier: recorded.verifier } },
        { name: 'outbox', data: { configured: false, incidents: [], outbox: [] } },
        { name: 'origin-witness', data: { schemaVersion: 'synthetic-witness', admissions: [], targetReads: [] } },
        { name: 'ticket-uses', data: { tracking: true, uses: acceptedAt === null ? [] : [{ useId: 'ticket-use-1', seq: 1, contextId: contexts[0], entry: 'http',
          position: 'ARGUMENT', outcome: 'ACCEPTED', at: acceptedAt, spread: [], source: '127.0.0.1' }] } },
        { name: 'legit-health', data: legitReport() }
      ] };
    }
  };
  const sent = [];
  const ticketProbe = async ({ item }) => {
    if (item.contextId !== 'ctx-a' || wire === null) return { denied: true, code: 'TICKET_EPOCH_REVOKED' };
    try { store.execute({ contextId: 'ctx-a', family: 'http', requestId: `probe-${randomUUID()}`, operation: 'use-ticket', args: { ticket: wire } }); return { denied: false, code: 'ACCEPTED' }; }
    catch (error) { return { denied: true, code: error.code }; }
  };
  const ports = {
    world: createJournalWorldPort({ db, intake }),
    evidence,
    sealer: createM1SealerPort({ db, sealDir, anchorRepo: anchor, publicKeyPath: join(sealDir, SEAL_PUBLIC_KEY), gitTimeoutMs: 10_000, dbTimeoutMs: 500, pushBackoffMs: 10 }),
    revocation: createRuntimeRevocationPort({ store, probes: { ticket: ticketProbe } }),
    response: { connector, registry: () => registry, health: { measure: legit ? legitHealth : async () => healthy() },
      signal: { kind: 'WRONG_TICKET_USED', eventId: 'evt-m7-unit' } },
    notifier: { send: async message => { sent.push(message); return { status: 'SENT', receiptId: `receipt-${sent.length}` }; } },
    ...(legit ? { legitimate: createLegitConsumerPort({ consumer: {
      stop: async () => { log.push(['legit.stop', intakeOpen]); consumerRunning = false; return { stoppedAt: new Date().toISOString() }; },
      report: async () => ({ stoppedAt: consumerRunning ? null : new Date().toISOString() }) } }) } : {})
  };
  const input = closeInput({ verdict, flaggedOwners, contexts: ['ctx-a', ...extra] });
  const sensitiveValues = [contextToken, ...(wire ? [wire] : [])];
  let closed = false;
  const closeStore = () => { if (!closed) { connector.close(); store.close(); closed = true; } };
  t.after(() => { closeStore(); rmSync(root, { recursive: true, force: true }); });
  return { root, db, sealDir, anchor, caseDir, store, wire, contextToken, ports, input, sensitiveValues, sent, escalations, connector, closeStore, log, registry,
    open: (overrides = {}) => openIncidentClose({ directory: caseDir, input, ports: { ...ports, ...overrides }, sensitiveValues }),
    verify: () => verifyIncidentCase({ directory: caseDir, db, publicKey: join(sealDir, SEAL_PUBLIC_KEY), anchorRepo: anchor, gitTimeoutMs: 10_000, dbTimeoutMs: 500 }) };
}

const stepStates = status => Object.fromEntries(INCIDENT_CLOSE_STEPS.map(step => [step, status.steps[step].state]));
const journalKinds = caseDir => readCloseJournal(caseDir).entries.map(entry => entry.step ? `${entry.kind}:${entry.step}` : entry.kind);

/* ------------------------------------------------------------------ */
/* C-1：依序執行；任一步失敗就停在該步並標記                                 */
/* ------------------------------------------------------------------ */

test('C-1 正常路徑：五步依序完成，每步都有開始與完成紀錄，重跑不重做', async t => {
  const l = lab(t);
  const result = await l.open().run();
  assert.equal(result.status, 'CLOSED');
  const kinds = journalKinds(l.caseDir).filter(kind => kind.startsWith('STEP_'));
  assert.deepEqual(kinds, INCIDENT_CLOSE_STEPS.flatMap(step => [`STEP_STARTED:${step}`, `STEP_DONE:${step}`]));
  const order = readCloseJournal(l.caseDir).entries.filter(entry => entry.kind === 'STEP_DONE').map(entry => entry.step);
  assert.deepEqual(order, [...INCIDENT_CLOSE_STEPS]);
  const again = await l.open().run();
  assert.deepEqual([again.status, again.replayed], ['CLOSED', true]);
  assert.equal(readIncidentCloseStatus(l.caseDir).closed, true);
});

test('C-1 步驟 1 失敗（缺少必要證據）：停在封存，不撤權；補齊後重跑從步驟 1 繼續完成', async t => {
  const l = lab(t);
  const missing = { collect: async args => { const collected = await l.ports.evidence.collect(args);
    return { ...collected, artifacts: collected.artifacts.filter(artifact => artifact.name !== 'legit-health') }; } };
  const halted = await l.open({ evidence: missing }).run();
  assert.deepEqual([halted.status, halted.step, halted.code], ['HALTED', 'SEAL_EVIDENCE', 'EVIDENCE_ARTIFACT_MISSING']);
  assert.deepEqual(halted.detail, { missing: ['legit-health'] });
  assert.deepEqual(stepStates(readIncidentCloseStatus(l.caseDir)), { FREEZE: 'DONE', SEAL_EVIDENCE: 'FAILED', REVOKE: 'PENDING',
    FENCE_DISPOSITION: 'PENDING', NOTIFY_AFFECTED: 'PENDING', POST_INCIDENT_REVIEW: 'PENDING' });
  assert.equal(l.store.snapshot().contexts[0].state, 'FENCED', '第 0 步已封鎖攻擊方 context');
  assert.ok(!readCloseJournal(l.caseDir).entries.some(entry => entry.kind === 'REVOKED'), '封存失敗時不得進入撤權');
  const resumed = await l.open().run();
  assert.equal(resumed.status, 'CLOSED');
  assert.equal(readIncidentCloseStatus(l.caseDir).steps.SEAL_EVIDENCE.runs, 2);
});

test('C-1 步驟 1 失敗（匯出期間世界仍有新變動）：WORLD_CHANGED_DURING_EXPORT，未簽章', async t => {
  const l = lab(t);
  const racing = { collect: async args => {
    l.store.registerContext({ contextId: 'late-ctx', tenantId: 'reference', worldId: 'world', disposition: 'DIVERT', token: token() });
    return l.ports.evidence.collect(args); } };
  const halted = await l.open({ evidence: racing }).run();
  assert.deepEqual([halted.status, halted.step, halted.code], ['HALTED', 'SEAL_EVIDENCE', 'WORLD_CHANGED_DURING_EXPORT']);
  assert.deepEqual(readdirSync(l.sealDir).filter(name => name.startsWith('manifest-attestations')), []);
});

test('C-1 步驟 2 失敗（撤權讀回仍可用）：停在撤權並標記；修好後重跑不重複封鎖', async t => {
  const l = lab(t);
  const leaky = { ...l.ports.revocation, probe: async args => (args.item.kind === 'WRONG_TICKET_SET' ? { denied: false, code: 'SYNTHETIC_STILL_ALLOWED' }
    : l.ports.revocation.probe(args)) };
  const halted = await l.open({ revocation: leaky }).run();
  assert.deepEqual([halted.status, halted.step, halted.code], ['HALTED', 'REVOKE', 'REVOKE_READBACK_NOT_DENIED']);
  assert.deepEqual(halted.detail, { allowed: ['wrong-tickets:ctx-a'] });
  assert.deepEqual(stepStates(readIncidentCloseStatus(l.caseDir)), { FREEZE: 'DONE', SEAL_EVIDENCE: 'DONE', REVOKE: 'FAILED', FENCE_DISPOSITION: 'PENDING',
    NOTIFY_AFFECTED: 'PENDING', POST_INCIDENT_REVIEW: 'PENDING' });
  const resumed = await l.open().run();
  assert.equal(resumed.status, 'CLOSED');
  const fences = readCloseJournal(l.caseDir).entries.filter(entry => entry.kind === 'FREEZE_FENCE');
  assert.equal(fences.length, 1, 'context 只經政策封鎖一次');
});

test('C-1 步驟 3 失敗（FENCE 讀回不符）：停在 FENCE 去留並標記', async t => {
  const l = lab(t);
  const flipping = { ...l.ports.revocation, inventory: async args => {
    const value = await l.ports.revocation.inventory(args);
    const decided = readFileSync(join(l.caseDir, CASE_FILES.journal), 'utf8').includes('"FENCE_DECISION"');
    return decided ? { items: value.items.map(item => (item.kind === 'WORLD_CONTEXT' ? { ...item, state: 'ACTIVE' } : item)) } : value;
  } };
  const halted = await l.open({ revocation: flipping }).run();
  assert.deepEqual([halted.status, halted.step, halted.code], ['HALTED', 'FENCE_DISPOSITION', 'FENCE_READBACK_MISMATCH']);
  assert.deepEqual(stepStates(readIncidentCloseStatus(l.caseDir)).NOTIFY_AFFECTED, 'PENDING');
  assert.equal((await l.open().run()).status, 'CLOSED');
});

test('C-1 步驟 4 失敗（通知被拒）：停在通知並標記；結果不明記 UNKNOWN 且重跑不重寄', async t => {
  const l = lab(t, { verdict: 'FALSE_POSITIVE', flaggedOwners: [{ recipientId: 'owner-ctx-a', subject: 'context:ctx-a' }] });
  const rejecting = { send: async () => ({ status: 'REJECTED', code: 'MAILBOX_REJECTED' }) };
  const halted = await l.open({ notifier: rejecting }).run();
  assert.deepEqual([halted.status, halted.step, halted.code], ['HALTED', 'NOTIFY_AFFECTED', 'NOTIFICATION_REJECTED']);
  assert.deepEqual(stepStates(readIncidentCloseStatus(l.caseDir)).POST_INCIDENT_REVIEW, 'PENDING');
  let calls = 0;
  const unknown = { send: async () => { calls++; throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); } };
  const done = await l.open({ notifier: unknown }).run();
  assert.equal(done.status, 'CLOSED');
  assert.equal(calls, 1);
  const notifications = readCloseJournal(l.caseDir).entries.filter(entry => entry.kind === 'NOTIFICATION');
  assert.deepEqual(notifications.map(entry => [entry.recipientId, entry.status]), [['owner-ctx-a', 'REJECTED'], ['owner-ctx-a', 'UNKNOWN']]);
  assert.deepEqual(notifications[1].reasons, ['CONTEXT_FENCED', 'CONTEXT_REVOKED']);
  assert.equal(l.sent.length, 0, '預設假寄送器未被呼叫');
});

test('C-1 步驟 5 失敗（結案封存失敗）：停在事後檢討並標記；重跑後完成', async t => {
  const l = lab(t);
  const failing = { ...l.ports.sealer, attest: async args => (args.kind === 'CLOSE_RECORD' ? { status: 'HALTED', code: 'ANCHOR_UNAVAILABLE' } : l.ports.sealer.attest(args)) };
  const halted = await l.open({ sealer: failing }).run();
  assert.deepEqual([halted.status, halted.step, halted.code], ['HALTED', 'POST_INCIDENT_REVIEW', 'CLOSE_RECORD_SEAL_FAILED']);
  assert.deepEqual(stepStates(readIncidentCloseStatus(l.caseDir)), { FREEZE: 'DONE', SEAL_EVIDENCE: 'DONE', REVOKE: 'DONE', FENCE_DISPOSITION: 'DONE',
    NOTIFY_AFFECTED: 'DONE', POST_INCIDENT_REVIEW: 'FAILED' });
  assert.equal(readIncidentCloseStatus(l.caseDir).closed, false);
  assert.equal((await l.open().run()).status, 'CLOSED');
});

test('C-1 上限：同一步最多執行 3 次，第 4 次直接停止；中途改變結束輸入被拒', async t => {
  const l = lab(t);
  const broken = { readFreeze: async () => ({ frozen: false, journalSequence: 0, journalHead: '0'.repeat(64) }), freeze: async () => ({ frozen: false }) };
  for (let run = 1; run <= 3; run++) {
    const halted = await l.open({ world: broken }).run();
    assert.deepEqual([halted.step, halted.code], ['FREEZE', 'WORLD_FREEZE_NOT_CONFIRMED']);
  }
  const limited = await l.open({ world: broken }).run();
  assert.deepEqual([limited.step, limited.code], ['FREEZE', 'STEP_RUN_LIMIT']);
  assert.equal(readIncidentCloseStatus(l.caseDir).steps.FREEZE.runs, 3);
  assert.throws(() => openIncidentClose({ directory: l.caseDir, input: { ...l.input, verdict: 'DRILL' }, ports: l.ports }), error => error.code === 'CLOSE_INPUT_CHANGED');
  const hanging = { ...l.ports.world, readFreeze: () => new Promise(() => {}) };
  const other = lab(t);
  const started = Date.now();
  const timedOut = await openIncidentClose({ directory: other.caseDir, input: other.input, ports: { ...other.ports, world: hanging }, limits: { portTimeoutMs: 200 } }).run();
  assert.deepEqual([timedOut.code, timedOut.detail], ['PORT_TIMEOUT', { port: 'world.readFreeze' }]);
  assert.ok(Date.now() - started < 5000);
});

/* ------------------------------------------------------------------ */
/* 第 0 步（凍結）：合法消費者仍運作時封鎖攻擊方，再停止世界與合法消費者        */
/* ------------------------------------------------------------------ */

const freezeTrail = caseDir => readCloseJournal(caseDir).entries.filter(entry => entry.step === 'FREEZE')
  .map(entry => (entry.kind === 'READBACK' ? `READBACK:${entry.check}` : entry.kind));

test('第 0 步正向：合法消費者仍運作時經政策封鎖 context 並讀回，接著停止世界、最後停止合法消費者，之後才封存', async t => {
  const l = lab(t, { legit: true });
  // 量測經過非同步工作後才完成，判定時間必須在量測完成之後。
  const response = { ...l.ports.response, health: { measure: async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return l.ports.response.health.measure();
  } } };
  const result = await l.open({ response }).run();
  assert.equal(result.status, 'CLOSED', JSON.stringify(result));
  assert.deepEqual(readCloseJournal(l.caseDir).entries.filter(entry => entry.kind === 'STEP_DONE').map(entry => entry.step), [...INCIDENT_CLOSE_STEPS]);
  assert.equal(INCIDENT_CLOSE_STEPS[0], 'FREEZE');
  assert.deepEqual(freezeTrail(l.caseDir), ['STEP_STARTED', 'READBACK:CONTEXTS', 'POLICY_DECISION', 'FREEZE_FENCE', 'READBACK:CONTEXT_DENIED',
    'READBACK:WORLD_FROZEN', 'READBACK:LEGIT_CONSUMER', 'STEP_DONE']);
  const decision = readCloseJournal(l.caseDir).entries.find(entry => entry.kind === 'POLICY_DECISION');
  assert.deepEqual([decision.step, decision.purpose, decision.contextId, decision.effect, decision.healthStatus], ['FREEZE', 'EXECUTE_A_CLASS', 'ctx-a', 'ALLOW', 'HEALTHY']);
  assert.ok(decision.health.ageMs >= 0 && decision.health.ageMs < 5_000 && decision.health.sampleCount >= 5, '封鎖時的健康數字是即時的');
  // 順序：健康量測時合法消費者仍在運作 → 停止世界（消費者仍運作）→ 停止合法消費者（世界已停）；之後封存再次確認世界已停。
  assert.deepEqual(l.log.slice(0, 3), [['health', true], ['world.freeze', true], ['legit.stop', false]]);
  assert.ok(l.log.slice(3).every(([kind]) => kind === 'world.freeze'));
  assert.equal(result.results.FREEZE.journalSequence, result.results.SEAL_EVIDENCE.journalSequence, '凍結後到封存之間 journal 沒有新變動');
  assert.deepEqual(result.results.FREEZE.fenced, ['ctx-a']);
  assert.deepEqual(result.results.FREEZE.legitimateConsumer, { configured: true, stopped: true });
  // 第 2 步不再經政策封鎖，也不撤合法憑證以外的東西：只撤錯誤 ticket 等 epoch 綁定項目。
  assert.ok(!readCloseJournal(l.caseDir).entries.some(entry => entry.step === 'REVOKE' && entry.kind === 'POLICY_DECISION'));
  assert.equal((await l.verify()).verdict, 'VERIFIED');
});

test('第 0 步：仍有多個 ACTIVE context、政策只允許封鎖一個時停下並產生 B 級工單，不繞過政策；人封鎖後從第 0 步續跑', async t => {
  const l = lab(t, { extra: ['ctx-b'], legit: true });
  const workOrders = openDungeonqWorkOrderStore({ directory: join(l.root, 'work-orders'), responseLedger: l.connector.responseLedger });
  const halted = await l.open({ workOrders }).run();
  assert.deepEqual([halted.status, halted.step, halted.code], ['HALTED', 'FREEZE', 'FREEZE_CONTEXTS_REQUIRE_HUMAN'], JSON.stringify(halted.detail));
  assert.deepEqual([halted.detail.contexts, halted.detail.fenced], [['ctx-b'], ['ctx-a']]);
  assert.equal(halted.detail.workOrders.length, 1);
  const decisions = readCloseJournal(l.caseDir).entries.filter(entry => entry.kind === 'POLICY_DECISION');
  assert.deepEqual(decisions.map(entry => [entry.purpose, entry.contextId, entry.effect]), [['EXECUTE_A_CLASS', 'ctx-a', 'ALLOW'],
    ['EXECUTE_A_CLASS', 'ctx-b', 'DENY'], ['CREATE_WORK_ORDER', 'ctx-b', 'REQUIRE_APPROVAL']]);
  assert.match(decisions[1].reason, /^limit_exceeded:per_incident:/u);
  const summary = workOrders.summarizeIncident(INCIDENT);
  assert.deepEqual(summary.workOrders.map(row => [row.workOrderId, row.status, row.targetId]), [[halted.detail.workOrders[0].workOrderId, 'OPEN', 'account:ctx-b']]);
  const record = workOrders.get(halted.detail.workOrders[0].workOrderId);
  assert.equal(record.systemExecution, 'NONE');
  assert.match(record.requirements.notes, /\/api\/policy\/apply/u);
  // 不繞過政策：ctx-b 仍在運作；世界沒有停止、合法消費者沒有停止、封存沒有開始。
  assert.equal(l.store.snapshot().contexts.find(row => row.contextId === 'ctx-b').state, 'ACTIVE');
  assert.ok(!l.log.some(([kind]) => kind === 'world.freeze' || kind === 'legit.stop'));
  assert.deepEqual(stepStates(readIncidentCloseStatus(l.caseDir)).SEAL_EVIDENCE, 'PENDING');
  // 人還沒處理就重跑：同一張工單，不重複開單。
  const again = await l.open({ workOrders }).run();
  assert.deepEqual([again.step, again.code], ['FREEZE', 'FREEZE_CONTEXTS_REQUIRE_HUMAN']);
  assert.equal(again.detail.workOrders[0].workOrderId, halted.detail.workOrders[0].workOrderId);
  assert.equal(workOrders.summarizeIncident(INCIDENT).workOrders.length, 1);
  // 人依工單以 owner 核准流程封鎖 ctx-b（這裡以 store.fence 代表 /api/policy/apply 的 FENCE）後，從第 0 步續跑完成。
  l.store.fence({ contextId: 'ctx-b', reason: 'owner fence via work order' });
  const resumed = await l.open({ workOrders }).run();
  assert.equal(resumed.status, 'CLOSED', JSON.stringify(resumed));
  assert.equal(readIncidentCloseStatus(l.caseDir).steps.FREEZE.runs, 3);
  assert.deepEqual(resumed.results.FREEZE.alreadyFenced, ['ctx-a', 'ctx-b']);
  assert.deepEqual(l.log.filter(([kind]) => kind !== 'health').slice(0, 2), [['world.freeze', true], ['legit.stop', false]]);
});

test('第 0 步失敗（合法使用者健康不明）：停在第 0 步，不停止世界與合法消費者；恢復後從第 0 步續跑完成', async t => {
  const l = lab(t, { legit: true });
  const stale = { ...l.ports.response, health: { measure: async () => ({ ...healthy(), measuredAt: new Date(Date.now() - 120_000).toISOString() }) } };
  const halted = await l.open({ response: stale }).run();
  assert.deepEqual([halted.status, halted.step, halted.code], ['HALTED', 'FREEZE', 'FREEZE_FENCE_NOT_EXECUTED']);
  assert.match(halted.detail.reason, /^legitimate_health_unknown/u);
  assert.deepEqual(stepStates(readIncidentCloseStatus(l.caseDir)), { FREEZE: 'FAILED', SEAL_EVIDENCE: 'PENDING', REVOKE: 'PENDING',
    FENCE_DISPOSITION: 'PENDING', NOTIFY_AFFECTED: 'PENDING', POST_INCIDENT_REVIEW: 'PENDING' });
  assert.equal(l.store.snapshot().contexts[0].state, 'ACTIVE');
  assert.ok(!l.log.some(([kind]) => kind === 'world.freeze' || kind === 'legit.stop'), '失敗時世界與合法消費者都還在運作');
  const resumed = await l.open().run();
  assert.equal(resumed.status, 'CLOSED', JSON.stringify(resumed));
  assert.equal(readIncidentCloseStatus(l.caseDir).steps.FREEZE.runs, 2);
  assert.equal(l.store.snapshot().contexts[0].state, 'FENCED');
});

test('第 2 步不再封鎖 context：第 0 步之後 context 仍 ACTIVE 時停下並標記（REVOKE_CONTEXT_STILL_ACTIVE），不用過期健康判定', async t => {
  const l = lab(t);
  const flipping = { ...l.ports.revocation, inventory: async args => {
    const value = await l.ports.revocation.inventory(args);
    const frozen = readCloseJournal(l.caseDir).entries.some(entry => entry.kind === 'STEP_DONE' && entry.step === 'FREEZE');
    return frozen ? { items: value.items.map(item => (item.kind === 'WORLD_CONTEXT' ? { ...item, state: 'ACTIVE' } : item)) } : value;
  } };
  const halted = await l.open({ revocation: flipping }).run();
  assert.deepEqual([halted.step, halted.code, halted.detail], ['REVOKE', 'REVOKE_CONTEXT_STILL_ACTIVE', { contexts: ['context:ctx-a'] }]);
  assert.equal(readCloseJournal(l.caseDir).entries.filter(entry => entry.kind === 'POLICY_DECISION').length, 1, '只有第 0 步經政策封鎖');
});

test('合法消費者介面：停止後保留最後一份報告（子程序結束後仍可匯出），停止失敗可重試；前綴與登錄表一致', async () => {
  let exited = false; let failures = 1;
  const port = createLegitConsumerPort({ consumer: {
    stop: async () => { if (failures-- > 0) throw Object.assign(new Error('ipc'), { code: 'CONSUMER_IPC_TIMEOUT' }); exited = true;
      return { stoppedAt: '2026-10-20T00:00:00.000Z', sampleCount: 3 }; },
    report: async () => { if (exited) throw Object.assign(new Error('gone'), { code: 'CONSUMER_EXITED' }); return { stoppedAt: null, sampleCount: 2 }; } } });
  assert.deepEqual(await port.state(), { running: true, stoppedAt: null });
  await assert.rejects(port.stop(), error => error.code === 'CONSUMER_IPC_TIMEOUT');
  assert.deepEqual(await port.stop(), { stopped: true });
  assert.deepEqual(await port.state(), { running: false, stoppedAt: '2026-10-20T00:00:00.000Z' });
  assert.equal((await port.report()).sampleCount, 3);
  assert.equal(CONTEXT_ACCOUNT_ASSET_PREFIX, RESPONSE_WIRING_CONTEXT_ACCOUNT_PREFIX);
});

/* ------------------------------------------------------------------ */
/* C-2：外部驗證端能驗證封存證據；竄改任一事件會被偵測                          */
/* ------------------------------------------------------------------ */

/** 同機攻擊者：改 journal 一列，重算後續雜湊鏈並以本機 journal key 重算 HMAC（沿用 M1 做法）。 */
function rewriteRow(db, sequence, edit) {
  const key = readFileSync(`${db}.journal.key`); const handle = new DatabaseSync(db);
  try {
    const rows = handle.prepare('SELECT sequence, event_json FROM runtime_events ORDER BY sequence').all();
    let previous = JSON.parse(rows[sequence - 2].event_json).digest; handle.exec('BEGIN IMMEDIATE');
    for (const row of rows.slice(sequence - 1)) {
      const event = JSON.parse(row.event_json); if (row.sequence === sequence) edit(event); event.previousDigest = previous;
      const body = { ...event }; delete body.digest; delete body.authentication; event.digest = worldDigest(body);
      event.authentication = createHmac('sha256', key).update('journal-v2\0').update(event.digest).digest('base64url');
      handle.prepare('UPDATE runtime_events SET event_json=? WHERE sequence=?').run(JSON.stringify(event), row.sequence); previous = event.digest;
    }
    handle.exec('COMMIT');
  } finally { handle.close(); }
}
const kindsOf = report => report.findings.map(item => item.kind);

test('C-2 外部驗證：封存後可驗證；竄改證據檔、manifest、報告、結束紀錄或 journal 任一事件都被偵測', async t => {
  const l = lab(t);
  assert.equal((await l.open().run()).status, 'CLOSED');
  const clean = await l.verify();
  assert.equal(clean.verdict, 'VERIFIED', JSON.stringify(clean.findings));
  assert.equal(clean.evidenceIntegrity, 'SAME_HOST_SELF_ATTESTED');
  assert.equal(clean.closeRecord.status, 'VERIFIED');
  const publicKey = join(l.sealDir, SEAL_PUBLIC_KEY);
  const cli = spawnSync(process.execPath, ['--import', 'tsx', CLOSE_SCRIPT, 'verify', '--case', l.caseDir, '--db', l.db, '--public-key', publicKey,
    '--anchor-repo', l.anchor], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).verdict, 'VERIFIED');

  const tamper = async (relative, edit, expected) => {
    const path = join(l.caseDir, relative); const backup = `${path}.bak`; copyFileSync(path, backup);
    writeFileSync(path, edit(readFileSync(path, 'utf8')));
    const report = await l.verify();
    copyFileSync(backup, path); rmSync(backup);
    assert.equal(report.verdict, 'TAMPERED', relative);
    assert.ok(kindsOf(report).includes(expected), `${relative}: ${kindsOf(report).join(',')}`);
  };
  await tamper(`${CASE_FILES.evidenceDirectory}/ticket-uses.json`, text => text.replace('"ACCEPTED"', '"REFUSED"'), 'ARTIFACT_DIGEST_MISMATCH');
  await tamper(CASE_FILES.manifest, text => text.replace('"realAssetReads":0', '"realAssetReads":1'), 'MANIFEST_MISMATCH');
  await tamper(CASE_FILES.report, text => text.replace('DRILL', 'X').replace('真實越權', '演練'), 'CLOSE_FILE_DIGEST_MISMATCH');
  // 結束紀錄：改一列並把整條雜湊鏈重算（同機攻擊者做得到），已簽的結案封存仍偵測到。
  await tamper(CASE_FILES.journal, text => {
    let previous = 'ROOT';
    return `${text.split('\n').filter(Boolean).map(line => {
      const body = JSON.parse(line); delete body.hash;
      if (body.kind === 'FENCE_DECISION') body.decision = 'RELEASE_ELIGIBLE';
      body.previous = previous;
      const next = createHash('sha256').update(`dungeonq-incident-close-journal/v1\n${canonicalJson(body)}`).digest('hex'); previous = next;
      return JSON.stringify({ ...body, hash: next });
    }).join('\n')}\n`;
  }, 'CLOSE_JOURNAL_PREFIX_MISMATCH');
  assert.equal((await l.verify()).verdict, 'VERIFIED', '還原後再次驗證通過');

  l.closeStore();
  rewriteRow(l.db, 3, event => { event.at += 1; });
  const tampered = await l.verify();
  assert.equal(tampered.verdict, 'TAMPERED');
  assert.ok(kindsOf(tampered).includes('JOURNAL_TAMPERED'), kindsOf(tampered).join(','));
  assert.equal(tampered.findings.find(item => item.kind === 'JOURNAL_TAMPERED').firstMismatch.sequence, 3);
  const status = spawnSync(process.execPath, ['--import', 'tsx', CLOSE_SCRIPT, 'status', '--case', l.caseDir], { encoding: 'utf8' });
  assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).closed, true);
});

/* ------------------------------------------------------------------ */
/* C-3：撤權後所有相關權限讀回被拒；誤判恢復沒有解除舊 context                   */
/* ------------------------------------------------------------------ */

test('C-3 撤權：context、錯誤 ticket、工作程序授權與 A-2 舊憑證全部讀回被拒；誤判不解除舊 context', { timeout: 120_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'dq-m7-revoke-')); chmodSync(root, 0o700);
  let origin; let store; let connector;
  t.after(async () => { connector?.close(); store?.close(); await origin?.close(); rmSync(root, { recursive: true, force: true }); });
  await installHostLayout(root);
  const targetPath = join(root, dungeonqTargetRelativePath);
  await writeFile(targetPath, 'ARTIFICIAL-M7-C3-TARGET', { mode: 0o600 });
  const credentials = { business: token(), witness: token(), control: token(), binding: token() };
  origin = await startFileOrigin({ targetPath, baseline: await captureTargetWitness(root), directory: join(root, 'origin'),
    normalToken: credentials.business, witnessToken: credentials.witness, rotationControlToken: credentials.control,
    accessPolicy: { tenantId: 'reference', principalId: 'ordinary-connector', readTarget: true, readOtherRecords: true, writeOtherRecords: true, issueTickets: true },
    responseProfile: { consumers: [{ consumerId: 'legit-1', bindingToken: credentials.binding }], divertedContentsBase64: Buffer.from('SYNTHETIC-M7-DECOY').toString('base64') } });
  const control = async (path, body) => (await fetch(`${origin.origin}${path}`, { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${credentials.control}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  const business = async (bearer, binding) => (await fetch(`${origin.origin}/business`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`,
    'content-type': 'application/json', ...(binding ? { 'x-dungeonq-consumer-binding': binding } : {}) },
  body: JSON.stringify({ contextId: 'ordinary', requestId: `c3-${randomUUID()}`, operation: 'snapshot', args: {} }) })).status;
  // 模擬事件中已執行的 A-2：輪替並開始過渡期；合法消費者取得新憑證。
  const before = await control('/control/response/state');
  await control('/control/response/apply', { actionId: 'pre-rotation-1', kind: 'ROTATE_OVERLAP', incidentId: INCIDENT, expectedRevision: before.revision,
    expectedEpoch: before.credential.epoch, overlapSeconds: 300 });
  const fresh = (await (await fetch(`${origin.origin}/consumer/credential`, { headers: { authorization: `Bearer ${credentials.binding}` } })).json()).token;
  assert.equal(await business(credentials.business, credentials.binding), 200, '過渡期內合法消費者仍可用舊憑證');

  const db = join(root, 'runtime', 'runtime.sqlite'); mkdirSync(join(root, 'runtime'), { mode: 0o700 });
  store = openRuntimeStore({ path: db });
  const tokens = { a: token(), b: token() };
  store.registerContext({ contextId: 'ctx-a', tenantId: 'reference', worldId: 'world', disposition: 'DIVERT', token: tokens.a });
  store.registerContext({ contextId: 'ctx-b', tenantId: 'reference', worldId: 'world', disposition: 'DIVERT', token: tokens.b });
  store.execute({ contextId: 'ctx-b', family: 'http', requestId: 'b-1', operation: 'snapshot', args: {} });
  const wire = store.execute({ contextId: 'ctx-b', family: 'http', requestId: 'b-2', operation: 'issue-ticket', args: { maxUses: 2 } }).ticket;
  const world = store.snapshot().worlds[0];
  store.grantMutation({ policyId: 'grant-b', contextId: 'ctx-b', expectedRevision: world.revision, allowedTemplates: store.snapshot().blueprint.allowedTemplates.slice(0, 1),
    maxMutations: 2, expiresAt: Date.now() + 3_600_000, authority: { kind: 'OWNER', principalId: 'owner-1' } });
  store.fence({ contextId: 'ctx-a', reason: 'owner fence before close' });

  const sealDir = join(root, 'sealer'); const anchor = join(root, 'anchor'); const caseDir = join(root, 'case');
  mkdirSync(anchor); execFileSync('git', ['init', '-q', '-b', 'main', anchor]); generateSealKey(sealDir);
  const registry = { registryId: 'm7-c3', registryVersion: '1', entries: ['ctx-a', 'ctx-b'].map(id => ({ targetId: `target:${id}`, kind: 'FLAGGED_CONTEXT',
    assetId: `context:${id}`, boundIncidentId: INCIDENT })) };
  connector = openDungeonqResponseConnector({ directory: join(root, 'ledger'), registry: () => registry,
    executors: createDungeonqResponseExecutors({ runtimeFence: store,
      fileOrigin: { origin: origin.origin, controlToken: credentials.control, credentialAssetId: 'credential:file-origin-business' } }),
    health: { measure: async () => healthy() }, escalate: async () => {}, sleep: async () => {}, observationMs: 5000 });
  let intakeOpen = true;
  const sent = [];
  const ports = {
    world: createJournalWorldPort({ db, intake: { stop: async () => { intakeOpen = false; }, isStopped: () => !intakeOpen } }),
    evidence: { collect: async () => ({ facts: { realAssetReads: 0 }, artifacts: [
      { name: 'runtime-journal', data: { events: store.evidence().events } }, { name: 'outbox', data: { incidents: [], outbox: [] } },
      { name: 'origin-witness', data: origin.report() }, { name: 'ticket-uses', data: { uses: [] } }, { name: 'legit-health', data: legitReport() }] }) },
    sealer: createM1SealerPort({ db, sealDir, anchorRepo: anchor, publicKeyPath: join(sealDir, SEAL_PUBLIC_KEY), gitTimeoutMs: 10_000, dbTimeoutMs: 500 }),
    revocation: createRuntimeRevocationPort({ store, fileOrigin: { origin: origin.origin, controlToken: credentials.control }, probes: {
      ticket: async ({ item }) => {
        if (item.contextId !== 'ctx-b') return { denied: true, code: 'TICKET_EPOCH_REVOKED' };
        try { store.execute({ contextId: 'ctx-b', family: 'http', requestId: `probe-${randomUUID()}`, operation: 'use-ticket', args: { ticket: wire } }); return { denied: false, code: 'ACCEPTED' }; }
        catch (error) { return { denied: true, code: error.code }; }
      },
      credential: async () => { const status = await business(credentials.business, credentials.binding); return { denied: status === 403, code: `HTTP_${status}` }; }
    } }),
    response: { connector, registry: () => registry, health: { measure: async () => healthy() }, signal: { kind: 'WRONG_TICKET_SPREAD', eventId: 'evt-m7-c3' } },
    notifier: { send: async message => { sent.push(message); return { status: 'SENT', receiptId: `receipt-${sent.length}` }; } }
  };
  const input = closeInput({ contexts: ['ctx-a', 'ctx-b'], verdict: 'FALSE_POSITIVE', flaggedOwners: [{ recipientId: 'owner-ctx-b', subject: 'context:ctx-b' }] });
  const result = await openIncidentClose({ directory: caseDir, input, ports, sensitiveValues: [...Object.values(credentials), ...Object.values(tokens), wire, fresh] }).run();
  assert.equal(result.status, 'CLOSED', JSON.stringify(result));

  const revokeReadbacks = readCloseJournal(caseDir).entries.filter(entry => entry.kind === 'READBACK' && entry.check === 'DENIED');
  assert.deepEqual(revokeReadbacks.map(entry => [entry.itemId, entry.denied, entry.code]).sort(), [
    ['context:ctx-a', true, 'CONTEXT_FENCED'], ['context:ctx-b', true, 'CONTEXT_FENCED'], ['origin-credential:epoch-0', true, 'HTTP_403'],
    ['worker-grant:grant-b', true, 'GRANT_EPOCH_REVOKED'], ['wrong-tickets:ctx-a', true, 'TICKET_EPOCH_REVOKED'], ['wrong-tickets:ctx-b', true, 'CONTEXT_FENCED']]);
  const decision = readCloseJournal(caseDir).entries.find(entry => entry.kind === 'POLICY_DECISION');
  assert.deepEqual([decision.contextId, decision.effect], ['ctx-b', 'ALLOW'], '仍為 ACTIVE 的 context 經政策判定後封鎖');
  // 撤權後直接讀回：舊值全部被拒；合法消費者的新憑證照常可用。
  assert.equal(await business(credentials.business, credentials.binding), 403);
  assert.equal(await business(credentials.business), 403);
  assert.equal(await business(fresh, credentials.binding), 200);
  for (const value of [tokens.a, tokens.b]) assert.throws(() => store.decide({ token: value, family: 'http' }), error => error.code === 'CONTEXT_FENCED');
  assert.throws(() => store.execute({ contextId: 'ctx-b', family: 'http', requestId: 'after-close', operation: 'use-ticket', args: { ticket: wire } }),
    error => error.code === 'CONTEXT_FENCED');
  const contexts = Object.fromEntries(store.snapshot().contexts.map(row => [row.contextId, [row.state, row.epoch]]));
  assert.deepEqual(contexts, { 'ctx-a': ['FENCED', 2], 'ctx-b': ['FENCED', 2] });
  assert.equal((await control('/control/response/state')).credential.overlap.state, 'REVOKED');
  // 誤判：FENCE 去留決策保留舊 context，合法使用者以新的獨立驗證取得新 context。
  const decisions = readCloseJournal(caseDir).entries.filter(entry => entry.kind === 'FENCE_DECISION');
  assert.deepEqual(decisions.map(entry => [entry.contextId, entry.decision, entry.applied, entry.legitimateRecovery]), [
    ['ctx-a', 'KEEP', 'NONE', 'NEW_CONTEXT_AFTER_INDEPENDENT_VERIFICATION'], ['ctx-b', 'KEEP', 'NONE', 'NEW_CONTEXT_AFTER_INDEPENDENT_VERIFICATION']]);
  assert.ok(decisions.every(entry => entry.reasons.includes('FALSE_POSITIVE_OLD_CONTEXT_STAYS_ISOLATED')));
  store.registerContext({ contextId: 'ctx-b-recovered', tenantId: 'reference', worldId: 'world-recovered', disposition: 'NORMAL_AUTHORIZED', token: token() });
  assert.equal(store.snapshot().contexts.find(row => row.contextId === 'ctx-b').state, 'FENCED', '新 context 建立後舊 context 仍隔離');
  assert.deepEqual(sent.map(message => message.recipientId), ['owner-ctx-b']);
  assert.match(sent[0].body, /重新取得新的工作階段/u);
  for (const value of [...Object.values(credentials), ...Object.values(tokens), wire, fresh]) assert.ok(!sent[0].body.includes(value));
});

/* ------------------------------------------------------------------ */
/* C-4：報告符合 5.2 格式，至少一項候選或寫明沒有的理由                         */
/* ------------------------------------------------------------------ */

const templateHeadings = () => readFileSync(TEMPLATE, 'utf8').split('\n').filter(line => /^## \d+\. /u.test(line)).map(line => line.trim());

test('C-4 範本與產生器的八個段落一致；報告格式完整、有後續 Owner、至少一項候選，且不含敏感值', async t => {
  assert.deepEqual(templateHeadings(), POST_INCIDENT_SECTIONS.map(sectionHeading));
  assert.equal(POST_INCIDENT_SECTIONS.length, 8);
  const l = lab(t);
  assert.equal((await l.open().run()).status, 'CLOSED');
  const report = readFileSync(join(l.caseDir, CASE_FILES.report), 'utf8');
  assert.deepEqual(reportHeadings(report), templateHeadings());
  for (const label of ['觸發', '錯誤 ticket 交付', '第一次接受', '識破或轉向', '告警送出', '真人 ACK', '決策', '動作', '讀回', '結束']) {
    assert.ok(report.includes(`| ${label} |`), `時間線缺少 ${label}`);
  }
  assert.match(report, /\| 偵測 \| .+ \| .+ \| DungeonQ 維護者 \|/u);
  const status = readIncidentCloseStatus(l.caseDir); assert.equal(status.closed, true);
  const candidates = openCandidateStore({ directory: join(l.caseDir, CASE_FILES.candidates) }).list();
  assert.ok(candidates.length >= 1);
  assert.deepEqual(candidates.map(row => row.state).sort(), candidates.map(() => 'TESTED'));
  assert.ok(candidates.some(row => row.kind === 'rules') && candidates.some(row => row.kind === 'drills'));
  for (const row of candidates) assert.ok(report.includes(row.candidateId), `報告列出候選 ${row.candidateId}`);
  assert.deepEqual(checkSensitiveContent(report, { sensitiveValues: l.sensitiveValues }), []);
  for (const file of [CASE_FILES.report, ...candidates.map(row => `${CASE_FILES.candidates}/${row.kind}/${row.candidateId}.json`)]) {
    const text = readFileSync(join(l.caseDir, file), 'utf8');
    for (const value of l.sensitiveValues) assert.ok(!text.includes(value), `${file} 含敏感值`);
  }
  assert.ok(!report.includes(l.root), '報告不含本機絕對路徑');
});

test('C-4 沒有新樣態時寫明理由；報告格式仍完整', async t => {
  const l = lab(t, { operations: false });
  assert.equal((await l.open().run()).status, 'CLOSED');
  const report = readFileSync(join(l.caseDir, CASE_FILES.report), 'utf8');
  assert.deepEqual(reportHeadings(report), templateHeadings());
  assert.match(report, /沒有新樣態。理由：.+/u);
  assert.deepEqual(openCandidateStore({ directory: join(l.caseDir, CASE_FILES.candidates) }).list(), []);
});

test('C-4 結束輸入的自由文字含憑證或個資時拒絕，不自動遮蔽', async t => {
  const l = lab(t);
  const leaking = { ...l.input, rootCause: { ...l.input.rootCause, detection: { ...l.input.rootCause.detection, finding: `攻擊方拿到 ${l.contextToken}` } } };
  assert.throws(() => openIncidentClose({ directory: l.caseDir, input: leaking, ports: l.ports, sensitiveValues: l.sensitiveValues }),
    error => error.code === 'CLOSE_INPUT_SENSITIVE');
  const email = { ...l.input, notification: { ...l.input.notification, contact: 'oncall@example.com' } };
  assert.throws(() => openIncidentClose({ directory: l.caseDir, input: email, ports: l.ports }), error => error.code === 'CLOSE_INPUT_SENSITIVE');
});

/* ------------------------------------------------------------------ */
/* C-5：候選沒有測試結果或沒有已驗證核准時，不能進入可發布狀態                    */
/* ------------------------------------------------------------------ */

function syntheticPattern() {
  const base = 1_800_000_000_000;
  const journalEvents = ['snapshot', 'read', 'issue-ticket', 'use-ticket'].map((operation, index) => ({ contextId: 'ctx-a', kind: 'EXECUTE', operation, at: base + index * 1000 }));
  const ticketUses = [{ contextId: 'ctx-a', entry: 'http', outcome: 'ACCEPTED', at: base + 3000, spread: [] },
    { contextId: 'ctx-a', entry: 'real-entry', outcome: 'ACCEPTED', at: base + 9000, spread: [] }];
  const traces = buildIncidentTraces({ contexts: ['ctx-a'], journalEvents, ticketUses });
  return { traces, pattern: extractAttackPattern(traces) };
}
const legitTraces = (operation = 'read', count = 30) => [{ traceId: 'legitimate:legit-1', source: 'LEGITIMATE',
  events: Array.from({ length: count }, (_, index) => ({ at: index * 1000, kind: 'OPERATION', operation })) }];
const verifierOf = (verdict, calls = []) => ({ verify: async args => { calls.push(args); return typeof verdict === 'function' ? verdict(args) : verdict; } });

test('C-5 候選狀態機：沒有測試、測試未通過、核准未驗證都不能 PUBLISHABLE；核准後被改動判為 INVALID；沒有發布函式', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dq-m7-candidates-')); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { traces, pattern } = syntheticPattern();
  assert.deepEqual(pattern.beforeAcceptance, ['snapshot', 'read', 'issue-ticket']);
  assert.deepEqual(pattern.recognitionSignals.map(entry => entry.signal), ['PIVOTED_TO_OTHER_PATH']);
  assert.equal(pattern.pivotAfterAcceptanceMs, 6000);
  const rules = buildRuleCandidates(pattern, { incidentId: INCIDENT });
  assert.deepEqual(rules.map(rule => rule.kind), ['TICKET_PRESENTATION', 'OPERATION_SEQUENCE']);
  const store = openCandidateStore({ directory: join(root, 'candidates') });
  assert.equal(typeof store.publish, 'undefined');
  const sequence = rules[1];
  store.write(sequence);
  const valid = verifierOf(args => ({ verified: true, approverId: 'human-reviewer-1', method: 'TOTP', candidateDigest: args.candidateDigest, testsDigest: args.testsDigest }));
  await assert.rejects(store.approve(sequence.candidateId, { approvalId: 'approval-1' }, { verifier: valid }), error => error.code === 'CANDIDATE_TESTS_REQUIRED');
  // 誤判測試失敗：合法流量含有同樣的順序。
  const noisy = [{ traceId: 'legitimate:noisy', source: 'LEGITIMATE', events: [
    ...['snapshot', 'read', 'issue-ticket'].map((operation, index) => ({ at: index * 100, kind: 'OPERATION', operation })),
    ...Array.from({ length: 30 }, (_, index) => ({ at: 1000 + index * 1000, kind: 'OPERATION', operation: 'read' }))] }];
  const failed = store.runTests(sequence.candidateId, { recordedTraces: traces, legitimateTraces: noisy, pattern });
  assert.deepEqual([failed.state, failed.tests.hit.passed, failed.tests.falsePositive.passed, failed.tests.falsePositive.hits], ['TEST_FAILED', true, false, 1]);
  await assert.rejects(store.approve(sequence.candidateId, { approvalId: 'approval-1' }, { verifier: valid }), error => error.code === 'CANDIDATE_TESTS_NOT_PASSED');
  // 合法流量樣本太少也不算通過。
  const thin = store.runTests(sequence.candidateId, { recordedTraces: traces, legitimateTraces: legitTraces('read', 5), pattern });
  assert.deepEqual([thin.state, thin.tests.falsePositive.passed], ['TEST_FAILED', false]);
  const passed = store.runTests(sequence.candidateId, { recordedTraces: traces, legitimateTraces: legitTraces(), pattern });
  assert.deepEqual([passed.state, passed.tests.hit.hits, passed.tests.falsePositive.hits, passed.tests.falsePositive.events], ['TESTED', 1, 0, 30]);
  // 核准未驗證、驗證端沒有綁定同一份摘要、驗證端出錯：都不能進 PUBLISHABLE。
  await assert.rejects(store.approve(sequence.candidateId, { approvalId: 'approval-1' }, { verifier: verifierOf({ verified: false, reason: 'TOTP_INVALID' }) }),
    error => error.code === 'APPROVAL_NOT_VERIFIED');
  await assert.rejects(store.approve(sequence.candidateId, { approvalId: 'approval-1' },
    { verifier: verifierOf({ verified: true, approverId: 'human-reviewer-1', candidateDigest: 'f'.repeat(64), testsDigest: 'f'.repeat(64) }) }),
  error => error.code === 'APPROVAL_NOT_VERIFIED');
  await assert.rejects(store.approve(sequence.candidateId, { approvalId: 'approval-1' }, { verifier: { verify: async () => { throw new Error('down'); } } }),
    error => error.code === 'APPROVAL_NOT_VERIFIED');
  await assert.rejects(store.approve(sequence.candidateId, { approvalId: 'approval-1' }, {}), error => error.code === 'APPROVAL_VERIFIER_REQUIRED');
  assert.equal(store.status(sequence.candidateId).state, 'TESTED');
  const calls = [];
  const approved = await store.approve(sequence.candidateId, { approvalId: 'approval-1', proof: 'opaque-session-proof' }, { verifier: verifierOf(
    args => ({ verified: true, approverId: 'human-reviewer-1', method: 'TOTP', candidateDigest: args.candidateDigest, testsDigest: args.testsDigest }), calls) });
  assert.equal(approved.state, 'PUBLISHABLE');
  assert.equal(approved.publication, 'NOT_PUBLISHED');
  assert.equal(calls[0].candidateId, sequence.candidateId);
  const stored = readFileSync(join(root, 'candidates', 'rules', `${sequence.candidateId}.json`), 'utf8');
  assert.ok(!stored.includes('opaque-session-proof'), '不保存核准證明本身');
  // 核准後把規則改寬：重新讀檔即判為 INVALID。
  const path = join(root, 'candidates', 'rules', `${sequence.candidateId}.json`);
  writeFileSync(path, stored.replace('"withinMs":', '"withinMs":1').replace('"snapshot"', '"read"'));
  assert.equal(store.status(sequence.candidateId).state, 'INVALID');
  // 候選只寫在候選目錄。
  assert.deepEqual(readdirSync(root), ['candidates']);
});

test('C-5 規則評估與演練案例：確定性、固定種子可重現、命中已記錄軌跡且不命中合法流量', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dq-m7-drill-')); chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { traces, pattern } = syntheticPattern();
  const [presentation, sequence] = buildRuleCandidates(pattern, { incidentId: INCIDENT });
  assert.deepEqual(evaluateRule(presentation, traces[0]).hit, true);
  assert.deepEqual(evaluateRule(sequence, traces[0]).hit, true);
  assert.deepEqual(evaluateRule(sequence, legitTraces()[0]).hit, false);
  const slow = { ...sequence, match: { ...sequence.match, withinMs: 500 } };
  assert.equal(evaluateRule(slow, traces[0]).hit, false, '超過時間窗不命中');
  const first = buildDrillCandidate(traces, pattern, { incidentId: INCIDENT, seed: 4242 });
  const second = buildDrillCandidate(traces, pattern, { incidentId: INCIDENT, seed: 4242 });
  const other = buildDrillCandidate(traces, pattern, { incidentId: INCIDENT, seed: 7 });
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.notEqual(canonicalJson(first.scenario.steps), canonicalJson(other.scenario.steps));
  assert.deepEqual(first.scenario.steps.map(step => step.action), ['OPERATION', 'OPERATION', 'OPERATION', 'OPERATION', 'PRESENT_WRONG_TICKET', 'PRESENT_WRONG_TICKET']);
  assert.ok(first.scenario.steps.every((step, index, all) => index === 0 || step.offsetMs >= all[index - 1].offsetMs));
  assert.deepEqual(first.scenario.expect, { wrongTicketAccepted: true, recognitionSignal: 'PIVOTED_TO_OTHER_PATH', protectedSourceReads: 0 });
  const store = openCandidateStore({ directory: join(root, 'candidates') });
  store.write(first);
  const tested = store.runTests(first.candidateId, { recordedTraces: traces, legitimateTraces: [], pattern });
  assert.equal(tested.state, 'TESTED');
  await assert.rejects(store.approve(first.candidateId, { approvalId: 'drill-approval' }, { verifier: verifierOf({ verified: false }) }),
    error => error.code === 'APPROVAL_NOT_VERIFIED');
  assert.throws(() => store.write({ ...first, rationale: '改過的內容' }), error => error.code === 'CANDIDATE_CONFLICT');
});

/* ------------------------------------------------------------------ */
/* 規則單元                                                              */
/* ------------------------------------------------------------------ */

test('FENCE 去留規則與受影響者推導', () => {
  const base = { verdict: 'REAL_INTRUSION', identityConfirmed: true, credentialsRevoked: true, realAssetReads: 0, evidenceSealed: true };
  assert.equal(decideFenceDisposition(base).decision, 'RELEASE_ELIGIBLE');
  assert.equal(decideFenceDisposition(base).applied, 'NONE', 'v1 不解除任何 FENCE');
  for (const [change, reason] of [[{ identityConfirmed: false }, 'IDENTITY_UNCONFIRMED'], [{ credentialsRevoked: false }, 'CREDENTIALS_NOT_REVOKED'],
    [{ realAssetReads: 1 }, 'REAL_ASSET_READ'], [{ evidenceSealed: false }, 'EVIDENCE_NOT_SEALED'], [{ verdict: 'FALSE_POSITIVE' }, 'FALSE_POSITIVE_OLD_CONTEXT_STAYS_ISOLATED']]) {
    const decision = decideFenceDisposition({ ...base, ...change });
    assert.deepEqual([decision.decision, decision.reasons], ['KEEP', [reason]]);
  }
  const directory = { legitimateConsumers: [{ recipientId: 'owner-legit-1', consumerId: 'legit-1' }],
    flaggedSubjectOwners: [{ recipientId: 'owner-src', subject: 'source:src-1' }, { recipientId: 'owner-ctx', subject: 'context:ctx-a' }] };
  const actions = [{ actionCode: 'A-2', assetId: 'credential:file-origin-business', status: 'EXECUTED' },
    { actionCode: 'A-5', assetId: 'source:src-1', status: 'EXECUTED' }, { actionCode: 'A-4', assetId: 'grant:context:ctx-a:issueTickets', status: 'FAILED' }];
  assert.deepEqual(deriveAffectedRecipients({ actions, verdict: 'REAL_INTRUSION', directory, contexts: ['ctx-a'] }),
    [{ recipientId: 'owner-legit-1', reasons: ['CREDENTIAL_ROTATED'] }]);
  assert.deepEqual(deriveAffectedRecipients({ actions, verdict: 'FALSE_POSITIVE', directory, contexts: ['ctx-a'] }), [
    { recipientId: 'owner-ctx', reasons: ['CONTEXT_REVOKED'] }, { recipientId: 'owner-legit-1', reasons: ['CREDENTIAL_ROTATED'] },
    { recipientId: 'owner-src', reasons: ['RATE_LIMITED'] }]);
});
