import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceWorld, createWorld, replayWorld, summarizeWorldEvents, validateWorldPack, worldDigest } from '../world/kernel.mjs';
import { exactWorld, makeWorldBundle, openPrivateWorldDatabase, requireWorld, WORLD_PROFILE, worldError } from './world-store.mjs';

const MAX_BODY = 16_384;
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
  requireWorld(/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? ''), 'CONTENT_TYPE_INVALID');
  requireWorld(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 'CONTENT_ENCODING_INVALID');
  requireWorld(!req.headers['content-length'] || Number(req.headers['content-length']) <= MAX_BODY, 'BODY_TOO_LARGE');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; requireWorld(size <= MAX_BODY, 'BODY_TOO_LARGE'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw worldError('JSON_INVALID'); }
}

// Each origin owns one scoped capability. No CORS, generic file route, upload, or runtime-control route.
export async function startWorldHttp({ role, token, port = 0, snapshot, command, evidence, artifact, variant = 'world' }) {
  requireWorld(['actor', 'observer'].includes(role), 'ROLE_INVALID');
  requireWorld(['world', 'defense'].includes(variant) && (variant !== 'defense' || role === 'actor'), 'VARIANT_INVALID');
  const staticRoot = fileURLToPath(new URL(variant === 'defense' ? '../public/defense-world/' : '../public/world/', import.meta.url));
  requireWorld(Number.isInteger(port) && port >= 0 && port <= 65535, 'PORT_INVALID');
  requireWorld(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token), 'TOKEN_INVALID');
  const files = new Map();
  let entries = [];
  try { entries = await readdir(staticRoot); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of entries) {
    if (!/^[a-zA-Z0-9_-]+\.(css|mjs)$/.test(name) && name !== (role === 'actor' ? 'index.html' : 'observer.html')) continue;
    const path = join(staticRoot, name); const info = await lstat(path);
    requireWorld(info.isFile() && !info.isSymbolicLink() && info.size <= 131_072, 'STATIC_FILE_INVALID');
    files.set(`/${name}`, { data: await readFile(path), type: name.endsWith('.css') ? 'text/css; charset=utf-8'
      : name.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
  }
  const authDigest = createHash('sha256').update(`Bearer ${token}`).digest();
  const server = createServer(async (req, res) => {
    securityHeaders(res);
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      requireWorld(req.socket.remoteAddress === '127.0.0.1', 'LOOPBACK_REQUIRED');
      requireWorld(req.headers.host === origin.slice(7)
        && req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host').length === 1, 'HOST_REJECTED');
      requireWorld(req.headers.origin === undefined || req.headers.origin === origin, 'ORIGIN_REJECTED');
      requireWorld(!req.headers['sec-fetch-site'] || ['none', 'same-origin'].includes(req.headers['sec-fetch-site']), 'ORIGIN_REJECTED');
      requireWorld(typeof req.url === 'string' && req.url.length <= 256 && /^\/[A-Za-z0-9_./-]*$/.test(req.url), 'PATH_REJECTED');
      if (!req.url.startsWith('/api/')) {
        requireWorld(req.method === 'GET', 'METHOD_REJECTED');
        const asset = files.get(req.url === '/' ? (role === 'actor' ? '/index.html' : '/observer.html') : req.url);
        if (!asset) return json(res, 404, { error: 'NOT_FOUND' });
        res.writeHead(200, { 'Content-Type': asset.type }); return res.end(asset.data);
      }
      const supplied = req.headers.authorization;
      requireWorld(typeof supplied === 'string' && supplied.length <= 128
        && timingSafeEqual(createHash('sha256').update(supplied).digest(), authDigest), 'UNAUTHORIZED');
      if (req.method === 'GET' && ((role === 'actor' && req.url === '/api/world') || (role === 'observer' && req.url === '/api/observer'))) {
        return json(res, 200, snapshot());
      }
      if (role === 'observer' && req.url === '/api/evidence' && req.method === 'GET') return json(res, 200, evidence());
      if (role === 'actor' && artifact && req.url === '/api/artifact' && req.method === 'GET') return json(res, 200, artifact.issue());
      if (role === 'actor' && artifact && req.url === '/api/artifact/read' && req.method === 'POST') {
        const body = await readBody(req); exactWorld(body, ['credential']); return json(res, 200, artifact.read(body.credential));
      }
      if (role === 'actor' && req.url === '/api/world/command' && req.method === 'POST') {
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
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, server,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

export function openWorldObserver({ path, pack, worldId, epoch }) {
  const admitted = validateWorldPack(pack); const db = openPrivateWorldDatabase(path);
  let state; let events; let closed = false;
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS observer_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
      pack_json TEXT NOT NULL, state_json TEXT NOT NULL, latest_sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS observer_events (sequence INTEGER PRIMARY KEY, event_json TEXT NOT NULL);`);
    let saved = db.prepare('SELECT * FROM observer_meta WHERE singleton=1').get();
    if (!saved) {
      requireWorld(db.prepare('SELECT count(*) AS n FROM observer_events').get().n === 0, 'OBSERVER_INCOMPLETE');
      const initial = createWorld(admitted, { worldId, epoch });
      db.prepare('INSERT INTO observer_meta VALUES (1,1,?,?,0)').run(JSON.stringify(admitted), JSON.stringify(initial));
      saved = db.prepare('SELECT * FROM observer_meta WHERE singleton=1').get();
    }
    state = JSON.parse(saved.state_json);
    requireWorld(saved.version === 1 && worldDigest(JSON.parse(saved.pack_json)) === worldDigest(admitted), 'WORLD_PACK_MISMATCH');
    requireWorld(state.worldId === worldId && state.epoch === epoch, 'WORLD_IDENTITY_MISMATCH');
    events = db.prepare('SELECT sequence,event_json FROM observer_events ORDER BY sequence').all().map(row => {
      const event = JSON.parse(row.event_json); requireWorld(row.sequence === event.sequence, 'JOURNAL_CORRUPT'); return event;
    });
    replayWorld(makeWorldBundle(admitted, state, events));
    let recomputed = createWorld(admitted, { worldId, epoch });
    for (const event of events) recomputed = advanceWorld(recomputed, event.command).state;
    requireWorld(worldDigest(recomputed) === worldDigest(state), 'STATE_CORRUPT');
    let latest = saved.latest_sequence;
    requireWorld(Number.isSafeInteger(latest) && latest >= state.revision && latest <= admitted.maxSteps, 'OBSERVER_WATERMARK_INVALID');
    const bundle = () => makeWorldBundle(admitted, state, events);
    return {
      append(incoming, latestSequence) {
        requireWorld(!closed, 'STORE_CLOSED');
        requireWorld(Array.isArray(incoming) && incoming.length <= 64 && Buffer.byteLength(JSON.stringify(incoming)) <= 1_048_576, 'APPEND_TOO_LARGE');
        requireWorld(Number.isSafeInteger(latestSequence) && latestSequence >= latest && latestSequence <= admitted.maxSteps, 'OBSERVER_WATERMARK_INVALID');
        let nextState = state; const nextEvents = [...events]; const acknowledgments = [];
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const event of incoming) {
            requireWorld(event && Number.isInteger(event.sequence) && event.sequence > 0 && event.sequence <= latestSequence, 'EVENT_INVALID');
            if (event.sequence <= nextState.revision) {
              requireWorld(worldDigest(nextEvents[event.sequence - 1]) === worldDigest(event), 'EVENT_CONFLICT');
            } else {
              requireWorld(event.sequence === nextState.revision + 1, 'EVENT_SEQUENCE_INVALID');
              const result = advanceWorld(nextState, event.command);
              requireWorld(worldDigest(result.event) === worldDigest(event), 'EVENT_CAUSALITY_INVALID');
              nextState = result.state; nextEvents.push(result.event);
              db.prepare('INSERT INTO observer_events VALUES (?,?)').run(event.sequence, JSON.stringify(result.event));
            }
            acknowledgments.push({ sequence: event.sequence, digest: event.digest });
          }
          requireWorld(latestSequence >= nextState.revision, 'OBSERVER_WATERMARK_INVALID');
          db.prepare('UPDATE observer_meta SET state_json=?, latest_sequence=? WHERE singleton=1').run(JSON.stringify(nextState), latestSequence);
          db.exec('COMMIT'); state = nextState; events = nextEvents; latest = latestSequence;
          return acknowledgments;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      },
      snapshot() {
        requireWorld(!closed, 'STORE_CLOSED');
        return { status: latest > state.revision ? 'LAGGING' : 'READY', worldId, events: structuredClone(events),
          summary: summarizeWorldEvents(events), verification: replayWorld(bundle()), lag: latest - state.revision, profile: WORLD_PROFILE };
      },
      exportEvidence() { requireWorld(!closed, 'STORE_CLOSED'); return structuredClone(bundle()); },
      close() { if (!closed) { closed = true; db.close(); } },
    };
  } catch (error) { db.close(); throw error; }
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
        exactWorld(message, ['type', 'path', 'pack', 'worldId', 'epoch', 'token', 'port', 'latestSequence']);
        observer = openWorldObserver(message);
        observer.append([], message.latestSequence);
        http = await startWorldHttp({ role: 'observer', token: message.token, port: message.port,
          snapshot: () => observer.snapshot(), evidence: () => observer.exportEvidence() });
        const saved = observer.exportEvidence();
        process.send({ type: 'ready', url: http.url, sequence: saved.events.length, digest: saved.events.at(-1)?.digest ?? null });
      } else if (message?.type === 'append' && observer && http) {
        exactWorld(message, ['type', 'events', 'latestSequence']);
        for (const ack of observer.append(message.events, message.latestSequence)) process.send({ type: 'ack', ...ack });
      } else throw worldError('OBSERVER_MESSAGE_REJECTED');
    } catch { process.exitCode = 1; if (http) await http.close(); observer?.close(); process.exit(1); }
  });
}
