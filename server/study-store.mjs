import { randomBytes, randomUUID } from 'node:crypto';
import { advanceStudy, createStudy, projectStudy, replayStudy, validateStudyDesign, makeStudyBundle } from '../study/experiment.mjs';
import { worldDigest } from '../world/kernel.mjs';
import { exactWorld as exactStudy, requireWorld as requireStudy, worldError as studyError,
  openPrivateWorldDatabase as openPrivateStudyDatabase } from './world-store.mjs';

export { exactStudy, requireStudy, studyError, openPrivateStudyDatabase };
export const STUDY_PROFILE = 'SYNTHETIC_CAUSAL_STUDY';
export const STUDY_MAX_EVENTS = 128;

export function openStudyStore({ path, design, worldId, epoch, arm, rule, nonce, maxPending = 64 }) {
  const admitted = validateStudyDesign(design);
  requireStudy(['CORRELATED', 'DISCRIMINATING'].includes(arm) && ['signal', 'structure'].includes(rule), 'STUDY_ASSIGNMENT_INVALID');
  requireStudy(Number.isInteger(maxPending) && maxPending >= 1 && maxPending <= 64, 'OUTBOX_LIMIT_INVALID');
  const db = openPrivateStudyDatabase(path);
  let closed = false; let restoring = false;
  const live = () => requireStudy(!closed, 'STORE_CLOSED');
  function transaction(fn, write = true) {
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS study_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
      design_json TEXT NOT NULL, state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS study_events (sequence INTEGER PRIMARY KEY CHECK(sequence BETWEEN 1 AND 128), event_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS study_requests (request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
        response_json TEXT NOT NULL, sequence INTEGER UNIQUE NOT NULL REFERENCES study_events(sequence));
      CREATE TABLE IF NOT EXISTS study_outbox (sequence INTEGER PRIMARY KEY REFERENCES study_events(sequence), digest TEXT NOT NULL,
        acknowledged INTEGER NOT NULL CHECK(acknowledged IN (0,1)));`);
    transaction(() => {
      if (db.prepare('SELECT singleton FROM study_meta WHERE singleton=1').get()) return;
      requireStudy(['study_events', 'study_requests', 'study_outbox'].every(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n === 0), 'STORAGE_INCOMPLETE');
      const initial = createStudy(admitted, { worldId: worldId ?? randomUUID(), epoch: epoch ?? randomUUID(), arm, rule,
        nonce: nonce ?? randomBytes(32).toString('hex') });
      db.prepare('INSERT INTO study_meta VALUES (1,1,?,?)').run(JSON.stringify(admitted), JSON.stringify(initial));
    });
    const readState = () => JSON.parse(db.prepare('SELECT state_json FROM study_meta WHERE singleton=1').get().state_json);
    const readEvents = () => {
      const rows = db.prepare('SELECT sequence,event_json FROM study_events ORDER BY sequence LIMIT 129').all();
      requireStudy(rows.length <= STUDY_MAX_EVENTS, 'STUDY_EVENT_LIMIT');
      return rows.map(row => { const event = JSON.parse(row.event_json); requireStudy(row.sequence === event.sequence, 'JOURNAL_CORRUPT'); return event; });
    };
    db.exec('BEGIN'); restoring = true;
    const saved = db.prepare('SELECT * FROM study_meta WHERE singleton=1').get();
    requireStudy(saved.version === 1 && worldDigest(JSON.parse(saved.design_json)) === worldDigest(admitted), 'STUDY_DESIGN_MISMATCH');
    const state = readState();
    requireStudy((worldId === undefined || worldId === state.worldId) && (epoch === undefined || epoch === state.epoch), 'STUDY_IDENTITY_MISMATCH');
    requireStudy(state.arm === arm && state.rule === rule && (nonce === undefined || nonce === state.nonce), 'STUDY_ASSIGNMENT_MISMATCH');
    const events = readEvents(); replayStudy(makeStudyBundle(state, events));
    let recomputed = createStudy(admitted, { worldId: state.worldId, epoch: state.epoch, arm, rule, nonce: state.nonce });
    const responses = new Map();
    for (const event of events) {
      const result = advanceStudy(recomputed, event.command); recomputed = result.state;
      responses.set(event.sequence, { view: result.view, event: result.event, replayed: false });
    }
    requireStudy(worldDigest(state) === worldDigest(recomputed), 'STATE_CORRUPT');
    const outbox = db.prepare('SELECT * FROM study_outbox ORDER BY sequence LIMIT 129').all();
    requireStudy(outbox.length === events.length && outbox.every((row, index) => row.sequence === events[index].sequence
      && row.digest === events[index].digest && [0, 1].includes(row.acknowledged)), 'OUTBOX_CORRUPT');
    const requests = db.prepare('SELECT * FROM study_requests ORDER BY sequence LIMIT 129').all();
    requireStudy(requests.length === events.length && requests.every((row, index) => {
      const payload = JSON.parse(row.payload_json);
      return row.sequence === events[index].sequence && payload.requestId === row.request_id && payload.expectedRevision === row.sequence - 1
        && worldDigest(payload) === row.payload_hash && worldDigest(payload.command) === worldDigest(events[index].command)
        && worldDigest(JSON.parse(row.response_json)) === worldDigest(responses.get(row.sequence));
    }), 'IDEMPOTENCY_CORRUPT');
    db.exec('COMMIT'); restoring = false;
    return {
      snapshot() { live(); return projectStudy(readState()); },
      command(envelope) {
        live(); exactStudy(envelope, ['requestId', 'expectedRevision', 'command']);
        requireStudy(typeof envelope.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(envelope.requestId), 'REQUEST_ID_INVALID');
        requireStudy(Number.isSafeInteger(envelope.expectedRevision) && envelope.expectedRevision >= 0, 'REVISION_INVALID');
        requireStudy(Buffer.byteLength(JSON.stringify(envelope)) <= 8192, 'COMMAND_TOO_LARGE');
        const payloadHash = worldDigest(envelope);
        return transaction(() => {
          const previous = db.prepare('SELECT payload_hash,response_json FROM study_requests WHERE request_id=?').get(envelope.requestId);
          if (previous) {
            requireStudy(previous.payload_hash === payloadHash, 'IDEMPOTENCY_CONFLICT');
            return { ...JSON.parse(previous.response_json), replayed: true };
          }
          const current = readState();
          requireStudy(current.revision === envelope.expectedRevision, 'REVISION_CONFLICT');
          requireStudy(!['COMPLETE', 'WITHDRAWN'].includes(current.phase), 'STUDY_FINISHED');
          const withdrawal = envelope.command?.type === 'withdraw';
          // One extra slot exists solely for withdrawal; ordinary study actions cannot borrow it.
          requireStudy(current.revision < (withdrawal ? STUDY_MAX_EVENTS : STUDY_MAX_EVENTS - 1), 'STUDY_EVENT_LIMIT');
          requireStudy(db.prepare('SELECT count(*) AS n FROM study_outbox WHERE acknowledged=0').get().n < maxPending + (withdrawal ? 1 : 0), 'OBSERVER_BACKLOG_FULL');
          const result = advanceStudy(current, envelope.command);
          const response = { view: result.view, event: result.event, replayed: false };
          db.prepare('INSERT INTO study_events VALUES (?,?)').run(result.event.sequence, JSON.stringify(result.event));
          db.prepare('INSERT INTO study_outbox VALUES (?,?,0)').run(result.event.sequence, result.event.digest);
          db.prepare('INSERT INTO study_requests VALUES (?,?,?,?,?)').run(envelope.requestId, payloadHash, JSON.stringify(envelope), JSON.stringify(response), result.event.sequence);
          db.prepare('UPDATE study_meta SET state_json=? WHERE singleton=1').run(JSON.stringify(result.state));
          return structuredClone(response);
        });
      },
      exportEvidence() { live(); return transaction(() => makeStudyBundle(readState(), readEvents()), false); },
      pending() {
        live(); return db.prepare(`SELECT e.event_json FROM study_outbox o JOIN study_events e USING(sequence)
          WHERE o.acknowledged=0 ORDER BY o.sequence`).all().map(row => JSON.parse(row.event_json));
      },
      ack(sequence, digest) {
        live(); requireStudy(Number.isInteger(sequence) && sequence > 0 && sequence <= STUDY_MAX_EVENTS
          && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'ACK_INVALID');
        return transaction(() => {
          const row = db.prepare('SELECT digest FROM study_outbox WHERE sequence=?').get(sequence);
          requireStudy(row && row.digest === digest, 'ACK_MISMATCH');
          db.prepare('UPDATE study_outbox SET acknowledged=1 WHERE sequence=?').run(sequence); return { sequence, digest };
        });
      },
      close() { if (!closed) { closed = true; db.close(); } },
    };
  } catch (error) { if (restoring) db.exec('ROLLBACK'); db.close(); throw error; }
}
