import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { interruptedWriteFixture } from './lib/interrupted-write-fixture.mjs';
import { createRuntimeClient } from '../sdk/runtime-client.mjs';
import { request } from '../runtime/transport.mjs';
import { runShippingReview } from '../examples/mcp-shipping-consumer/client.mjs';

export async function runInterruptedWriteDemo() {
  const f = await interruptedWriteFixture();
  const input = (requestId, expectedRevision) => ({ requestId, operation: 'write', args: {
    key: 'welcome', value: 'Order 41\nReview completed. Shipping approval remains pending.', expectedRevision } });
  const inspect = (operation, family = 'http') => request(f.gateway.origin, '/api/operator/write-status', f.credentials.owner,
    { ...operation, contextId: 'diverted', family });
  const scenes = []; const add = (id, result) => scenes.push({ id, result });
  try {
    f.fault('after-commit');
    const review = await runShippingReview({ endpoint: f.gateway.mcpEndpoint, actorToken: f.credentials.actor, requestPrefix: 'recorded-recovery' });
    const recovered = review.scenes.find(scene => scene.id === 'write-recovered');
    assert(recovered); assert.equal(f.writeAttempts, 1);
    const committed = await inspect(input('recorded-recovery-write', 0), 'mcp');
    assert.equal(committed.state, 'COMMITTED');
    add('lost-response', { fault: 'facade socket closed AFTER canonical transaction', clientInitiallyConfirmed: false,
      operatorState: committed.state, commitSequence: committed.sequence, eventDigest: committed.eventDigest,
      revision: committed.result.revision, automaticWriteRetries: 0, writeAttempts: f.writeAttempts });
    add('read-only-recovery', { clientStatus: review.status, recoveryMethod: recovered.result.method,
      separateReadbackMatches: review.scenes.find(scene => scene.id === 'write-readback').result.value === committed.result.value,
      ticketReadbackMatches: review.scenes.find(scene => scene.id === 'world-ticket').result.readbackMatches });
    await f.restart();
    const persisted = await inspect(input('recorded-recovery-write', 0), 'mcp');
    assert.equal(persisted.eventDigest, committed.eventDigest);
    add('restart', { operatorState: persisted.state, sameCommitDigest: true, revision: persisted.result.revision });
    const client = createRuntimeClient({ origin: f.gateway.origin, token: f.credentials.actor });
    const refused = input('recorded-refusal', 99); await assert.rejects(client.operate(refused));
    const rejected = await inspect(refused); assert.equal(rejected.state, 'NOT_COMMITTED');
    add('confirmed-refusal', { operatorState: rejected.state, cause: 'authenticated revision refusal before transaction',
      worldRevision: f.gateway.status().worlds.find(w => w.worldId === 'dungeon').revision });
    f.fault('before-commit'); const unknown = input('recorded-before-loss', 1);
    await assert.rejects(client.writeWithRecovery(unknown));
    assert.equal((await inspect(unknown)).state, 'UNKNOWN');
    assert.equal((await inspect(input('unseen-request', 1))).state, 'UNKNOWN');
    add('unproven-outcome', { operatorState: 'UNKNOWN', fault: 'facade socket closed BEFORE canonical execution',
      unseenRequestState: 'UNKNOWN', automaticWriteRetries: 0, reason: 'absence at a checkpoint is not proof of a final failure' });
    const evidence = await f.gateway.evidence();
    assert.equal(evidence.status, 'FAIL'); assert.equal(evidence.scope.witness.accepted, 0);
    add('retained-evidence', { overallEvidence: evidence.status, unknownAttemptsRetained: evidence.events.filter(e => e.outcome === 'UNKNOWN').length,
      canonicalWrites: evidence.canonical.events.filter(e => e.kind === 'EXECUTE' && e.operation === 'write').length,
      divertedOriginAdmissions: evidence.scope.witness.accepted, historyRewritten: false });
    const sources = ['runtime/store.mjs', 'runtime/server.mjs', 'runtime/mcp.mjs', 'runtime/outcomes.mjs', 'sdk/runtime-client.mjs',
      'examples/mcp-shipping-consumer/client.mjs', 'scripts/lib/interrupted-write-fixture.mjs', 'scripts/interrupted-write-demo.mjs'];
    return { schemaVersion: 'dungeonq.interrupted-write-proof/v1', mode: 'SCRIPTED_LOCAL_FAULT_INJECTION',
      sourceVersion: JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version,
      recordedAt: new Date().toISOString(), status: 'PASS',
      meaning: 'All named recovery assertions passed. The faulted runtime evidence intentionally remains FAIL.',
      sourceHashes: Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(new URL('../' + path, import.meta.url))).digest('hex')])),
      scenes, limitations: ['Artificial reference resources only.', 'No new model run.', 'No automatic retry of a failed write.',
        'Canonical commit proof does not restore missing transport evidence or certify production security.',
        'NOT_COMMITTED applies to the exact authenticated refusal at its checkpoint, not every future retry.'] };
  } finally { await f.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const destination = process.argv[2];
  if (!destination) throw Error('Provide a NEW report path outside the checkout.');
  const location = relative(fileURLToPath(new URL('../', import.meta.url)), resolve(destination));
  if (!location.startsWith('..') && !isAbsolute(location)) throw Error('Report path must be outside the checkout.');
  const report = await runInterruptedWriteDemo();
  writeFileSync(resolve(destination), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  for (const scene of report.scenes) console.log(`${scene.id}: ${JSON.stringify(scene.result)}`);
  console.log('RECOVERY_ASSERTIONS: PASS; FAULTED_RUNTIME_EVIDENCE: FAIL (retained)');
}
