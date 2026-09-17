import { randomUUID } from 'node:crypto';
import { advanceTopology, createTopology, projectTopology, replayTopology, validateTopologyAssignment, makeTopologyBundle } from '../world/topology.mjs';
import { worldDigest } from '../world/kernel.mjs';
import { exactWorld as exactTopology, requireWorld as requireTopology, worldError as topologyError,
  openPrivateWorldDatabase as openPrivateTopologyDatabase } from './world-store.mjs';

export { exactTopology, requireTopology, topologyError, openPrivateTopologyDatabase };
export const TOPOLOGY_PROFILE = 'SYNTHETIC_TOPOLOGY_WORKFLOW';
export const TOPOLOGY_MAX_EVENTS = 128;

export function openTopologyStore({ path, seed = 19, worldId, epoch, arm = 'TREATMENT', participantMode = 'SCRIPTED_FIXTURE', maxPending = 64 }) {
  const admitted = validateTopologyAssignment({ seed, arm, participantMode });
  requireTopology(Number.isInteger(maxPending) && maxPending >= 1 && maxPending <= 64, 'OUTBOX_LIMIT_INVALID');
  const db = openPrivateTopologyDatabase(path);
  let closed = false; let restoring = false;
  const live = () => requireTopology(!closed, 'STORE_CLOSED');
  function transaction(fn, write = true) {
    db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS topology_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
      assignment_json TEXT NOT NULL, state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS topology_events (sequence INTEGER PRIMARY KEY CHECK(sequence BETWEEN 1 AND 128), event_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS topology_requests (request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
        response_json TEXT NOT NULL, sequence INTEGER UNIQUE NOT NULL REFERENCES topology_events(sequence));
      CREATE TABLE IF NOT EXISTS topology_outbox (sequence INTEGER PRIMARY KEY REFERENCES topology_events(sequence), digest TEXT NOT NULL,
        acknowledged INTEGER NOT NULL CHECK(acknowledged IN (0,1)));`);
    transaction(() => {
      if (db.prepare('SELECT singleton FROM topology_meta WHERE singleton=1').get()) return;
      requireTopology(['topology_events', 'topology_requests', 'topology_outbox'].every(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n === 0), 'STORAGE_INCOMPLETE');
      const initial = createTopology({ ...admitted, worldId: worldId ?? randomUUID(), epoch: epoch ?? randomUUID() });
      db.prepare('INSERT INTO topology_meta VALUES (1,2,?,?)').run(JSON.stringify(admitted), JSON.stringify(initial));
    });
    const readState = () => JSON.parse(db.prepare('SELECT state_json FROM topology_meta WHERE singleton=1').get().state_json);
    const readEvents = () => {
      const rows = db.prepare('SELECT sequence,event_json FROM topology_events ORDER BY sequence LIMIT 129').all();
      requireTopology(rows.length <= TOPOLOGY_MAX_EVENTS, 'TOPOLOGY_EVENT_LIMIT');
      return rows.map(row => { const event = JSON.parse(row.event_json); requireTopology(row.sequence === event.sequence, 'JOURNAL_CORRUPT'); return event; });
    };
    db.exec('BEGIN'); restoring = true;
    const saved = db.prepare('SELECT * FROM topology_meta WHERE singleton=1').get();
    requireTopology(saved.version === 2 && worldDigest(JSON.parse(saved.assignment_json)) === worldDigest(admitted), 'TOPOLOGY_DESIGN_MISMATCH');
    const state = readState();
    requireTopology((worldId === undefined || worldId === state.worldId) && (epoch === undefined || epoch === state.epoch), 'TOPOLOGY_IDENTITY_MISMATCH');
    requireTopology(state.arm === arm && state.seed === seed && state.participantMode === participantMode, 'TOPOLOGY_ASSIGNMENT_MISMATCH');
    const events = readEvents(); replayTopology(makeTopologyBundle(state, events));
    let recomputed = createTopology({ ...admitted, worldId: state.worldId, epoch: state.epoch });
    const responses = new Map();
    for (const event of events) {
      const result = advanceTopology(recomputed, event.command); recomputed = result.state;
      responses.set(event.sequence, { view: result.view, event: result.event, replayed: false });
    }
    requireTopology(worldDigest(state) === worldDigest(recomputed), 'STATE_CORRUPT');
    const outbox = db.prepare('SELECT * FROM topology_outbox ORDER BY sequence LIMIT 129').all();
    requireTopology(outbox.length === events.length && outbox.every((row, index) => row.sequence === events[index].sequence
      && row.digest === events[index].digest && [0, 1].includes(row.acknowledged)), 'OUTBOX_CORRUPT');
    const requests = db.prepare('SELECT * FROM topology_requests ORDER BY sequence LIMIT 129').all();
    requireTopology(requests.length === events.length && requests.every((row, index) => {
      const payload = JSON.parse(row.payload_json);
      return row.sequence === events[index].sequence && payload.requestId === row.request_id && payload.expectedRevision === row.sequence - 1
        && worldDigest(payload) === row.payload_hash && worldDigest(payload.command) === worldDigest(events[index].command)
        && worldDigest(JSON.parse(row.response_json)) === worldDigest(responses.get(row.sequence));
    }), 'IDEMPOTENCY_CORRUPT');
    db.exec('COMMIT'); restoring = false;
    return {
      snapshot() { live(); return projectTopology(readState()); },
      command(envelope) {
        live(); exactTopology(envelope, ['requestId', 'expectedRevision', 'command']);
        requireTopology(typeof envelope.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(envelope.requestId), 'REQUEST_ID_INVALID');
        requireTopology(Number.isSafeInteger(envelope.expectedRevision) && envelope.expectedRevision >= 0, 'REVISION_INVALID');
        requireTopology(Buffer.byteLength(JSON.stringify(envelope)) <= 8192, 'COMMAND_TOO_LARGE');
        const payloadHash = worldDigest(envelope);
        return transaction(() => {
          const previous = db.prepare('SELECT payload_hash,response_json FROM topology_requests WHERE request_id=?').get(envelope.requestId);
          if (previous) {
            requireTopology(previous.payload_hash === payloadHash, 'IDEMPOTENCY_CONFLICT');
            return { ...JSON.parse(previous.response_json), replayed: true };
          }
          const current = readState();
          requireTopology(current.revision === envelope.expectedRevision, 'REVISION_CONFLICT');
          requireTopology(!['FINISHED', 'WITHDRAWN'].includes(current.phase), 'TOPOLOGY_FINISHED');
          const withdrawal = envelope.command?.type === 'withdraw';
          // One extra slot exists solely for withdrawal; ordinary topology actions cannot borrow it.
          requireTopology(current.revision < (withdrawal ? TOPOLOGY_MAX_EVENTS : TOPOLOGY_MAX_EVENTS - 1), 'TOPOLOGY_EVENT_LIMIT');
          requireTopology(db.prepare('SELECT count(*) AS n FROM topology_outbox WHERE acknowledged=0').get().n < maxPending + (withdrawal ? 1 : 0), 'OBSERVER_BACKLOG_FULL');
          const result = advanceTopology(current, envelope.command);
          const response = { view: result.view, event: result.event, replayed: false };
          db.prepare('INSERT INTO topology_events VALUES (?,?)').run(result.event.sequence, JSON.stringify(result.event));
          db.prepare('INSERT INTO topology_outbox VALUES (?,?,0)').run(result.event.sequence, result.event.digest);
          db.prepare('INSERT INTO topology_requests VALUES (?,?,?,?,?)').run(envelope.requestId, payloadHash, JSON.stringify(envelope), JSON.stringify(response), result.event.sequence);
          db.prepare('UPDATE topology_meta SET state_json=? WHERE singleton=1').run(JSON.stringify(result.state));
          return structuredClone(response);
        });
      },
      exportEvidence() { live(); return transaction(() => makeTopologyBundle(readState(), readEvents()), false); },
      pending() {
        live(); return db.prepare(`SELECT e.event_json FROM topology_outbox o JOIN topology_events e USING(sequence)
          WHERE o.acknowledged=0 ORDER BY o.sequence`).all().map(row => JSON.parse(row.event_json));
      },
      ack(sequence, digest) {
        live(); requireTopology(Number.isInteger(sequence) && sequence > 0 && sequence <= TOPOLOGY_MAX_EVENTS
          && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'ACK_INVALID');
        return transaction(() => {
          const row = db.prepare('SELECT digest FROM topology_outbox WHERE sequence=?').get(sequence);
          requireTopology(row && row.digest === digest, 'ACK_MISMATCH');
          db.prepare('UPDATE topology_outbox SET acknowledged=1 WHERE sequence=?').run(sequence); return { sequence, digest };
        });
      },
      close() { if (!closed) { closed = true; db.close(); } },
    };
  } catch (error) { if (restoring) db.exec('ROLLBACK'); db.close(); throw error; }
}

