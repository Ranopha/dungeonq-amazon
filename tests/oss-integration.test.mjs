import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRuntimeReference } from '../runtime/reference.mjs';
import { validateConfiguration, runShippingReview, REVIEW_NOTE } from '../examples/mcp-shipping-consumer/client.mjs';
import { consumerDirectory, consumerProcessOptions, launchConsumer, verifySecretReadDenied, integrationVerdict, requiredEvidenceChecks, runIntegrationDemo } from '../scripts/oss-integration-demo.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function temporary(t, name) {
  const directory = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
async function reference(t, presentation = 'participant-v1') {
  const directory = temporary(t, 'dq-oss-test-fixture-');
  const runtime = await openRuntimeReference({ directory, presentation, network: false, hostBroker: false });
  t.after(() => runtime.close());
  return runtime;
}

test('consumer rejects missing actor credential and extra owner/origin authority before connecting', async () => {
  const endpoint = 'http://127.0.0.1:1/mcp';
  for (const actorToken of [undefined, '', 'bad token']) {
    await assert.rejects(runShippingReview({ endpoint, actorToken }), { code: 'ACTOR_TOKEN_REQUIRED' });
  }
  for (const extra of [{ ownerToken: 'forbidden' }, { origin: 'http://127.0.0.1:2' }, { credentials: {} }]) {
    assert.throws(() => validateConfiguration({ endpoint, actorToken: 'actor', ...extra }), { code: 'EXTRA_AUTHORITY_OR_OPTION_DENIED' });
  }
  for (const invalid of ['http://example.com/mcp', 'https://user:secret@example.com/mcp', 'https://example.com/mcp?token=secret']) {
    assert.throws(() => validateConfiguration({ endpoint: invalid, actorToken: 'actor' }), { code: 'INVALID_MCP_ENDPOINT' });
  }
});

test('consumer process never inherits operator environment, fixture access, or code outside public dependencies', async t => {
  const runtime = await reference(t);
  const cwd = temporary(t, 'dq-oss-test-consumer-');
  const options = consumerProcessOptions({ cwd });
  assert.deepEqual(Object.keys(options.env).sort(), ['NODE_NO_WARNINGS', 'PATH']);
  assert(!options.execArgv.includes('--allow-child-process'));
  assert(!options.execArgv.some(value => value.includes('--allow-fs-write')));
  assert.equal((await verifySecretReadDenied({ cwd, secretPath: join(runtime.directory, 'credentials.json') })).result, 'ERR_ACCESS_DENIED');
  for (const name of ['cli.mjs', 'client.mjs']) {
    const code = readFileSync(join(consumerDirectory, name), 'utf8');
    assert(!/from\s+['"]\.\.\//.test(code), 'consumer must not import parent implementation');
    assert(!/node:fs|runtime\//.test(code), 'consumer must not read fixture files or internal runtime');
  }
});

test('copied standalone package connects to an existing reference and performs actual MCP review/write/read/ticket', async t => {
  const runtime = await reference(t);
  const isolatedPackage = temporary(t, 'dq-oss-detached-package-');
  for (const name of ['package.json', 'package-lock.json', 'client.mjs', 'cli.mjs']) copyFileSync(join(consumerDirectory, name), join(isolatedPackage, name));
  const dependencies = existsSync(join(consumerDirectory, 'node_modules')) ? join(consumerDirectory, 'node_modules') : join(root, 'node_modules');
  // Reuse installed public dependencies offline; no repository implementation is copied.
  symlinkSync(dependencies, join(isolatedPackage, 'node_modules'));
  const { report, ticket } = await launchConsumer({ packageDirectory: isolatedPackage, cwd: isolatedPackage,
    configuration: { endpoint: runtime.mcpEndpoint, actorToken: runtime.credentials.actor } });
  assert.equal(report.status, 'PASS');
  assert.equal(report.scenes.find(scene => scene.id === 'write-readback').result.value, REVIEW_NOTE);
  assert.equal(report.scenes.find(scene => scene.id === 'world-ticket').result.newFollowUps, 0, 'consumer must not self-authorize adaptation');
  assert.equal(runtime.status().policies.length, 0);
  assert.equal(runtime.status().worlds.find(world => world.worldId === 'dungeon').revision, 1);
  const encoded = JSON.stringify(report);
  for (const secret of [...Object.values(runtime.credentials), ticket]) assert(!encoded.includes(secret));
});

test('wrong actor credentials and owner credentials fail without a consumer PASS or canonical write', async t => {
  const runtime = await reference(t);
  const cwd = temporary(t, 'dq-oss-failed-consumer-');
  for (const actorToken of ['not-the-actor', runtime.credentials.owner]) {
    await assert.rejects(launchConsumer({ cwd, configuration: { endpoint: runtime.mcpEndpoint, actorToken } }));
  }
  assert.equal(runtime.status().worlds.find(world => world.worldId === 'dungeon').revision, 0);
  assert.equal(runtime.status().policies.length, 0);
});

test('missing shipping fixture and an operator handoff failure cannot become a successful run', async t => {
  const runtime = await reference(t, 'diagnostic-v1');
  const cwd = temporary(t, 'dq-oss-incompatible-consumer-');
  await assert.rejects(launchConsumer({ cwd, configuration: { endpoint: runtime.mcpEndpoint, actorToken: runtime.credentials.actor } }), { code: 'SHIPPING_FIXTURE_REQUIRED' });
  const participant = await reference(t);
  await assert.rejects(launchConsumer({ cwd, configuration: { endpoint: participant.mcpEndpoint, actorToken: participant.credentials.actor, waitForOperator: true },
    onOperatorBoundary: async () => { throw Object.assign(new Error('OPERATOR_FIXTURE_FAILED'), { code: 'OPERATOR_FIXTURE_FAILED' }); } }), { code: 'OPERATOR_FIXTURE_FAILED' });
  assert.equal(participant.status().policies.length, 0);
  assert.equal(participant.status().worlds.find(world => world.worldId === 'dungeon').revision, 1, 'completed review remains saved; no ticket adaptation is reported');
});

test('complete fresh fixture report correlates consumer, owner, collector and independent origin without secrets', async t => {
  const directory = temporary(t, 'dq-oss-report-');
  const output = join(directory, 'integration.json');
  const report = await runIntegrationDemo({ output });
  assert.equal(report.status, 'PASS');
  assert.deepEqual(report.scenes.map(scene => scene.id), ['authority-boundary', 'consumer-connect', 'shipping-review', 'write-readback', 'operator-approval', 'world-ticket', 'origin-boundary', 'final-evidence']);
  assert.equal(report.evidence.events.filter(event => event.family === 'mcp' && event.destination === 'SYNTHETIC' && event.outcome === 'SERVED').length, 8);
  assert.equal(report.evidence.origin.admissions.filter(row => row.accepted === 1).length, 1);
  assert.equal(report.evidence.origin.admissions.filter(row => row.accepted === 0).length, 1);
  assert.equal(report.evidence.policy.uses, 1);
  assert.equal(report.productionProtection, 'NOT_ASSESSED');
  assert.equal(report.thirdPartyAdoption, 'NOT_ESTABLISHED');
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), report);
  await assert.rejects(runIntegrationDemo({ output }), { code: 'NEW_OUTPUT_PATH_REQUIRED' });
});

test('acceptance never promotes missing, failed, unknown or mismatched evidence to PASS', () => {
  const good = { consumer: { status: 'PASS' }, evidence: { status: 'PASS', checks: requiredEvidenceChecks.map(id => ({ id, status: 'PASS' })) }, originChecks: { stateUnchanged: true, ordinaryAccepted: 1, ticketRejected: 1 },
    authorityChecks: { secretRead: 'ERR_ACCESS_DENIED', operatorDenied: true }, policy: { maxMutations: 8, uses: 1, followUpCount: 1 } };
  assert.equal(integrationVerdict(good), 'PASS');
  for (const change of [{ consumer: { status: 'FAIL' } }, { evidence: undefined }, { evidence: { status: 'PASS' } }, { evidence: { status: 'PASS', checks: good.evidence.checks.slice(1) } },
    { evidence: { status: 'PASS', checks: [{ status: 'INCONCLUSIVE' }] } }, { evidence: { status: 'FAIL', checks: [{ status: 'PASS' }] } },
    { originChecks: { ...good.originChecks, stateUnchanged: false } }, { authorityChecks: { ...good.authorityChecks, operatorDenied: false } },
    { policy: { ...good.policy, uses: 0 } }]) assert.equal(integrationVerdict({ ...good, ...change }), 'FAIL');
});
