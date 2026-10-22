// 普通流量入場統計時間窗（ADR-DQ-021）：合法消費者長時間每秒探測不撞 journal 上限；時間窗可驗證、竄改可偵測；
// 舊資料庫照常開啟。全部使用暫存目錄、假時鐘與人工合成資料。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openRuntimeStore, admissionAttemptDigest, admissionSourceClass } from '../runtime/store.mjs';
import { createPitchingBlueprint } from '../runtime/pitching.mjs';
import { compareJournalToCheckpoints, createCheckpoint, publicKeyId, readJournalReadOnly, recomputeJournalChain,
  signCheckpoint } from '../runtime/evidence-seal.mjs';
import { worldDigest } from '../world/kernel.mjs';

const token = letter => letter.repeat(40);
const code = expected => cause => cause.code === expected;
const START = 1_700_000_000_000; // 對齊到分鐘之外的任意時間；時間窗以 60 秒對齊。
const hmac = (key, domain, digest) => createHmac('sha256', key).update(`${domain}\0`).update(digest).digest('base64url');
const defaultBlueprint = () => JSON.parse(readFileSync(new URL('../runtime/blueprints/default.json', import.meta.url), 'utf8'));

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dungeonq-store-admission-'));
  const path = join(directory, 'runtime.sqlite'); let time = START; let store; let admissions = 0; let routes = 0;
  const configuration = { path, clock: () => time, ...options };
  const open = () => { store = openRuntimeStore(configuration); return store; };
  const close = () => { store?.close(); store = undefined; };
  const register = () => {
    store.registerContext({ contextId: 'diverted', tenantId: 'reference', worldId: 'dungeon', token: token('a'), disposition: 'DIVERT' });
    store.registerContext({ contextId: 'ordinary', tenantId: 'reference', worldId: 'ordinary-world', token: token('o'), disposition: 'NORMAL_AUTHORIZED' });
  };
  // 一次合法消費者探測；回傳它的 gateway attempt 識別碼。
  const admit = (overrides = {}) => {
    const attemptId = `attempt-${++admissions}`;
    const input = { contextId: 'ordinary', requestId: `legit-${admissions}`, family: 'http', outcome: 'SERVED', attemptId,
      latencyMs: 4 + (admissions % 11) / 4, source: 'LOOPBACK' };
    for (const [key, value] of Object.entries(overrides)) { if (value === undefined) delete input[key]; else input[key] = value; }
    store.recordAdmission(input); return attemptId;
  };
  const divert = () => store.recordRoute({ contextId: 'diverted', requestId: `diverted-${++routes}`, family: 'mcp', destination: 'SYNTHETIC', outcome: 'SERVED' });
  t.after(() => { close(); rmSync(directory, { recursive: true, force: true }); });
  return { path, open, close, register, admit, divert, store: () => store, tick: (ms = 1000) => { time += ms; }, now: () => time };
}
const withConnection = (path, fn) => { const db = new DatabaseSync(path); try { return fn(db); } finally { db.close(); } };
const workload = evidence => evidence.events.filter(event => event.kind !== 'FENCE').length;

test('合法消費者每秒 1 次、連續 2.5 小時（假時鐘）：每 60 秒封存一筆時間窗，不撞 journal 上限', t => {
  const f = fixture(t, { blueprint: createPitchingBlueprint({ seed: 17 }) }); const store = f.open(); f.register();
  const attempts = []; const seconds = 9000;
  for (let second = 1; second <= seconds; second++) {
    f.tick(); attempts.push(f.admit());
    if (second % 30 === 0) f.divert(); // 關鍵事件（參與者的路由）仍逐筆寫入。
  }
  const evidence = store.evidence(); const windows = evidence.events.filter(event => event.kind === 'ADMISSION');
  assert.equal(evidence.verifier.status, 'VERIFIED');
  assert.equal(windows.length, 150, '9000 秒、60 秒一窗，最後一窗仍開著');
  assert.equal(evidence.events.filter(event => event.kind === 'ROUTE').length, 300, '參與者路由逐筆保留');
  const census = evidence.admissions;
  assert.equal(census.sealed.windows, 150); assert.equal(census.sealed.perRequestRoutes, 0);
  assert.equal(census.open.authenticated, false); assert.equal(census.total.count, seconds);
  assert.equal(census.total.outcomes.SERVED, seconds);
  assert.equal(census.total.attemptDigest, admissionAttemptDigest(attempts), '時間窗的 attempt 摘要合計等於全部 attempt');
  for (const window of windows) {
    const { admission } = window;
    assert.equal(admission.windowEnd - admission.windowStart, 60000); assert.equal(admission.windowStart % 60000, 0);
    assert.ok(admission.firstAt >= admission.windowStart && admission.lastAt < admission.windowEnd && admission.lastAt <= window.at);
    assert.deepEqual(admission.families, { http: admission.count }); assert.deepEqual(admission.sources, { LOOPBACK: admission.count });
    assert.deepEqual(admission.contexts, [{ contextId: 'ordinary', count: admission.count }]);
    assert.ok(admission.latency.min <= admission.latency.p50 && admission.latency.p95 <= admission.latency.max);
  }
  // 容量估算：合法消費者每小時只用 60 筆時間窗；含每 30 秒一次的參與者路由，剩餘額度仍夠合法消費者再撐 24 小時以上。
  const used = workload(evidence); const maxEvents = store.snapshot().bounds.maxEvents;
  assert.ok(used < 500, `2.5 小時只用 ${used} 筆工作事件`);
  assert.ok((maxEvents - used) / 60 >= 24, '剩餘額度足夠每分鐘一窗再撐 24 小時以上');
  // 正常關閉時封存最後一窗；重新開啟以完整重播驗證每一窗。
  f.close(); const reopened = f.open().admissionCensus();
  assert.equal(reopened.open, null); assert.equal(reopened.sealed.windows, 151);
  assert.equal(reopened.sealed.count, seconds); assert.equal(reopened.total.attemptDigest, admissionAttemptDigest(attempts));
});

test('時間窗邊界：同一分鐘內只累積；跨分鐘才封存；滿 4096 筆提前封存；未封存的時間窗標明未經認證', t => {
  const f = fixture(t); const store = f.open(); f.register();
  f.tick(5000); f.admit(); f.tick(1000); f.admit({ outcome: 'UNKNOWN', family: 'mcp', source: 'PRIVATE', latencyMs: undefined });
  let census = store.admissionCensus();
  assert.equal(census.sealed.windows, 0); assert.equal(census.open.count, 2); assert.equal(census.open.authenticated, false);
  assert.equal(store.evidence().events.filter(event => event.kind === 'ADMISSION').length, 0, '同一分鐘內不寫 journal');
  f.tick(60000); f.admit();
  const sealed = store.evidence().events.filter(event => event.kind === 'ADMISSION');
  assert.equal(sealed.length, 1, '下一分鐘的第一筆先封存上一窗');
  assert.deepEqual(sealed[0].admission.outcomes, { SERVED: 1, REFUSED: 0, FAILED: 0, UNKNOWN: 1 });
  assert.deepEqual(sealed[0].admission.families, { http: 1, mcp: 1 }); assert.deepEqual(sealed[0].admission.sources, { LOOPBACK: 1, PRIVATE: 1 });
  assert.equal(sealed[0].admission.latency.samples, 1, '沒有延遲的入場只計次數');
  // 同一毫秒內 4097 筆：第 4097 筆前先封存滿額的那一窗。
  f.tick(60000); for (let index = 0; index < 4097; index++) f.admit();
  census = store.admissionCensus();
  const full = store.evidence().events.filter(event => event.kind === 'ADMISSION').at(-1).admission;
  assert.equal(full.count, 4096); assert.equal(census.open.count, 1); assert.equal(census.open.windowStart, full.windowStart, '同一分鐘的第二窗');
  assert.equal(census.total.count, 4100);
  assert.equal(store.sealAdmissions().count, 1, '手動封存目前的時間窗'); assert.equal(store.sealAdmissions(), null);
  assert.equal(store.admissionCensus().open, null);
});

test('入場規則：重送同一 attempt 是冪等；被導流或已封鎖的 context 不能記為普通入場；封存時 context 已封鎖仍可封存', t => {
  const f = fixture(t); const store = f.open(); f.register();
  f.tick(); const input = { contextId: 'ordinary', requestId: 'legit-x', family: 'http', outcome: 'SERVED', attemptId: 'attempt-x', latencyMs: 3 };
  assert.equal(store.recordAdmission(input).replayed, false);
  assert.equal(store.recordAdmission(input).replayed, true); assert.equal(store.admissionCensus().open.count, 1);
  assert.throws(() => store.recordAdmission({ ...input, outcome: 'UNKNOWN' }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.recordAdmission({ ...input, attemptId: 'attempt-d', contextId: 'diverted' }), code('ROUTE_CROSSING_DENIED'));
  assert.throws(() => store.recordAdmission({ ...input, attemptId: 'attempt-o', outcome: 'DONE' }), code('ROUTE_INVALID'));
  assert.throws(() => store.recordAdmission({ ...input, attemptId: 'attempt-s', source: '127.0.0.1' }), code('ADMISSION_SOURCE_INVALID'));
  assert.throws(() => store.recordAdmission({ ...input, attemptId: 'attempt-l', latencyMs: -1 }), code('ADMISSION_LATENCY_INVALID'));
  assert.throws(() => store.recordAdmission({ ...input, attemptId: 'attempt-k', extra: 1 }));
  store.fence({ contextId: 'ordinary', reason: 'synthetic misfire drill' });
  assert.throws(() => store.recordAdmission({ ...input, attemptId: 'attempt-f' }), code('CONTEXT_FENCED'));
  assert.equal(store.sealAdmissions().count, 1, '入場時仍有效的紀錄照常封存');
  f.close(); assert.equal(f.open().admissionCensus().sealed.count, 1, '重新開啟後重播通過');
  assert.equal(admissionSourceClass('127.0.0.1'), 'LOOPBACK'); assert.equal(admissionSourceClass('::ffff:127.0.0.1'), 'LOOPBACK');
  assert.equal(admissionSourceClass('192.168.1.20'), 'PRIVATE'); assert.equal(admissionSourceClass('203.0.113.9'), 'OTHER');
  assert.equal(admissionSourceClass(null), 'UNKNOWN');
});

test('竄改時間窗：沒有金鑰時下一次操作就拒絕；持有本機金鑰改計數時重播拒絕；Ed25519 檢查點指出確切序號', t => {
  const f = fixture(t); const store = f.open(); f.register();
  for (let index = 0; index < 4; index++) { f.tick(30000); f.admit(); }
  const sequence = store.evidence().events.findLast(event => event.kind === 'ADMISSION').sequence;
  const sealedCount = store.admissionCensus().sealed.count;
  // 沒有金鑰：改 head 那一窗的計數。
  const original = withConnection(f.path, db => db.prepare('SELECT event_json FROM runtime_events WHERE sequence=?').get(sequence).event_json);
  withConnection(f.path, db => {
    const event = JSON.parse(original); event.command.input.count += 1;
    db.prepare('UPDATE runtime_events SET event_json=? WHERE sequence=?').run(JSON.stringify(event), sequence);
  });
  assert.throws(() => store.admissionCensus(), code('JOURNAL_CORRUPT'));
  withConnection(f.path, db => db.prepare('UPDATE runtime_events SET event_json=? WHERE sequence=?').run(original, sequence));
  assert.equal(store.admissionCensus().sealed.count, sealedCount, '還原後恢復');
  // 簽一個 Ed25519 檢查點，再以本機 journal key 把計數改大並重新串鏈。
  const { privateKey } = generateKeyPairSync('ed25519');
  const checkpoint = signCheckpoint(createCheckpoint({ chain: recomputeJournalChain(readJournalReadOnly(f.path)), keyId: publicKeyId(privateKey),
    storeLabel: 'admission-lab', sealedAt: START, reason: 'PERIODIC' }), privateKey);
  f.close();
  const key = readFileSync(`${f.path}.journal.key`);
  withConnection(f.path, db => {
    const row = db.prepare('SELECT event_json FROM runtime_events WHERE sequence=?').get(sequence);
    const event = JSON.parse(row.event_json); event.command.input.count += 5;
    const { digest, authentication, ...body } = event; event.digest = worldDigest(body); event.authentication = hmac(key, 'journal-v2', event.digest);
    db.prepare('UPDATE runtime_events SET event_json=? WHERE sequence=?').run(JSON.stringify(event), sequence);
  });
  assert.throws(() => f.open(), code('ADMISSION_INVALID'), '計數與各分項加總不符');
  const after = readJournalReadOnly(f.path);
  const comparison = compareJournalToCheckpoints({ genesis: after.genesis, rows: after.rows, checkpoints: [checkpoint] });
  assert.equal(comparison.status, 'MISMATCH'); assert.equal(comparison.firstMismatch.kind, 'EVENT_DIGEST_MISMATCH');
  assert.equal(comparison.firstMismatch.sequence, sequence);
});

test('舊資料庫相容：逐筆 ORIGIN 路由的舊 journal 照常開啟並與新時間窗合計；第 1 版共用金鑰資料庫也能封存時間窗', t => {
  const f = fixture(t); let store = f.open(); f.register();
  // 0.15.0-dev.13 以前 gateway 為每個普通請求寫一筆 ROUTE；格式未變，recordRoute 仍照舊寫入。
  const legacyAttempts = [];
  for (let index = 1; index <= 5; index++) {
    f.tick(); const attemptId = `legacy-${index}`; legacyAttempts.push(attemptId);
    store.recordRoute({ contextId: 'ordinary', requestId: `old-${index}`, family: 'http', destination: 'ORIGIN', outcome: index === 5 ? 'UNKNOWN' : 'SERVED', attemptId });
  }
  f.close(); store = f.open();
  const attempts = [...legacyAttempts]; for (let index = 0; index < 3; index++) { f.tick(); attempts.push(f.admit()); }
  let census = store.admissionCensus();
  assert.equal(census.sealed.perRequestRoutes, 5); assert.equal(census.total.count, 8);
  assert.deepEqual(census.total.outcomes, { SERVED: 7, REFUSED: 0, FAILED: 0, UNKNOWN: 1 });
  assert.equal(census.total.attemptDigest, admissionAttemptDigest(attempts));
  f.close(); census = f.open().admissionCensus();
  assert.equal(census.sealed.windows, 1); assert.equal(census.sealed.count, 8);

  // 第 1 版：v1 schema，journal 以 ticket key 與 journal-v1 網域認證（依舊版寫法重建）。
  const g = fixture(t); g.open(); g.register(); g.tick(); g.store().recordRoute({ contextId: 'ordinary', requestId: 'old', family: 'http', destination: 'ORIGIN', outcome: 'SERVED', attemptId: 'v1-old' });
  g.close();
  const meta = withConnection(g.path, db => db.prepare('SELECT * FROM runtime_meta').get());
  const rows = withConnection(g.path, db => db.prepare('SELECT sequence, event_json FROM runtime_events ORDER BY sequence').all());
  const ticketKey = readFileSync(`${g.path}.ticket-key`); const legacyPath = `${g.path}.legacy-build`;
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
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${g.path}${suffix}`, { force: true });
  renameSync(legacyPath, g.path); chmodSync(g.path, 0o600); rmSync(`${g.path}.journal.key`);
  const legacy = g.open(); g.tick(); g.admit(); assert.equal(legacy.sealAdmissions().count, 1);
  const exported = legacy.evidence();
  assert.equal(exported.verifier.journalKey, 'LEGACY_SHARED'); assert.equal(exported.admissions.total.count, 2);
  assert.equal(withConnection(g.path, db => db.prepare('SELECT version FROM runtime_meta').get().version), 1, '不遷移');
});

test('封存被拒（JOURNAL_LIMIT）時時間窗保留，不遺失也不重複；FENCE 保留額度不受影響', t => {
  const blueprint = defaultBlueprint(); blueprint.bounds.maxEvents = 4; blueprint.bounds.maxRequests = 4;
  const f = fixture(t, { blueprint }); const store = f.open(); f.register();
  f.tick(); f.admit(); f.tick(60000); f.admit(); // 第 3 筆工作事件：第一窗。
  f.tick(); f.divert(); // 第 4 筆：工作事件額度用完。
  f.tick(60000); assert.throws(() => f.admit(), code('JOURNAL_LIMIT'), '封存上一窗被拒，本次入場一併拒絕');
  const census = store.admissionCensus();
  assert.equal(census.sealed.windows, 1); assert.equal(census.open.count, 1, '未封存的那一窗仍在'); assert.equal(census.total.count, 2);
  assert.equal(store.fence({ contextId: 'diverted', reason: 'reserve still available' }).state, 'FENCED');
  f.close(); assert.equal(f.open().admissionCensus().total.count, 1, '關閉時封存失敗：只剩已封存的部分，由 gateway 統計核對指出缺口');
});
