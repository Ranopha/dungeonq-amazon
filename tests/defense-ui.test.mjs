import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../workbench/defense.mjs', import.meta.url), 'utf8');
const admin = () => ({ authenticated: true, csrfToken: 'csrf-lab', state: { tenantId: 'tenant-lab', role: 'TENANT_SUPER_ADMIN',
  capabilities: ['READ_STATUS', 'PUBLISH_GRANT', 'MANAGE_MEMBERS'], serverNow: Date.now() } });
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
async function boot(replies) {
  const elements = new Map(); const requests = []; const allElements = [];
  const create = tag => {
    const element = { tagName: tag.toUpperCase(), textContent: '', className: '', children: [], attributes: {}, listeners: new Map(),
      disabled: false, hidden: false, checked: false, value: '',
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      setAttribute(name, value) { this.attributes[name] = value; }, addEventListener(name, handler) { this.listeners.set(name, handler); }, focus() {} };
    allElements.push(element); return element;
  };
  const element = id => {
    if (!elements.has(id)) elements.set(id, Object.assign(create(['approve', 'execute', 'refresh', 'logout', 'dismiss-message', 'reconcile', 'refresh-proposal'].includes(id) ? 'button' : 'div'), { id }));
    return elements.get(id);
  };
  for (const id of ['login-form', 'approve-form']) {
    element(id).elements = Object.fromEntries(['tenantId', 'username', 'password', 'otp', 'acknowledge'].map(name => [name, create('input')]));
    element(id).elements.tenantId.value = 'tenant-lab'; element(id).elements.username.value = 'owner-lab';
  }
  const document = { getElementById: element, createElement: create, querySelectorAll: selector => selector === 'button' ? allElements.filter(item => item.tagName === 'BUTTON') : [] };
  const environment = { document, Date, async fetch(path, options) {
    const row = { path, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null, headers: options.headers };
    requests.push(row); assert.ok(replies.length, `No response prepared for ${path}`);
    let reply = replies.shift(); if (typeof reply === 'function') reply = await reply(row);
    if (reply instanceof Error) throw reply;
    if (reply?.httpStatus) return { ok: false, status: reply.httpStatus, json: async () => reply.body };
    return { ok: true, status: 200, json: async () => reply };
  } };
  await runInNewContext(`(async () => {\n${source}\n})()`, environment, { timeout: 1000 });
  const dispatch = async (id, type = 'click') => { const handler = element(id).listeners.get(type); assert.ok(handler, `${id} ${type}`); await handler({ preventDefault() {} }); };
  return { element, requests, dispatch };
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
  assert.deepEqual(ui.requests.map(row => row.method), ['GET', 'GET']);
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
