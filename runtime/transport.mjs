import http from 'node:http';
import { runtimeJson } from './contracts.mjs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { worldDigest } from '../world/kernel.mjs';

export function failure(code) { return Object.assign(new Error(code.replaceAll('_', ' ')), { code }); }
export function insist(ok, code) { if (!ok) throw failure(code); }
export function exact(value, required, optional = []) {
  insist(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_ENVELOPE');
  insist(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)), 'INVALID_ENVELOPE');
}
export const digest = worldDigest;
export const newToken = () => randomBytes(32).toString('base64url');
export function equalToken(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.length <= 2048 && b.length <= 2048
    && timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}
export function bearer(req) { return /^Bearer ([A-Za-z0-9_.-]{1,2048})$/.exec(req.headers.authorization ?? '')?.[1]; }
export function privateJson(path, create) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(create()), { flag: 'wx', mode: 0o600 });
  const info = lstatSync(path);
  insist(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && !(info.mode & 0o077), 'PRIVATE_STORAGE_REQUIRED');
  return JSON.parse(readFileSync(path, 'utf8'));
}
export function seal(body, key, domain) {
  return { body, mac: createHmac('sha256', key).update(domain + '\n' + digest(body)).digest('base64url') };
}
export function unseal(value, key, domain) {
  exact(value, ['body', 'mac']);
  insist(equalToken(value.mac, seal(value.body, key, domain).mac), 'PROOF_REJECTED');
  return value.body;
}
export function headers(res) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}
export function send(res, status, body) {
  headers(res); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body));
}
export function sendError(res, error) {
  const code = /^[A-Z][A-Z0-9_]{1,79}$/.test(error?.code ?? '') ? error.code : 'SERVICE_UNAVAILABLE';
  const status = /UNAUTHORIZED|AUTH_REQUIRED/.test(code) ? 401 : /DENIED|FENCED/.test(code) ? 403
    : /CONFLICT|STALE/.test(code) ? 409 : /LIMIT|CAPACITY/.test(code) ? 429 : /UNAVAILABLE|UNKNOWN/.test(code) ? 503 : 400;
  if (!res.headersSent) send(res, status, { error: { code, message: code.replaceAll('_', ' ') } }); else res.destroy();
}
export async function body(req, limit = 32768) {
  insist(/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? ''), 'CONTENT_TYPE_INVALID');
  insist(!req.headers['content-encoding'], 'CONTENT_ENCODING_INVALID');
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; insist(size <= limit, 'BODY_LIMIT'); chunks.push(c); }
  try { return runtimeJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))),limit); }
  catch { throw failure('JSON_INVALID'); }
}
export async function serve(handler, { host = '127.0.0.1', port = 0, browser = false } = {}) {
  let active = 0; let requests = 0; let until = Date.now() + 60000;
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    let admitted = false;
    try {
      if (Date.now() >= until) { requests = 0; until = Date.now() + 60000; }
      insist(++requests <= 12000 && active < 64, 'CAPACITY_LIMIT'); active++; admitted = true;
      const expected = req.headers.host;
      insist(typeof expected === 'string' && expected.length < 128 && req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'host').length === 1, 'HOST_DENIED');
      if (host === '127.0.0.1') insist(expected === `127.0.0.1:${server.address().port}` && req.socket.remoteAddress === '127.0.0.1', 'HOST_DENIED');
      if (browser) insist(!req.headers.origin || req.headers.origin === `http://${expected}`, 'ORIGIN_DENIED');
      else insist(!req.headers.origin && !req.headers.cookie, 'BROWSER_DENIED');
      insist(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']), 'ORIGIN_DENIED');
      insist(typeof req.url === 'string' && req.url.length <= 256 && /^\/[A-Za-z0-9_./-]*$/.test(req.url), 'PATH_DENIED');
      await handler(req, res);
    } catch (e) { sendError(res, e); } finally { if (admitted) active--; }
  });
  server.maxConnections = 128; server.headersTimeout = 5000; server.requestTimeout = 5000;
  server.timeout = 6000; server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, origin: `http://${host}:${server.address().port}`, port: server.address().port,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
export async function request(origin, path, token, payload, { timeout = 4000, maxResponse = 524288 } = {}) {
  const target = new URL(origin);
  insist(target.protocol === 'http:' && !target.username && !target.password && target.pathname === '/' && !target.search && !target.hash, 'ENDPOINT_DENIED');
  insist(/^\/[a-z/-]+$/.test(path), 'PATH_DENIED');
  const encoded = payload === undefined ? undefined : JSON.stringify(payload);
  insist(encoded === undefined || Buffer.byteLength(encoded) <= 65536, 'BODY_LIMIT');
  const response = await fetch(new URL(path, target), { method: encoded === undefined ? 'GET' : 'POST', redirect: 'error',
    signal: AbortSignal.timeout(timeout), headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(encoded ? { 'Content-Type': 'application/json' } : {}) }, body: encoded });
  let size = 0; const chunks = [];
  for await (const c of response.body) { size += c.length; insist(size <= maxResponse, 'RESPONSE_LIMIT'); chunks.push(c); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('RESPONSE_INVALID'); }
  if (!response.ok) throw failure(value?.error?.code ?? 'REMOTE_REJECTED');
  return value;
}
