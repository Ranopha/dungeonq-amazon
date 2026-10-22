import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DUNGEONQ_RESPONSE_ACTION_CATALOG,
  DUNGEONQ_RESPONSE_ACTION_POLICY_VERSION,
  evaluateDungeonqResponseAction
} from '../../packages/policy/src/dungeonq-response-action.ts';
import { dungeonqTargetRelativePath } from '../../plugins/dungeonq-host-integration/src/contracts.ts';
import { startFileOrigin } from '../../plugins/dungeonq-host-integration/src/file-origin.ts';
import { createDungeonqResponseExecutors, openDungeonqResponseConnector } from '../../plugins/dungeonq-host-integration/src/response-actions.ts';
import { captureTargetWitness, installHostLayout } from '../../plugins/dungeonq-host-integration/src/target-witness.ts';
import { openPitchControl, ticketHandleDigest } from '../../vendor/dungeonq-runtime/runtime/pitch-control.mjs';
import { openRuntimeStore } from '../../vendor/dungeonq-runtime/runtime/store.mjs';
import { generateSealKey, SEAL_PUBLIC_KEY } from './evidence-sealer.mjs';
import { CASE_FILES, createM1SealerPort, openIncidentClose, readCloseJournal, verifyIncidentCase } from './incident-close.mjs';
import { createJournalWorldPort, createLegitConsumerPort, createLocalEvidencePort, createRuntimeRevocationPort } from './incident-local-ports.mjs';
import { checkSensitiveContent, openCandidateStore, POST_INCIDENT_SECTIONS, reportHeadings, sectionHeading } from './incident-review.mjs';
import { legitHealthMeasurement, startLegitConsumer } from './legit-consumer.mjs';
import { openDungeonqWorkOrderStore } from './work-order.mjs';

/*
 * DQ-HANDOFF-015 M7 整合測試（LOCAL_PROOF_KERNEL：同一 OS 使用者的程序層實驗，不宣稱隔離）。
 * 合成事件：被導入假世界的 context 依序瀏覽、取得並使用錯誤 ticket，再帶著錯誤 ticket 轉向真實入口；
 * 合法消費者全程運作，而且和 gateway 一樣每次探測都在執行環境 journal 留下一筆 ROUTE（M9 演練的衝突來源）。
 * 期間經政策執行一個 A 級動作（A-2 輪替並行過渡）並建立一張 B 級工單，之後跑完整個結束流程：
 * 第 0 步凍結（合法消費者仍運作、健康數字即時時經政策封鎖仍 ACTIVE 的 context，再停止世界、最後停止合法消費者）
 * → 封存（M1 簽章、本機錨點）→ 撤權（結束 A-2 過渡期）→ FENCE 去留 → 通知受影響的合法使用者（假寄送器）
 * → 事後報告與候選。不寄信、不呼叫模型、不推送遠端。
 */

const INCIDENT = 'inc-m7-integration';
const CONTEXT = 'ctx-flagged-1';
const OBSERVATION_MS = 5_000;
const waitUntil = async (predicate, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `等待逾時：${label}`);
    await new Promise((done) => setTimeout(done, 200));
  }
};
const listFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? listFiles(join(directory, entry.name)) : [join(directory, entry.name)]);

test('LOCAL_PROOF_KERNEL：合成事件在合法消費者全程運作下執行 A 級動作與工單，跑完結束流程並產出報告與候選', { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dq-m7-integration-'));
  chmodSync(root, 0o700);
  let origin; let store; let pitch; let connector; let consumer;
  try {
    await installHostLayout(root);
    const targetPath = join(root, dungeonqTargetRelativePath);
    const contents = 'ARTIFICIAL-M7-INTEGRATION-TARGET';
    await writeFile(targetPath, contents, { mode: 0o600 });
    const decoyText = 'SYNTHETIC-M7-DECOY-ONLY';
    const token = () => randomBytes(32).toString('base64url').replaceAll('-', 'x');
    const credentials = { business: token(), witness: token(), control: token(), binding: token(), context: token() };
    origin = await startFileOrigin({
      targetPath, baseline: await captureTargetWitness(root), directory: join(root, 'origin'),
      normalToken: credentials.business, witnessToken: credentials.witness, rotationControlToken: credentials.control,
      accessPolicy: { tenantId: 'reference', principalId: 'ordinary-connector', readTarget: true, readOtherRecords: true, writeOtherRecords: true, issueTickets: true },
      responseProfile: { consumers: [{ consumerId: 'legit-1', bindingToken: credentials.binding }], divertedContentsBase64: Buffer.from(decoyText).toString('base64') }
    });
    mkdirSync(join(root, 'runtime'), { mode: 0o700 });
    const db = join(root, 'runtime', 'runtime.sqlite');
    store = openRuntimeStore({ path: db });
    pitch = openPitchControl({ path: join(root, 'pitch', 'pitch-control.sqlite'), ticketTracking: {} });

    // 合成攻擊方（腳本代理）：所有動作都經過 intake 閘門；結束流程第 1 步關閉閘門後不再有新變動。
    let intakeOpen = true;
    const toolLog = [];
    const act = (requestId, operation, args = {}) => {
      assert.ok(intakeOpen, '閘門關閉後不得再有參與者動作');
      toolLog.push({ at: Date.now(), contextId: CONTEXT, kind: 'CALL', tool: operation });
      return store.execute({ contextId: CONTEXT, family: 'http', requestId, operation, args });
    };
    store.registerContext({ contextId: CONTEXT, tenantId: 'reference', worldId: 'world', disposition: 'DIVERT', token: credentials.context });
    store.registerContext({ contextId: 'ordinary-legit', tenantId: 'reference', worldId: 'world-legit', disposition: 'NORMAL_AUTHORIZED', token: token() });
    const lease = pitch.begin({ family: 'http' }); pitch.bind(lease, { contextId: CONTEXT }); pitch.finish(lease, { outcome: 'SERVED', code: 'OK' });
    pitch.recordEntry({ contextId: CONTEXT, worldId: 'world', epoch: 1, eventId: 'evt-m7-entry' });

    // 和 gateway 相同：每次合法探測都在 journal 寫一筆 ROUTE，所以合法消費者運作時 journal 一直在變。
    let routes = 0;
    const gatewayLikeFetch = async (url, init) => {
      if (new URL(url).pathname === '/business') {
        store.recordRoute({ contextId: 'ordinary-legit', requestId: `legit-route-${++routes}`, family: 'http', destination: 'ORIGIN', outcome: 'SERVED' });
      }
      return fetch(url, init);
    };
    consumer = startLegitConsumer({
      origin: origin.origin, consumerId: 'legit-1', bindingToken: credentials.binding, credential: credentials.business, fetchImpl: gatewayLikeFetch,
      durationMs: 5 * 60_000, probe: { operation: 'read', key: 'initial-machine-target', expectedContentsSha256: createHash('sha256').update(contents).digest('hex') }
    });
    const legitimate = createLegitConsumerPort({ consumer });

    act('agent-1', 'snapshot');
    await new Promise((done) => setTimeout(done, 300));
    act('agent-2', 'read', { key: 'welcome' });
    await new Promise((done) => setTimeout(done, 300));
    const issued = act('agent-3', 'issue-ticket', { maxUses: 2 });
    const handleDigest = ticketHandleDigest(store.participantTicket(issued.ticket));
    pitch.trackTicket({ ticketId: issued.ticketId, handleDigest, contextId: CONTEXT, worldId: 'world', epoch: 1, entry: 'http',
      issuedAt: issued.issuedAt, expiresAt: issued.expiresAt, source: '127.0.0.1' });
    await new Promise((done) => setTimeout(done, 300));
    const firstUse = pitch.recordTicketUse({ handleDigest, contextId: CONTEXT, entry: 'http', position: 'ARGUMENT', client: 'scripted-agent', source: '127.0.0.1' });
    act('agent-4', 'use-ticket', { ticket: issued.ticket });
    pitch.settleTicketUse({ useId: firstUse.useId, outcome: 'ACCEPTED', code: 'OK' });
    // 入場告警以假寄送函式取得本機回執（不寄任何信），管理員轉錄 ACK（未驗證身分）。
    await pitch.deliver({ send: async () => ({ accepted: true, receiptId: 'synthetic-receipt-1' }) });
    pitch.acknowledge({ incidentId: pitch.snapshot().incidents[0].incidentId, operatorId: 'synthetic-operator' });
    await new Promise((done) => setTimeout(done, 600));
    // 轉向：帶著錯誤 ticket 到真實入口（D10：延續同一個假世界）。
    const pivot = pitch.recordTicketUse({ handleDigest, contextId: CONTEXT, entry: 'real-entry', position: 'CREDENTIAL', client: 'scripted-agent', source: '127.0.0.1' });
    act('agent-5', 'use-ticket', { ticket: issued.ticket });
    pitch.settleTicketUse({ useId: pivot.useId, outcome: 'ACCEPTED', code: 'OK' });

    const registry = { registryId: 'm7-integration-registry', registryVersion: '1', entries: [
      { targetId: 'target:ctx-flagged-1', kind: 'FLAGGED_CONTEXT', assetId: `context:${CONTEXT}`, boundIncidentId: INCIDENT },
      { targetId: 'target:credential', kind: 'CREDENTIAL', assetId: 'credential:file-origin-business', boundIncidentId: null },
      { targetId: 'target:account', kind: 'ACCOUNT', assetId: 'account:service-operator', boundIncidentId: null }
    ] };
    const escalations = [];
    connector = openDungeonqResponseConnector({
      directory: join(root, 'ledger'), registry: () => registry,
      executors: createDungeonqResponseExecutors({ runtimeFence: store,
        fileOrigin: { origin: origin.origin, controlToken: credentials.control, credentialAssetId: 'credential:file-origin-business' } }),
      health: { measure: ({ sinceMs }) => consumer.measure({ sinceMs }) },
      escalate: async (escalation) => { escalations.push(escalation); },
      observationMs: OBSERVATION_MS
    });

    await waitUntil(async () => (await consumer.report()).sampleCount >= 7, 20_000, '處置前基線樣本');
    await consumer.setPhase('DURING');

    // 一個 A 級動作：A-2 輪替並行過渡（以名稱自政策目錄挑選，由政策判定）。
    const rotation = DUNGEONQ_RESPONSE_ACTION_CATALOG.actions.find((entry) => entry.name === 'ROTATE_CREDENTIAL_WITH_OVERLAP');
    const evaluatedAt = new Date().toISOString();
    const input = {
      policyVersion: DUNGEONQ_RESPONSE_ACTION_POLICY_VERSION, traceId: 'trace-m7-a2', evaluatedAt, incidentId: INCIDENT,
      signal: { kind: 'WRONG_TICKET_USED', eventId: 'evt-m7-1' }, actionCode: rotation.code, targetId: 'target:credential',
      parameters: { rateLimitDurationSeconds: null }, targetRegistry: registry,
      ...connector.policyInputState({ incidentId: INCIDENT, evaluatedAt }),
      legitimateHealth: await consumer.measure({ sinceMs: Date.now() - 10_000 })
    };
    const decision = evaluateDungeonqResponseAction(input);
    assert.equal(decision.effect, 'ALLOW', decision.reason);
    const request = { incidentId: INCIDENT, actionCode: rotation.code, targetId: 'target:credential' };
    const rotated = await connector.execute({ decision, input, request, expectedState: await connector.readTargetState(request) });
    assert.deepEqual([rotated.status, rotated.readback], ['EXECUTED', 'CONFIRMED'], rotated.reason);

    // 一張 B 級工單。
    const workOrders = openDungeonqWorkOrderStore({ directory: join(root, 'work-orders'), responseLedger: connector.responseLedger });
    const bAt = new Date().toISOString();
    const bInput = {
      policyVersion: DUNGEONQ_RESPONSE_ACTION_POLICY_VERSION, traceId: 'trace-m7-b1', evaluatedAt: bAt, incidentId: INCIDENT,
      signal: { kind: 'WRONG_TICKET_USED', eventId: 'evt-m7-b1' }, actionCode: 'B-1', targetId: 'target:account', parameters: { rateLimitDurationSeconds: null },
      targetRegistry: registry, ...connector.policyInputState({ incidentId: INCIDENT, evaluatedAt: bAt }),
      legitimateHealth: legitHealthMeasurement([], { sinceMs: 0, measuredAtMs: Date.now() })
    };
    const created = await workOrders.create({ decision: evaluateDungeonqResponseAction(bInput), input: bInput,
      request: { incidentId: INCIDENT, actionCode: 'B-1', targetId: 'target:account' },
      context: { evidence: { summary: '合成整合測試：被標記 context 使用並轉向帶出錯誤 ticket。', references: ['evt-m7-1'], counts: { realAssetReads: 0 } },
        impact: { affectedUserGroups: ['合成合法消費者'], notes: '合成實驗環境，沒有外部使用者。' },
        requirements: { adminAccountRole: '身分管理系統管理員角色' } } });
    assert.equal(created.workOrder.status, 'OPEN');

    await consumer.setPhase('AFTER');
    // 誤判測試要求合法流量樣本至少 20 個事件；等到足夠樣本再結束，避免候選因樣本不足而判為未通過。
    await waitUntil(async () => { const current = await consumer.report(); return current.segments.AFTER.count >= 6 && current.sampleCount >= 24; },
      20_000, '處置後樣本');

    // 結束流程。
    const sealDir = join(root, 'sealer'); const anchor = join(root, 'anchor'); const caseDir = join(root, 'case-inc-m7-integration');
    mkdirSync(anchor); execFileSync('git', ['init', '-q', '-b', 'main', anchor]);
    const bare = join(root, 'anchor-remote.git'); execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['-C', anchor, 'remote', 'add', 'origin', bare]);
    generateSealKey(sealDir);
    const sent = [];
    const ports = {
      world: createJournalWorldPort({ db, intake: { stop: async () => { intakeOpen = false; }, isStopped: () => !intakeOpen } }),
      evidence: createLocalEvidencePort({ store, pitchControl: pitch, fileOrigin: { origin: origin.origin, witnessToken: credentials.witness }, consumer: legitimate, connector,
        workOrders, toolLog: () => toolLog }),
      sealer: createM1SealerPort({ db, sealDir, anchorRepo: anchor, publicKeyPath: join(sealDir, SEAL_PUBLIC_KEY), label: 'm7-integration' }),
      revocation: createRuntimeRevocationPort({ store, pitchControl: pitch, fileOrigin: { origin: origin.origin, controlToken: credentials.control } }),
      response: { connector, registry: () => registry, health: { measure: ({ sinceMs }) => consumer.measure({ sinceMs }) },
        signal: { kind: 'WRONG_TICKET_USED', eventId: 'evt-m7-close' } },
      notifier: { send: async (message) => { sent.push(message); return { status: 'SENT', receiptId: `synthetic-notice-${sent.length}` }; } },
      legitimate
    };
    const sensitiveValues = [...Object.values(credentials), issued.ticket, decoyText, Buffer.from(decoyText).toString('base64'), contents];
    const closer = openIncidentClose({ directory: caseDir, sensitiveValues, ports, input: {
      incidentId: INCIDENT, contexts: [CONTEXT], verdict: 'DRILL', severity: 'HIGH', identityConfirmed: false, isolation: 'LOCAL_PROOF_KERNEL',
      rootCause: {
        detection: { finding: '錯誤 ticket 第一次出示即被記錄並告警。', improvement: '把轉向真實入口列為獨立訊號。', owner: 'DungeonQ 維護者' },
        wrongTicket: { finding: '錯誤 ticket 在兩個入口都被接受。', improvement: '觀察接受後的識破時間。', owner: 'DungeonQ 維護者' },
        notification: { finding: '入場告警只有本機回執，沒有實寄。', improvement: 'M3 接上主管道與備援。', owner: 'M3 施工者' },
        response: { finding: 'A-2 期間合法消費者不中斷。', improvement: '結束時一併結束過渡期。', owner: 'DungeonQ 維護者' },
        documentation: { finding: '結束流程首次以合成事件跑完。', improvement: '在 M9 演練中由真人照流程文件執行。', owner: '使用者' }
      },
      followUps: [{ item: '把 FENCE 去留規則移入處置動作政策', owner: 'DungeonQ 維護者' }],
      notification: { contact: 'DungeonQ 值班管理員', directory: { legitimateConsumers: [{ recipientId: 'owner-legit-1', consumerId: 'legit-1' }], flaggedSubjectOwners: [] } }
    } });
    const routesBeforeClose = routes;
    assert.equal((await legitimate.state()).running, true, '呼叫結束流程時合法消費者仍在運作');
    const started = Date.now();
    const result = await closer.run();
    const closeMs = Date.now() - started;
    assert.equal(result.status, 'CLOSED', JSON.stringify({ step: result.step, code: result.code, detail: result.detail }));

    // C-1：第 0 步加五步依序完成。
    const journal = readCloseJournal(caseDir).entries;
    assert.deepEqual(journal.filter((entry) => entry.kind === 'STEP_DONE').map((entry) => entry.step),
      ['FREEZE', 'SEAL_EVIDENCE', 'REVOKE', 'FENCE_DISPOSITION', 'NOTIFY_AFFECTED', 'POST_INCIDENT_REVIEW']);
    // 第 0 步：合法消費者全程運作到封鎖之後；封鎖時政策讀到的健康數字是即時的，判定 HEALTHY 並 ALLOW。
    const fenceDecision = journal.find((entry) => entry.kind === 'POLICY_DECISION');
    assert.deepEqual([fenceDecision.step, fenceDecision.contextId, fenceDecision.effect, fenceDecision.healthStatus], ['FREEZE', CONTEXT, 'ALLOW', 'HEALTHY']);
    assert.ok(fenceDecision.health.ageMs >= 0 && fenceDecision.health.ageMs < 5_000, `健康量測距判定 ${fenceDecision.health.ageMs} 毫秒`);
    assert.ok(fenceDecision.health.sampleCount >= 5, `最近 10 秒有 ${fenceDecision.health.sampleCount} 個樣本`);
    const fencedAt = Date.parse(journal.find((entry) => entry.kind === 'FREEZE_FENCE').at);
    const legitReport = await legitimate.report();
    assert.ok(Date.parse(legitReport.stoppedAt) >= fencedAt, '合法消費者在封鎖之後才停止');
    assert.ok(routes > routesBeforeClose, '結束流程開始後合法探測仍持續寫入 journal');
    assert.equal(result.results.FREEZE.journalSequence, result.results.SEAL_EVIDENCE.journalSequence, '凍結後到封存之間 journal 沒有新變動');
    assert.deepEqual(result.results.FREEZE.legitimateConsumer, { configured: true, stopped: true });
    // C-2：外部驗證端（只用公鑰、錨點、唯讀資料庫）驗證通過；錨點推送到本機 bare 倉庫仍標同機自證。
    const verified = await verifyIncidentCase({ directory: caseDir, db, publicKey: join(sealDir, SEAL_PUBLIC_KEY), anchorRepo: anchor });
    assert.equal(verified.verdict, 'VERIFIED', JSON.stringify(verified.findings));
    assert.equal(verified.evidenceIntegrity, 'SAME_HOST_SELF_ATTESTED');
    // C-3：撤權後讀回被拒；context 已在第 0 步經政策封鎖；A-2 過渡期結束；合法消費者全程沒有失敗。
    assert.ok(journal.filter((entry) => entry.kind === 'READBACK' && entry.check === 'DENIED').every((entry) => entry.denied));
    assert.throws(() => store.decide({ token: credentials.context, family: 'http' }), (error) => error.code === 'CONTEXT_FENCED');
    const stale = await fetch(`${origin.origin}/business`, { method: 'POST', headers: { authorization: `Bearer ${credentials.business}`, 'content-type': 'application/json',
      'x-dungeonq-consumer-binding': credentials.binding }, body: JSON.stringify({ contextId: 'ordinary', requestId: 'after-close-old', operation: 'snapshot', args: {} }) });
    assert.equal(stale.status, 403);
    const health = legitReport;
    assert.equal(health.complete, true);
    assert.deepEqual(health.failures, []);
    assert.deepEqual(escalations, []);
    // 通知：受 A-2 影響的合法使用者收到一則通知（假寄送器），內容不含機密。
    assert.deepEqual(sent.map((message) => message.recipientId), ['owner-legit-1']);
    // C-4：報告八段、與範本一致；候選至少一項且都只在候選目錄。
    const report = readFileSync(join(caseDir, CASE_FILES.report), 'utf8');
    assert.deepEqual(reportHeadings(report), POST_INCIDENT_SECTIONS.map(sectionHeading));
    const candidates = openCandidateStore({ directory: join(caseDir, CASE_FILES.candidates) }).list();
    assert.ok(candidates.length >= 1);
    const candidateStore = openCandidateStore({ directory: join(caseDir, CASE_FILES.candidates) });
    assert.ok(candidates.every((row) => row.state === 'TESTED'), JSON.stringify(candidates.map((row) => ({ ...row, tests: candidateStore.get(row.candidateId).tests }))));
    // 案件目錄內所有檔案（含私人證據）都不含憑證、ticket 原值、誘餌原文或真實內容；全部是私人權限。
    for (const file of listFiles(caseDir)) {
      const text = readFileSync(file, 'utf8');
      for (const value of sensitiveValues) assert.ok(!text.includes(value), `${file} 含敏感值`);
      assert.equal(statSync(file).mode & 0o077, 0, `${file} 不是私人權限`);
    }
    assert.deepEqual(checkSensitiveContent(report, { sensitiveValues }), []);
    assert.deepEqual(checkSensitiveContent(`${sent[0].subject}\n${sent[0].body}`, { sensitiveValues }), []);

    const summary = {
      isolation: 'LOCAL_PROOF_KERNEL', closeMs, steps: journal.filter((entry) => entry.kind === 'STEP_DONE').map((entry) => entry.step),
      evidence: { artifacts: result.results.SEAL_EVIDENCE.artifacts, journalSequence: result.results.SEAL_EVIDENCE.journalSequence,
        integrity: verified.evidenceIntegrity, verdict: verified.verdict },
      revoke: result.results.REVOKE.kinds, fence: result.results.FENCE_DISPOSITION.decisions.map((row) => `${row.contextId}:${row.decision}`),
      notified: result.results.NOTIFY_AFFECTED, candidates: candidates.map((row) => `${row.kind}:${row.state}`),
      legitimate: Object.fromEntries(Object.entries(health.segments).map(([phase, row]) => [phase, `${row.successes}/${row.count}`])),
      workOrders: 1, freeze: { health: fenceDecision.health, legitRoutes: routes, routesDuringClose: routes - routesBeforeClose }
    };
    console.log(`DQ_M7_CLOSE ${JSON.stringify(summary)}`);
  } finally {
    await consumer?.stop().catch(() => undefined);
    connector?.close();
    pitch?.close();
    store?.close();
    await origin?.close();
    await rm(root, { recursive: true, force: true });
  }
});
