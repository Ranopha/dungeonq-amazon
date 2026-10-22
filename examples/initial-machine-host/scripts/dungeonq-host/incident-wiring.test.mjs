import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { otpAt } from '../../vendor/dungeonq-runtime/server/totp.mjs';
import { findDungeonqResponsePolicyBypass } from '../lib/dungeonq-response-policy-fitness.mjs';
import { createAckOperatorRecord, writeAckOperatorFile } from './ack-operator.mjs';
import { createDungeonqAlertSender } from './alert-sender.mjs';
import { composeAffectedNotification } from './incident-close.mjs';
import { buildIncidentTraces, buildRuleCandidates, extractAttackPattern, openCandidateStore } from './incident-review.mjs';
import { DUNGEONQ_INCIDENT_RECIPIENT_OWNER, INCIDENT_WIRING_LIMITS, createIncidentApprovalVerifier, createIncidentNotifier, createIncidentWiring,
  recommendedCloseLimits } from './incident-wiring.mjs';

/*
 * DQ-HANDOFF-015 M7 接線測試：通知（M3 寄送器）與候選核准（M3 ACK 操作員帳號）。
 * 全部用假管道與測試帳號，不讀祕密檔、不連外、不寄送。
 */

const repoRoot = resolve(import.meta.dirname, '../..');
const PASSWORD = 'drill test password 0042 only';
const INCIDENT = `incident-${'a'.repeat(64)}`;
const temp = (t, prefix) => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
};

/** 假管道：依序回傳設定的結果；'HANG' 表示一直不回應（只能被 signal 中止）。 */
function fakeChannel(name, role, outcomes = ['ACCEPTED']) {
  const calls = [];
  return {
    name, role, calls,
    async send(message, { signal } = {}) {
      calls.push({ ...message });
      const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
      if (outcome === 'HANG') return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      if (outcome === 'THROW') throw new Error('transport down');
      return outcome === 'ACCEPTED' ? { state: 'ACCEPTED', receiptId: `<${name.toLowerCase()}-${calls.length}@provider.example>` } : { state: outcome };
    }
  };
}

function notifierFixture(t, { primary = ['ACCEPTED'], fallback = ['ACCEPTED'], limits, sensitiveValues = [] } = {}) {
  const root = temp(t, 'dq-incident-notify-');
  const channels = [fakeChannel('GMAIL_SMTP', 'PRIMARY', primary), fakeChannel('LINE_PUSH', 'FALLBACK', fallback)];
  const sender = createDungeonqAlertSender({ channels });
  const notifier = createIncidentNotifier({ sender, ledgerDirectory: join(root, 'notifications'), limits, sensitiveValues });
  return { root, primary: channels[0], fallback: channels[1], notifier, reopen: () => createIncidentNotifier({ sender, ledgerDirectory: join(root, 'notifications'), limits, sensitiveValues }) };
}
const message = composeAffectedNotification({ incidentId: INCIDENT, reasons: ['CREDENTIAL_ROTATED'], contact: 'DungeonQ 值班管理員' });
const request = (overrides = {}) => ({ incidentId: INCIDENT, recipientId: DUNGEONQ_INCIDENT_RECIPIENT_OWNER, idempotencyKey: 'dq-close-notify:abc',
  subject: message.subject, body: message.body, signal: new AbortController().signal, ...overrides });

test('通知：登錄的收件人經 M3 主管道送出，回執改為代號；帳本只存摘要；名單外的代號一律拒絕且不寄送', async t => {
  const f = notifierFixture(t);
  const sent = await f.notifier.send(request());
  assert.equal(sent.status, 'SENT');
  assert.match(sent.receiptId, /^notify:GMAIL_SMTP:[a-f0-9]{32}$/u);
  assert.match(sent.receiptId, /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u, 'M7 的回執格式');
  assert.equal(f.primary.calls.length, 1);
  assert.equal(f.fallback.calls.length, 0);
  assert.match(f.primary.calls[0].subject, /^\[DungeonQ 處置通知\] DungeonQ 事件/u);
  assert.match(f.primary.calls[0].text, /發生什麼/u);
  assert.equal(f.primary.calls[0].idempotencyKey, 'dq-close-notify:abc:GMAIL_SMTP');
  // 同一冪等鍵重送：回同一張回執，不再交給管道。
  assert.deepEqual(await f.reopen().send(request()), sent);
  assert.equal(f.primary.calls.length, 1);
  for (const recipientId of ['someone-else', 'owner@example.com', '', undefined]) {
    assert.deepEqual(await f.notifier.send(request({ recipientId, idempotencyKey: `other-${String(recipientId)}` })), { status: 'REJECTED', code: 'RECIPIENT_NOT_REGISTERED' });
  }
  assert.equal(f.primary.calls.length + f.fallback.calls.length, 1);
  const ledger = readFileSync(f.notifier.inspect.ledgerPath, 'utf8');
  assert.equal(statSync(f.notifier.inspect.ledgerPath).mode & 0o077, 0);
  assert.ok(!ledger.includes('provider.example'), '帳本不存供應商回執原文');
  assert.ok(!ledger.includes('發生什麼'), '帳本不存內容');
  assert.ok(!ledger.includes('someone-else@'), '帳本不存位址');
});

test('通知：內容含機密或格式不符時拒絕，不交給任何管道', async t => {
  const f = notifierFixture(t, { sensitiveValues: ['SYNTHETIC-SECRET-VALUE-123'] });
  assert.deepEqual(await f.notifier.send(request({ body: '請用 SYNTHETIC-SECRET-VALUE-123 登入', idempotencyKey: 'k1' })), { status: 'REJECTED', code: 'NOTIFY_CONTENT_SENSITIVE' });
  assert.deepEqual(await f.notifier.send(request({ body: '聯絡 oncall@example.com', idempotencyKey: 'k2' })), { status: 'REJECTED', code: 'NOTIFY_CONTENT_SENSITIVE' });
  assert.deepEqual(await f.notifier.send(request({ body: 'password: hunter2hunter2', idempotencyKey: 'k3' })), { status: 'REJECTED', code: 'NOTIFY_CONTENT_SENSITIVE' });
  assert.deepEqual(await f.notifier.send(request({ body: '', idempotencyKey: 'k4' })), { status: 'REJECTED', code: 'NOTIFY_CONTENT_INVALID' });
  assert.deepEqual(await f.notifier.send(request({ subject: 'x'.repeat(INCIDENT_WIRING_LIMITS.maxSubjectLength + 1), idempotencyKey: 'k5' })),
    { status: 'REJECTED', code: 'NOTIFY_CONTENT_INVALID' });
  assert.equal(f.primary.calls.length + f.fallback.calls.length, 0);
});

test('通知：主管道沒有回 ACCEPTED 就改走備援；兩者都被拒為 REJECTED（人重跑時可再試）；結果不明不重送', async t => {
  const switched = notifierFixture(t, { primary: ['FAILED'] });
  const viaFallback = await switched.notifier.send(request());
  assert.equal(viaFallback.status, 'SENT');
  assert.match(viaFallback.receiptId, /^notify:LINE_PUSH:/u);
  assert.equal(switched.primary.calls.length, 1);
  assert.equal(switched.fallback.calls.length, 1);

  const rejected = notifierFixture(t, { primary: ['FAILED'], fallback: ['QUOTA'] });
  assert.deepEqual(await rejected.notifier.send(request()), { status: 'REJECTED', code: 'ALL_CHANNELS_FAILED' });
  assert.deepEqual(await rejected.notifier.send(request()), { status: 'REJECTED', code: 'ALL_CHANNELS_FAILED' });
  assert.equal(rejected.primary.calls.length, 2, '明確被拒時，人重跑可以再試');

  const unknown = notifierFixture(t, { primary: ['UNKNOWN'], fallback: ['THROW'] });
  await assert.rejects(unknown.notifier.send(request()), error => error.code === 'NOTIFY_RESULT_UNKNOWN');
  await assert.rejects(unknown.reopen().send(request()), error => error.code === 'NOTIFY_RESULT_UNKNOWN');
  assert.equal(unknown.primary.calls.length, 1, '結果不明不重送');
  assert.equal(unknown.fallback.calls.length, 1);
});

test('通知：管道逾時記為結果不明並改走備援；中止時不再嘗試；每事件次數有上限', async t => {
  const slow = notifierFixture(t, { primary: ['HANG'], limits: { channelTimeoutMs: 200 } });
  const started = Date.now();
  const sent = await slow.notifier.send(request());
  assert.equal(sent.status, 'SENT');
  assert.match(sent.receiptId, /^notify:LINE_PUSH:/u);
  assert.ok(Date.now() - started < 2_000);
  const results = slow.notifier.inspect.entries().filter(entry => entry.kind === 'RESULT').map(entry => [entry.channel, entry.state]);
  assert.deepEqual(results, [['GMAIL_SMTP', 'UNKNOWN'], ['LINE_PUSH', 'ACCEPTED']]);

  const aborted = notifierFixture(t, { primary: ['HANG'] });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(aborted.notifier.send(request({ signal: controller.signal })), error => error.code === 'NOTIFY_RESULT_UNKNOWN');
  assert.equal(aborted.fallback.calls.length, 0);

  const capped = notifierFixture(t, { primary: ['FAILED'], fallback: ['FAILED'], limits: { maxSendsPerIncident: 4 } });
  assert.equal((await capped.notifier.send(request({ idempotencyKey: 'c1' }))).code, 'ALL_CHANNELS_FAILED');
  assert.equal((await capped.notifier.send(request({ idempotencyKey: 'c2' }))).code, 'ALL_CHANNELS_FAILED');
  assert.deepEqual(await capped.notifier.send(request({ idempotencyKey: 'c3' })), { status: 'REJECTED', code: 'NOTIFY_LIMIT_REACHED' });
  assert.equal(capped.primary.calls.length, 2);
});

test('通知：沒有任何管道時明確拒絕（不讀祕密檔）；登錄名單只能有一筆；M7 時限建議容得下兩個管道', async t => {
  const root = temp(t, 'dq-incident-notify-none-');
  // 設定檔路徑指向不存在的位置：M3 寄送器只檢查檔案屬性，不讀內容，也不會建立管道。
  const sender = createDungeonqAlertSender({ smtpConfigPath: join(root, 'missing-smtp.json'), lineConfigPath: join(root, 'missing-line.json') });
  assert.equal(sender.delivery.configured, false);
  const notifier = createIncidentNotifier({ sender, ledgerDirectory: join(root, 'n') });
  assert.deepEqual(await notifier.send(request()), { status: 'REJECTED', code: 'DELIVERY_NOT_CONFIGURED' });
  assert.throws(() => createIncidentNotifier({ sender, ledgerDirectory: join(root, 'n2'), recipients: [{ recipientId: 'owner' }, { recipientId: 'second' }] }),
    error => error.code === 'INCIDENT_NOTIFY_RECIPIENTS_INVALID');
  assert.throws(() => createIncidentNotifier({ sender, ledgerDirectory: 'relative' }), error => error.code === 'INCIDENT_WIRING_DIRECTORY_INVALID');
  assert.equal(recommendedCloseLimits().notifyTimeoutMs, 2 * INCIDENT_WIRING_LIMITS.channelTimeoutMs + 2_000);
  const wiring = createIncidentWiring({ caseDirectory: join(root, 'case'), sender, approvalStateDirectory: join(root, 'approvals'),
    accountPath: join(root, 'missing-account.json') });
  assert.equal(typeof wiring.notifier.send, 'function');
  assert.equal(typeof wiring.approval.verify, 'function');
  assert.equal(wiring.delivery.configured, false);
});

/* ------------------------------------------------------------------ */
/* 候選核准                                                              */
/* ------------------------------------------------------------------ */

async function approvalFixture(t, { totp = true, limits } = {}) {
  const root = temp(t, 'dq-incident-approval-');
  const { record, seed } = await createAckOperatorRecord({ operatorId: 'drill-reviewer', password: PASSWORD, totp });
  const accountPath = writeAckOperatorFile(join(root, 'private', 'ack.json'), record);
  let now = Date.now();
  const verifier = createIncidentApprovalVerifier({ accountPath, stateDirectory: join(root, 'approvals'), clock: () => now, limits });
  const code = (offsetSteps = 0) => otpAt(seed, Math.floor(now / 30_000) + offsetSteps);
  return { root, accountPath, verifier, code, advance: ms => { now += ms; }, seed };
}
const binding = { candidateId: 'rule-0123456789abcdef', candidateDigest: 'c'.repeat(64), testsDigest: 'd'.repeat(64) };
const proofOf = (overrides = {}) => ({ password: PASSWORD, candidateDigest: binding.candidateDigest, testsDigest: binding.testsDigest, ...overrides });

test('核准：Argon2id＋TOTP 驗證真人帳號並綁定兩個摘要；錯密碼、缺或重用驗證碼、摘要不符一律不通過', async t => {
  const f = await approvalFixture(t, { limits: { approvalMaxFailuresPerWindow: 20 } });
  const ask = (proof, approvalId = 'approval-1') => f.verifier.verify({ ...binding, approval: { approvalId, proof }, signal: new AbortController().signal });
  assert.deepEqual(await ask(proofOf({ password: 'wrong password for drill 0042', totp: f.code() })), { verified: false, reason: 'CREDENTIALS_INVALID' });
  assert.deepEqual(await ask(proofOf()), { verified: false, reason: 'TOTP_INVALID' }, '帳號啟用 TOTP 時必填');
  assert.deepEqual(await ask(proofOf({ totp: f.code(), candidateDigest: 'e'.repeat(64) })), { verified: false, reason: 'DIGEST_BINDING_MISMATCH' });
  assert.deepEqual(await ask(proofOf({ totp: f.code(), testsDigest: 'e'.repeat(64) })), { verified: false, reason: 'DIGEST_BINDING_MISMATCH' });
  const code = f.code();
  const ok = await ask(proofOf({ totp: code }));
  assert.deepEqual(ok, { verified: true, approverId: 'drill-reviewer', method: 'PASSWORD_TOTP', candidateDigest: binding.candidateDigest, testsDigest: binding.testsDigest });
  assert.deepEqual(await ask(proofOf({ totp: code }), 'approval-2'), { verified: false, reason: 'TOTP_INVALID' }, '同一驗證碼步數不能重用');
  f.advance(30_000);
  assert.deepEqual(await ask(proofOf({ totp: f.code() }), 'approval-1'), ok, '同一核准編號、同一綁定可再驗證');
  f.advance(30_000);
  assert.deepEqual(await f.verifier.verify({ ...binding, candidateId: 'rule-fedcba9876543210', approval: { approvalId: 'approval-1', proof: proofOf({ totp: f.code() }) } }),
    { verified: false, reason: 'APPROVAL_ID_REUSED' });
  const state = readFileSync(f.verifier.inspect.statePath, 'utf8');
  assert.ok(!state.includes(PASSWORD) && !state.includes(code), '狀態檔不存密碼或驗證碼');
  assert.equal(statSync(f.verifier.inspect.statePath).mode & 0o077, 0);
  assert.equal(f.verifier.inspect.approvals().length, 2);
});

test('核准：15 分鐘內失敗 5 次即暫停；帳號不存在時不通過；未啟用 TOTP 的帳號只驗密碼', async t => {
  const f = await approvalFixture(t);
  const ask = proof => f.verifier.verify({ ...binding, approval: { approvalId: 'approval-x', proof } });
  for (let index = 0; index < INCIDENT_WIRING_LIMITS.approvalMaxFailuresPerWindow; index++) {
    assert.equal((await ask(proofOf({ password: `wrong password attempt ${index} xx` }))).reason, 'CREDENTIALS_INVALID');
  }
  assert.deepEqual(await ask(proofOf({ totp: f.code() })), { verified: false, reason: 'APPROVAL_RATE_LIMIT' }, '正確密碼也要等窗口過去');
  f.advance(INCIDENT_WIRING_LIMITS.approvalFailureWindowMs + 1_000);
  assert.equal((await ask(proofOf({ totp: f.code() }))).verified, true);

  const missing = createIncidentApprovalVerifier({ accountPath: join(f.root, 'no-account.json'), stateDirectory: join(f.root, 'other-state') });
  assert.deepEqual(await missing.verify({ ...binding, approval: { approvalId: 'a', proof: proofOf() } }), { verified: false, reason: 'ACCOUNT_UNAVAILABLE' });

  const plain = await approvalFixture(t, { totp: false });
  const result = await plain.verifier.verify({ ...binding, approval: { approvalId: 'approval-p', proof: proofOf() } });
  assert.equal(result.method, 'PASSWORD');
  assert.equal(result.verified, true);
});

test('核准：接上 M7 候選目錄，只有測試通過且真人驗證通過才進 PUBLISHABLE；狀態檔不含核准證明', async t => {
  const f = await approvalFixture(t);
  const base = 1_800_000_000_000;
  const journalEvents = ['snapshot', 'read', 'issue-ticket', 'use-ticket'].map((operation, index) => ({ contextId: 'ctx-a', kind: 'EXECUTE', operation, at: base + index * 1000 }));
  const ticketUses = [{ contextId: 'ctx-a', entry: 'http', outcome: 'ACCEPTED', at: base + 3000, spread: [] }];
  const traces = buildIncidentTraces({ contexts: ['ctx-a'], journalEvents, ticketUses });
  const pattern = extractAttackPattern(traces);
  const [rule] = buildRuleCandidates(pattern, { incidentId: INCIDENT });
  const store = openCandidateStore({ directory: join(f.root, 'case', 'candidates') });
  store.write(rule);
  const legitimateTraces = [{ traceId: 'legitimate:legit-1', source: 'LEGITIMATE',
    events: Array.from({ length: 30 }, (_, index) => ({ at: index * 1000, kind: 'OPERATION', operation: 'read' })) }];
  const tested = store.runTests(rule.candidateId, { recordedTraces: traces, legitimateTraces, pattern });
  assert.equal(tested.state, 'TESTED');
  const proof = overrides => ({ password: PASSWORD, totp: f.code(), candidateDigest: tested.candidateDigest, testsDigest: tested.testsDigest, ...overrides });
  await assert.rejects(store.approve(rule.candidateId, { approvalId: 'approval-bad', proof: proof({ password: 'not the right password 0000' }) }, { verifier: f.verifier }),
    error => error.code === 'APPROVAL_NOT_VERIFIED');
  await assert.rejects(store.approve(rule.candidateId, { approvalId: 'approval-bad2', proof: proof({ testsDigest: 'f'.repeat(64) }) }, { verifier: f.verifier }),
    error => error.code === 'APPROVAL_NOT_VERIFIED');
  const approved = await store.approve(rule.candidateId, { approvalId: 'approval-ok', proof: proof() }, { verifier: f.verifier });
  assert.equal(approved.state, 'PUBLISHABLE');
  assert.equal(approved.publication, 'NOT_PUBLISHED');
  assert.deepEqual([approved.approval.approverId, approved.approval.method], ['drill-reviewer', 'PASSWORD_TOTP']);
  const recordText = readFileSync(join(f.root, 'case', 'candidates', 'rules', `${rule.candidateId}.json`), 'utf8');
  assert.ok(!recordText.includes(PASSWORD), '候選紀錄不存核准證明');
});

test('架構檢查：接線模組不繞過處置政策', () => {
  const path = 'scripts/dungeonq-host/incident-wiring.mjs';
  assert.deepEqual(findDungeonqResponsePolicyBypass(path, readFileSync(join(repoRoot, path), 'utf8')), []);
});
