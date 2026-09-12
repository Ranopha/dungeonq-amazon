import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { createLocalFixture } from '../server/local-fixture.mjs';
import { startWorkbench } from '../server/workbench.mjs';
import { digest } from '../server/contracts.mjs';
import { otpAt } from '../server/totp.mjs';

async function setup(t, override) {
  const fixture = await createLocalFixture();
  const web = await startWorkbench({ application: override ?? fixture.core.application, tls: fixture.tls });
  t.after(async () => { await web.close(); await fixture.close(); });
  const jar = new Map();
  const call = (path, { method = 'GET', body, headers = {}, raw, cookie } = {}) => new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = https.request(web.origin + path, { method, ca: fixture.tls.cert,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity('127.0.0.1', certificate),
      headers: { Cookie: cookie ?? [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(method === 'POST' ? { Origin: web.origin, 'Content-Type': 'application/json' } : {}),
        ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }), ...headers } }, response => {
      let text = ''; response.on('data', data => { text += data; }); response.on('end', () => {
        for (const value of response.headers['set-cookie'] ?? []) {
          const [pair] = value.split(';'); const pos = pair.indexOf('=');
          if (pair.slice(pos + 1)) jar.set(pair.slice(0, pos), pair.slice(pos + 1)); else jar.delete(pair.slice(0, pos));
        }
        let json; try { json = JSON.parse(text); } catch { /* 靜態資產 */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    }); req.on('error', reject); req.end(payload);
  });
  const post = async (path, body, options = {}) => {
    const context = await call('/api/context');
    return call(path, { method: 'POST', body, ...options, headers: { 'X-DQ-CSRF': context.json.csrfToken, ...options.headers } });
  };
  const login = () => post('/api/login', { tenantId: 'tenant-lab', username: 'owner-lab', password: fixture.password });
  return { fixture, web, call, post, login, jar };
}

test('HTTPS 選配 TOTP 綁定 CSRF 與意圖；啟用後密碼不得降級，Owner 才能讀通知', async t => {
  const f = await setup(t); await f.login();
  const state = (await f.call('/api/context')).json.state;
  assert.equal((await f.post('/api/totp/begin', { intentToken: 'x'.repeat(43) }, { headers: { 'X-DQ-CSRF': '' } })).status, 403);
  const intent = await f.post('/api/intents', { password: f.fixture.password, purpose: 'ENROLL_TOTP',
    manifestDigest: digest({ tenantId: state.tenantId, principalId: state.principalId, action: 'ENROLL_TOTP' }) });
  const start = await f.post('/api/totp/begin', { intentToken: intent.json.intentToken }); assert.equal(start.status, 200);
  assert.equal((await f.post('/api/totp/begin', { intentToken: intent.json.intentToken })).json.error, 'INTENT_INVALID');
  const bits = [...start.json.secret].map(c => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')).join('');
  const seed = Buffer.from(bits.match(/.{8}/gu).map(byte => parseInt(byte, 2)));
  const step = Math.floor(Date.now() / 30000);
  assert.equal((await f.post('/api/totp/confirm', { otp: otpAt(seed, step) })).status, 200);
  assert.equal((await f.call('/api/context')).json.authenticated, false);
  assert.equal((await f.login()).status, 401);
  const login = await f.post('/api/login', { tenantId: 'tenant-lab', username: 'owner-lab', password: f.fixture.password, otp: otpAt(seed, step + 1) });
  assert.equal(login.status, 200); assert.equal(login.json.principal.authentication, 'PASSWORD_TOTP');
  assert.ok((await f.call('/api/notifications')).json.some(n => n.status === 'PENDING'));
  await f.post('/api/logout', {});
  const auditor = f.fixture.members.find(m => m.role === 'AUDITOR');
  assert.equal((await f.post('/api/login', { tenantId: 'tenant-lab', username: auditor.username, password: auditor.password })).status, 200);
  assert.equal((await f.call('/api/notifications')).status, 403);
  assert.equal((await f.post('/api/notifications/send', {})).status, 404);
});
function draft(state) {
  return { schemaVersion: 'dungeonq.lab-grant-draft/v1', tenantId: state.tenantId, profile: 'SYNTHETIC_ONLY',
    assetIds: ['api-orders'], effect: 'SYNTHETIC_CONTAINMENT', connectorVersion: 'sqlite-fixture/v1', runbookVersion: 'containment/v1',
    dependencyDigest: digest({ tenantId: state.tenantId, assetIds: ['api-orders'], connectorVersion: 'sqlite-fixture/v1' }),
    expiresAt: state.serverNow + 3_600_000, maxEffects: 1, maxConcurrent: 1, leaseMs: 300_000 };
}

test('HTTPS 密碼登入、HttpOnly Session、Scope 預覽、重驗發布與撤銷可讀回', async t => {
  const f = await setup(t);
  const login = await f.login(); assert.equal(login.status, 200);
  assert.equal(login.json.sessionToken, undefined);
  const cookie = login.headers['set-cookie'][0];
  assert.match(cookie, /^__Host-dq-session=/u);
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(flag));
  assert.ok(!cookie.includes('Domain='));
  const context = await f.call('/api/context'); assert.equal(context.json.authenticated, true);
  const preview = await f.post('/api/grants/preview', draft(context.json.state)); assert.equal(preview.status, 200);
  const intent = await f.post('/api/intents', { password: f.fixture.password, purpose: 'PUBLISH_GRANT', manifestDigest: preview.json.digest });
  const body = { draft: preview.json.draft, intentToken: intent.json.intentToken };
  assert.equal((await f.post('/api/grants/publish', body)).status, 200);
  assert.equal((await f.post('/api/grants/publish', body)).json.error, 'INTENT_INVALID');
  assert.equal((await f.call('/api/context')).json.state.grants[0].state, 'ACTIVE');
  const revoke = await f.post('/api/intents', { password: f.fixture.password, purpose: 'REVOKE_GRANTS',
    manifestDigest: digest({ tenantId: 'tenant-lab', action: 'REVOKE_GRANTS' }) });
  assert.equal((await f.post('/api/grants/revoke', { intentToken: revoke.json.intentToken })).status, 200);
  assert.equal((await f.call('/api/context')).json.state.grants[0].state, 'REVOKED');
  assert.ok((await f.call('/api/evidence')).json.events.some(event => event.body.kind === 'GRANT_PUBLISHED'));
  const oldCookie = `__Host-dq-session=${f.jar.get('__Host-dq-session')}`;
  assert.equal((await f.post('/api/logout', {})).status, 200);
  assert.equal((await f.call('/api/evidence', { cookie: oldCookie })).status, 401);
});

test('拒絕跨 Origin／Host／Fetch Metadata、缺失或跨 Session 的 CSRF', async t => {
  const f = await setup(t);
  assert.equal((await f.call('/api/context', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await f.call('/api/context', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.call('/api/context', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const body = { tenantId: 'tenant-lab', username: 'owner-lab', password: f.fixture.password };
  assert.equal((await f.call('/api/login', { method: 'POST', body })).json.error, 'CSRF_INVALID');
  const first = await f.call('/api/context');
  const old = first.json.csrfToken;
  await f.call('/api/context');
  assert.equal((await f.call('/api/login', { method: 'POST', body, headers: { 'X-DQ-CSRF': old } })).json.error, 'CSRF_INVALID');
  await f.login();
  assert.equal((await f.post('/api/logout', {}, { headers: { Origin: '' } })).status, 403);
  assert.equal((await f.post('/api/logout', {}, { headers: { 'X-DQ-CSRF': old } })).json.error, 'CSRF_INVALID');
  assert.equal((await f.call('/api/context')).json.authenticated, true);
});

test('閉合路由、JSON 類型、大小、Cookie 重複、錯誤封裝與無 CORS', async t => {
  const f = await setup(t);
  for (const path of ['/api/bootstrap', '/api/local', '/api/claim', '/api/apply', '/server/governance.mjs', '/api/context?actorType=HUMAN']) {
    assert.equal((await f.call(path)).status, 404);
  }
  assert.equal((await f.call('/api/login')).status, 405);
  assert.equal((await f.call('/api/evidence')).status, 401);
  const text = await f.post('/api/login', {}, { headers: { 'Content-Type': 'text/plain' } }); assert.equal(text.status, 415);
  assert.equal((await f.post('/api/login', {}, { raw: '!' })).json.error, 'JSON_INVALID');
  assert.equal((await f.post('/api/login', {}, { raw: 'x'.repeat(17_000) })).status, 413);
  assert.equal((await f.post('/api/login', { actorType: 'HUMAN' })).json.error, 'SCHEMA_INVALID');
  const cookie = '__Host-dq-visit=' + 'a'.repeat(43);
  assert.equal((await f.call('/api/context', { cookie: `${cookie}; ${cookie}` })).json.error, 'COOKIE_INVALID');
  const page = await f.call('/'); assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/u);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['access-control-allow-origin'], undefined);
  assert.ok(!page.text.includes(f.fixture.password));
});

test('底層例外不洩漏路徑／SQL／stack，UI 無權威 Token 儲存或動態 HTML sink', async t => {
  const f = await setup(t, { status: () => { throw new Error('SQL private internal path'); } });
  const response = await f.call('/api/context', { cookie: '__Host-dq-session=' + 'a'.repeat(43) });
  assert.equal(response.status, 503); assert.equal(response.json.error, 'SERVICE_UNAVAILABLE');
  assert.ok(!response.text.includes('SQL')); assert.ok(!response.text.includes('stack'));
  const ui = await f.call('/workbench.mjs');
  assert.doesNotMatch(ui.text, /localStorage|sessionStorage|\.innerHTML|document\.cookie|\beval\(/u);
});

test('HTTPS 離線恢復：綁定訪客 CSRF、不自動登入、舊 Session／密碼／Codes 失效', async t => {
  const f = await setup(t); await f.login();
  const state = (await f.call('/api/context')).json.state;
  const preview = await f.post('/api/grants/preview', draft(state));
  const grantIntent = await f.post('/api/intents', { password: f.fixture.password, purpose: 'PUBLISH_GRANT', manifestDigest: preview.json.digest });
  await f.post('/api/grants/publish', { draft: preview.json.draft, intentToken: grantIntent.json.intentToken });
  const intent = await f.post('/api/intents', { password: f.fixture.password, purpose: 'RENEW_RECOVERY',
    manifestDigest: digest({ tenantId: state.tenantId, principalId: state.principalId, action: 'RENEW_RECOVERY' }) });
  const codes = await f.post('/api/recovery/renew', { intentToken: intent.json.intentToken });
  assert.equal(codes.status, 200); assert.equal(codes.json.recoveryCodes.length, 8);
  assert.equal((await f.post('/api/recovery/renew', { intentToken: intent.json.intentToken })).json.error, 'INTENT_INVALID');
  const body = { tenantId: state.tenantId, username: 'owner-lab', recoveryCode: codes.json.recoveryCodes[0], newPassword: '合成新的登入密碼-orbit-754' };
  assert.equal((await f.post('/api/recover', body)).json.error, 'LOGOUT_REQUIRED');
  await f.post('/api/logout', {});
  await f.login();
  const oldCookie = `__Host-dq-session=${f.jar.get('__Host-dq-session')}`;
  // 模擬另一個未登入的瀏覽器；保留此登入在 Server 有效，讓恢復而非 logout 負責撤銷。
  f.jar.delete('__Host-dq-session');
  assert.equal((await f.call('/api/recover', { method: 'POST', body })).json.error, 'CSRF_INVALID');
  assert.equal((await f.post('/api/recover', body, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const result = await f.post('/api/recover', body); assert.equal(result.status, 200);
  assert.equal(result.json.grantsRevoked, true); assert.equal(result.json.notification, 'NOT_CONFIGURED');
  assert.ok(!result.headers['set-cookie'].some(value => value.startsWith('__Host-dq-session=')));
  assert.equal((await f.call('/api/context')).json.authenticated, false);
  assert.equal((await f.call('/api/evidence', { cookie: oldCookie })).status, 401);
  assert.equal((await f.post('/api/recover', body)).json.error, 'RECOVERY_FAILED');
  assert.equal((await f.login()).status, 401);
  assert.equal((await f.post('/api/login', { tenantId: state.tenantId, username: 'owner-lab', password: body.newPassword })).status, 200);
  assert.equal((await f.call('/api/context')).json.state.grants[0].state, 'REVOKED');
});

test('HTTPS 角色由 Server 決定，隱藏按鈕以外的直接越權亦遭拒絕', async t => {
  const f = await setup(t);
  for (const member of f.fixture.members) {
    const result = await f.post('/api/login', { tenantId: 'tenant-lab', username: member.username, password: member.password });
    assert.equal(result.json.principal.role, member.role);
    const state = (await f.call('/api/context')).json.state;
    const preview = await f.post('/api/grants/preview', draft(state));
    assert.equal(preview.status, member.role === 'AUDITOR' ? 403 : 200);
    assert.equal((await f.post('/api/intents', { password: member.password, purpose: 'PUBLISH_GRANT', manifestDigest: digest(draft(state)) })).status, 403);
    assert.equal((await f.post('/api/grants/publish', { draft: draft(state), intentToken: 'a'.repeat(43) })).status, 403);
    assert.equal((await f.post('/api/grants/revoke', { intentToken: 'a'.repeat(43) })).status, 403);
    assert.equal((await f.call('/api/evidence')).status, 200);
    await f.post('/api/logout', {});
  }
  for (const path of ['/api/members', '/api/provisionMember', '/api/disableMember']) assert.equal((await f.post(path, {})).status, 404);
});

test('HTTPS 新增成員與本人設定密碼閉環；名單及直接 apply 不可越權／跳過 CSRF', async t => {
  const f = await setup(t); await f.login();
  const input = { schemaVersion: 'dungeonq.lab-member-change/v1', tenantId: 'tenant-lab', username: 'member-web',
    action: 'CREATE', role: 'REVIEWER', expectedEpoch: 0 };
  const preview = await f.post('/api/members/preview', input); assert.equal(preview.status, 200);
  const intent = await f.post('/api/intents', { password: f.fixture.password, purpose: 'MANAGE_MEMBERS', manifestDigest: preview.json.digest });
  const body = { draft: preview.json.draft, intentToken: intent.json.intentToken };
  assert.equal((await f.call('/api/members/apply', { method: 'POST', body })).json.error, 'CSRF_INVALID');
  const result = await f.post('/api/members/apply', body); assert.equal(result.status, 200); assert.equal(result.json.state, 'SETUP_PENDING');
  const list = await f.call('/api/members'); assert.equal(list.json.find(x => x.username === input.username).state, 'SETUP_PENDING');
  assert.ok(!list.text.includes(result.json.setupCode)); assert.equal((await f.post('/api/members/apply', body)).json.error, 'MEMBER_EXISTS');
  await f.post('/api/logout', {});
  const password = '合成網頁成員自己的密碼-8274';
  assert.equal((await f.post('/api/recover', { tenantId: input.tenantId, username: input.username, recoveryCode: result.json.setupCode, newPassword: password })).status, 200);
  assert.equal((await f.post('/api/login', { tenantId: input.tenantId, username: input.username, password })).status, 200);
  assert.equal((await f.call('/api/context')).json.state.role, 'REVIEWER');
  assert.equal((await f.call('/api/members')).status, 403);
  assert.equal((await f.post('/api/members/apply', body)).status, 403);
  assert.equal((await f.post('/api/members/preview', input)).status, 403);
  assert.equal((await f.post('/api/intents', { password, purpose: 'MANAGE_MEMBERS', manifestDigest: preview.json.digest })).status, 403);
});
