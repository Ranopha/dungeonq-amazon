// 增量驗證（ADR-DQ-020）：快取何時重建、竄改在哪個時間點被抓到、被拒絕的指令不留下半套狀態。
// 全部使用暫存目錄與人工合成資料。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { openRuntimeStore } from '../runtime/store.mjs';
import { createPitchingBlueprint } from '../runtime/pitching.mjs';
import { compareJournalToCheckpoints, createCheckpoint, publicKeyId, readJournalReadOnly, recomputeJournalChain,
  signCheckpoint } from '../runtime/evidence-seal.mjs';
import { worldDigest } from '../world/kernel.mjs';

const FULL_REPLAY_SQL = 'SELECT * FROM runtime_events ORDER BY sequence';
const token = letter => letter.repeat(40);
const code = expected => cause => cause.code === expected;
const defaultBlueprint = () => JSON.parse(readFileSync(new URL('../runtime/blueprints/default.json', import.meta.url), 'utf8'));
const registration = (contextId = 'context-a', worldId = 'world-a', disposition = 'DIVERT', letter = 'a') =>
  ({ contextId, tenantId: 'tenant-a', worldId, disposition, token: token(letter) });
const hmac = (key, domain, digest) => createHmac('sha256', key).update(`${domain}\0`).update(digest).digest('base64url');

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dungeonq-store-incremental-'));
  const path = join(directory, 'runtime.sqlite'); let time = 1_000_000; let store; let routes = 0;
  const configuration = { path, clock: () => time, ...options };
  const open = () => { store = openRuntimeStore(configuration); return store; };
  const close = () => { store?.close(); store = undefined; };
  const route = (contextId = 'context-a', destination = 'SYNTHETIC') => { time += 1000;
    return store.recordRoute({ contextId, requestId: `route-${++routes}`, family: 'http', destination, outcome: 'SERVED' }); };
  const read = () => store.decide({ token: token('a'), family: 'http' });
  t.after(() => { close(); rmSync(directory, { recursive: true, force: true }); });
  return { path, directory, open, close, route, read, store: () => store, tick: (ms = 1000) => { time += ms; }, setTime: value => { time = value; } };
}

/**
 * Counts full replays (the only statement that reads every journal row), can hide data_version changes from the store
 * to simulate a modification that SQLite does not report, and can move the monotonic clock forward.
 */
function instrument(t) {
  const all = StatementSync.prototype.all; const get = StatementSync.prototype.get; const now = performance.now.bind(performance);
  const probe = { full: 0, seenVersion: null, maskedVersion: null, offset: 0 };
  t.mock.method(StatementSync.prototype, 'all', function (...args) {
    if (this.sourceSQL === FULL_REPLAY_SQL) probe.full++; return all.apply(this, args);
  });
  t.mock.method(StatementSync.prototype, 'get', function (...args) {
    const row = get.apply(this, args);
    if (this.sourceSQL !== 'PRAGMA data_version') return row;
    if (probe.maskedVersion !== null) return { data_version: probe.maskedVersion };
    probe.seenVersion = row.data_version; return row;
  });
  t.mock.method(performance, 'now', () => now() + probe.offset);
  return Object.assign(probe, { mask() { probe.maskedVersion = probe.seenVersion; }, unmask() { probe.maskedVersion = null; } });
}

function withConnection(path, fn) { const db = new DatabaseSync(path); try { return fn(db); } finally { db.close(); } }
const tamperRow = (path, sequence, edit) => withConnection(path, db => {
  const original = db.prepare('SELECT event_json FROM runtime_events WHERE sequence=?').get(sequence).event_json;
  const event = JSON.parse(original); edit(event);
  db.prepare('UPDATE runtime_events SET event_json=? WHERE sequence=?').run(JSON.stringify(event), sequence);
  return original;
});
const restoreRow = (path, sequence, original) => withConnection(path, db =>
  db.prepare('UPDATE runtime_events SET event_json=? WHERE sequence=?').run(original, sequence));

/** Same-host attacker with the local journal key: edits one row and re-chains every later row. */
function rewriteWithKey(path, sequence, edit) {
  const key = readFileSync(`${path}.journal.key`);
  withConnection(path, db => {
    const rows = db.prepare('SELECT sequence, event_json FROM runtime_events ORDER BY sequence').all();
    let previous = JSON.parse(rows[sequence - 2].event_json).digest; db.exec('BEGIN IMMEDIATE');
    for (const row of rows.slice(sequence - 1)) {
      const event = JSON.parse(row.event_json); if (row.sequence === sequence) edit(event); event.previousDigest = previous;
      const { digest, authentication, ...body } = event; event.digest = worldDigest(body); event.authentication = hmac(key, 'journal-v2', event.digest);
      db.prepare('UPDATE runtime_events SET event_json=? WHERE sequence=?').run(JSON.stringify(event), row.sequence); previous = event.digest;
    }
    db.exec('COMMIT');
  });
}

test('開啟、匯出、其他連線寫入、每 500 次操作與每 60 秒才完整重播；其餘操作只用快取', t => {
  const probe = instrument(t); const f = fixture(t); const store = f.open();
  assert.equal(probe.full, 1, '開啟時完整重播一次');
  store.registerContext(registration()); for (let index = 0; index < 20; index++) f.route();
  for (let index = 0; index < 20; index++) { f.read(); store.snapshot(); }
  assert.equal(probe.full, 1, '一般讀寫不重播整個 journal');
  const exported = store.evidence(); assert.equal(probe.full, 2, '匯出前完整重播');
  assert.equal(exported.verifier.status, 'VERIFIED'); assert.equal(exported.events.length, 21);
  for (let index = 0; index < 500; index++) f.read();
  assert.equal(probe.full, 2, '完整重播後 500 次操作內只用快取');
  f.read(); assert.equal(probe.full, 3, '第 501 次操作完整重播');
  f.route(); assert.equal(probe.full, 3);
  probe.offset += 60_000; f.read(); assert.equal(probe.full, 4, '距上次完整重播 60 秒後完整重播');
  withConnection(f.path, db => db.prepare('SELECT count(*) AS n FROM runtime_events').get());
  f.read(); assert.equal(probe.full, 4, '其他連線只讀不會觸發重建');
  withConnection(f.path, db => db.prepare("UPDATE runtime_meta SET state_json=state_json || ' '").run());
  f.read(); assert.equal(probe.full, 5, '其他連線寫入（內容等價）後整個重建，且重建通過');
  f.read(); assert.equal(probe.full, 5);
});

test('修改 head 那一列：下一次操作就拒絕（JOURNAL_CORRUPT），即使 SQLite 沒回報變動；還原後恢復', t => {
  const probe = instrument(t); const f = fixture(t); const store = f.open();
  store.registerContext(registration()); f.route(); f.route(); f.route();
  probe.mask();
  const original = tamperRow(f.path, 4, event => { event.command.input.outcome = 'REFUSED'; });
  assert.throws(() => f.read(), code('JOURNAL_CORRUPT'), 'head 列比對不符，改走完整重播並拒絕');
  assert.throws(() => f.route(), code('JOURNAL_CORRUPT'));
  assert.throws(() => store.snapshot(), code('JOURNAL_CORRUPT'));
  assert.throws(() => store.evidence(), code('JOURNAL_CORRUPT'));
  restoreRow(f.path, 4, original); probe.unmask();
  assert.equal(f.read().contextId, 'context-a'); assert.equal(f.route().replayed, false);
  assert.equal(store.evidence().events.length, 5);
});

test('修改舊列：其他連線經 SQLite 寫入時下一次操作就抓到', t => {
  instrument(t); const f = fixture(t); const store = f.open();
  store.registerContext(registration()); for (let index = 0; index < 5; index++) f.route();
  tamperRow(f.path, 2, event => { event.command.input.outcome = 'REFUSED'; });
  assert.throws(() => f.read(), code('JOURNAL_CORRUPT'));
  assert.throws(() => f.route(), code('JOURNAL_CORRUPT'));
});

test('修改舊列且 SQLite 沒回報變動：快取期間不會發現，最遲在下一次完整驗證（第 501 次操作、60 秒或匯出）抓到', t => {
  const probe = instrument(t);
  for (const trigger of ['operations', 'interval', 'export']) {
    const f = fixture(t); const store = f.open();
    store.registerContext(registration()); for (let index = 0; index < 5; index++) f.route();
    store.evidence(); const before = probe.full; probe.mask();
    tamperRow(f.path, 2, event => { event.command.input.outcome = 'REFUSED'; });
    for (let index = 0; index < 3; index++) f.read();
    assert.equal(probe.full, before, `${trigger}：快取期間只檢查 head 列，舊列的變動尚未發現`);
    if (trigger === 'operations') {
      let failedAt = null;
      for (let index = 4; index <= 600 && failedAt === null; index++) {
        try { f.read(); } catch (error) { assert.equal(error.code, 'JOURNAL_CORRUPT'); failedAt = index; }
      }
      assert.equal(failedAt, 501, '完整重播後第 501 次操作抓到');
    } else if (trigger === 'interval') {
      probe.offset += 60_000; assert.throws(() => f.read(), code('JOURNAL_CORRUPT'));
    } else assert.throws(() => store.evidence(), code('JOURNAL_CORRUPT'));
    assert.throws(() => f.route(), code('JOURNAL_CORRUPT'), '抓到之後拒絕後續操作');
    probe.unmask(); f.close();
  }
});

test('修改舊列並以本機 journal key 重算 HMAC：本機自驗通過，Ed25519 檢查點比對仍指出確切序號', t => {
  instrument(t); const f = fixture(t); const store = f.open();
  store.registerContext(registration()); for (let index = 0; index < 4; index++) f.route();
  const { privateKey } = generateKeyPairSync('ed25519');
  const sealed = readJournalReadOnly(f.path);
  const checkpoint = signCheckpoint(createCheckpoint({ chain: recomputeJournalChain(sealed), keyId: publicKeyId(privateKey),
    storeLabel: 'lab-a', sealedAt: 2_000_000, reason: 'PERIODIC' }), privateKey);
  // 把第 3 個事件（一次路由紀錄）的時間往後挪 1 毫秒，再以本機 journal key 重新串鏈。
  rewriteWithKey(f.path, 3, event => { event.at += 1; });
  assert.equal(f.route().replayed, false, '本機以同一把 journal key 自驗通過，照常寫入');
  assert.equal(store.evidence().verifier.status, 'VERIFIED');
  const after = readJournalReadOnly(f.path);
  const comparison = compareJournalToCheckpoints({ genesis: after.genesis, rows: after.rows, checkpoints: [checkpoint] });
  assert.equal(comparison.status, 'MISMATCH');
  assert.equal(comparison.firstMismatch.kind, 'EVENT_DIGEST_MISMATCH'); assert.equal(comparison.firstMismatch.sequence, 3);
});

test('其他程序寫入後快取整個重建：看得到對方的事件、序號接續、重送得到原結果', t => {
  const probe = instrument(t); const f = fixture(t); const store = f.open();
  store.registerContext(registration()); f.route(); f.route(); const before = probe.full;
  const script = `const { openRuntimeStore } = await import(${JSON.stringify(new URL('../runtime/store.mjs', import.meta.url).href)});
    const store = openRuntimeStore({ path: process.argv[1], clock: () => 5_000_000 });
    for (let index = 1; index <= 3; index++) store.recordRoute({ contextId: 'context-a', requestId: 'remote-' + index, family: 'mcp', destination: 'SYNTHETIC', outcome: 'SERVED' });
    store.close();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, f.path], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  f.setTime(5_001_000);
  const replay = store.recordRoute({ contextId: 'context-a', requestId: 'remote-2', family: 'mcp', destination: 'SYNTHETIC', outcome: 'SERVED' });
  assert.equal(replay.replayed, true, '重建後的冪等索引包含對方的請求');
  assert.equal(probe.full, before + 1, '偵測到其他程序寫入，整個重建一次');
  f.route();
  const evidence = store.evidence();
  assert.deepEqual(evidence.events.map(event => event.requestId), [undefined, 'route-1', 'route-2', 'remote-1', 'remote-2', 'remote-3', 'route-3']);
  assert.equal(evidence.events.at(-1).sequence, 7);
  f.close(); assert.equal(f.open().evidence().verifier.status, 'VERIFIED');
});

test('被拒絕的指令不留下半套狀態：快取與重新開啟後的完整重播一致', t => {
  instrument(t); const blueprint = defaultBlueprint(); blueprint.bounds.maxWorlds = 1;
  const f = fixture(t, { blueprint }); const store = f.open();
  store.registerContext(registration());
  // transition 先把 context 放進狀態，才因世界數上限拒絕；快取不能留著它。
  assert.throws(() => store.registerContext(registration('context-b', 'world-b', 'DIVERT', 'b')), code('WORLD_LIMIT'));
  assert.deepEqual(store.snapshot().contexts.map(context => context.contextId), ['context-a']);
  assert.equal(store.registerContext(registration('context-b', 'world-a', 'NORMAL_AUTHORIZED', 'b')).contextId, 'context-b');
  assert.throws(() => store.execute({ contextId: 'context-a', family: 'http', requestId: 'stale', operation: 'write',
    args: { key: 'note', value: 'x', expectedRevision: 9 } }), code('REVISION_CONFLICT'));
  const cached = store.snapshot(); const exported = store.evidence(); f.close();
  const reopened = f.open();
  assert.deepEqual(reopened.snapshot(), cached); assert.equal(reopened.evidence().verifier.stateDigest, exported.verifier.stateDigest);
});

test('state_json 是最新狀態摘要的正規文字；配球進度、MUTATE 與 ticket 使用後，快取摘要與完整重播一致', t => {
  instrument(t);
  const pitching = fixture(t, { blueprint: createPitchingBlueprint({ seed: 17 }) }); const store = pitching.open();
  store.registerContext(registration()); store.registerContext(registration('legit', 'world-legit', 'NORMAL_AUTHORIZED', 'l'));
  let sequence = 0;
  const run = (operation, args = {}, family = 'http') => { pitching.tick(); return store.execute({ contextId: 'context-a', family, requestId: `p-${++sequence}`, operation, args }); };
  run('read', { key: 'catalog-current' }); pitching.route('legit', 'ORIGIN'); run('read', { key: 'catalog-prior' }, 'mcp'); run('snapshot');
  const ticket = run('issue-ticket', { scope: ['catalog-current'] }).ticket;
  assert.ok(run('use-ticket', { key: 'catalog-current', ticket }).revealed, '配球進度前進，contexts 改變');
  const written = run('write', { key: 'note-review', value: { text: 'synthetic' }, expectedRevision: run('snapshot').revision });
  run('read', { key: 'note-review' }, 'mcp'); pitching.route('legit', 'ORIGIN');
  const check = path => withConnection(path, db => {
    const stateJson = db.prepare('SELECT state_json FROM runtime_meta').get().state_json;
    const last = JSON.parse(db.prepare('SELECT event_json FROM runtime_events ORDER BY sequence DESC LIMIT 1').get().event_json);
    assert.equal(createHash('sha256').update(stateJson).digest('hex'), last.stateDigest);
    assert.equal(worldDigest(JSON.parse(stateJson)), last.stateDigest);
  });
  assert.equal(written.key, 'note-review'); check(pitching.path);
  const cached = store.snapshot(); pitching.close();
  assert.deepEqual(pitching.open().snapshot(), cached, '重新開啟後完整重播得到同一個狀態');

  const plain = fixture(t); const legacy = plain.open(); legacy.registerContext(registration());
  const observationId = legacy.execute({ contextId: 'context-a', family: 'http', requestId: 'read-a', operation: 'read', args: { key: 'welcome' } }).observationId;
  legacy.grantMutation({ policyId: 'policy-a', contextId: 'context-a', expectedRevision: 0, allowedTemplates: ['follow-up'],
    maxMutations: 1, expiresAt: 1_060_000, authority: { kind: 'OWNER', principalId: 'owner-a' } });
  legacy.mutate({ policyId: 'policy-a', contextId: 'context-a', observationId, requestId: 'mutation-a', expectedRevision: 0, template: 'follow-up' });
  assert.equal(legacy.snapshot().observations[0].usedBy, 'mutation-a', 'MUTATE 改到舊的 observation');
  plain.route(); check(plain.path);
  const snapshot = legacy.snapshot(); plain.close();
  assert.deepEqual(plain.open().snapshot(), snapshot);
});

test('第 1 版（ticket 與 journal 共用金鑰）資料庫同樣走快取，竄改 head 列一樣被拒絕', t => {
  instrument(t); const f = fixture(t); const store = f.open();
  store.registerContext(registration()); f.route(); f.route(); f.close();
  // 依舊版程式的寫法重建：v1 schema，journal 以 ticket key 與 journal-v1 網域認證。
  const meta = withConnection(f.path, db => db.prepare('SELECT * FROM runtime_meta').get());
  const rows = withConnection(f.path, db => db.prepare('SELECT sequence, event_json FROM runtime_events ORDER BY sequence').all());
  const ticketKey = readFileSync(`${f.path}.ticket-key`); const legacyPath = `${f.path}.legacy-build`;
  withConnection(legacyPath, db => {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('CREATE TABLE runtime_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, blueprint_json TEXT NOT NULL, key_digest TEXT NOT NULL, state_json TEXT NOT NULL)');
    db.exec('CREATE TABLE runtime_events (sequence INTEGER PRIMARY KEY, event_json TEXT NOT NULL)');
    db.prepare('INSERT INTO runtime_meta VALUES (1,1,?,?,?)').run(meta.blueprint_json, meta.key_digest, meta.state_json);
    for (const row of rows) {
      const event = JSON.parse(row.event_json); event.authentication = hmac(ticketKey, 'journal-v1', event.digest);
      db.prepare('INSERT INTO runtime_events VALUES (?,?)').run(row.sequence, JSON.stringify(event));
    }
  });
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${f.path}${suffix}`, { force: true });
  renameSync(legacyPath, f.path); chmodSync(f.path, 0o600); rmSync(`${f.path}.journal.key`);
  const legacy = f.open();
  assert.equal(legacy.evidence().verifier.journalKey, 'LEGACY_SHARED');
  for (let index = 0; index < 5; index++) f.route();
  assert.equal(f.read().contextId, 'context-a');
  assert.equal(withConnection(f.path, db => db.prepare('SELECT version FROM runtime_meta').get().version), 1, '不遷移');
  tamperRow(f.path, 8, event => { event.command.input.outcome = 'FAILED'; });
  assert.throws(() => f.read(), code('JOURNAL_CORRUPT'));
});
