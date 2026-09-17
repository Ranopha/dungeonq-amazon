import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openWorldStore } from '../server/world-store.mjs';
import { openWorldObserver } from '../server/world-observer.mjs';
import { replayWorld, worldDigest } from '../world/kernel.mjs';

const pack = JSON.parse(await readFile(new URL('../world/packs/clockwork-archive.json', import.meta.url), 'utf8'));
const envelope = revision => ({ requestId: `request_${revision}`, expectedRevision: revision, command: { type: 'inspect' } });
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'dungeonq-world-runtime-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}

test('SQLite 重啟保留身分、因果狀態、事件及原始防重送回覆', async t => {
  const path = join(await directory(t), 'world.sqlite');
  let store = openWorldStore({ path, pack }); t.after(() => store.close());
  const initial = store.snapshot();
  const first = store.command(envelope(0));
  assert.equal(first.view.revision, 1);
  assert.equal(store.pending().length, 1);
  const before = store.exportEvidence(); assert.equal(replayWorld(before).valid, true);
  store.close(); store = openWorldStore({ path, pack });
  assert.equal(store.snapshot().worldId, initial.worldId); assert.equal(store.snapshot().epoch, initial.epoch);
  assert.deepEqual(store.exportEvidence(), before);
  assert.deepEqual(store.command(envelope(0)), { ...first, replayed: true });
  assert.equal(store.snapshot().revision, 1);
  assert.throws(() => store.command({ ...envelope(0), command: { type: 'rebuild' } }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.throws(() => store.command({ ...envelope(0), requestId: 'stale' }), { code: 'REVISION_CONFLICT' });
  assert.equal(store.exportEvidence().events.length, 1);
  assert.throws(() => openWorldStore({ path, pack, worldId: 'other-world' }), { code: 'WORLD_IDENTITY_MISMATCH' });
  assert.throws(() => openWorldStore({ path, pack: { ...pack, title: '不同世界' } }), { code: 'WORLD_PACK_MISMATCH' });
});

test('state、journal、outbox、idempotency 同一交易失敗全部回復', async t => {
  const path = join(await directory(t), 'world.sqlite');
  const store = openWorldStore({ path, pack }); t.after(() => store.close());
  const raw = new DatabaseSync(path); t.after(() => raw.close());
  raw.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON world_outbox BEGIN SELECT RAISE(ABORT, 'synthetic storage interruption'); END;");
  assert.throws(() => store.command(envelope(0)));
  assert.equal(store.snapshot().revision, 0); assert.equal(store.pending().length, 0);
  assert.equal(store.exportEvidence().events.length, 0);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM world_requests').get().n, 0);
  raw.exec('DROP TRIGGER fail_outbox');
  assert.equal(store.command(envelope(0)).view.revision, 1);
  assert.equal(store.exportEvidence().events.length, 1);
});

test('有界積壓拒絕新動作；錯誤 ACK 不清除事件；重送與重新開啟保持一致', async t => {
  const path = join(await directory(t), 'world.sqlite');
  let store = openWorldStore({ path, pack, maxPending: 2 }); t.after(() => store.close());
  const first = store.command(envelope(0)); store.command(envelope(1));
  assert.throws(() => store.command(envelope(2)), { code: 'OBSERVER_BACKLOG_FULL' });
  assert.equal(store.snapshot().revision, 2);
  assert.equal(store.command(envelope(0)).replayed, true);
  assert.throws(() => store.ack(1, 'wrong'), { code: 'ACK_MISMATCH' });
  assert.equal(store.pending().length, 2);
  store.ack(1, first.event.digest); store.ack(1, first.event.digest);
  store.command(envelope(2)); store.close(); store = openWorldStore({ path, pack, maxPending: 2 });
  assert.deepEqual(store.pending().map(event => event.sequence), [2, 3]);
});

test('restore 拒絕狀態、事件、outbox 或防重送紀錄的破壞', async t => {
  const base = await directory(t);
  for (const target of ['state', 'event', 'outbox', 'request']) await t.test(target, () => {
    const path = join(base, `${target}.sqlite`);
    const store = openWorldStore({ path, pack }); store.command(envelope(0)); store.close();
    const raw = new DatabaseSync(path);
    if (target === 'state') {
      const state = JSON.parse(raw.prepare('SELECT state_json FROM world_meta').get().state_json);
      state.generation++; raw.prepare('UPDATE world_meta SET state_json=?').run(JSON.stringify(state));
    } else if (target === 'event') {
      const event = JSON.parse(raw.prepare('SELECT event_json FROM world_events').get().event_json);
      event.observation.message = '無法由已宣告世界產生的結果';
      raw.prepare('UPDATE world_events SET event_json=?').run(JSON.stringify(event));
    } else if (target === 'outbox') raw.exec('DELETE FROM world_outbox');
    else raw.exec("UPDATE world_requests SET payload_hash='changed'");
    raw.close(); assert.throws(() => openWorldStore({ path, pack }));
  });
});

test('獨立 Observer 落盤後重送只 ACK，拒絕缺號／錯誤因果，整批回滾後可恢復', async t => {
  const base = await directory(t);
  const actor = openWorldStore({ path: join(base, 'world.sqlite'), pack }); t.after(() => actor.close());
  actor.command(envelope(0)); actor.command(envelope(1));
  const all = actor.exportEvidence();
  const options = { path: join(base, 'observer.sqlite'), pack, worldId: all.worldId, epoch: all.epoch };
  let observer = openWorldObserver(options); t.after(() => observer.close());
  assert.throws(() => observer.append([all.events[1]], 2), { code: 'EVENT_SEQUENCE_INVALID' });
  const changed = structuredClone(all.events[1]); changed.observation.message = '錯誤因果';
  assert.throws(() => observer.append([all.events[0], changed], 2), { code: 'EVENT_CAUSALITY_INVALID' });
  assert.equal(observer.snapshot().events.length, 0);
  observer.close(); observer = openWorldObserver(options);
  const ack = observer.append([all.events[0]], 2); assert.equal(ack[0].digest, all.events[0].digest);
  assert.equal(observer.snapshot().lag, 1);
  assert.deepEqual(observer.append([all.events[0]], 2), ack);
  assert.equal(observer.snapshot().events.length, 1);
  observer.append(all.events, 2);
  assert.equal(observer.snapshot().lag, 0);
  assert.equal(observer.snapshot().summary.beliefStatus, 'UNKNOWN');
  assert.equal(worldDigest(observer.exportEvidence()), worldDigest(all));
  observer.close(); observer = openWorldObserver(options);
  assert.equal(observer.snapshot().verification.valid, true);
  assert.equal(observer.snapshot().events.length, 2);
});

test('兩個 store handle 以最新 revision 競爭且證據保持完整', async t => {
  const path = join(await directory(t), 'world.sqlite');
  const a = openWorldStore({ path, pack }); const b = openWorldStore({ path, pack });
  t.after(() => { a.close(); b.close(); });
  a.command(envelope(0));
  assert.throws(() => b.command({ ...envelope(0), requestId: 'second-writer' }), { code: 'REVISION_CONFLICT' });
  b.command(envelope(1));
  assert.equal(replayWorld(a.exportEvidence()).eventCount, 2);
});
