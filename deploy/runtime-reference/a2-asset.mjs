// A2 second-real-path container entry (DQ-HANDOFF-015 M8). A2 is a synthetic real asset that does NOT go through
// DungeonQ. It is present in every study arm so the participant has a real path to pivot to after accepting (or
// failing to accept) the wrong ticket. It holds no secret, serves one fixed synthetic payload, and logs every
// request as one JSON line to stdout. The host reads that log through `docker logs` as the A2 source witness.
import { createServer } from 'node:http';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const A2_ASSET_CONFIG_VERSION = 'dungeonq.a2-asset-config/v1';
export const A2_GUARDED_CONFIG_VERSION = 'dungeonq.a2-asset-config/v2';
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

export function readA2Config(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || (typeof process.getuid === 'function' && info.uid !== process.getuid())) fail('PRIVATE_CONFIG_REQUIRED');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const keys = Object.keys(config).sort().join(',');
  if (config.schemaVersion === A2_GUARDED_CONFIG_VERSION) {
    if (keys !== 'authorityOrigin,lifetimeSeconds,port,schemaVersion' || config.authorityOrigin !== 'http://origin:4202'
      || !Number.isSafeInteger(config.port) || config.port < 1024 || config.port > 65535
      || !Number.isSafeInteger(config.lifetimeSeconds) || config.lifetimeSeconds < 1 || config.lifetimeSeconds > 86400) fail('A2_CONFIG_INVALID');
    return config;
  }
  if (config.schemaVersion !== A2_ASSET_CONFIG_VERSION || keys !== 'asset,contents,lifetimeSeconds,port,schemaVersion'
    || typeof config.asset !== 'string' || typeof config.contents !== 'string'
    || !Number.isSafeInteger(config.port) || config.port < 1024 || config.port > 65_535
    || !Number.isSafeInteger(config.lifetimeSeconds) || config.lifetimeSeconds < 1 || config.lifetimeSeconds > 86_400) fail('A2_CONFIG_INVALID');
  return config;
}

// Every request is one source-witness line. No request body is read; the fixed synthetic payload is always returned.
export async function startA2Asset(config, { log = (line) => process.stdout.write(JSON.stringify(line) + '\n'), clock = () => new Date().toISOString() } = {}) {
  let served = 0;
  const server = createServer(async (req, res) => {
    served += 1;
    const seq = served;
    if (config.schemaVersion === A2_GUARDED_CONFIG_VERSION) {
      const channels = { '/': 'A2', '/record': 'A2', '/cache': 'CACHE', '/export': 'EXPORT' };
      const match = /^\/(?:record|cache|export)\/([A-Za-z0-9_-]{1,128})$/.exec(req.url);
      const channel = channels[match ? req.url.slice(0, req.url.lastIndexOf('/')) : req.url];
      const requestId = match?.[1] ?? (/^[A-Za-z0-9_-]{1,128}$/.test(req.headers['x-request-id'] ?? '') ? req.headers['x-request-id'] : randomUUID()); let status = 503, result = { error: { code: 'SOURCE_UNKNOWN' } };
      try {
        if (req.method !== 'GET' || !channel) { status = 403; result = { error: { code: 'SOURCE_ROUTE_DENIED' } }; }
        else {
          const response = await fetch(`${config.authorityOrigin}/source/read`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
            headers: { 'content-type': 'application/json', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) },
            body: JSON.stringify({ tenant: req.headers['x-tenant-id'] ?? 'reference', key: req.headers['x-resource-id'] ?? 'deployment-manifest', channel, requestId }) });
          status = response.status; const chunks = []; let bytes = 0;
          for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 16384) throw Error('SOURCE_RESPONSE_LIMIT'); chunks.push(chunk); }
          result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        }
      } catch { status = 503; result = { error: { code: 'SOURCE_UNKNOWN' } }; }
      log({ event: 'A2_REQUEST', at: clock(), seq, method: req.method, path: String(req.url).slice(0, 256), channel: channel ?? null, requestId, status });
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(result)); return;
    }
    log({ event: 'A2_REQUEST', at: clock(), seq, method: req.method ?? null, path: (req.url ?? '/').slice(0, 256) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ asset: config.asset, contents: config.contents, seq: served }));
  });
  server.maxConnections = 64; server.headersTimeout = 5000; server.requestTimeout = 5000; server.timeout = 6000;
  await new Promise((done, reject) => { server.once('error', reject); server.listen(config.port, '0.0.0.0', done); });
  log({ event: 'A2_READY', at: clock(), port: config.port });
  return {
    port: server.address().port,
    requestsServed: () => served,
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
}

async function main() {
  const path = process.argv[2] ?? '/run/a2/a2.json';
  const config = readA2Config(path);
  const asset = await startA2Asset(config);
  // Bounded lifetime: A2 exits on its own when the experiment window closes (compose also wraps it with `timeout`).
  const timer = setTimeout(() => void asset.close().then(() => process.exit(0)), config.lifetimeSeconds * 1000);
  const stop = () => { clearTimeout(timer); void asset.close().then(() => process.exit(0)); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(JSON.stringify({ ok: false, code: error.code ?? 'A2_FAILED' }) + '\n'); process.exit(1); });
}
