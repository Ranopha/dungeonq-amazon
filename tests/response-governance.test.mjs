import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { openGovernance, verifyReceipt } from '../server/governance.mjs';
import { digest } from '../server/contracts.mjs';

const password = 'Synthetic-only-owner-password-2026';
const request = { requestId: 'request-one', eventId: 'incident-one', assetId: 'asset-one', expectedVersion: 0 };
const code = expected => error => error.code === expected;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dq-response-test-'));
  let now = 1_790_000_000_000;
  const keys = generateKeyPairSync('ed25519');
  const options = { path: join(directory, 'core.sqlite'), privateKey: keys.privateKey, keyId: 'response-test', clock: () => now };
  let core = await openGovernance(options);
  t.after(async () => { core.close(); await rm(directory, { recursive: true, force: true }); });
  await core.local.bootstrap({ tenantId: 'tenant-one', username: 'owner-one', password, assetIds: ['asset-one', 'asset-two'] });
  const { sessionToken } = await core.application.login({ tenantId: 'tenant-one', username: 'owner-one', password }, 'test');
  const { workerToken } = core.local.provisionWorker({ tenantId: 'tenant-one', workerId: 'worker-one', expiresAt: now + 86_400_000 });
  core.local.recordObservation({ tenantId: 'tenant-one', assetId: 'asset-one', eventId: 'incident-one', version: 0 });
  return { get core() { return core; }, sessionToken, workerToken, keys, directory,
    async reopen() { core.close(); core = await openGovernance(options); }, advance(ms) { now += ms; } };
}
async function approve(f, requestId = 'request-one') {
  const row = f.core.application.responses(f.sessionToken).find(row => row.requestId === requestId);
  const { intentToken } = await f.core.application.reauthenticate(f.sessionToken,
    { password, purpose: 'PUBLISH_GRANT', manifestDigest: row.manifestDigest }, 'test');
  return f.core.application.approveResponse(f.sessionToken, { requestId, manifestDigest: row.manifestDigest, intentToken });
}

test('助理請求、人核准、登出後執行、重播及重啟讀回使用真實核心', async t => {
  const f = await fixture(t);
  const proposed = f.core.execution.requestResponse(f.workerToken, request);
  assert.equal(proposed.state, 'AWAITING_HUMAN');
  assert.throws(() => f.core.execution.applyResponse(f.workerToken, request.requestId), code('HUMAN_APPROVAL_REQUIRED'));
  assert.equal(f.core.execution.inspect(f.workerToken).assets[0].state, 'ACTIVE');
  await f.reopen();
  assert.deepEqual(f.core.execution.requestResponse(f.workerToken, request), proposed);
  await approve(f); f.core.application.logout(f.sessionToken);
  const receipt = f.core.execution.applyResponse(f.workerToken, request.requestId);
  assert.equal(verifyReceipt(receipt, f.keys.publicKey, 'response-test'), true);
  assert.deepEqual(f.core.execution.applyResponse(f.workerToken, request.requestId), receipt);
  await f.reopen();
  const state = f.core.execution.inspect(f.workerToken);
  assert.equal(state.assets[0].state, 'CONTAINED');
  assert.deepEqual(state.responses[0].receipt, receipt);
  assert.equal(state.responses[0].draft.maxEffects, 1);
  assert.deepEqual(f.core.execution.applyResponse(f.workerToken, request.requestId), receipt);
  const tampered = structuredClone(receipt); tampered.body.after.state = 'ACTIVE';
  assert.equal(verifyReceipt(tampered, f.keys.publicKey, 'response-test'), false);
});

test('錯 digest、角色、自稱人類、worker token、重播意圖不得核准', async t => {
  const f = await fixture(t);
  const row = f.core.execution.requestResponse(f.workerToken, request);
  const input = { requestId: request.requestId, manifestDigest: row.manifestDigest, intentToken: f.workerToken };
  assert.throws(() => f.core.application.approveResponse(f.workerToken, input), code('AUTH_REQUIRED'));
  assert.throws(() => f.core.application.approveResponse(f.sessionToken, { ...input, actorType: 'HUMAN' }), code('SCHEMA_INVALID'));
  const { intentToken } = await f.core.application.reauthenticate(f.sessionToken,
    { password, purpose: 'PUBLISH_GRANT', manifestDigest: row.manifestDigest }, 'test');
  assert.throws(() => f.core.application.approveResponse(f.sessionToken, { ...input, intentToken, manifestDigest: 'a'.repeat(64) }), code('RESPONSE_CHANGED'));
  f.core.application.approveResponse(f.sessionToken, { ...input, intentToken });
  assert.throws(() => f.core.application.approveResponse(f.sessionToken, { ...input, intentToken }), code('RESPONSE_ALREADY_APPROVED'));
  await f.core.local.provisionMember({ tenantId: 'tenant-one', username: 'reviewer-one', password, role: 'REVIEWER' });
  const other = await f.core.application.login({ tenantId: 'tenant-one', username: 'reviewer-one', password }, 'test');
  assert.throws(() => f.core.application.approveResponse(other.sessionToken, input), code('PERMISSION_DENIED'));
});

test('獨立離線 verifier 固定外部公鑰，不信任證據內置替換 key，且只宣稱 receipt', async t => {
  const f = await fixture(t);
  f.core.execution.requestResponse(f.workerToken, request); await approve(f);
  const receipt = f.core.execution.applyResponse(f.workerToken, request.requestId);
  const path = join(f.directory, 'evidence.json'); const key = join(f.directory, 'public.pem');
  const badKey = join(f.directory, 'wrong-public.pem');
  await writeFile(key, f.keys.publicKey.export({ type: 'spki', format: 'pem' }));
  await writeFile(badKey, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
  const evidence = { schemaVersion: 'dungeonq.assistant-evidence/v1', response: { receipt }, verificationKey: 'not-trusted' };
  await writeFile(path, JSON.stringify(evidence));
  const run = pinned => spawnSync(process.execPath, [new URL('../scripts/verify-assistant-evidence.mjs', import.meta.url).pathname, path, pinned, 'response-test'], { encoding: 'utf8' });
  const valid = run(key); assert.equal(valid.status, 0);
  assert.equal(JSON.parse(valid.stdout).envelopeAuthenticated, false);
  assert.equal(run(badKey).status, 1);
  evidence.response.receipt.body.after.version += 1;
  await writeFile(path, JSON.stringify(evidence)); assert.equal(run(key).status, 1);
});

test('請求衝突、未知事件、跨租戶和另一 worker 不得挪用', async t => {
  const f = await fixture(t);
  f.core.execution.requestResponse(f.workerToken, request);
  assert.throws(() => f.core.execution.requestResponse(f.workerToken, { ...request, assetId: 'asset-two' }), code('RESPONSE_CONFLICT'));
  assert.throws(() => f.core.execution.requestResponse(f.workerToken, { ...request, requestId: 'new-request', eventId: 'unknown' }), code('OBSERVATION_UNAVAILABLE'));
  const worker2 = f.core.local.provisionWorker({ tenantId: 'tenant-one', workerId: 'worker-two', expiresAt: 1_790_086_400_000 }).workerToken;
  assert.throws(() => f.core.execution.applyResponse(worker2, request.requestId), code('RESPONSE_UNAVAILABLE'));
  assert.deepEqual(f.core.execution.inspect(worker2).responses, []);
  await f.core.local.bootstrap({ tenantId: 'tenant-two', username: 'owner-two', password, assetIds: ['asset-one'] });
  const worker3 = f.core.local.provisionWorker({ tenantId: 'tenant-two', workerId: 'worker-three', expiresAt: 1_790_086_400_000 }).workerToken;
  assert.throws(() => f.core.execution.applyResponse(worker3, request.requestId), code('RESPONSE_UNAVAILABLE'));
  assert.deepEqual(f.core.execution.inspect(worker3).responses, []);
});

test('到期、撤銷與停用 worker 仍 fail closed', async t => {
  const f = await fixture(t);
  f.core.execution.requestResponse(f.workerToken, request); await approve(f);
  const intent = await f.core.application.reauthenticate(f.sessionToken,
    { password, purpose: 'REVOKE_GRANTS', manifestDigest: digest({ tenantId: 'tenant-one', action: 'REVOKE_GRANTS' }) }, 'test');
  f.core.application.revokeGrants(f.sessionToken, intent.intentToken);
  assert.throws(() => f.core.execution.applyResponse(f.workerToken, request.requestId), code('GRANT_INACTIVE'));
  assert.equal(f.core.execution.inspect(f.workerToken).assets[0].state, 'ACTIVE');
  f.advance(300_001);
  assert.throws(() => f.core.execution.requestResponse(f.workerToken, { ...request, requestId: 'expired' }), code('OBSERVATION_UNAVAILABLE'));
  f.core.local.revokeWorker('worker-one');
  assert.throws(() => f.core.execution.inspect(f.workerToken), code('WORKER_AUTH_REQUIRED'));
});
