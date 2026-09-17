import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { advanceWorld, createWorld, projectWorld, replayWorld, validateWorldPack, worldDigest } from '../world/kernel.mjs';

export const WORLD_PROFILE = 'ABSTRACT_SYNTHETIC_WORLD';
export function worldError(code) { return Object.assign(new Error(code), { code }); }
export function requireWorld(condition, code) { if (!condition) throw worldError(code); }
export function exactWorld(value, keys, code = 'INVALID_ENVELOPE') {
  requireWorld(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), code);
}
const clone = value => JSON.parse(JSON.stringify(value));

export function openPrivateWorldDatabase(path) {
  requireWorld(typeof path === 'string' && isAbsolute(path), 'STORAGE_PATH_INVALID');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) closeSync(openSync(path, 'wx', 0o600));
  const info = lstatSync(path);
  requireWorld(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o077) === 0, 'STORAGE_NOT_PRIVATE');
  chmodSync(path, 0o600);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;');
  requireWorld(db.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'STORAGE_CORRUPT');
  return db;
}

export function makeWorldBundle(pack, state, events) {
  return { schemaVersion: 'dungeonq.world-evidence/v1', profile: WORLD_PROFILE, pack,
    worldId: state.worldId, epoch: state.epoch, events, finalDigest: worldDigest(state) };
}

export function openWorldStore({ path, pack, worldId, epoch, maxPending = 64 }) {
  const admitted = validateWorldPack(pack);
  requireWorld(Number.isInteger(maxPending) && maxPending >= 1 && maxPending <= 200, 'OUTBOX_LIMIT_INVALID');
  const db = openPrivateWorldDatabase(path);
  let closed = false; let restoring = false;
  const live = () => requireWorld(!closed, 'STORE_CLOSED');
  const transact = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS world_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
      pack_json TEXT NOT NULL, state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS world_events (sequence INTEGER PRIMARY KEY, event_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS world_requests (request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
      response_json TEXT NOT NULL, sequence INTEGER UNIQUE NOT NULL REFERENCES world_events(sequence));
      CREATE TABLE IF NOT EXISTS world_outbox (sequence INTEGER PRIMARY KEY REFERENCES world_events(sequence), digest TEXT NOT NULL,
      acknowledged INTEGER NOT NULL CHECK(acknowledged IN (0,1)));`);
    let saved = db.prepare('SELECT * FROM world_meta WHERE singleton=1').get();
    if (!saved) {
      requireWorld(db.prepare('SELECT count(*) AS n FROM world_events').get().n === 0
        && db.prepare('SELECT count(*) AS n FROM world_requests').get().n === 0
        && db.prepare('SELECT count(*) AS n FROM world_outbox').get().n === 0, 'STORAGE_INCOMPLETE');
      const state = createWorld(admitted, { worldId: worldId ?? randomUUID(), epoch: epoch ?? randomUUID() });
      transact(() => db.prepare('INSERT INTO world_meta VALUES (1,1,?,?)').run(JSON.stringify(admitted), JSON.stringify(state)));
      saved = db.prepare('SELECT * FROM world_meta WHERE singleton=1').get();
    }
    db.exec('BEGIN'); restoring = true;
    saved = db.prepare('SELECT * FROM world_meta WHERE singleton=1').get();
    requireWorld(saved.version === 1 && worldDigest(JSON.parse(saved.pack_json)) === worldDigest(admitted), 'WORLD_PACK_MISMATCH');
    const readState = () => JSON.parse(db.prepare('SELECT state_json FROM world_meta WHERE singleton=1').get().state_json);
    const readEvents = () => db.prepare('SELECT sequence,event_json FROM world_events ORDER BY sequence').all().map(row => {
      const event = JSON.parse(row.event_json);
      requireWorld(event.sequence === row.sequence, 'JOURNAL_CORRUPT'); return event;
    });
    const restored = readState();
    requireWorld((worldId === undefined || worldId === restored.worldId) && (epoch === undefined || epoch === restored.epoch), 'WORLD_IDENTITY_MISMATCH');
    const events = readEvents();
    replayWorld(makeWorldBundle(admitted, restored, events));
    let recomputed = createWorld(admitted, { worldId: restored.worldId, epoch: restored.epoch });
    const expectedResponses = new Map();
    for (const event of events) {
      const result = advanceWorld(recomputed, event.command); recomputed = result.state;
      expectedResponses.set(event.sequence, { view: result.view, event: result.event, replayed: false });
    }
    requireWorld(worldDigest(restored) === worldDigest(recomputed), 'STATE_CORRUPT');
    const outbox = db.prepare('SELECT * FROM world_outbox ORDER BY sequence').all();
    requireWorld(outbox.length === events.length && outbox.every((row, index) => row.sequence === events[index].sequence
      && row.digest === events[index].digest && [0, 1].includes(row.acknowledged)), 'OUTBOX_CORRUPT');
    const requests = db.prepare('SELECT * FROM world_requests ORDER BY sequence').all();
    requireWorld(requests.length === events.length && requests.every((row, index) => {
      const payload = JSON.parse(row.payload_json);
      return row.sequence === events[index].sequence && payload.requestId === row.request_id
        && payload.expectedRevision === row.sequence - 1 && worldDigest(payload) === row.payload_hash
        && worldDigest(payload.command) === worldDigest(events[index].command)
        && worldDigest(JSON.parse(row.response_json)) === worldDigest(expectedResponses.get(row.sequence));
    }), 'IDEMPOTENCY_CORRUPT');
    db.exec('COMMIT'); restoring = false;
    return {
      snapshot() { live(); return projectWorld(readState()); },
      command(envelope) {
        live(); exactWorld(envelope, ['requestId', 'expectedRevision', 'command']);
        requireWorld(typeof envelope.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(envelope.requestId), 'REQUEST_ID_INVALID');
        requireWorld(Number.isSafeInteger(envelope.expectedRevision) && envelope.expectedRevision >= 0, 'REVISION_INVALID');
        requireWorld(Buffer.byteLength(JSON.stringify(envelope)) <= 16_384, 'COMMAND_TOO_LARGE');
        const payloadHash = worldDigest(envelope);
        return transact(() => {
          const previous = db.prepare('SELECT payload_hash,response_json FROM world_requests WHERE request_id=?').get(envelope.requestId);
          if (previous) {
            requireWorld(previous.payload_hash === payloadHash, 'IDEMPOTENCY_CONFLICT');
            return { ...JSON.parse(previous.response_json), replayed: true };
          }
          const state = readState();
          requireWorld(state.revision === envelope.expectedRevision, 'REVISION_CONFLICT');
          requireWorld(db.prepare('SELECT count(*) AS n FROM world_outbox WHERE acknowledged=0').get().n < maxPending, 'OBSERVER_BACKLOG_FULL');
          const result = advanceWorld(state, envelope.command);
          const response = { view: result.view, event: result.event, replayed: false };
          db.prepare('INSERT INTO world_events VALUES (?,?)').run(result.event.sequence, JSON.stringify(result.event));
          db.prepare('INSERT INTO world_outbox VALUES (?,?,0)').run(result.event.sequence, result.event.digest);
          db.prepare('INSERT INTO world_requests VALUES (?,?,?,?,?)').run(envelope.requestId, payloadHash, JSON.stringify(envelope), JSON.stringify(response), result.event.sequence);
          db.prepare('UPDATE world_meta SET state_json=? WHERE singleton=1').run(JSON.stringify(result.state));
          return clone(response);
        });
      },
      exportEvidence() {
        live(); db.exec('BEGIN');
        try { const result = makeWorldBundle(admitted, readState(), readEvents()); db.exec('COMMIT'); return result; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      pending() {
        live(); return db.prepare(`SELECT e.event_json FROM world_outbox o JOIN world_events e USING(sequence)
          WHERE o.acknowledged=0 ORDER BY o.sequence`).all().map(row => JSON.parse(row.event_json));
      },
      ack(sequence, digest) {
        live(); requireWorld(Number.isSafeInteger(sequence) && sequence > 0 && typeof digest === 'string', 'ACK_INVALID');
        return transact(() => {
          const row = db.prepare('SELECT digest FROM world_outbox WHERE sequence=?').get(sequence);
          requireWorld(row && row.digest === digest, 'ACK_MISMATCH');
          db.prepare('UPDATE world_outbox SET acknowledged=1 WHERE sequence=?').run(sequence);
          return { sequence, digest };
        });
      },
      close() { if (!closed) { closed = true; db.close(); } },
    };
  } catch (error) { if (restoring) db.exec('ROLLBACK'); db.close(); throw error; }
}
