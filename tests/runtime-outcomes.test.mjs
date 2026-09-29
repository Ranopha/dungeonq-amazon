import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRuntimeReference } from '../runtime/reference.mjs';
import { body, digest, failure, newToken, request, seal, send, serve } from '../runtime/transport.mjs';
import { startRuntimeGateway } from '../runtime/server.mjs';
import { startOrigin, startCollector } from '../runtime/services.mjs';
import { executeOutcome, verifyRefusal, REFUSAL_DOMAIN } from '../runtime/outcomes.mjs';

const operation = (requestId, name, args = {}) => ({ requestId, operation: name, args });
test('multiline passive notes persist; authenticated refusals retain evidence without hiding failures', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dq-outcomes-'));
  let runtime = await openRuntimeReference({ directory, presentation: 'participant-v1', network: false, hostBroker: false });
  t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  const actor = input => request(runtime.origin, '/api/operate', runtime.credentials.actor, input);
  const value = 'Case 42\nReview pending\r\nTwo lines\tand a tab';
  const write = operation('multiline', 'write', { key: 'welcome', value, expectedRevision: 0 });
  assert.equal((await actor(write)).value, value);
  for (const [index, bad] of ['\0', '\x1b[31m', '<script>bad</script>', 'https://example.test', 'data:text/plain,secret', ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')].entries()) {
    await assert.rejects(actor(operation(`refusal-${index}`, 'write', { key: 'welcome', value: bad, expectedRevision: 1 })), { code: 'VALUE_NOT_PASSIVE' });
  }
  await assert.rejects(actor(operation('stale-write', 'write', { key: 'welcome', value: 'stale', expectedRevision: 0 })), { code: 'REVISION_CONFLICT' });
  assert.equal((await actor(operation('read-after', 'read', { key: 'welcome' }))).value, value);
  const evidence = await runtime.evidence();
  assert.equal(evidence.status, 'PASS');
  const refused = evidence.events.filter(event => event.outcome === 'REFUSED');
  assert.equal(refused.length, 7);
  for (const event of refused) {
    const proof = verifyRefusal(event.refusal, runtime.credentials.seal, event);
    assert.equal(digest(proof), event.resultDigest);
    assert.equal(proof.checkpoint.eventCount >= 1, true);
  }
  assert.equal(evidence.scope.witness.accepted, 0);
  await runtime.close();
  runtime = await openRuntimeReference({ directory, presentation: 'participant-v1', network: false, hostBroker: false });
  assert.equal((await actor(operation('restart', 'read', { key: 'welcome' }))).value, value);
  assert.equal((await actor(write)).replayed, true);
  assert.equal((await runtime.evidence()).status, 'PASS');
  await runtime.facadeService.close();
  await assert.rejects(actor(operation('lost-transport', 'snapshot')));
  const uncertain = await runtime.evidence();
  assert.equal(uncertain.status, 'FAIL');
  assert.equal(uncertain.events.at(-1).outcome, 'UNKNOWN');
  assert.equal(uncertain.scope.witness.accepted, 0);
});

for (const mode of ['forged-refusal', 'unsigned-refusal', 'effect-then-response-loss']) test(`${mode} stays UNKNOWN and cannot produce a clean boundary report`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dq-uncertain-'));
  const credentials = Object.fromEntries(['owner', 'actor', 'other', 'ordinary', 'seal', 'producer', 'reader', 'witness'].map(key => [key, newToken()]));
  const origin = await startOrigin({ path: join(directory, 'origin.sqlite'), normalToken: credentials.ordinary, witnessToken: credentials.witness });
  const collector = await startCollector({ path: join(directory, 'collector.sqlite'), producerToken: credentials.producer, readerToken: credentials.reader });
  let gateway;
  t.after(async () => { await gateway?.close(); await collector.close(); await origin.close(); rmSync(directory, { recursive: true, force: true }); });
  gateway = await startRuntimeGateway({ directory, credentials, originOrigin: origin.origin, collectorOrigin: collector.origin, network: false, hostBroker: false,
    facadeFactory: async stateOrigin => serve(async (req, res) => {
      const admitted = await body(req);
      if (mode === 'unsigned-refusal') throw failure('VALUE_NOT_PASSIVE');
      if (mode === 'effect-then-response-loss') {
        await request(stateOrigin, '/execute', undefined, admitted);
        res.destroy(); return;
      }
      // Even a correctly signed proof for a different input must not classify this attempt as refused.
      const input = admitted.body;
      send(res, 200, seal({ outcome: 'REFUSED', code: 'VALUE_NOT_PASSIVE', contextId: input.contextId, family: input.family,
        requestId: input.requestId, operation: input.operation, inputDigest: '0'.repeat(64),
        checkpoint: { head: 'ROOT', stateDigest: '0'.repeat(64), eventCount: 0 } }, credentials.seal, REFUSAL_DOMAIN));
    })
  });
  await assert.rejects(request(gateway.origin, '/api/operate', credentials.actor, operation('uncertain-write', 'write', { key: 'welcome', value: 'persisted only in response-loss case', expectedRevision: 0 })));
  const evidence = await gateway.evidence();
  assert.equal(evidence.status, 'FAIL');
  assert.equal(evidence.events.at(-1).outcome, 'UNKNOWN');
  assert.equal(evidence.checks.find(check => check.id === 'dispatch-outcomes-known').status, 'FAIL');
  assert.equal(evidence.scope.witness.accepted, 0);
  assert.equal(gateway.store.snapshot().worlds.find(world => world.worldId === 'dungeon').revision, mode === 'effect-then-response-loss' ? 1 : 0);
});

test('no-effect refusals require matching authenticated binding and unchanged verified state', () => {
  const checkpoint = { status: 'VERIFIED', head: 'a'.repeat(64), stateDigest: 'b'.repeat(64), eventCount: 3 };
  const input = { contextId: 'one', family: 'http', requestId: 'attempt', operation: 'write', args: {} };
  const admitted = { ...input, epoch: 1, expiresAt: 1 };
  const rejected = () => { throw Object.assign(Error('refused'), { code: 'VALUE_NOT_PASSIVE' }); };
  const store = { evidence: () => ({ verifier: checkpoint }), execute: rejected };
  const proof = executeOutcome(store, input, admitted, 'reference-test-key').refusal;
  const expected = { ...input, inputDigest: digest(admitted) };
  assert.equal(verifyRefusal(proof, 'reference-test-key', expected).outcome, 'REFUSED');
  for (const field of ['contextId', 'family', 'requestId', 'operation', 'inputDigest']) {
    assert.throws(() => verifyRefusal(proof, 'reference-test-key', { ...expected, [field]: 'changed' }));
  }
  assert.throws(() => verifyRefusal({ ...proof, body: { ...proof.body, code: 'RECORD_UNKNOWN' } }, 'reference-test-key', expected));
  assert.throws(() => verifyRefusal(seal(proof.body, 'wrong-key', REFUSAL_DOMAIN), 'reference-test-key', expected));
  let reads = 0;
  assert.throws(() => executeOutcome({ ...store, evidence: () => ({ verifier: reads++ ? { ...checkpoint, eventCount: 4 } : checkpoint }) }, input, admitted, 'key'));
  assert.throws(() => executeOutcome({ ...store, execute: () => { throw Object.assign(Error(), { code: 'SQLITE_ERROR' }); } }, input, admitted, 'key'));
});
