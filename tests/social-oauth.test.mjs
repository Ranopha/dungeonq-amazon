import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, chmod, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createSocialOAuth, loadOAuthConfigFile, verifiedGoogleIdentity } from '../server/social-oauth.mjs';

// All keys, identities, HTTP replies and credentials below are local fixtures.
// No provider request or real-account sign-in occurs in this suite.
const NOW = Date.UTC(2026, 8, 17, 0, 0, 0);
const origin = 'https://127.0.0.1:4196';
const supplied = { google: { clientId: 'google-fixture-client', clientSecret: 'google-fixture-secret' },
  github: { clientId: 'github-fixture-client', clientSecret: 'github-fixture-secret' } };
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GITHUB_TOKEN = 'https://github.com/login/oauth/access_token';
const GITHUB_USER = 'https://api.github.com/user';
const GITHUB_EMAILS = 'https://api.github.com/user/emails?per_page=100';
let signer; let otherSigner; let keyResolver;

before(async () => {
  const pair = await generateKeyPair('RS256'); signer = pair.privateKey;
  otherSigner = (await generateKeyPair('RS256')).privateKey;
  keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }] });
});

async function signed(nonce, overrides = {}, key = signer) {
  return new SignJWT({ iss: 'https://accounts.google.com', aud: supplied.google.clientId,
    sub: 'google-immutable-subject-41', email: 'owner@fixture.test', email_verified: true, nonce,
    iat: NOW / 1000, exp: NOW / 1000 + 300, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).sign(key);
}

function fixture(t, options = {}) {
  let now = NOW; let authorization;
  const calls = []; const logins = []; const links = []; const statuses = [];
  const local = {
    async loginExternalIdentity(identity) {
      logins.push(identity); if (options.loginError) throw Object.assign(new Error(options.loginError), { code: options.loginError });
      return { sessionToken: 'previously-linked-account-session' };
    },
    linkExternalIdentity(sessionToken, identity) { links.push({ sessionToken, identity }); return { linked: true, provider: identity.provider }; },
    bootstrap() { assert.fail('OAuth must not bootstrap an Owner'); },
  };
  const application = { status(sessionToken) { statuses.push(sessionToken); return { capabilities: options.capabilities ?? ['MANAGE_EMAIL'] }; } };
  const fetcher = async (url, request) => {
    calls.push({ url, request });
    if (options.responses?.[url]) return options.responses[url](request);
    if (url === GOOGLE_TOKEN) return Response.json({ id_token: await signed(authorization.searchParams.get('nonce'), options.googleClaims),
      access_token: 'unused-google-access-token', refresh_token: 'unused-google-refresh-token' });
    if (url === GITHUB_TOKEN) return Response.json({ access_token: 'github_fixture_token', token_type: 'bearer' });
    if (url === GITHUB_USER) return Response.json({ id: 4312, login: 'mutable-display-name', email: 'unverified@fixture.test' });
    if (url === GITHUB_EMAILS) return Response.json([{ email: 'other@fixture.test', primary: false, verified: true },
      { email: 'owner@fixture.test', primary: true, verified: true }]);
    throw new Error('Unexpected fixture URL');
  };
  const oauth = createSocialOAuth({ configuration: options.configuration ?? supplied, local, application, clock: () => now },
    { fetch: fetcher, googleKeys: keyResolver });
  t.after(() => oauth.close());
  return { oauth, calls, logins, links, statuses, setTime(value) { now = value; },
    get authorization() { return authorization; },
    start(provider = 'google', extra = {}) {
      const cookie = randomBytes(32).toString('base64url');
      authorization = new URL(oauth.start({ provider, origin, cookie, ...extra }).authorizationUrl);
      return { state: authorization.searchParams.get('state'), code: 'synthetic-authorization-code', cookie };
    } };
}

test('Google 使用本機公鑰驗證 RS256，輸出僅含固定身分資料', async () => {
  const options = { clientId: supplied.google.clientId, nonce: 'bound-nonce', keyResolver, currentDate: new Date(NOW) };
  for (const iss of ['https://accounts.google.com', 'accounts.google.com']) {
    const identity = await verifiedGoogleIdentity(await signed(options.nonce, { iss }), options);
    assert.deepEqual(identity, { provider: 'google', subject: 'google-immutable-subject-41', email: 'owner@fixture.test', mode: 'REAL_VERIFIED' });
  }
  assert.equal((await verifiedGoogleIdentity(await signed(options.nonce, { aud: [supplied.google.clientId], azp: supplied.google.clientId }), options)).provider, 'google');
});

test('Google 拒絕簽章、issuer、audience、nonce、未驗證信箱與時間不符', async t => {
  const options = { clientId: supplied.google.clientId, nonce: 'bound-nonce', keyResolver, currentDate: new Date(NOW) };
  const cases = [
    ['issuer', { iss: 'https://other.fixture.test' }], ['audience', { aud: 'other-fixture-client' }],
    ['nonce', { nonce: 'different-nonce' }], ['unverified email', { email_verified: false }],
    ['string verified flag', { email_verified: 'true' }], ['expired', { exp: NOW / 1000 - 60 }],
    ['too old', { iat: NOW / 1000 - 700 }], ['future issued', { iat: NOW / 1000 + 60 }],
    ['missing expiry', { exp: undefined }], ['missing nonce', { nonce: undefined }],
    ['missing email', { email: undefined }], ['nonstring email', { email: { address: 'owner@fixture.test' } }],
    ['display name', { email: 'Owner <owner@fixture.test>' }], ['email newline', { email: 'owner@fixture.test\nother' }],
    ['empty subject', { sub: '' }], ['nonstring subject', { sub: 4312 }], ['wrong azp', { azp: 'another-client' }],
    ['empty azp', { azp: '' }], ['false azp', { azp: false }],
    ['multiple audiences', { aud: [supplied.google.clientId, 'another-client'] }],
  ];
  for (const [label, claims] of cases) await t.test(label, async () => {
    await assert.rejects(verifiedGoogleIdentity(await signed(options.nonce, claims), options), { message: 'OAUTH_IDENTITY_REJECTED' });
  });
  await assert.rejects(verifiedGoogleIdentity(await signed(options.nonce, {}, otherSigner), options), { code: 'OAUTH_IDENTITY_REJECTED' });
  const hsToken = await new SignJWT({ sub: 'local-fixture' }).setProtectedHeader({ alg: 'HS256' }).sign(randomBytes(32));
  await assert.rejects(verifiedGoogleIdentity(hsToken, options), { code: 'OAUTH_IDENTITY_REJECTED' });
});

test('Google 最小 scope、nonce 與 PKCE綁定交換，不回傳 token／secret', async t => {
  const f = fixture(t); const callback = f.start(); const url = f.authorization;
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), 'openid email');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('nonce'), /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(url.searchParams.get('redirect_uri'), `${origin}/api/identity/callback`);
  assert.equal(url.searchParams.has('client_secret'), false); assert.equal(url.searchParams.has('access_type'), false);
  const result = await f.oauth.callback(callback);
  assert.deepEqual(result, { linked: false, session: { sessionToken: 'previously-linked-account-session' } });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, GOOGLE_TOKEN);
  const request = f.calls[0].request; const body = new URLSearchParams(request.body);
  assert.equal(request.method, 'POST'); assert.equal(request.redirect, 'error'); assert.ok(request.signal instanceof AbortSignal);
  assert.equal(body.get('client_secret'), supplied.google.clientSecret);
  assert.equal(body.get('redirect_uri'), url.searchParams.get('redirect_uri'));
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'));
  assert.equal(f.logins.length, 1); assert.equal(f.links.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /clientSecret|fixture-secret|refresh_token|access_token|id_token/u);
});

test('Google callback 的 JWT 過期採用注入時間，拒絕前不呼叫身分 handle', async t => {
  const f = fixture(t, { googleClaims: { exp: NOW / 1000 + 30 } }); const callback = f.start(); f.setTime(NOW + 60_000);
  await assert.rejects(f.oauth.callback(callback), { code: 'OAUTH_IDENTITY_REJECTED' });
  assert.equal(f.logins.length, 0); assert.equal(f.links.length, 0);
});

test('state／cookie不符、過期、錯誤 code、重播均拒絕且不新增 Provider I/O', async t => {
  const f = fixture(t); const callback = f.start();
  for (const invalid of [{ ...callback, state: 'invalid' }, { ...callback, state: randomBytes(32).toString('base64url') },
    { ...callback, cookie: randomBytes(32).toString('base64url') }]) await assert.rejects(f.oauth.callback(invalid), { code: 'OAUTH_STATE_INVALID' });
  assert.equal(f.calls.length, 0);
  await f.oauth.callback(callback); assert.equal(f.calls.length, 1);
  await assert.rejects(f.oauth.callback(callback), { code: 'OAUTH_STATE_INVALID' }); assert.equal(f.calls.length, 1);
  const expired = f.start(); f.setTime(NOW + 300_000);
  await assert.rejects(f.oauth.callback(expired), { code: 'OAUTH_STATE_INVALID' }); assert.equal(f.calls.length, 1);
  const badCode = f.start();
  await assert.rejects(f.oauth.callback({ ...badCode, code: 'bad\ncode' }), { code: 'OAUTH_CODE_INVALID' });
  await assert.rejects(f.oauth.callback(badCode), { code: 'OAUTH_STATE_INVALID' }); assert.equal(f.calls.length, 1);
});

test('並行 callback 在 Provider await前消耗 state，只有一次交換', async t => {
  let release; const waiting = new Promise(resolve => { release = resolve; }); let nonce;
  const f = fixture(t, { responses: { [GOOGLE_TOKEN]: async () => { await waiting; return Response.json({ id_token: await signed(nonce) }); } } });
  const callback = f.start(); nonce = f.authorization.searchParams.get('nonce');
  const first = f.oauth.callback(callback);
  await assert.rejects(f.oauth.callback(callback), { code: 'OAUTH_STATE_INVALID' });
  assert.equal(f.calls.length, 1); release(); await first; assert.equal(f.logins.length, 1);
});

test('跨站連結 callback 可沒有 Strict session cookie，仍只使用已保存 Owner session', async t => {
  const f = fixture(t); const callback = f.start('google', { sessionToken: 'original-owner-session', intentToken: 'fresh-link-intent' });
  const result = await f.oauth.callback(callback);
  assert.equal(result.linked, true); assert.deepEqual(f.statuses, ['original-owner-session']);
  assert.equal(f.logins.length, 0); assert.equal(f.links.length, 1);
  assert.equal(f.links[0].sessionToken, 'original-owner-session'); assert.equal(f.links[0].identity.intentToken, 'fresh-link-intent');
  const other = f.start('google', { sessionToken: 'original-owner-session', intentToken: 'fresh-link-intent' });
  await assert.rejects(f.oauth.callback({ ...other, sessionToken: 'different-session' }), { code: 'OAUTH_STATE_INVALID' });
  assert.equal(f.calls.length, 1); assert.equal(f.links.length, 1);
});

test('信箱文字相同不自行建立 Owner／連結；未知 subject 交由 local拒絕', async t => {
  const f = fixture(t, { loginError: 'EXTERNAL_IDENTITY_NOT_LINKED' }); const callback = f.start();
  await assert.rejects(f.oauth.callback(callback), { code: 'EXTERNAL_IDENTITY_NOT_LINKED' });
  assert.equal(f.logins.length, 1); assert.equal(f.logins[0].email, 'owner@fixture.test');
  assert.equal(f.logins[0].subject, 'google-immutable-subject-41'); assert.equal(f.links.length, 0); assert.equal(f.statuses.length, 0);
  const denied = fixture(t, { capabilities: [] });
  assert.throws(() => denied.start('google', { sessionToken: 'low-role-session', intentToken: 'anything' }), { code: 'PERMISSION_DENIED' });
  assert.equal(denied.calls.length, 0);
});

test('GitHub 只用 verified primary email與不可變 numeric id，不用顯示名稱授權', async t => {
  const f = fixture(t); const callback = f.start('github');
  assert.equal(f.authorization.searchParams.get('scope'), 'user:email'); assert.equal(f.authorization.searchParams.get('allow_signup'), 'false');
  assert.equal(f.authorization.searchParams.get('code_challenge_method'), 'S256');
  await f.oauth.callback(callback);
  assert.deepEqual(f.calls.map(call => call.url), [GITHUB_TOKEN, GITHUB_USER, GITHUB_EMAILS]);
  assert.deepEqual(f.logins, [{ provider: 'github', subject: '4312', email: 'owner@fixture.test', mode: 'REAL_VERIFIED' }]);
  for (const call of f.calls.slice(1)) {
    assert.equal(call.request.headers.Authorization, 'Bearer github_fixture_token'); assert.equal(call.request.redirect, 'error');
  }
  const body = new URLSearchParams(f.calls[0].request.body);
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), f.authorization.searchParams.get('code_challenge'));
});

test('GitHub 缺唯一 verified primary、錯誤 ID／email／bearer token時不呼叫身分 handle', async t => {
  const cases = [
    ['unverified', GITHUB_EMAILS, [{ email: 'owner@fixture.test', primary: true, verified: false }], 'OAUTH_VERIFIED_EMAIL_REQUIRED'],
    ['secondary', GITHUB_EMAILS, [{ email: 'owner@fixture.test', primary: false, verified: true }], 'OAUTH_VERIFIED_EMAIL_REQUIRED'],
    ['two primary', GITHUB_EMAILS, [{ email: 'a@fixture.test', primary: true, verified: true },
      { email: 'b@fixture.test', primary: true, verified: true }], 'OAUTH_VERIFIED_EMAIL_REQUIRED'],
    ['noninteger id', GITHUB_USER, { id: '4312' }, 'OAUTH_IDENTITY_REJECTED'],
    ['unsafe integer', GITHUB_USER, { id: Number.MAX_SAFE_INTEGER + 1 }, 'OAUTH_IDENTITY_REJECTED'],
    ['zero id', GITHUB_USER, { id: 0 }, 'OAUTH_IDENTITY_REJECTED'],
    ['bad email', GITHUB_EMAILS, [{ email: ['owner@fixture.test'], primary: true, verified: true }], 'OAUTH_IDENTITY_REJECTED'],
    ['header token', GITHUB_TOKEN, { access_token: 'token\r\nother', token_type: 'bearer' }, 'OAUTH_IDENTITY_REJECTED'],
  ];
  for (const [label, url, reply, code] of cases) await t.test(label, async t => {
    const f = fixture(t, { responses: { [url]: () => Response.json(reply) } });
    await assert.rejects(f.oauth.callback(f.start('github')), { code });
    assert.equal(f.logins.length, 0); assert.equal(f.links.length, 0);
  });
});

test('未設定 Provider與Apple保持停用，狀態不洩漏 credentials，close清除flow', async t => {
  const f = fixture(t, { configuration: {} });
  assert.deepEqual(f.oauth.providers(), { configured: false, providers: [
    { id: 'google', label: 'Google', enabled: false, reason: 'NOT_CONFIGURED' },
    { id: 'github', label: 'GitHub', enabled: false, reason: 'NOT_CONFIGURED' },
    { id: 'apple', label: 'Apple', enabled: false, reason: 'UNSUPPORTED_LOCAL_PROFILE' },
  ] });
  for (const provider of ['google', 'github', 'apple']) assert.throws(() => f.start(provider), { code: 'OAUTH_NOT_CONFIGURED' });
  assert.equal(f.calls.length, 0);
  const enabled = fixture(t); const callback = enabled.start();
  assert.doesNotMatch(JSON.stringify(enabled.oauth.providers()), /clientId|clientSecret|fixture-secret/u);
  assert.throws(() => enabled.start('apple'), { code: 'OAUTH_NOT_CONFIGURED' });
  enabled.oauth.close(); await assert.rejects(enabled.oauth.callback(callback), { code: 'OAUTH_STATE_INVALID' });
  assert.equal(enabled.calls.length, 0);
});

test('Provider 錯誤／超大內容轉固定錯誤，不外洩 token 或重送已消耗 flow', async t => {
  for (const [label, response] of [
    ['network', () => { throw new Error('fixture-private-token client-secret internal-provider-body'); }],
    ['HTTP', () => new Response('fixture-private-token', { status: 401 })],
    ['JSON', () => new Response('fixture-private-token-not-json')],
    ['size', () => new Response('x'.repeat(65537))],
  ]) await t.test(label, async t => {
    const f = fixture(t, { responses: { [GOOGLE_TOKEN]: response } }); const callback = f.start();
    await assert.rejects(f.oauth.callback(callback), { message: 'OAUTH_PROVIDER_UNAVAILABLE' });
    await assert.rejects(f.oauth.callback(callback), { code: 'OAUTH_STATE_INVALID' });
    assert.equal(f.calls.length, 1); assert.equal(f.logins.length, 0); assert.equal(f.links.length, 0);
  });
});

test('OAuth 設定檔只接受有界 UTF-8、0600、regular、精確 schema，錯誤不含路徑或secret', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dq-social-config-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'oauth.json'); await writeFile(path, JSON.stringify(supplied), { mode: 0o600 });
  assert.deepEqual(await loadOAuthConfigFile(path), supplied);
  for (const invalid of [undefined, 'oauth.json', directory, join(directory, 'missing-private-file')]) {
    await assert.rejects(loadOAuthConfigFile(invalid), { message: 'OAUTH_CONFIGURATION_INVALID' });
  }
  const alias = join(directory, 'alias.json'); await symlink(path, alias);
  await assert.rejects(loadOAuthConfigFile(alias), { code: 'OAUTH_CONFIGURATION_INVALID' });
  await chmod(path, 0o644); await assert.rejects(loadOAuthConfigFile(path), { code: 'OAUTH_CONFIGURATION_INVALID' }); await chmod(path, 0o600);
  for (const invalid of [{ apple: supplied.google }, { google: { ...supplied.google, issuer: 'https://other.fixture.test' } },
    { google: { ...supplied.google, clientSecret: 'bad\nsecret' } }, { google: { clientId: supplied.google.clientId } }]) {
    await writeFile(path, JSON.stringify(invalid)); await assert.rejects(loadOAuthConfigFile(path), { message: 'OAUTH_CONFIGURATION_INVALID' });
  }
  for (const content of [' '.repeat(16385), '', Buffer.from([0xff]), '{bad json']) {
    await writeFile(path, content); await assert.rejects(loadOAuthConfigFile(path), { code: 'OAUTH_CONFIGURATION_INVALID' });
  }
  await writeFile(path, JSON.stringify(supplied)); await link(path, join(directory, 'hardlink.json'));
  await assert.rejects(loadOAuthConfigFile(path), { code: 'OAUTH_CONFIGURATION_INVALID' });
});
