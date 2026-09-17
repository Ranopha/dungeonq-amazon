import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { createLocalFixture } from '../server/local-fixture.mjs';
import { startWorkbench } from '../server/workbench.mjs';

async function setup(t, { enabled = true } = {}) {
  const fixture = await createLocalFixture();
  const effects = [];
  const state = { incidents: [], requests: [] };
  const lab = { profile: 'SYNTHETIC_ONLY', campaigns: [], resource: { assetId: 'api-orders', generation: 0 },
    notificationChannel: 'LOCAL_SINK_ONLY', runtimeIsolation: 'NOT_PRODUCTION_ISOLATION', limitation: 'Local reference only.' };
  const application = { ...fixture.core.application, rotationStatus: session => { fixture.core.application.status(session); return state; },
    approveRotation: (session, body) => { fixture.core.application.status(session); effects.push(['approve', body]); return { state: 'APPROVED' }; },
    refreshRotation: (session, body) => { fixture.core.application.status(session); effects.push(['refresh', body]); return { requestId: body.requestId, state: 'AWAITING_HUMAN' }; } };
  const defense = { status: async () => lab, runRotation: async requestId => { effects.push(['apply', requestId]); return { state: 'COMPLETED' }; },
    reconcileRotation: async requestId => { effects.push(['reconcile', requestId]); return { state: 'COMPLETED' }; } };
  const web = await startWorkbench({ application, tls: fixture.tls, ...(enabled ? { defense } : {}) });
  t.after(async () => { await web.close(); await fixture.close(); });
  const jar = new Map();
  const call = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = https.request(web.origin + path, { method, ca: fixture.tls.cert,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity('127.0.0.1', certificate),
      headers: { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(method === 'POST' ? { Origin: web.origin, 'Content-Type': 'application/json' } : {}),
        ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }), ...headers } }, response => {
      let text = ''; response.on('data', data => { text += data; }); response.on('end', () => {
        for (const value of response.headers['set-cookie'] ?? []) {
          const [pair] = value.split(';'); const position = pair.indexOf('=');
          if (pair.slice(position + 1)) jar.set(pair.slice(0, position), pair.slice(position + 1)); else jar.delete(pair.slice(0, position));
        }
        let json; try { json = JSON.parse(text); } catch { /* 靜態資產 */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    }); request.on('error', reject); request.end(payload);
  });
  const post = async (path, body, headers) => {
    const context = await call('/api/context');
    return call(path, { method: 'POST', body, headers: { 'X-DQ-CSRF': context.json.csrfToken, ...headers } });
  };
  const login = member => post('/api/login', { tenantId: member?.tenantId ?? 'tenant-lab', username: member?.username ?? 'owner-lab', password: member?.password ?? fixture.password });
  return { fixture, effects, state, lab, defense, call, post, login };
}

test('Defense optional路徑未啟動時閉合，啟動後靜態頁沒有合成密碼', async t => {
  const disabled = await setup(t, { enabled: false });
  for (const path of ['/defense', '/defense.mjs', '/defense.css', '/api/defense/status']) assert.equal((await disabled.call(path)).status, 404);
  assert.equal((await disabled.post('/api/defense/apply', { requestId: 'rotation-1' })).status, 404);
  const active = await setup(t);
  for (const path of ['/defense', '/defense.mjs', '/defense.css']) {
    const response = await active.call(path); assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(!response.text.includes(active.fixture.password));
    assert.match(response.headers['content-security-policy'], /script-src 'self'/u);
  }
  assert.equal((await active.call('/api/defense/status')).status, 401);
  assert.equal((await active.call('/workbench.mjs')).status, 200);
});

test('Defense固定tenant，Owner可讀通知，其他角色可讀狀態但不能核准或執行', async t => {
  const f = await setup(t); await f.login();
  const owner = await f.call('/api/defense/status');
  assert.equal(owner.status, 200); assert.deepEqual(owner.json.lab, f.lab); assert.deepEqual(owner.json.notifications, []);
  await f.post('/api/logout', {});
  for (const member of f.fixture.members) {
    assert.equal((await f.login(member)).status, 200);
    const view = await f.call('/api/defense/status'); assert.equal(view.status, 200); assert.equal(view.json.notifications, null);
    assert.equal((await f.post('/api/defense/approve', { requestId: 'rotation-1', manifestDigest: 'a'.repeat(64), intentToken: 'a'.repeat(43) })).status, 403);
    assert.equal((await f.post('/api/defense/apply', { requestId: 'rotation-1' })).status, 403);
    assert.equal((await f.post('/api/defense/reconcile', { requestId: 'rotation-1' })).status, 403);
    assert.equal((await f.post('/api/defense/refresh', { requestId: 'rotation-1' })).status, 403);
    await f.post('/api/logout', {});
  }
  await f.fixture.core.local.bootstrap({ tenantId: 'tenant-other', username: 'owner-other', password: 'synthetic-other-password-938', assetIds: ['api-orders'] });
  await f.login({ tenantId: 'tenant-other', username: 'owner-other', password: 'synthetic-other-password-938' });
  assert.equal((await f.call('/api/defense/status')).status, 403);
  assert.equal((await f.post('/api/defense/apply', { requestId: 'rotation-1' })).status, 403);
  assert.equal(f.effects.length, 0);
});

test('Defense沿既有CSRF/Origin/Host與exact schema，approve不自動執行', async t => {
  const f = await setup(t); await f.login();
  const approve = { requestId: 'rotation-1', manifestDigest: 'a'.repeat(64), intentToken: 'a'.repeat(43) };
  assert.equal((await f.post('/api/defense/approve', approve, { 'X-DQ-CSRF': '' })).status, 403);
  assert.equal((await f.post('/api/defense/apply', { requestId: 'rotation-1' }, { Origin: 'https://wrong.example' })).status, 403);
  assert.equal((await f.call('/api/defense/status', { headers: { Host: 'wrong.example' } })).status, 403);
  assert.equal((await f.post('/api/defense/apply', { requestId: 'rotation-1', authority: 'HUMAN' })).json.error, 'SCHEMA_INVALID');
  assert.equal((await f.post('/api/defense/apply', { requestId: '../rotation' })).json.error, 'SCHEMA_INVALID');
  assert.equal((await f.post('/api/defense/approve', { ...approve, role: 'TENANT_SUPER_ADMIN' })).json.error, 'SCHEMA_INVALID');
  assert.equal((await f.call('/api/defense/apply')).status, 405);
  assert.equal((await f.post('/api/defense/approve', approve)).status, 200);
  assert.deepEqual(f.effects, [['approve', approve]]);
  assert.equal((await f.post('/api/defense/apply', { requestId: 'rotation-1' })).status, 200);
  assert.deepEqual(f.effects[1], ['apply', 'rotation-1']);
  assert.equal((await f.post('/api/defense/reconcile', { requestId: 'rotation-1' })).status, 200);
  assert.deepEqual(f.effects[2], ['reconcile', 'rotation-1']);
  assert.equal((await f.post('/api/defense/refresh', { requestId: 'rotation-1' })).status, 200);
  assert.deepEqual(f.effects[3], ['refresh', { requestId: 'rotation-1' }]);
  f.defense.runRotation = async () => { throw new Error('private SQL issuer password'); };
  const failure = await f.post('/api/defense/apply', { requestId: 'rotation-1' });
  assert.equal(failure.status, 503); assert.equal(failure.json.error, 'SERVICE_UNAVAILABLE');
  assert.doesNotMatch(failure.text, /private|SQL|password/u);
});
