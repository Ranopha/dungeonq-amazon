import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import { createLocalFixture } from '../server/local-fixture.mjs';
import { startWorkbench } from '../server/workbench.mjs';
import { createSocialOAuth } from '../server/social-oauth.mjs';
import { digest } from '../server/contracts.mjs';

const SESSION = '__Host-dq-session';
const VISIT = '__Host-dq-visit';
const FLOW = '__Host-dq-oauth';
const OAUTH_SECRET = 'synthetic-http-oauth-secret';
const PROVIDER_DETAIL = 'private-provider-error-token-and-password';
const random = () => randomBytes(32).toString('base64url');
const crossSite = { Origin: 'https://github.com', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' };

async function setup(t) {
  const fixture = await createLocalFixture();
  const providerCalls = []; let providerFailure = false; let subject = 76234; let clockOffset = 0;
  const identity = createSocialOAuth({ configuration: { github: { clientId: 'synthetic-http-client', clientSecret: OAUTH_SECRET } },
    application: fixture.core.application, local: fixture.core.local, clock: () => Date.now() + clockOffset }, {
    async fetch(url, options) {
      providerCalls.push({ url, options });
      assert.equal(options.redirect, 'error');
      if (providerFailure) throw new Error(PROVIDER_DETAIL);
      if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'synthetic_github_token', token_type: 'bearer' });
      if (url === 'https://api.github.com/user') return Response.json({ id: subject, login: 'mutable-http-fixture-login' });
      if (url === 'https://api.github.com/user/emails?per_page=100') return Response.json([{ email: 'owner@fixture.test', primary: true, verified: true }]);
      assert.fail('HTTP fixture must never request another provider endpoint');
    },
  });
  const web = await startWorkbench({ application: fixture.core.application, tls: fixture.tls, identity });
  t.after(async () => { await web.close(); identity.close(); await fixture.close(); });
  const jar = new Map();
  const call = (path, { method = 'GET', body, headers = {}, cookie } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(web.origin + path, { method, ca: fixture.tls.cert,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity('127.0.0.1', certificate),
      headers: { Cookie: cookie ?? [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
        ...(method === 'POST' ? { Origin: web.origin, 'Content-Type': 'application/json' } : {}),
        ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }), ...headers } }, response => {
      let text = ''; response.on('data', data => { text += data; }); response.on('end', () => {
        for (const value of response.headers['set-cookie'] ?? []) {
          const [pair] = value.split(';'); const position = pair.indexOf('=');
          if (pair.slice(position + 1)) jar.set(pair.slice(0, position), pair.slice(position + 1));
          else jar.delete(pair.slice(0, position));
        }
        let json; try { json = JSON.parse(text); } catch { /* Redirects intentionally have an empty body. */ }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.on('error', reject); req.end(payload);
  });
  const post = async (path, body, options = {}) => {
    const context = await call('/api/context');
    return call(path, { method: 'POST', body, ...options, headers: { 'X-DQ-CSRF': context.json.csrfToken, ...options.headers } });
  };
  const login = (member = { username: 'owner-lab', password: fixture.password }) => post('/api/login',
    { tenantId: 'tenant-lab', username: member.username, password: member.password });
  const intent = async () => {
    const result = await post('/api/intents', { password: fixture.password, purpose: 'MANAGE_EMAIL',
      manifestDigest: digest({ action: 'LINK_IDENTITY', provider: 'github' }) });
    assert.equal(result.status, 200); return result.json.intentToken;
  };
  const start = async (intentToken) => {
    const response = await post(intentToken === undefined ? '/api/identity/start' : '/api/identity/link',
      { provider: 'github', ...(intentToken === undefined ? {} : { intentToken }) });
    assert.equal(response.status, 200);
    const url = new URL(response.json.authorizationUrl);
    return { response, url, cookie: `${FLOW}=${jar.get(FLOW)}`,
      path: `/api/identity/callback?${new URLSearchParams({ state: url.searchParams.get('state'), code: 'synthetic-http-code' })}` };
  };
  const callback = flow => call(flow.path, { cookie: flow.cookie, headers: crossSite });
  return { fixture, identity, web, jar, call, post, login, intent, start, callback, providerCalls,
    failProvider(value = true) { providerFailure = value; }, changeSubject() { subject++; }, expireFlows() { clockOffset += 300001; } };
}

function rejectedCallback(response) {
  assert.equal(response.status, 303); assert.equal(response.headers.location, '/defense#identity-signin-failed');
  assert.equal(response.text, ''); assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  const cookies = response.headers['set-cookie'];
  assert.equal(cookies.length, 1); assert.match(cookies[0], /^__Host-dq-oauth=;.*SameSite=Lax; Max-Age=0/u);
  assert.doesNotMatch(JSON.stringify(response.headers) + response.text, /private-provider-error|synthetic-http-oauth-secret/u);
}

test('OAuth HTTP start 受 Origin／CSRF 保護；flow cookie Lax、visit/session Strict', async t => {
  const f = await setup(t);
  const providers = await f.call('/api/identity/providers'); assert.equal(providers.status, 200);
  assert.equal(providers.json.providers.find(provider => provider.id === 'github').enabled, true);
  assert.equal(providers.json.providers.find(provider => provider.id === 'google').enabled, false);
  assert.equal(providers.json.providers.find(provider => provider.id === 'apple').enabled, false);
  assert.doesNotMatch(providers.text, /clientSecret|synthetic-http-oauth-secret/u);
  const context = await f.call('/api/context');
  assert.match(context.headers['set-cookie'][0], /^__Host-dq-visit=.*Path=\/; Secure; HttpOnly; SameSite=Strict/u);
  assert.ok(f.jar.has(VISIT));
  assert.equal((await f.call('/api/identity/start', { method: 'POST', body: { provider: 'github' } })).json.error, 'CSRF_INVALID');
  assert.equal((await f.post('/api/identity/start', { provider: 'github' }, { headers: { Origin: 'https://other.fixture.test' } })).json.error, 'ORIGIN_DENIED');
  assert.equal((await f.post('/api/identity/start', { provider: 'github' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).json.error, 'FETCH_CONTEXT_DENIED');
  assert.equal((await f.post('/api/identity/start', { provider: 'github', clientSecret: 'request-cannot-configure' })).json.error, 'SCHEMA_INVALID');
  assert.equal((await f.call('/api/identity/providers', { headers: crossSite })).status, 403);
  const flow = await f.start();
  assert.equal(flow.url.origin, 'https://github.com'); assert.equal(flow.url.searchParams.get('scope'), 'user:email');
  assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(flow.url.searchParams.get('redirect_uri'), `${f.web.origin}/api/identity/callback`);
  assert.equal(flow.url.searchParams.has('client_secret'), false);
  assert.equal(flow.response.headers['set-cookie'].length, 1);
  assert.match(flow.response.headers['set-cookie'][0], /^__Host-dq-oauth=.*Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=300/u);
  assert.equal(f.providerCalls.length, 0);
  const login = await f.login(); assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'].find(value => value.startsWith(`${SESSION}=`)), /SameSite=Strict/u);
});

test('HTTP 連結需 Owner，完成時需 fresh 單次 intent；cross-site callback 使用原已保存 session', async t => {
  const f = await setup(t);
  assert.equal((await f.post('/api/identity/link', { provider: 'github', intentToken: random() })).status, 401);
  const auditor = f.fixture.members.find(member => member.role === 'AUDITOR'); await f.login(auditor);
  assert.equal((await f.post('/api/identity/link', { provider: 'github', intentToken: random() })).status, 403);
  await f.post('/api/logout', {}); await f.login();
  assert.equal((await f.post('/api/identity/link', { provider: 'github' })).json.error, 'SCHEMA_INVALID');
  assert.equal((await f.post('/api/identity/link', { provider: 'github', intentToken: random() }, { headers: { 'X-DQ-CSRF': '' } })).status, 403);
  assert.equal(f.providerCalls.length, 0);
  const invalidIntent = await f.start(random());
  // Starting a provider redirect does not consume/approve the intent; core verifies it on callback.
  rejectedCallback(await f.callback(invalidIntent));
  const ownerSession = f.jar.get(SESSION);
  assert.deepEqual(f.fixture.core.application.emailStatus(ownerSession).linkedIdentities, []);
  const intentToken = await f.intent(); const flow = await f.start(intentToken);
  const result = await f.callback(flow); assert.equal(result.status, 303); assert.equal(result.headers.location, '/defense');
  assert.equal(result.headers['set-cookie'].some(value => value.startsWith(`${SESSION}=`)), false);
  assert.equal(f.jar.get(SESSION), ownerSession);
  const status = f.fixture.core.application.emailStatus(ownerSession);
  assert.equal(status.linkedIdentities.length, 1); assert.equal(status.linkedIdentities[0].provider, 'github');
  assert.equal(status.linkedIdentities[0].mode, 'REAL_VERIFIED');
  const reused = await f.start(intentToken); rejectedCallback(await f.callback(reused));
  const evidence = f.fixture.core.application.evidence(ownerSession);
  assert.equal(evidence.events.filter(event => event.body.kind === 'SOCIAL_IDENTITY_LINKED').length, 1);
});

test('已連結身分跨站 HTTP 登入產生可使用 Strict session；重播與相同信箱的另一subject不得登入', async t => {
  const f = await setup(t); await f.login();
  const owner = (await f.call('/api/context')).json.state.principalId;
  const linked = await f.start(await f.intent()); assert.equal((await f.callback(linked)).headers.location, '/defense');
  await f.post('/api/logout', {});
  const flow = await f.start(); const result = await f.callback(flow);
  assert.equal(result.status, 303); assert.equal(result.headers.location, '/defense'); assert.equal(result.text, '');
  const sessionCookie = result.headers['set-cookie'].find(value => value.startsWith(`${SESSION}=`));
  assert.match(sessionCookie, /^__Host-dq-session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800$/u);
  assert.match(result.headers['set-cookie'].find(value => value.startsWith(`${FLOW}=`)), /SameSite=Lax; Max-Age=0/u);
  const context = await f.call('/api/context'); assert.equal(context.json.authenticated, true);
  assert.equal(context.json.state.principalId, owner); assert.equal(context.json.state.role, 'TENANT_SUPER_ADMIN');
  assert.equal((await f.call('/api/evidence')).status, 200);
  const requestCount = f.providerCalls.length; rejectedCallback(await f.callback(flow)); assert.equal(f.providerCalls.length, requestCount);
  assert.equal((await f.post('/api/logout', {})).status, 200);
  f.changeSubject(); const wrongIdentity = await f.start(); rejectedCallback(await f.callback(wrongIdentity));
  assert.equal((await f.call('/api/context')).json.authenticated, false);
});

test('HTTP callback 拒絕缺少/錯誤 state與cookie、重複query、過期與錯誤session，無 Provider I/O', async t => {
  const f = await setup(t);
  for (const kind of ['missing-cookie', 'wrong-cookie', 'missing-state', 'wrong-state', 'duplicate-state', 'duplicate-code', 'duplicate-cookie', 'unknown-query']) {
    const flow = await f.start(); let path = flow.path; let cookie = flow.cookie;
    if (kind === 'missing-cookie') cookie = '';
    else if (kind === 'wrong-cookie') cookie = `${FLOW}=${random()}`;
    else if (kind === 'missing-state') path = '/api/identity/callback?code=synthetic-code';
    else if (kind === 'wrong-state') path = `/api/identity/callback?state=${random()}&code=synthetic-code`;
    else if (kind === 'duplicate-state') path += `&state=${flow.url.searchParams.get('state')}`;
    else if (kind === 'duplicate-code') path += '&code=another-code';
    else if (kind === 'duplicate-cookie') cookie += `; ${cookie}`;
    else path += '&client_secret=must-not-be-accepted';
    rejectedCallback(await f.call(path, { cookie, headers: crossSite }));
  }
  const expired = await f.start(); f.expireFlows(); rejectedCallback(await f.callback(expired));
  assert.equal(f.providerCalls.length, 0);
  await f.login(); const linked = await f.start(await f.intent());
  rejectedCallback(await f.call(linked.path, { cookie: `${linked.cookie}; ${SESSION}=${random()}`, headers: crossSite }));
  assert.equal(f.providerCalls.length, 0);
  assert.equal((await f.call('/api/context')).json.authenticated, true);
});

test('Provider拒絕文字與內部例外不進入HTTP response；回呼失敗不建立session', async t => {
  const f = await setup(t); const declined = await f.start();
  const declinePath = `/api/identity/callback?${new URLSearchParams({ state: declined.url.searchParams.get('state'),
    error: 'access_denied', error_description: PROVIDER_DETAIL })}`;
  rejectedCallback(await f.call(declinePath, { cookie: declined.cookie, headers: crossSite }));
  assert.equal(f.providerCalls.length, 0); assert.equal(f.jar.has(SESSION), false);
  f.failProvider(); const unavailable = await f.start(); rejectedCallback(await f.callback(unavailable));
  assert.equal(f.providerCalls.length, 1); assert.equal(f.jar.has(SESSION), false);
  rejectedCallback(await f.callback(unavailable)); assert.equal(f.providerCalls.length, 1);
  assert.equal((await f.call('/api/context')).json.authenticated, false);
});
