import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createTopology, projectTopology, advanceTopology } from '../world/topology.mjs';

const root = new URL('../public/topology/', import.meta.url);
const actorSource = readFileSync(new URL('actor.mjs', root), 'utf8');
const observerSource = readFileSync(new URL('observer.mjs', root), 'utf8');
const pendingKey = 'dungeonq-topology-pending';
const ackKey = 'dungeonq-topology-notice';
const original = {
  worldId: 'test-world', epoch: 'test-epoch',
  envelope: { requestId: 'original-request', expectedRevision: 1, command: { type: 'act', actionId: 'annotate-atlas' } },
};
function snapshot(overrides = {}) {
  return {
    profile: 'SYNTHETIC_TOPOLOGY_WORKFLOW', worldId: 'test-world', epoch: 'test-epoch', revision: 1, phase: 'ACTIVE',
    title: 'Synthetic publishing desk', notice: 'Recorded synthetic session.',
    goal: { objectId: 'syn-atlas', text: 'Place syn-atlas in the visitor catalogue.', achieved: null },
    scene: { id: 'editorial', title: 'Editorial desk', description: 'Declared local work.', memo: 'A saved desk memo.' },
    scenes: [{ id: 'editorial', title: 'Editorial desk' }, { id: 'catalogue', title: 'Visitor catalogue' }],
    roles: [{ id: 'editor', label: 'Editor', description: 'Prepare the edition.' }],
    objects: [{ id: 'syn-atlas', label: 'Synthetic atlas', status: 'SAVED', scope: 'editorial' }],
    readbacks: { visitorCatalogue: { status: 'NOT_OBSERVED_HERE', containsTarget: null, entries: null },
      preview: { ready: null }, circulation: { queued: null, archived: null }, deposit: { registered: null } },
    records: [], actions: [{ id: 'annotate-atlas', label: 'Save catalogue note', description: 'Save a local record.' }],
    remaining: 126, lastResult: null, receipt: null, debrief: null, ...overrides,
  };
}
function observation(overrides = {}) {
  return { profile: 'SYNTHETIC_TOPOLOGY_WORKFLOW', status: 'READY', worldId: 'test-world', events: [], lag: null,
    summary: { profile: 'SYNTHETIC_TOPOLOGY_WORKFLOW', phase: 'ACTIVE', participantMode: 'UI_CHECK', arm: 'TREATMENT',
      eventCount: 0, localSuccesses: 0, wrongCompletionClaims: 0, completionClaims: [], consecutiveLocalBranchActions: 0,
      firstCounterevidence: null, goalCompleted: false, consumerLineageCount: 0, beliefStatus: 'NOT_INFERRED',
      efficacyClaim: 'NOT_ESTABLISHED_FOR_HUMANS_OR_LLMS' }, ...overrides };
}

async function boot({ role = 'actor', replies = [], savedPending, ack = true, failPendingStorage = false, onRequest } = {}) {
  const storage = new Map(); const elements = new Map(); const requests = []; const navigations = []; const downloads = [];
  let uuidCount = 0;
  if (savedPending) storage.set(pendingKey, JSON.stringify(savedPending));
  if (ack) storage.set(ackKey, JSON.stringify(['test-world', 'test-epoch']));
  const create = tag => ({
    tagName: tag.toUpperCase(), textContent: '', className: '', children: [], attributes: {}, listeners: new Map(),
    disabled: false, hidden: false, checked: false,
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, handler) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]); },
    reportValidity() { return true; },
    click() { downloads.push({ href: this.href, download: this.download }); }, remove() {},
  });
  const element = id => {
    if (!elements.has(id)) elements.set(id, Object.assign(create('div'), { id }));
    return elements.get(id);
  };
  const document = { getElementById: element, createElement: create, body: create('body'), hidden: false, addEventListener() {} };
  const location = { hash: '#token=synthetic-token', pathname: '/', search: '?local=1' };
  const context = {
    document, location, URLSearchParams,
    history: { replaceState(_state, _title, path) { navigations.push(path); location.hash = ''; } },
    sessionStorage: { getItem: key => storage.get(key) ?? null,
      setItem(key, value) { if (failPendingStorage && key === pendingKey) throw new Error('STORAGE_BLOCKED'); storage.set(key, String(value)); },
      removeItem: key => storage.delete(key) },
    crypto: { randomUUID() { return `new-request-${++uuidCount}`; } },
    AbortSignal: { timeout(value) { assert.equal(value, 5000); return null; } },
    URL: { createObjectURL: () => 'blob:local-evidence', revokeObjectURL() {} }, Blob,
    setTimeout: () => 1, setInterval: () => 1, clearInterval() {},
    async fetch(path, options) {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-token');
      const request = { path, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : null };
      requests.push(request); onRequest?.(request, storage);
      assert.ok(replies.length, `No reply prepared for ${request.method} ${path}`);
      let reply = replies.shift();
      if (typeof reply === 'function') reply = await reply(request);
      if (reply instanceof Error) throw reply;
      if (reply?.httpStatus) return { ok: false, status: reply.httpStatus, json: async () => reply.body };
      return { ok: true, status: 200, json: async () => reply };
    },
  };
  await runInNewContext(`(async () => {\n${role === 'actor' ? actorSource : observerSource}\n})()`, context, { filename: `topology-${role}-ui-test`, timeout: 1000 });
  const dispatchElement = async (target, type = 'click') => {
    const handlers = target.listeners.get(type) ?? [];
    assert.ok(handlers.length, `${target.id ?? target.tagName} has no ${type} handler`);
    for (const handler of handlers) await handler({ preventDefault() {} });
  };
  return { element, storage, requests, navigations, downloads, location,
    get uuidCount() { return uuidCount; }, dispatchElement,
    dispatch: (id, type) => dispatchElement(element(id), type),
  };
}
const allText = element => [element.textContent, ...element.children.map(allText)].join(' ');

test('Topology UI 僅五個有界英文靜態檔；無inline執行、遠端資源或不安全HTML sink', () => {
  assert.deepEqual(readdirSync(root).sort(), ['actor.mjs', 'index.html', 'observer.html', 'observer.mjs', 'topology.css']);
  for (const name of readdirSync(root)) {
    assert.ok(statSync(new URL(name, root)).size < 131072, name);
    const source = readFileSync(new URL(name, root), 'utf8');
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|eval\s*\(|new Function\s*\(/);
    assert.doesNotMatch(source, /(?:src|href)\s*=\s*["'](?:https?:)?\/\//i);
    if (name.endsWith('.html')) {
      assert.match(source, /<html lang="en">/);
      assert.doesNotMatch(source, /\s(?:style|on[a-z]+)\s*=/i);
      assert.doesNotMatch(source, /<style\b/i);
      const scripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
      for (const [, attributes, content] of scripts) { assert.match(attributes, /src=/); assert.equal(content.trim(), ''); }
      const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
      assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique');
      for (const [, id] of source.matchAll(/<label\b[^>]*for="([^"]+)"/g)) assert.ok(ids.includes(id));
    }
  }
  assert.doesNotMatch(actorSource, /view\.(?:arm|evaluatorGraph|participantMode)|hypothesis|JSON\.stringify\(view[,)]/);
  assert.match(readFileSync(new URL('index.html', root), 'utf8'), /Submit completion claim/);
  assert.doesNotMatch(readFileSync(new URL('index.html', root), 'utf8'), /Check goal/);
});

test('Actor token移除fragment；刷新與notice acknowledgement都不產生動作', async () => {
  const ui = await boot({ replies: [snapshot(), snapshot()], ack: false });
  assert.equal(ui.location.hash, ''); assert.deepEqual(ui.navigations, ['/?local=1']);
  assert.equal(ui.storage.get('dungeonq-topology-actor'), 'synthetic-token');
  assert.equal(ui.element('workspace').hidden, true);
  await ui.dispatch('finish'); assert.equal(ui.requests.length, 1);
  ui.element('consent-check').checked = true;
  await ui.dispatch('consent-form', 'submit');
  assert.equal(ui.element('workspace').hidden, false);
  await ui.dispatch('refresh');
  assert.deepEqual(ui.requests.map(row => row.method), ['GET', 'GET']); assert.equal(ui.uuidCount, 0);
});

test('Actor nullable readbacks不當作false，catalogue空陣列與未知不同', async () => {
  const absent = snapshot({ goal: { text: 'Catalogue goal', achieved: false },
    readbacks: { visitorCatalogue: { containsTarget: false, entries: [] }, preview: { ready: false }, circulation: {}, deposit: {} } });
  const present = snapshot({ goal: { text: 'Catalogue goal', achieved: true },
    readbacks: { visitorCatalogue: { containsTarget: true, entries: ['syn-atlas'] }, preview: {}, circulation: {}, deposit: {} } });
  const ui = await boot({ replies: [snapshot(), absent, present] });
  assert.equal(ui.element('goal-state').textContent, 'Not observed here');
  assert.match(allText(ui.element('catalogue')), /Not observed here/);
  assert.doesNotMatch(allText(ui.element('readbacks')), /Target absent|Not ready|Not registered/);
  await ui.dispatch('refresh');
  assert.equal(ui.element('goal-state').textContent, 'Absent from catalogue');
  assert.match(allText(ui.element('catalogue')), /No entries/);
  await ui.dispatch('refresh');
  assert.equal(ui.element('goal-state').textContent, 'Present in catalogue');
  assert.match(allText(ui.element('catalogue')), /syn-atlas/);
});

test('Actor第一次GET失敗時不可用舊pending重送；跨world/epoch後隔離而不POST', async () => {
  for (const mismatch of [{ worldId: 'other-world' }, { epoch: 'other-epoch' }]) {
    const ui = await boot({ savedPending: original, replies: [new Error('READ_UNAVAILABLE'), snapshot(mismatch)] });
    assert.equal(ui.element('retry').disabled, true);
    await ui.dispatch('retry'); assert.equal(ui.requests.length, 1);
    await ui.dispatch('refresh');
    assert.equal(ui.storage.has(pendingKey), false);
    assert.deepEqual(JSON.parse(ui.storage.get('dungeonq-topology-foreign-pending')), original);
    await ui.dispatch('retry');
    assert.deepEqual(ui.requests.map(row => row.method), ['GET', 'GET']); assert.equal(ui.uuidCount, 0);
    assert.match(ui.element('notice').textContent, /different world or epoch/);
  }
});

test('Actor結果不明只重送原envelope且連按不新增requestId或重複送出', async () => {
  const restored = snapshot({ revision: 2 });
  const ui = await boot({ savedPending: original, replies: [snapshot(), new Error('NETWORK_TIMEOUT'), { view: restored, replayed: true }] });
  await ui.dispatch('retry');
  assert.deepEqual(JSON.parse(ui.storage.get(pendingKey)), original);
  assert.equal(ui.element('finish').disabled, true);
  await Promise.all([ui.dispatch('retry'), ui.dispatch('retry')]);
  const posts = ui.requests.filter(row => row.method === 'POST');
  assert.equal(posts.length, 2); posts.forEach(row => assert.deepEqual(row.body, original.envelope));
  assert.equal(ui.uuidCount, 0); assert.equal(ui.storage.has(pendingKey), false);
  assert.match(ui.element('notice').textContent, /No duplicate/);
});

test('Actor新動作先保存request再傳送；連按同一按鈕僅一次效果請求', async () => {
  const ui = await boot({ replies: [snapshot(), { view: snapshot({ revision: 2 }), replayed: false }],
    onRequest(request, storage) {
      if (request.method === 'POST') assert.deepEqual(JSON.parse(storage.get(pendingKey)).envelope, request.body);
    } });
  const action = ui.element('actions').children[0];
  await Promise.all([ui.dispatchElement(action), ui.dispatchElement(action)]);
  assert.equal(ui.requests.filter(row => row.method === 'POST').length, 1);
  assert.equal(ui.uuidCount, 1); assert.equal(ui.storage.has(pendingKey), false);
});

test('Actor 4xx清pending並讀回；讀回失敗時禁止從舊狀態產生新動作', async () => {
  const ui = await boot({ savedPending: original, replies: [snapshot(),
    { httpStatus: 409, body: { error: 'REVISION_MISMATCH' } }, new Error('READ_UNAVAILABLE'), snapshot({ revision: 8 })] });
  await ui.dispatch('retry');
  assert.equal(ui.storage.has(pendingKey), false); assert.equal(ui.element('finish').disabled, true);
  await ui.dispatch('finish');
  assert.deepEqual(ui.requests.map(row => row.method), ['GET', 'POST', 'GET']);
  assert.equal(ui.uuidCount, 0);
  await ui.dispatch('refresh'); assert.equal(ui.element('finish').disabled, false);
});

test('Actor withdrawal先確認原結果，再用最新revision送出一次退出', async () => {
  const ui = await boot({ savedPending: original, replies: [snapshot(), { view: snapshot({ revision: 2 }), replayed: true },
    { view: snapshot({ revision: 3, phase: 'WITHDRAWN', debrief: { actualComplete: false, message: 'Session ended.' } }), replayed: false }] });
  await Promise.all([ui.dispatch('withdraw'), ui.dispatch('withdraw')]);
  const posts = ui.requests.filter(row => row.method === 'POST');
  assert.equal(posts.length, 2); assert.deepEqual(posts[0].body, original.envelope);
  assert.deepEqual(posts[1].body.command, { type: 'withdraw' }); assert.equal(posts[1].body.expectedRevision, 2);
  assert.equal(ui.uuidCount, 1); assert.equal(ui.element('terminal').hidden, false);
});

test('Actor withdrawal遇未知原結果不新增退出，並說明可停止參與', async () => {
  const ui = await boot({ savedPending: original, replies: [snapshot(), new Error('NETWORK_TIMEOUT')] });
  await ui.dispatch('withdraw');
  assert.equal(ui.requests.filter(row => row.method === 'POST').length, 1);
  assert.equal(ui.uuidCount, 0); assert.deepEqual(JSON.parse(ui.storage.get(pendingKey)), original);
  assert.match(ui.element('notice').textContent, /stop and close this page/);
});

test('Actor錯誤完成宣告保持ACTIVE、明示GOAL_NOT_MET；終止後handler也拒絕新動作', async () => {
  const denied = snapshot({ revision: 2, lastResult: { outcome: 'GOAL_NOT_MET', message: 'Catalogue entry absent.', actionId: null, actualComplete: false } });
  const ui = await boot({ replies: [snapshot(), { view: denied, replayed: false }, snapshot({ phase: 'FINISHED', revision: 3,
    goal: { text: 'Catalogue goal', achieved: true }, debrief: { actualComplete: true, message: 'Complete.' } })] });
  await ui.dispatch('finish');
  assert.equal(ui.requests[1].body.command.type, 'finish');
  assert.equal(ui.element('result-heading').textContent, 'GOAL_NOT_MET');
  assert.match(ui.element('notice').textContent, /Completion claim not confirmed/);
  assert.equal(ui.element('closing').hidden, false); assert.equal(ui.element('finish').disabled, false);
  await ui.dispatch('refresh');
  await ui.dispatch('finish'); await ui.dispatch('withdraw');
  assert.equal(ui.requests.length, 3); assert.equal(ui.element('terminal').hidden, false);
});

test('Actor pending無法寫入sessionStorage時不可傳送或捏造已保存', async () => {
  const ui = await boot({ replies: [snapshot()], failPendingStorage: true });
  await ui.dispatch('finish');
  assert.equal(ui.requests.length, 1); assert.equal(ui.element('finish').disabled, true);
  assert.match(ui.element('notice').textContent, /No new operation was sent/);
});

test('Observer缺少valid或lag時明示未知，不把空記錄或false goal寫為成功', async () => {
  const ui = await boot({ role: 'observer', replies: [observation()] });
  assert.match(ui.element('verification-title').textContent, /unavailable or incomplete/);
  assert.match(ui.element('lag').textContent, /lag is unknown/);
  assert.equal(ui.element('actual-goal').textContent, 'Not met');
  assert.match(allText(ui.element('claim-comparison')), /No completion claim/);
  assert.equal(ui.storage.get('dungeonq-topology-observer'), 'synthetic-token');
  assert.equal(ui.storage.has('dungeonq-topology-actor'), false);
});

test('Observer局部成功、完成宣告與實際goal分開呈現；重播數量不符不通過', async () => {
  const events = [
    { sequence: 1, command: { type: 'visit', sceneId: 'preview' }, observation: { outcome: 'SUCCESS', message: 'Opened preview.' } },
    { sequence: 2, command: { type: 'act', actionId: 'render-preview' }, observation: { outcome: 'SUCCESS', message: 'Preview saved.' } },
    { sequence: 3, command: { type: 'finish' }, observation: { outcome: 'GOAL_NOT_MET', message: 'Not published.', actualComplete: false } },
  ];
  const data = observation({ events, lag: 0, verification: { valid: true, eventCount: 3 },
    summary: { ...observation().summary, localSuccesses: 1, wrongCompletionClaims: 1,
      completionClaims: [{ sequence: 3, claimedComplete: true, actualComplete: false }] } });
  const ui = await boot({ role: 'observer', replies: [data, { ...data, verification: { valid: true, eventCount: 2 } }] });
  assert.equal(ui.element('verification-title').textContent, 'Received sequence replayed');
  assert.equal(ui.element('local-successes').textContent, '1');
  assert.equal(ui.element('actual-goal').textContent, 'Not met');
  assert.equal(ui.element('success-chain').children.length, 1);
  assert.match(allText(ui.element('claim-comparison')), /server refused completion/);
  assert.match(ui.element('lag').textContent, /relative to/);
  await ui.dispatch('refresh'); assert.match(ui.element('verification-title').textContent, /incomplete/);
});

test('Observer更新失敗標示stale，不能保留passed標示或下載可用狀態', async () => {
  const ui = await boot({ role: 'observer', replies: [observation({ verification: { valid: true, eventCount: 0 } }), new Error('OBSERVER_OFFLINE')] });
  await ui.dispatch('refresh');
  assert.equal(ui.element('verification-title').textContent, 'Latest verification unknown');
  assert.match(ui.element('verification-detail').textContent, /may be stale/);
  assert.equal(ui.element('download').disabled, true);
  await ui.dispatch('download'); assert.equal(ui.requests.length, 2);
});

test('Observer僅由專用認證endpoint下載完整bundle，filename不接受路徑', async () => {
  const ui = await boot({ role: 'observer', replies: [observation(),
    { schemaVersion: 'dungeonq.topology-evidence/v2', worldId: '../../synthetic', events: [] }] });
  await ui.dispatch('download');
  assert.equal(ui.requests[1].path, '/api/evidence');
  assert.equal(ui.downloads.length, 1); assert.doesNotMatch(ui.downloads[0].download, /[/.]{2}|\//);
  assert.match(ui.element('notice').textContent, /researcher-only information/);
});

test('Actor與真實v2 projection整合：當地未知、catalogue誠實讀回、訪視只送宣告scene', async () => {
  const state = createTopology({ worldId: 'test-world', epoch: 'test-epoch', participantMode: 'UI_CHECK' });
  const initial = projectTopology(state);
  const next = advanceTopology(state, { type: 'visit', sceneId: 'catalogue' });
  const ui = await boot({ replies: [initial, { view: next.view, replayed: false }] });
  assert.equal(ui.element('goal-state').textContent, 'Not observed here');
  const catalogueButton = ui.element('scenes').children.find(button => button.textContent === 'Visitor catalogue');
  assert.ok(catalogueButton);
  await ui.dispatchElement(catalogueButton);
  assert.deepEqual(ui.requests[1].body.command, { type: 'visit', sceneId: 'catalogue' });
  assert.equal(ui.element('scene-title').textContent, 'Visitor catalogue');
  assert.equal(ui.element('goal-state').textContent, 'Absent from catalogue');
  assert.match(allText(ui.element('catalogue')), /No entries/);
});
