// DQ-HANDOFF-015 M3：告警交接經真實 gateway（入場告警、ticket 更新、ACK 頁、持久計時器跨重啟、停用開關）。假管道，不連外。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRuntimeGateway } from '../runtime/server.mjs';
import { startCollector, startFacade, startOrigin } from '../runtime/services.mjs';
import { newToken, request } from '../runtime/transport.mjs';
import { hashPassword } from '../server/passwords.mjs';

const PASSWORD = 'correct horse battery staple 42';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const op = (requestId, operation = 'snapshot', args = {}) => ({ requestId, operation, args });
let passwordRecord;
test.before(async () => { passwordRecord = await hashPassword(PASSWORD); });

function channel(name, role) {
  const calls = [];
  return { name, role, inbox: false, calls, async send(message) { calls.push(message); return { state: 'ACCEPTED', receiptId: `${name}-${calls.length}` }; } };
}
async function fixture(t, { stages = { stage2Ms: 60000, stage3Ms: 120000, stage4Ms: 180000 }, safeDefault, deliveryTimeoutMs = 25000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dq-handoff-gw-'));
  const credentials = Object.fromEntries(['owner', 'actor', 'other', 'ordinary', 'seal', 'producer', 'reader', 'witness'].map(key => [key, newToken()]));
  const origin = await startOrigin({ path: join(directory, 'origin.sqlite'), normalToken: credentials.ordinary, witnessToken: credentials.witness });
  const collector = await startCollector({ path: join(directory, 'collector.sqlite'), producerToken: credentials.producer, readerToken: credentials.reader });
  const primary = channel('GMAIL_SMTP', 'PRIMARY'); const fallback = channel('LINE_PUSH', 'FALLBACK');
  const alerts = []; const safeCalls = []; const summaries = [];
  let gateway;
  const start = () => startRuntimeGateway({ directory, credentials, originOrigin: origin.origin, collectorOrigin: collector.origin,
    network: false, hostBroker: false, presentation: 'pitching-v1', wrongTicketTracking: {},
    pitchingLimits: { deliveryTimeoutMs, deliveryLeaseMs: 30000, deliveryAttempts: 3, retryBaseMs: 15000 },
    facadeFactory: stateOrigin => startFacade({ stateOrigin }),
    alertHandoff: { notifier: { channels: [primary, fallback] }, selfCheck: 'NONE', limits: stages,
      ackAccount: { schemaVersion: 'dungeonq.ack-operator/v1', operatorId: 'owner-admin', password: passwordRecord, totp: null },
      localConsole: alert => alerts.push(alert),
      safeDefault: safeDefault ? async input => { safeCalls.push(input); return safeDefault(input); } : undefined,
      summary: async ({ incidentId }) => { summaries.push(incidentId);
        return { realAssetReads: { count: 0, status: 'MEASURED' }, workOrders: { status: 'LEDGER', pendingCount: 0, items: [] },
          leaked: { token: 'must-not-appear', ticket: 'must-not-appear', note: 'kept' } }; } } });
  t.after(async () => { await gateway?.close(); await collector.close(); await origin.close(); rmSync(directory, { recursive: true, force: true }); });
  gateway = await start();
  return { credentials, primary, fallback, alerts, safeCalls, summaries, get r() { return gateway; },
    async stop() { await gateway.close(); gateway = undefined; }, async restart() { if (gateway) await gateway.close(); gateway = await start(); return gateway; } };
}
const actor = (f, input) => request(f.r.origin, '/api/operate', f.credentials.actor, input);
const owner = (f, path, input) => request(f.r.origin, path, f.credentials.owner, input);
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('TIMEOUT'); await sleep(50); }
}
async function post(f, path, body) {
  const response = await fetch(f.r.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test('N-1／N-3 gateway 入場告警經自己的寄送器送出；ticket 使用與擴散更新經同一寄送器', async t => {
  const f = await fixture(t);
  const before = await owner(f, '/api/pitching/status');
  assert.equal(before.deliveryConfigured, true); assert.deepEqual(before.alertHandoff.channels.map(c => c.name), ['GMAIL_SMTP', 'LINE_PUSH']);
  await actor(f, op('enter'));
  const status = await until(async () => { const s = await owner(f, '/api/pitching/status'); return s.outbox[0]?.status === 'ACCEPTED' && s; });
  assert.match(status.outbox[0].receiptId, /^delivery-/); assert.equal(f.primary.calls.length, 1); assert.equal(f.fallback.calls.length, 0);
  const response = await owner(f, '/api/pitching/response/status');
  assert.equal(response.events.find(e => e.kind === 'PROVIDER_ACCEPTED').assurance, 'LOCAL_OUTBOX_ACCEPTANCE');
  const issued = await actor(f, op('issue', 'issue-ticket', { scope: ['catalog-current'], maxUses: 4, ttlMs: 600000 }));
  await actor(f, op('use-1', 'use-ticket', { ticket: issued.ticket, key: 'catalog-current' }));
  await until(() => f.primary.calls.length === 2);
  assert.match(f.primary.calls[1].subject, /錯誤 ticket 使用更新.*第 1 封/u);
  // Spread: the same handle from another verified context is released at once (D9 supplement).
  await request(f.r.origin, '/api/operate', f.credentials.other, op('use-other', 'use-ticket', { ticket: issued.ticket, key: 'catalog-current' })).catch(() => {});
  await until(() => f.primary.calls.length === 3);
  assert.match(f.primary.calls[2].subject, /首次擴散/u);
  for (const message of f.primary.calls) assert(!message.text.includes(issued.ticket), 'no ticket value leaves the runtime');
  const ledger = (await owner(f, '/api/pitching/status')).ticketLedger;
  assert.deepEqual(ledger.updates.map(u => u.status), ['ACCEPTED', 'ACCEPTED']);
  const handoff = await owner(f, '/api/pitching/handoff/status');
  assert.deepEqual(handoff.deliveries.map(d => d.scope.split(':')[0]).sort(), ['ENTRY', 'TICKET', 'TICKET']);
});

test('N-4 ACK 頁：本機開啟、密碼驗證、記錄 HUMAN_ACK 與帳號、摘要不含祕密；錯誤一律拒絕', async t => {
  const f = await fixture(t);
  await actor(f, op('enter'));
  await until(() => f.primary.calls.length === 1);
  const incidentId = (await owner(f, '/api/pitching/status')).incidents[0].incidentId;
  const link = /http:\/\/127\.0\.0\.1:\d+\/ack\/incident-[a-f0-9]{64}\/[A-Za-z0-9_-]{43}/.exec(f.primary.calls[0].text)[0];
  const handle = link.split('/').at(-1);
  const page = await fetch(link);
  assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/); assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await fetch(f.r.origin + '/ack/app.mjs')).status, 200);
  const forged = await post(f, '/ack/verify', { incidentId, handle: 'A'.repeat(43), password: PASSWORD });
  assert.equal(forged.status, 403); assert.equal(forged.body.error.code, 'ACK_LINK_DENIED');
  const wrong = await post(f, '/ack/verify', { incidentId, handle, password: 'not the operator password' });
  assert.equal(wrong.body.error.code, 'ACK_CREDENTIALS_DENIED');
  const otherIncident = 'incident-' + 'f'.repeat(64);
  assert.equal((await post(f, '/ack/verify', { incidentId: otherIncident, handle, password: PASSWORD })).body.error.code, 'ACK_INCIDENT_MISMATCH_DENIED');
  const ok = await post(f, '/ack/verify', { incidentId, handle, password: PASSWORD });
  assert.equal(ok.status, 200); assert.equal(ok.body.account, 'owner-admin');
  assert.equal((await post(f, '/ack/verify', { incidentId, handle, password: PASSWORD })).body.error.code, 'ACK_LINK_USED_DENIED');
  const summary = await post(f, '/ack/summary', { incidentId, summaryToken: ok.body.summaryToken });
  assert.equal(summary.status, 200); assert.equal(summary.body.stage.current, 'HUMAN_ACKNOWLEDGED');
  assert.equal(summary.body.host.realAssetReads.count, 0); assert.equal(summary.body.host.leaked.note, 'kept');
  assert.equal(summary.body.ticket.tracking, true);
  const text = JSON.stringify(summary.body);
  for (const secret of [f.credentials.owner, f.credentials.actor, 'must-not-appear', PASSWORD]) assert(!text.includes(secret));
  const control = await owner(f, '/api/pitching/status');
  assert.equal(control.incidents[0].acknowledgement.operatorId, 'owner-admin');
  const human = (await owner(f, '/api/pitching/response/status')).events.find(e => e.kind === 'HUMAN_ACK');
  assert.deepEqual([human.evidenceKind, human.assurance, human.performer], ['VERIFIED_ACK_LINK', 'LOCAL_VERIFIED_LOGIN', 'HUMAN']);
  // Cross-site browser requests and requests without the loopback Host are refused by the shared transport.
  const crossSite = await fetch(f.r.origin + '/ack/verify', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(crossSite.status, 403);
  await assert.rejects(request(f.r.origin, '/api/pitching/handoff/status', f.credentials.actor), error => error.code === 'UNAUTHORIZED');
});

test('N-5／N-6 持久計時器跨 gateway 重啟：到期立即處理、逾時預設動作只執行一次並結案', async t => {
  const f = await fixture(t, { stages: { stage2Ms: 1200, stage3Ms: 2400, stage4Ms: 3600 },
    safeDefault: async () => ({ outcome: 'EFFECTIVE', closureReason: 'AUTO_SAFE_DEFAULT', actions: [{ actionCode: 'A-1', status: 'EXECUTED', readback: 'CONFIRMED' }] }) });
  await actor(f, op('enter'));
  await until(() => f.fallback.calls.length === 1, 5000);
  assert.match(f.fallback.calls[0].subject, /第 2 階段/u);
  await f.stop();
  await sleep(2600);
  await f.restart();
  const status = await until(async () => { const s = await owner(f, '/api/pitching/handoff/status'); return s.incidents[0].closure && s; }, 5000);
  assert.equal(status.incidents[0].closure.reason, 'AUTO_SAFE_DEFAULT');
  assert.equal(f.safeCalls.length, 1); assert.equal(f.safeCalls[0].trigger.kind, 'ACK_TIMEOUT');
  const stage3 = status.incidents[0].stages.find(s => s.stage === 3);
  assert.equal(stage3.status, 'DONE'); assert(stage3.firedAt - stage3.dueAt >= 0);
  const fired = status.events.filter(e => e.kind === 'STAGE_FIRED').map(e => e.detail.stage).sort();
  assert.deepEqual(fired, [2, 3, 4], 'each stage fired exactly once across the restart');
  await sleep(500); assert.equal(f.safeCalls.length, 1);
});

test('停用開關：取消升級、保留入場 outbox 給選配轉送；設定不正確即拒絕啟動', async t => {
  const f = await fixture(t, { stages: { stage2Ms: 1000, stage3Ms: 2000, stage4Ms: 3000 } });
  const disabled = await owner(f, '/api/pitching/handoff/disable', { reason: '演練中止' });
  assert.equal(disabled.disabled, true);
  await actor(f, op('enter'));
  await sleep(1500);
  const status = await owner(f, '/api/pitching/status');
  assert.equal(status.outbox[0].status, 'PENDING', 'nothing is claimed while the kill switch is on');
  assert.equal(status.alertHandoff.sendingEnabled, false);
  assert.equal(f.primary.calls.length + f.fallback.calls.length, 0);
  const g = mkdtempSync(join(tmpdir(), 'dq-handoff-bad-')); t.after(() => rmSync(g, { recursive: true, force: true }));
  const credentials = Object.fromEntries(['owner', 'actor', 'other', 'ordinary', 'seal', 'producer', 'reader', 'witness'].map(key => [key, newToken()]));
  await assert.rejects(startRuntimeGateway({ directory: g, credentials, presentation: 'pitching-v1', network: false, hostBroker: false,
    alertSender: async () => ({ accepted: true, receiptId: 'x' }), alertHandoff: { notifier: { channels: [] } } }), error => error.code === 'PITCH_HANDOFF_INVALID');
  await assert.rejects(startRuntimeGateway({ directory: g, credentials, presentation: 'participant-v1', network: false, hostBroker: false,
    alertHandoff: { notifier: { channels: [] } } }), error => error.code === 'PITCH_HANDOFF_INVALID');
});

test('入場 outbox 逾時短於兩個管道的時間預算時拒絕啟動', async t => {
  await assert.rejects(fixture(t, { deliveryTimeoutMs: 5000 }), error => error.code === 'PITCH_HANDOFF_LIMITS_INVALID');
});

test('N-7 供應商持續暫時性拒絕：入場告警重送次數有上限、間隔拉長，之後停止', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dq-handoff-retry-'));
  const credentials = Object.fromEntries(['owner', 'actor', 'other', 'ordinary', 'seal', 'producer', 'reader', 'witness'].map(key => [key, newToken()]));
  const origin = await startOrigin({ path: join(directory, 'origin.sqlite'), normalToken: credentials.ordinary, witnessToken: credentials.witness });
  const collector = await startCollector({ path: join(directory, 'collector.sqlite'), producerToken: credentials.producer, readerToken: credentials.reader });
  const times = { GMAIL_SMTP: [], LINE_PUSH: [] };
  const failing = (name, role) => ({ name, role, async send() { times[name].push(Date.now()); return { state: 'RETRY' }; } });
  let gateway;
  t.after(async () => { await gateway?.close(); await collector.close(); await origin.close(); rmSync(directory, { recursive: true, force: true }); });
  gateway = await startRuntimeGateway({ directory, credentials, originOrigin: origin.origin, collectorOrigin: collector.origin,
    network: false, hostBroker: false, presentation: 'pitching-v1', facadeFactory: stateOrigin => startFacade({ stateOrigin }),
    pitchingLimits: { deliveryTimeoutMs: 25000, deliveryLeaseMs: 30000, deliveryAttempts: 3, retryBaseMs: 200 },
    alertHandoff: { notifier: { channels: [failing('GMAIL_SMTP', 'PRIMARY'), failing('LINE_PUSH', 'FALLBACK')] }, selfCheck: 'NONE',
      localConsole: () => {}, limits: { stage2Ms: 600000, stage3Ms: 1200000, stage4Ms: 1800000 } } });
  await request(gateway.origin, '/api/operate', credentials.actor, op('enter'));
  const status = await until(async () => { const s = await request(gateway.origin, '/api/pitching/status', credentials.owner); return s.outbox[0].status === 'EXHAUSTED' && s; }, 8000);
  assert.equal(status.outbox[0].attempts, 3);
  await sleep(1500);
  assert.equal(times.GMAIL_SMTP.length, 3, 'one send plus two bounded resends, then stop');
  assert.equal(times.LINE_PUSH.length, 3);
  const gaps = times.GMAIL_SMTP.slice(1).map((at, index) => at - times.GMAIL_SMTP[index]);
  assert(gaps[1] > gaps[0], 'intervals grow');
});
