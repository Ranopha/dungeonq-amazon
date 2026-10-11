import test from 'node:test';
import assert from 'node:assert/strict';
import { runRestartBeforeLookup } from '../scripts/restart-recovery-demo.mjs';
import { interruptedWriteFixture } from '../scripts/lib/interrupted-write-fixture.mjs';
import { createRuntimeClient } from '../sdk/runtime-client.mjs';
import { request } from '../runtime/transport.mjs';

for (const family of ['http', 'mcp']) {
  test(`${family}: restart precedes the first participant recovery lookup; one durable write only`, async () => {
    await runRestartBeforeLookup(family);
  });
}
const write = (requestId, expectedRevision = 0) => ({ requestId, operation: 'write',
  args: { key: 'welcome', value: 'Original saved review.', expectedRevision } });
const client = f => createRuntimeClient({ origin: f.gateway.origin, token: f.credentials.actor });

test('restart preserves UNKNOWN versus authenticated refusal and does not authorize either retry', async t => {
  const f = await interruptedWriteFixture(); t.after(() => f.close());
  const refused = write('refused', 42), unknown = write('lost-before');
  await assert.rejects(client(f).operate(refused), { code: 'REVISION_CONFLICT' });
  f.fault('before-commit'); await assert.rejects(client(f).operate(unknown));
  await f.restart();
  for (const [input, expected] of [[refused, 'NOT_COMMITTED'], [unknown, 'UNKNOWN'], [write('never-seen'), 'UNKNOWN']]) {
    const status = await client(f).writeStatus(input);
    assert.equal(status.state, expected); assert.equal(status.automaticRetryAllowed, false);
    assert.equal(status.result, undefined);
  }
  assert.equal(f.writeAttempts, 2);
  assert.equal(f.gateway.store.evidence().events.filter(e => e.kind === 'EXECUTE' && e.operation === 'write').length, 0);
});

test('post-restart recovery returns the original value, not a later edit; fencing still blocks the actor', async t => {
  const f = await interruptedWriteFixture(); t.after(() => f.close());
  const input = write('original'); f.fault('after-commit'); await assert.rejects(client(f).operate(input));
  await f.restart();
  await client(f).operate({ ...write('later-edit', 1), args: { ...write('later-edit', 1).args, value: 'Later review.' } });
  const recovered = await client(f).writeStatus(input);
  assert.equal(recovered.result.value, input.args.value); assert.equal(recovered.result.revision, 1);
  assert.equal((await client(f).operate({ requestId: 'current', operation: 'read', args: { key: 'welcome' } })).value, 'Later review.');
  assert.equal((await client(f).writeStatus({ ...input, args: { ...input.args, expectedRevision: 2 } })).state, 'CONFLICT');
  f.gateway.store.fence({ contextId: 'diverted', reason: 'Operator ends this session.' });
  await f.restart();
  await assert.rejects(client(f).writeStatus(input), { code: 'CONTEXT_FENCED' });
  const owner = await request(f.gateway.origin, '/api/operator/write-status', f.credentials.owner,
    { ...input, contextId: 'diverted', family: 'http' });
  assert.equal(owner.state, 'COMMITTED'); assert.equal(owner.result.value, input.args.value);
});
