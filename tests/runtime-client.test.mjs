import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createRuntimeClient, RuntimeError, evidenceState } from '../sdk/runtime-client.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureToken = 'synthetic-reference-operator-token';
const status = { schemaVersion: 'dungeonq.runtime-status/v1', profile: 'LOCAL_INTEGRATION_REFERENCE',
  contexts: [{ contextId: 'ctx-one', tenantId: 'tenant-one', worldId: 'world-one', epoch: 1, disposition: 'ALLOW', state: 'ACTIVE' }],
  worlds: [{ worldId: 'world-one', revision: 0, records: [] }], capabilities: [{ id: 'local', state: 'READY' }], limitations: [] };
const evidence = { schemaVersion: 'dungeonq.runtime-evidence/v1', status: 'PASS',
  checks: [{ id: 'scope', status: 'PASS', detail: 'Synthetic scope checked.' }], events: [], scope: { profile: 'LOCAL_INTEGRATION_REFERENCE' }, limitations: [] };

async function serverFixture(t, route) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    const call = { path: req.url, method: req.method, authorization: req.headers.authorization, body: text ? JSON.parse(text) : undefined };
    requests.push(call);
    const reply = await route(call);
    if (reply?.drop) { res.destroy(); return; }
    res.writeHead(reply?.status ?? 200, { 'Content-Type': 'application/json', ...reply?.headers });
    res.end(reply?.raw ?? JSON.stringify(reply?.body ?? {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

test('runtime client separates public readiness from authenticated reads and exact operation identity', async t => {
  const f = await serverFixture(t, call => ({ body: call.path === '/api/capabilities' ? { capabilities: [] }
    : call.path === '/api/status' ? status : call.path === '/api/evidence' ? evidence : { requestId: call.body.requestId, replayed: false } }));
  const client = createRuntimeClient({ origin: f.origin, token: fixtureToken });
  await client.capabilities(); assert.equal(f.requests[0].authorization, undefined);
  assert.deepEqual(await client.status(), status); assert.deepEqual(await client.evidence(), evidence);
  const operation = { requestId: 'operation-one', operation: 'write', args: { key: 'order', value: 3, expectedRevision: 0 } };
  await client.operate(operation);
  assert.deepEqual(f.requests.at(-1).body, operation);
  assert.equal(f.requests.at(-1).authorization, `Bearer ${fixtureToken}`);
  assert.equal(f.requests.at(-1).method, 'POST');
  assert.ok(f.requests.every(call => !call.path.includes(fixtureToken)));
});

test('runtime client reconnect replaces authority and disconnect refuses private requests before I/O', async t => {
  const f = await serverFixture(t, () => ({ body: status }));
  const client = createRuntimeClient({ origin: f.origin, token: fixtureToken });
  await client.status(); client.setToken('synthetic-second-owner'); await client.status(); client.disconnect();
  await assert.rejects(client.status(), { code: 'AUTH_REQUIRED' });
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].authorization, 'Bearer synthetic-second-owner');
  assert.equal(JSON.stringify(client).includes(fixtureToken), false);
});

test('runtime client preserves safe error codes without exposing server detail and never retries', async t => {
  const f = await serverFixture(t, () => ({ status: 403, body: { error: { code: 'SCOPE_DENIED', message: `private ${fixtureToken}` }, requestId: 'trace-one' } }));
  const client = createRuntimeClient({ origin: f.origin, token: fixtureToken });
  await assert.rejects(client.status(), error => error instanceof RuntimeError && error.code === 'SCOPE_DENIED'
    && error.status === 403 && error.requestId === 'trace-one' && !String(error).includes(fixtureToken));
  assert.equal(f.requests.length, 1);
});

test('runtime client marks lost mutation replies uncertain and sends explicit apply only', async t => {
  const f = await serverFixture(t, () => ({ drop: true }));
  const client = createRuntimeClient({ origin: f.origin, token: fixtureToken });
  assert.throws(() => client.apply({ proposalId: 'p-one', digest: 'a'.repeat(64), confirmation: 'yes' }), { code: 'EXPLICIT_CONFIRMATION_REQUIRED' });
  await assert.rejects(client.apply({ proposalId: 'p-one', digest: 'a'.repeat(64), confirmation: 'APPLY' }), error => error.uncertain === true);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.confirmation, 'APPLY');
});

test('runtime client refuses redirects, malformed replies and unsafe origins', async t => {
  let destinationCalls = 0;
  const f = await serverFixture(t, call => {
    if (call.path === '/api/status') return { status: 302, headers: { Location: '/destination' }, body: {} };
    if (call.path === '/destination') destinationCalls++;
    return { raw: '<html>private server detail</html>' };
  });
  const client = createRuntimeClient({ origin: f.origin, token: fixtureToken });
  await assert.rejects(client.status(), { code: 'CONNECTION_UNAVAILABLE' }); assert.equal(destinationCalls, 0);
  await assert.rejects(client.evidence(), { code: 'INVALID_RESPONSE' });
  for (const origin of ['http://outside.example', 'file:///tmp/server', `${f.origin}/api`, `${f.origin}?token=x`, 'https://user:password@example.test']) {
    assert.throws(() => createRuntimeClient({ origin }), { code: 'INVALID_RUNTIME_ORIGIN' });
  }
});

test('an obsolete session response cannot be delivered after reconnect', async () => {
  let release;
  const client = createRuntimeClient({ origin: 'http://127.0.0.1:1', token: fixtureToken,
    fetch: () => new Promise(resolve => { release = () => resolve(Response.json(status)); }) });
  const pending = client.status(); client.setToken('new-synthetic-token'); release();
  await assert.rejects(pending, { code: 'SESSION_CHANGED' });
});

test('streamed response budget and timeout stop a read without exposing its content', async () => {
  let canceled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1_048_577)); }, cancel() { canceled = true; } });
  const client = createRuntimeClient({ origin: 'http://127.0.0.1:1', token: fixtureToken, fetch: async () => new Response(body) });
  await assert.rejects(client.status(), { code: 'RESPONSE_TOO_LARGE' }); assert.equal(canceled, true);
  const timed = createRuntimeClient({ origin: 'http://127.0.0.1:1', token: fixtureToken, timeoutMs: 5,
    fetch: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('local-only timeout detail')))) });
  await assert.rejects(timed.status(), { code: 'REQUEST_TIMEOUT' });
});

test('evidence display does not turn missing, mixed or failed checks into verification', () => {
  for (const value of [undefined, {}, { status: 'SUCCESS' }, { status: 'PASS', checks: [] }, { status: 'PASS', checks: [{}] }, { status: 'PASS', checks: {} }]) assert.equal(evidenceState(value), 'INCONCLUSIVE');
  assert.equal(evidenceState({ status: 'PASS', checks: [{ status: 'FAIL' }] }), 'FAIL');
  assert.equal(evidenceState(evidence), 'PASS'); assert.equal(evidenceState({ status: 'FAIL' }), 'FAIL');
});

test('runtime CLI reads only the selected environment credential and emits a bounded error envelope', async t => {
  const f = await serverFixture(t, call => call.path === '/api/evidence' ? { status: 401, body: { error: { code: 'AUTH_REQUIRED', message: fixtureToken } } } : { body: { capabilities: [] } });
  const env = { ...process.env, DUNGEONQ_RUNTIME_URL: f.origin, DUNGEONQ_OPERATOR_TOKEN: fixtureToken };
  const publicResult = await exec(process.execPath, ['cli/runtime.mjs', 'capabilities'], { cwd: root, env });
  assert.deepEqual(JSON.parse(publicResult.stdout), { capabilities: [] }); assert.equal(f.requests[0].authorization, undefined);
  await assert.rejects(exec(process.execPath, ['cli/runtime.mjs', 'evidence'], { cwd: root, env }), error => {
    assert.equal(error.stdout, ''); assert.equal(JSON.parse(error.stderr).error.code, 'AUTH_REQUIRED');
    assert.ok(!error.stderr.includes(fixtureToken)); return error.code === 1;
  });
  assert.equal(f.requests.at(-1).authorization, `Bearer ${fixtureToken}`);
});

test('Python SDK uses the same HTTP contract, reconnect and redacted error semantics', async t => {
  const f = await serverFixture(t, call => call.path === '/api/evidence'
    ? { status: 403, body: { error: { code: 'SCOPE_DENIED', message: fixtureToken } } }
    : { body: call.path === '/api/status' ? status : { capabilities: [] } });
  const script = `import importlib.util, os, json\nspec = importlib.util.spec_from_file_location("dq_runtime", "sdk/runtime-client.py")\nm = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\nc = m.RuntimeClient(os.environ["DUNGEONQ_RUNTIME_URL"], os.environ["DUNGEONQ_OPERATOR_TOKEN"])\nc.capabilities()\nc.status()\nc.set_token("python-second-owner")\nc.status()\ntry:\n c.evidence()\nexcept m.RuntimeError as e:\n assert e.code == "SCOPE_DENIED" and e.status == 403\n assert os.environ["DUNGEONQ_OPERATOR_TOKEN"] not in str(e)\nc.disconnect()\ntry:\n c.status()\nexcept m.RuntimeError as e:\n assert e.code == "AUTH_REQUIRED"\nelse:\n raise AssertionError("disconnected request allowed")\nassert m.evidence_state({"status":"PASS","checks":[]}) == "INCONCLUSIVE"\nprint(json.dumps({"passed": True}))\n`;
  const result = await exec(process.env.DUNGEONQ_TEST_PYTHON ?? 'python3', ['-B', '-c', script], { cwd: root,
    env: { ...process.env, DUNGEONQ_RUNTIME_URL: f.origin, DUNGEONQ_OPERATOR_TOKEN: fixtureToken } });
  assert.equal(JSON.parse(result.stdout).passed, true); assert.equal(f.requests[0].authorization, undefined);
  assert.equal(f.requests[2].authorization, 'Bearer python-second-owner'); assert.equal(f.requests.length, 4);
});

async function panelFixture({ panelStatus = status, panelEvidence = evidence } = {}) {
  const source = await readFile(new URL('../public/runtime/app.mjs', import.meta.url), 'utf8');
  const elements = new Map(); const requests = []; let loseApply = false; const failures = new Map();
  const create = tag => ({ tagName: tag, textContent: '', children: [], dataset: {}, hidden: false, disabled: false, value: '', checked: false,
    listeners: new Map(), append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    addEventListener(name, handler) { this.listeners.set(name, handler); }, focus() { this.focused = true; } });
  const element = id => { if (!elements.has(id)) elements.set(id, create('div')); return elements.get(id); };
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname; const body = options.body ? JSON.parse(options.body) : undefined; requests.push({ path, body });
    if (path === '/api/policy/apply' && loseApply) throw Error('synthetic lost reply');
    if (failures.has(path)) { const failed = failures.get(path); failures.delete(path); return Response.json({ error: { code: failed.code } }, { status: failed.status }); }
    return Response.json(path === '/api/status' ? panelStatus : path === '/api/evidence' ? panelEvidence : path === '/api/policy/preview'
      ? { ...body, proposalId: 'proposal-one', digest: 'a'.repeat(64), expiresAt: Date.now() + 60000, changes: ['Fence context'], warnings: [] }
      : path === '/api/policy/apply' ? { proposalId: body.proposalId, state: 'APPLIED', readback: { state: 'FENCED' } } : { capabilities: [] });
  };
  const window = create('window');
  const injected = { createRuntimeClient: options => createRuntimeClient({ ...options, fetch: fetcher }), evidenceState };
  await runInNewContext(source.replace(/^import .*?;\n/, 'const { createRuntimeClient, evidenceState } = injected;\n'), {
    injected, document: { getElementById: element, createElement: create }, location: { origin: 'http://127.0.0.1:1' }, window,
    Date, JSON, Number, String, Array, Math, setTimeout, clearTimeout,
  });
  const dispatch = async (id, event = 'click') => { element(id).listeners.get(event)({ preventDefault() {} }); await new Promise(resolve => setImmediate(resolve)); };
  const rendered = item => [item.textContent, ...item.children.map(rendered)].join('\n');
  return { element, requests, dispatch, rendered: id => rendered(element(id)), loseReply() { loseApply = true; },
    failNext(path, code, status = 503) { failures.set(path, { code, status }); },
    setStatus(value) { panelStatus = value; }, setEvidence(value) { panelEvidence = value; },
    close() { window.listeners.get('pagehide')(); } };
}

test('operator panel requires preview then explicit confirmation; lost apply reply is not resent and disconnect clears views', async t => {
  const ui = await panelFixture(); t.after(() => ui.close());
  ui.element('operator-token').value = fixtureToken; await ui.dispatch('connect-form', 'submit');
  assert.equal(ui.element('operator-token').value, ''); assert.equal(ui.element('private-state').hidden, false);
  ui.element('context').value = 'ctx-one'; ui.element('action').value = 'FENCE'; await ui.dispatch('preview-form', 'submit');
  assert.equal(ui.element('proposal').hidden, false); assert.equal(ui.element('apply').disabled, true);
  assert.equal(ui.requests.some(row => row.path === '/api/policy/apply'), false);
  await ui.dispatch('apply-form', 'submit'); assert.equal(ui.requests.some(row => row.path === '/api/policy/apply'), false);
  ui.element('confirm').checked = true; await ui.dispatch('confirm', 'change'); assert.equal(ui.element('apply').disabled, false);
  ui.loseReply(); await ui.dispatch('apply-form', 'submit'); await ui.dispatch('apply-form', 'submit');
  assert.equal(ui.requests.filter(row => row.path === '/api/policy/apply').length, 1);
  assert.match(ui.element('message').textContent, /uncertain/); assert.equal(ui.element('apply').disabled, true);
  assert.equal(ui.element('private-state').hidden, true); assert.equal(ui.element('worlds').children.length, 0);
  assert.equal(ui.element('preview').disabled, true);
  await ui.dispatch('read-evidence'); assert.equal(ui.element('evidence-state').textContent, 'Verified within scope');
  await ui.dispatch('disconnect'); assert.equal(ui.element('private-state').hidden, true);
  assert.equal(ui.element('evidence-state').textContent, 'Not verified'); assert.equal(ui.element('contexts').children.length, 0);
});

test('operator reads actual records and observations, filters tenant/world exactly, and keeps the policy target independent', async t => {
  const panelStatus = { ...status, contexts: [
    { ...status.contexts[0], tenantId: 'tenant-one', worldId: 'shared-name' },
    { ...status.contexts[0], contextId: 'ctx-two', tenantId: 'tenant-two', worldId: 'shared-name' },
  ], worlds: [
    { tenantId: 'tenant-one', worldId: 'shared-name', revision: 2, records: [
      { key: 'review', revision: 2, value: 'First line\nSecond line <img src=x onerror=alert(1)>' },
      { key: 'metadata', revision: 1, value: { note: 'visible note', token: 'do-not-render-token' } },
      { key: 'private-key-secret', revision: 1, value: 'do-not-render-secret' },
    ] },
    { tenantId: 'tenant-two', worldId: 'shared-name', revision: 7, records: [{ key: 'other', revision: 7, value: 'Other tenant record' }] },
  ], observations: [
    { observationId: 'obs-one', contextId: 'ctx-one', requestId: 'request-one', operation: 'write', epoch: 1, worldRevision: 2 },
    { observationId: 'obs-two', contextId: 'ctx-two', requestId: 'request-two', operation: 'use-ticket', epoch: 2, worldRevision: 7, usedBy: 'mutation-two' },
  ] };
  const ui = await panelFixture({ panelStatus }); t.after(() => ui.close());
  ui.element('operator-token').value = fixtureToken; await ui.dispatch('connect-form', 'submit');
  assert.match(ui.rendered('worlds'), /First line\nSecond line <img/);
  assert.match(ui.rendered('worlds'), /Record revision 2/); assert.match(ui.rendered('worlds'), /visible note/);
  assert.doesNotMatch(ui.rendered('worlds'), /do-not-render/);
  ui.element('context').value = 'ctx-two'; ui.element('inspect-context').value = 'ctx-one'; await ui.dispatch('inspect-context', 'change');
  assert.equal(ui.element('context').value, 'ctx-two'); assert.match(ui.rendered('worlds'), /First line/);
  assert.doesNotMatch(ui.rendered('worlds'), /Other tenant record/);
  assert.match(ui.rendered('observations'), /World revision 2/); assert.doesNotMatch(ui.rendered('observations'), /request-two/);
  assert.equal(ui.requests.filter(row => row.path === '/api/policy/apply').length, 0);
  await ui.dispatch('disconnect');
  for (const id of ['worlds', 'observations', 'events']) assert.equal(ui.element(id).children.length, 0);
  assert.equal(ui.element('inspect-context').disabled, true);
});

test('operator correlates complete request identities only and preserves refused, unknown, historical and missing evidence states', async t => {
  const canonical = (contextId, requestId, family, operation = 'write') => ({ sequence: 1, at: 12345, kind: 'EXECUTE', contextId, requestId, family, operation });
  const route = (contextId, requestId, family, outcome = 'SERVED') => ({ eventId: `${contextId}-${family}`, contextId, requestId, family, destination: 'SYNTHETIC', outcome });
  const panelEvidence = { ...evidence, status: 'FAIL', checks: [{ id: 'known', status: 'FAIL', detail: 'Unknown attempt retained.' }],
    canonical: { events: [canonical('ctx-one', 'same', 'http'), canonical('ctx-one', 'canonical-only', 'ssh'),
      { contextId: 'ctx-one', requestId: 'incomplete', kind: 'EXECUTE', sequence: 3, operation: 'read' }] },
    events: [route('ctx-one', 'same', 'http', 'REFUSED'), route('ctx-two', 'same', 'http'), route('ctx-one', 'same', 'mcp'),
      route('ctx-one', 'unknown', 'http', 'UNKNOWN'), route('ctx-one', 'historical', 'http', 'FAILED'),
      { contextId: 'ctx-one', requestId: 'incomplete', outcome: 'SERVED' }] };
  const ui = await panelFixture({ panelEvidence }); t.after(() => ui.close());
  ui.element('operator-token').value = fixtureToken; await ui.dispatch('connect-form', 'submit'); await ui.dispatch('read-evidence');
  const displayed = ui.rendered('events');
  assert.equal(displayed.match(/Shared request identity in both sources/g)?.length, 1);
  assert.match(displayed, /Refused without new effect \(server reported\)/);
  assert.match(displayed, /Outcome unknown — do not repeat the change/);
  assert.match(displayed, /Historical failure — effect not established/);
  assert.match(displayed, /Collector destination: SYNTHETIC/);
  assert.match(displayed, /Canonical record missing/); assert.match(displayed, /No collector record paired/);
  assert.equal(displayed.match(/No complete context \/ request \/ transport identity/g)?.length, 2);
  assert.equal(ui.element('evidence-state').textContent, 'Failed checks');
  ui.element('inspect-context').value = 'ctx-one'; await ui.dispatch('inspect-context', 'change');
  assert.doesNotMatch(ui.rendered('events'), /ctx-two/); assert.match(ui.rendered('events'), /ctx-one \/ same \/ mcp/);
});

test('operator clears stale private readbacks and verification after read failure or lost access, then requires fresh state', async t => {
  const ui = await panelFixture({ panelStatus: { ...status, observations: [{ contextId: 'ctx-one', requestId: 'retained', operation: 'read', worldRevision: 0 }] } });
  t.after(() => ui.close());
  ui.element('operator-token').value = fixtureToken; await ui.dispatch('connect-form', 'submit'); await ui.dispatch('read-evidence');
  assert.equal(ui.element('evidence-state').textContent, 'Verified within scope');
  ui.failNext('/api/evidence', 'EVIDENCE_UNAVAILABLE'); await ui.dispatch('refresh');
  assert.equal(ui.element('evidence-state').textContent, 'Not verified');
  assert.equal(ui.element('private-state').hidden, true); assert.equal(ui.element('evidence-details').hidden, true);
  for (const id of ['worlds', 'observations', 'events', 'contexts']) assert.equal(ui.element(id).children.length, 0);
  assert.equal(ui.element('preview').disabled, true); assert.equal(ui.element('refresh').disabled, false);
  await ui.dispatch('refresh'); assert.equal(ui.element('private-state').hidden, false);
  ui.failNext('/api/status', 'AUTH_REQUIRED', 401); await ui.dispatch('refresh');
  assert.equal(ui.element('connection-state').textContent, 'Disconnected'); assert.equal(ui.element('refresh').disabled, true);
  assert.equal(ui.element('observations').children.length, 0); assert.equal(ui.element('evidence-state').textContent, 'Not verified');
});

test('runtime panel has labeled keyboard controls and uses no credential persistence or HTML injection sinks', async () => {
  const html = await readFile(new URL('../public/runtime/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../public/runtime/app.mjs', import.meta.url), 'utf8');
  assert.match(html, /<html lang="en">/); assert.match(html, /type="password" autocomplete="off"/);
  assert.match(html, /role="status" aria-live="polite" tabindex="-1"/); assert.match(html, /class="skip-link"/);
  assert.doesNotMatch(js + html, /localStorage|sessionStorage|\.innerHTML|\.outerHTML|document\.write|console\.(?:log|error)|location\.search/);
});
