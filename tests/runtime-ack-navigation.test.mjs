import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { serve, send } from '../runtime/transport.mjs';
const ack = `/ack/incident-${'a'.repeat(64)}/${'b'.repeat(43)}`;
function request(origin, { path = ack, method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(origin + path, { method, headers: { 'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', ...headers } }, res => {
      res.resume(); res.once('end', () => resolve(res.statusCode));
    }); req.once('error', reject); req.end();
  });
}
test('外部告警只可導向 ACK 登入文件；預設拒絕、其他請求仍拒絕', async t => {
  let calls = 0;
  const handle = (_req, res) => { calls++; send(res, 200, { page: 'login only' }); };
  const off = await serve(handle, { browser: true }); t.after(() => off.close());
  assert.equal(await request(off.origin), 403); assert.equal(calls, 0);
  const on = await serve(handle, { browser: true, ackNavigation: true }); t.after(() => on.close());
  assert.equal(await request(on.origin), 200); assert.equal(calls, 1);
  for (const input of [{ method: 'POST' }, { path: '/ack/verify' }, { path: '/api/operate' },
    { headers: { 'Sec-Fetch-Mode': 'cors' } }, { headers: { 'Sec-Fetch-Dest': 'iframe' } },
    { headers: { 'Sec-Fetch-Dest': 'image' } }, { headers: { Origin: 'https://mail.google.com' } }]) {
    assert.equal(await request(on.origin, input), 403);
  }
  assert.equal(calls, 1);
});
