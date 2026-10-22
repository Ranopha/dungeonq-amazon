// DQ-HANDOFF-015：摘要頁送出決策（計畫 6.1 的 t6）。執行環境只驗證會話、Origin 與單次決策權杖、記錄 t6，
// 決策本身交給主機注入的處理器（這裡是假處理器）。不讀任何祕密檔、不連外、不寄送。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPitchHandoff, PITCH_HANDOFF_DECISION_LIMITS } from '../runtime/pitch-handoff.mjs';
import { startRuntimeGateway } from '../runtime/server.mjs';
import { startCollector, startFacade, startOrigin } from '../runtime/services.mjs';
import { newToken, request } from '../runtime/transport.mjs';
import { hashPassword } from '../server/passwords.mjs';

const MINUTE = 60000;
const INCIDENT = 'incident-' + 'a'.repeat(64);
const OTHER = 'incident-' + 'b'.repeat(64);
const ORIGIN = 'http://127.0.0.1:4100';
const PASSWORD = 'correct horse battery staple 42';
const TARGET = `${INCIDENT}/flagged-context`;
const coded = code => error => error.code === code;
let passwordRecord;
test.before(async () => { passwordRecord = await hashPassword(PASSWORD); });

function fixture(t, { decision, ticketSummary } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dq-decision-')); let time = 10_000_000; const handles = [];
  const ackAccount = { schemaVersion: 'dungeonq.ack-operator/v1', operatorId: 'owner-admin', password: passwordRecord, totp: null };
  const open = (extra = {}) => {
    const handle = openPitchHandoff({ path: join(directory, 'pitch-handoff.sqlite'), clock: () => time, schedule: false, ackAccount, selfCheck: 'NONE',
      localConsole: () => {}, limits: { stage2Ms: 2 * MINUTE, stage3Ms: 5 * MINUTE, stage4Ms: 10 * MINUTE }, decision, ticketSummary, ...extra });
    handle.bindOrigin(ORIGIN); handles.push(handle); return handle;
  };
  t.after(async () => { for (const handle of handles) await handle.close(); rmSync(directory, { recursive: true, force: true }); });
  return { open, advance: ms => { time += ms; }, now: () => time };
}
const incident = (f, id = INCIDENT) => ({ incidentId: id, contextId: 'diverted', worldId: 'dungeon', epoch: 1, enteredAt: f.now() });
async function acknowledge(h, incidentId = INCIDENT) {
  const link = h.mintLink(incidentId);
  return (await h.verifyAck({ incidentId, handle: link.link.split('/').at(-1), password: PASSWORD })).summaryToken;
}
const from = { origin: ORIGIN };
async function submit(h, session, request, { incidentId = INCIDENT } = {}) {
  const { decisionToken } = await h.issueDecisionToken({ incidentId, summaryToken: session }, from);
  return h.submitDecision({ incidentId, summaryToken: session, decisionToken, request }, from);
}
function recordingHandler(results = {}) {
  const calls = [];
  const handler = async args => {
    calls.push(args);
    return results[args.request.kind] ?? { outcome: 'REJECTED', reason: 'not_scripted' };
  };
  return { calls, handler };
}

test('t6 三種決策正向：已驗證會話＋單次權杖＋本機 Origin 才交給主機處理器；結果與讀回寫入事件紀錄，不含祕密', async t => {
  const script = recordingHandler({
    EXECUTE_A_CLASS: { outcome: 'EXECUTED', readback: 'CONFIRMED', reason: 'effect_confirmed', token: 'SECRET-TOKEN-VALUE',
      policy: { effect: 'ALLOW', reason: 'a_class_within_limits', decisionDigest: 'd'.repeat(64), healthStatus: 'HEALTHY', password: 'SECRET-PASSWORD' },
      action: { actionCode: 'A-1', actionName: 'FENCE_CONTEXT', targetId: TARGET, status: 'EXECUTED', readback: 'CONFIRMED', ticket: 'SECRET-TICKET' } },
    CREATE_WORK_ORDER: { outcome: 'WORK_ORDER_CREATED', readback: 'CONFIRMED', reason: 'work_order_created',
      workOrder: { workOrderId: 'wo-' + 'c'.repeat(24), ref: 'dungeonq-work-order:wo-' + 'c'.repeat(24), status: 'OPEN', contents: 'SECRET-DECOY' } },
    START_CLOSE: { outcome: 'CLOSED', readback: 'CONFIRMED', reason: 'close_completed', close: { status: 'CLOSED', step: null, code: null,
      steps: { FREEZE: 'DONE', SEAL_EVIDENCE: 'DONE' } } }
  });
  const f = fixture(t, { decision: script.handler, ticketSummary: () => ({ tracking: true, uses: 2, spread: false }) });
  const h = f.open(); await h.start(); h.arm(incident(f));
  f.advance(MINUTE);
  const session = await acknowledge(h);
  const ackAt = f.now();
  f.advance(20_000);
  const first = await submit(h, session, { kind: 'EXECUTE_A_CLASS', actionCode: 'A-1', targetId: TARGET });
  const t6 = f.now();
  assert.equal(first.state, 'DONE'); assert.equal(first.result.outcome, 'EXECUTED'); assert.equal(first.result.readback, 'CONFIRMED');
  assert.equal(first.submittedAt, t6); assert.match(first.decisionId, /^decision-[a-f0-9-]{36}$/u);
  assert.deepEqual(first.result.policy, { effect: 'ALLOW', reason: 'a_class_within_limits', decisionDigest: 'd'.repeat(64), healthStatus: 'HEALTHY' });
  assert.equal(first.result.action.status, 'EXECUTED');
  const call = script.calls[0];
  assert.deepEqual([call.incidentId, call.request, call.submittedAt, call.firstDecisionAt], [INCIDENT, { kind: 'EXECUTE_A_CLASS', actionCode: 'A-1', targetId: TARGET }, t6, t6]);
  assert.deepEqual(call.actor.account, 'owner-admin'); assert.equal(call.acknowledgement.at, ackAt); assert.deepEqual(call.ticket, { uses: 2, spread: false });
  assert.ok(call.signal instanceof AbortSignal);
  f.advance(10_000);
  const second = await submit(h, session, { kind: 'CREATE_WORK_ORDER', actionCode: 'B-1', targetId: `${INCIDENT}/context-account` });
  assert.deepEqual([second.result.outcome, second.result.readback, second.result.workOrder.status], ['WORK_ORDER_CREATED', 'CONFIRMED', 'OPEN']);
  assert.equal(script.calls[1].firstDecisionAt, t6, 't6 是第一個送出的決策');
  const close = { verdict: 'DRILL', severity: 'HIGH', identityConfirmed: false, owner: 'DungeonQ 維護者',
    rootCause: { detection: { finding: '合成發現', improvement: '合成改善' } } };
  const third = await submit(h, session, { kind: 'START_CLOSE', close });
  assert.deepEqual([third.result.outcome, third.result.close.status], ['CLOSED', 'CLOSED']);
  assert.deepEqual(script.calls[2].request, { kind: 'START_CLOSE', close });
  // 開始結束流程之後不再接受 A 級或 B 級決策。
  await assert.rejects(submit(h, session, { kind: 'EXECUTE_A_CLASS', actionCode: 'A-5', targetId: TARGET }), coded('DECISION_INCIDENT_CLOSING'));
  assert.equal(script.calls.length, 3);
  const status = h.publicStatus();
  const events = status.events.filter(e => e.incidentId === INCIDENT);
  const submitted = events.filter(e => e.kind === 'ADMIN_DECISION_SUBMITTED');
  assert.equal(submitted.length, 3);
  assert.equal(Math.min(...submitted.map(e => e.at)), t6);
  assert.deepEqual(Object.keys(submitted.at(-1).detail).sort(), ['account', 'actionCode', 'decisionId', 'kind', 'method', 'targetId'], '自由文字不寫入事件紀錄');
  assert.equal(events.filter(e => e.kind === 'ADMIN_DECISION_RESULT').length, 3);
  assert.equal(status.incidents[0].measurements.adminDecisionAt, t6);
  const view = await h.summary({ incidentId: INCIDENT, summaryToken: session });
  assert.equal(view.decisions.configured, true);
  assert.deepEqual(view.decisions.items.map(item => [item.request.kind, item.state, item.result.outcome]),
    [['EXECUTE_A_CLASS', 'DONE', 'EXECUTED'], ['CREATE_WORK_ORDER', 'DONE', 'WORK_ORDER_CREATED'], ['START_CLOSE', 'DONE', 'CLOSED']]);
  assert.equal(view.measurements.adminDecisionAt, t6);
  const text = JSON.stringify([view, status]);
  for (const secret of ['SECRET-TOKEN-VALUE', 'SECRET-PASSWORD', 'SECRET-TICKET', 'SECRET-DECOY', '合成發現', PASSWORD]) assert.ok(!text.includes(secret), secret);
  const status2 = await h.decisionStatus({ incidentId: INCIDENT, summaryToken: session, decisionId: first.decisionId }, from);
  assert.equal(status2.result.outcome, 'EXECUTED');
});

test('拒絕：未驗證、重用、過期、錯事件、CSRF（缺 Origin、外站 Origin、沒有或偽造權杖）、格式不符；拒絕都寫入事件紀錄且不呼叫處理器', async t => {
  const script = recordingHandler({ EXECUTE_A_CLASS: { outcome: 'EXECUTED', readback: 'CONFIRMED' } });
  const f = fixture(t, { decision: script.handler });
  const h = f.open(); await h.start(); h.arm(incident(f)); h.arm(incident(f, OTHER));
  const forged = 'A'.repeat(43);
  // 未驗證：沒有 ACK 的會話。
  await assert.rejects(h.issueDecisionToken({ incidentId: INCIDENT, summaryToken: forged }, from), coded('DECISION_SESSION_DENIED'));
  const session = await acknowledge(h); const otherSession = await acknowledge(h, OTHER);
  const requestA = { kind: 'EXECUTE_A_CLASS', actionCode: 'A-1', targetId: TARGET };
  // 錯事件：A 事件的會話不能用在 B 事件；A 事件的權杖不能配 B 事件的會話。
  await assert.rejects(h.issueDecisionToken({ incidentId: OTHER, summaryToken: session }, from), coded('DECISION_INCIDENT_MISMATCH_DENIED'));
  const { decisionToken: tokenA } = await h.issueDecisionToken({ incidentId: INCIDENT, summaryToken: session }, from);
  await assert.rejects(h.submitDecision({ incidentId: OTHER, summaryToken: otherSession, decisionToken: tokenA, request: requestA }, from), coded('DECISION_TOKEN_DENIED'));
  // CSRF：缺 Origin、外站 Origin、沒有權杖、偽造權杖。
  await assert.rejects(h.issueDecisionToken({ incidentId: INCIDENT, summaryToken: session }, {}), coded('DECISION_ORIGIN_DENIED'));
  await assert.rejects(h.submitDecision({ incidentId: INCIDENT, summaryToken: session, decisionToken: tokenA, request: requestA }, { origin: 'https://evil.example' }),
    coded('DECISION_ORIGIN_DENIED'));
  await assert.rejects(h.submitDecision({ incidentId: INCIDENT, summaryToken: session, decisionToken: '', request: requestA }, from), coded('DECISION_TOKEN_DENIED'));
  await assert.rejects(h.submitDecision({ incidentId: INCIDENT, summaryToken: session, decisionToken: forged, request: requestA }, from), coded('DECISION_TOKEN_DENIED'));
  await assert.rejects(h.submitDecision({ incidentId: INCIDENT, summaryToken: session, request: requestA }, from), coded('INVALID_ENVELOPE'));
  // 外站 Origin 被拒時權杖沒有被消耗；本機送出成功一次後，同一權杖重用被拒。
  const ok = await h.submitDecision({ incidentId: INCIDENT, summaryToken: session, decisionToken: tokenA, request: requestA }, from);
  assert.equal(ok.result.outcome, 'EXECUTED');
  await assert.rejects(h.submitDecision({ incidentId: INCIDENT, summaryToken: session, decisionToken: tokenA, request: requestA }, from), coded('DECISION_TOKEN_USED_DENIED'));
  // 被主機拒絕的結束請求不算開始結束流程，之後仍可送 A 級決策。
  assert.equal((await submit(h, session, { kind: 'START_CLOSE', close: { verdict: 'DRILL' } })).result.outcome, 'REJECTED');
  assert.equal((await submit(h, session, requestA)).result.outcome, 'EXECUTED', '被拒絕的結束請求不算開始');
  // 新權杖取代同一會話尚未使用的舊權杖。
  const { decisionToken: older } = await h.issueDecisionToken({ incidentId: INCIDENT, summaryToken: session }, from);
  await h.issueDecisionToken({ incidentId: INCIDENT, summaryToken: session }, from);
  await assert.rejects(h.submitDecision({ incidentId: INCIDENT, summaryToken: session, decisionToken: older, request: requestA }, from), coded('DECISION_TOKEN_USED_DENIED'));
  // 格式不符：權杖照樣消耗，不能拿去重送。
  const { decisionToken: badRequest } = await h.issueDecisionToken({ incidentId: INCIDENT, summaryToken: session }, from);
  await assert.rejects(h.submitDecision({ incidentId: INCIDENT, summaryToken: session, decisionToken: badRequest, request: { kind: 'RUN_SHELL', command: 'x' } }, from),
    coded('DECISION_REQUEST_INVALID'));
  await assert.rejects(h.submitDecision({ incidentId: INCIDENT, summaryToken: session, decisionToken: badRequest, request: requestA }, from), coded('DECISION_TOKEN_USED_DENIED'));
  // 過期：權杖 5 分鐘；會話 15 分鐘。
  const { decisionToken: stale } = await h.issueDecisionToken({ incidentId: INCIDENT, summaryToken: session }, from);
  f.advance(PITCH_HANDOFF_DECISION_LIMITS.tokenTtlMs + 1000);
  await assert.rejects(h.submitDecision({ incidentId: INCIDENT, summaryToken: session, decisionToken: stale, request: requestA }, from), coded('DECISION_TOKEN_EXPIRED_DENIED'));
  f.advance(15 * MINUTE);
  await assert.rejects(h.issueDecisionToken({ incidentId: INCIDENT, summaryToken: session }, from), coded('DECISION_SESSION_EXPIRED_DENIED'));
  assert.equal(script.calls.length, 3, '只有通過全部檢查的請求交給處理器');
  const reasons = new Set(h.publicStatus().events.filter(e => e.kind === 'ADMIN_DECISION_REJECTED').map(e => e.detail.reason));
  for (const reason of ['DECISION_SESSION_DENIED', 'DECISION_INCIDENT_MISMATCH_DENIED', 'DECISION_TOKEN_DENIED', 'DECISION_ORIGIN_DENIED', 'DECISION_TOKEN_USED_DENIED',
    'DECISION_REQUEST_INVALID', 'DECISION_TOKEN_EXPIRED_DENIED', 'DECISION_SESSION_EXPIRED_DENIED']) assert.ok(reasons.has(reason), reason);
  // 沒有接上處理器：只能檢視摘要。
  const g = fixture(t); const plain = g.open(); await plain.start(); plain.arm(incident(g));
  const plainSession = await acknowledge(plain);
  await assert.rejects(plain.issueDecisionToken({ incidentId: INCIDENT, summaryToken: plainSession }, from), coded('ADMIN_DECISION_NOT_CONFIGURED'));
  assert.equal((await plain.summary({ incidentId: INCIDENT, summaryToken: plainSession })).decisions.configured, false);
});

test('處理中：先回覆 RUNNING，同一事件同時只處理一個；結果之後可讀；處理器失敗記 FAILED；關閉時中斷記不明且不重跑', async t => {
  let release; let calls = 0;
  const handler = async ({ request, signal }) => {
    calls += 1;
    if (request.actionCode === 'A-3') throw new Error('boom');
    if (request.actionCode === 'A-4') return new Promise(resolve => signal.addEventListener('abort', () => resolve({ outcome: 'EXECUTED' }), { once: true }));
    return new Promise(resolve => { release = () => resolve({ outcome: 'EXECUTED', readback: 'CONFIRMED' }); });
  };
  const f = fixture(t, { decision: handler });
  const h = f.open(); await h.start(); h.arm(incident(f));
  const session = await acknowledge(h);
  const running = await submit(h, session, { kind: 'EXECUTE_A_CLASS', actionCode: 'A-1', targetId: TARGET });
  assert.equal(running.state, 'RUNNING'); assert.equal(running.result, null);
  await assert.rejects(submit(h, session, { kind: 'EXECUTE_A_CLASS', actionCode: 'A-5', targetId: TARGET }), coded('DECISION_IN_PROGRESS'));
  release();
  for (let n = 0; n < 50; n++) { if ((await h.decisionStatus({ incidentId: INCIDENT, summaryToken: session, decisionId: running.decisionId }, from)).state === 'DONE') break; await new Promise(r => setTimeout(r, 20)); }
  const done = await h.decisionStatus({ incidentId: INCIDENT, summaryToken: session, decisionId: running.decisionId }, from);
  assert.deepEqual([done.state, done.result.outcome], ['DONE', 'EXECUTED']);
  const failed = await submit(h, session, { kind: 'EXECUTE_A_CLASS', actionCode: 'A-3', targetId: TARGET });
  assert.deepEqual([failed.state, failed.result.outcome, failed.result.reason], ['DONE', 'FAILED', 'DECISION_HANDLER_ERROR']);
  const interrupted = await submit(h, session, { kind: 'EXECUTE_A_CLASS', actionCode: 'A-4', targetId: TARGET });
  assert.equal(interrupted.state, 'RUNNING');
  await h.close();
  const reopened = f.open(); await reopened.start();
  const after = (await reopened.summary({ incidentId: INCIDENT, summaryToken: session })).decisions.items.at(-1);
  assert.deepEqual([after.decisionId, after.state, after.result], [interrupted.decisionId, 'UNKNOWN', null]);
  assert.equal(calls, 3, '中斷的決策不重跑');
  // 重啟後舊的決策權杖全部失效。
  await assert.rejects(reopened.submitDecision({ incidentId: INCIDENT, summaryToken: session, decisionToken: 'C'.repeat(43),
    request: { kind: 'EXECUTE_A_CLASS', actionCode: 'A-1', targetId: TARGET } }, from), coded('DECISION_TOKEN_DENIED'));
});

test('gateway：ACK 頁有送出決策區、決策端點只在本機且必須帶本機 Origin；t6 出現在交接狀態', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dq-decision-gw-'));
  const credentials = Object.fromEntries(['owner', 'actor', 'other', 'ordinary', 'seal', 'producer', 'reader', 'witness'].map(key => [key, newToken()]));
  const origin = await startOrigin({ path: join(directory, 'origin.sqlite'), normalToken: credentials.ordinary, witnessToken: credentials.witness });
  const collector = await startCollector({ path: join(directory, 'collector.sqlite'), producerToken: credentials.producer, readerToken: credentials.reader });
  const calls = []; const sent = [];
  const gateway = await startRuntimeGateway({ directory, credentials, originOrigin: origin.origin, collectorOrigin: collector.origin,
    network: false, hostBroker: false, presentation: 'pitching-v1', facadeFactory: stateOrigin => startFacade({ stateOrigin }),
    pitchingLimits: { deliveryTimeoutMs: 25000, deliveryLeaseMs: 30000, deliveryAttempts: 3, retryBaseMs: 15000 },
    alertHandoff: { notifier: { channels: [{ name: 'GMAIL_SMTP', role: 'PRIMARY', async send(message) { sent.push(message); return { state: 'ACCEPTED', receiptId: `r-${sent.length}` }; } }] },
      selfCheck: 'NONE', limits: { stage2Ms: 60000, stage3Ms: 120000, stage4Ms: 180000 },
      ackAccount: { schemaVersion: 'dungeonq.ack-operator/v1', operatorId: 'owner-admin', password: passwordRecord, totp: null }, localConsole: () => {},
      decision: async args => { calls.push(args); return { outcome: 'WORK_ORDER_CREATED', readback: 'CONFIRMED', workOrder: { workOrderId: 'wo-' + 'e'.repeat(24), status: 'OPEN' } }; } } });
  t.after(async () => { await gateway.close(); await collector.close(); await origin.close(); rmSync(directory, { recursive: true, force: true }); });
  await request(gateway.origin, '/api/operate', credentials.actor, { requestId: 'enter', operation: 'snapshot', args: {} });
  for (let n = 0; n < 100 && sent.length === 0; n++) await new Promise(r => setTimeout(r, 50));
  const [, incidentId, handle] = /\/ack\/(incident-[a-f0-9]{64})\/([A-Za-z0-9_-]{43})/.exec(sent[0].text);
  const page = await (await fetch(`${gateway.origin}/ack/${incidentId}/${handle}`)).text();
  assert.match(page, /送出決策/u); assert.match(page, /id="decide-form"/u);
  assert.match(readFileSync(new URL('../public/runtime/ack.mjs', import.meta.url), 'utf8'), /\/ack\/decision\/token/u);
  const post = async (path, body, headers = {}) => {
    const response = await fetch(gateway.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const self = { Origin: gateway.origin };
  const ack = await post('/ack/verify', { incidentId, handle, password: PASSWORD });
  const session = ack.body.summaryToken;
  const noOrigin = await post('/ack/decision/token', { incidentId, summaryToken: session });
  assert.deepEqual([noOrigin.status, noOrigin.body.error.code], [403, 'DECISION_ORIGIN_DENIED']);
  const crossSite = await post('/ack/decision/token', { incidentId, summaryToken: session }, { Origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);
  const token = await post('/ack/decision/token', { incidentId, summaryToken: session }, self);
  assert.equal(token.status, 200);
  const body = { kind: 'CREATE_WORK_ORDER', actionCode: 'B-1', targetId: `${incidentId}/context-account` };
  const decided = await post('/ack/decision', { incidentId, summaryToken: session, decisionToken: token.body.decisionToken, request: body }, self);
  assert.deepEqual([decided.status, decided.body.state, decided.body.result.outcome], [200, 'DONE', 'WORK_ORDER_CREATED']);
  const replay = await post('/ack/decision', { incidentId, summaryToken: session, decisionToken: token.body.decisionToken, request: body }, self);
  assert.deepEqual([replay.status, replay.body.error.code], [403, 'DECISION_TOKEN_USED_DENIED']);
  const status = await post('/ack/decision/status', { incidentId, summaryToken: session, decisionId: decided.body.decisionId }, self);
  assert.equal(status.body.result.workOrder.workOrderId, 'wo-' + 'e'.repeat(24));
  assert.equal(calls.length, 1); assert.equal(calls[0].actor.account, 'owner-admin');
  const handoff = await request_(gateway, credentials);
  assert.equal(handoff.incidents[0].measurements.adminDecisionAt, decided.body.submittedAt);
  assert.ok(handoff.events.some(e => e.kind === 'ADMIN_DECISION_SUBMITTED'));
});
const request_ = (gateway, credentials) => request(gateway.origin, '/api/pitching/handoff/status', credentials.owner);
