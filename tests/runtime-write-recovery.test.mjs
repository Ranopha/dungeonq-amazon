import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { interruptedWriteFixture } from '../scripts/lib/interrupted-write-fixture.mjs';
import { createRuntimeClient } from '../sdk/runtime-client.mjs';
import { request } from '../runtime/transport.mjs';
import { runShippingReview } from '../examples/mcp-shipping-consumer/client.mjs';

const write = (requestId = 'lost-write', expectedRevision = 0) => ({ requestId, operation: 'write', args: {
  key: 'welcome', value: 'Review saved\nShipping approval remains separate.', expectedRevision } });
async function fixture(t) { const f = await interruptedWriteFixture(); t.after(() => f.close()); return f; }
const actor = f => createRuntimeClient({ origin: f.gateway.origin, token: f.credentials.actor });
const inspect = (f, input, family = 'http') => request(f.gateway.origin, '/api/operator/write-status', f.credentials.owner,
  { ...input, contextId: 'diverted', family });

test('lost canonical reply is proven committed; lookup has no effect and survives restart', async t => {
  const f = await fixture(t), input = write(); f.fault('after-commit');
  await assert.rejects(actor(f).operate(input));
  const before = f.gateway.store.evidence().verifier;
  const outcome = await inspect(f, input);
  assert.equal(outcome.state, 'COMMITTED'); assert.equal(outcome.result.value, input.args.value);
  assert.equal(outcome.result.revision, 1); assert.equal(outcome.automaticRetryAllowed, false);
  assert.deepEqual(f.gateway.store.evidence().verifier, before); assert.equal(f.writeAttempts, 1);
  assert.equal((await inspect(f, { ...input, args: { ...input.args, value: 'changed' } })).state, 'CONFLICT');
  assert.equal((await inspect(f, input, 'mcp')).state, 'CONFLICT');
  await f.restart(); assert.equal((await inspect(f, input)).eventDigest, outcome.eventDigest);
  const replay = await actor(f).operate(input); assert.equal(replay.replayed, true); assert.equal(replay.revision, 1);
  const evidence = await f.gateway.evidence();
  assert.equal(evidence.canonical.events.filter(e => e.kind === 'EXECUTE' && e.operation === 'write').length, 1);
  assert.deepEqual(evidence.events.filter(e => e.requestId === input.requestId).map(e => e.outcome), ['UNKNOWN', 'SERVED']);
  assert.equal(evidence.status, 'FAIL', 'recovery must not erase the earlier transport gap');
});

test('HTTP client automatically recovers a committed result with a read only lookup, not another write', async t => {
  const f = await fixture(t); f.fault('after-commit');
  const recovered = await actor(f).writeWithRecovery(write());
  assert.equal(recovered.recovered, true); assert.equal(recovered.result.revision, 1); assert.equal(f.writeAttempts, 1);
  const readback = await actor(f).operate({ requestId: 'readback', operation: 'read', args: { key: 'welcome' } });
  assert.equal(readback.value, recovered.result.value);
});

test('SDK delivery loss after HTTP success recovers without rewriting', async t => {
  const f = await fixture(t); let dropped = false;
  const client = createRuntimeClient({ origin: f.gateway.origin, token: f.credentials.actor, fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (url.endsWith('/api/operate') && !dropped) { dropped = true; await response.text(); throw Error('response lost'); }
    return response;
  } });
  assert.equal((await client.writeWithRecovery(write())).recovered, true); assert.equal(f.writeAttempts, 1);
});

test('authenticated refusal differs from before-commit transport loss and an unseen ID', async t => {
  const f = await fixture(t);
  const refused = write('rejected-before-commit', 42);
  await assert.rejects(actor(f).operate(refused), { code: 'REVISION_CONFLICT' });
  assert.equal((await inspect(f, refused)).state, 'NOT_COMMITTED');
  f.fault('before-commit'); const interrupted = write('connection-lost-before-commit');
  await assert.rejects(actor(f).writeWithRecovery(interrupted));
  assert.equal((await inspect(f, interrupted)).state, 'UNKNOWN');
  assert.equal((await inspect(f, write('never-observed'))).state, 'UNKNOWN');
  assert.equal(f.writeAttempts, 2);
  assert.equal(f.gateway.status().worlds.find(w => w.worldId === 'dungeon').revision, 0);
});

test('actor lookup cannot cross tenant, choose identity, inspect owner endpoints, or revive fenced authority', async t => {
  const f = await fixture(t), input = write(); await actor(f).operate(input);
  const other = createRuntimeClient({ origin: f.gateway.origin, token: f.credentials.other });
  const unknown = await other.writeStatus(input); assert.equal(unknown.state, 'UNKNOWN'); assert.equal(unknown.result, undefined);
  await assert.rejects(actor(f).writeStatus({ ...input, contextId: 'other' }));
  await assert.rejects(actor(f).inspectWrite({ ...input, contextId: 'diverted', family: 'http' }));
  f.gateway.store.fence({ contextId: 'diverted', reason: 'test fence' });
  await assert.rejects(actor(f).writeStatus(input), { code: 'CONTEXT_FENCED' });
  assert.equal((await inspect(f, input)).state, 'COMMITTED', 'owner may inspect historical evidence');
});

test('real MCP consumer recovers lost write reply and continues separate readback/ticket without duplicate write', async t => {
  const f = await fixture(t); f.fault('after-commit');
  const result = await runShippingReview({ endpoint: f.gateway.mcpEndpoint, actorToken: f.credentials.actor, requestPrefix: 'mcp-lost' });
  assert.equal(result.status, 'PASS'); assert.equal(result.scenes.find(s => s.id === 'write-recovered').result.writeResent, false);
  assert.equal(f.writeAttempts, 1);
  assert.equal((await inspect(f, { requestId: 'mcp-lost-write', operation: 'write', args: {
    key: 'welcome', value: 'Order 41\nReview completed. Shipping approval remains pending.', expectedRevision: 0 } }, 'mcp')).state, 'COMMITTED');
  assert.equal((await f.gateway.evidence()).status, 'FAIL', 'consumer success is not a complete route evidence PASS');
});

test('corrupt canonical journal cannot answer COMMITTED', async t => {
  const f = await fixture(t), input = write(); await actor(f).operate(input);
  const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'));
  db.prepare('UPDATE runtime_events SET event_json=? WHERE sequence=(SELECT max(sequence) FROM runtime_events)').run('{}'); db.close();
  await assert.rejects(inspect(f, input));
});
