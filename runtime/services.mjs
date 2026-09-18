import { openAuxiliary } from './auxiliary.mjs';
import { bearer, body, digest, equalToken, exact, insist, request, send, serve } from './transport.mjs';

export async function startOrigin({ path, normalToken, witnessToken, contextId = 'ordinary', host, port }) {
  const db = openAuxiliary(path, 'CREATE TABLE IF NOT EXISTS origin_meta (id INTEGER PRIMARY KEY, config TEXT NOT NULL, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS origin_admissions (seq INTEGER PRIMARY KEY, context TEXT NOT NULL, accepted INTEGER NOT NULL, request_id TEXT NOT NULL);', 'origin_meta');
  const config = digest({ normalToken, witnessToken, contextId });
  const saved = db.prepare('SELECT * FROM origin_meta WHERE id=1').get();
  if (!saved) db.prepare('INSERT INTO origin_meta VALUES(1,?,?)').run(config, JSON.stringify({ key: 'welcome', quantity: 7, classification: 'ARTIFICIAL_PROTECTED_REFERENCE' }));
  else insist(saved.config === config, 'ORIGIN_CONFIG_CHANGED');
  const value = () => JSON.parse(db.prepare('SELECT value FROM origin_meta WHERE id=1').get().value);
  const report = () => {
    const rows = db.prepare('SELECT * FROM origin_admissions ORDER BY seq').all();
    insist(rows.every((r,index)=>r.seq===index+1), 'ORIGIN_AUDIT_INCOMPLETE');
    return { admissions: rows, schemaVersion: 'dungeonq.origin-witness/v1', resource: 'artificial-origin', stateDigest: digest(value()),
      configDigest: config, accepted: rows.filter(r => r.accepted === 1).length, rejected: rows.filter(r => r.accepted === 0).length,
      acceptedContexts: [...new Set(rows.filter(r => r.accepted === 1).map(r => r.context))], highWater: rows.at(-1)?.seq ?? 0 };
  };
  let transport;
  try { transport = await serve(async (req, res) => {
    if (req.url === '/witness' && req.method === 'GET') {
      insist(equalToken(bearer(req), witnessToken), 'UNAUTHORIZED'); return send(res, 200, report());
    }
    insist(req.url === '/business' && req.method === 'POST', 'NOT_FOUND');
    const input = await body(req); exact(input, ['contextId', 'requestId', 'operation', 'args']);
    insist(typeof input.contextId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(input.contextId), 'CONTEXT_INVALID');
    insist(typeof input.requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId), 'REQUEST_ID_INVALID');
    insist(db.prepare('SELECT count(*) AS n FROM origin_admissions').get().n < 20000, 'ORIGIN_AUDIT_LIMIT');
    const accepted = equalToken(bearer(req), normalToken) && input.contextId === contextId
      && ['snapshot', 'read'].includes(input.operation) && (input.operation !== 'read' || input.args?.key === 'welcome');
    db.prepare('INSERT INTO origin_admissions(context,accepted,request_id) VALUES(?,?,?)').run(input.contextId, Number(accepted), input.requestId);
    insist(accepted, 'ORIGIN_AUTHORITY_DENIED');
    return send(res, 200, { destination: 'ORIGIN', record: value(), requestId: input.requestId });
  }, { host, port }); }
  catch (e) { db.close(); throw e; }
  return { ...transport, report, close: async () => { await transport.close(); db.close(); } };
}

export async function startCollector({ path, producerToken, readerToken, host, port }) {
  const db = openAuxiliary(path, 'CREATE TABLE IF NOT EXISTS collector_meta(id INTEGER PRIMARY KEY, config TEXT NOT NULL); CREATE TABLE IF NOT EXISTS collector_events(seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, hash TEXT NOT NULL, previous TEXT NOT NULL);', 'collector_meta');
  const config = digest({ producerToken, readerToken });
  const saved = db.prepare('SELECT config FROM collector_meta WHERE id=1').get();
  if (!saved) db.prepare('INSERT INTO collector_meta VALUES(1,?)').run(config); else insist(saved.config === config, 'COLLECTOR_CONFIG_CHANGED');
  const read = () => {
    const rows = db.prepare('SELECT * FROM collector_events ORDER BY seq').all(); let previous = 'ROOT'; let sequence = 0;
    for (const row of rows) { insist(row.seq === ++sequence && row.previous === previous && digest({ previous, event: JSON.parse(row.payload) }) === row.hash, 'EVIDENCE_CHAIN_INVALID'); previous = row.hash; }
    return { schemaVersion: 'dungeonq.collector/v1', highWater: sequence, head: previous, events: rows.map(r => JSON.parse(r.payload)), complete: true };
  };
  read(); let transport;
  try { transport = await serve(async (req, res) => {
    if (req.url === '/evidence' && req.method === 'GET') {
      insist(equalToken(bearer(req), readerToken), 'UNAUTHORIZED'); return send(res, 200, read());
    }
    insist(req.url === '/event' && req.method === 'POST', 'NOT_FOUND');
    insist(equalToken(bearer(req), producerToken), 'UNAUTHORIZED');
    const event = await body(req, 8192); exact(event, ['eventId', 'contextId', 'requestId', 'family', 'destination', 'outcome', 'resultDigest']);
    insist(['http', 'mcp', 'ssh', 'postgres', 'host'].includes(event.family), 'FAMILY_DENIED');
    insist(['SYNTHETIC', 'ORIGIN'].includes(event.destination) && ['SERVED', 'FAILED', 'UNKNOWN'].includes(event.outcome), 'EVENT_INVALID');
    for (const key of ['eventId', 'contextId', 'requestId']) insist(typeof event[key] === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(event[key]), 'EVENT_INVALID');
    insist(typeof event.resultDigest === 'string' && /^[a-f0-9]{64}$/.test(event.resultDigest), 'EVENT_INVALID');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previousEvent = db.prepare('SELECT payload FROM collector_events WHERE event_id=?').get(event.eventId);
      if (previousEvent) insist(digest(JSON.parse(previousEvent.payload)) === digest(event), 'EVENT_REPLAY_CONFLICT');
      else {
        const last = db.prepare('SELECT seq,hash FROM collector_events ORDER BY seq DESC LIMIT 1').get();
        insist((last?.seq ?? 0) < 20000, 'EVIDENCE_CAPACITY_LIMIT');
        const previous = last?.hash ?? 'ROOT';
        db.prepare('INSERT INTO collector_events(event_id,payload,hash,previous) VALUES(?,?,?,?)').run(event.eventId, JSON.stringify(event), digest({ previous, event }), previous);
      }
      db.exec('COMMIT'); return send(res, 200, { accepted: true, eventId: event.eventId });
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }, { host, port }); } catch (e) { db.close(); throw e; }
  return { ...transport, close: async () => { await transport.close(); db.close(); } };
}

export async function startFacade({ stateOrigin, host, port }) {
  const transport = await serve(async (req, res) => {
    insist(req.method === 'POST' && req.url === '/effect', 'NOT_FOUND');
    const admitted = await body(req); exact(admitted, ['body', 'mac']);
    const result = await request(stateOrigin, '/execute', undefined, admitted);
    send(res, 200, result);
  }, { host, port });
  return transport;
}
