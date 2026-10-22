import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openRuntimeStore, RUNTIME_STORE_LEGACY_SHARED_KEY, RUNTIME_STORE_SEPARATE_JOURNAL_KEY } from '../runtime/store.mjs';
import { compareJournalToCheckpoints, createCheckpoint, publicKeyId, readJournalReadOnly, recomputeJournalChain,
  signCheckpoint, verifyCheckpoint, verifyCheckpointLog } from '../runtime/evidence-seal.mjs';
import { worldDigest } from '../world/kernel.mjs';

const LEGACY_SCHEMA = [
  'CREATE TABLE runtime_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, blueprint_json TEXT NOT NULL, key_digest TEXT NOT NULL, state_json TEXT NOT NULL)',
  'CREATE TABLE runtime_events (sequence INTEGER PRIMARY KEY, event_json TEXT NOT NULL)',
];
const token = letter => letter.repeat(40);
const code = expected => cause => cause.code === expected;
const hmac = (key, domain, digest) => createHmac('sha256', key).update(`${domain}\0`).update(digest).digest('base64url');

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dungeonq-evidence-seal-test-'));
  const path = join(directory, 'runtime.sqlite'); let time = 1_000_000; let store;
  const configuration = { path, clock: () => time, ...options };
  const open = (extra = {}) => { store = openRuntimeStore({ ...configuration, ...extra }); return store; };
  const close = () => { store?.close(); store = undefined; };
  t.after(() => { close(); rmSync(directory, { recursive: true, force: true }); });
  return { path, directory, open, close, tick: (ms = 1000) => { time += ms; } };
}
function populate(f, store, count = 4) {
  store.registerContext({ contextId: 'context-a', tenantId: 'tenant-a', worldId: 'world-a', disposition: 'DIVERT', token: token('a') });
  for (let index = 0; index < count; index++) {
    f.tick(); store.recordRoute({ contextId: 'context-a', requestId: `route-${index}`, family: 'http', destination: 'SYNTHETIC', outcome: 'SERVED' });
  }
}
const rowsOf = path => {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare('SELECT sequence, event_json FROM runtime_events ORDER BY sequence').all().map(row => ({ sequence: row.sequence, eventJson: row.event_json })); }
  finally { db.close(); }
};
const metaOf = path => { const db = new DatabaseSync(path, { readOnly: true }); try { return db.prepare('SELECT * FROM runtime_meta').get(); } finally { db.close(); } };

/** Same-host attacker: edits one event and re-chains every later event, authenticating with the given key. */
function rewriteJournal(path, sequence, edit, key, domain) {
  const db = new DatabaseSync(path);
  try {
    const rows = db.prepare('SELECT sequence, event_json FROM runtime_events ORDER BY sequence').all();
    let previous = rows[sequence - 2] ? JSON.parse(rows[sequence - 2].event_json).digest : undefined;
    db.exec('BEGIN IMMEDIATE');
    for (const row of rows.slice(sequence - 1)) {
      const event = JSON.parse(row.event_json); if (row.sequence === sequence) edit(event);
      if (previous !== undefined) event.previousDigest = previous;
      const { digest, authentication, ...body } = event; event.digest = worldDigest(body); event.authentication = hmac(key, domain, event.digest);
      db.prepare('UPDATE runtime_events SET event_json=? WHERE sequence=?').run(JSON.stringify(event), row.sequence); previous = event.digest;
    }
    db.exec('COMMIT');
  } finally { db.close(); }
}

/** Rebuilds a version 2 database exactly as the pre-separation store wrote it: v1 schema and journal MAC under the ticket key. */
function convertToLegacy(path) {
  const meta = metaOf(path); const rows = rowsOf(path); const ticketKey = readFileSync(`${path}.ticket-key`);
  const legacyPath = `${path}.legacy-build`; const db = new DatabaseSync(legacyPath);
  try {
    db.exec('PRAGMA journal_mode=WAL'); for (const statement of LEGACY_SCHEMA) db.exec(statement);
    db.prepare('INSERT INTO runtime_meta VALUES (1,1,?,?,?)').run(meta.blueprint_json, meta.key_digest, meta.state_json);
    for (const row of rows) {
      const event = JSON.parse(row.eventJson); event.authentication = hmac(ticketKey, 'journal-v1', event.digest);
      db.prepare('INSERT INTO runtime_events VALUES (?,?)').run(row.sequence, JSON.stringify(event));
    }
  } finally { db.close(); }
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  renameSync(legacyPath, path); chmodSync(path, 0o600); rmSync(`${path}.journal.key`);
}
const keyPair = () => generateKeyPairSync('ed25519');
function seal(chain, privateKey, previous = null, sealedAt = 2_000_000, reason = 'PERIODIC') {
  return signCheckpoint(createCheckpoint({ chain, previous, keyId: publicKeyId(privateKey), storeLabel: 'lab-a', sealedAt, reason }), privateKey);
}

test('new stores keep ticket and journal keys in separate private files and record both digests', t => {
  const f = fixture(t); const store = f.open(); populate(f, store);
  const ticketKey = readFileSync(`${f.path}.ticket-key`); const journalKey = readFileSync(`${f.path}.journal.key`);
  assert.equal(ticketKey.length, 32); assert.equal(journalKey.length, 32); assert.notDeepEqual(ticketKey, journalKey);
  for (const file of [`${f.path}.ticket-key`, `${f.path}.journal.key`]) assert.equal(lstatSync(file).mode & 0o777, 0o600);
  const meta = metaOf(f.path);
  assert.equal(meta.version, RUNTIME_STORE_SEPARATE_JOURNAL_KEY);
  assert.equal(meta.journal_key_digest, createHash('sha256').update(journalKey).digest('hex'));
  assert.equal(store.evidence().verifier.journalKey, 'SEPARATE');
  const event = JSON.parse(rowsOf(f.path)[0].eventJson);
  assert.equal(event.authentication, hmac(journalKey, 'journal-v2', event.digest));
  assert.notEqual(event.authentication, hmac(ticketKey, 'journal-v1', event.digest));
  // Ticket handles still use the ticket key and survive restart unchanged.
  const issued = store.execute({ contextId: 'context-a', family: 'http', requestId: 'issue-a', operation: 'issue-ticket', args: {} });
  const handle = store.participantTicket(issued.ticket); f.close();
  assert.equal(f.open().resolveParticipantTicket(handle, 'context-a'), issued.ticket);
});

test('a leaked ticket key can no longer rewrite the journal; the journal key still can (sealing covers that case)', t => {
  const f = fixture(t); populate(f, f.open()); f.close();
  const ticketKey = readFileSync(`${f.path}.ticket-key`); const journalKey = readFileSync(`${f.path}.journal.key`);
  const original = readFileSync(f.path);
  for (const domain of ['journal-v1', 'journal-v2']) {
    rewriteJournal(f.path, 3, event => { event.at += 1; }, ticketKey, domain);
    assert.throws(() => f.open(), code('JOURNAL_CORRUPT'), domain);
    writeFileSync(f.path, original);
  }
  rewriteJournal(f.path, 3, event => { event.at += 1; }, journalKey, 'journal-v2');
  assert.equal(f.open().evidence().verifier.status, 'VERIFIED');
});

test('journal key files are pinned, private, required for existing stores and never equal to the ticket key', t => {
  const f = fixture(t); populate(f, f.open()); f.close();
  const journalPath = `${f.path}.journal.key`; const original = readFileSync(journalPath);
  writeFileSync(journalPath, randomBytes(32)); assert.throws(() => f.open(), code('JOURNAL_KEY_MISMATCH'));
  writeFileSync(journalPath, original); chmodSync(journalPath, 0o644); assert.throws(() => f.open(), code('STORAGE_NOT_PRIVATE'));
  chmodSync(journalPath, 0o600); rmSync(journalPath); assert.throws(() => f.open(), code('JOURNAL_KEY_MISSING'));
  assert.equal(existsSync(journalPath), false);
  writeFileSync(journalPath, original, { mode: 0o600 }); assert.equal(f.open().evidence().verifier.status, 'VERIFIED'); f.close();

  const shared = randomBytes(32); const g = fixture(t);
  assert.throws(() => g.open({ signingKey: shared, journalKey: Buffer.from(shared) }), code('JOURNAL_KEY_NOT_SEPARATE'));
  assert.throws(() => g.open({ journalKey: randomBytes(32), journalKeyPath: join(g.directory, 'j.key') }), code('JOURNAL_KEY_SOURCE_AMBIGUOUS'));
  assert.throws(() => g.open({ journalKeyPath: `${g.path}.ticket-key` }), code('JOURNAL_KEY_PATH_INVALID'));
  assert.throws(() => g.open({ journalKeyPath: `${g.path}-wal` }), code('JOURNAL_KEY_PATH_INVALID'));
  assert.throws(() => g.open({ journalKey: randomBytes(16) }), code('JOURNAL_KEY_INVALID'));
  const injected = randomBytes(32); g.open({ journalKey: injected }); g.close();
  assert.equal(existsSync(`${g.path}.journal.key`), false);
  assert.throws(() => g.open({ journalKey: randomBytes(32) }), code('JOURNAL_KEY_MISMATCH'));
  assert.equal(g.open({ journalKey: injected }).evidence().verifier.journalKey, 'SEPARATE');
});

test('legacy shared-key stores stay readable, verifiable and writable without migration or a journal key', t => {
  const f = fixture(t); populate(f, f.open()); f.close(); convertToLegacy(f.path);
  const before = rowsOf(f.path);
  let store = f.open(); assert.equal(store.evidence().verifier.journalKey, 'LEGACY_SHARED');
  assert.equal(store.evidence().verifier.status, 'VERIFIED'); assert.equal(existsSync(`${f.path}.journal.key`), false);
  f.tick(); store.recordRoute({ contextId: 'context-a', requestId: 'legacy-route', family: 'http', destination: 'SYNTHETIC', outcome: 'SERVED' });
  f.close();
  const after = rowsOf(f.path); assert.deepEqual(after.slice(0, before.length), before);
  const ticketKey = readFileSync(`${f.path}.ticket-key`); const appended = JSON.parse(after.at(-1).eventJson);
  assert.equal(appended.authentication, hmac(ticketKey, 'journal-v1', appended.digest));
  assert.equal(metaOf(f.path).version, RUNTIME_STORE_LEGACY_SHARED_KEY);
  store = f.open(); assert.equal(store.evidence().events.length, before.length + 1); f.close();
  assert.throws(() => f.open({ journalKeyPath: join(f.directory, 'journal.key') }), code('JOURNAL_KEY_NOT_APPLICABLE'));
  assert.throws(() => f.open({ journalKey: randomBytes(32) }), code('JOURNAL_KEY_NOT_APPLICABLE'));
  assert.equal(existsSync(join(f.directory, 'journal.key')), false);
  // A schema/version disagreement is never treated as either known format.
  const db = new DatabaseSync(f.path); db.prepare('UPDATE runtime_meta SET version=2').run(); db.close();
  assert.throws(() => f.open(), code('STORAGE_SCHEMA_INVALID'));
});

test('journal chain recomputation needs no key and names the first broken row', t => {
  const f = fixture(t); const store = f.open(); populate(f, store); const evidence = store.evidence(); f.close();
  const snapshot = readJournalReadOnly(f.path); const chain = recomputeJournalChain({ genesis: snapshot.genesis, rows: snapshot.rows });
  assert.equal(chain.status, 'LINKED'); assert.equal(chain.linkedThrough, evidence.events.length);
  assert.deepEqual(chain.heads.slice(1), evidence.events.map(event => event.digest)); assert.equal(chain.head, evidence.verifier.head);
  assert.equal(snapshot.journalKeyMode, 'SEPARATE'); assert.equal(snapshot.metaStateDigest, chain.stateDigest);
  const edited = structuredClone(snapshot.rows); const third = JSON.parse(edited[2].eventJson); third.at += 1; edited[2].eventJson = JSON.stringify(third);
  assert.deepEqual(recomputeJournalChain({ genesis: snapshot.genesis, rows: edited }).firstBreak, { sequence: 3, reason: 'EVENT_DIGEST_MISMATCH' });
  assert.deepEqual(recomputeJournalChain({ genesis: snapshot.genesis, rows: snapshot.rows.filter(row => row.sequence !== 2) }).firstBreak,
    { sequence: 2, reason: 'SEQUENCE_GAP' });
  const garbled = structuredClone(snapshot.rows); garbled[0].eventJson = '{';
  assert.deepEqual(recomputeJournalChain({ genesis: snapshot.genesis, rows: garbled }).firstBreak, { sequence: 1, reason: 'EVENT_UNPARSEABLE' });
  assert.deepEqual(recomputeJournalChain({ genesis: 'f'.repeat(64), rows: snapshot.rows }).firstBreak, { sequence: 1, reason: 'PREVIOUS_DIGEST_MISMATCH' });
});

test('checkpoints are signed with the private key and verified with the public key only', t => {
  const f = fixture(t); populate(f, f.open(), 2); f.close();
  const { privateKey, publicKey } = keyPair(); const other = keyPair();
  const snapshot = readJournalReadOnly(f.path); const chain = recomputeJournalChain(snapshot);
  const first = seal(chain, privateKey);
  assert.equal(first.index, 0); assert.equal(first.sequence, 3); assert.equal(first.eventDigests.length, 3);
  assert.deepEqual(verifyCheckpoint(first, publicKey), { valid: true });
  assert.deepEqual(verifyCheckpoint(first, other.publicKey), { valid: false, reason: 'CHECKPOINT_KEY_MISMATCH' });
  assert.deepEqual(verifyCheckpoint({ ...first, sequence: 2 }, publicKey).valid, false);
  assert.deepEqual(verifyCheckpoint({ ...first, head: first.genesis }, publicKey), { valid: false, reason: 'CHECKPOINT_HEAD_INVALID' });
  const forged = signCheckpoint({ ...createCheckpoint({ chain, keyId: publicKeyId(other.privateKey), sealedAt: 2_000_000, reason: 'MANUAL' }) }, other.privateKey);
  assert.deepEqual(verifyCheckpoint({ ...forged, keyId: first.keyId }, publicKey).valid, false);
  const flipped = { ...first, signature: `${first.signature[0] === 'A' ? 'B' : 'A'}${first.signature.slice(1)}` };
  assert.deepEqual(verifyCheckpoint(flipped, publicKey), { valid: false, reason: 'CHECKPOINT_SIGNATURE_INVALID' });
  assert.throws(() => signCheckpoint(createCheckpoint({ chain, keyId: first.keyId, sealedAt: 1, reason: 'MANUAL' }), other.privateKey), code('CHECKPOINT_KEY_MISMATCH'));
  assert.throws(() => publicKeyId(generateKeyPairSync('x25519').publicKey), code('SEAL_PUBLIC_KEY_INVALID'));
  assert.throws(() => createCheckpoint({ chain, keyId: first.keyId, sealedAt: 1, reason: 'LATER' }), code('CHECKPOINT_REASON_INVALID'));
  assert.equal(publicKeyId(publicKey), publicKeyId(privateKey));
  assert.equal(publicKeyId(publicKey.export({ type: 'spki', format: 'pem' })), first.keyId);
});

test('checkpoint logs link by digest and continuous sequence; reordering or splicing is rejected', t => {
  const f = fixture(t); const store = f.open(); populate(f, store, 2);
  const { privateKey, publicKey } = keyPair();
  const first = seal(recomputeJournalChain(readJournalReadOnly(f.path)), privateKey);
  f.tick(); store.recordRoute({ contextId: 'context-a', requestId: 'later', family: 'http', destination: 'SYNTHETIC', outcome: 'SERVED' });
  const second = seal(recomputeJournalChain(readJournalReadOnly(f.path)), privateKey, first, 2_000_500);
  const unchanged = seal(recomputeJournalChain(readJournalReadOnly(f.path)), privateKey, second, 2_001_000, 'FINAL');
  assert.equal(second.fromSequence, 3); assert.equal(second.eventDigests.length, 1); assert.equal(unchanged.eventDigests.length, 0);
  assert.deepEqual(verifyCheckpointLog([first, second, unchanged], publicKey),
    { status: 'VALID', count: 3, sequence: 4, head: second.head, lastDigest: unchanged.digest });
  assert.deepEqual(verifyCheckpointLog([second, first], publicKey).firstProblem, { index: 0, reason: 'CHECKPOINT_INDEX_GAP' });
  assert.deepEqual(verifyCheckpointLog([first, unchanged], publicKey).firstProblem, { index: 1, reason: 'CHECKPOINT_INDEX_GAP' });
  // A second history started from another first checkpoint cannot be spliced onto this one.
  const restart = seal(recomputeJournalChain(readJournalReadOnly(f.path)), privateKey, null, 2_002_000);
  const spliced = seal(recomputeJournalChain(readJournalReadOnly(f.path)), privateKey, restart, 2_003_000);
  assert.deepEqual(verifyCheckpointLog([first, spliced], publicKey).firstProblem, { index: 1, reason: 'CHECKPOINT_LINK_MISMATCH' });
  assert.deepEqual(verifyCheckpointLog([], publicKey), { status: 'VALID', count: 0, sequence: null, head: null, lastDigest: null });
});

test('a journal rewritten with the valid local journal key is located exactly by the signed checkpoints', t => {
  const f = fixture(t); const store = f.open(); populate(f, store, 5);
  const { privateKey, publicKey } = keyPair();
  const first = seal(recomputeJournalChain(readJournalReadOnly(f.path)), privateKey);
  f.tick(); store.recordRoute({ contextId: 'context-a', requestId: 'unsealed', family: 'http', destination: 'SYNTHETIC', outcome: 'SERVED' });
  f.close();
  let snapshot = readJournalReadOnly(f.path);
  assert.deepEqual(verifyCheckpointLog([first], publicKey).status, 'VALID');
  const clean = compareJournalToCheckpoints({ genesis: snapshot.genesis, rows: snapshot.rows, checkpoints: [first] });
  assert.equal(clean.status, 'MATCH'); assert.equal(clean.sealedThroughSequence, 6); assert.equal(clean.unsealedEvents, 1);

  rewriteJournal(f.path, 4, event => { event.at += 1; }, readFileSync(`${f.path}.journal.key`), 'journal-v2');
  assert.equal(f.open().evidence().verifier.status, 'VERIFIED'); f.close();
  snapshot = readJournalReadOnly(f.path);
  const result = compareJournalToCheckpoints({ genesis: snapshot.genesis, rows: snapshot.rows, checkpoints: [first] });
  assert.equal(result.status, 'MISMATCH'); assert.equal(result.firstMismatch.kind, 'EVENT_DIGEST_MISMATCH');
  assert.equal(result.firstMismatch.sequence, 4); assert.equal(result.firstMismatch.expected, first.eventDigests[3]);
  assert.throws(() => createCheckpoint({ chain: recomputeJournalChain(snapshot), previous: first, keyId: first.keyId, sealedAt: 3_000_000, reason: 'PERIODIC' }),
    code('JOURNAL_REWRITTEN'));

  const truncated = snapshot.rows.slice(0, 2);
  assert.equal(compareJournalToCheckpoints({ genesis: snapshot.genesis, rows: truncated, checkpoints: [first] }).firstMismatch.kind, 'JOURNAL_TRUNCATED');
  assert.equal(compareJournalToCheckpoints({ genesis: 'e'.repeat(64), rows: snapshot.rows, checkpoints: [first] }).firstMismatch.kind, 'GENESIS_MISMATCH');
});

test('read-only journal access does not write, and reports locked or missing databases', t => {
  const f = fixture(t); const store = f.open(); populate(f, store, 1);
  const before = readFileSync(f.path); const files = ['-wal', '-shm', '.journal.key'].map(suffix => existsSync(`${f.path}${suffix}`));
  assert.equal(readJournalReadOnly(f.path).rows.length, 2); assert.deepEqual(readFileSync(f.path), before);
  assert.deepEqual(['-wal', '-shm', '.journal.key'].map(suffix => existsSync(`${f.path}${suffix}`)), files);
  f.close();
  const lock = new DatabaseSync(f.path); lock.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
  try { assert.throws(() => readJournalReadOnly(f.path, { timeoutMs: 50 }), code('DATABASE_LOCKED')); } finally { lock.close(); }
  assert.throws(() => readJournalReadOnly(join(f.directory, 'missing.sqlite')), code('DATABASE_UNAVAILABLE'));
  assert.throws(() => readJournalReadOnly('relative.sqlite'), code('DATABASE_PATH_INVALID'));
  const foreign = join(f.directory, 'foreign.sqlite'); const db = new DatabaseSync(foreign); db.exec('CREATE TABLE other (x)'); db.close();
  assert.throws(() => readJournalReadOnly(foreign), code('DATABASE_SCHEMA_INVALID'));
});
