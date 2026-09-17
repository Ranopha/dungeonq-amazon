import { createServer } from 'node:https';
import { createHmac, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GovernanceError, requireThat, exact, token } from './contracts.mjs';
import { authorize } from './authorization.mjs';

const SESSION = '__Host-dq-session';
const NONCE = '__Host-dq-visit';
const COOKIE_FLAGS = 'Path=/; Secure; HttpOnly; SameSite=Strict';
const STATIC = new Map([
  ['/', ['../workbench/index.html', 'text/html; charset=utf-8']],
  ['/workbench.css', ['../workbench/workbench.css', 'text/css; charset=utf-8']],
  ['/workbench.mjs', ['../workbench/workbench.mjs', 'text/javascript; charset=utf-8']],
  ['/canonical.mjs', ['../public/src/canonical.mjs', 'text/javascript; charset=utf-8']]
]);
const POSTS = new Set(['/api/login', '/api/logout', '/api/grants/preview', '/api/intents', '/api/grants/publish', '/api/grants/revoke', '/api/recovery/renew', '/api/recover', '/api/members/preview', '/api/members/apply', '/api/totp/begin', '/api/totp/confirm', '/api/totp/remove']);
const HEADERS = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
};
function cookies(header = '') {
  requireThat(header.length < 8192, 'COOKIE_INVALID');
  const found = new Map();
  for (const entry of header.split(';')) {
    const [name, ...rest] = entry.trim().split('=');
    if (![SESSION, NONCE].includes(name)) continue;
    requireThat(!found.has(name), 'COOKIE_INVALID');
    const value = rest.join('=');
    requireThat(/^[A-Za-z0-9_-]{43}$/u.test(value), 'COOKIE_INVALID');
    found.set(name, value);
  }
  return found;
}
async function jsonBody(request, limit = 16_384) {
  requireThat(/^application\/json(?:;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] ?? ''), 'CONTENT_TYPE');
  requireThat(!request.headers['content-encoding'], 'CONTENT_ENCODING');
  if (request.headers['content-length']) requireThat(Number(request.headers['content-length']) <= limit, 'BODY_TOO_LARGE');
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length; requireThat(size <= limit, 'BODY_TOO_LARGE'); chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new GovernanceError('JSON_INVALID'); }
}
function statusFor(code) {
  if (['AUTH_REQUIRED', 'AUTH_FAILED'].includes(code)) return 401;
  if (['ORIGIN_DENIED', 'HOST_DENIED', 'CSRF_INVALID', 'TENANT_DENIED', 'FETCH_CONTEXT_DENIED', 'PERMISSION_DENIED'].includes(code)) return 403;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'METHOD_DENIED') return 405;
  if (code === 'BODY_TOO_LARGE') return 413;
  if (['CONTENT_TYPE', 'CONTENT_ENCODING'].includes(code)) return 415;
  if (['AUTH_CAPACITY', 'AUTH_RATE_LIMIT', 'TRANSPORT_CAPACITY'].includes(code)) return 429;
  if (code === 'SERVICE_UNAVAILABLE') return 503;
  return 400;
}

// 只暴露固定 Application 方法；不接收 local／execution handles。
export async function startWorkbench({ application, tls, port = 0, assistant, defense }) {
  requireThat(tls?.key && tls?.cert, 'TLS_REQUIRED');
  requireThat(Number.isInteger(port) && port >= 0 && port <= 65535, 'PORT_INVALID');
  const assets = new Map();
  for (const [route, [path, type]] of STATIC) assets.set(route, { bytes: await readFile(new URL(path, import.meta.url)), type });
  if (assistant) {
    for (const [route, file, type] of [
      ['/assistant', 'index.html', 'text/html; charset=utf-8'],
      ['/assistant.css', 'assistant.css', 'text/css; charset=utf-8'],
      ['/assistant.mjs', 'assistant.mjs', 'text/javascript; charset=utf-8']
    ]) assets.set(route, { bytes: await readFile(new URL(`../${assistant.info?.model && file === 'index.html' ? 'astra' : 'assistant'}/${file}`, import.meta.url)), type });
  }
  if (defense) {
    for (const [route, file, type] of [
      ['/defense', 'defense.html', 'text/html; charset=utf-8'],
      ['/defense.css', 'defense.css', 'text/css; charset=utf-8'],
      ['/defense.mjs', 'defense.mjs', 'text/javascript; charset=utf-8']
    ]) assets.set(route, { bytes: await readFile(new URL(`../workbench/${file}`, import.meta.url)), type });
  }
  const csrfKey = randomBytes(32);
  let origin; let active = 0; let count = 0; let reset = Date.now() + 60_000;
  const csrf = (binding, expires) => `${expires}.${createHmac('sha256', csrfKey).update(`${origin}\n${binding}\n${expires}`).digest('base64url')}`;
  const issueCsrf = binding => csrf(binding, Date.now() + 10 * 60_000);
  const verifyCsrf = (value, binding) => {
    requireThat(typeof value === 'string' && /^\d{13}\.[A-Za-z0-9_-]{43}$/u.test(value), 'CSRF_INVALID');
    const expires = Number(value.split('.')[0]);
    requireThat(expires > Date.now() && expires <= Date.now() + 10 * 60_000, 'CSRF_INVALID');
    requireThat(timingSafeEqual(Buffer.from(value), Buffer.from(csrf(binding, expires))), 'CSRF_INVALID');
  };
  const server = createServer({ ...tls, minVersion: 'TLSv1.2', maxHeaderSize: 16_384 }, async (request, response) => {
    const traceId = randomUUID();
    for (const [key, value] of Object.entries(HEADERS)) response.setHeader(key, value);
    response.setHeader('X-Request-ID', traceId);
    const send = (status, value) => {
      const encoded = JSON.stringify(value);
      requireThat(Buffer.byteLength(encoded) <= 512_000, 'BODY_TOO_LARGE');
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(encoded);
    };
    const clearSession = () => response.setHeader('Set-Cookie', `${SESSION}=; ${COOKIE_FLAGS}; Max-Age=0`);
    let admitted = false;
    try {
      requireThat(request.socket.remoteAddress === '127.0.0.1', 'HOST_DENIED');
      requireThat(request.headers.host === new URL(origin).host, 'HOST_DENIED');
      requireThat(!request.headers.origin || request.headers.origin === origin, 'ORIGIN_DENIED');
      requireThat(!request.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(request.headers['sec-fetch-site']), 'FETCH_CONTEXT_DENIED');
      requireThat(request.url?.startsWith('/') && !request.url.startsWith('//'), 'NOT_FOUND');
      const url = new URL(request.url, origin);
      requireThat(url.origin === origin && !url.search, 'NOT_FOUND');
      if (Date.now() >= reset) { count = 0; reset = Date.now() + 60_000; }
      requireThat(++count <= 600 && active < 8, 'TRANSPORT_CAPACITY');
      active++; admitted = true;
      const path = url.pathname;
      if (request.method === 'GET' && assets.has(path)) {
        const asset = assets.get(path); response.writeHead(200, { 'Content-Type': asset.type }); response.end(asset.bytes); return;
      }
      requireThat(path.startsWith('/api/'), 'NOT_FOUND');
      const jar = cookies(request.headers.cookie);
      const session = jar.get(SESSION);
      if (request.method === 'GET' && path === '/api/context') {
        let state = null;
        if (session) {
          try { state = application.status(session); }
          catch (error) { if (error.code !== 'AUTH_REQUIRED') throw error; clearSession(); }
        }
        if (state) { send(200, { authenticated: true, csrfToken: issueCsrf(`session:${session}`), state }); return; }
        const visit = token();
        const existing = response.getHeader('Set-Cookie');
        response.setHeader('Set-Cookie', [...(existing ? [existing] : []), `${NONCE}=${visit}; ${COOKIE_FLAGS}; Max-Age=600`]);
        send(200, { authenticated: false, csrfToken: issueCsrf(`visit:${visit}`), profile: 'SYNTHETIC_ONLY' }); return;
      }
      if (request.method === 'GET' && path === '/api/evidence') { send(200, application.evidence(session)); return; }
      if (request.method === 'GET' && path === '/api/members') { send(200, application.members(session)); return; }
      if (request.method === 'GET' && path === '/api/notifications') { send(200, application.notifications(session)); return; }
      if (defense && request.method === 'GET' && path === '/api/defense/status') {
        const state = application.status(session);
        authorize(state.role, 'READ_STATUS');
        requireThat(state.tenantId === 'tenant-lab', 'TENANT_DENIED');
        // Notification receipts are Owner-only; readers can still inspect the lab.
        const notifications = state.capabilities.includes('MANAGE_MEMBERS') ? application.notifications(session) : null;
        send(200, { governance: application.rotationStatus(session), lab: await defense.status(), notifications }); return;
      }
      if (assistant && request.method === 'GET' && path === '/api/assistant/context') {
        application.status(session);
        send(200, { info: assistant.info, responses: application.responses(session) }); return;
      }
      const assistantPost = assistant && ['/api/assistant/command', '/api/assistant/approve'].includes(path);
      const defensePost = defense && ['/api/defense/approve', '/api/defense/apply', '/api/defense/reconcile', '/api/defense/refresh'].includes(path);
      requireThat(POSTS.has(path) || assistantPost || defensePost, 'NOT_FOUND');
      requireThat(request.method === 'POST', 'METHOD_DENIED');
      requireThat(request.headers.origin === origin, 'ORIGIN_DENIED');
      const visitor = path === '/api/login' || path === '/api/recover';
      if (path === '/api/recover') requireThat(!session, 'LOGOUT_REQUIRED');
      const binding = visitor ? `visit:${jar.get(NONCE) ?? ''}` : `session:${session ?? ''}`;
      requireThat(visitor ? jar.has(NONCE) : !!session, visitor ? 'CSRF_INVALID' : 'AUTH_REQUIRED');
      verifyCsrf(request.headers['x-dq-csrf'], binding);
      const body = await jsonBody(request, path === '/api/assistant/command' ? 196_608 : 16_384);
      // 不信任 X-Forwarded-For 或請求中自稱的來源。
      const source = 'loopback-workbench';
      if (defensePost) {
        const state = application.status(session);
        requireThat(state.tenantId === 'tenant-lab', 'TENANT_DENIED');
        authorize(state.role, 'PUBLISH_GRANT');
        if (path === '/api/defense/approve') {
          exact(body, ['requestId', 'manifestDigest', 'intentToken']);
          send(200, application.approveRotation(session, body)); return;
        }
        exact(body, ['requestId']);
        requireThat(typeof body.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(body.requestId), 'SCHEMA_INVALID');
        if (path === '/api/defense/refresh') { send(200, application.refreshRotation(session, body)); return; }
        if (path === '/api/defense/reconcile') { send(200, await defense.reconcileRotation(body.requestId)); return; }
        send(200, await defense.runRotation(body.requestId)); return;
      }
      if (assistantPost) {
        const state = application.status(session);
        // This optional UI controls only the launcher's single synthetic tenant.
        requireThat(state.tenantId === 'tenant-lab', 'TENANT_DENIED');
        if (path === '/api/assistant/approve') { send(200, application.approveResponse(session, body)); return; }
        if (body?.command !== 'status') authorize(state.role, 'PREVIEW_GRANT');
        send(200, await assistant.command(body)); return;
      }
      if (path === '/api/recover') {
        const result = await application.recover(body, source);
        response.setHeader('Set-Cookie', `${NONCE}=; ${COOKIE_FLAGS}; Max-Age=0`);
        send(200, result); return;
      }
      if (path === '/api/login') {
        const result = await application.login(body, source);
        // 成功登入換 Session，舊瀏覽器 Session 不再有效。
        if (session) { try { application.logout(session); } catch (error) { if (error.code !== 'AUTH_REQUIRED') throw error; } }
        response.setHeader('Set-Cookie', [`${SESSION}=${result.sessionToken}; ${COOKIE_FLAGS}; Max-Age=28800`, `${NONCE}=; ${COOKIE_FLAGS}; Max-Age=0`]);
        send(200, { principal: result.principal, expiresAt: result.expiresAt }); return;
      }
      if (path === '/api/logout') { exact(body, []); const result = application.logout(session); clearSession(); send(200, result); return; }
      if (path === '/api/grants/preview') { send(200, application.previewGrant(session, body)); return; }
      if (path === '/api/intents') { send(200, await application.reauthenticate(session, body, source)); return; }
      if (path === '/api/totp/begin') { exact(body, ['intentToken']); send(200, application.beginTotp(session, body.intentToken)); return; }
      if (path === '/api/totp/confirm') { const result = application.confirmTotp(session, body, source); clearSession(); send(200, result); return; }
      if (path === '/api/totp/remove') { exact(body, ['intentToken']); const result = application.removeTotp(session, body.intentToken); clearSession(); send(200, result); return; }
      if (path === '/api/members/preview') { send(200, application.previewMemberChange(session, body)); return; }
      if (path === '/api/members/apply') { exact(body, ['draft', 'intentToken']); send(200, await application.applyMemberChange(session, body.draft, body.intentToken)); return; }
      if (path === '/api/recovery/renew') { exact(body, ['intentToken']); send(200, application.renewRecoveryCodes(session, body.intentToken)); return; }
      if (path === '/api/grants/publish') { exact(body, ['draft', 'intentToken']); send(200, application.publishGrant(session, body.draft, body.intentToken)); return; }
      if (path === '/api/grants/revoke') { exact(body, ['intentToken']); send(200, application.revokeGrants(session, body.intentToken)); }
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const code = error instanceof GovernanceError ? error.code : 'SERVICE_UNAVAILABLE';
      if (code === 'AUTH_REQUIRED') clearSession();
      // 不把底層 SQL、路徑、密碼、Cookie、Body 或 stack 傳出／記錄。
      send(statusFor(code), { error: code, traceId });
    } finally { if (admitted) active--; }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 5000; server.timeout = assistant?.info?.model ? 90_000 : 10_000;
  server.maxConnections = 32; server.maxRequestsPerSocket = 100; server.keepAliveTimeout = 2000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `https://127.0.0.1:${server.address().port}`;
  return Object.freeze({ origin, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) });
}
