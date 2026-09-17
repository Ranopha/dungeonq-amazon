import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceTopology, createTopology, replayTopology, summarizeTopology, validateTopologyAssignment, makeTopologyBundle } from '../world/topology.mjs';
import { worldDigest } from '../world/kernel.mjs';
import { exactTopology, openPrivateTopologyDatabase, requireTopology, TOPOLOGY_PROFILE, TOPOLOGY_MAX_EVENTS, topologyError } from './topology-store.mjs';

const staticRoot = fileURLToPath(new URL('../public/topology/', import.meta.url));
const MAX_BODY = 8192;
function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
}
async function readBody(req) {
  requireTopology(/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? ''), 'CONTENT_TYPE_INVALID');
  requireTopology(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 'CONTENT_ENCODING_INVALID');
  requireTopology(!req.headers['content-length'] || Number(req.headers['content-length']) <= MAX_BODY, 'BODY_TOO_LARGE');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; requireTopology(size <= MAX_BODY, 'BODY_TOO_LARGE'); chunks.push(chunk); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw topologyError('JSON_INVALID'); }
}

// Each origin owns one scoped capability. No CORS, generic file route, upload, or runtime-control route.
export async function startTopologyHttp({ role, token, port = 0, snapshot, command, evidence }) {
  requireTopology(['actor', 'observer'].includes(role), 'ROLE_INVALID');
  requireTopology(Number.isInteger(port) && port >= 0 && port <= 65535, 'PORT_INVALID');
  requireTopology(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token), 'TOKEN_INVALID');
  const files = new Map();
  let entries = [];
  try { entries = await readdir(staticRoot); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of entries) {
    if (!/^[a-zA-Z0-9_-]+\.(css|mjs)$/.test(name) && name !== (role === 'actor' ? 'index.html' : 'observer.html')) continue;
    const path = join(staticRoot, name); const info = await lstat(path);
    requireTopology(info.isFile() && !info.isSymbolicLink() && info.size <= 131_072, 'STATIC_FILE_INVALID');
    files.set(`/${name}`, { data: await readFile(path), type: name.endsWith('.css') ? 'text/css; charset=utf-8'
      : name.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
  }
  const authDigest = createHash('sha256').update(`Bearer ${token}`).digest();
  const server = createServer({ maxHeaderSize: 16_384 }, async (req, res) => {
    securityHeaders(res);
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      requireTopology(req.socket.remoteAddress === '127.0.0.1', 'LOOPBACK_REQUIRED');
      requireTopology(req.headers.host === origin.slice(7)
        && req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host').length === 1, 'HOST_REJECTED');
      requireTopology(req.headers.origin === undefined || req.headers.origin === origin, 'ORIGIN_REJECTED');
      requireTopology(!req.headers['sec-fetch-site'] || ['none', 'same-origin'].includes(req.headers['sec-fetch-site']), 'ORIGIN_REJECTED');
      requireTopology(typeof req.url === 'string' && req.url.length <= 256 && /^\/[A-Za-z0-9_./-]*$/.test(req.url), 'PATH_REJECTED');
      if (!req.url.startsWith('/api/')) {
        requireTopology(req.method === 'GET', 'METHOD_REJECTED');
        const asset = files.get(req.url === '/' ? (role === 'actor' ? '/index.html' : '/observer.html') : req.url);
        if (!asset) return json(res, 404, { error: 'NOT_FOUND' });
        res.writeHead(200, { 'Content-Type': asset.type }); return res.end(asset.data);
      }
      const supplied = req.headers.authorization;
      requireTopology(typeof supplied === 'string' && supplied.length <= 128
        && timingSafeEqual(createHash('sha256').update(supplied).digest(), authDigest), 'UNAUTHORIZED');
      if (req.method === 'GET' && ((role === 'actor' && req.url === '/api/topology') || (role === 'observer' && req.url === '/api/observer'))) {
        return json(res, 200, snapshot());
      }
      if (role === 'observer' && req.url === '/api/evidence' && req.method === 'GET') return json(res, 200, evidence());
      if (role === 'actor' && req.url === '/api/topology/command' && req.method === 'POST') {
        const result = command(await readBody(req));
        return json(res, 200, { view: result.view, replayed: result.replayed });
      }
      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : 'REQUEST_REJECTED';
      const status = code === 'UNAUTHORIZED' ? 401 : code === 'BODY_TOO_LARGE' ? 413
        : code === 'OBSERVER_BACKLOG_FULL' ? 503 : ['REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT'].includes(code) ? 409
          : ['HOST_REJECTED', 'ORIGIN_REJECTED', 'LOOPBACK_REQUIRED'].includes(code) ? 403 : 400;
      if (!res.headersSent) json(res, status, { error: code }); else res.destroy();
    }
  });
  server.maxHeadersCount = 24; server.headersTimeout = 5000; server.requestTimeout = 5000; server.keepAliveTimeout = 1000;
  server.maxConnections = 32; server.maxRequestsPerSocket = 100;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, server,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

export function openTopologyObserver({ path, seed, worldId, epoch, arm, participantMode }) {
  const admitted = validateTopologyAssignment({ seed, arm, participantMode }); const db = openPrivateTopologyDatabase(path);
  let state; let events; let closed = false; let restoring = false;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS observer_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
      assignment_json TEXT NOT NULL, state_json TEXT NOT NULL, latest_sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS observer_events (sequence INTEGER PRIMARY KEY, event_json TEXT NOT NULL);`);
    let saved = db.prepare('SELECT * FROM observer_meta WHERE singleton=1').get();
    if (!saved) {
      requireTopology(db.prepare('SELECT count(*) AS n FROM observer_events').get().n === 0, 'OBSERVER_INCOMPLETE');
      const initial = createTopology({ ...admitted, worldId, epoch });
      db.prepare('INSERT INTO observer_meta VALUES (1,2,?,?,0)').run(JSON.stringify(admitted), JSON.stringify(initial));
      saved = db.prepare('SELECT * FROM observer_meta WHERE singleton=1').get();
    }
    db.exec('BEGIN'); restoring = true;
    saved = db.prepare('SELECT * FROM observer_meta WHERE singleton=1').get();
    state = JSON.parse(saved.state_json);
    requireTopology(saved.version === 2 && worldDigest(JSON.parse(saved.assignment_json)) === worldDigest(admitted), 'TOPOLOGY_DESIGN_MISMATCH');
    requireTopology(state.worldId === worldId && state.epoch === epoch, 'TOPOLOGY_IDENTITY_MISMATCH');
    requireTopology(state.arm === arm && state.seed === seed && state.participantMode === participantMode, 'TOPOLOGY_ASSIGNMENT_MISMATCH');
    events = db.prepare('SELECT sequence,event_json FROM observer_events ORDER BY sequence LIMIT 129').all().map(row => {
      const event = JSON.parse(row.event_json); requireTopology(row.sequence === event.sequence, 'JOURNAL_CORRUPT'); return event;
    });
    requireTopology(events.length <= TOPOLOGY_MAX_EVENTS, 'TOPOLOGY_EVENT_LIMIT');
    replayTopology(makeTopologyBundle(state, events));
    let recomputed = createTopology({ ...admitted, worldId, epoch });
    for (const event of events) recomputed = advanceTopology(recomputed, event.command).state;
    requireTopology(worldDigest(recomputed) === worldDigest(state), 'STATE_CORRUPT');
    let latest = saved.latest_sequence;
    requireTopology(Number.isSafeInteger(latest) && latest >= state.revision && latest <= TOPOLOGY_MAX_EVENTS, 'OBSERVER_WATERMARK_INVALID');
    db.exec('COMMIT'); restoring = false;
    const bundle = () => makeTopologyBundle(state, events);
    return {
      append(incoming, latestSequence) {
        requireTopology(!closed, 'STORE_CLOSED');
        requireTopology(Array.isArray(incoming) && incoming.length <= 64 && Buffer.byteLength(JSON.stringify(incoming)) <= 1_048_576, 'APPEND_TOO_LARGE');
        requireTopology(Number.isSafeInteger(latestSequence) && latestSequence >= latest && latestSequence <= TOPOLOGY_MAX_EVENTS, 'OBSERVER_WATERMARK_INVALID');
        let nextState = state; const nextEvents = [...events]; const acknowledgments = [];
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const event of incoming) {
            requireTopology(event && Number.isInteger(event.sequence) && event.sequence > 0 && event.sequence <= latestSequence, 'EVENT_INVALID');
            if (event.sequence <= nextState.revision) {
              requireTopology(worldDigest(nextEvents[event.sequence - 1]) === worldDigest(event), 'EVENT_CONFLICT');
            } else {
              requireTopology(event.sequence === nextState.revision + 1, 'EVENT_SEQUENCE_INVALID');
              const result = advanceTopology(nextState, event.command);
              requireTopology(worldDigest(result.event) === worldDigest(event), 'EVENT_CAUSALITY_INVALID');
              nextState = result.state; nextEvents.push(result.event);
              db.prepare('INSERT INTO observer_events VALUES (?,?)').run(event.sequence, JSON.stringify(result.event));
            }
            acknowledgments.push({ sequence: event.sequence, digest: event.digest });
          }
          requireTopology(latestSequence >= nextState.revision, 'OBSERVER_WATERMARK_INVALID');
          db.prepare('UPDATE observer_meta SET state_json=?, latest_sequence=? WHERE singleton=1').run(JSON.stringify(nextState), latestSequence);
          db.exec('COMMIT'); state = nextState; events = nextEvents; latest = latestSequence;
          return acknowledgments;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      snapshot() {
        requireTopology(!closed, 'STORE_CLOSED');
        return { status: latest > state.revision ? 'LAGGING' : 'READY', worldId, events: structuredClone(events),
          summary: summarizeTopology(state, events), verification: replayTopology(bundle()), lag: latest - state.revision, profile: TOPOLOGY_PROFILE };
      },
      exportEvidence() { requireTopology(!closed, 'STORE_CLOSED'); return structuredClone(bundle()); },
      close() { if (!closed) { closed = true; db.close(); } },
    };
  } catch (error) { if (restoring) db.exec('ROLLBACK'); db.close(); throw error; }
}

// This fixed child entry point has a single append channel. Replies only acknowledge saved immutable events.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.send) {
  let observer; let http; let booting = false;
  const stop = async () => { if (http) await http.close(); observer?.close(); process.exit(0); };
  process.on('disconnect', stop); process.on('SIGTERM', stop);
  process.on('message', async message => {
    try {
      if (message?.type === 'bootstrap' && !observer && !booting) {
        booting = true;
        exactTopology(message, ['type', 'path', 'seed', 'worldId', 'epoch', 'arm', 'participantMode', 'token', 'port', 'latestSequence']);
        observer = openTopologyObserver(message);
        observer.append([], message.latestSequence);
        http = await startTopologyHttp({ role: 'observer', token: message.token, port: message.port,
          snapshot: () => observer.snapshot(), evidence: () => observer.exportEvidence() });
        const saved = observer.exportEvidence();
        process.send({ type: 'ready', url: http.url, sequence: saved.events.length, digest: saved.events.at(-1)?.digest ?? null });
      } else if (message?.type === 'append' && observer && http) {
        exactTopology(message, ['type', 'events', 'latestSequence']);
        for (const ack of observer.append(message.events, message.latestSequence)) process.send({ type: 'ack', ...ack });
      } else throw topologyError('OBSERVER_MESSAGE_REJECTED');
    } catch { process.exitCode = 1; if (http) await http.close(); observer?.close(); process.exit(1); }
  });
}

