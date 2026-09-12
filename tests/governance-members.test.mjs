import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { openGovernance } from '../server/governance.mjs';
import { digest, token } from '../server/contracts.mjs';

const PASSWORD = '合成成員管理測試-password-471';
const MEMBER_PASSWORD = '合成成員自己設定的長密碼-927';
const code = name => error => error.code === name;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dungeonq-members-'));
  let now = 1_790_000_000_000;
  const options = { path: join(directory, 'state.sqlite'), privateKey: generateKeyPairSync('ed25519').privateKey, keyId: 'member-lab', clock: () => now };
  let core = await openGovernance(options);
  t.after(async () => { core.close(); await rm(directory, { recursive: true, force: true }); });
  await core.local.bootstrap({ tenantId: 'tenant-a', username: 'owner-a', password: PASSWORD, assetIds: ['api-a'] });
  const owner = (await core.application.login({ tenantId: 'tenant-a', username: 'owner-a', password: PASSWORD }, 'local-test')).sessionToken;
  const draft = (overrides = {}) => ({ schemaVersion: 'dungeonq.lab-member-change/v1', tenantId: 'tenant-a', username: 'member-a', action: 'CREATE', role: 'MIS_OPERATOR', expectedEpoch: 0, ...overrides });
  const intent = async input => {
    now += 1000;
    return (await core.application.reauthenticate(owner, { password: PASSWORD, purpose: 'MANAGE_MEMBERS', manifestDigest: digest(input) }, 'local-test')).intentToken;
  };
  return { get core() { return core; }, owner, draft, intent, get now() { return now; }, advance: ms => { now += ms; },
    async apply(input) { const preview = core.application.previewMemberChange(owner, input); return core.application.applyMemberChange(owner, preview.draft, await intent(preview.draft)); },
    recover: setupCode => core.application.recover({ tenantId: 'tenant-a', username: 'member-a', recoveryCode: setupCode, newPassword: MEMBER_PASSWORD }, 'local-test'),
    login: () => core.application.login({ tenantId: 'tenant-a', username: 'member-a', password: MEMBER_PASSWORD }, 'local-test'),
    async ownerLogin() { return (await core.application.login({ tenantId: 'tenant-a', username: 'owner-a', password: PASSWORD }, 'local-test')).sessionToken; },
    async reopen() { core.close(); core = await openGovernance(options); }
  };
}

test('成員完整生命週期：一次設定→自己密碼登入→角色變更撤銷舊 Session/Codes→停用', async t => {
  const f = await fixture(t);
  const created = await f.apply(f.draft()); assert.equal(created.state, 'SETUP_PENDING'); assert.equal(created.setupCode.length, 43);
  assert.equal(created.setupExpiresAt - f.now, 86_400_000);
  await assert.rejects(f.login(), code('AUTH_FAILED'));
  const activated = await f.recover(created.setupCode); assert.equal(activated.grantsRevoked, false);
  const member = await f.login(); assert.equal(member.principal.role, 'MIS_OPERATOR');
  const current = f.core.application.members(f.owner).find(x => x.username === 'member-a');
  const changed = await f.apply(f.draft({ action: 'CHANGE_ROLE', role: 'AUDITOR', expectedEpoch: current.epoch }));
  assert.equal(changed.state, 'ACTIVE'); assert.equal(changed.role, 'AUDITOR');
  assert.throws(() => f.core.application.status(member.sessionToken), code('AUTH_REQUIRED'));
  await assert.rejects(f.recover(activated.recoveryCodes[0]), code('RECOVERY_FAILED'));
  const auditor = await f.login(); assert.equal(auditor.principal.role, 'AUDITOR');
  const disabled = await f.apply(f.draft({ action: 'DISABLE', role: 'AUDITOR', expectedEpoch: changed.epoch }));
  assert.equal(disabled.state, 'DISABLED');
  assert.throws(() => f.core.application.status(auditor.sessionToken), code('AUTH_REQUIRED'));
  await assert.rejects(f.login(), code('AUTH_FAILED'));
  const evidence = JSON.stringify(f.core.application.evidence(f.owner));
  assert.ok(!evidence.includes(created.setupCode)); assert.ok(!evidence.includes(MEMBER_PASSWORD));
  await f.reopen(); assert.equal(f.core.application.members(f.owner).find(x => x.username === 'member-a').state, 'DISABLED');
});

test('成員 API 拒絕其他角色、Owner 修改、Owner 升權、跨租戶與 Actor 注入', async t => {
  const f = await fixture(t); const ownerIntent = await f.intent(f.draft());
  for (const role of ['AUDITOR', 'MIS_OPERATOR', 'REVIEWER']) {
    await f.core.local.provisionMember({ tenantId: 'tenant-a', username: role.toLowerCase(), role, password: PASSWORD });
    const member = await f.core.application.login({ tenantId: 'tenant-a', username: role.toLowerCase(), password: PASSWORD }, 'local-test');
    assert.throws(() => f.core.application.members(member.sessionToken), code('PERMISSION_DENIED'));
    assert.throws(() => f.core.application.previewMemberChange(member.sessionToken, f.draft()), code('PERMISSION_DENIED'));
    await assert.rejects(f.core.application.applyMemberChange(member.sessionToken, f.draft(), ownerIntent), code('PERMISSION_DENIED'));
  }
  assert.throws(() => f.core.application.previewMemberChange(f.owner, f.draft({ username: 'owner-a', action: 'DISABLE', expectedEpoch: 1 })), code('MEMBER_UNAVAILABLE'));
  assert.throws(() => f.core.application.previewMemberChange(f.owner, f.draft({ role: 'TENANT_SUPER_ADMIN' })), code('UNSUPPORTED_CAPABILITY'));
  assert.throws(() => f.core.application.previewMemberChange(f.owner, f.draft({ tenantId: 'tenant-b' })), code('TENANT_DENIED'));
  assert.throws(() => f.core.application.previewMemberChange(f.owner, f.draft({ actorType: 'HUMAN' })), code('SCHEMA_INVALID'));
  assert.throws(() => f.core.application.members(token()), code('AUTH_REQUIRED'));
});

test('成員變更篡改／重播／競爭及 stale epoch 不得造成第二次副作用', async t => {
  const f = await fixture(t); const input = f.draft(); const intent = await f.intent(input);
  await assert.rejects(f.core.application.applyMemberChange(f.owner, { ...input, role: 'AUDITOR' }, intent), code('INTENT_INVALID'));
  const attempts = await Promise.allSettled([f.core.application.applyMemberChange(f.owner, input, intent), f.core.application.applyMemberChange(f.owner, input, intent)]);
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(f.core.application.members(f.owner).filter(x => x.username === input.username).length, 1);
  await assert.rejects(f.core.application.applyMemberChange(f.owner, input, intent), code('MEMBER_EXISTS'));
  const disable = f.draft({ action: 'DISABLE', expectedEpoch: 1 });
  const staleIntent = await f.intent(disable);
  f.core.local.disableMember({ tenantId: 'tenant-a', username: 'member-a' });
  await assert.rejects(f.core.application.applyMemberChange(f.owner, disable, staleIntent), code('MEMBER_STALE'));
});

test('初始設定碼可重發、舊碼與過期碼拒絕，停用不能重發或恢復', async t => {
  const f = await fixture(t); const first = await f.apply(f.draft());
  const next = await f.apply(f.draft({ action: 'REISSUE_SETUP', expectedEpoch: first.epoch }));
  await assert.rejects(f.recover(first.setupCode), code('RECOVERY_FAILED'));
  f.advance(86_400_000);
  await f.reopen(); await assert.rejects(f.recover(next.setupCode), code('RECOVERY_FAILED'));
  const owner = await f.ownerLogin();
  const row = f.core.application.members(owner).find(x => x.username === 'member-a'); assert.equal(row.state, 'SETUP_EXPIRED');
  const draft = f.draft({ action: 'REISSUE_SETUP', expectedEpoch: row.epoch });
  const intent = await f.core.application.reauthenticate(owner, { password: PASSWORD, purpose: 'MANAGE_MEMBERS', manifestDigest: digest(draft) }, 'local-test');
  const renewed = await f.core.application.applyMemberChange(owner, draft, intent.intentToken);
  f.core.local.disableMember({ tenantId: 'tenant-a', username: 'member-a' });
  await assert.rejects(f.recover(renewed.setupCode), code('RECOVERY_FAILED'));
  assert.throws(() => f.core.application.previewMemberChange(owner, { ...draft, expectedEpoch: renewed.epoch + 1 }), code('MEMBER_UNAVAILABLE'));
});

test('Owner 在新增密碼 hash 等待期間登出，不能繼續建立成員', async t => {
  const f = await fixture(t); const intent = await f.intent(f.draft());
  const pending = f.core.application.applyMemberChange(f.owner, f.draft(), intent);
  f.core.application.logout(f.owner);
  await assert.rejects(pending, code('AUTH_REQUIRED'));
  const owner = await f.ownerLogin(); assert.equal(f.core.application.members(owner).length, 1);
});
