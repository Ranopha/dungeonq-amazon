// Signed evidence checkpoints for the runtime journal.
// Checkpoints are made by a separate sealing process with an Ed25519 private key. Verifiers use only the public key.
// The store write path stays synchronous; nothing here is called from store.apply.
import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { worldDigest } from '../world/kernel.mjs';

export const CHECKPOINT_SCHEMA = 'dungeonq.evidence-checkpoint/v1';
export const CHECKPOINT_REASONS = Object.freeze(['PERIODIC', 'FINAL', 'MANUAL']);
export const MAX_CHECKPOINT_EVENTS = 4096;
const SIGNATURE_DOMAIN = 'dungeonq-evidence-checkpoint-v1';
const DIGEST = /^[a-f0-9]{64}$/u;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BODY_KEYS = ['schemaVersion', 'keyId', 'storeLabel', 'genesis', 'index', 'previousCheckpointDigest', 'fromSequence',
  'sequence', 'head', 'eventDigests', 'lastEventAt', 'stateDigest', 'sealedAt', 'reason'];
const EVENT_KEYS = ['sequence', 'at', 'previousDigest', 'command', 'response', 'stateDigest', 'digest', 'authentication'];

export class EvidenceSealError extends Error {
  constructor(code, detail) { super(code); this.name = 'EvidenceSealError'; this.code = code; if (detail !== undefined) this.detail = detail; }
}
const need = (condition, code, detail) => { if (!condition) throw new EvidenceSealError(code, detail); };
const isDigest = value => typeof value === 'string' && DIGEST.test(value);
const safeInteger = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

function publicKeyObject(key) {
  let object;
  try { object = key instanceof KeyObject ? (key.type === 'private' ? createPublicKey(key) : key) : createPublicKey(key); }
  catch { need(false, 'SEAL_PUBLIC_KEY_INVALID'); }
  need(object.type === 'public' && object.asymmetricKeyType === 'ed25519', 'SEAL_PUBLIC_KEY_INVALID');
  return object;
}
function privateKeyObject(key) {
  let object;
  try { object = key instanceof KeyObject ? key : createPrivateKey(key); } catch { need(false, 'SEAL_PRIVATE_KEY_INVALID'); }
  need(object.type === 'private' && object.asymmetricKeyType === 'ed25519', 'SEAL_PRIVATE_KEY_INVALID');
  return object;
}

/** SHA-256 of the SPKI DER encoding; names the signer without revealing anything secret. */
export function publicKeyId(key) {
  return createHash('sha256').update(publicKeyObject(key).export({ type: 'spki', format: 'der' })).digest('hex');
}

/**
 * Recomputes the journal hash chain from stored rows, without any HMAC key.
 * rows: [{ sequence, eventJson }] in sequence order. heads[n] is the digest after n events (heads[0] is genesis).
 * The chain stops at the first row that does not link; firstBreak names it.
 */
export function recomputeJournalChain({ genesis, rows }) {
  need(isDigest(genesis), 'GENESIS_INVALID'); need(Array.isArray(rows), 'JOURNAL_ROWS_INVALID');
  const heads = [genesis]; const times = [null]; const stateDigests = [null]; let firstBreak = null;
  for (let index = 0; index < rows.length; index++) {
    const expected = index + 1; const row = rows[index]; const fail = reason => { firstBreak = { sequence: expected, reason }; };
    if (!row || row.sequence !== expected) { fail('SEQUENCE_GAP'); break; }
    let event;
    try { event = JSON.parse(row.eventJson); } catch { fail('EVENT_UNPARSEABLE'); break; }
    if (!exactKeys(event, EVENT_KEYS)) { fail('EVENT_ENVELOPE_INVALID'); break; }
    const { digest, authentication, ...body } = event;
    if (event.sequence !== expected) { fail('SEQUENCE_GAP'); break; }
    if (event.previousDigest !== heads[index]) { fail('PREVIOUS_DIGEST_MISMATCH'); break; }
    if (!isDigest(digest) || worldDigest(body) !== digest) { fail('EVENT_DIGEST_MISMATCH'); break; }
    if (!safeInteger(event.at) || (times[index] !== null && event.at < times[index])) { fail('EVENT_CLOCK_INVALID'); break; }
    if (!isDigest(event.stateDigest)) { fail('EVENT_STATE_DIGEST_INVALID'); break; }
    heads.push(digest); times.push(event.at); stateDigests.push(event.stateDigest);
  }
  const linkedThrough = heads.length - 1;
  return { status: firstBreak ? 'BROKEN' : 'LINKED', rowCount: rows.length, linkedThrough, firstBreak,
    heads, times, stateDigests, head: heads[linkedThrough], lastEventAt: times[linkedThrough], stateDigest: stateDigests[linkedThrough] };
}

function validateBody(body) {
  need(exactKeys(body, BODY_KEYS), 'CHECKPOINT_ENVELOPE_INVALID');
  need(body.schemaVersion === CHECKPOINT_SCHEMA, 'CHECKPOINT_SCHEMA_INVALID');
  need(isDigest(body.keyId) && isDigest(body.genesis) && isDigest(body.head), 'CHECKPOINT_DIGEST_INVALID');
  need(body.storeLabel === null || (typeof body.storeLabel === 'string' && LABEL.test(body.storeLabel)), 'CHECKPOINT_LABEL_INVALID');
  need(safeInteger(body.index) && safeInteger(body.fromSequence) && safeInteger(body.sequence, body.fromSequence), 'CHECKPOINT_SEQUENCE_INVALID');
  need(body.index === 0 ? body.previousCheckpointDigest === null && body.fromSequence === 0 : isDigest(body.previousCheckpointDigest),
    'CHECKPOINT_LINK_INVALID');
  need(Array.isArray(body.eventDigests) && body.eventDigests.length === body.sequence - body.fromSequence
    && body.eventDigests.length <= MAX_CHECKPOINT_EVENTS && body.eventDigests.every(isDigest), 'CHECKPOINT_EVENTS_INVALID');
  if (body.eventDigests.length) need(body.head === body.eventDigests.at(-1), 'CHECKPOINT_HEAD_INVALID');
  if (body.sequence === 0) need(body.head === body.genesis && body.lastEventAt === null && body.stateDigest === null, 'CHECKPOINT_HEAD_INVALID');
  else need(safeInteger(body.lastEventAt) && isDigest(body.stateDigest), 'CHECKPOINT_HEAD_INVALID');
  need(safeInteger(body.sealedAt), 'CHECKPOINT_TIME_INVALID');
  need(CHECKPOINT_REASONS.includes(body.reason), 'CHECKPOINT_REASON_INVALID');
  return body;
}

/**
 * Builds checkpoint content from a recomputed chain and the previous checkpoint (or null for the first one).
 * The checkpoint carries every event digest added since the previous checkpoint, so a verifier can name the first changed event.
 */
export function createCheckpoint({ chain, previous = null, keyId, storeLabel = null, sealedAt, reason }) {
  need(chain && chain.status === 'LINKED', 'JOURNAL_CHAIN_BROKEN', chain?.firstBreak);
  const fromSequence = previous ? previous.sequence : 0;
  need(chain.linkedThrough >= fromSequence, 'JOURNAL_TRUNCATED', { sealedSequence: fromSequence, journalSequence: chain.linkedThrough });
  if (previous) {
    need(previous.genesis === chain.heads[0], 'STORE_MISMATCH');
    need(chain.heads[fromSequence] === previous.head, 'JOURNAL_REWRITTEN', { sequence: fromSequence, expected: previous.head, actual: chain.heads[fromSequence] });
    need(sealedAt >= previous.sealedAt, 'CHECKPOINT_TIME_INVALID');
  }
  return validateBody({ schemaVersion: CHECKPOINT_SCHEMA, keyId, storeLabel, genesis: chain.heads[0],
    index: previous ? previous.index + 1 : 0, previousCheckpointDigest: previous ? previous.digest : null,
    fromSequence, sequence: chain.linkedThrough, head: chain.head, eventDigests: chain.heads.slice(fromSequence + 1),
    lastEventAt: chain.lastEventAt, stateDigest: chain.stateDigest, sealedAt, reason });
}

const signedMessage = digest => Buffer.from(`${SIGNATURE_DOMAIN}\0${digest}`);

/** Signs checkpoint content with the Ed25519 private key. */
export function signCheckpoint(body, privateKey) {
  const key = privateKeyObject(privateKey); validateBody(body);
  need(body.keyId === publicKeyId(key), 'CHECKPOINT_KEY_MISMATCH');
  const digest = worldDigest(body);
  return { ...structuredClone(body), digest, signature: sign(null, signedMessage(digest), key).toString('base64url') };
}

/** Verifies one signed checkpoint with the public key only. */
export function verifyCheckpoint(signed, publicKey) {
  const key = publicKeyObject(publicKey);
  try {
    need(signed !== null && typeof signed === 'object' && !Array.isArray(signed), 'CHECKPOINT_ENVELOPE_INVALID');
    const { digest, signature, ...body } = signed; validateBody(body);
    need(isDigest(digest) && worldDigest(body) === digest, 'CHECKPOINT_DIGEST_MISMATCH');
    need(body.keyId === publicKeyId(key), 'CHECKPOINT_KEY_MISMATCH');
    need(typeof signature === 'string' && /^[A-Za-z0-9_-]{86}$/u.test(signature)
      && verify(null, signedMessage(digest), key, Buffer.from(signature, 'base64url')), 'CHECKPOINT_SIGNATURE_INVALID');
    return { valid: true };
  } catch (error) {
    if (error instanceof EvidenceSealError) return { valid: false, reason: error.code };
    throw error;
  }
}

/** Verifies an ordered checkpoint log: every signature, the index/digest links, and the head continuity. */
export function verifyCheckpointLog(checkpoints, publicKey) {
  need(Array.isArray(checkpoints), 'CHECKPOINT_LOG_INVALID');
  let previous = null;
  for (let index = 0; index < checkpoints.length; index++) {
    const checkpoint = checkpoints[index]; const problem = reason => ({ status: 'INVALID', count: checkpoints.length, firstProblem: { index, reason } });
    const single = verifyCheckpoint(checkpoint, publicKey);
    if (!single.valid) return problem(single.reason);
    if (checkpoint.index !== index) return problem('CHECKPOINT_INDEX_GAP');
    if (previous) {
      if (checkpoint.previousCheckpointDigest !== previous.digest) return problem('CHECKPOINT_LINK_MISMATCH');
      if (checkpoint.fromSequence !== previous.sequence) return problem('CHECKPOINT_SEQUENCE_GAP');
      if (checkpoint.genesis !== previous.genesis) return problem('CHECKPOINT_STORE_MISMATCH');
      if (checkpoint.storeLabel !== previous.storeLabel) return problem('CHECKPOINT_STORE_MISMATCH');
      if (checkpoint.sealedAt < previous.sealedAt) return problem('CHECKPOINT_TIME_INVALID');
      if (!checkpoint.eventDigests.length && checkpoint.head !== previous.head) return problem('CHECKPOINT_HEAD_INVALID');
    }
    previous = checkpoint;
  }
  return { status: 'VALID', count: checkpoints.length, sequence: previous?.sequence ?? null, head: previous?.head ?? null,
    lastDigest: previous?.digest ?? null };
}

/**
 * Compares a journal recomputed from the database with signed checkpoints (already verified with verifyCheckpointLog).
 * Returns the first sealed position that differs, so a rewrite with a valid local HMAC is still located.
 */
export function compareJournalToCheckpoints({ genesis, rows, checkpoints }) {
  const chain = recomputeJournalChain({ genesis, rows });
  const mismatch = firstMismatch => ({ status: 'MISMATCH', firstMismatch, journalSequence: chain.rowCount, chain: chainSummary(chain) });
  if (checkpoints.length && checkpoints[0].genesis !== genesis) {
    return mismatch({ kind: 'GENESIS_MISMATCH', sequence: 0, checkpointIndex: 0, expected: checkpoints[0].genesis, actual: genesis });
  }
  for (const checkpoint of checkpoints) {
    for (let offset = 0; offset < checkpoint.eventDigests.length; offset++) {
      const sequence = checkpoint.fromSequence + offset + 1; const expected = checkpoint.eventDigests[offset];
      const base = { sequence, checkpointIndex: checkpoint.index, expected };
      if (sequence > chain.rowCount) return mismatch({ kind: 'JOURNAL_TRUNCATED', ...base, actual: null });
      if (chain.firstBreak && chain.firstBreak.sequence === sequence) {
        return mismatch({ kind: 'JOURNAL_CHAIN_BROKEN', reason: chain.firstBreak.reason, ...base, actual: null });
      }
      if (chain.heads[sequence] !== expected) return mismatch({ kind: 'EVENT_DIGEST_MISMATCH', ...base, actual: chain.heads[sequence] });
    }
    if (checkpoint.sequence > 0 && (chain.times[checkpoint.sequence] !== checkpoint.lastEventAt
      || chain.stateDigests[checkpoint.sequence] !== checkpoint.stateDigest)) {
      return mismatch({ kind: 'CHECKPOINT_METADATA_MISMATCH', sequence: checkpoint.sequence, checkpointIndex: checkpoint.index,
        expected: checkpoint.stateDigest, actual: chain.stateDigests[checkpoint.sequence] });
    }
  }
  const sealedThrough = checkpoints.at(-1)?.sequence ?? 0;
  return { status: 'MATCH', sealedThroughSequence: sealedThrough, journalSequence: chain.rowCount,
    unsealedEvents: chain.rowCount - sealedThrough,
    tail: chain.firstBreak ? { status: 'BROKEN', firstBreak: chain.firstBreak } : { status: 'LINKED' }, chain: chainSummary(chain) };
}
const chainSummary = chain => ({ status: chain.status, linkedThrough: chain.linkedThrough, head: chain.head,
  lastEventAt: chain.lastEventAt, stateDigest: chain.stateDigest, firstBreak: chain.firstBreak });

/**
 * Reads the journal through a read-only SQLite connection in one read transaction. Needs no key and never writes.
 * A busy or locked database is reported as DATABASE_LOCKED; other open/read failures as DATABASE_UNAVAILABLE.
 */
export function readJournalReadOnly(path, { timeoutMs = 2000 } = {}) {
  need(typeof path === 'string' && isAbsolute(path), 'DATABASE_PATH_INVALID');
  need(Number.isSafeInteger(timeoutMs) && timeoutMs >= 0 && timeoutMs <= 60000, 'DATABASE_TIMEOUT_INVALID');
  let stat;
  try { stat = lstatSync(path); } catch { need(false, 'DATABASE_UNAVAILABLE'); }
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0, 'DATABASE_UNAVAILABLE');
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: timeoutMs });
    db.exec('BEGIN');
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
      need(tables.includes('runtime_meta') && tables.includes('runtime_events'), 'DATABASE_SCHEMA_INVALID');
      const meta = db.prepare('SELECT version, blueprint_json, state_json FROM runtime_meta WHERE singleton=1').get();
      need(meta && typeof meta.blueprint_json === 'string' && typeof meta.state_json === 'string', 'DATABASE_SCHEMA_INVALID');
      const rows = db.prepare('SELECT sequence, event_json FROM runtime_events ORDER BY sequence').all();
      let genesis; let metaStateDigest;
      try { genesis = worldDigest(JSON.parse(meta.blueprint_json)); metaStateDigest = worldDigest(JSON.parse(meta.state_json)); }
      catch { need(false, 'DATABASE_SCHEMA_INVALID'); }
      return { storeVersion: meta.version, journalKeyMode: meta.version === 2 ? 'SEPARATE' : 'LEGACY_SHARED', genesis, metaStateDigest,
        rows: rows.map(row => ({ sequence: row.sequence, eventJson: row.event_json })) };
    } finally { try { db.exec('ROLLBACK'); } catch { /* read transaction already ended */ } }
  } catch (error) {
    if (error instanceof EvidenceSealError) throw error;
    const primary = typeof error?.errcode === 'number' ? error.errcode & 0xff : null;
    throw new EvidenceSealError(primary === 5 || primary === 6 ? 'DATABASE_LOCKED' : 'DATABASE_UNAVAILABLE', { message: String(error?.message ?? error) });
  } finally { try { db?.close(); } catch { /* already closed */ } }
}
