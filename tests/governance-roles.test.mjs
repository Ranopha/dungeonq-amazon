import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openGovernance } from '../server/governance.mjs';
import { capabilities, authorize } from '../server/authorization.mjs';
import { digest, token } from '../server/contracts.mjs';

const PASSWORD = '合成角色測試專用密碼-orbit-482';
const NEXT = '合成恢復測試專用密碼-orbit-731';
const code = value => error => error.code === value;
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dungeonq-roles-'));
  let now = 1_790_000_000_000;
  const options = { path: join(directory, 'state.sqlite'), privateKey: generateKeyPairSync('ed25519').privateKey, keyId: 'lab-key', clock: () => now };
  let core = await openGovernance(options);
  t.after(async () => { core.close(); await rm(directory, { recursive: true, force: true }); });
  await core.local.bootstrap({ tenantId: 'tenant-a', username: 'owner-a', password: PASSWORD, assetIds: ['api-a'] });
  const login = username => core.application.login({ tenantId: 'tenant-a', username, password: PASSWORD }, 'test-source');
  const owner = (await login('owner-a')).sessionToken;
  const draft = { schemaVersion: 'dungeonq.lab-grant-draft/v1', tenantId: 'tenant-a', profile: 'SYNTHETIC_ONLY',
    assetIds: ['api-a'], effect: 'SYNTHETIC_CONTAINMENT', connectorVersion: 'sqlite-fixture/v1', runbookVersion: 'containment/v1',
    dependencyDigest: digest({ tenantId: 'tenant-a', assetIds: ['api-a'], connectorVersion: 'sqlite-fixture/v1' }),
    expiresAt: now + 3_600_000, maxEffects: 2, maxConcurrent: 1, leaseMs: 300_000 };
  const intent = (session, purpose, manifestDigest) => core.application.reauthenticate(session, { password: PASSWORD, purpose, manifestDigest }, 'test-source');
  return { get core() { return core; }, options, owner, draft, login, intent,
    advance: () => { now += 60_000; },
    async reopen() { core.close(); core = await openGovernance(options); },
    member: role => core.local.provisionMember({ tenantId: 'tenant-a', username: role.toLowerCase(), password: PASSWORD, role }) };
}

test('角色政策矩陣：低權限不能重驗／發布／撤銷，Reviewer 不冒充第二核准人', async t => {
  const f = await setup(t);
  const ownerIntent = await f.intent(f.owner, 'PUBLISH_GRANT', digest(f.draft));
  for (const role of ['MIS_OPERATOR', 'REVIEWER', 'AUDITOR']) {
    await f.member(role); const login = await f.login(role.toLowerCase()); const session = login.sessionToken;
    assert.equal(login.principal.role, role);
    const state = f.core.application.status(session);
    assert.equal(state.role, role); assert.deepEqual(state.capabilities, capabilities(role));
    assert.ok(f.core.application.evidence(session).events.every(event => event.body.tenant === 'tenant-a'));
    if (role === 'AUDITOR') assert.throws(() => f.core.application.previewGrant(session, f.draft), code('PERMISSION_DENIED'));
    else {
      assert.equal(f.core.application.previewGrant(session, f.draft).digest, digest(f.draft));
      assert.throws(() => f.core.application.previewGrant(session, { ...f.draft, tenantId: 'tenant-b' }), code('TENANT_DENIED'));
    }
    for (const purpose of ['PUBLISH_GRANT', 'REVOKE_GRANTS']) await assert.rejects(f.intent(session, purpose, digest(f.draft)), code('PERMISSION_DENIED'));
    assert.throws(() => f.core.application.publishGrant(session, f.draft, ownerIntent.intentToken), code('PERMISSION_DENIED'));
    assert.throws(() => f.core.application.revokeGrants(session, ownerIntent.intentToken), code('PERMISSION_DENIED'));
    assert.throws(() => f.core.application.renewRecoveryCodes(session, ownerIntent.intentToken), code('INTENT_INVALID'));
    assert.equal(f.core.application.logout(session).loggedOut, true);
  }
  assert.equal(f.core.application.publishGrant(f.owner, f.draft, ownerIntent.intentToken).body.authorization, 'SINGLE_OWNER_AUTHORIZED');
  for (const role of ['PLATFORM_OPERATOR', 'MACHINE_WORKER', '__proto__', 'constructor']) {
    assert.deepEqual(capabilities(role), []);
    assert.throws(() => authorize(role, 'READ_STATUS'), code('PERMISSION_DENIED'));
    await assert.rejects(f.core.local.provisionMember({ tenantId: 'tenant-a', username: 'unsupported-member', password: PASSWORD, role }), code('UNSUPPORTED_CAPABILITY'));
  }
  await assert.rejects(f.core.application.login({ tenantId: 'tenant-a', username: 'owner-a', password: PASSWORD, role: 'TENANT_SUPER_ADMIN' }, 'test-source'), code('SCHEMA_INVALID'));
  await f.reopen(); assert.equal(f.core.application.status(f.owner).role, 'TENANT_SUPER_ADMIN');
});

test('恢復碼更新只作用本人、單次意圖不可換人／重播，秘密不進證據／DB', async t => {
  const f = await setup(t); const member = await f.member('AUDITOR'); const session = (await f.login('auditor')).sessionToken;
  const manifest = { tenantId: 'tenant-a', principalId: member.principalId, action: 'RENEW_RECOVERY' };
  const intent = await f.intent(session, 'RENEW_RECOVERY', digest(manifest));
  assert.throws(() => f.core.application.renewRecoveryCodes(f.owner, intent.intentToken), code('INTENT_INVALID'));
  const result = f.core.application.renewRecoveryCodes(session, intent.intentToken);
  assert.equal(result.recoveryCodes.length, 8); assert.equal(result.notification, 'NOT_CONFIGURED');
  assert.throws(() => f.core.application.renewRecoveryCodes(session, intent.intentToken), code('INTENT_INVALID'));
  await assert.rejects(f.core.application.recover({ tenantId: 'tenant-a', username: 'auditor', recoveryCode: member.recoveryCodes[0], newPassword: NEXT }, 'test-source'), code('RECOVERY_FAILED'));
  await assert.rejects(f.core.application.recover({ tenantId: 'tenant-a', username: 'owner-a', recoveryCode: result.recoveryCodes[0], newPassword: NEXT }, 'test-source'), code('RECOVERY_FAILED'));
  const evidence = JSON.stringify(f.core.application.evidence(f.owner));
  const db = new DatabaseSync(f.options.path);
  const rows = JSON.stringify(db.prepare('SELECT * FROM recovery').all()); db.close();
  for (const value of result.recoveryCodes) { assert.ok(!evidence.includes(value)); assert.ok(!rows.includes(value)); }
  const recovered = await f.core.application.recover({ tenantId: 'tenant-a', username: 'auditor', recoveryCode: result.recoveryCodes[0], newPassword: NEXT }, 'test-source');
  assert.equal(recovered.grantsRevoked, false);
  assert.throws(() => f.core.application.status(session), code('AUTH_REQUIRED'));
});

test('低權限恢復不能連坐租戶 Grant／Worker；停用後舊登入／Code／正在驗證的請求失效', async t => {
  const f = await setup(t); const member = await f.member('MIS_OPERATOR');
  const session = (await f.login('mis_operator')).sessionToken;
  const auth = await f.intent(f.owner, 'PUBLISH_GRANT', digest(f.draft));
  const grant = f.core.application.publishGrant(f.owner, f.draft, auth.intentToken);
  const { workerToken } = f.core.local.provisionWorker({ tenantId: 'tenant-a', workerId: 'worker-a', expiresAt: f.draft.expiresAt });
  f.core.local.recordObservation({ tenantId: 'tenant-a', eventId: 'event-a', assetId: 'api-a', version: 0 });
  const job = f.core.execution.claim(workerToken, { grantId: grant.body.grantId, eventId: 'event-a', assetId: 'api-a', expectedVersion: 0 });
  const recovered = await f.core.application.recover({ tenantId: 'tenant-a', username: 'mis_operator', recoveryCode: member.recoveryCodes[0], newPassword: NEXT }, 'test-source');
  assert.equal(recovered.grantsRevoked, false);
  assert.equal(f.core.application.status(f.owner).grants[0].state, 'ACTIVE');
  assert.equal(f.core.execution.apply(workerToken, job.jobId).body.state, 'COMPLETED');
  assert.throws(() => f.core.application.status(session), code('AUTH_REQUIRED'));
  const loginInFlight = f.core.application.login({ tenantId: 'tenant-a', username: 'mis_operator', password: NEXT }, 'test-source');
  f.core.local.disableMember({ tenantId: 'tenant-a', username: 'mis_operator' });
  await assert.rejects(loginInFlight, code('AUTH_FAILED'));
  await assert.rejects(f.core.application.recover({ tenantId: 'tenant-a', username: 'mis_operator', recoveryCode: recovered.recoveryCodes[0], newPassword: PASSWORD }, 'test-source'), code('RECOVERY_FAILED'));
  assert.throws(() => f.core.local.disableMember({ tenantId: 'tenant-a', username: 'owner-a' }), code('MEMBER_UNAVAILABLE'));
  assert.throws(() => f.core.local.disableMember({ tenantId: 'tenant-b', username: 'mis_operator' }), code('MEMBER_UNAVAILABLE'));
  await f.reopen();
  await assert.rejects(f.core.application.login({ tenantId: 'tenant-a', username: 'mis_operator', password: NEXT }, 'test-source'), code('AUTH_FAILED'));
});

test('停用與恢復雜湊並行：恢復不能重新啟用帳號；未知方法預設拒絕', async t => {
  const f = await setup(t); const member = await f.member('REVIEWER');
  const pending = f.core.application.recover({ tenantId: 'tenant-a', username: 'reviewer', recoveryCode: member.recoveryCodes[0], newPassword: NEXT }, 'test-source');
  f.core.local.disableMember({ tenantId: 'tenant-a', username: 'reviewer' });
  await assert.rejects(pending, code('RECOVERY_FAILED'));
  assert.throws(() => authorize('TENANT_SUPER_ADMIN', 'ARBITRARY_SQL'), code('PERMISSION_DENIED'));
  assert.throws(() => f.core.application.renewRecoveryCodes(token(), token()), code('AUTH_REQUIRED'));
});
