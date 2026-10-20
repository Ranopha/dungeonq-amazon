import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { runJudgeDemo } from './judge-response-demo.mjs';
const output = process.argv[2];
if (!output || existsSync(output)) throw Error('NEW_REPORT_PATH_REQUIRED');
const csrf = randomBytes(24).toString('hex');
let state = { status: 'READY', events: [] }, work, origin;
const html = readFileSync(new URL('./demo-console.html', import.meta.url), 'utf8').replace('DEMO_CSRF_TOKEN', csrf);
const send = (res, status, type, value) => { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" }); res.end(value); };
const server = createServer(async (req, res) => {
  if (req.headers.host !== new URL(origin).host) return send(res, 403, 'text/plain', 'HOST_DENIED');
  if (req.method === 'GET' && req.url === '/') return send(res, 200, 'text/html; charset=utf-8', html);
  if (req.method === 'GET' && req.url === '/state') return send(res, 200, 'application/json', JSON.stringify(state));
  if (req.method !== 'POST' || req.url !== '/run' || req.headers.origin !== origin || req.headers['x-demo-csrf'] !== csrf)
    return send(res, 403, 'text/plain', 'REQUEST_DENIED');
  if (state.status !== 'READY') return send(res, 409, 'text/plain', 'RUN_ALREADY_STARTED');
  state.status = 'RUNNING';
  work = runJudgeDemo(row => state.events.push(row)).then(report => {
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); state = report;
  }).catch(() => { state.status = 'FAILED'; state.error = 'DEMO_FAILED'; });
  send(res, 202, 'application/json', JSON.stringify({ status: 'RUNNING' }));
});
server.listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; process.stdout.write(origin + '\n'); });
process.once('SIGTERM', async () => { await work; server.close(); });
