import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createServer } from 'node:http';
import { createRuntimeClient, evidenceState } from '../sdk/runtime-client.mjs';

const control = () => ({ schemaVersion: 'dungeonq.pitch-control/v1', incidents: [
  { incidentId: 'incident-one', contextId: 'ctx-one', worldId: 'world-one', epoch: 1,
    phase: 'ADMITTED', admittedAt: 1000, enteredAt: null, localInbox: 'AVAILABLE', acknowledgement: null, resolution: null },
], outbox: [{ incidentId: 'incident-one', status: 'PENDING', attempts: 0 }] });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function panel(t, { pitching = true } = {}) {
  const source = await readFile(new URL('../public/runtime/app.mjs', import.meta.url), 'utf8');
  const elements = new Map(); const timers = new Map(); const requests = []; let timerId = 0;
  const document = { activeElement: null };
  const create = tag => ({ tagName: tag, textContent: '', children: [], dataset: {}, hidden: false, disabled: false,
    value: '', checked: false, listeners: new Map(), append(...rows) { this.children.push(...rows); },
    replaceChildren(...rows) { this.children = rows; }, addEventListener(name, fn) { this.listeners.set(name, fn); },
    focus() { document.activeElement = this; } });
  const element = id => { if (!elements.has(id)) elements.set(id, create('div')); return elements.get(id); };
  Object.assign(document, { getElementById: element, createElement: create });
  let snapshot = control(); let heldPath; let held; let failPath; let failureStatus = 503;
  const respond = (path, input) => {
    if (path === '/api/status') return { contexts: [], worlds: [], observations: [], capabilities: [], limitations: [], pitching: pitching ? snapshot : null };
    if (path === '/api/pitching/status') return snapshot;
    if (path === '/api/pitching/ack') snapshot.incidents[0].acknowledgement = { operatorId: 'owner', at: 2000 };
    if (path === '/api/pitching/resolve') snapshot.incidents[0].resolution = { operatorId: 'owner', at: 3000, resolution: input.resolution };
    return path.startsWith('/api/pitching/') ? snapshot.incidents[0] : { capabilities: [] };
  };
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname; const input = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ path, input, authorization: options.headers.Authorization });
    if (path === heldPath) {
      heldPath = null;
      return new Promise(resolve => { held = () => resolve(Response.json(respond(path, input))); });
    }
    if (path === failPath) { failPath = null; return Response.json({ error: { code: failureStatus === 403 ? 'PERMISSION_DENIED' : 'PITCH_UNAVAILABLE' } }, { status: failureStatus }); }
    return Response.json(respond(path, input));
  };
  const window = create('window');
  runInNewContext(source.replace(/^import .*?;\n/, 'const { createRuntimeClient, evidenceState } = injected;\n'), {
    injected: { createRuntimeClient: options => createRuntimeClient({ ...options, fetch: fetcher }), evidenceState },
    document, window, location: { origin: 'http://127.0.0.1:1' },
    setTimeout(fn, ms) { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout(id) { timers.delete(id); },
  });
  const dispatch = async (target, event = 'click') => { (typeof target === 'string' ? element(target) : target).listeners.get(event)({ preventDefault() {} }); await tick(); };
  const walk = item => [item, ...item.children.flatMap(walk)];
  const text = id => walk(element(id)).map(row => row.textContent).join('\n');
  t.after(() => window.listeners.get('pagehide')());
  return { element, requests, timers, dispatch, text, document,
    connect: async () => { element('operator-token').value = 'synthetic-owner'; await dispatch('connect-form', 'submit'); },
    control: id => walk(element('pitch-incidents')).find(row => row.dataset.pitchControl === id),
    async poll() { const entry = [...timers].find(([, value]) => value.ms === 3000); assert.ok(entry, 'poll is scheduled'); timers.delete(entry[0]); entry[1].fn(); await tick(); },
    hold(path) { heldPath = path; }, async release() { held(); await tick(); },
    setSnapshot(value) { snapshot = value; }, snapshot: () => snapshot,
    fail(path, status = 503) { failPath = path; failureStatus = status; },
  };
}

test('Owner SDK uses authenticated exact pitching endpoints and refuses disconnected I/O', async t => {
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    calls.push({ method: req.method, path: req.url, token: req.headers.authorization, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ incidentId: 'i-one' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const client = createRuntimeClient({ origin: `http://127.0.0.1:${server.address().port}`, token: 'synthetic-owner' });
  await client.pitchStatus(); await client.acknowledgeIncident({ incidentId: 'i-one', operatorId: 'untrusted' });
  await client.resolveIncident({ incidentId: 'i-one', resolution: 'REVIEWED', operatorId: 'untrusted' });
  assert.deepEqual(calls.map(({ method, path, body }) => ({ method, path, body })), [
    { method: 'GET', path: '/api/pitching/status', body: null },
    { method: 'POST', path: '/api/pitching/ack', body: { incidentId: 'i-one' } },
    { method: 'POST', path: '/api/pitching/resolve', body: { incidentId: 'i-one', resolution: 'REVIEWED' } },
  ]);
  assert.ok(calls.every(call => call.token === 'Bearer synthetic-owner'));
  client.disconnect(); await assert.rejects(client.pitchStatus(), { code: 'AUTH_REQUIRED' });
  await assert.rejects(client.acknowledgeIncident({ incidentId: 'i-one' }), { code: 'AUTH_REQUIRED' });
  assert.equal(calls.length, 3);
});

test('inbox preserves admission, delivery and human states; mutations require explicit actions', async t => {
  const ui = await panel(t); await ui.connect();
  assert.match(ui.text('pitch-incidents'), /ADMITTED.*已保留/); assert.match(ui.text('pitch-incidents'), /PENDING/);
  assert.match(ui.text('pitch-incidents'), /本機已保存/); assert.equal(ui.element('grant-mutation-option').disabled, true);
  assert.equal(ui.control('resolve:incident-one').disabled, true);
  ui.element('context').value = 'ctx-one'; ui.element('action').value = 'GRANT_MUTATION'; await ui.dispatch('preview-form', 'submit');
  assert.equal(ui.requests.filter(call => call.path === '/api/policy/preview').length, 0);
  await ui.dispatch(ui.control('ack:incident-one'));
  assert.equal(ui.control('ack:incident-one').disabled, true); assert.equal(ui.control('resolve:incident-one').disabled, false);
  await ui.dispatch(ui.control('resolve:incident-one')); assert.equal(ui.requests.filter(call => call.path === '/api/pitching/resolve').length, 0);
  ui.control('resolution:incident-one').value = 'FALSE_POSITIVE'; await ui.dispatch(ui.control('resolve:incident-one'));
  assert.match(ui.text('pitch-incidents'), /已判定誤報/); assert.equal(ui.control('resolve:incident-one').disabled, true);
  assert.equal(ui.requests.filter(call => call.path === '/api/pitching/ack').length, 1);
  assert.equal(ui.requests.filter(call => call.path === '/api/pitching/resolve').length, 1);
});

test('3 second polling is private, does not rebuild unchanged controls, and never promotes external acceptance to read receipt', async t => {
  const ui = await panel(t); assert.equal(ui.timers.size, 0); await ui.connect();
  const focused = ui.control('ack:incident-one'); focused.focus(); await ui.poll();
  assert.equal(ui.control('ack:incident-one'), focused); assert.equal(ui.document.activeElement, focused);
  ui.snapshot().incidents[0].phase = 'ENTERED'; ui.snapshot().incidents[0].enteredAt = 1500;
  ui.snapshot().outbox[0].status = 'ACCEPTED'; ui.snapshot().outbox[0].attempts = 1;
  await ui.poll(); assert.match(ui.text('pitch-incidents'), /ENTERED.*已記錄進入/);
  assert.match(ui.text('pitch-incidents'), /非收件匣送達或已讀/); assert.equal(ui.control('ack:incident-one').disabled, false);
  ui.snapshot().outbox[0].status = 'UNKNOWN'; await ui.poll(); assert.match(ui.text('pitch-incidents'), /UNKNOWN.*待對帳/);
  assert.ok(ui.requests.filter(call => call.path === '/api/pitching/status').every(call => call.authorization === 'Bearer synthetic-owner'));
  await ui.dispatch('disconnect'); assert.equal(ui.timers.size, 0); assert.equal(ui.element('pitching').hidden, true);
  assert.equal(ui.text('pitch-incidents'), ''); assert.equal(ui.text('pitch-summary'), '');
});

test('late poll, acknowledgement and connect responses cannot repopulate a disconnected session', async t => {
  const ui = await panel(t); await ui.connect();
  ui.hold('/api/pitching/status'); await ui.poll(); await ui.dispatch('disconnect'); await ui.release();
  assert.equal(ui.text('pitch-incidents'), ''); assert.equal(ui.timers.size, 0);
  await ui.connect(); ui.hold('/api/pitching/ack'); await ui.dispatch(ui.control('ack:incident-one'));
  await ui.dispatch('disconnect'); await ui.release(); assert.equal(ui.text('pitch-incidents'), '');
  ui.hold('/api/status'); await ui.connect(); await ui.dispatch('disconnect'); await ui.release();
  assert.equal(ui.element('connection-state').textContent, 'Disconnected'); assert.equal(ui.timers.size, 0);
});

test('old poll failure cannot clear a new session and auth loss clears the current inbox', async t => {
  const ui = await panel(t); await ui.connect(); ui.hold('/api/pitching/status'); await ui.poll();
  await ui.dispatch('disconnect'); await ui.connect(); await ui.release();
  assert.equal(ui.element('pitching').hidden, false); assert.equal(ui.element('connection-state').textContent, 'Operator connected');
  ui.fail('/api/pitching/status', 403); await ui.poll();
  assert.equal(ui.element('pitching').hidden, true); assert.equal(ui.text('pitch-incidents'), ''); assert.equal(ui.timers.size, 0);
});

test('uncertain acknowledgement is not resent; non-pitching profile keeps the legacy grant and has no polling', async t => {
  const ui = await panel(t); await ui.connect(); ui.fail('/api/pitching/ack'); await ui.dispatch(ui.control('ack:incident-one'));
  assert.equal(ui.requests.filter(call => call.path === '/api/pitching/ack').length, 1);
  assert.equal(ui.element('pitching').hidden, true); assert.equal(ui.text('pitch-incidents'), ''); assert.equal(ui.timers.size, 0);
  const legacy = await panel(t, { pitching: false }); await legacy.connect();
  assert.equal(legacy.element('grant-mutation-option').disabled, false); assert.equal(legacy.element('pitching').hidden, true);
  assert.equal(legacy.timers.size, 0); assert.equal(legacy.requests.some(call => call.path.startsWith('/api/pitching/')), false);
});

test('untrusted fields stay text and the inbox has labels without executable markup or external navigation', async t => {
  const ui = await panel(t); ui.snapshot().incidents[0].contextId = '<img src=x onerror=alert(1)>'; await ui.connect();
  assert.match(ui.text('pitch-incidents'), /<img src=x onerror=alert\(1\)>/);
  const js = await readFile(new URL('../public/runtime/app.mjs', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/runtime/index.html', import.meta.url), 'utf8');
  assert.match(html, /lang="zh-Hant" aria-labelledby="pitch-heading"/);
  assert.match(html, /id="pitch-summary" role="status" aria-live="polite"/);
  assert.doesNotMatch(js + html, /\.innerHTML|\.outerHTML|document\.write|localStorage|sessionStorage|href="https?:/);
  assert.match(js, /label\.htmlFor = select\.id/);
});
