import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceStudy, createStudy, replayStudy, summarizeStudy, validateStudyDesign, makeStudyBundle } from '../study/experiment.mjs';
import { worldDigest } from '../world/kernel.mjs';
import { exactStudy, openPrivateStudyDatabase, requireStudy, STUDY_PROFILE, STUDY_MAX_EVENTS, studyError } from './study-store.mjs';

const staticRoot = fileURLToPath(new URL('../public/study/', import.meta.url));
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
  requireStudy(/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? ''), 'CONTENT_TYPE_INVALID');
  requireStudy(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 'CONTENT_ENCODING_INVALID');
  requireStudy(!req.headers['content-length'] || Number(req.headers['content-length']) <= MAX_BODY, 'BODY_TOO_LARGE');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; requireStudy(size <= MAX_BODY, 'BODY_TOO_LARGE'); chunks.push(chunk); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw studyError('JSON_INVALID'); }
}

// Each origin owns one scoped capability. No CORS, generic file route, upload, or runtime-control route.
export async function startStudyHttp({ role, token, port = 0, snapshot, command, evidence }) {
  requireStudy(['actor', 'observer'].includes(role), 'ROLE_INVALID');
  requireStudy(Number.isInteger(port) && port >= 0 && port <= 65535, 'PORT_INVALID');
  requireStudy(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token), 'TOKEN_INVALID');
  const files = new Map();
  let entries = [];
  try { entries = await readdir(staticRoot); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of entries) {
    if (!/^[a-zA-Z0-9_-]+\.(css|mjs)$/.test(name) && name !== (role === 'actor' ? 'index.html' : 'observer.html')) continue;
    const path = join(staticRoot, name); const info = await lstat(path);
    requireStudy(info.isFile() && !info.isSymbolicLink() && info.size <= 131_072, 'STATIC_FILE_INVALID');
    files.set(`/${name}`, { data: await readFile(path), type: name.endsWith('.css') ? 'text/css; charset=utf-8'
      : name.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
  }
  const authDigest = createHash('sha256').update(`Bearer ${token}`).digest();
  const server = createServer({ maxHeaderSize: 16_384 }, async (req, res) => {
    securityHeaders(res);
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      requireStudy(req.socket.remoteAddress === '127.0.0.1', 'LOOPBACK_REQUIRED');
      requireStudy(req.headers.host === origin.slice(7)
        && req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host').length === 1, 'HOST_REJECTED');
      requireStudy(req.headers.origin === undefined || req.headers.origin === origin, 'ORIGIN_REJECTED');
      requireStudy(!req.headers['sec-fetch-site'] || ['none', 'same-origin'].includes(req.headers['sec-fetch-site']), 'ORIGIN_REJECTED');
      requireStudy(typeof req.url === 'string' && req.url.length <= 256 && /^\/[A-Za-z0-9_./-]*$/.test(req.url), 'PATH_REJECTED');
      if (!req.url.startsWith('/api/')) {
        requireStudy(req.method === 'GET', 'METHOD_REJECTED');
        const asset = files.get(req.url === '/' ? (role === 'actor' ? '/index.html' : '/observer.html') : req.url);
        if (!asset) return json(res, 404, { error: 'NOT_FOUND' });
        res.writeHead(200, { 'Content-Type': asset.type }); return res.end(asset.data);
      }
      const supplied = req.headers.authorization;
      requireStudy(typeof supplied === 'string' && supplied.length <= 128
        && timingSafeEqual(createHash('sha256').update(supplied).digest(), authDigest), 'UNAUTHORIZED');
      if (req.method === 'GET' && ((role === 'actor' && req.url === '/api/study') || (role === 'observer' && req.url === '/api/observer'))) {
        return json(res, 200, snapshot());
      }
      if (role === 'observer' && req.url === '/api/evidence' && req.method === 'GET') return json(res, 200, evidence());
      if (role === 'actor' && req.url === '/api/study/command' && req.method === 'POST') {
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

export function openStudyObserver({ path, design, worldId, epoch, arm, rule, nonce }) {
  const admitted = validateStudyDesign(design); const db = openPrivateStudyDatabase(path);
  let state; let events; let closed = false; let restoring = false;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS observer_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
      design_json TEXT NOT NULL, state_json TEXT NOT NULL, latest_sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS observer_events (sequence INTEGER PRIMARY KEY, event_json TEXT NOT NULL);`);
    let saved = db.prepare('SELECT * FROM observer_meta WHERE singleton=1').get();
    if (!saved) {
      requireStudy(db.prepare('SELECT count(*) AS n FROM observer_events').get().n === 0, 'OBSERVER_INCOMPLETE');
      const initial = createStudy(admitted, { worldId, epoch, arm, rule, nonce });
      db.prepare('INSERT INTO observer_meta VALUES (1,1,?,?,0)').run(JSON.stringify(admitted), JSON.stringify(initial));
      saved = db.prepare('SELECT * FROM observer_meta WHERE singleton=1').get();
    }
    db.exec('BEGIN'); restoring = true;
    saved = db.prepare('SELECT * FROM observer_meta WHERE singleton=1').get();
    state = JSON.parse(saved.state_json);
    requireStudy(saved.version === 1 && worldDigest(JSON.parse(saved.design_json)) === worldDigest(admitted), 'STUDY_DESIGN_MISMATCH');
    requireStudy(state.worldId === worldId && state.epoch === epoch, 'STUDY_IDENTITY_MISMATCH');
    requireStudy(state.arm === arm && state.rule === rule && state.nonce === nonce, 'STUDY_ASSIGNMENT_MISMATCH');
    events = db.prepare('SELECT sequence,event_json FROM observer_events ORDER BY sequence LIMIT 129').all().map(row => {
      const event = JSON.parse(row.event_json); requireStudy(row.sequence === event.sequence, 'JOURNAL_CORRUPT'); return event;
    });
    requireStudy(events.length <= STUDY_MAX_EVENTS, 'STUDY_EVENT_LIMIT');
    replayStudy(makeStudyBundle(state, events));
    let recomputed = createStudy(admitted, { worldId, epoch, arm, rule, nonce });
    for (const event of events) recomputed = advanceStudy(recomputed, event.command).state;
    requireStudy(worldDigest(recomputed) === worldDigest(state), 'STATE_CORRUPT');
    let latest = saved.latest_sequence;
    requireStudy(Number.isSafeInteger(latest) && latest >= state.revision && latest <= STUDY_MAX_EVENTS, 'OBSERVER_WATERMARK_INVALID');
    db.exec('COMMIT'); restoring = false;
    const bundle = () => makeStudyBundle(state, events);
    return {
      append(incoming, latestSequence) {
        requireStudy(!closed, 'STORE_CLOSED');
        requireStudy(Array.isArray(incoming) && incoming.length <= 64 && Buffer.byteLength(JSON.stringify(incoming)) <= 1_048_576, 'APPEND_TOO_LARGE');
        requireStudy(Number.isSafeInteger(latestSequence) && latestSequence >= latest && latestSequence <= STUDY_MAX_EVENTS, 'OBSERVER_WATERMARK_INVALID');
        let nextState = state; const nextEvents = [...events]; const acknowledgments = [];
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const event of incoming) {
            requireStudy(event && Number.isInteger(event.sequence) && event.sequence > 0 && event.sequence <= latestSequence, 'EVENT_INVALID');
            if (event.sequence <= nextState.revision) {
              requireStudy(worldDigest(nextEvents[event.sequence - 1]) === worldDigest(event), 'EVENT_CONFLICT');
            } else {
              requireStudy(event.sequence === nextState.revision + 1, 'EVENT_SEQUENCE_INVALID');
              const result = advanceStudy(nextState, event.command);
              requireStudy(worldDigest(result.event) === worldDigest(event), 'EVENT_CAUSALITY_INVALID');
              nextState = result.state; nextEvents.push(result.event);
              db.prepare('INSERT INTO observer_events VALUES (?,?)').run(event.sequence, JSON.stringify(result.event));
            }
            acknowledgments.push({ sequence: event.sequence, digest: event.digest });
          }
          requireStudy(latestSequence >= nextState.revision, 'OBSERVER_WATERMARK_INVALID');
          db.prepare('UPDATE observer_meta SET state_json=?, latest_sequence=? WHERE singleton=1').run(JSON.stringify(nextState), latestSequence);
          db.exec('COMMIT'); state = nextState; events = nextEvents; latest = latestSequence;
          return acknowledgments;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      snapshot() {
        requireStudy(!closed, 'STORE_CLOSED');
        return { status: latest > state.revision ? 'LAGGING' : 'READY', worldId, events: structuredClone(events),
          summary: summarizeStudy(state, events), verification: replayStudy(bundle()), lag: latest - state.revision, profile: STUDY_PROFILE };
      },
      exportEvidence() { requireStudy(!closed, 'STORE_CLOSED'); return structuredClone(bundle()); },
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
        exactStudy(message, ['type', 'path', 'design', 'worldId', 'epoch', 'arm', 'rule', 'nonce', 'token', 'port', 'latestSequence']);
        observer = openStudyObserver(message);
        observer.append([], message.latestSequence);
        http = await startStudyHttp({ role: 'observer', token: message.token, port: message.port,
          snapshot: () => observer.snapshot(), evidence: () => observer.exportEvidence() });
        const saved = observer.exportEvidence();
        process.send({ type: 'ready', url: http.url, sequence: saved.events.length, digest: saved.events.at(-1)?.digest ?? null });
      } else if (message?.type === 'append' && observer && http) {
        exactStudy(message, ['type', 'events', 'latestSequence']);
        for (const ack of observer.append(message.events, message.latestSequence)) process.send({ type: 'ack', ...ack });
      } else throw studyError('OBSERVER_MESSAGE_REJECTED');
    } catch { process.exitCode = 1; if (http) await http.close(); observer?.close(); process.exit(1); }
  });
}
