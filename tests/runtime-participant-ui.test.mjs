import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createRuntimeClient, RuntimeError } from '../sdk/runtime-client.mjs';
import { openRuntimeReference } from '../runtime/reference.mjs';
import { request } from '../runtime/transport.mjs';

const source = await readFile(new URL('../public/runtime/participant.mjs', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/runtime/participant.html', import.meta.url), 'utf8');
const actorToken = 'participant-ui-fixture-actor';
const ticketValue = 'A'.repeat(43);
const snapshot = (revision = 0) => ({ revision, records: [
  { key: 'order-41', value: { status: 'awaiting-review' }, revision: 0 },
  { key: 'review-policy', value: 'Shipping approval is a separate process.', revision: 0 },
] });

function fakeServer() {
  let revision = 0; const values = new Map(snapshot().records.map(row => [row.key, row.value]));
  const results = new Map(); let uses = 0;
  return {
    get uses() { return uses; },
    reply(input) {
      if (results.has(input.requestId)) return { ...results.get(input.requestId), replayed: true };
      const { operation, args } = input; let result;
      if (operation === 'snapshot') result = { revision, records: [...values].map(([key, value]) => ({ key, value, revision })) };
      if (operation === 'read') result = { key: args.key, value: values.get(args.key), recordRevision: revision, revision };
      if (operation === 'write') {
        if (args.expectedRevision !== revision) return { error: { code: 'REVISION_CONFLICT' } };
        values.set(args.key, args.value); revision++;
        result = { key: args.key, value: args.value, recordRevision: revision, revision };
      }
      if (operation === 'issue-ticket') result = { ticket: ticketValue, scope: args.scope, issuedAt: Date.now(), expiresAt: Date.now() + 300000, maxUses: 1, revision };
      if (operation === 'use-ticket') {
        uses++; result = { key: args.key, value: values.get(args.key), recordRevision: revision, revision, usesRemaining: 0 };
      }
      results.set(input.requestId, result); return result;
    },
  };
}
async function fixture(t, { origin = 'http://127.0.0.1:1', reply, fetcher } = {}) {
  const elements = new Map(), calls = [], timers = new Set();
  const create = tag => ({ tagName: tag, textContent: '', className: '', children: [], dataset: {}, hidden: false,
    disabled: false, value: '', listeners: new Map(), append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; }, addEventListener(name, handler) { this.listeners.set(name, handler); }, focus() { this.focused = true; } });
  const element = id => {
    assert.match(html, new RegExp(`id="${id}"`), `JS element ${id} exists in the HTML`);
    if (!elements.has(id)) elements.set(id, create('div'));
    return elements.get(id);
  };
  const server = fakeServer();
  const transport = async (url, options) => {
    const input = JSON.parse(options.body); calls.push({ path: new URL(url).pathname, input, serialized: options.body });
    if (fetcher) return fetcher(url, options, input);
    const result = await (reply ? reply(input, server) : server.reply(input));
    return Response.json(result, { status: result.error ? 400 : 200 });
  };
  const page = create('window');
  runInNewContext(source.replace(/^import .*?;\n/, 'const { createRuntimeClient, RuntimeError } = injected;\n'), {
    injected: { createRuntimeClient: options => createRuntimeClient({ ...options, fetch: transport }), RuntimeError },
    document: { getElementById: element, createElement: create }, location: { origin }, window: page,
    crypto: { randomUUID }, Date, JSON, Number, String, Array, Object, Boolean, Math,
    setTimeout(fn, ms) { const handle = setTimeout(fn, ms); timers.add(handle); return handle; },
    clearTimeout(handle) { clearTimeout(handle); timers.delete(handle); },
  });
  const dispatch = async (id, event = 'click') => element(id).listeners.get(event)({ preventDefault() {} });
  const connect = async (token = actorToken) => { element('actor-token').value = token; await dispatch('connect-form', 'submit'); };
  const allText = () => [...elements.values()].map(root => {
    const walk = row => [row.textContent, row.value, ...row.children.flatMap(walk)]; return walk(root).join(' ');
  }).join('\n');
  t.after(() => { page.listeners.get('pagehide')(); for (const timer of timers) clearTimeout(timer); });
  return { element, calls, dispatch, connect, allText, server };
}

test('participant UI performs all five operations through the real HTTP SDK and independently reads a write back', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dq-participant-ui-'));
  const runtime = await openRuntimeReference({ directory, network: false, hostBroker: false, presentation: 'participant-v1' });
  t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  const ui = await fixture(t, { origin: runtime.origin, fetcher: (url, options) => fetch(url, options) });
  await ui.connect(runtime.credentials.actor);
  assert.equal(ui.element('actor-token').value, ''); assert.equal(ui.element('private-state').hidden, false);
  assert.match(ui.element('revision-state').textContent, /revision 0/);
  ui.element('record-key').value = 'review-policy'; await ui.dispatch('read-form', 'submit');
  assert.match(ui.element('record-value').textContent, /Shipping approval is a separate process/);
  ui.element('write-key').value = 'review-findings'; ui.element('write-value').value = 'Order 41 requires shipping approval.';
  await ui.dispatch('write-form', 'submit');
  assert.deepEqual(ui.calls.slice(-2).map(call => call.input.operation), ['write', 'read']);
  assert.equal(ui.element('save-state').textContent, 'Saved value read back');
  const written = await request(runtime.origin, '/api/operate', runtime.credentials.actor,
    { requestId: 'independent-read', operation: 'read', args: { key: 'review-findings' } });
  assert.equal(written.value, 'Order 41 requires shipping approval.'); assert.equal(written.recordRevision, 1);
  ui.element('ticket-key').value = 'order-41'; await ui.dispatch('issue-form', 'submit');
  assert.equal(ui.element('use-ticket').disabled, false); await ui.dispatch('use-ticket');
  assert.equal(ui.element('ticket-result').hidden, false); assert.match(ui.element('ticket-state').textContent, /0 uses remaining/);
  assert.equal(ui.element('use-ticket').disabled, true);
  assert(ui.calls.every(call => call.path === '/api/operate'));
  assert(!ui.allText().includes(runtime.credentials.actor));
  const ticket = ui.calls.find(call => call.input.operation === 'use-ticket').input.args.ticket;
  assert(!ui.allText().includes(ticket));
});

test('lost write response pauses other operations and an explicit retry preserves the complete original request', async t => {
  let drop = true;
  const ui = await fixture(t, { reply(input, server) {
    const result = server.reply(input);
    if (input.operation === 'write' && drop) { drop = false; throw Error('lost private reply'); }
    return result;
  } });
  await ui.connect(); ui.element('write-key').value = 'review-findings'; ui.element('write-value').value = 'First reviewed value';
  await ui.dispatch('write-form', 'submit');
  assert.equal(ui.calls.filter(call => call.input.operation === 'write').length, 1);
  assert.equal(ui.element('uncertain').hidden, false); assert.equal(ui.element('save').disabled, true);
  const count = ui.calls.length;
  ui.element('write-value').value = 'Changed after the lost reply';
  await ui.dispatch('write-form', 'submit'); await ui.dispatch('refresh');
  assert.equal(ui.calls.length, count);
  await ui.dispatch('retry');
  const writes = ui.calls.filter(call => call.input.operation === 'write');
  assert.equal(writes.length, 2); assert.equal(writes[0].serialized, writes[1].serialized);
  assert.equal(ui.element('save-state').textContent, 'Saved value read back');
  assert.equal(ui.element('save-readback').textContent, 'First reviewed value');
  assert.equal(ui.element('uncertain').hidden, true);
});

test('a lost readback retries only that read, never the acknowledged write', async t => {
  let drop = true;
  const ui = await fixture(t, { reply(input, server) {
    if (input.operation === 'read' && input.args.key === 'review-findings' && drop) { drop = false; throw Error('reply lost'); }
    return server.reply(input);
  } });
  await ui.connect(); ui.element('write-key').value = 'review-findings'; ui.element('write-value').value = 'Needs a separate shipping decision';
  await ui.dispatch('write-form', 'submit');
  assert.equal(ui.element('save-state').textContent, 'Write acknowledged; readback pending');
  await ui.dispatch('retry');
  assert.equal(ui.calls.filter(call => call.input.operation === 'write').length, 1);
  const reads = ui.calls.filter(call => call.input.operation === 'read'); assert.equal(reads[0].serialized, reads[1].serialized);
  assert.equal(ui.element('save-state').textContent, 'Saved value read back');
});

test('stale revision requires a new snapshot and preserves the review draft without an automatic write retry', async t => {
  let conflict = true;
  const ui = await fixture(t, { reply(input, server) {
    if (input.operation === 'write' && conflict) return { error: { code: 'REVISION_CONFLICT' } };
    return server.reply(input);
  } });
  await ui.connect(); ui.element('write-key').value = 'review-findings'; ui.element('write-value').value = 'Keep my draft';
  await ui.dispatch('write-form', 'submit');
  assert.equal(ui.element('save').disabled, true); assert.equal(ui.element('uncertain').hidden, true);
  assert.equal(ui.element('write-value').value, 'Keep my draft');
  await ui.dispatch('read-form', 'submit'); assert.equal(ui.element('save').disabled, true);
  const oldWrite = ui.calls.find(call => call.input.operation === 'write');
  conflict = false; await ui.dispatch('refresh'); assert.equal(ui.element('save').disabled, false);
  await ui.dispatch('write-form', 'submit');
  const writes = ui.calls.filter(call => call.input.operation === 'write');
  assert.equal(writes.length, 2); assert.notEqual(oldWrite.input.requestId, writes[1].input.requestId);
});

test('ticket retry keeps its opaque value out of rendered state and does not consume twice', async t => {
  let drop = true;
  const ui = await fixture(t, { reply(input, server) {
    const value = server.reply(input);
    if (input.operation === 'use-ticket' && drop) { drop = false; throw Error('dropped ticket reply'); }
    return value;
  } });
  await ui.connect(); await ui.dispatch('issue-form', 'submit');
  assert(!ui.allText().includes(ticketValue)); await ui.dispatch('use-ticket');
  assert.equal(ui.element('uncertain').hidden, false); assert(!ui.allText().includes(ticketValue));
  await ui.dispatch('retry'); assert.equal(ui.server.uses, 1);
  const uses = ui.calls.filter(call => call.input.operation === 'use-ticket'); assert.equal(uses[0].serialized, uses[1].serialized);
  assert(!ui.allText().includes(ticketValue)); assert.equal(ui.element('use-ticket').disabled, true);
});

test('disconnect and access loss erase loaded records, notes and ticket', async t => {
  let fenced = false;
  const ui = await fixture(t, { reply(input, server) { return fenced ? { error: { code: 'CONTEXT_FENCED' } } : server.reply(input); } });
  await ui.connect(); await ui.dispatch('read-form', 'submit'); await ui.dispatch('issue-form', 'submit');
  ui.element('write-value').value = 'Private draft'; fenced = true; await ui.dispatch('refresh');
  assert.equal(ui.element('private-state').hidden, true); assert.equal(ui.element('write-value').value, '');
  assert.equal(ui.element('record-rows').children.length, 0); assert.equal(ui.element('record-value').textContent, '');
  assert.equal(ui.element('use-ticket').disabled, true); assert.equal(ui.element('connection-state').textContent, 'Disconnected');
  fenced = false; await ui.connect(); await ui.dispatch('issue-form', 'submit'); await ui.dispatch('disconnect');
  const count = ui.calls.length; await ui.dispatch('retry'); await ui.dispatch('use-ticket'); assert.equal(ui.calls.length, count);
  assert.equal(ui.element('ticket-state').textContent, 'No ticket held.'); assert.equal(ui.element('request-result').textContent, '');
});

test('logout discards an uncertain request and cannot retry it in a later session', async t => {
  let drop = true;
  const ui = await fixture(t, { reply(input, server) {
    const value = server.reply(input);
    if (input.operation === 'write' && drop) { drop = false; throw Error('reply lost'); }
    return value;
  } });
  await ui.connect(); await ui.dispatch('issue-form', 'submit');
  ui.element('write-key').value = 'review-findings'; ui.element('write-value').value = 'Unconfirmed private draft';
  await ui.dispatch('write-form', 'submit');
  assert.equal(ui.element('uncertain').hidden, false);
  const priorRequest = ui.calls.at(-1).input.requestId;
  await ui.dispatch('disconnect');
  assert.equal(ui.element('uncertain').hidden, true); assert.equal(ui.element('retry-description').textContent, '');
  assert.equal(ui.element('write-value').value, ''); assert.equal(ui.element('ticket-state').textContent, 'No ticket held.');
  assert(!ui.allText().includes('Unconfirmed private draft'));
  await ui.connect();
  const count = ui.calls.length; await ui.dispatch('retry');
  assert.equal(ui.calls.length, count); assert.equal(ui.calls.filter(call => call.input.requestId === priorRequest).length, 1);
});

test('late responses cannot restore a disconnected session and a diagnostic projection never enters the page', async t => {
  let release;
  const ui = await fixture(t, { fetcher: () => new Promise(resolve => { release = () => resolve(Response.json(snapshot())); }) });
  const connecting = ui.connect(); await ui.dispatch('disconnect'); release(); await connecting;
  assert.equal(ui.element('private-state').hidden, true); assert.equal(ui.element('record-rows').children.length, 0);
  const diagnostic = await fixture(t, { reply: () => ({ ...snapshot(), _route: { private: 'must-never-render' } }) });
  await diagnostic.connect(); assert.equal(diagnostic.element('private-state').hidden, true);
  assert(!diagnostic.allText().includes('must-never-render')); assert.match(diagnostic.element('message').textContent, /participant-v1/);
});

test('mismatched readback is visibly unverified and all record content remains inert text', async t => {
  const payload = '<img src=x onerror=alert(1)>';
  const ui = await fixture(t, { reply(input, server) {
    const value = server.reply(input);
    return input.operation === 'read' ? { ...value, value: payload } : value;
  } });
  await ui.connect(); ui.element('write-key').value = 'review-findings'; ui.element('write-value').value = 'Expected note';
  await ui.dispatch('write-form', 'submit');
  assert.equal(ui.element('save-state').textContent, 'Saved record has changed');
  assert.equal(ui.element('record-value').textContent, payload); assert.equal(ui.element('record-value').children.length, 0);
  assert.equal(ui.element('save-state').dataset.state, 'changed');
});

test('participant controls are labeled and have no owner, persistence or injection paths', () => {
  assert.match(html, /<html lang="en">/); assert.match(html, /type="password" autocomplete="off"/);
  assert.match(html, /role="status" aria-live="polite" tabindex="-1"/); assert.match(html, /class="skip-link"/);
  assert.match(html, /Self-hosted manual fixture/); assert.match(html, /does not approve shipping/);
  for (const id of ['actor-token', 'record-key', 'write-key', 'write-value', 'ticket-key']) assert.match(html, new RegExp(`label for="${id}"`));
  assert.doesNotMatch(source + html, /localStorage|sessionStorage|\.innerHTML|\.outerHTML|document\.write|console\.|location\.(?:search|hash)|client\.(?:status|evidence|preview|apply)\(/);
});
