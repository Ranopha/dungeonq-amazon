import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAckOperatorRecord, writeAckOperatorFile, verifyAckOperatorLocally } from './ack-operator.mjs';
import { openHumanSourceHandoff } from './human-source-handoff.mjs';
import { humanSourceMetrics } from './human-source-drill.mjs';
import { otpAt } from '../../vendor/dungeonq-runtime/server/totp.mjs';
import { persistSourceAlert, respondToSourceAlert } from './source-response.mjs';
const incidentId = `incident-${'a'.repeat(64)}`;
const PASSWORD = 'synthetic test operator password';

async function fixture(t, execute = async () => ({ result: { status: 'EXECUTED', readback: 'CONFIRMED' } }), sourceWitness, executeClose) {
  const directory = mkdtempSync(join(tmpdir(), 'dq-m9-human-test-'));
  const account = await createAckOperatorRecord({ password: PASSWORD, totp: true });
  const accountPath = join(directory, 'operator.json'); writeAckOperatorFile(accountPath, account.record);
  const messages = [], events = [], calls = [];
  const alert = sourceWitness ? persistSourceAlert({ directory, witness: sourceWitness, emit: () => {} }) : { incidentId, receivedAt: Date.now() };
  const ui = await openHumanSourceHandoff({ directory, alert, accountPath,
    schedule: false, observationMode: 'SCRIPTED_TEST', emit: (kind, detail) => events.push({ kind, detail }),
    sender: { notifier: { channels: [{ name: 'TEST', role: 'PRIMARY',
      send: async message => { messages.push(message); return { state: 'ACCEPTED', receiptId: 'test-only' }; } }] } },
    execute: async (value, guard) => { calls.push(value); return execute(value, guard); }, executeClose
  });
  t.after(async () => { await ui.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = async (path, input, origin = ui.origin) => {
    const result = await fetch(ui.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(input) });
    return { status: result.status, body: await result.json() };
  };
  await ui.sendEntry();
  assert(!messages[0].text.includes('系統會執行逾時預設安全動作'));
  assert(messages[0].text.includes('未確認或未決策不會輪替'));
  const link = JSON.stringify(messages).match(/http:\/\/127\.0\.0\.1:\d+\/ack\/incident-[a-f0-9]{64}\/([A-Za-z0-9_-]{43})/);
  assert(link, 'test delivery contains an ACK link');
  const login = () => post('/ack/verify', { incidentId: alert.incidentId, handle: link[1], password: PASSWORD, totp: otpAt(account.seed, Math.floor(Date.now() / 30000)) });
  return { directory, ui, post, login, calls, events, link: link[0] };
}

test('HTTP 會話先驗證 TOTP，限定事件與 A-2 對象；決策重播不重做', async t => {
  const f = await fixture(t);
  const page = await fetch(f.link); assert.equal(page.status, 200); assert((await page.text()).includes('ack'));
  const guest = { incidentId, summaryToken: 'g'.repeat(43) };
  assert.equal((await f.post('/ack/decision/token', guest)).status, 403);
  const logged = await f.login(); assert.equal(logged.status, 200); assert.equal(logged.body.method, 'PASSWORD_TOTP');
  const session = { incidentId, summaryToken: logged.body.summaryToken };
  assert.equal((await f.post('/ack/decision/token', session, 'http://example.invalid')).status, 403);
  assert.equal((await f.post('/ack/decision/token', { ...session, incidentId: `incident-${'b'.repeat(64)}` })).status, 403);
  const token = async () => (await f.post('/ack/decision/token', session)).body.decisionToken;
  const request = { kind: 'EXECUTE_A_CLASS', actionCode: 'A-2', targetId: 'source-credential' };
  const bad = await f.post('/ack/decision', { ...session, decisionToken: await token(), request: { ...request, targetId: 'another-credential' } });
  assert.equal(bad.body.result.outcome, 'REJECTED'); assert.equal(f.calls.length, 0);
  const input = { ...session, decisionToken: await token(), request };
  const done = await f.post('/ack/decision', input);
  assert.equal(done.body.result.outcome, 'EXECUTED'); assert.equal(f.calls.length, 1);
  assert.equal((await f.post('/ack/decision', input)).status, 403);
  assert.equal((await f.post('/ack/decision', { ...session, decisionToken: await token(), request })).body.result.outcome, 'REJECTED');
  assert.equal(f.calls.length, 1); assert.equal(f.events.find(row => row.kind === 'VERIFIED_ACK').detail.observationMode, 'SCRIPTED_TEST');
});

for (const uncertain of [false, true]) test(`結案必須在 rotate 後由同事件真人另送，重播不重做（UNKNOWN=${uncertain}）`, async t => {
  let closes = 0;
  const executeClose = async () => {
    closes++; if (uncertain) throw Object.assign(Error('unknown'), { code: 'CLOSE_TRANSPORT_UNKNOWN' });
    return { status: 'CLOSED', steps: {} };
  };
  executeClose.validate = value => { if (value.request.close.verdict !== 'DRILL') throw Object.assign(Error('invalid'), { code: 'CLOSE_INPUT_INVALID' }); };
  const f = await fixture(t, undefined, undefined, executeClose);
  const logged = await f.login(); const session = { incidentId, summaryToken: logged.body.summaryToken };
  const submit = async request => f.post('/ack/decision', { ...session,
    decisionToken: (await f.post('/ack/decision/token', session)).body.decisionToken, request });
  const request = { kind: 'START_CLOSE', close: { verdict: 'DRILL' } };
  assert.equal((await submit(request)).body.result.outcome, 'REJECTED'); assert.equal(closes, 0);
  assert.equal((await submit({ kind: 'EXECUTE_A_CLASS', actionCode: 'A-2', targetId: 'source-credential' })).body.result.outcome, 'EXECUTED');
  assert.equal((await submit({ kind: 'START_CLOSE', close: { verdict: 'invalid' } })).body.result.outcome, 'REJECTED');
  assert.equal(closes, 0, '輸入拒絕後仍可修正，不開始結案');
  assert.equal((await submit(request)).body.result.outcome, uncertain ? 'UNKNOWN' : 'CLOSED');
  assert.equal((await submit(request)).body.result.outcome, 'REJECTED'); assert.equal(closes, 1);
  assert.equal(f.events.filter(row => row.kind === 'HUMAN_CLOSE_DECISION').length, 1);
});

test('執行結果不明保留 UNKNOWN，第二個有效決策也不重送', async t => {
  const f = await fixture(t, async () => { throw Error('transport interrupted'); });
  const logged = await f.login();
  const session = { incidentId, summaryToken: logged.body.summaryToken };
  const decide = async () => f.post('/ack/decision', { ...session,
    decisionToken: (await f.post('/ack/decision/token', session)).body.decisionToken,
    request: { kind: 'EXECUTE_A_CLASS', actionCode: 'A-2', targetId: 'source-credential' } });
  assert.equal((await decide()).body.result.outcome, 'UNKNOWN');
  assert.equal((await decide()).body.result.outcome, 'REJECTED'); assert.equal(f.calls.length, 1);
});

test('M3 決策與來源事件不符時，Policy 前置閘門拒絕輪替', async t => {
  let committed = false;
  const witness = { head: 'scoped-test', tenantId: 'reference', resource: 'deployment-manifest',
    events: [{ kind: 'TARGET_DENIED', requestId: 'participant-test', seq: 1, at: Date.now() }] };
  // 這是無傳輸測試，獨立目錄與測試帳號；絕不把這筆 ACK 算入真人結果。
  const f = await fixture(t, async (_value, guard) => {
    const alert = persistSourceAlert({ directory: f.directory, witness, emit: () => {} });
    return respondToSourceAlert({ directory: f.directory, witness, existingAlert: alert,
      beforeExecute: facts => {
        // fixture 的 M3 事件與來源事件需一致，否則真實 guard 應拒絕。
        assert.throws(() => guard(facts), /HUMAN SOURCE POLICY SCOPE DENIED/);
        throw Object.assign(Error('deliberately mismatched incident'), { code: 'SOURCE_BINDING_DENIED' });
      },
      rpc: async input => {
        if (input.action === 'commit') committed = true;
        return { status: 200, body: input.action === 'status' ? { epoch: 1 } : witness };
      }, emit: () => {}, health: { measure: async () => ({ measuredAt: new Date().toISOString(), sampleCount: 8,
        baseline: { successRate: 1, p95LatencyMs: 20 }, current: { successRate: 1, p95LatencyMs: 20 } }) } });
  });
  const logged = await f.login(), session = { incidentId, summaryToken: logged.body.summaryToken };
  const result = await f.post('/ack/decision', { ...session, decisionToken: (await f.post('/ack/decision/token', session)).body.decisionToken,
    request: { kind: 'EXECUTE_A_CLASS', actionCode: 'A-2', targetId: 'source-credential' } });
  assert.equal(result.body.result.outcome, 'UNKNOWN'); assert.equal(committed, false);
  assert.equal(f.ui.execution().error, 'SOURCE_BINDING_DENIED');
});

test('M3 已驗證決策串到真實 Policy 與 M5，測試來源輪替讀回成功', async t => {
  let committed = false;
  const witness = { head: 'matching-test', tenantId: 'reference', resource: 'deployment-manifest',
    events: [{ kind: 'TARGET_DENIED', requestId: 'participant-match', seq: 1, at: Date.now() }] };
  const f = await fixture(t, async (_value, guard) => respondToSourceAlert({ directory: f.directory, witness,
    existingAlert: JSON.parse(readFileSync(join(f.directory, 'alert.json'))), beforeExecute: guard, emit: () => {},
    health: { measure: async () => ({ measuredAt: new Date().toISOString(), sampleCount: 8,
      baseline: { successRate: 1, p95LatencyMs: 20 }, current: { successRate: 1, p95LatencyMs: 20 } }) },
    rpc: async input => {
      if (input.action === 'probe') return ['MAIN', 'A2', 'CACHE', 'EXPORT'].map(channel => ({ channel,
        status: committed && input.credential === 'old' ? 403 : 200 }));
      if (input.action === 'commit') committed = true;
      return { status: 200, body: input.action === 'status' ? { epoch: 1 } : input.action === 'witness' ? witness : { status: committed ? 'EFFECTIVE' : 'PREPARED' } };
    } }), witness);
  const logged = await f.login(), session = { incidentId: logged.body.incidentId, summaryToken: logged.body.summaryToken };
  let result = await f.post('/ack/decision', { ...session, decisionToken: (await f.post('/ack/decision/token', session)).body.decisionToken,
    request: { kind: 'EXECUTE_A_CLASS', actionCode: 'A-2', targetId: 'source-credential' } });
  const decisionId = result.body.decisionId;
  for (let count = 0; result.body.state === 'RUNNING' && count < 10; count++) {
    await delay(500); result = await f.post('/ack/decision/status', { ...session, decisionId });
  }
  assert.equal(result.body.result.outcome, 'EXECUTED', JSON.stringify({ execution: f.ui.execution(), events: f.events })); assert.equal(committed, true);
  assert.equal(f.events.find(row => row.kind === 'HUMAN_POLICY_AUTHORIZATION').detail.authorized, true);
});

test('沒有本人 ACK 不執行；缺時間點維持 null 與 UNKNOWN', async t => {
  const f = await fixture(t); assert.equal(f.calls.length, 0); assert.equal(f.ui.execution(), null);
  const result = humanSourceMetrics({ alert: { receivedAt: 100 }, handoff: f.ui.status(), events: [] });
  assert.equal(result.humanResponseMs, null); assert.equal(result.rotationVerifiedAt, null);
  assert.equal(result.extraTimeFromDungeonQ, 'NOT_PROVEN');
});

test('host commit 上下界與真人耗時分離，收件匣未知不冒充到達', () => {
  const result = humanSourceMetrics({ alert: { receivedAt: 100 },
    handoff: { incidents: [{ measurements: { providerAcceptedAt: 200, verifiedHumanAckAt: 400, inboxArrival: { status: 'UNKNOWN', at: null } } }] },
    response: { timing: { alertToEffectiveHostBoundsMs: [600, 650] } },
    events: [{ kind: 'HUMAN_ROTATE_DECISION', detail: { submittedAt: 500 } }, { kind: 'ROTATION_VERIFIED', at: 1000 }] });
  assert.deepEqual(result.providerToEffectiveHostBoundsMs, [500, 550]);
  assert.deepEqual(result.decisionToEffectiveHostBoundsMs, [200, 250]);
  assert.equal(result.humanResponseMs, 800); assert.equal(result.providerToAckMs, 200);
  assert.equal(result.inboxArrival.status, 'UNKNOWN');
});

test('已保存的來源告警不可替換成其他事件或修改時間', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dq-m9-alert-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const witness = { head: 'test', tenantId: 'reference', resource: 'deployment-manifest',
    events: [{ kind: 'TARGET_DENIED', requestId: 'participant-test', seq: 1, at: Date.now() }] };
  const alert = persistSourceAlert({ directory, witness, emit: () => {} });
  assert.equal(JSON.parse(readFileSync(join(directory, 'alert.json'))).incidentId, alert.incidentId);
  await assert.rejects(respondToSourceAlert({ directory, witness, existingAlert: { ...alert, receivedAt: 0 } }), /SOURCE_ALERT_MISMATCH/);
});

test('設定預檢必須有可用密碼與 TOTP，不產生事件 ACK', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dq-m9-readiness-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { record, seed } = await createAckOperatorRecord({ password: PASSWORD, totp: true });
  const path = join(directory, 'operator.json'); writeAckOperatorFile(path, record);
  const now = Date.now(), totp = otpAt(seed, Math.floor(now / 30000));
  const ready = await verifyAckOperatorLocally({ path, password: PASSWORD, totp, now });
  assert.equal(ready.incidentAcknowledged, false); assert.equal(ready.method, 'PASSWORD_TOTP');
  await assert.rejects(verifyAckOperatorLocally({ path, password: PASSWORD, totp: '', now }), /預檢未通過/);
  await assert.rejects(verifyAckOperatorLocally({ path, password: 'wrong password', totp, now }), /預檢未通過/);
});
