// DQ-HANDOFF-015 M2：錯誤 ticket 帳本、擴散標記與 D9 告警節流（單元層）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPitchControl, ticketHandleDigest } from '../runtime/pitch-control.mjs';

const error = code => cause => cause.code === code;
const MINUTE = 60000;
function fixture(t, ticketTracking = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dungeonq-ticket-ledger-'));
  const path = join(directory, 'pitch.sqlite'); let time = 1_000_000; const handles = [];
  const config = { path, clock: () => time, ...(ticketTracking === null ? {} : { ticketTracking }) };
  const open = (extra = {}) => { const handle = openPitchControl({ ...config, ...extra }); handles.push(handle); return handle; };
  t.after(() => { for (const handle of handles) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  return { path, open, advance: delta => { time += delta; }, now: () => time };
}
// Create the incident exactly as the gateway does: lease, bind, then admitted entry.
function enter(control, contextId, worldId = `world-${contextId}`) {
  const lease = control.begin({ family: 'http' }); control.bind(lease, { contextId });
  control.recordEntry({ contextId, worldId, epoch: 1, eventId: `entry-${contextId}` });
  control.finish(lease, { outcome: 'SERVED', code: 'OK' });
}
const ticketId = n => String(n).padStart(64, 'a');
function issue(control, { n = 1, contextId = 'context-a', source = '127.0.0.1', at = 1_000_000 } = {}) {
  const handle = `handle-${n}-${contextId}`;
  control.trackTicket({ ticketId: ticketId(n), handleDigest: ticketHandleDigest(handle), contextId, worldId: `world-${contextId}`,
    epoch: 1, entry: 'http', issuedAt: at, expiresAt: at + 3_600_000, source });
  return handle;
}
const use = (control, handle, { contextId = 'context-a', source = '127.0.0.1', entry = 'http', position = 'ARGUMENT', client = 'test-client/1' } = {}) =>
  control.recordTicketUse({ handleDigest: ticketHandleDigest(handle), contextId, entry, position, client, source });
const rows = path => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('SELECT count(*) AS n FROM pitch_ticket_uses').get().n; } finally { db.close(); } };

test('預設停用：設定、schema 與狀態形狀不變；啟停不能在同一資料庫靜默切換', t => {
  const f = fixture(t, null); const plain = f.open();
  assert.equal(plain.ticketTracking, false); assert.equal(Object.hasOwn(plain.snapshot(), 'ticketLedger'), false);
  assert.throws(() => plain.recordTicketUse({ handleDigest: 'a'.repeat(64), contextId: null, entry: 'http', position: 'ARGUMENT' }), error('PITCH_TICKET_TRACKING_DISABLED'));
  plain.close();
  assert.throws(() => openPitchControl({ path: f.path, clock: () => 1, ticketTracking: {} }), error('AUXILIARY_SCHEMA_CHANGED'));
  const g = fixture(t, {}); g.open().close();
  assert.throws(() => openPitchControl({ path: g.path, clock: () => 1 }), error('AUXILIARY_SCHEMA_CHANGED'));
  assert.throws(() => openPitchControl({ path: g.path, clock: () => 1, ticketTracking: { digestIntervalMs: 1000 } }), error('PITCH_CONFIG_CHANGED'));
  assert.throws(() => fixture(t, { maxUpdatesPerIncident: 0 }).open(), error('PITCH_TICKET_LIMITS_INVALID'));
});

test('T-3 每次使用一筆紀錄；第一次立即告警；不同 context／來源標記擴散並提高嚴重度', t => {
  const f = fixture(t); const control = f.open();
  enter(control, 'context-a'); enter(control, 'context-b');
  const handle = issue(control);
  assert.deepEqual(use(control, 'not-a-tracked-handle'), { tracked: false });
  const first = use(control, handle);
  assert.equal(first.tracked, true); assert.deepEqual(first.spread, []); assert.equal(first.severity, 'HIGH');
  assert.match(first.trackId, /^wt-[a-f0-9]{32}$/);
  let ledger = control.snapshot().ticketLedger;
  assert.equal(ledger.updates.length, 1); assert.equal(ledger.updates[0].kind, 'FIRST_USE');
  assert.equal(ledger.updates[0].useCount, 1); assert.equal(ledger.updates[0].status, 'PENDING');
  f.advance(1000); const crossed = use(control, handle, { contextId: 'context-b' });
  assert.deepEqual(crossed.spread, ['CONTEXT']); assert.equal(crossed.severity, 'CRITICAL');
  f.advance(1000); const moved = use(control, handle, { source: '203.0.113.9' });
  assert.deepEqual(moved.spread, ['SOURCE']);
  f.advance(1000); const anonymous = use(control, handle, { contextId: null, entry: 'control', position: 'CREDENTIAL' });
  assert.deepEqual(anonymous.spread, ['CONTEXT']);
  ledger = control.snapshot().ticketLedger;
  assert.equal(ledger.useCount, 4); assert.equal(rows(f.path), 4);
  // D9 supplement (M3): the first spread is released at once; the later uses wait for the digest window.
  assert.equal(ledger.updates.length, 2, 'first use and first spread are immediate; later uses wait for the digest window');
  assert.equal(ledger.updates[1].kind, 'DIGEST'); assert.equal(ledger.updates[1].firstSpread, true);
  assert.deepEqual([ledger.updates[1].fromUse, ledger.updates[1].toUse, ledger.updates[1].spreadUses], [2, 2, 1]);
  const incident = ledger.incidents[0];
  assert.equal(incident.severity, 'CRITICAL'); assert.equal(incident.spreadUses, 3); assert.equal(incident.pendingUses, 2);
  const ticket = ledger.tickets[0];
  assert.deepEqual(ticket.spread, ['CONTEXT', 'SOURCE']); assert.deepEqual(ticket.contexts, ['context-a', 'context-b', null]);
  assert.deepEqual(ticket.sources, ['127.0.0.1', '203.0.113.9']);
  const listed = control.ticketUses();
  assert.deepEqual(listed.uses.map(row => [row.incidentUse, row.contextId, row.entry, row.position, row.outcome]),
    [[1, 'context-a', 'http', 'ARGUMENT', 'PRESENTED'], [2, 'context-b', 'http', 'ARGUMENT', 'PRESENTED'],
      [3, 'context-a', 'http', 'ARGUMENT', 'PRESENTED'], [4, null, 'control', 'CREDENTIAL', 'PRESENTED']]);
  assert.equal(listed.complete, true); assert.equal(listed.uses[0].client, 'test-client/1');
  assert.doesNotMatch(JSON.stringify(control.snapshot()), /handle-1-context-a/, 'the presented capability is never stored');
  // Five minutes after the spread update the remaining pending uses are released as one digest.
  f.advance(5 * MINUTE);
  const digest = control.snapshot().ticketLedger.updates[2];
  assert.equal(digest.kind, 'DIGEST'); assert.equal(digest.severity, 'CRITICAL'); assert.equal(digest.firstSpread, false);
  assert.deepEqual([digest.fromUse, digest.toUse, digest.useCount, digest.spreadUses], [3, 4, 2, 2]);
  assert.equal(digest.idempotencyKey, `pitch-ticket-update-v1:${digest.incidentId}:3`);
});

test('結果補記可重放、衝突拒絕；接受次數不超過使用次數', t => {
  const f = fixture(t); const control = f.open(); enter(control, 'context-a'); const handle = issue(control);
  const presented = use(control, handle);
  const settled = control.settleTicketUse({ useId: presented.useId, outcome: 'ACCEPTED', code: 'OK', replayed: false });
  assert.equal(settled.outcome, 'ACCEPTED');
  assert.equal(control.settleTicketUse({ useId: presented.useId, outcome: 'ACCEPTED', code: 'OK' }).outcome, 'ACCEPTED');
  assert.throws(() => control.settleTicketUse({ useId: presented.useId, outcome: 'REFUSED', code: 'TICKET_EXHAUSTED' }), error('PITCH_TICKET_SETTLE_CONFLICT'));
  assert.throws(() => control.settleTicketUse({ useId: 'ticket-use-99', outcome: 'REFUSED', code: 'X' }), error('PITCH_TICKET_USE_UNKNOWN'));
  assert.equal(control.snapshot().ticketLedger.tickets[0].accepted, 1);
  // Re-tracking the same canonical ticket is idempotent; a changed binding is a conflict.
  assert.equal(control.trackTicket({ ticketId: ticketId(1), handleDigest: ticketHandleDigest(handle), contextId: 'context-a',
    worldId: 'world-context-a', epoch: 1, entry: 'mcp', issuedAt: 1_000_000, expiresAt: 4_600_000 }).replayed, true);
  assert.throws(() => control.trackTicket({ ticketId: ticketId(1), handleDigest: ticketHandleDigest('other'), contextId: 'context-a',
    worldId: 'world-context-a', epoch: 1, entry: 'http', issuedAt: 1_000_000, expiresAt: 4_600_000 }), error('PITCH_TICKET_CONFLICT'));
  assert.throws(() => issue(control, { n: 2, contextId: 'no-incident' }), error('PITCH_INCIDENT_UNKNOWN'));
});

test('T-5 重啟後節流狀態仍正確：窗口內不重發第一封，到期由下一次讀取放出摘要', t => {
  const f = fixture(t); let control = f.open(); enter(control, 'context-a'); const handle = issue(control);
  use(control, handle); control.close();
  f.advance(MINUTE); control = f.open(); use(control, handle); use(control, handle);
  let ledger = control.snapshot().ticketLedger;
  assert.equal(ledger.updates.length, 1); assert.equal(ledger.incidents[0].pendingUses, 2);
  control.close(); f.advance(4 * MINUTE - 1); control = f.open();
  assert.equal(control.snapshot().ticketLedger.updates.length, 1, 'not yet five minutes since the first update');
  control.close(); f.advance(1); control = f.open();
  ledger = control.ticketUpdates();
  assert.equal(ledger.updates.length, 2); assert.equal(ledger.updates[1].useCount, 2);
  assert.equal(ledger.updates[1].createdAt - ledger.updates[0].createdAt, 5 * MINUTE);
  assert.equal(ledger.incidents[0].pendingUses, 0); assert.equal(ledger.incidents[0].coveredUses, 3);
});

test('T-5 大量使用：入列次數不超過 D9 上限，紀錄筆數等於實際使用次數', t => {
  const f = fixture(t); let control = f.open(); enter(control, 'context-a'); enter(control, 'context-b');
  const handle = issue(control); const total = 240; let accepted = 0;
  for (let n = 1; n <= total; n++) {
    f.advance(75000);
    const result = use(control, handle, n % 10 === 0 ? { contextId: 'context-b' } : {});
    if (n % 40 === 0) { control.settleTicketUse({ useId: result.useId, outcome: 'ACCEPTED', code: 'OK' }); accepted++; }
    if (n === 120) { control.close(); control = f.open(); }
  }
  const { updates, incidents } = control.ticketUpdates();
  const incident = incidents[0];
  assert.equal(updates.length, 20, 'at most 20 updates per incident');
  assert.equal(updates[0].kind, 'FIRST_USE'); assert(updates.slice(1).every(row => row.kind === 'DIGEST'));
  // D9 supplement: only the single first-spread update may arrive inside the five-minute digest window.
  assert.equal(updates.filter(row => row.firstSpread).length, 1);
  for (let index = 1; index < updates.length; index++) if (!updates[index].firstSpread) assert(updates[index].createdAt - updates[index - 1].createdAt >= 5 * MINUTE);
  assert.equal(updates.reduce((sum, row) => sum + row.useCount, 0) + incident.pendingUses + incident.suppressedUses, total);
  assert.equal(incident.uses, total); assert.equal(incident.pendingUses, 0); assert(incident.suppressedUses > 0);
  assert.equal(rows(f.path), total); assert.equal(control.snapshot().ticketLedger.tickets[0].accepted, accepted);
  let seen = 0; let after = 0;
  do { const page = control.ticketUses({ afterSeq: after, limit: 500 }); seen += page.uses.length; after = page.nextAfterSeq; if (page.complete) break; } while (true);
  assert.equal(seen, total);
  // After the cap no further update is ever enqueued, even after a long quiet period.
  f.advance(60 * MINUTE); use(control, handle);
  assert.equal(control.ticketUpdates().updates.length, 20); assert.equal(control.snapshot().ticketLedger.useCount, total + 1);
});

test('寫入失敗與容量上限：拒絕而不留下半套紀錄，之後可恢復', t => {
  const f = fixture(t, { maxUses: 3 }); const control = f.open(); enter(control, 'context-a'); const handle = issue(control);
  use(control, handle);
  // Another writer holds the SQLite write lock: the use cannot be recorded, so the caller must refuse it.
  const blocker = new DatabaseSync(f.path); blocker.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
  try { assert.throws(() => use(control, handle), cause => /locked|busy/i.test(cause.message)); }
  finally { blocker.exec('ROLLBACK'); blocker.close(); }
  assert.equal(control.snapshot().ticketLedger.useCount, 1); assert.equal(rows(f.path), 1);
  use(control, handle); use(control, handle);
  assert.throws(() => use(control, handle), error('PITCH_TICKET_LEDGER_LIMIT'));
  const ledger = control.snapshot().ticketLedger;
  assert.equal(ledger.useCount, 3); assert.equal(ledger.refusedAtCapacity, 1); assert.equal(rows(f.path), 3);
  assert.deepEqual(use(control, 'untracked'), { tracked: false }, 'untracked traffic is unaffected by the cap');
});

test('帳本列被刪改即視為毀損，不會靜默重設計數', t => {
  const f = fixture(t); const control = f.open(); enter(control, 'context-a'); const handle = issue(control);
  use(control, handle); use(control, handle);
  const db = new DatabaseSync(f.path); db.exec('DELETE FROM pitch_ticket_uses WHERE seq=2'); db.close();
  assert.throws(() => control.snapshot(), error('PITCH_TICKET_LEDGER_CORRUPT'));
  const tamper = new DatabaseSync(f.path);
  tamper.prepare('INSERT INTO pitch_ticket_uses VALUES(2,?,?,?)').run('ticket-use-2', '{"seq":2}', 'b'.repeat(64)); tamper.close();
  assert.throws(() => control.ticketUses(), error('PITCH_TICKET_LEDGER_CORRUPT'));
});

test('D9 補充：每事件第一次擴散立即入列並計入 20 封上限；之後的擴散仍依 5 分鐘摘要', t => {
  const f = fixture(t, { maxUpdatesPerIncident: 2 }); const control = f.open();
  enter(control, 'context-a'); enter(control, 'context-b'); const handle = issue(control);
  use(control, handle); f.advance(1000);
  const spread = use(control, handle, { contextId: 'context-b' });
  assert.deepEqual(spread.spread, ['CONTEXT']);
  let ledger = control.snapshot().ticketLedger;
  assert.equal(ledger.updates.length, 2, 'the first spread is sent immediately');
  assert.equal(ledger.updates[1].firstSpread, true); assert.equal(ledger.updates[1].createdAt - ledger.updates[0].createdAt, 1000);
  f.advance(1000); use(control, handle, { source: '198.51.100.7' });
  f.advance(10 * MINUTE); use(control, handle, { contextId: 'context-b' });
  ledger = control.snapshot().ticketLedger;
  assert.equal(ledger.updates.length, 2, 'the immediate spread update counts toward the per-incident cap');
  assert.equal(ledger.incidents[0].suppressedUses, 2); assert.equal(rows(f.path), 4);
});

test('M3 領取／完成：同一狀態機、單次嘗試、租約到期記 UNKNOWN、不重複領取', t => {
  const f = fixture(t); const control = f.open(); enter(control, 'context-a'); const handle = issue(control); use(control, handle);
  const claim = control.claimTicketUpdate({ leaseMs: 5000 });
  assert.equal(claim.update.status, 'IN_FLIGHT'); assert.equal(claim.attempt, 1); assert.equal(claim.incident.phase, 'ENTERED');
  assert.equal(control.claimTicketUpdate(), null, 'an in-flight update is never claimed twice');
  assert.equal(control.completeTicketUpdate({ updateId: claim.update.updateId, claimToken: 'wrong-token', outcome: 'UNKNOWN' }).stale, true);
  const done = control.completeTicketUpdate({ updateId: claim.update.updateId, claimToken: claim.claimToken, outcome: 'ACCEPTED', receiptId: 'delivery-1' });
  assert.equal(done.update.status, 'ACCEPTED'); assert.equal(done.update.receiptId, 'delivery-1');
  assert.equal(control.completeTicketUpdate({ updateId: claim.update.updateId, claimToken: claim.claimToken, outcome: 'UNKNOWN' }).stale, true);
  f.advance(5 * MINUTE); use(control, handle);
  const second = control.claimTicketUpdate({ leaseMs: 5000 });
  f.advance(5001);
  assert.equal(control.ticketUpdates().updates[1].status, 'UNKNOWN', 'expired claim is UNKNOWN, not re-sent');
  assert.equal(control.claimTicketUpdate(), null);
  assert.equal(control.completeTicketUpdate({ updateId: second.update.updateId, claimToken: second.claimToken, outcome: 'ACCEPTED', receiptId: 'late' }).stale, true);
  f.advance(5 * MINUTE); use(control, handle);
  const third = control.claimTicketUpdate();
  const rejected = control.completeTicketUpdate({ updateId: third.update.updateId, claimToken: third.claimToken, outcome: 'REJECTED', retryable: true });
  assert.equal(rejected.update.status, 'PENDING'); assert(rejected.update.nextAttemptAt > f.now());
  assert.equal(control.recoverTicketUpdateClaims().recovered, 0);
  f.advance(rejected.update.nextAttemptAt - f.now()); const again = control.claimTicketUpdate();
  assert.equal(again.attempt, 2);
  control.close(); const reopened = f.open();
  assert.equal(reopened.recoverTicketUpdateClaims().recovered, 1, 'a restarted gateway turns its predecessor claims into UNKNOWN');
  assert.equal(reopened.ticketUpdates().updates[2].status, 'UNKNOWN');
});
