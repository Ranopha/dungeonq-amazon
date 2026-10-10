import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { interruptedWriteFixture } from '../scripts/lib/interrupted-write-fixture.mjs';
import { createRuntimeClient } from '../sdk/runtime-client.mjs';
import { request } from '../runtime/transport.mjs';

const write = (requestId = 'security-write', expectedRevision = 0) => ({ requestId, operation: 'write', args: {
  key: 'welcome', value: 'Artificial reviewed note', expectedRevision } });
async function fixture(t) { const f = await interruptedWriteFixture(); t.after(() => f.close()); return f; }
const actor = f => createRuntimeClient({ origin: f.gateway.origin, token: f.credentials.actor });

for (const fault of ['unsigned-error-after-commit', 'invalid-proof-after-commit']) {
  test(`${fault}: an untrusted facade cannot suppress read-only recovery with a rejection code`, async t => {
    const f = await fixture(t); f.fault(fault);
    const recovered = await actor(f).writeWithRecovery(write());
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.result.revision, 1);
    assert.equal(f.writeAttempts, 1);
    const evidence = await f.gateway.evidence();
    assert.equal(evidence.events.at(-1).outcome, 'UNKNOWN');
    assert.equal(evidence.status, 'FAIL');
    assert.equal(evidence.canonical.events.filter(e => e.kind === 'EXECUTE' && e.operation === 'write').length, 1);
  });
}

test('failure to persist the gateway receipt after commit stays uncertain and preserves the pending attempt', async t => {
  const f = await fixture(t);
  const journal = new DatabaseSync(join(f.directory, 'gateway.sqlite'));
  t.after(() => journal.close());
  journal.exec("CREATE TRIGGER fail_attempt BEFORE INSERT ON gateway_attempts BEGIN SELECT RAISE(FAIL, 'injected storage failure'); END");
  const recovered = await actor(f).writeWithRecovery(write());
  assert.equal(recovered.recovered, true); assert.equal(f.writeAttempts, 1);
  assert.equal(journal.prepare('SELECT count(*) AS n FROM gateway_pending').get().n, 1);
  assert.equal((await f.gateway.evidence()).status, 'FAIL');
});

test('an unsigned rejection without a proven commit stays UNKNOWN and never resends the write', async t => {
  const f = await fixture(t), client = actor(f); f.fault('unsigned-error-before-commit');
  await assert.rejects(client.writeWithRecovery(write()), error => error.code === 'DISPATCH_UNKNOWN' && error.uncertain);
  const outcome = await client.writeStatus(write());
  assert.equal(outcome.state, 'UNKNOWN'); assert.equal(outcome.result, undefined);
  assert.equal(f.writeAttempts, 1);
  assert.equal(f.gateway.status().worlds.find(world => world.worldId === 'dungeon').revision, 0);
});

test('both actor lookup transports reject supplied authority and owner-only fields', async t => {
  const f = await fixture(t), input = write();
  const mcp = f.gateway.mcpEndpoint.replace(/\/mcp$/, '');
  for (const extra of [{ token: f.credentials.other }, { family: 'mcp' }, { contextId: 'other' }, { operatorView: true }]) {
    for (const [origin, path] of [[f.gateway.origin, '/api/write-status'], [mcp, '/write-status']]) {
      await assert.rejects(request(origin, path, f.credentials.actor, { ...input, ...extra }), { code: 'INVALID_ENVELOPE' });
    }
  }
});

test('participant lookups do not disclose global checkpoint movement caused by another context', async t => {
  const f = await fixture(t), input = write('unseen-in-other-context');
  const other = createRuntimeClient({ origin: f.gateway.origin, token: f.credentials.other });
  const before = await other.writeStatus(input);
  await actor(f).operate(write());
  const after = await other.writeStatus(input);
  assert.equal(before.state, 'UNKNOWN');
  assert.deepEqual(after, before, 'a separate tenant write must not change an unseen request response');
  const own = await actor(f).writeStatus(write());
  assert.equal(own.state, 'COMMITTED');
  assert.equal(Object.hasOwn(own, 'checkpoint'), false);
  assert.equal(Object.hasOwn(own, 'sequence'), false);
  const owner = await request(f.gateway.origin, '/api/operator/write-status', f.credentials.owner,
    { ...write(), contextId: 'diverted', family: 'http' });
  assert.ok(owner.checkpoint.eventCount > 0); assert.ok(owner.sequence > 0);
  const mcp = f.gateway.mcpEndpoint.replace(/\/mcp$/, '');
  const lookup = () => request(mcp, '/write-status', f.credentials.other, input);
  const mcpBefore = await lookup();
  await actor(f).operate(write('second-write', 1));
  assert.deepEqual(await lookup(), mcpBefore);
});

test('concurrent identical writes commit once, while conflicting payloads and adapters cannot reuse that identity', async t => {
  const f = await fixture(t), client = actor(f), input = write();
  const results = await Promise.all(Array.from({ length: 6 }, () => client.operate(input)));
  assert.equal(results.filter(result => result.replayed === false).length, 1);
  assert.ok(results.every(result => result.revision === 1));
  const changed = { ...input, args: { ...input.args, value: 'A conflicting note' } };
  await assert.rejects(client.operate(changed), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.gateway.dispatch({ ...input, token: f.credentials.actor, family: 'mcp' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal((await client.writeStatus(changed)).state, 'CONFLICT');
  const other = createRuntimeClient({ origin: f.gateway.origin, token: f.credentials.other });
  assert.equal((await other.operate(input)).revision, 1, 'the same request ID is independent in another context');
  const evidence = await f.gateway.evidence();
  assert.equal(evidence.canonical.events.filter(e => e.kind === 'EXECUTE' && e.operation === 'write' && e.contextId === 'diverted').length, 1);
  assert.equal(evidence.events.filter(e => e.contextId === 'diverted' && e.requestId === input.requestId).length, 8);
});

test('competing new identities at one revision allow only one committed write', async t => {
  const f = await fixture(t), client = actor(f);
  const inputs = [write('contender-a'), write('contender-b')];
  const results = await Promise.allSettled(inputs.map(input => client.operate(input)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const states = await Promise.all(inputs.map(input => client.writeStatus(input)));
  assert.deepEqual(states.map(result => result.state).sort(), ['COMMITTED', 'NOT_COMMITTED']);
});

test('UNKNOWN, CONFLICT, NOT_COMMITTED and mismatched recovery replies never become success or another write', async () => {
  const input = write();
  const valid = { schemaVersion: 'dungeonq.write-status/v1', requestId: input.requestId, state: 'COMMITTED',
    result: { key: input.args.key, value: input.args.value, revision: 1, recordRevision: 1 } };
  const cases = [
    ...['UNKNOWN', 'CONFLICT', 'NOT_COMMITTED'].map(state => ({ ...valid, state })),
    { ...valid, requestId: 'different' },
    { ...valid, result: { ...valid.result, value: 'different' } },
    { ...valid, result: { ...valid.result, revision: 2 } },
    { ...valid, result: { ...valid.result, recordRevision: 0 } },
    {},
  ];
  for (const response of cases) {
    const calls = [];
    const client = createRuntimeClient({ origin: 'http://127.0.0.1:1', token: 'synthetic-test-token', fetch: async (url, options) => {
      calls.push({ path: new URL(url).pathname, input: JSON.parse(options.body) });
      if (url.endsWith('/api/operate')) throw Error('lost reply');
      return Response.json(response);
    } });
    await assert.rejects(client.writeWithRecovery(input), error => error.uncertain === true);
    assert.deepEqual(calls.map(call => call.path), ['/api/operate', '/api/write-status']);
    assert.ok(calls.every(call => JSON.stringify(call.input) === JSON.stringify(input)));
  }
});
