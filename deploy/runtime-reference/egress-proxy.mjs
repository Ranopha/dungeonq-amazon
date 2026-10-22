// Model-participant egress proxy: CONNECT only, exact host:port allowlist, public addresses only.
// Runs in its own container; the participant reaches it over the internal participant network.
import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const EGRESS_VERSION = 'dungeonq.egress-allowlist/v1';
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DEFAULT_LIMITS = Object.freeze({ maxConcurrent: 4, maxTunnels: 256, connectTimeoutMs: 5000, idleTimeoutMs: 60_000,
  maxTunnelMs: 600_000, lifetimeSeconds: 1200 });
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

function hostName(value) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 253) return null;
  const host = value.toLowerCase();
  if (net.isIP(host) || !host.includes('.')) return null;
  return host.split('.').every((label) => LABEL.test(label)) && !/^\d+$/.test(host.split('.').at(-1)) ? host : null;
}

export function normalizeAllowlist(entries) {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 8) fail('EGRESS_ALLOWLIST_INVALID');
  const normalized = entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'host,port') fail('EGRESS_ALLOWLIST_INVALID');
    const host = hostName(entry.host);
    if (!host || !Number.isSafeInteger(entry.port) || entry.port < 1 || entry.port > 65535) fail('EGRESS_ALLOWLIST_INVALID');
    return `${host}:${entry.port}`;
  });
  if (new Set(normalized).size !== normalized.length) fail('EGRESS_ALLOWLIST_INVALID');
  return Object.freeze(normalized);
}

export function parseConnectTarget(value) {
  if (typeof value !== 'string' || value.length > 260) return null;
  const match = /^([^:\s/@[\]]+):(\d{1,5})$/.exec(value);
  if (!match) return null;
  const host = hostName(match[1]); const port = Number(match[2]);
  if (!host || port < 1 || port > 65535) return null;
  return { host, port };
}

export function egressDecision(target, allowlist) {
  const parsed = parseConnectTarget(target);
  if (!parsed) return { allowed: false, code: 'TARGET_INVALID' };
  if (!allowlist.includes(`${parsed.host}:${parsed.port}`)) return { allowed: false, code: 'DESTINATION_DENIED', ...parsed };
  return { allowed: true, code: 'ALLOWED', ...parsed };
}

function ipv4Public(address) {
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return ipv4Public(address);
  if (family !== 6) return false;
  const value = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return ipv4Public(mapped[1]);
  if (value === '::' || value === '::1') return false;
  const head = parseInt(value.split(':')[0] || '0', 16);
  if ((head & 0xfe00) === 0xfc00 || (head & 0xffc0) === 0xfe80 || (head & 0xff00) === 0xff00) return false;
  if (value.startsWith('2001:db8:') || value.startsWith('64:ff9b:') || value.startsWith('100::')) return false;
  return (head & 0xe000) === 0x2000;
}

const defaultResolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

export function createEgressProxy({ allow, limits = {}, resolveHost = defaultResolve, connect = net.connect, log = () => {} }) {
  const allowlist = normalizeAllowlist(allow);
  const bounds = { ...DEFAULT_LIMITS, ...limits };
  for (const key of ['maxConcurrent', 'maxTunnels', 'connectTimeoutMs', 'idleTimeoutMs', 'maxTunnelMs']) {
    if (!Number.isSafeInteger(bounds[key]) || bounds[key] < 1) fail('EGRESS_LIMIT_INVALID');
  }
  const state = { active: 0, total: 0, allowed: 0, denied: 0, failed: 0 };
  const record = (entry) => { try { log({ at: new Date().toISOString(), ...entry }); } catch { /* logging never widens access */ } };
  const reject = (socket, status, code, target) => {
    state.denied++;
    record({ decision: 'DENIED', code, target: typeof target === 'string' ? target.slice(0, 260) : null });
    socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Too Many Requests'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const server = http.createServer((req, res) => {
    state.denied++; record({ decision: 'DENIED', code: 'METHOD_DENIED', target: null });
    res.writeHead(405, { Connection: 'close', 'Content-Length': 0 }); res.end();
  });
  server.maxHeadersCount = 32; server.headersTimeout = 5000; server.requestTimeout = 5000;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    if (state.active >= bounds.maxConcurrent) return reject(client, 429, 'CONCURRENCY_LIMIT', req.url);
    if (state.total >= bounds.maxTunnels) return reject(client, 429, 'TUNNEL_BUDGET_EXHAUSTED', req.url);
    const decision = egressDecision(req.url, allowlist);
    if (!decision.allowed) return reject(client, 403, decision.code, req.url);
    state.active++; state.total++;
    const target = `${decision.host}:${decision.port}`;
    const started = Date.now(); let upstream; let connected = false; let finished = false; let bytesUp = 0; let bytesDown = 0; let tunnelTimer;
    const finish = (code, status) => {
      if (finished) return; finished = true; state.active--; clearTimeout(tunnelTimer); upstream?.destroy();
      if (!connected) {
        state.failed++; record({ decision: 'FAILED', code, target });
        client.end(`HTTP/1.1 ${status ?? 502} Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      client.destroy();
      record({ decision: 'CLOSED', code, target, bytesUp, bytesDown, durationMs: Date.now() - started });
    };
    let addresses;
    try { addresses = await resolveHost(decision.host); } catch { return finish('RESOLUTION_FAILED'); }
    if (!Array.isArray(addresses) || addresses.length === 0 || !addresses.every(isPublicAddress)) {
      // Never follow an allowlisted name into an internal, loopback, or link-local address.
      finished = true; state.active--; return reject(client, 403, 'RESOLVED_ADDRESS_DENIED', req.url);
    }
    upstream = connect({ host: addresses[0], port: decision.port });
    upstream.setTimeout(bounds.connectTimeoutMs, () => finish(connected ? 'IDLE_TIMEOUT' : 'UPSTREAM_TIMEOUT', 504));
    upstream.once('error', () => finish(connected ? 'UPSTREAM_ERROR' : 'UPSTREAM_UNREACHABLE'));
    upstream.once('connect', () => {
      if (finished) return;
      connected = true; state.allowed++; record({ decision: 'ALLOWED', code: 'ALLOWED', target });
      upstream.setTimeout(bounds.idleTimeoutMs);
      client.setTimeout(bounds.idleTimeoutMs, () => finish('IDLE_TIMEOUT'));
      tunnelTimer = setTimeout(() => finish('TUNNEL_TIME_LIMIT'), bounds.maxTunnelMs); tunnelTimer.unref();
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) { bytesUp += head.length; upstream.write(head); }
      client.on('data', (chunk) => { bytesUp += chunk.length; });
      upstream.on('data', (chunk) => { bytesDown += chunk.length; });
      client.pipe(upstream); upstream.pipe(client);
      client.once('close', () => finish('CLIENT_CLOSED')); upstream.once('close', () => finish('UPSTREAM_CLOSED'));
    });
  });
  return { server, allowlist, bounds, stats: () => ({ ...state }) };
}

function readPrivateConfig(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) fail('PRIVATE_CONFIG_REQUIRED');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (config.schemaVersion !== EGRESS_VERSION) fail('EGRESS_CONFIG_INVALID');
  return config;
}

async function main() {
  const config = readPrivateConfig(process.argv[2]);
  const proxy = createEgressProxy({ allow: config.allow, limits: config.limits,
    log: (entry) => process.stdout.write(JSON.stringify(entry) + '\n') });
  await new Promise((done, reject) => { proxy.server.once('error', reject); proxy.server.listen(config.port ?? 3128, '0.0.0.0', done); });
  process.stdout.write(JSON.stringify({ ready: true, role: 'egress', allow: proxy.allowlist }) + '\n');
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; proxy.server.close(() => process.exit(0)); proxy.server.closeAllConnections?.(); setTimeout(() => process.exit(0), 2000).unref(); };
  // The proxy never outlives the bounded experiment window, even when nobody stops it.
  const lifetime = setTimeout(stop, Math.max(1, proxy.bounds.lifetimeSeconds) * 1000); lifetime.unref();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(JSON.stringify({ ready: false, code: error.code ?? 'EGRESS_FAILED' }) + '\n'); process.exit(1); });
}
