import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { runtimeJson, runtimeEnvelope } from './contracts.mjs';

export const PUBLIC_GATEWAY_LIMITS = Object.freeze({ maxRequests: 1000, maxConcurrent: 8, maxConnections: 32,
  maxBodyBytes: 32768, maxResponseBytes: 524288, timeoutMs: 8000 });
const error = (code, status = 400) => Object.assign(new Error(code), { code, status });
const check = (value, code, status) => { if (!value) throw error(code, status); };
const hash = value => createHash('sha256').update(value).digest();
const exactToken = (a, b) => timingSafeEqual(hash(a), hash(b));
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const STATIC = new Map([
  ['/runtime/participant.html', 'text/html'], ['/runtime/participant.css', 'text/css'],
  ['/runtime/participant.mjs', 'text/javascript'], ['/runtime/client.mjs', 'text/javascript'], ['/runtime/styles.css', 'text/css'],
]);
const API = new Map([['/api/operate', 'POST'], ['/api/write-status', 'POST'], ['/api/capabilities', 'GET'], ['/mcp', 'POST']]);
const OPERATIONS = new Set(['snapshot', 'read', 'write', 'issue-ticket', 'use-ticket']);

function privateJson(path) {
  check(typeof path === 'string' && isAbsolute(path), 'CONFIG_PATH_INVALID');
  const parent = lstatSync(dirname(path));
  check(parent.isDirectory() && !parent.isSymbolicLink() && !(parent.mode & 0o022), 'CONFIG_NOT_PRIVATE');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    check(stat.isFile() && stat.nlink === 1 && !(stat.mode & 0o077) && stat.size <= 16384, 'CONFIG_NOT_PRIVATE');
    return runtimeJson(JSON.parse(readFileSync(fd, 'utf8')), 16384);
  } finally { closeSync(fd); }
}
function origin(value, protocol, hostname) {
  let url; try { url = new URL(value); } catch { throw error('CONFIG_ORIGIN_INVALID'); }
  check(url.protocol === protocol && (!hostname || url.hostname === hostname) && !url.username && !url.password
    && url.pathname === '/' && !url.search && !url.hash && url.origin === value, 'CONFIG_ORIGIN_INVALID');
  return url;
}
function configuration(path) {
  const config = privateJson(path);
  runtimeEnvelope(config, ['schemaVersion', 'publicOrigin', 'basePath', 'runtimeOrigin', 'mcpOrigin', 'credentialsPath', 'participantNames']);
  check(config.schemaVersion === 'dungeonq.public-gateway/v1' && ['', '/dungeonq'].includes(config.basePath), 'CONFIG_INVALID');
  const publicURL = origin(config.publicOrigin, 'https:');
  check(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(publicURL.hostname) && !publicURL.port
    && !['localhost', '127.0.0.1'].includes(publicURL.hostname), 'CONFIG_ORIGIN_INVALID');
  const runtimeURL = origin(config.runtimeOrigin, 'http:', '127.0.0.1');
  const mcpURL = origin(config.mcpOrigin, 'http:', '127.0.0.1');
  check(runtimeURL.port && mcpURL.port && runtimeURL.port !== mcpURL.port, 'CONFIG_ORIGIN_INVALID');
  const credentials = privateJson(config.credentialsPath);
  runtimeEnvelope(credentials, ['owner', 'actor', 'other', 'ordinary', 'seal', 'producer', 'reader', 'witness']);
  check(Object.values(credentials).every(value => typeof value === 'string' && TOKEN.test(value)), 'CONFIG_CREDENTIAL_INVALID');
  check(new Set(Object.values(credentials)).size === Object.keys(credentials).length, 'CONFIG_CREDENTIAL_COLLISION');
  check(Array.isArray(config.participantNames) && config.participantNames.length >= 1 && config.participantNames.length <= 2
    && new Set(config.participantNames).size === config.participantNames.length
    && config.participantNames.every(name => ['actor', 'other'].includes(name)), 'CONFIG_PARTICIPANT_INVALID');
  return { ...config, publicURL, runtimeURL, mcpURL, tokens: config.participantNames.map(name => credentials[name]) };
}
function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}
function deny(res, failure) {
  if (res.headersSent) return res.destroy();
  securityHeaders(res);
  const status = Number.isInteger(failure.status) ? failure.status : 502;
  const code = SAFE_CODE.test(failure.code ?? '') ? failure.code : 'PUBLIC_GATEWAY_UNAVAILABLE';
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
  res.end(JSON.stringify({ error: { code } }));
}
function single(req, name, required = false) {
  const count = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
  check(count <= 1 && (!required || count === 1), 'HEADER_DENIED', 400);
  return req.headers[name];
}
async function readBody(req, maximum, signal) {
  check(/^application\/json(?:;\s*charset=utf-8)?$/i.test(single(req, 'content-type', true) ?? ''), 'CONTENT_TYPE_DENIED', 415);
  const chunks = []; let size = 0;
  const abort = () => req.destroy(); signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of req) { size += chunk.length; check(size <= maximum, 'BODY_LIMIT', 413); chunks.push(chunk); }
    let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw error('JSON_INVALID', 400); }
    try { return runtimeJson(value, maximum, 12); } catch { throw error('JSON_INVALID', 400); }
  } finally { signal.removeEventListener('abort', abort); }
}
function payloadFor(path, value) {
  try {
    if (path !== '/mcp') {
      runtimeEnvelope(value, ['requestId', 'operation', 'args'], [], 32768);
      check(typeof value.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.requestId)
        && OPERATIONS.has(value.operation) && value.args && typeof value.args === 'object' && !Array.isArray(value.args), 'PAYLOAD_DENIED');
      check(path !== '/api/write-status' || value.operation === 'write', 'PAYLOAD_DENIED');
    } else {
      runtimeEnvelope(value, ['jsonrpc', 'method'], ['id', 'params'], 32768);
      check(value.jsonrpc === '2.0' && ['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping'].includes(value.method), 'MCP_METHOD_DENIED');
      check(value.id === undefined || typeof value.id === 'string' && value.id.length <= 128 || Number.isSafeInteger(value.id), 'PAYLOAD_DENIED');
      if (value.method === 'tools/call') {
        runtimeEnvelope(value.params, ['name', 'arguments'], ['_meta'], 32768);
        check([...OPERATIONS].some(operation => value.params.name === 'dungeonq_' + operation.replaceAll('-', '_')), 'MCP_TOOL_DENIED');
        runtimeEnvelope(value.params.arguments, ['requestId', 'args'], [], 32768);
        payloadFor('/api/operate', { operation: value.params.name.slice(9).replaceAll('_', '-'), ...value.params.arguments });
      }
    }
  } catch (failure) { if (failure.status) throw failure; throw error('PAYLOAD_DENIED', 400); }
  return JSON.stringify(value);
}
function upstream(url, path, token, encoded, limits, signal, protocolVersion) {
  return new Promise((resolve, reject) => {
    const headers = { Host: url.host, Accept: path === '/mcp' ? 'application/json, text/event-stream' : '*/*',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(path !== '/mcp' ? { Origin: url.origin } : {}),
      ...(encoded !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : {}),
      ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}) };
    const request = http.request({ hostname: '127.0.0.1', port: url.port, path, method: encoded === undefined ? 'GET' : 'POST',
      headers, signal, agent: false }, response => {
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400 || response.headers['content-encoding']) {
        response.destroy(); reject(error('UPSTREAM_RESPONSE_DENIED', 502)); return;
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > limits.maxResponseBytes) { response.destroy(); reject(error('UPSTREAM_RESPONSE_LIMIT', 502)); }
        else chunks.push(chunk);
      });
      response.on('error', () => reject(error('UPSTREAM_UNAVAILABLE', 502)));
      response.on('end', () => resolve({ status, type: response.headers['content-type'] ?? '', body: Buffer.concat(chunks) }));
    });
    request.on('error', () => reject(error(signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', signal.aborted ? 504 : 502)));
    request.end(encoded);
  });
}
function responseBody(route, response, prefix) {
  const expected = STATIC.get(route);
  if (expected) {
    check(response.status === 200 && response.type.split(';')[0] === expected, 'UPSTREAM_RESPONSE_DENIED', 502);
    let text = response.body.toString('utf8');
    if (prefix && route === '/runtime/participant.html') text = text.replaceAll('"/runtime/', `"${prefix}/runtime/`);
    if (prefix && route === '/runtime/participant.mjs') {
      check(text.includes("from '/runtime/client.mjs'"), 'UPSTREAM_ASSET_CHANGED', 502);
      text = text.replace("from '/runtime/client.mjs'", `from '${prefix}/runtime/client.mjs'`);
    }
    if (prefix && route === '/runtime/client.mjs') {
      check(text.includes('const base = originOf(origin);'), 'UPSTREAM_ASSET_CHANGED', 502);
      text = text.replace('const base = originOf(origin);', `const base = originOf(origin) + ${JSON.stringify(prefix)};`);
    }
    return { type: `${expected}; charset=utf-8`, body: Buffer.from(text) };
  }
  if (route === '/mcp' && response.status === 202 && response.body.length === 0) return { type: 'application/json', body: response.body };
  check(/^application\/json(?:;|$)/i.test(response.type), 'UPSTREAM_RESPONSE_DENIED', 502);
  let value; try { value = JSON.parse(response.body.toString('utf8')); } catch { throw error('UPSTREAM_RESPONSE_INVALID', 502); }
  check(value && typeof value === 'object' && !Array.isArray(value), 'UPSTREAM_RESPONSE_INVALID', 502);
  if (response.status >= 400) {
    const code = SAFE_CODE.test(value.error?.code ?? '') ? value.error.code : 'UPSTREAM_REJECTED';
    return { type: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ error: { code } })) };
  }
  return { type: 'application/json; charset=utf-8', body: response.body };
}

/** Participant-only bridge. It never starts a tunnel, publishes a route or selects an upstream from request data. */
export async function startPublicGateway({ configPath, port = 0, limits: overrides = {} } = {}) {
  const config = configuration(configPath); const limits = { ...PUBLIC_GATEWAY_LIMITS, ...overrides };
  check(Object.keys(overrides).every(key => Object.hasOwn(PUBLIC_GATEWAY_LIMITS, key)), 'CONFIG_LIMIT_INVALID');
  for (const [key, maximum] of Object.entries(PUBLIC_GATEWAY_LIMITS)) check(Number.isSafeInteger(limits[key]) && limits[key] > 0 && limits[key] <= maximum, 'CONFIG_LIMIT_INVALID');
  check(Number.isSafeInteger(port) && port >= 0 && port <= 65535, 'CONFIG_PORT_INVALID');
  // This unaffecting capability read prevents accidental attachment to the diagnostic projection.
  const probe = await upstream(config.runtimeURL, '/api/capabilities', config.tokens[0], undefined, limits, AbortSignal.timeout(limits.timeoutMs));
  const capability = responseBody('/api/capabilities', probe, '');
  check(probe.status === 200 && JSON.parse(capability.body.toString()).schemaVersion === 'workspace.capabilities/v1', 'PARTICIPANT_RUNTIME_REQUIRED');
  let requests = 0; let active = 0; let closing; const controllers = new Set();
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    let admitted = false; const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
    const abort = () => { if (!res.writableEnded) controller.abort(); }; res.once('close', abort);
    try {
      check(++requests <= limits.maxRequests && active < limits.maxConcurrent, 'PUBLIC_CAPACITY_LIMIT', 429); active++; admitted = true;
      check(req.socket.remoteAddress === '127.0.0.1', 'PEER_DENIED', 403);
      check(single(req, 'host', true) === config.publicURL.host, 'HOST_DENIED', 403);
      const suppliedOrigin = single(req, 'origin'); check(suppliedOrigin === undefined || suppliedOrigin === config.publicOrigin, 'ORIGIN_DENIED', 403);
      check(single(req, 'content-encoding') === undefined, 'CONTENT_ENCODING_DENIED', 415);
      const rawPath = req.url;
      check(typeof rawPath === 'string' && rawPath.length <= 128 && /^\/[A-Za-z0-9_./-]*$/.test(rawPath)
        && !rawPath.includes('//') && !rawPath.split('/').some(part => part === '.' || part === '..'), 'PATH_DENIED', 404);
      check(!config.basePath || rawPath.startsWith(config.basePath + '/'), 'PATH_DENIED', 404);
      let route = config.basePath ? rawPath.slice(config.basePath.length) : rawPath;
      if (route === '/') route = '/runtime/participant.html';
      const api = API.has(route); check(api || STATIC.has(route), 'PATH_DENIED', 404);
      const method = api ? API.get(route) : 'GET';
      if (req.method !== method) { res.setHeader('Allow', method); throw error('METHOD_DENIED', 405); }
      const authorization = single(req, 'authorization');
      const suppliedToken = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(authorization ?? '')?.[1];
      const token = suppliedToken && config.tokens.find(allowed => exactToken(allowed, suppliedToken));
      check(!api && authorization === undefined || token, 'PARTICIPANT_AUTH_REQUIRED', 401);
      if (api) check(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']), 'ORIGIN_DENIED', 403);
      let encoded;
      if (method === 'POST') encoded = payloadFor(route, await readBody(req, limits.maxBodyBytes, controller.signal));
      else check(!req.headers['transfer-encoding'] && (!req.headers['content-length'] || req.headers['content-length'] === '0'), 'BODY_DENIED', 400);
      const protocolVersion = route === '/mcp' ? single(req, 'mcp-protocol-version') : undefined;
      check(protocolVersion === undefined || /^\d{4}-\d{2}-\d{2}$/.test(protocolVersion), 'HEADER_DENIED', 400);
      const response = await upstream(route === '/mcp' ? config.mcpURL : config.runtimeURL, route, token, encoded, limits, controller.signal, protocolVersion);
      const output = responseBody(route, response, config.basePath);
      check(output.body.length <= limits.maxResponseBytes, 'UPSTREAM_RESPONSE_LIMIT', 502);
      securityHeaders(res); res.writeHead(response.status, { 'Content-Type': output.type }); res.end(output.body);
    } catch (failure) { deny(res, controller.signal.aborted ? error('UPSTREAM_TIMEOUT', 504) : failure); }
    finally { clearTimeout(timer); controllers.delete(controller); res.removeListener('close', abort); if (admitted) active--; }
  });
  server.maxConnections = limits.maxConnections; server.headersTimeout = Math.min(5000, limits.timeoutMs);
  server.requestTimeout = limits.timeoutMs; server.timeout = limits.timeoutMs; server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = Math.min(100, limits.maxRequests);
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, port: server.address().port,
    publicURL: config.publicOrigin + config.basePath + '/runtime/participant.html',
    status: () => ({ requests, active, limits: { ...limits } }),
    close: () => closing ??= new Promise(resolve => { for (const controller of controllers) controller.abort(); server.close(resolve); server.closeAllConnections(); }) };
}
