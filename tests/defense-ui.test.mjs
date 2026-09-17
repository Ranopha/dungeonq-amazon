import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { canonicalJson, sha256Hex } from '../public/src/canonical.mjs';

const source = readFileSync(new URL('../workbench/defense.mjs', import.meta.url), 'utf8');
const admin = () => ({ authenticated: true, csrfToken: 'csrf-lab', state: { tenantId: 'tenant-lab', role: 'TENANT_SUPER_ADMIN',
  capabilities: ['READ_STATUS', 'PUBLISH_GRANT', 'MANAGE_MEMBERS', 'MANAGE_EMAIL'], serverNow: Date.now() } });
const mailStatus = overrides => ({ schemaVersion: 'dungeonq.email-status/v1', mode: 'LOCAL_EMAIL_CAPTURE', configured: true,
  recipient: { state: 'UNBOUND', email: null, maskedEmail: null, loginAliasEnabled: false }, pendingChallenge: null,
  linkedIdentities: [], deliveries: [], captureMessages: [], ...overrides });
const providers = [{ id: 'google', label: 'Google', enabled: false, reason: 'NOT_CONFIGURED' },
  { id: 'github', label: 'GitHub', enabled: false, reason: 'NOT_CONFIGURED' },
  { id: 'apple', label: 'Apple', enabled: false, reason: 'UNSUPPORTED_LOCAL_PROFILE' }];
const request = overrides => ({ requestId: 'rotation-1', incidentId: 'incident-1', assetId: 'api-orders', workerId: 'worker-1',
  manifest: { schemaVersion: 'dungeonq.reference-rotation/v1', assetId: 'api-orders', expectedGeneration: 0, expiresAt: Date.now() + 300_000 },
  manifestDigest: 'a'.repeat(64), domain: 'SYNTHETIC_ROTATION', state: 'AWAITING_HUMAN', authorizationActive: false,
  checks: null, ...overrides });
function snapshot(current = request(), notifications = []) {
  return { governance: { incidents: [{ incidentId: 'incident-1', assetId: 'api-orders', worldId: 'world-1', observedAt: Date.now(),
    notification: { eventId: 'notice-1', state: 'PENDING', receipt: null }, actorClassification: 'UNDETERMINED' }], requests: current ? [current] : [] },
    lab: { resource: { assetId: 'api-orders', generation: 0 }, campaigns: [{ incidentId: 'incident-1', worldId: 'world-1', seed: 'seed-1',
      steps: 2, localSuccesses: 1, currentMap: 'B', phase: 'ACTIVE' }], runtimeIsolation: 'NOT_PRODUCTION_ISOLATION', limitation: 'Synthetic local resource.' }, notifications };
}
const allText = element => [element.textContent, ...element.children.map(allText)].join(' ');
async function boot(replies, options = {}) {
  const elements = new Map(); const requests = []; const allElements = []; const navigation = []; const historyChanges = [];
  const create = tag => {
    const element = { tagName: tag.toUpperCase(), textContent: '', className: '', children: [], attributes: {}, listeners: new Map(),
      disabled: false, hidden: false, checked: false, value: '',
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(name, handler) { this.listeners.set(name, handler); }, focus() {} };
    allElements.push(element); return element;
  };
  const element = id => {
    if (!elements.has(id)) elements.set(id, Object.assign(create(['approve', 'execute', 'refresh', 'logout', 'dismiss-message', 'reconcile', 'refresh-proposal',
      'email-begin', 'email-confirm', 'email-remove', 'identity-link', 'identity-login-google', 'identity-login-github', 'identity-login-apple'].includes(id) ? 'button' : 'div'), { id }));
    return elements.get(id);
  };
  for (const id of ['login-form', 'approve-form', 'email-bind-form', 'email-confirm-form', 'email-remove-form', 'identity-link-form']) {
    element(id).elements = Object.fromEntries(['tenantId', 'username', 'password', 'otp', 'acknowledge', 'email', 'code', 'provider'].map(name => [name, create('input')]));
    element(id).elements.tenantId.value = 'tenant-lab'; element(id).elements.username.value = 'owner-lab';
  }
  element('email-bind-form').elements.email = element('email-address');
  element('email-confirm-form').elements.code = element('email-code');
  element('identity-link-form').elements.provider = element('identity-link-provider');
  const document = { getElementById: element, createElement: create, querySelectorAll: selector => selector === 'button' ? allElements.filter(item => item.tagName === 'BUTTON') : [] };
  const location = { origin: 'https://127.0.0.1:4196', pathname: '/defense', search: '', hash: options.hash ?? '', assign(value) { navigation.push(value); } };
  const environment = { document, Date, URL, location, __canonical: { canonicalJson, sha256Hex },
    history: { replaceState(_state, _title, value) { historyChanges.push(value); location.hash = ''; } }, async fetch(path, requestOptions) {
    const row = { path, method: requestOptions.method ?? 'GET', body: requestOptions.body ? JSON.parse(requestOptions.body) : null, headers: requestOptions.headers };
    requests.push(row);
    let reply;
    if (path === '/api/identity/providers') reply = options.providers ?? { providers, configured: false };
    else if (path === '/api/email/status') reply = options.email ?? mailStatus();
    else { assert.ok(replies.length, `No response prepared for ${path}`); reply = replies.shift(); }
    if (typeof reply === 'function') reply = await reply(row);
    if (reply instanceof Error) throw reply;
    if (reply?.httpStatus) return { ok: false, status: reply.httpStatus, json: async () => reply.body };
    return { ok: true, status: 200, json: async () => reply };
  } };
  const vmSource = source.replace("await import('/canonical.mjs')", '__canonical');
  await runInNewContext(`(async () => {\n${vmSource}\n})()`, environment, { timeout: 1000 });
  const dispatch = async (id, type = 'click') => { const handler = element(id).listeners.get(type); assert.ok(handler, `${id} ${type}`); await handler({ preventDefault() {} }); };
  return { element, requests, dispatch, navigation, historyChanges };
}

test('Defense英文可存取頁與固定assets，無儲存秘密或不安全HTML sink', () => {
  const html = readFileSync(new URL('../workbench/defense.html', import.meta.url), 'utf8');
  assert.match(html, /<html lang="en">/u); assert.match(html, /type="password"/u);
  assert.match(html, /aria-live="polite"/u); assert.match(html, /neither proof of AI identity nor proof that A was breached/u);
  assert.match(html, /Local notification sink only/u);
  for (const content of [html, source]) {
    assert.doesNotMatch(content, /localStorage|sessionStorage|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.cookie|\beval\(/u);
    assert.doesNotMatch(content, /(?:src|href)\s*=\s*["'](?:https?:)?\/\//iu);
  }
  assert.doesNotMatch(html, /\s(?:style|on[a-z]+)\s*=/iu);
  const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('Defense讀取不核准，digest綁定fresh reauth後需分開執行且清除密碼', async () => {
  const approved = request({ state: 'APPROVED', authorizationActive: true, approvedAt: Date.now(), approvedBy: 'owner-1' });
  const ui = await boot([admin(), snapshot(), admin(), { intentToken: 'intent-once' }, admin(), approved, admin(), snapshot(approved)]);
  assert.ok(ui.requests.every(row => row.method === 'GET'));
  assert.equal(ui.element('execute').disabled, true); assert.equal(ui.element('approve').disabled, false);
  const form = ui.element('approve-form'); form.elements.password.value = 'synthetic-fresh-password'; form.elements.otp.value = '123456'; form.elements.acknowledge.checked = true;
  await ui.dispatch('approve-form', 'submit');
  const posts = ui.requests.filter(row => row.method === 'POST');
  assert.deepEqual(posts.map(row => row.path), ['/api/intents', '/api/defense/approve']);
  assert.deepEqual(posts[0].body, { password: 'synthetic-fresh-password', purpose: 'APPROVE_ROTATION', manifestDigest: 'a'.repeat(64), otp: '123456' });
  assert.deepEqual(posts[1].body, { requestId: 'rotation-1', manifestDigest: 'a'.repeat(64), intentToken: 'intent-once' });
  assert.equal(form.elements.password.value, ''); assert.equal(form.elements.otp.value, '');
  assert.equal(ui.element('execute').disabled, false); assert.match(ui.element('message-text').textContent, /has not run/u);
});

test('Defense完成與四個strict true才顯示verified，UNKNOWN與缺值不算成功', async () => {
  const checks = { oldKeyDenied: true, newKeyBusiness: true, oldConsumerDenied: true, decoyKeyDenied: true };
  for (const [current, expected] of [
    [request({ state: 'COMPLETED', checks }), true],
    [request({ state: 'UNKNOWN', checks }), false],
    [request({ state: 'COMPLETED', checks: { ...checks, decoyKeyDenied: null } }), false],
    [request({ state: 'COMPLETED', checks: { ...checks, newKeyBusiness: false } }), false],
    [request({ state: 'CLAIMED', checks }), false]
  ]) {
    const ui = await boot([admin(), snapshot(current)]);
    assert.equal(ui.element('verification-title').textContent === 'Verified — all four checks passed', expected);
    assert.equal(ui.element('execute').disabled, true);
  }
});

test('Defense執行結果讀回；lost reply後不可重送，刷新先查既有狀態', async () => {
  const approved = request({ state: 'APPROVED', authorizationActive: true });
  const unknown = request({ state: 'UNKNOWN', authorizationActive: false });
  const ui = await boot([admin(), snapshot(approved), admin(), new Error('CONNECTION_LOST'), admin(), snapshot(unknown)]);
  await ui.dispatch('execute'); assert.equal(ui.element('execute').disabled, true);
  await ui.dispatch('execute'); assert.equal(ui.requests.filter(row => row.method === 'POST').length, 1);
  await ui.dispatch('refresh');
  assert.equal(ui.element('execute').disabled, true); assert.match(ui.element('execution-note').textContent, /Do not execute again/u);
  assert.equal(ui.requests.filter(row => row.method === 'POST').length, 1);
});

test('Defense成功執行仍用server讀回，任何失敗檢查保留未verified', async () => {
  const approved = request({ state: 'APPROVED', authorizationActive: true });
  const completed = request({ state: 'COMPLETED', authorizationActive: false,
    checks: { oldKeyDenied: true, newKeyBusiness: true, oldConsumerDenied: true, decoyKeyDenied: false } });
  const ui = await boot([admin(), snapshot(approved), admin(), { state: 'COMPLETED' }, admin(), snapshot(completed)]);
  await ui.dispatch('execute');
  assert.equal(ui.element('verification-title').textContent, 'Not verified');
  assert.match(allText(ui.element('check-list')), /FAILED/u); assert.match(ui.element('message-text').textContent, /incomplete/u);
});

test('Defense UNKNOWN及已claim過期只能明示readback對帳，不重送effect', async () => {
  const checks = { oldKeyDenied: true, newKeyBusiness: true, oldConsumerDenied: true, decoyKeyDenied: true };
  for (const state of ['UNKNOWN', 'EXPIRED']) {
    const current = request({ state, claimedAt: Date.now() - 1000, authorizationActive: false });
    const completed = request({ state: 'COMPLETED', checks, completedAt: Date.now() });
    const ui = await boot([admin(), snapshot(current), admin(), completed, admin(), snapshot(completed)]);
    assert.equal(ui.element('reconcile-section').hidden, false); assert.equal(ui.element('refresh-proposal').disabled, true);
    await ui.dispatch('reconcile');
    assert.deepEqual(ui.requests.filter(row => row.method === 'POST').map(row => row.path), ['/api/defense/reconcile']);
    assert.equal(ui.element('verification-title').textContent, 'Verified — all four checks passed');
  }
});

test('Defense過期待核准提案可刷新，新digest必須重新核准，不會自動執行', async () => {
  const expired = request({ state: 'EXPIRED', claimedAt: null, authorizationActive: false });
  const renewed = request({ manifestDigest: 'b'.repeat(64), claimedAt: null });
  const ui = await boot([admin(), snapshot(expired), admin(), renewed, admin(), snapshot(renewed)]);
  assert.equal(ui.element('expired-proposal').hidden, false); assert.equal(ui.element('refresh-proposal').disabled, false);
  await ui.dispatch('refresh-proposal');
  assert.deepEqual(ui.requests.filter(row => row.method === 'POST').map(row => row.path), ['/api/defense/refresh']);
  assert.equal(ui.element('manifest-digest').textContent, 'b'.repeat(64));
  assert.equal(ui.element('execute').disabled, true); assert.equal(ui.element('approve-form').elements.acknowledge.checked, false);
});

test('Defense非Owner仍可讀lab，無通知授權不阻斷頁面，刷新失敗鎖定舊操作', async () => {
  const reader = admin(); reader.state.role = 'AUDITOR'; reader.state.capabilities = ['READ_STATUS'];
  const ui = await boot([reader, snapshot(request(), null)]);
  assert.equal(ui.element('workspace').hidden, false); assert.equal(ui.element('approve-form').hidden, true);
  assert.match(ui.element('notification-access').textContent, /Owner only/u);
  assert.equal(ui.element('approve').disabled, true); assert.equal(ui.element('execute').disabled, true);
  const owner = await boot([admin(), snapshot(request({ state: 'APPROVED', authorizationActive: true })), admin(), new Error('UNAVAILABLE')]);
  await owner.dispatch('refresh'); assert.equal(owner.element('execute').disabled, true);
});

test('Defense登入後清除密碼與OTP，登入只使用context CSRF與同源cookie', async () => {
  const visitor = { authenticated: false, csrfToken: 'visit-csrf' };
  const ui = await boot([visitor, visitor, { principal: { role: 'TENANT_SUPER_ADMIN' } }, admin(), snapshot(null)]);
  const form = ui.element('login-form'); form.elements.password.value = 'synthetic-password'; form.elements.otp.value = '654321';
  await ui.dispatch('login-form', 'submit');
  const post = ui.requests.find(row => row.method === 'POST'); assert.equal(post.path, '/api/login');
  assert.equal(post.headers['X-DQ-CSRF'], 'visit-csrf'); assert.equal(post.body.otp, '654321');
  assert.equal(form.elements.password.value, ''); assert.equal(form.elements.otp.value, ''); assert.equal(ui.element('no-request').hidden, false);
});

test('Defense社群登入依真實設定停用，Google與GitHub不冒充已設定，Apple說明本機限制', async () => {
  const visitor = { authenticated: false, csrfToken: 'visitor-csrf' };
  const ui = await boot([visitor]);
  for (const provider of ['google', 'github', 'apple']) {
    assert.equal(ui.element(`identity-login-${provider}`).disabled, true);
    await ui.dispatch(`identity-login-${provider}`);
  }
  assert.match(ui.element('identity-reason-google').textContent, /Not configured/u);
  assert.match(ui.element('identity-reason-apple').textContent, /configured deployment/u);
  assert.match(ui.element('identity-provider-status').textContent, /local administrator access/u);
  assert.equal(ui.requests.some(row => row.method === 'POST'), false);
});

test('Defense已設定provider登入以訪客CSRF開始，單獨跳轉，不核准rotation', async () => {
  const visitor = { authenticated: false, csrfToken: 'visitor-csrf' };
  const configured = { providers: [{ id: 'google', label: 'Google', enabled: true, reason: null }], configured: true };
  const ui = await boot([visitor, visitor, { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque' }], { providers: configured });
  assert.equal(ui.element('identity-login-google').disabled, false);
  await ui.dispatch('identity-login-google');
  const posts = ui.requests.filter(row => row.method === 'POST');
  assert.deepEqual(posts.map(row => row.path), ['/api/identity/start']);
  assert.deepEqual(posts[0].body, { provider: 'google' });
  assert.equal(posts[0].headers['X-DQ-CSRF'], 'visitor-csrf');
  assert.deepEqual(ui.navigation, ['https://accounts.google.com/o/oauth2/v2/auth?state=opaque']);
});

test('Defense社群綁定確認精確provider digest及OTP，跳轉前清除密碼', async () => {
  const configured = { providers: [{ id: 'github', label: 'GitHub', enabled: true, reason: null }], configured: true };
  const ui = await boot([admin(), snapshot(null), admin(), { intentToken: 'link-once' }, admin(),
    { authorizationUrl: 'https://github.com/login/oauth/authorize?state=opaque' }], { providers: configured });
  const form = ui.element('identity-link-form'); form.elements.password.value = 'synthetic-password'; form.elements.otp.value = '123456';
  await ui.dispatch('identity-link-form', 'submit');
  const posts = ui.requests.filter(row => row.method === 'POST');
  assert.deepEqual(posts.map(row => row.path), ['/api/intents', '/api/identity/link']);
  assert.deepEqual(posts[0].body, { password: 'synthetic-password', otp: '123456', purpose: 'MANAGE_EMAIL',
    manifestDigest: await sha256Hex(canonicalJson({ action: 'LINK_IDENTITY', provider: 'github' })) });
  assert.deepEqual(posts[1].body, { provider: 'github', intentToken: 'link-once' });
  assert.equal(form.elements.password.value, ''); assert.equal(form.elements.otp.value, '');
  assert.deepEqual(ui.navigation, ['https://github.com/login/oauth/authorize?state=opaque']);
});

test('Defense provider redirect拒絕非HTTPS，callback失敗訊息不冒充成功且清掉已處理fragment', async () => {
  const visitor = { authenticated: false, csrfToken: 'visitor-csrf' };
  const configured = { providers: [{ id: 'google', label: 'Google', enabled: true }], configured: true };
  const invalid = await boot([visitor, visitor, { authorizationUrl: 'javascript:invalid' }], { providers: configured });
  await invalid.dispatch('identity-login-google');
  assert.deepEqual(invalid.navigation, []); assert.match(invalid.element('message-text').textContent, /could not be started/u);
  const failed = await boot([visitor], { hash: '#identity-signin-failed' });
  assert.deepEqual(failed.historyChanges, ['/defense']);
  assert.match(failed.element('message-text').textContent, /was not confirmed/u);
  assert.match(failed.element('message-text').textContent, /First link.*Owner/u);
  assert.match(failed.element('message-text').textContent, /authenticator/u);
});

test('Defense人工備援綁定正規化email與digest，模擬信箱不自動驗證，確認與解除皆讀回', async () => {
  let email = mailStatus();
  const now = Date.now();
  const ui = await boot([admin(), snapshot(null), admin(), { intentToken: 'bind-once' }, admin(), row => {
    email = mailStatus({ recipient: { state: 'PENDING', email: row.body.email, loginAliasEnabled: false },
      pendingChallenge: { challengeId: 'challenge-1', email: row.body.email, expiresAt: now + 300_000, attemptsRemaining: 5, simulation: true },
      captureMessages: [{ id: 'capture-1', to: row.body.email, subject: 'Simulated verification', text: 'Verification code: 246810', acceptedAt: now }] });
    return { challengeId: 'challenge-1', email: row.body.email, state: 'PENDING', simulation: true };
  }, admin(), row => {
    assert.deepEqual(row.body, { challengeId: 'challenge-1', code: '246810' });
    email = mailStatus({ recipient: { state: 'SIMULATED_VERIFIED', email: 'owner@example.test', maskedEmail: 'o***@example.test',
      verificationMethod: 'LOCAL_EMAIL_CAPTURE', verifiedAt: now, loginAliasEnabled: true } });
    return { verified: true, simulation: true };
  }, admin(), { intentToken: 'remove-once' }, admin(), () => { email = mailStatus(); return { removed: true }; }], { email: () => email });
  const form = ui.element('email-bind-form'); form.elements.email.value = ' Owner@Example.Test '; form.elements.password.value = 'synthetic-password';
  await ui.dispatch('email-bind-form', 'submit');
  const beginIntent = ui.requests.find(row => row.path === '/api/intents');
  assert.equal(beginIntent.body.purpose, 'MANAGE_EMAIL');
  assert.equal(beginIntent.body.manifestDigest, await sha256Hex(canonicalJson({ action: 'BIND_EMAIL', email: 'owner@example.test' })));
  assert.deepEqual(ui.requests.find(row => row.path === '/api/email/begin').body, { email: 'owner@example.test', intentToken: 'bind-once' });
  assert.equal(form.elements.password.value, '');
  assert.equal(ui.element('email-manual').open, true); assert.equal(ui.element('email-capture').open, true);
  assert.match(allText(ui.element('email-capture-list')), /246810/u);
  assert.equal(ui.element('email-confirm-form').elements.code.value, '');
  assert.equal(ui.requests.some(row => row.path === '/api/email/confirm'), false);
  assert.match(ui.element('message-text').textContent, /No external email/u);
  ui.element('email-confirm-form').elements.code.value = '246810';
  await ui.dispatch('email-confirm-form', 'submit');
  assert.match(ui.element('email-recipient').textContent, /Simulated verification/u);
  assert.match(ui.element('email-alias').textContent, /simulated email sign-in/u);
  assert.equal(ui.element('email-confirm-form').elements.code.value, '');
  ui.element('email-remove-form').elements.password.value = 'synthetic-password';
  await ui.dispatch('email-remove-form', 'submit');
  assert.equal(ui.requests.filter(row => row.path === '/api/intents').at(-1).body.manifestDigest,
    await sha256Hex(canonicalJson({ action: 'REMOVE_EMAIL' })));
  assert.match(ui.element('email-recipient').textContent, /No email bound/u);
  assert.match(ui.element('message-text').textContent, /linked provider sign-ins removed/u);
  assert.equal(ui.element('email-remove-form').elements.password.value, '');
});

test('Defense SMTP接受不宣稱收件匣送達，UNKNOWN禁止新驗證請求，未設定不開放寄送', async () => {
  const email = mailStatus({ mode: 'SMTP', deliveries: [{ id: 'mail-1', kind: 'DECOY_CONTACT', eventId: 'incident-1', state: 'ACCEPTED',
    mode: 'SMTP', createdAt: Date.now(), attempts: 1, maskedRecipient: 'o***@example.test' }],
    captureMessages: [{ text: 'Should not display SMTP content' }] });
  const smtp = await boot([admin(), snapshot(null)], { email });
  assert.match(allText(smtp.element('email-delivery-list')), /Accepted by SMTP server.*inbox delivery unconfirmed/u);
  assert.equal(smtp.element('email-capture').hidden, true); assert.equal(smtp.element('email-capture-list').children.length, 0);
  const unknown = await boot([admin(), snapshot(null)], { email: mailStatus({ deliveries: [{ kind: 'VERIFY_EMAIL', state: 'UNKNOWN', createdAt: Date.now() }],
    pendingChallenge: { challengeId: 'pending', email: 'owner@example.test', attemptsRemaining: 5, expiresAt: Date.now() + 300_000, simulation: true } }) });
  assert.equal(unknown.element('email-begin').disabled, true); assert.match(unknown.element('email-challenge').textContent, /do not resend/u);
  await unknown.dispatch('email-bind-form', 'submit'); assert.equal(unknown.requests.some(row => row.method === 'POST'), false);
  const unconfigured = await boot([admin(), snapshot(null)], { email: mailStatus({ mode: 'NOT_CONFIGURED', configured: false }) });
  assert.equal(unconfigured.element('email-begin').disabled, true); assert.match(unconfigured.element('email-mode').textContent, /not configured/u);
});

test('Defense email狀態失敗獨立停用信箱，不阻擋rotation閱讀與核准；低權限不讀取email', async () => {
  const failed = await boot([admin(), snapshot()], { email: { httpStatus: 503, body: { error: 'SERVICE_UNAVAILABLE' } } });
  assert.equal(failed.element('email-readback-error').hidden, false);
  assert.equal(failed.element('email-begin').disabled, true); assert.equal(failed.element('identity-link').disabled, true);
  assert.equal(failed.element('approve').disabled, false);
  const reader = admin(); reader.state.role = 'AUDITOR'; reader.state.capabilities = ['READ_STATUS'];
  const readOnly = await boot([reader, snapshot(null, null)]);
  assert.equal(readOnly.element('email-settings').hidden, true);
  assert.equal(readOnly.requests.some(row => row.path === '/api/email/status'), false);
});

test('Defense未知人工綁定結果停用修改至讀回，已連結provider狀態明示來源', async () => {
  const linked = mailStatus({ recipient: { state: 'VERIFIED', email: 'owner@example.test', maskedEmail: 'o***@example.test',
    verificationMethod: 'OAUTH_VERIFIED', loginAliasEnabled: true }, linkedIdentities: [{ provider: 'google', mode: 'REAL_VERIFIED', linkedAt: Date.now() }] });
  const ui = await boot([admin(), snapshot(null), admin(), { intentToken: 'bind-once' }, admin(), new Error('CONNECTION_LOST')], { email: linked });
  assert.match(ui.element('identity-current').textContent, /Linked: Google/u);
  ui.element('email-bind-form').elements.email.value = 'new@example.test'; ui.element('email-bind-form').elements.password.value = 'synthetic-password';
  await ui.dispatch('email-bind-form', 'submit');
  assert.equal(ui.element('email-begin').disabled, true); assert.equal(ui.element('email-remove').disabled, true);
  assert.match(ui.element('message-text').textContent, /Read current status/u);
  await ui.dispatch('email-bind-form', 'submit');
  assert.equal(ui.requests.filter(row => row.path === '/api/email/begin').length, 1);
});
