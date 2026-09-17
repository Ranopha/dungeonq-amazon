import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const actorSource = readFileSync(new URL('../public/study/actor.mjs', import.meta.url), 'utf8');
const pendingKey = 'dungeonq-study-pending';
const originalPending = {
  worldId: 'original-world',
  envelope: { requestId: 'original-request', expectedRevision: 1,
    command: { type: 'predict', choiceId: 'training-1-card-1', predictedSuccess: null,
      hypothesis: 'unknown', confidence: null, suspicion: null } },
};
const snapshot = (worldId, phase = 'ACT', revision = 2) => ({
  profile: 'SYNTHETIC_CAUSAL_STUDY', worldId, epoch: 'one', revision, phase,
  assignmentCommit: 'a'.repeat(64), title: '介面回歸合成場', consentNotice: '人工合成測試',
  room: { id: 'training-1', title: '練習館', description: '固定合成規則' },
  choices: phase === 'PREDICT' ? [{ id: 'training-1-card-1', label: '亮／圓', features: { signal: true, structure: true } }] : [],
  inventory: [], receipts: [], lastResult: null,
  pendingPrediction: phase === 'ACT' ? originalPending.envelope.command : null, debrief: null,
});

async function bootActor({ getReplies, postReply }) {
  const storage = new Map([[pendingKey, JSON.stringify(originalPending)]]);
  const elements = new Map(); const requests = []; let uuidCalls = 0;
  const makeElement = tag => ({
    tagName: tag.toUpperCase(), children: [], listeners: new Map(), disabled: false, hidden: false,
    value: '', textContent: '', className: '', resetCount: 0,
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, handler) {
      const handlers = this.listeners.get(type) ?? []; handlers.push(handler); this.listeners.set(type, handlers);
    },
    reset() { this.resetCount++; }, reportValidity() { return true; },
  });
  const element = id => {
    if (!elements.has(id)) elements.set(id, Object.assign(makeElement('div'), { id }));
    return elements.get(id);
  };
  const document = {
    getElementById: element, createElement: makeElement,
    querySelectorAll(selector) {
      assert.equal(selector, 'button[type=submit],#act-submit');
      return ['consent-submit', 'predict-submit', 'reflect-submit', 'act-submit'].map(element);
    },
    querySelector() { return null; },
  };
  const context = {
    document, URLSearchParams, location: { hash: '#token=synthetic-actor-token', pathname: '/' },
    history: { replaceState() {} },
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key),
    },
    crypto: { randomUUID() { uuidCalls++; return `new-request-${uuidCalls}`; } },
    AbortSignal: { timeout(milliseconds) { assert.equal(milliseconds, 5000); return null; } },
    async fetch(url, options) {
      const request = { url, method: options.method, body: options.body ? JSON.parse(options.body) : null };
      requests.push(request);
      assert.equal(options.headers.Authorization, 'Bearer synthetic-actor-token');
      let data;
      if (options.method === 'GET') {
        assert.equal(url, '/api/study'); assert.ok(getReplies.length, 'GET 必須有指定的合成回覆');
        data = getReplies.shift();
      } else {
        assert.equal(options.method, 'POST'); assert.equal(url, '/api/study/command');
        assert.equal(typeof postReply, 'function', '此路徑不應發出 POST'); data = postReply(request.body);
      }
      if (data instanceof Error) throw data;
      return { ok: true, status: 200, json: async () => data };
    },
  };
  await runInNewContext(`(async () => {\n${actorSource}\n})()`, context, { filename: 'study-actor-ui-test', timeout: 1000 });
  return {
    element, storage, requests, get uuidCalls() { return uuidCalls; },
    // 直接呼叫已註冊 handler，另驗證 disabled 按鈕背後的程式防線。
    async dispatch(id, type = 'click') {
      const handlers = element(id).listeners.get(type) ?? [];
      assert.ok(handlers.length, `${id} 必須註冊 ${type} handler`);
      for (const handler of handlers) await handler({ preventDefault() {} });
    },
  };
}

test('Actor 首次 GET 失敗時保留原 pending，但按鈕及 handler 均不得重送', async () => {
  const ui = await bootActor({ getReplies: [new Error('合成讀取失敗')] });
  assert.equal(ui.element('retry').hidden, false);
  assert.equal(ui.element('retry').disabled, true);
  assert.deepEqual(JSON.parse(ui.storage.get(pendingKey)), originalPending);
  await ui.dispatch('retry');
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.requests[0].method, 'GET');
  assert.equal(ui.uuidCalls, 0);
  assert.deepEqual(JSON.parse(ui.storage.get(pendingKey)), originalPending);
});

test('Actor 後續 GET 才讀到不同世界時清除舊 pending，重試也不發出 POST', async () => {
  const ui = await bootActor({ getReplies: [new Error('首次尚未讀回'), snapshot('different-world', 'PREDICT', 1)] });
  await ui.dispatch('refresh');
  assert.equal(ui.storage.has(pendingKey), false);
  assert.equal(ui.element('retry').hidden, true);
  assert.equal(ui.element('predict-stage').hidden, false);
  assert.equal(ui.element('predict-submit').disabled, false);
  await ui.dispatch('retry');
  assert.deepEqual(ui.requests.map(request => request.method), ['GET', 'GET']);
  assert.equal(ui.uuidCalls, 0);
});

test('Actor 同世界恢復後才允許原 envelope 重試，連續觸發只送一次且不另發 requestId', async () => {
  const restored = snapshot(originalPending.worldId);
  const ui = await bootActor({
    getReplies: [new Error('首次尚未讀回'), restored],
    postReply(envelope) {
      assert.deepEqual(envelope, originalPending.envelope);
      return { view: restored, replayed: true };
    },
  });
  await ui.dispatch('retry');
  assert.equal(ui.requests.filter(request => request.method === 'POST').length, 0);
  await ui.dispatch('refresh');
  assert.equal(ui.element('retry').hidden, false);
  assert.equal(ui.element('retry').disabled, false);
  assert.equal(ui.element('act-submit').disabled, true);
  await Promise.all([ui.dispatch('retry'), ui.dispatch('retry')]);
  const posts = ui.requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 1); assert.deepEqual(posts[0].body, originalPending.envelope);
  assert.equal(ui.uuidCalls, 0); assert.equal(ui.storage.has(pendingKey), false);
  assert.equal(ui.element('retry').hidden, true);
  assert.equal(ui.element('act-submit').disabled, false);
  assert.equal(ui.element('revision').textContent, '已保存 2 筆紀錄');
  assert.equal(ui.element('notice').textContent, '已確認原請求，沒有重複執行。');
});
