import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { exact, requireThat } from './contracts.mjs';

const GOOGLE = 'https://accounts.google.com';
const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');
const same = (left, right) => typeof left === 'string' && typeof right === 'string'
  && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const PROVIDERS = { google: { label: 'Google', authorization: `${GOOGLE}/o/oauth2/v2/auth`, token: 'https://oauth2.googleapis.com/token', scope: 'openid email' },
  github: { label: 'GitHub', authorization: 'https://github.com/login/oauth/authorize', token: 'https://github.com/login/oauth/access_token', scope: 'user:email' } };

function configuration(input) {
  requireThat(input && Object.getPrototypeOf(input) === Object.prototype && Object.keys(input).length <= 2
    && Object.keys(input).every(key => Object.hasOwn(PROVIDERS, key)), 'OAUTH_CONFIGURATION_INVALID');
  const result = {};
  for (const [name, item] of Object.entries(input)) {
    exact(item, ['clientId', 'clientSecret']);
    requireThat(typeof item.clientId === 'string' && /^[A-Za-z0-9._-]{5,256}$/u.test(item.clientId)
      && typeof item.clientSecret === 'string' && item.clientSecret.length >= 8 && item.clientSecret.length <= 4096
      && !/[\r\n\0]/u.test(item.clientSecret), 'OAUTH_CONFIGURATION_INVALID');
    result[name] = Object.freeze({ ...item });
  }
  return Object.freeze(result);
}

export async function loadOAuthConfigFile(path) {
  let file;
  try {
    requireThat(typeof path === 'string' && isAbsolute(path), 'OAUTH_CONFIGURATION_INVALID');
    const before = await lstat(path);
    requireThat(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && (before.mode & 0o777) === 0o600
      && before.size > 0 && before.size <= 16_384, 'OAUTH_CONFIGURATION_INVALID');
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await file.stat();
    requireThat(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.nlink === 1
      && (opened.mode & 0o777) === 0o600 && opened.size > 0 && opened.size <= 16_384, 'OAUTH_CONFIGURATION_INVALID');
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    requireThat(bytesRead === opened.size && bytesRead <= 16_384, 'OAUTH_CONFIGURATION_INVALID');
    return configuration(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))));
  } catch { requireThat(false, 'OAUTH_CONFIGURATION_INVALID'); }
  finally { if (file) await file.close().catch(() => {}); }
}

function providerEmail(value) {
  requireThat(typeof value === 'string' && value.length <= 254 && /^[\x21-\x7e]+$/u.test(value), 'OAUTH_IDENTITY_REJECTED');
  const parts = value.split('@');
  requireThat(parts.length === 2 && parts[0].length > 0 && parts[0].length <= 64
    && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u.test(parts[0]) && !parts[0].startsWith('.')
    && !parts[0].endsWith('.') && !parts[0].includes('..') && parts[1].includes('.')
    && parts[1].split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label)), 'OAUTH_IDENTITY_REJECTED');
  return value;
}

// The key resolver is a trusted assembly dependency, never an HTTP/MCP field.
export async function verifiedGoogleIdentity(idToken, { clientId, nonce, keyResolver, currentDate = new Date() }) {
  requireThat(typeof idToken === 'string' && idToken.length <= 16_384, 'OAUTH_IDENTITY_REJECTED');
  let payload;
  try { ({ payload } = await jwtVerify(idToken, keyResolver, { issuer: [GOOGLE, 'accounts.google.com'], audience: clientId,
    algorithms: ['RS256'], requiredClaims: ['sub', 'email', 'email_verified', 'nonce', 'iat', 'exp'], maxTokenAge: '10m', clockTolerance: 5, currentDate })); }
  catch { requireThat(false, 'OAUTH_IDENTITY_REJECTED'); }
  requireThat(same(payload.nonce, nonce) && payload.email_verified === true && typeof payload.sub === 'string'
    && /^[A-Za-z0-9_-]{1,255}$/u.test(payload.sub) && (!Object.hasOwn(payload, 'azp') || payload.azp === clientId)
    && (typeof payload.aud === 'string' || payload.aud.length === 1), 'OAUTH_IDENTITY_REJECTED');
  return { provider: 'google', subject: payload.sub, email: providerEmail(payload.email), mode: 'REAL_VERIFIED' };
}

export function createSocialOAuth({ configuration: supplied = {}, local, application, clock = Date.now }, dependencies = {}) {
  const config = configuration(supplied);
  // Tests replace provider HTTP replies / JWKS. Runtime never accepts endpoint overrides in config.
  const fetcher = dependencies.fetch ?? fetch;
  const keys = dependencies.googleKeys ?? createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { timeoutDuration: 5000 });
  const flows = new Map();
  async function json(url, options = {}) {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(5000) });
    requireThat(response.ok && response.body, 'OAUTH_PROVIDER_UNAVAILABLE');
    const reader = response.body.getReader(); let size = 0; const parts = [];
    try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
      requireThat(size <= 65_536, 'OAUTH_PROVIDER_UNAVAILABLE'); parts.push(Buffer.from(next.value)); } }
    finally { await reader.cancel().catch(() => {}); }
    try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { requireThat(false, 'OAUTH_PROVIDER_UNAVAILABLE'); }
  }
  function providers() {
    return { configured: Object.keys(config).length > 0, providers: [...Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label,
      enabled: !!config[id], reason: config[id] ? null : 'NOT_CONFIGURED' })),
    { id: 'apple', label: 'Apple', enabled: false, reason: 'UNSUPPORTED_LOCAL_PROFILE' }] };
  }
  function start({ provider, origin, cookie, sessionToken, intentToken }) {
    requireThat(Object.hasOwn(PROVIDERS, provider) && config[provider], 'OAUTH_NOT_CONFIGURED');
    requireThat(/^https:\/\/127\.0\.0\.1:\d{1,5}$/u.test(origin) && typeof cookie === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(cookie), 'OAUTH_STATE_INVALID');
    for (const [key, flow] of flows) if (flow.expiresAt <= clock()) flows.delete(key);
    requireThat(flows.size < 32, 'AUTH_CAPACITY');
    if (sessionToken) {
      const principal = application.status(sessionToken);
      requireThat(principal.capabilities.includes('MANAGE_EMAIL') && typeof intentToken === 'string', 'PERMISSION_DENIED');
    } else requireThat(intentToken === undefined, 'OAUTH_STATE_INVALID');
    const state = random(); const nonce = random(); const verifier = random(); const redirectUri = `${origin}/api/identity/callback`;
    flows.set(hash(state), { provider, cookieHash: hash(cookie), nonce, verifier, redirectUri, sessionToken, intentToken, expiresAt: clock() + 300_000 });
    const url = new URL(PROVIDERS[provider].authorization);
    for (const [key, value] of Object.entries({ client_id: config[provider].clientId, redirect_uri: redirectUri, response_type: 'code',
      scope: PROVIDERS[provider].scope, state, code_challenge: hash(verifier), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
    if (provider === 'google') { url.searchParams.set('nonce', nonce); url.searchParams.set('prompt', 'select_account'); }
    else url.searchParams.set('allow_signup', 'false');
    return { authorizationUrl: url.href };
  }
  async function callback({ state, code, cookie, sessionToken }) {
    requireThat(typeof state === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(state) && typeof cookie === 'string', 'OAUTH_STATE_INVALID');
    const key = hash(state); const flow = flows.get(key);
    requireThat(flow && flow.expiresAt > clock() && same(flow.cookieHash, hash(cookie)), 'OAUTH_STATE_INVALID');
    // Consume before network awaits: failed or uncertain exchanges require a new login flow.
    flows.delete(key);
    requireThat(typeof code === 'string' && code.length > 0 && code.length <= 2048 && !/[\r\n\0]/u.test(code), 'OAUTH_CODE_INVALID');
    // The Owner cookie is SameSite=Strict and may be absent on a provider redirect.
    // The separate Lax flow cookie binds this browser; core revalidates the saved Owner session.
    if (flow.sessionToken && sessionToken !== undefined) requireThat(same(flow.sessionToken, sessionToken), 'OAUTH_STATE_INVALID');
    const provider = PROVIDERS[flow.provider]; const client = config[flow.provider];
    let identity;
    try {
      const tokens = await json(provider.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, code,
          redirect_uri: flow.redirectUri, code_verifier: flow.verifier, grant_type: 'authorization_code' }).toString() });
      if (flow.provider === 'google') identity = await verifiedGoogleIdentity(tokens.id_token, { clientId: client.clientId, nonce: flow.nonce,
        keyResolver: keys, currentDate: new Date(clock()) });
      else {
        requireThat(typeof tokens.access_token === 'string' && tokens.access_token.length <= 2048
          && /^[A-Za-z0-9_-]+$/u.test(tokens.access_token) && tokens.token_type?.toLowerCase() === 'bearer', 'OAUTH_IDENTITY_REJECTED');
        const headers = { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'DungeonQ-local-lab', 'X-GitHub-Api-Version': '2022-11-28' };
        const user = await json('https://api.github.com/user', { headers });
        const emails = await json('https://api.github.com/user/emails?per_page=100', { headers });
        requireThat(Number.isSafeInteger(user.id) && user.id > 0 && Array.isArray(emails), 'OAUTH_IDENTITY_REJECTED');
        const primary = emails.filter(item => item.primary === true && item.verified === true);
        requireThat(primary.length === 1, 'OAUTH_VERIFIED_EMAIL_REQUIRED');
        identity = { provider: 'github', subject: String(user.id), email: providerEmail(primary[0].email), mode: 'REAL_VERIFIED' };
      }
    } catch (error) {
      requireThat(false, ['OAUTH_IDENTITY_REJECTED', 'OAUTH_VERIFIED_EMAIL_REQUIRED'].includes(error.code) ? error.code : 'OAUTH_PROVIDER_UNAVAILABLE');
    }
    if (flow.sessionToken) {
      const result = local.linkExternalIdentity(flow.sessionToken, { ...identity, intentToken: flow.intentToken });
      return { linked: true, result };
    }
    return { linked: false, session: await local.loginExternalIdentity(identity) };
  }
  return Object.freeze({ providers, start, callback, close() { flows.clear(); } });
}
