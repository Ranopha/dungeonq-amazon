import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openGovernance } from '../server/governance.mjs';
import { openReferenceIssuer, ROTATION_DOMAIN } from '../server/reference-issuer.mjs';
import { openLocalNotificationSink } from '../server/local-notification-sink.mjs';
import { Store } from '../server/store.mjs';
import { digest, canonicalJson } from '../server/contracts.mjs';

const password = 'Synthetic-owner-rotation-password-2026';
const target = { tenantId: 'tenant-a', assetId: 'api-orders', expectedGeneration: 0, epoch: 1, cleanConsumer: 'clean-consumer' };
const contact = { tenantId: 'tenant-a', incidentId: 'incident-one', assetId: 'api-orders', worldId: 'world-b', eventDigest: digest({ event: 'synthetic-contact' }) };
const input = { requestId: 'rotation-one', incidentId: 'incident-one' };
const checks = { oldKeyDenied: true, newKeyBusiness: true, oldConsumerDenied: true, decoyKeyDenied: true };
const code = value => error => error.code === value;

async function fixture(t, { rotation = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dq-defense-governance-'));
  let now = 1_790_000_000_000;
  const privateKey = generateKeyPairSync('ed25519').privateKey;
  const rotationPrivateKey = generateKeyPairSync('ed25519').privateKey;
  const options = { path: join(directory, 'core.sqlite'), privateKey, keyId: 'defense-test', clock: () => now,
    ...(rotation ? { rotationPrivateKey } : {}) };
  let core = await openGovernance(options);
  let issuer;
  t.after(async () => { core.close(); issuer?.close(); await rm(directory, { recursive: true, force: true }); });
  const boot = await core.local.bootstrap({ tenantId: 'tenant-a', username: 'owner-a', password, assetIds: ['api-orders'] });
  const login = await core.application.login({ tenantId: 'tenant-a', username: 'owner-a', password }, 'test');
  const { workerToken } = core.local.provisionWorker({ tenantId: 'tenant-a', workerId: 'worker-a', expiresAt: now + 86_400_000 });
  const f = { get core() { return core; }, options, directory, rotationPrivateKey, session: login.sessionToken, workerToken,
    recoveryCode: boot.recoveryCodes[0], advance(ms) { now += ms; },
    async reopen() { core.close(); core = await openGovernance(options); },
    prepare() { core.local.registerRotationTarget(target); core.local.recordDecoyContact(contact); return core.execution.requestRotation(workerToken, input); },
    async approve(requestId = input.requestId) {
      const row = core.application.rotationStatus(f.session).requests.find(row => row.requestId === requestId);
      const intent = await core.application.reauthenticate(f.session, { password, purpose: 'APPROVE_ROTATION', manifestDigest: row.manifestDigest }, 'test');
      return core.application.approveRotation(f.session, { requestId, manifestDigest: row.manifestDigest, intentToken: intent.intentToken });
    },
    issuer() {
      issuer = openReferenceIssuer({ path: join(directory, 'issuer.sqlite'), custodyKey: randomBytes(32),
        authorizationPublicKey: createPublicKey(rotationPrivateKey), clock: () => now });
      const consumers = issuer.bootstrap({ tenantId: 'tenant-a', assetId: 'api-orders', consumers: ['old-consumer', 'clean-consumer'] });
      return { issuer, consumers };
    }
  };
  return f;
}

test('同一誘餌事故耐久入列、實際sink收件、重播與重啟不重送，未知角色身分保持未判定', async t => {
  const f = await fixture(t); f.prepare();
  const sink = openLocalNotificationSink({ path: join(f.directory, 'sink.sqlite'), tenantId: 'tenant-a' });
  t.after(() => sink.close());
  let status = f.core.application.rotationStatus(f.session);
  assert.equal(status.incidents[0].notification.state, 'PENDING');
  assert.equal(status.incidents[0].actorClassification, 'UNDETERMINED');
  assert.equal((await f.core.notifications.dispatch(sink)).state, 'DELIVERED');
  status = f.core.application.rotationStatus(f.session);
  assert.equal(sink.lookup(status.incidents[0].notification.receipt).eventId, status.incidents[0].notification.eventId);
  assert.equal(f.core.local.recordDecoyContact(contact).replay, true);
  assert.throws(() => f.core.local.recordDecoyContact({ ...contact, actorType: 'AI' }), code('SCHEMA_INVALID'));
  assert.throws(() => f.core.local.recordDecoyContact({ ...contact, worldId: 'world-c' }), code('DECOY_INCIDENT_CONFLICT'));
  await f.reopen();
  assert.deepEqual(f.core.application.rotationStatus(f.session), status);
  assert.equal((await f.core.notifications.dispatch(sink)).state, 'IDLE');
});

test('獨立管理員核准精確輪換，實際Issuer舊key/consumer及decoy拒絕、新key成功、結果重播無新permit', async t => {
  const f = await fixture(t); const proposal = f.prepare();
  const { issuer, consumers } = f.issuer();
  const oldKey = issuer.acquire(consumers['old-consumer'], 'api-orders');
  assert.equal(issuer.business({ tenantId: 'tenant-a', assetId: 'api-orders', apiKey: oldKey }).quantity, 7);
  assert.equal(proposal.state, 'AWAITING_HUMAN');
  assert.equal(proposal.authorizationActive, false);
  assert.throws(() => f.core.execution.claimRotation(f.workerToken, { requestId: input.requestId }), code('HUMAN_APPROVAL_REQUIRED'));
  assert.equal((await f.approve()).authorizationActive, true);
  await f.reopen();
  const claim = f.core.execution.claimRotation(f.workerToken, { requestId: input.requestId });
  assert.equal(verify(null, Buffer.from(ROTATION_DOMAIN + canonicalJson(claim.permit.body)), createPublicKey(f.rotationPrivateKey), Buffer.from(claim.permit.signature, 'base64url')), true);
  const replay = f.core.execution.claimRotation(f.workerToken, { requestId: input.requestId });
  assert.deepEqual(replay.permit, claim.permit); assert.equal(replay.replay, true);
  const receipt = issuer.rotate(claim.permit);
  const newKey = issuer.acquire(consumers['clean-consumer'], 'api-orders');
  assert.equal(issuer.business({ tenantId: 'tenant-a', assetId: 'api-orders', apiKey: newKey }).generation, 1);
  assert.throws(() => issuer.business({ tenantId: 'tenant-a', assetId: 'api-orders', apiKey: oldKey }), code('KEY_REJECTED'));
  assert.throws(() => issuer.acquire(consumers['old-consumer'], 'api-orders'), code('CONSUMER_FENCED'));
  const decoyKey = randomBytes(32).toString('base64url');
  assert.throws(() => issuer.business({ tenantId: 'tenant-a', assetId: 'api-orders', apiKey: decoyKey }), code('KEY_REJECTED'));
  const result = { tenantId: 'tenant-a', requestId: input.requestId, manifestDigest: claim.manifestDigest, status: 'COMPLETED', receipt, checks };
  assert.equal(f.core.local.recordRotationOutcome(result).state, 'COMPLETED');
  await f.reopen();
  assert.equal(f.core.local.registerRotationTarget(target).generation, 1);
  assert.throws(() => f.core.local.registerRotationTarget({ ...target, expectedGeneration: 1 }), code('ROTATION_TARGET_CONFLICT'));
  assert.equal(f.core.local.recordRotationOutcome(result).state, 'COMPLETED');
  const history = f.core.execution.claimRotation(f.workerToken, { requestId: input.requestId });
  assert.equal(history.state, 'COMPLETED'); assert.equal(Object.hasOwn(history, 'permit'), false);
  assert.deepEqual(history.receipt, receipt);
  assert.deepEqual(f.core.local.rotationRequestsToReconcile({ tenantId: 'tenant-a' }), []);
});

test('Worker、自稱人類、Reviewer、containment意圖和錯digest不能核准輪換', async t => {
  const f = await fixture(t); const proposal = f.prepare();
  const approval = { requestId: input.requestId, manifestDigest: proposal.manifestDigest, intentToken: f.workerToken };
  assert.throws(() => f.core.application.approveRotation(f.workerToken, approval), code('AUTH_REQUIRED'));
  assert.throws(() => f.core.application.approveRotation(f.session, { ...approval, actorType: 'HUMAN' }), code('SCHEMA_INVALID'));
  const old = await f.core.application.reauthenticate(f.session, { password, purpose: 'PUBLISH_GRANT', manifestDigest: proposal.manifestDigest }, 'test');
  assert.throws(() => f.core.application.approveRotation(f.session, { ...approval, intentToken: old.intentToken }), code('INTENT_INVALID'));
  const good = await f.core.application.reauthenticate(f.session, { password, purpose: 'APPROVE_ROTATION', manifestDigest: proposal.manifestDigest }, 'test');
  assert.throws(() => f.core.application.approveRotation(f.session, { ...approval, intentToken: good.intentToken, manifestDigest: 'f'.repeat(64) }), code('ROTATION_CHANGED'));
  await f.core.local.provisionMember({ tenantId: 'tenant-a', username: 'reviewer-a', password, role: 'REVIEWER' });
  const other = await f.core.application.login({ tenantId: 'tenant-a', username: 'reviewer-a', password }, 'test');
  await assert.rejects(f.core.application.reauthenticate(other.sessionToken, { password, purpose: 'APPROVE_ROTATION', manifestDigest: proposal.manifestDigest }, 'test'), code('PERMISSION_DENIED'));
  assert.throws(() => f.core.application.approveRotation(other.sessionToken, approval), code('PERMISSION_DENIED'));
  f.core.application.approveRotation(f.session, { ...approval, intentToken: good.intentToken });
  assert.throws(() => f.core.application.approveRotation(f.session, { ...approval, intentToken: good.intentToken }), code('ROTATION_ALREADY_DECIDED'));
});

test('跨租戶／另一Worker及同事故不同request拒絕，兩事故同generation只有一個claim', async t => {
  const f = await fixture(t); f.prepare();
  assert.deepEqual(f.core.execution.requestRotation(f.workerToken, input), f.core.application.rotationStatus(f.session).requests[0]);
  assert.throws(() => f.core.execution.requestRotation(f.workerToken, { ...input, requestId: 'rotation-alias' }), code('ROTATION_REQUEST_CONFLICT'));
  const w2 = f.core.local.provisionWorker({ tenantId: 'tenant-a', workerId: 'worker-b', expiresAt: 1_790_086_400_000 }).workerToken;
  assert.throws(() => f.core.execution.requestRotation(w2, input), code('ROTATION_REQUEST_CONFLICT'));
  assert.throws(() => f.core.execution.claimRotation(w2, { requestId: input.requestId }), code('ROTATION_UNAVAILABLE'));
  await f.core.local.bootstrap({ tenantId: 'tenant-b', username: 'owner-b', password, assetIds: ['api-orders'] });
  const b = await f.core.application.login({ tenantId: 'tenant-b', username: 'owner-b', password }, 'test');
  const wb = f.core.local.provisionWorker({ tenantId: 'tenant-b', workerId: 'worker-c', expiresAt: 1_790_086_400_000 }).workerToken;
  assert.deepEqual(f.core.application.rotationStatus(b.sessionToken), { incidents: [], requests: [] });
  assert.throws(() => f.core.execution.requestRotation(wb, input), code('DECOY_INCIDENT_UNAVAILABLE'));
  assert.throws(() => f.core.execution.claimRotation(wb, { requestId: input.requestId }), code('ROTATION_UNAVAILABLE'));
  await f.approve();
  f.core.local.recordDecoyContact({ ...contact, incidentId: 'incident-two' });
  f.core.execution.requestRotation(f.workerToken, { requestId: 'rotation-two', incidentId: 'incident-two' });
  await f.approve('rotation-two');
  f.core.execution.claimRotation(f.workerToken, { requestId: input.requestId });
  assert.throws(() => f.core.execution.claimRotation(f.workerToken, { requestId: 'rotation-two' }), code('ROTATION_GENERATION_CLAIMED'));
});

test('未知結果重啟後只能對帳、不再取得permit或延長效期，完成讀回不可缺任一項', async t => {
  const f = await fixture(t); const proposal = f.prepare(); await f.approve();
  const claim = f.core.execution.claimRotation(f.workerToken, { requestId: input.requestId });
  const { issuer } = f.issuer(); const receipt = issuer.rotate(claim.permit);
  const result = { tenantId: 'tenant-a', requestId: input.requestId, manifestDigest: claim.manifestDigest,
    status: 'UNKNOWN', receipt: null, checks: { oldKeyDenied: false, newKeyBusiness: false, oldConsumerDenied: false, decoyKeyDenied: false } };
  f.core.local.recordRotationOutcome(result); await f.reopen();
  assert.throws(() => f.core.execution.claimRotation(f.workerToken, { requestId: input.requestId }), code('ROTATION_RECONCILIATION_REQUIRED'));
  assert.equal(f.core.execution.requestRotation(f.workerToken, input).manifest.expiresAt, proposal.manifest.expiresAt);
  assert.equal(f.core.local.rotationRequestsToReconcile({ tenantId: 'tenant-a' })[0].storedState, 'UNKNOWN');
  for (const key of Object.keys(checks)) assert.throws(() => f.core.local.recordRotationOutcome({ ...result, status: 'COMPLETED', receipt, checks: { ...checks, [key]: false } }), code('ROTATION_READBACK_REQUIRED'));
  assert.throws(() => f.core.local.recordRotationOutcome({ ...result, status: 'COMPLETED', receipt: { ...receipt, assetId: 'wrong-asset' }, checks }), code('ROTATION_RECEIPT_INVALID'));
  assert.throws(() => f.core.local.recordRotationOutcome({ ...result, status: 'COMPLETED', receipt: { ...receipt, generation: 9 }, checks }), code('ROTATION_RECEIPT_INVALID'));
  assert.throws(() => f.core.local.recordRotationOutcome({ ...result, manifestDigest: 'f'.repeat(64) }), code('ROTATION_RESULT_UNBOUND'));
  f.advance(300_001);
  assert.equal(f.core.local.recordRotationOutcome({ ...result, status: 'COMPLETED', receipt, checks }).state, 'COMPLETED');
});

test('過期與Worker撤銷關閉新核准／claim，Proposal重播不續期', async t => {
  const f = await fixture(t); const row = f.prepare();
  const intent = await f.core.application.reauthenticate(f.session, { password, purpose: 'APPROVE_ROTATION', manifestDigest: row.manifestDigest }, 'test');
  f.advance(300_001);
  assert.throws(() => f.core.application.approveRotation(f.session, { requestId: row.requestId, manifestDigest: row.manifestDigest, intentToken: intent.intentToken }), code('ROTATION_FENCED'));
  assert.equal(f.core.execution.requestRotation(f.workerToken, input).state, 'EXPIRED');
  assert.equal(f.core.execution.requestRotation(f.workerToken, input).manifest.expiresAt, row.manifest.expiresAt);
  f.core.local.revokeWorker('worker-a');
  assert.throws(() => f.core.execution.claimRotation(f.workerToken, { requestId: row.requestId }), code('WORKER_AUTH_REQUIRED'));
});

test('Owner可刷新尚未claim的過期提案，保留事故與scope、清空approval與舊intent，曾claim不能刷新', async t => {
  const f = await fixture(t); const original = f.prepare();
  assert.throws(() => f.core.application.refreshRotation(f.workerToken, { requestId: input.requestId }), code('AUTH_REQUIRED'));
  assert.throws(() => f.core.application.refreshRotation(f.session, { requestId: input.requestId }), code('ROTATION_REFRESH_DENIED'));
  f.advance(200_000);
  const oldIntent = await f.core.application.reauthenticate(f.session, { password, purpose: 'APPROVE_ROTATION', manifestDigest: original.manifestDigest }, 'test');
  f.advance(100_001);
  const refreshed = f.core.application.refreshRotation(f.session, { requestId: input.requestId });
  assert.equal(refreshed.requestId, original.requestId); assert.equal(refreshed.incidentId, original.incidentId);
  assert.equal(refreshed.state, 'AWAITING_HUMAN'); assert.equal(refreshed.approvedBy, null);
  assert.deepEqual({ ...refreshed.manifest, expiresAt: original.manifest.expiresAt }, original.manifest);
  assert.notEqual(refreshed.manifestDigest, original.manifestDigest);
  assert.throws(() => f.core.application.approveRotation(f.session, { requestId: input.requestId,
    manifestDigest: refreshed.manifestDigest, intentToken: oldIntent.intentToken }), code('INTENT_INVALID'));
  await f.approve(); f.core.execution.claimRotation(f.workerToken, { requestId: input.requestId }); f.advance(300_001);
  assert.throws(() => f.core.application.refreshRotation(f.session, { requestId: input.requestId }), code('ROTATION_REFRESH_DENIED'));
  const g = await fixture(t); g.prepare(); await g.approve(); g.advance(300_001);
  const reset = g.core.application.refreshRotation(g.session, { requestId: input.requestId });
  assert.equal(reset.approvedBy, null); assert.equal(reset.approvedAt, null);
  assert.throws(() => g.core.execution.claimRotation(g.workerToken, { requestId: input.requestId }), code('HUMAN_APPROVAL_REQUIRED'));
});

test('刷新提案不能復活撤銷epoch或停用Worker的權限', async t => {
  for (const revoke of ['TENANT', 'WORKER']) {
    const f = await fixture(t); f.prepare(); f.advance(300_001);
    if (revoke === 'TENANT') {
      const intent = await f.core.application.reauthenticate(f.session, { password, purpose: 'REVOKE_GRANTS', manifestDigest: digest({ tenantId: 'tenant-a', action: 'REVOKE_GRANTS' }) }, 'test');
      f.core.application.revokeGrants(f.session, intent.intentToken);
      assert.throws(() => f.core.application.refreshRotation(f.session, { requestId: input.requestId }), code('ROTATION_REFRESH_DENIED'));
    } else {
      f.core.local.revokeWorker('worker-a');
      assert.throws(() => f.core.application.refreshRotation(f.session, { requestId: input.requestId }), code('ROTATION_FENCED'));
    }
  }
});

test('Owner撤銷及Recovery Fence輪換但保存已發生效果的對帳，不復活舊權限', async t => {
  for (const recovery of [false, true]) {
    const f = await fixture(t); const proposal = f.prepare(); await f.approve();
    const claim = f.core.execution.claimRotation(f.workerToken, { requestId: input.requestId });
    const { issuer } = f.issuer(); const receipt = issuer.rotate(claim.permit);
    if (recovery) await f.core.application.recover({ tenantId: 'tenant-a', username: 'owner-a', recoveryCode: f.recoveryCode, newPassword: 'Replacement-synthetic-owner-password-2026' }, 'test');
    else {
      const intent = await f.core.application.reauthenticate(f.session, { password, purpose: 'REVOKE_GRANTS', manifestDigest: digest({ tenantId: 'tenant-a', action: 'REVOKE_GRANTS' }) }, 'test');
      f.core.application.revokeGrants(f.session, intent.intentToken);
    }
    await f.reopen();
    assert.throws(() => f.core.execution.claimRotation(f.workerToken, { requestId: input.requestId }), code('ROTATION_FENCED'));
    assert.equal(f.core.local.rotationRequestsToReconcile({ tenantId: 'tenant-a' })[0].state, 'FENCED');
    const readback = f.core.local.recordRotationOutcome({ tenantId: 'tenant-a', requestId: input.requestId,
      manifestDigest: proposal.manifestDigest, status: 'COMPLETED', receipt, checks });
    assert.equal(readback.state, 'COMPLETED'); assert.equal(readback.authorizationActive, false);
    assert.equal(Object.hasOwn(f.core.execution.claimRotation(f.workerToken, { requestId: input.requestId }), 'permit'), false);
  }
});

test('Rotation signer選配且獨立，啟用後缺失／替換拒絕；一般Store及Issuer不要求該私鑰', async t => {
  const f = await fixture(t, { rotation: false });
  assert.deepEqual(f.core.application.rotationStatus(f.session), { incidents: [], requests: [] });
  assert.throws(() => f.core.local.registerRotationTarget(target), code('ROTATION_NOT_CONFIGURED'));
  await assert.rejects(openGovernance({ ...f.options, rotationPrivateKey: f.options.privateKey }), code('ROTATION_KEY_NOT_SEPARATE'));
  const g = await fixture(t); g.prepare();
  await assert.rejects(openGovernance({ ...g.options, rotationPrivateKey: undefined }), code('ROTATION_KEY_REQUIRED'));
  await assert.rejects(openGovernance({ ...g.options, rotationPrivateKey: generateKeyPairSync('ed25519').privateKey }), code('ROTATION_KEY_PIN_MISMATCH'));
  assert.equal(g.core.local.rotationVerificationKey().domain, ROTATION_DOMAIN);
  const plain = new Store(join(g.directory, 'plain.sqlite')); assert.equal(plain.get('PRAGMA user_version').user_version, 7); plain.close();
});

test('v5→v6保留原紀錄／clock／epoch與舊證據；新增表衝突整體rollback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dq-defense-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const conflict of [false, true]) {
    const path = join(directory, `${conflict ? 'conflict' : 'valid'}.sqlite`);
    let db = new Store(path, () => 12345);
    db.transaction(now => { db.run("INSERT INTO tenants VALUES ('tenant-a',9)"); db.audit(now, 'tenant-a', 'HISTORIC_SYNTHETIC_EVENT', 'fixture'); });
    const previous = db.all('SELECT * FROM audit'); db.close();
    const legacy = new DatabaseSync(path);
    legacy.exec('DROP TABLE external_identities; DROP TABLE email_outbox; DROP TABLE email_challenges; DROP TABLE email_bindings; DROP TABLE rotation_claims; DROP TABLE rotation_requests; DROP TABLE decoy_incidents; DROP TABLE rotation_targets; PRAGMA user_version=5;');
    if (conflict) legacy.exec('CREATE TABLE rotation_requests(marker TEXT); INSERT INTO rotation_requests VALUES (\'synthetic-original\');');
    legacy.close();
    if (conflict) {
      assert.throws(() => new Store(path));
      const read = new DatabaseSync(path);
      assert.equal(read.prepare('PRAGMA user_version').get().user_version, 5);
      assert.equal(read.prepare('SELECT marker FROM rotation_requests').get().marker, 'synthetic-original');
      assert.equal(read.prepare("SELECT name FROM sqlite_schema WHERE name='rotation_targets'").get(), undefined); read.close();
    } else {
      db = new Store(path); assert.equal(db.get('PRAGMA user_version').user_version, 7);
      assert.equal(db.get("SELECT epoch FROM tenants WHERE id='tenant-a'").epoch, 9);
      assert.equal(db.get("SELECT value FROM meta WHERE key='clock'").value, 12345);
      assert.deepEqual(db.all('SELECT * FROM audit'), previous); db.close();
    }
  }
});
