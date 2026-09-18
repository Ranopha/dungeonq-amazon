import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DOCKER_CONTEXT, selectDockerContext, compareIsolationContinuity, evaluateIsolation, prepareReference, readReference, referenceSourceManifest } from '../scripts/runtime-isolation.mjs';

test('runner context selection requires an explicit dedicated name without changing the default', () => {
  assert.equal(selectDockerContext(), 'colima-dungeonq-rehearsal');
  assert.equal(selectDockerContext('dungeonq-ci'), 'dungeonq-ci');
  for (const value of ['', 'default', 'production', 'dungeonq-', 'dungeonq-../default', 'dungeonq-ci\n']) {
    assert.throws(() => selectDockerContext(value), /DEDICATED_DOCKER_CONTEXT_REQUIRED/);
  }
});

function prepared(t) {
  const parent = mkdtempSync(join(tmpdir(), 'dq-isolation-test-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return prepareReference({ directory: join(parent, 'reference') });
}

test('reference preparation separates credentials and never stages configuration or repository metadata', (t) => {
  const value = prepared(t);
  assert.equal(value.context, DOCKER_CONTEXT);
  assert.equal(value.uid, process.getuid());
  const read = (role) => JSON.parse(readFileSync(join(value.directory, 'config', `${role}.json`), 'utf8'));
  const gateway = read('gateway');
  assert.equal(new Set(Object.values(gateway.credentials)).size, 8);
  assert.ok(Object.values(gateway.credentials).every((token) => /^[A-Za-z0-9_-]{43}$/.test(token)));
  assert.deepEqual(Object.keys(read('facade').options).sort(), ['host', 'port', 'stateOrigin']);
  assert.equal(read('origin').options.normalToken, gateway.credentials.ordinary);
  assert.equal(read('origin').options.witnessToken, gateway.credentials.witness);
  assert.equal(read('collector').options.producerToken, gateway.credentials.producer);
  assert.equal(read('collector').options.readerToken, gateway.credentials.reader);
  for (const role of ['gateway', 'facade', 'origin', 'collector']) {
    assert.equal(lstatSync(join(value.directory, 'config', `${role}.json`)).mode & 0o777, 0o600);
  }
  const staged = JSON.parse(readFileSync(join(value.buildDirectory, 'source-manifest.json'), 'utf8'));
  assert.equal(staged.sourceDigest, value.sourceDigest);
  assert.equal(createHash('sha256').update(JSON.stringify(staged.entries)).digest('hex'), value.sourceDigest);
  assert.ok(staged.entries.every((entry) => !entry.path.startsWith('.git') && !entry.path.includes('config/gateway')));
  assert.equal(existsSync(join(value.buildDirectory, 'config')), false);
  assert.equal(lstatSync(join(value.buildDirectory, 'runtime/blueprints')).mode & 0o777, 0o755);
  assert.equal(lstatSync(join(value.buildDirectory, 'runtime/blueprints/default.json')).mode & 0o777, 0o644);
  assert.equal(referenceSourceManifest().sourceDigest, value.sourceDigest);
});

test('preparation refuses reuse and manifest reads reject non-private permissions', (t) => {
  const value = prepared(t);
  const original = readFileSync(join(value.directory, 'config/gateway.json'), 'utf8');
  assert.throws(() => prepareReference({ directory: value.directory }), /NEW_ABSOLUTE_DIRECTORY_REQUIRED/);
  assert.equal(readFileSync(join(value.directory, 'config/gateway.json'), 'utf8'), original);
  assert.equal(readReference(value.directory).project, value.project);
  chmodSync(join(value.directory, 'reference.json'), 0o644);
  assert.throws(() => readReference(value.directory), /PRIVATE_REFERENCE_FILE_REQUIRED/);
});

test('isolation acceptance fails closed for missing, duplicate, failed, or unobserved facts', () => {
  const missing = evaluateIsolation([]);
  assert.equal(missing.status, 'INCONCLUSIVE');
  const complete = missing.checks.map(({ id }) => ({ id, status: 'PASS', detail: 'Unit fixture only, not live evidence.' }));
  assert.equal(evaluateIsolation(complete).status, 'PASS');
  assert.equal(evaluateIsolation(complete.slice(1)).status, 'INCONCLUSIVE');
  assert.equal(evaluateIsolation([...complete, complete[0]]).status, 'INCONCLUSIVE');
  assert.equal(evaluateIsolation(complete.map((entry, index) => index ? entry : { ...entry, status: 'NOT_RUN' })).status, 'INCONCLUSIVE');
  assert.equal(evaluateIsolation(complete.map((entry, index) => index ? entry : { ...entry, status: 'FAIL' })).status, 'FAIL');
});

test('continuity compares mount identity independent of Docker ordering and detects volume or event replacement', () => {
  const checks = evaluateIsolation([]).checks.map(({ id }) => ({ id, status: 'PASS' }));
  checks.find((check) => check.id === 'origin-witness-continuity').detail = { before: { accepted: 1 }, after: { accepted: 1 } };
  const containers = Object.fromEntries(['gateway', 'facade', 'origin', 'collector'].map((role) => [role, { id: `before-${role}`, mounts: [
    { Type: 'volume', Name: `${role}-config`, Destination: '/run/dungeonq', RW: false },
    { Type: 'volume', Name: `${role}-state`, Destination: '/state', RW: true },
  ] }]));
  const before = { context: DOCKER_CONTEXT, project: 'unit-fixture', status: 'PASS', sourceDigest: 'fixture', images: [{ id: 'image-fixture' }],
    checks, facts: { containers, gatewayEvidence: { eventIds: ['first', 'second'], eventCount: 2 } } };
  const after = structuredClone(before);
  for (const [role, container] of Object.entries(after.facts.containers)) { container.id = `after-${role}`; container.mounts.reverse(); }
  after.facts.gatewayEvidence = { eventIds: ['first', 'second', 'third', 'fourth'], eventCount: 4 };
  assert.equal(compareIsolationContinuity(before, after).status, 'PASS');
  const replaced = structuredClone(after);
  replaced.facts.containers.origin.mounts[0].Name = 'different-volume';
  assert.equal(compareIsolationContinuity(before, replaced).status, 'FAIL');
  const missing = structuredClone(after);
  missing.facts.gatewayEvidence.eventIds = ['third', 'fourth'];
  assert.equal(compareIsolationContinuity(before, missing).status, 'FAIL');
  assert.equal(compareIsolationContinuity({}, {}).status, 'INCONCLUSIVE');
});
