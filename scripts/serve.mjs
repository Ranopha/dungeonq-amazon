#!/usr/bin/env node
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, extname, resolve } from 'node:path';
import { access } from 'node:fs/promises';
import { readStaticAsset, isStaticAsset, STATIC_TYPES, BUILD_MARKER } from './lib/static-assets.mjs';

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
});
function sendPlain(response, status, message) {
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' }); response.end(message);
}
export function createStaticServer({ rootUrl = new URL('../public/', import.meta.url), runtimeClientUrl = null } = {}) {
  const root = rootUrl instanceof URL ? fileURLToPath(rootUrl) : resolve(rootUrl);
  const server = createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method ?? '')) { sendPlain(response, 405, 'Method not allowed'); return; }
    let pathname;
    try {
      const host = new URL('http://' + request.headers.host);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) || Number(host.port || 80) !== server.address().port) { sendPlain(response, 403, 'Host denied'); return; }
      pathname = decodeURIComponent((request.url ?? '').split('?')[0]);
    } catch { sendPlain(response, 400, 'Bad request'); return; }
    if (!pathname.startsWith('/') || pathname.startsWith('//') || pathname.split('/').some(part => part === '.' || part === '..')) { sendPlain(response, 404, 'Not found'); return; }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const path = pathname.slice(1);
    if (!isStaticAsset(path)) { sendPlain(response, 404, 'Not found'); return; }
    try {
      const data = path === 'runtime/client.mjs' && runtimeClientUrl
        ? await readStaticAsset(dirname(fileURLToPath(runtimeClientUrl)), 'runtime-client.mjs') : await readStaticAsset(root, path);
      response.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': STATIC_TYPES[extname(path)], 'Content-Length': data.length });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch { sendPlain(response, 404, 'Not found'); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.maxHeadersCount = 100;
  return server;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || args.length === 1 && args[0] !== '--built') throw Error('Use npm run dev, or npm run build then npm start.');
    const built = args[0] === '--built';
    const rootUrl = new URL(built ? '../dist/static/' : '../public/', import.meta.url);
    if (built) await access(new URL(BUILD_MARKER, rootUrl));
    const port = Number(process.env.DUNGEONQ_PORT ?? '4174');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('DUNGEONQ_PORT must be an integer from 1 to 65535.');
    const server = createStaticServer({ rootUrl, runtimeClientUrl: built ? null : new URL('../sdk/runtime-client.mjs', import.meta.url) });
    server.once('error', error => { console.error(error.code ?? 'STATIC_SERVER_FAILED'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`DungeonQ static preview: http://127.0.0.1:${port}\nStatic assets only. Use the dedicated runtime/lab commands for API-backed workspaces.`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeIdleConnections(); });
  } catch (error) { console.error(error.code === 'ENOENT' ? 'Build output missing. Run npm run build first.' : error.message); process.exitCode = 1; }
}
