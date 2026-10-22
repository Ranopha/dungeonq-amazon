// DQ-HANDOFF-015 M3：告警交接（N-1～N-7）。全部使用注入的假管道，不讀任何祕密檔、不連外。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openPitchHandoff } from '../runtime/pitch-handoff.mjs';
import { hashPassword } from '../server/passwords.mjs';
import { base32, otpAt } from '../server/totp.mjs';

const MINUTE = 60000;
const INCIDENT = 'incident-' + 'a'.repeat(64);
const OTHER = 'incident-' + 'b'.repeat(64);
const PASSWORD = 'correct horse battery staple 42';
const coded = code => error => error.code === code;
let passwordRecord;
test.before(async () => { passwordRecord = await hashPassword(PASSWORD); });

function channel(name, role, script = [], { inbox = role === 'PRIMARY' } = {}) {
  const calls = []; const logins = [];
  return { name, role, inbox, calls, logins, script,
    async send(message) { calls.push(message); const next = script.length ? script.shift() : { state: 'ACCEPTED' };
      if (typeof next === 'function') return next(message);
      return next.state === 'ACCEPTED' ? { state: 'ACCEPTED', receiptId: next.receiptId ?? `${name}-receipt-${calls.length}` } : next; },
    async checkLogin() { logins.push(Date.now()); return { state: 'OK' }; } };
}
function fixture(t, { primary = [], fallback = [], noFallback = false, account, totp, ...options } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dq-handoff-')); let time = 10_000_000; const handles = [];
  const alerts = [];
  const channels = { primary: channel('GMAIL_SMTP', 'PRIMARY', primary), fallback: noFallback ? null : channel('LINE_PUSH', 'FALLBACK', fallback) };
  const seed = totp ? randomBytes(20) : null;
  const ackAccount = account === null ? undefined : { schemaVersion: 'dungeonq.ack-operator/v1', operatorId: 'owner-admin', password: passwordRecord, totp: seed ? base32(seed) : null };
  const open = (extra = {}) => {
    const handle = openPitchHandoff({ path: join(directory, 'pitch-handoff.sqlite'), clock: () => time, schedule: false,
      notifier: { channels: [channels.primary, channels.fallback].filter(Boolean) }, ackAccount, selfCheck: 'NONE',
      localConsole: alert => alerts.push(alert), limits: { stage2Ms: 2 * MINUTE, stage3Ms: 5 * MINUTE, stage4Ms: 10 * MINUTE }, ...options, ...extra });
    handle.bindOrigin('http://127.0.0.1:4100'); handles.push(handle); return handle;
  };
  t.after(async () => { for (const handle of handles) await handle.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, open, channels, alerts, seed, advance: ms => { time += ms; }, now: () => time };
}
const incident = (f, id = INCIDENT) => ({ incidentId: id, contextId: 'diverted', worldId: 'dungeon', epoch: 1, enteredAt: f.now() });
const kinds = status => status.events.map(e => e.kind);
const handleOf = link => link.link.split('/').at(-1);
const stage = (status, n, id = INCIDENT) => status.incidents.find(i => i.incidentId === id).stages.find(s => s.stage === n);

test('N-1 主管道成功：只走主管道，回執與四個量測時間點分開記錄', async t => {
  const f = fixture(t); const h = f.open(); await h.start();
  const result = await h.entrySend({ idempotencyKey: `pitch-alert-v1:${INCIDENT}`, incident: incident(f), attempt: 1 });
  assert.equal(result.accepted, true); assert.match(result.receiptId, /^delivery-/);
  assert.equal(f.channels.primary.calls.length, 1); assert.equal(f.channels.fallback.calls.length, 0);
  const message = f.channels.primary.calls[0];
  assert.match(message.subject, /^\[DungeonQ 測試告警\] .*第 1 階段.*\[DQA[0-9A-F]{10}\]$/u);
  assert.match(message.text, /^\[DungeonQ 測試告警\]\n/u);
  assert.match(message.text, /http:\/\/127\.0\.0\.1:4100\/ack\/incident-a{64}\/[A-Za-z0-9_-]{43}/);
  assert.doesNotMatch(message.text, /password|secret|IMT_/i);
  const status = h.publicStatus(); const m = status.incidents[0].measurements;
  assert.equal(m.queueCreatedAt, f.now()); assert.equal(m.providerAcceptedAt, f.now()); assert.equal(m.providerChannel, 'GMAIL_SMTP');
  assert.equal(m.verifiedHumanAckAt, null); assert.equal(m.inboxArrival.status, 'NOT_APPLICABLE');
  assert(!kinds(status).includes('CHANNEL_SWITCH'));
});

test('N-2 主管道被拒或逾時結果不明：記錄切換、不盲目重送主管道、改走備援', async t => {
  for (const [label, outcome] of [['拒絕', { state: 'FAILED' }], ['結果不明', { state: 'UNKNOWN' }], ['逾時', () => new Promise(() => {})]]) {
    await t.test(label, async t2 => {
      const f = fixture(t2, { primary: [outcome], limits: { stage2Ms: 2 * MINUTE, stage3Ms: 5 * MINUTE, stage4Ms: 10 * MINUTE, channelTimeoutMs: 200 } });
      const h = f.open(); await h.start();
      const result = await h.entrySend({ idempotencyKey: 'k', incident: incident(f), attempt: 1 });
      assert.equal(result.accepted, true);
      assert.equal(f.channels.primary.calls.length, 1); assert.equal(f.channels.fallback.calls.length, 1);
      const status = h.publicStatus();
      const sw = status.events.find(e => e.kind === 'CHANNEL_SWITCH');
      assert.deepEqual([sw.detail.from, sw.detail.to], ['GMAIL_SMTP', 'LINE_PUSH']);
      assert.equal(status.deliveries.find(d => d.channel === 'GMAIL_SMTP').status, typeof outcome === 'function' ? 'UNKNOWN' : outcome.state);
      // A second control attempt never re-sends a channel whose outcome is UNKNOWN/FAILED or already ACCEPTED.
      await h.entrySend({ idempotencyKey: 'k', incident: incident(f), attempt: 2 });
      assert.equal(f.channels.primary.calls.length, 1); assert.equal(f.channels.fallback.calls.length, 1);
    });
  }
});

test('N-2 兩個管道都失敗：本機最高優先告警（含本機 ACK 連結），升級時間表照常推進', async t => {
  const f = fixture(t, { primary: [{ state: 'FAILED' }, { state: 'FAILED' }, { state: 'FAILED' }], fallback: [{ state: 'FAILED' }, { state: 'FAILED' }, { state: 'FAILED' }],
    safeDefault: async () => ({ outcome: 'EFFECTIVE', closureReason: 'AUTO_SAFE_DEFAULT', actions: [] }) });
  const h = f.open(); await h.start();
  const result = await h.entrySend({ idempotencyKey: 'k', incident: incident(f), attempt: 1 });
  assert.deepEqual(result, { accepted: false, definitive: true, retryable: false });
  assert.equal(f.alerts.length, 1); assert.equal(f.alerts[0].level, 'CRITICAL'); assert.match(f.alerts[0].ackLink, /\/ack\/incident-a{64}\//);
  f.advance(2 * MINUTE); await h.tick();
  assert.equal(stage(h.publicStatus(), 2).status, 'FAILED', 'stage 2 still fires on schedule');
  f.advance(3 * MINUTE); await h.tick(); f.advance(5 * MINUTE); await h.tick();
  const status = h.publicStatus();
  assert.equal(stage(status, 3).status, 'FAILED'); assert.equal(stage(status, 4).status, 'DONE');
  assert.equal(status.incidents[0].closure.reason, 'AUTO_SAFE_DEFAULT', 'notification failure never delays the safe default');
  assert(f.alerts.filter(a => a.level === 'CRITICAL').length >= 3);
});

test('LINE 429／額度用盡：管道標為不可用並寫入事件紀錄，之後不再呼叫', async t => {
  const f = fixture(t, { primary: [{ state: 'FAILED' }, { state: 'FAILED' }], fallback: [{ state: 'QUOTA' }] });
  const h = f.open(); await h.start();
  await h.entrySend({ idempotencyKey: 'k', incident: incident(f), attempt: 1 });
  let status = h.publicStatus();
  const line = status.channels.find(c => c.name === 'LINE_PUSH');
  assert(line.unavailableUntil > f.now()); assert.equal(line.reason, 'QUOTA_OR_RATE_LIMIT');
  assert(kinds(status).includes('CHANNEL_UNAVAILABLE'));
  f.advance(2 * MINUTE); await h.tick();
  assert.equal(f.channels.fallback.calls.length, 1, 'an unavailable channel is skipped, not called');
  status = h.publicStatus();
  assert(status.events.some(e => e.kind === 'DELIVERY_SKIPPED' && e.detail.reason === 'CHANNEL_UNAVAILABLE'));
  assert.equal(f.channels.primary.calls.length, 2, 'stage 2 falls back to the primary channel');
});

test('N-5 計時器跨重啟：到期時間持久化，重啟後立即處理、不重新起算；同階段只觸發一次', async t => {
  const f = fixture(t); let h = f.open(); await h.start();
  const t0 = f.now(); h.arm(incident(f));
  assert.deepEqual(h.publicStatus().incidents[0].stages.map(s => s.dueAt), [t0 + 2 * MINUTE, t0 + 5 * MINUTE, t0 + 10 * MINUTE]);
  await h.close();
  f.advance(3 * MINUTE);
  h = f.open(); await h.start({ entered: [incident(f)] });
  const status = h.publicStatus();
  assert.equal(status.incidents[0].t0, t0, 're-arming after restart keeps the original T0');
  const fired = stage(status, 2);
  assert.equal(fired.status, 'DONE'); assert.equal(fired.firedAt, f.now());
  assert.equal(status.events.find(e => e.kind === 'STAGE_FIRED').detail.lateMs, MINUTE);
  assert.equal(f.channels.fallback.calls.length, 1); assert.match(f.channels.fallback.calls[0].subject, /第 2 階段/u);
  await h.tick(); await h.tick();
  assert.equal(f.channels.fallback.calls.length, 1, 'same stage never fires twice');
  f.advance(2 * MINUTE); await h.tick();
  assert.equal(stage(h.publicStatus(), 3).status, 'DONE');
  assert.equal(f.channels.primary.calls.length, 1); assert.equal(f.channels.fallback.calls.length, 2);
  assert.match(f.channels.primary.calls[0].subject, /【最高優先】第 3 階段/u);
});

test('N-5 執行中斷：FIRING 階段重啟後記 UNKNOWN，不重跑', async t => {
  const f = fixture(t, { fallback: [() => new Promise(() => {})], limits: { stage2Ms: 2 * MINUTE, stage3Ms: 5 * MINUTE, stage4Ms: 10 * MINUTE, channelTimeoutMs: 30000 } });
  let h = f.open(); await h.start(); h.arm(incident(f));
  f.advance(2 * MINUTE); void h.tick();
  await new Promise(resolve => setTimeout(resolve, 20));
  await h.close(); h = f.open(); await h.start();
  const status = h.publicStatus();
  assert.equal(stage(status, 2).status, 'UNKNOWN'); assert.equal(stage(status, 2).result.reason, 'INTERRUPTED_BY_RESTART');
  assert.equal(status.deliveries[0].status, 'UNKNOWN');
  assert.equal(f.channels.fallback.calls.length, 1);
});

async function ack(h, f, { link, password = PASSWORD, incidentId = INCIDENT, totp } = {}) {
  link ??= h.mintLink(incidentId);
  return h.verifyAck({ incidentId, handle: handleOf(link), password, ...(totp ? { totp } : {}) });
}

test('N-4／N-5 已驗證 ACK：記錄帳號與方式、取消後續階段、之後不再升級', async t => {
  const acknowledged = [];
  const f = fixture(t, { onAcknowledged: value => acknowledged.push(value) });
  const h = f.open(); await h.start(); h.arm(incident(f));
  f.advance(MINUTE);
  const result = await ack(h, f);
  assert.equal(result.acknowledged, true); assert.equal(result.account, 'owner-admin'); assert.equal(result.method, 'PASSWORD');
  assert.equal(result.ackLatencyMs, MINUTE); assert.match(result.summaryToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(acknowledged.length, 1); assert.equal(acknowledged[0].account, 'owner-admin');
  const summary = await h.summary({ incidentId: INCIDENT, summaryToken: result.summaryToken });
  assert.equal(summary.stage.current, 'HUMAN_ACKNOWLEDGED'); assert.equal(summary.nextEscalation, null);
  assert.equal(summary.acknowledgement.account, 'owner-admin'); assert.equal(summary.host.status, 'NOT_CONFIGURED');
  f.advance(20 * MINUTE); await h.tick();
  const status = h.publicStatus();
  assert(status.incidents[0].stages.every(s => s.status === 'CANCELLED'));
  assert.equal(f.channels.primary.calls.length + f.channels.fallback.calls.length, 0);
  assert.equal(status.incidents[0].measurements.verifiedHumanAckAt, f.now() - 20 * MINUTE);
  assert(status.events.some(e => e.kind === 'HUMAN_ACK' && e.detail.account === 'owner-admin'));
  await assert.rejects(h.summary({ incidentId: OTHER, summaryToken: result.summaryToken }), coded('ACK_SESSION_DENIED'));
  await assert.rejects(h.summary({ incidentId: INCIDENT, summaryToken: result.summaryToken }), coded('ACK_SESSION_DENIED'));
});

test('N-4 偽造、重用、過期、錯事件、錯密碼一律拒絕；失敗達上限鎖定連結', async t => {
  const f = fixture(t); const h = f.open(); await h.start(); h.arm(incident(f)); h.arm(incident(f, OTHER));
  await assert.rejects(h.verifyAck({ incidentId: INCIDENT, handle: 'x'.repeat(43), password: PASSWORD }), coded('ACK_LINK_DENIED'));
  await assert.rejects(h.verifyAck({ incidentId: INCIDENT, handle: 'short', password: PASSWORD }), coded('ACK_LINK_DENIED'));
  const otherLink = h.mintLink(OTHER);
  await assert.rejects(ack(h, f, { link: otherLink, incidentId: INCIDENT }), coded('ACK_INCIDENT_MISMATCH_DENIED'));
  const expired = h.mintLink(INCIDENT); f.advance(61 * MINUTE);
  await assert.rejects(ack(h, f, { link: expired }), coded('ACK_LINK_EXPIRED_DENIED'));
  const locked = h.mintLink(INCIDENT);
  for (let n = 0; n < 4; n++) await assert.rejects(ack(h, f, { link: locked, password: 'wrong password value 1234' }), coded('ACK_CREDENTIALS_DENIED'));
  f.advance(16 * MINUTE);
  await assert.rejects(ack(h, f, { link: locked, password: 'wrong password value 1234' }), coded('ACK_CREDENTIALS_DENIED'));
  await assert.rejects(ack(h, f, { link: locked }), coded('ACK_LINK_LOCKED_DENIED'), 'a locked link stays locked even with the right password');
  const good = h.mintLink(INCIDENT); const spare = h.mintLink(INCIDENT);
  assert.equal((await ack(h, f, { link: good })).acknowledged, true);
  await assert.rejects(ack(h, f, { link: good }), coded('ACK_LINK_USED_DENIED'));
  await assert.rejects(ack(h, f, { link: spare }), coded('ACK_LINK_USED_DENIED'), 'other links of an acknowledged incident are superseded');
  assert.equal(h.mintLink(INCIDENT), null, 'no new link after acknowledgement');
  const status = h.publicStatus();
  assert.deepEqual([...new Set(status.events.filter(e => e.kind === 'ACK_REJECTED').map(e => e.detail.reason))].sort(),
    ['CREDENTIALS_INVALID', 'EXPIRED', 'FORGED', 'LOCKED', 'REUSED', 'WRONG_INCIDENT']);
  assert.equal(status.incidents.find(i => i.incidentId === OTHER).acknowledgement, null);
});

test('N-4 帳號啟用 TOTP 時必填；同一驗證碼不能重用；全域失敗次數限流', async t => {
  const f = fixture(t, { totp: true }); const h = f.open(); await h.start(); h.arm(incident(f)); h.arm(incident(f, OTHER));
  await assert.rejects(ack(h, f), coded('ACK_CREDENTIALS_DENIED'), 'password alone is not enough');
  const code = otpAt(f.seed, Math.floor(f.now() / 30000));
  const first = await ack(h, f, { totp: code });
  assert.equal(first.method, 'PASSWORD_TOTP');
  await assert.rejects(ack(h, f, { incidentId: OTHER, totp: code }), coded('ACK_CREDENTIALS_DENIED'), 'a TOTP step is never reused');
  for (let n = 0; n < 8; n++) await assert.rejects(ack(h, f, { incidentId: OTHER, password: 'wrong password value 1234' }), coded('ACK_CREDENTIALS_DENIED'));
  await assert.rejects(ack(h, f, { incidentId: OTHER, totp: otpAt(f.seed, Math.floor(f.now() / 30000) + 1) }), coded('ACK_RATE_LIMIT'));
});

test('N-4 未設定 ACK 帳號：無法確認，升級照常', async t => {
  const f = fixture(t, { account: null }); const h = f.open(); await h.start(); h.arm(incident(f));
  assert.equal(h.accountStatus(), 'MISSING');
  await assert.rejects(ack(h, f), coded('ACK_ACCOUNT_UNAVAILABLE'));
  f.advance(2 * MINUTE); await h.tick();
  assert.equal(stage(h.publicStatus(), 2).status, 'DONE');
});

test('N-6 逾時預設動作：只以 ACK_TIMEOUT 觸發一次，讀回生效才記 AUTO_SAFE_DEFAULT；未生效升級本機告警', async t => {
  const calls = [];
  const f = fixture(t, { safeDefault: async input => { calls.push(input); return { outcome: 'EFFECTIVE', closureReason: 'AUTO_SAFE_DEFAULT',
    actions: [{ actionCode: 'A-1', status: 'EXECUTED', readback: 'CONFIRMED' }, { actionCode: 'A-5', status: 'EXECUTED', readback: 'CONFIRMED' }],
    decisions: [{ actionCode: 'A-1', effect: 'ALLOW' }, { actionCode: 'A-5', effect: 'ALLOW' }] }; } });
  const h = f.open(); await h.start(); h.arm(incident(f));
  f.advance(10 * MINUTE); await h.tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].trigger.kind, 'ACK_TIMEOUT'); assert.equal(calls[0].incidentId, INCIDENT);
  assert.equal(calls[0].contextId, 'diverted'); assert.equal(calls[0].epoch, 1); assert(calls[0].signal instanceof AbortSignal);
  const status = h.publicStatus();
  assert.equal(status.incidents[0].closure.reason, 'AUTO_SAFE_DEFAULT');
  assert.deepEqual(stage(status, 4).result.actions.map(a => a.readback), ['CONFIRMED', 'CONFIRMED']);
  assert(f.channels.primary.calls.some(m => /第 4 階段/u.test(m.subject)), 'the administrator is told the default ran');
  f.advance(10 * MINUTE); await h.tick(); assert.equal(calls.length, 1);
  const link = h.mintLink(INCIDENT); const late = await ack(h, f, { link });
  const summary = await h.summary({ incidentId: INCIDENT, summaryToken: late.summaryToken });
  assert.equal(summary.stage.current, 'CLOSED_AUTO_SAFE_DEFAULT', 'a late human ACK never rewrites the automatic closure');
});

test('N-6 預設動作被政策拒絕、未生效或逾時：不結案、本機最高優先告警', async t => {
  for (const [label, impl, expected] of [
    ['政策拒絕', async () => ({ outcome: 'DENIED', reason: 'limit_exceeded:global_hourly' }), 'FAILED'],
    ['讀回未生效', async () => ({ outcome: 'NOT_EFFECTIVE' }), 'FAILED'],
    ['結案原因不符', async () => ({ outcome: 'EFFECTIVE', closureReason: 'HUMAN' }), 'FAILED'],
    ['逾時', () => new Promise(() => {}), 'UNKNOWN']]) {
    await t.test(label, async t2 => {
      const f = fixture(t2, { safeDefault: impl, limits: { stage2Ms: 2 * MINUTE, stage3Ms: 5 * MINUTE, stage4Ms: 10 * MINUTE, safeDefaultTimeoutMs: 1000 } });
      const h = f.open(); await h.start(); h.arm(incident(f)); f.advance(10 * MINUTE); await h.tick();
      const status = h.publicStatus();
      assert.equal(status.incidents[0].closure, null);
      assert.equal(stage(status, 4).status, expected);
      assert(f.alerts.some(a => a.level === 'CRITICAL' && a.stage === 4));
    });
  }
});

test('N-7 失敗路徑：暫時性拒絕的重送有上限且間隔逐次拉長；結果不明不重送；閒置時沒有任何寄送', async t => {
  const f = fixture(t, { primary: Array(10).fill({ state: 'RETRY' }), fallback: Array(10).fill({ state: 'RETRY' }) });
  const h = f.open(); await h.start(); h.arm(incident(f));
  f.advance(2 * MINUTE); await h.tick();
  for (let n = 0; n < 6 && stage(h.publicStatus(), 2).status === 'RETRY_WAIT'; n++) { f.advance(15000 * 2 ** n); await h.tick(); }
  const row = stage(h.publicStatus(), 2);
  assert.equal(row.status, 'FAILED'); assert.equal(row.retries, 2);
  assert.equal(f.channels.fallback.calls.length, 3, 'one send plus at most two resends per channel');
  assert.equal(f.channels.primary.calls.length, 3);
  const fired = h.publicStatus().events.filter(e => e.kind === 'STAGE_FIRED' && e.detail.stage === 2).map(e => e.at).reverse();
  assert.deepEqual(fired.slice(1).map((at, i) => at - fired[i]), [15000, 30000], 'backoff grows');
  // UNKNOWN is never re-sent: stage 3 sees one UNKNOWN primary and a RETRY fallback, then stops.
  f.channels.primary.script.splice(0, Infinity, { state: 'UNKNOWN' }); f.channels.fallback.script.splice(0, Infinity, { state: 'RETRY' }, { state: 'RETRY' });
  f.advance(5 * MINUTE); await h.tick();
  assert.equal(stage(h.publicStatus(), 3).status, 'FAILED', 'an UNKNOWN outcome stops automatic resending');
  assert.equal(f.channels.primary.calls.length, 4);
  h.disable({ reason: 'test finished' });
  // Idle: a fresh directory with no incident for a simulated week sends nothing.
  const g = fixture(t); const idle = g.open(); await idle.start();
  for (let day = 0; day < 7; day++) { g.advance(24 * 60 * MINUTE); await idle.tick(); }
  assert.equal(g.channels.primary.calls.length + g.channels.fallback.calls.length, 0);
});

test('N-7 閒置時只有每天至多一次的登入自我檢查，不寄信；明確設定才寄測試信', async t => {
  const f = fixture(t, { selfCheck: 'LOGIN' }); let h = f.open(); await h.start();
  assert.equal(f.channels.primary.logins.length, 1); assert.equal(f.channels.fallback.logins.length, 1);
  await h.tick(); f.advance(23 * 60 * MINUTE); await h.tick();
  assert.equal(f.channels.primary.logins.length, 1, 'at most once a day');
  await h.close(); h = f.open(); await h.start();
  assert.equal(f.channels.primary.logins.length, 1, 'a restart inside the day does not re-check');
  f.advance(61 * MINUTE); await h.tick();
  assert.equal(f.channels.primary.logins.length, 2);
  assert.equal(f.channels.primary.calls.length + f.channels.fallback.calls.length, 0, 'LOGIN mode never sends');
  const g = fixture(t, { selfCheck: 'SEND' }); const s = g.open(); await s.start();
  assert.equal(g.channels.primary.calls.length, 1); assert.match(g.channels.primary.calls[0].subject, /管道自我檢查/u);
});

test('停用開關：取消所有待執行階段、停止寄送與 ACK 連結；每管道每日寄送上限', async t => {
  const f = fixture(t, { limits: { stage2Ms: 2 * MINUTE, stage3Ms: 5 * MINUTE, stage4Ms: 10 * MINUTE, channelDailyLimit: 2 } });
  const h = f.open(); await h.start();
  await h.entrySend({ idempotencyKey: 'k', incident: incident(f), attempt: 1 });
  await h.entrySend({ idempotencyKey: 'k', incident: incident(f, OTHER), attempt: 1 });
  h.arm({ ...incident(f), incidentId: 'incident-' + 'c'.repeat(64) });
  await h.entrySend({ idempotencyKey: 'k', incident: incident(f, 'incident-' + 'c'.repeat(64)), attempt: 1 });
  assert.equal(f.channels.primary.calls.length, 2, 'daily limit reached');
  assert(h.publicStatus().events.some(e => e.kind === 'CHANNEL_DAILY_LIMIT'));
  assert.equal(h.disable({ reason: '演練結束' }).cancelledStages, 9);
  assert.equal(h.sendingEnabled(), false);
  f.advance(30 * MINUTE); await h.tick();
  assert.equal(f.channels.fallback.calls.length, 1, 'no escalation after the kill switch');
  assert.equal(h.disable({ reason: '再按一次' }).replayed, true);
});

test('D13 收件匣量測：每 10 秒查一次，找到即停；10 分鐘內沒找到記 UNKNOWN 並停止', async t => {
  const probes = []; let arrive = null;
  const f = fixture(t, { inboxProbe: { async find({ tokens }) { probes.push([...tokens]); return { found: arrive ? { [tokens[0]]: arrive } : {} }; } } });
  const h = f.open(); await h.start();
  await h.entrySend({ idempotencyKey: 'k', incident: incident(f), attempt: 1 });
  assert.equal(h.publicStatus().deliveries[0].inbox.status, 'PENDING');
  await h.tick(); f.advance(5000); await h.tick();
  assert.equal(probes.length, 1, 'at most one probe per interval');
  f.advance(5000); arrive = f.now() - 3000; await h.tick();
  assert.equal(probes.length, 2);
  let delivery = h.publicStatus().deliveries[0];
  assert.deepEqual([delivery.inbox.status, delivery.inbox.at, delivery.inbox.checks], ['FOUND', arrive, 2]);
  f.advance(60000); await h.tick(); assert.equal(probes.length, 2, 'stops once found');
  const g = fixture(t, { inboxProbe: { async find() { throw new Error('imap down'); } } });
  const k = g.open(); await k.start();
  await k.entrySend({ idempotencyKey: 'k', incident: incident(g), attempt: 1 });
  k.disable({ reason: 'measure inbox only' });
  for (let n = 0; n < 70; n++) { g.advance(10000); await k.tick(); }
  assert.equal(k.publicStatus().deliveries.length, 1, 'the kill switch stops escalation but not the bounded inbox measurement');
  delivery = k.publicStatus().deliveries[0];
  assert.equal(delivery.inbox.status, 'UNKNOWN'); assert(delivery.inbox.checks <= 60);
  assert.equal(k.publicStatus().incidents[0].measurements.inboxArrival.status, 'UNKNOWN');
});

test('設定釘選：既有目錄改上限或管道一律拒絕，不靜默重設', async t => {
  const f = fixture(t); const h = f.open(); await h.close();
  assert.throws(() => f.open({ limits: { stage2Ms: 3 * MINUTE, stage3Ms: 5 * MINUTE, stage4Ms: 10 * MINUTE } }), coded('HANDOFF_CONFIG_CHANGED'));
  assert.throws(() => f.open({ notifier: { channels: [f.channels.primary] } }), coded('HANDOFF_CONFIG_CHANGED'));
  assert.throws(() => f.open({ limits: { stage2Ms: 6 * MINUTE } }), coded('PITCH_HANDOFF_LIMITS_INVALID'));
});

test('ACK 帳號檔：0600、一般檔才接受', async t => {
  const { loadAckAccountFile } = await import('../runtime/pitch-handoff.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'dq-ack-account-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'ack.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 'dungeonq.ack-operator/v1', operatorId: 'owner', password: passwordRecord, totp: null }), { mode: 0o644 });
  assert.throws(() => loadAckAccountFile(path), coded('ACK_ACCOUNT_INVALID'));
  writeFileSync(join(directory, 'ok.json'), JSON.stringify({ schemaVersion: 'dungeonq.ack-operator/v1', operatorId: 'owner', password: passwordRecord, totp: null }), { mode: 0o600 });
  assert.equal(loadAckAccountFile(join(directory, 'ok.json')).operatorId, 'owner');
});
