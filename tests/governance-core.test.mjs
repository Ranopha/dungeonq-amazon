import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { openGovernance, verifyReceipt } from '../server/governance.mjs';
import { digest, token } from '../server/contracts.mjs';
import { hashPassword, verifyPassword } from '../server/passwords.mjs';

const PASSWORD = '合成測試專用的安全長密碼-apple-42';
const NEW_PASSWORD = '合成恢復後的新密碼-planet-57';
const MINUTE = 60_000;
const DAY = 86_400_000;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dungeonq-governance-'));
  let now = 1_790_000_000_000;
  const keys = generateKeyPairSync('ed25519');
  const options = { path: join(directory, 'governance.sqlite'), privateKey: keys.privateKey, keyId: 'lab-signing-v1', clock: () => now };
  let core = await openGovernance(options);
  t.after(async () => { core.close(); await rm(directory, { recursive: true, force: true }); });
  const boot = await core.local.bootstrap({ tenantId: 'tenant-a', username: 'owner-a', password: PASSWORD, assetIds: ['api-a', 'api-b'] });
  const { sessionToken } = await core.application.login({ tenantId: 'tenant-a', username: 'owner-a', password: PASSWORD }, 'local-test');
  const { workerToken } = core.local.provisionWorker({ tenantId: 'tenant-a', workerId: 'worker-a', expiresAt: now + DAY });
  return {
    directory, options, keys, sessionToken, workerToken, recoveryCodes: boot.recoveryCodes,
    get core() { return core; }, get now() { return now; }, advance(ms) { now += ms; },
    async reopen() { core.close(); core = await openGovernance(options); },
    draft(overrides = {}) {
      return { schemaVersion: 'dungeonq.lab-grant-draft/v1', tenantId: 'tenant-a', profile: 'SYNTHETIC_ONLY',
        assetIds: ['api-a', 'api-b'], effect: 'SYNTHETIC_CONTAINMENT', connectorVersion: 'sqlite-fixture/v1',
        runbookVersion: 'containment/v1', dependencyDigest: digest({ tenantId: 'tenant-a', assetIds: ['api-a', 'api-b'], connectorVersion: 'sqlite-fixture/v1' }),
        expiresAt: now + DAY, maxEffects: 2, maxConcurrent: 1, leaseMs: 300_000, ...overrides };
    }
  };
}
async function publish(f, overrides = {}) {
  const preview = f.core.application.previewGrant(f.sessionToken, f.draft(overrides));
  const intent = await f.core.application.reauthenticate(f.sessionToken,
    { password: PASSWORD, purpose: 'PUBLISH_GRANT', manifestDigest: preview.digest }, 'local-test');
  return f.core.application.publishGrant(f.sessionToken, preview.draft, intent.intentToken);
}
function observe(f, assetId = 'api-a', eventId = 'event-a') {
  return f.core.local.recordObservation({ tenantId: 'tenant-a', eventId, assetId, version: 0 });
}
function claim(f, grant, overrides = {}) {
  return f.core.execution.claim(f.workerToken, { grantId: grant.body.grantId, eventId: 'event-a', assetId: 'api-a', expectedVersion: 0, ...overrides });
}
const code = expected => error => error.code === expected;

test('無 FIDO：密碼核准、Logout、人離線後機器執行，Receipt 可由公鑰獨立驗證', async t => {
  const f = await fixture(t);
  assert.equal(f.core.application.status(f.sessionToken).fidoRequired, false);
  const grant = await publish(f);
  assert.equal(grant.body.authorization, 'SINGLE_OWNER_AUTHORIZED');
  f.core.application.logout(f.sessionToken);
  f.advance(8 * 60 * MINUTE); // 虛擬時間，不冒充八小時 soak。
  observe(f);
  const job = claim(f, grant);
  const receipt = f.core.execution.apply(f.workerToken, job.jobId);
  assert.equal(receipt.body.state, 'COMPLETED');
  assert.equal(verifyReceipt(receipt, f.keys.publicKey, 'lab-signing-v1'), true);
  assert.deepEqual(f.core.execution.apply(f.workerToken, job.jobId), receipt);
  assert.equal(claim(f, grant).replay, true);
  assert.throws(() => f.core.application.status(f.sessionToken), code('AUTH_REQUIRED'));
  assert.deepEqual(f.core.execution.pending(f.workerToken), []);
});

test('密碼使用 Argon2id 且 DB 不保存明文、Session／Worker／恢復碼原文', async t => {
  const f = await fixture(t);
  const db = new DatabaseSync(f.options.path);
  const row = db.prepare('SELECT password FROM users').get();
  const encoded = JSON.parse(row.password);
  assert.equal(encoded.algorithm, 'argon2id');
  assert.equal(encoded.memory, 19_456);
  assert.equal(encoded.passes, 2);
  const all = ['users', 'sessions', 'workers', 'recovery', 'audit'].map(name => db.prepare(`SELECT * FROM ${name}`).all());
  db.close();
  const serialized = JSON.stringify(all);
  for (const sensitive of [PASSWORD, f.sessionToken, f.workerToken, ...f.recoveryCodes]) assert.ok(!serialized.includes(sensitive));
  await assert.rejects(f.core.local.bootstrap({ tenantId: 'tenant-b', username: 'owner-b', password: 'passwordpassword', assetIds: ['api-a'] }), code('PASSWORD_POLICY'));
  await assert.rejects(f.core.local.bootstrap({ tenantId: 'tenant-b', username: 'owner-b', password: 'x'.repeat(129), assetIds: ['api-a'] }), code('PASSWORD_INVALID'));
  await assert.rejects(f.core.local.bootstrap({ tenantId: 'tenant-a', username: 'evil', password: PASSWORD, assetIds: ['api-a'] }), code('BOOTSTRAP_CLOSED'));
});

test('不能用 actor 字串、Worker Token 或任意 Token 假冒人類／跨租戶授權', async t => {
  const f = await fixture(t);
  assert.throws(() => f.core.application.previewGrant({ actorType: 'HUMAN', role: 'TENANT_SUPER_ADMIN' }, f.draft()), code('AUTH_REQUIRED'));
  assert.throws(() => f.core.application.previewGrant(f.workerToken, f.draft()), code('AUTH_REQUIRED'));
  assert.throws(() => f.core.application.status(token()), code('AUTH_REQUIRED'));
  assert.throws(() => f.core.application.previewGrant(f.sessionToken, f.draft({ actorType: 'HUMAN' })), code('SCHEMA_INVALID'));
  assert.throws(() => f.core.application.previewGrant(f.sessionToken, f.draft({ tenantId: 'tenant-b' })), code('TENANT_DENIED'));
  assert.throws(() => f.core.application.previewGrant(f.sessionToken, f.draft({ assetIds: ['api-missing'] })), code('SCOPE_INVALID'));
  assert.throws(() => f.core.application.previewGrant(f.sessionToken, f.draft({ profile: 'MANAGED_PRODUCTION' })), code('UNSUPPORTED_CAPABILITY'));
  assert.throws(() => f.core.application.previewGrant(f.sessionToken, f.draft({ effect: 'ROTATE_CREDENTIAL' })), code('UNSUPPORTED_CAPABILITY'));
});

test('單次重新驗證綁定 Digest／用途／Session，篡改與重播不能發布', async t => {
  const f = await fixture(t);
  const preview = f.core.application.previewGrant(f.sessionToken, f.draft());
  const { intentToken } = await f.core.application.reauthenticate(f.sessionToken,
    { password: PASSWORD, purpose: 'PUBLISH_GRANT', manifestDigest: preview.digest }, 'local-test');
  assert.throws(() => f.core.application.publishGrant(f.sessionToken, { ...preview.draft, maxEffects: 3 }, intentToken), code('INTENT_INVALID'));
  assert.throws(() => f.core.application.revokeGrants(f.sessionToken, intentToken), code('INTENT_INVALID'));
  const second = await f.core.application.login({ tenantId: 'tenant-a', username: 'owner-a', password: PASSWORD }, 'local-test');
  assert.throws(() => f.core.application.publishGrant(second.sessionToken, preview.draft, intentToken), code('INTENT_INVALID'));
  f.core.application.publishGrant(f.sessionToken, preview.draft, intentToken);
  assert.throws(() => f.core.application.publishGrant(f.sessionToken, preview.draft, intentToken), code('INTENT_INVALID'));
});

test('過期意圖與過期 Session 拒絕，不依賴使用者回傳時間', async t => {
  const f = await fixture(t);
  const preview = f.core.application.previewGrant(f.sessionToken, f.draft());
  const intent = await f.core.application.reauthenticate(f.sessionToken,
    { password: PASSWORD, purpose: 'PUBLISH_GRANT', manifestDigest: preview.digest }, 'local-test');
  f.advance(5 * MINUTE);
  assert.throws(() => f.core.application.publishGrant(f.sessionToken, preview.draft, intent.intentToken), code('INTENT_INVALID'));
  f.advance(15 * MINUTE);
  assert.throws(() => f.core.application.status(f.sessionToken), code('AUTH_REQUIRED'));
});

test('恢復碼一次性使用，撤銷所有舊 Session、Intent、Grant，原密碼失效', async t => {
  const f = await fixture(t);
  const grant = await publish(f); observe(f); const job = claim(f, grant);
  const result = await f.core.application.recover({ tenantId: 'tenant-a', username: 'owner-a',
    recoveryCode: f.recoveryCodes[0], newPassword: NEW_PASSWORD }, 'local-test');
  assert.equal(result.recoveryCodes.length, 8);
  assert.throws(() => f.core.application.status(f.sessionToken), code('AUTH_REQUIRED'));
  assert.throws(() => f.core.execution.apply(f.workerToken, job.jobId), code('JOB_FENCED'));
  assert.throws(() => claim(f, grant), code('GRANT_INACTIVE'));
  await assert.rejects(f.core.application.login({ tenantId: 'tenant-a', username: 'owner-a', password: PASSWORD }, 'local-test'), code('AUTH_FAILED'));
  const login = await f.core.application.login({ tenantId: 'tenant-a', username: 'owner-a', password: NEW_PASSWORD }, 'local-test');
  assert.equal(login.principal.authentication, 'PASSWORD');
  await assert.rejects(f.core.application.recover({ tenantId: 'tenant-a', username: 'owner-a',
    recoveryCode: f.recoveryCodes[0], newPassword: PASSWORD }, 'local-test'), code('RECOVERY_FAILED'));
  await assert.rejects(f.core.application.recover({ tenantId: 'tenant-a', username: 'owner-a',
    recoveryCode: f.recoveryCodes[1], newPassword: PASSWORD }, 'local-test'), code('RECOVERY_FAILED'));
});

test('逐帳號／來源／全域限速持久化，重啟不能繞過', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 3; i++) {
    await assert.rejects(f.core.application.login({ tenantId: 'tenant-a', username: 'unknown', password: PASSWORD }, 'source-a'), code('AUTH_FAILED'));
  }
  await assert.rejects(f.core.application.login({ tenantId: 'tenant-a', username: 'unknown', password: PASSWORD }, 'source-a'), code('AUTH_FAILED'));
  await f.reopen();
  await assert.rejects(f.core.application.login({ tenantId: 'tenant-a', username: 'unknown', password: PASSWORD }, 'source-b'), code('AUTH_RATE_LIMIT'));
  f.advance(10 * MINUTE);
  await assert.rejects(f.core.application.login({ tenantId: 'tenant-a', username: 'unknown', password: PASSWORD }, 'source-b'), code('AUTH_FAILED'));
  for (let i = 0; i < 30; i++) await assert.rejects(f.core.application.login({ tenantId: 'tenant-a', username: `missing-${i}`, password: PASSWORD }, 'shared-source'), code('AUTH_FAILED'));
  await assert.rejects(f.core.application.login({ tenantId: 'tenant-a', username: 'new-target', password: PASSWORD }, 'shared-source'), code('AUTH_RATE_LIMIT'));
});

test('來源未登錄的事件、同事件不同目標、資產版本漂移都拒絕', async t => {
  const f = await fixture(t); const grant = await publish(f);
  assert.throws(() => claim(f, grant), code('OBSERVATION_UNAVAILABLE'));
  observe(f);
  assert.throws(() => f.core.local.recordObservation({ tenantId: 'tenant-a', eventId: 'event-a', assetId: 'api-b', version: 0 }), code('EVENT_CONFLICT'));
  assert.throws(() => claim(f, grant, { expectedVersion: 1 }), code('OBSERVATION_UNAVAILABLE'));
  const job = claim(f, grant);
  assert.throws(() => claim(f, grant, { eventId: 'event-b' }), code('CLAIM_CONFLICT'));
  assert.throws(() => f.core.execution.apply(f.sessionToken, job.jobId), code('WORKER_AUTH_REQUIRED'));
});

test('Claim／Outbox／完成 Receipt 跨重啟存在，10,000 重播不新增效果', async t => {
  const f = await fixture(t); const grant = await publish(f); observe(f); const job = claim(f, grant);
  await f.reopen();
  assert.deepEqual(f.core.execution.pending(f.workerToken), [{ id: job.jobId, state: 'CLAIMED' }]);
  const receipt = f.core.execution.apply(f.workerToken, job.jobId);
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) assert.equal(claim(f, grant).jobId, job.jobId);
  t.diagnostic(`10,000 次合成 Claim 重播：${Math.round(performance.now() - start)} ms（單機、固定時鐘，非正式 SLA）`);
  await f.reopen();
  assert.deepEqual(f.core.execution.apply(f.workerToken, job.jobId), receipt);
  const state = f.core.application.status(f.sessionToken);
  assert.equal(state.assets[0].version, 1);
  assert.equal(state.grants[0].used, 1);
  const evidence = f.core.application.evidence(f.sessionToken);
  assert.equal(evidence.receipts.length, 1);
  assert.equal(evidence.events.filter(event => event.body.kind === 'EFFECT_VERIFIED').length, 1);
});

test('並行上限與總預算不可因不同事件繞過', async t => {
  const f = await fixture(t); const grant = await publish(f, { maxEffects: 1 });
  observe(f); observe(f, 'api-b', 'event-b');
  const job = claim(f, grant);
  assert.throws(() => claim(f, grant, { assetId: 'api-b', eventId: 'event-b' }), code('BUDGET_EXHAUSTED'));
  f.core.execution.apply(f.workerToken, job.jobId);
  assert.throws(() => claim(f, grant, { assetId: 'api-b', eventId: 'event-b' }), code('BUDGET_EXHAUSTED'));
});

test('過期 Lease 耐久 Fence，不回填成功也不退款重送', async t => {
  const f = await fixture(t); const grant = await publish(f, { leaseMs: 1000 }); observe(f); const job = claim(f, grant);
  f.advance(1000);
  assert.deepEqual(f.core.execution.apply(f.workerToken, job.jobId), { state: 'FENCED', reason: 'LEASE_INACTIVE' });
  await f.reopen();
  assert.throws(() => f.core.execution.apply(f.workerToken, job.jobId), code('JOB_FENCED'));
  assert.equal(f.core.application.status(f.sessionToken).assets[0].state, 'ACTIVE');
  assert.deepEqual(f.core.execution.pending(f.workerToken), []);
});

test('Grant 撤銷與時鐘倒退拒絕新效果，Worker 撤銷不靠人類 Session', async t => {
  const f = await fixture(t); const grant = await publish(f); observe(f); const job = claim(f, grant);
  const intent = await f.core.application.reauthenticate(f.sessionToken, { password: PASSWORD, purpose: 'REVOKE_GRANTS',
    manifestDigest: digest({ tenantId: 'tenant-a', action: 'REVOKE_GRANTS' }) }, 'local-test');
  f.core.application.revokeGrants(f.sessionToken, intent.intentToken);
  await f.reopen();
  assert.throws(() => claim(f, grant), code('GRANT_INACTIVE'));
  assert.throws(() => f.core.execution.apply(f.workerToken, job.jobId), code('JOB_FENCED'));
  f.advance(-1);
  assert.throws(() => f.core.execution.pending(f.workerToken), code('CLOCK_ROLLBACK'));
  f.advance(1);
  f.core.local.revokeWorker('worker-a');
  assert.throws(() => f.core.execution.pending(f.workerToken), code('WORKER_AUTH_REQUIRED'));
});

test('獨立核驗器拒絕篡改、錯誤公鑰與非合成證據', async t => {
  const f = await fixture(t); const grant = await publish(f); observe(f);
  const receipt = f.core.execution.apply(f.workerToken, claim(f, grant).jobId);
  const tampered = structuredClone(receipt); tampered.body.assetId = 'another-asset';
  assert.equal(verifyReceipt(tampered, f.keys.publicKey, 'lab-signing-v1'), false);
  assert.equal(verifyReceipt(receipt, generateKeyPairSync('ed25519').publicKey, 'lab-signing-v1'), false);
  assert.equal(verifyReceipt(receipt, f.keys.publicKey, 'other-key'), false);
  assert.equal(verifyReceipt(null, f.keys.publicKey, 'lab-signing-v1'), false);
  assert.equal(verifyReceipt({ ...receipt, actorType: 'HUMAN' }, f.keys.publicKey, 'lab-signing-v1'), false);
  const cyclic = structuredClone(receipt); cyclic.body.extra = cyclic;
  assert.equal(verifyReceipt(cyclic, f.keys.publicKey, 'lab-signing-v1'), false);
});

test('持久化 Grant／Lease 被篡改不能產生效果，稽核列禁止更新刪除', async t => {
  const f = await fixture(t); const grant = await publish(f); observe(f); const job = claim(f, grant);
  const db = new DatabaseSync(f.options.path);
  const lease = JSON.parse(db.prepare('SELECT lease FROM jobs WHERE id=?').get(job.jobId).lease);
  lease.assetId = 'api-b';
  db.prepare('UPDATE jobs SET lease=? WHERE id=?').run(JSON.stringify(lease), job.jobId);
  assert.throws(() => db.exec("DELETE FROM audit"), /AUDIT_IMMUTABLE/u);
  assert.throws(() => db.exec("UPDATE audit SET digest='fake'"), /AUDIT_IMMUTABLE/u);
  db.close();
  assert.deepEqual(f.core.execution.apply(f.workerToken, job.jobId), { state: 'FENCED', reason: 'SIGNATURE_INVALID' });
  assert.ok(f.core.application.status(f.sessionToken).assets.every(asset => asset.state === 'ACTIVE'));
});

test('新租戶的 Worker 不可拿另一租戶 Grant 或讀 Evidence', async t => {
  const f = await fixture(t); const grant = await publish(f);
  await f.core.local.bootstrap({ tenantId: 'tenant-b', username: 'owner-b', password: PASSWORD, assetIds: ['api-a'] });
  const { workerToken } = f.core.local.provisionWorker({ tenantId: 'tenant-b', workerId: 'worker-b', expiresAt: f.now + DAY });
  observe(f);
  assert.throws(() => f.core.execution.claim(workerToken, { grantId: grant.body.grantId, eventId: 'event-a', assetId: 'api-a', expectedVersion: 0 }), code('GRANT_UNAVAILABLE'));
  const other = await f.core.application.login({ tenantId: 'tenant-b', username: 'owner-b', password: PASSWORD }, 'local-test');
  assert.ok(f.core.application.evidence(other.sessionToken).events.every(event => event.body.tenant === 'tenant-b'));
});

test('拒絕正式 Profile、非私有儲存與未知 Migration 版本', async t => {
  const f = await fixture(t);
  await assert.rejects(openGovernance({ ...f.options, profile: 'MANAGED_PRODUCTION' }), code('PROFILE_NOT_AUTHORIZED'));
  const path = join(f.directory, 'future.sqlite');
  const db = new DatabaseSync(path); db.exec('PRAGMA user_version=99'); db.close();
  await chmod(path, 0o600);
  await assert.rejects(openGovernance({ ...f.options, path }), code('SCHEMA_VERSION_UNSUPPORTED'));
  await chmod(path, 0o644);
  await assert.rejects(openGovernance({ ...f.options, path }), code('STORAGE_NOT_PRIVATE'));
});

test('曾拒絕過期 Session 的時間不能倒退復活；重開時釘選簽章身分', async t => {
  const f = await fixture(t);
  f.advance(15 * MINUTE);
  assert.throws(() => f.core.application.status(f.sessionToken), code('AUTH_REQUIRED'));
  f.advance(-1);
  assert.throws(() => f.core.application.status(f.sessionToken), code('CLOCK_ROLLBACK'));
  f.advance(1);
  await assert.rejects(openGovernance({ ...f.options, privateKey: generateKeyPairSync('ed25519').privateKey }), code('SIGNER_PIN_MISMATCH'));
});

// 私鑰／Token 僅經測試子程序 stdin 傳遞，不放參數、檔案或日誌。
const CHILD = `
import { openGovernance } from './server/governance.mjs';
import { createPrivateKey } from 'node:crypto';
let raw=''; for await (const chunk of process.stdin) raw+=chunk;
const input=JSON.parse(raw);
const core=await openGovernance({path:input.path, privateKey:createPrivateKey({key:Buffer.from(input.key,'base64'),format:'der',type:'pkcs8'}),keyId:'lab-signing-v1',clock:()=>input.now});
try {
 const result=core.execution.claim(input.workerToken,input.claim);
 process.stdout.write(JSON.stringify(result)+'\\n');
 if(input.stay) setInterval(()=>{},1000); else core.close();
} catch(error) {core.close();process.stdout.write(JSON.stringify({code:error.code})+'\\n');}
`;
function child(f, grant, stay = false) {
  const processChild = spawn(process.execPath, ['--input-type=module', '-e', CHILD], { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  processChild.stderr.on('data', data => { stderr += data; });
  processChild.stdin.end(JSON.stringify({ path: f.options.path, key: f.keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    now: f.now, workerToken: f.workerToken, claim: { grantId: grant.body.grantId, eventId: 'event-a', assetId: 'api-a', expectedVersion: 0 }, stay }));
  const exit = new Promise(resolve => processChild.once('exit', (status, signal) => resolve({ status, signal })));
  const result = new Promise((resolve, reject) => {
    let buffer = '';
    processChild.stdout.on('data', data => { buffer += data; if (buffer.includes('\n')) resolve(JSON.parse(buffer.trim())); });
    processChild.on('error', reject);
    processChild.on('exit', () => { if (!buffer.includes('\n')) reject(new Error(stderr)); });
  });
  return { process: processChild, result, exit };
}

test('兩個 OS 程序同時 Claim 只產生一筆，程序強制終止後可接續', { timeout: 20_000 }, async t => {
  const f = await fixture(t); const grant = await publish(f); observe(f);
  const a = child(f, grant, true); const b = child(f, grant);
  t.after(() => { a.process.kill('SIGKILL'); b.process.kill('SIGKILL'); });
  const [first, second] = await Promise.all([a.result, b.result]);
  assert.equal(first.jobId, second.jobId);
  assert.notEqual(first.replay, second.replay);
  a.process.kill('SIGKILL');
  assert.equal((await a.exit).signal, 'SIGKILL'); await b.exit;
  await f.reopen();
  const receipt = f.core.execution.apply(f.workerToken, first.jobId);
  assert.equal(receipt.body.after.version, 1);
  assert.equal(f.core.application.status(f.sessionToken).grants[0].used, 1);
});

test('效果交易中被 SIGKILL：未提交的資產更新回復，Outbox 仍可接續', { timeout: 20_000 }, async t => {
  const f = await fixture(t); const grant = await publish(f); observe(f); const job = claim(f, grant);
  const script = `
    import { Store } from './server/store.mjs';
    let raw=''; for await(const chunk of process.stdin) raw+=chunk;
    const input=JSON.parse(raw); const db=new Store(input.path,()=>input.now);
    db.transaction(()=>{
      db.run("UPDATE assets SET state='CONTAINED',version=version+1 WHERE tenant=? AND id=?",'tenant-a','api-a');
      process.kill(process.pid,'SIGKILL');
    });
  `;
  const childProcess = spawn(process.execPath, ['--input-type=module', '-e', script],
    { cwd: new URL('..', import.meta.url), stdio: ['pipe', 'ignore', 'pipe'] });
  t.after(() => childProcess.kill('SIGKILL'));
  const exited = new Promise(resolve => childProcess.once('exit', (status, signal) => resolve({ status, signal })));
  childProcess.stdin.end(JSON.stringify({ path: f.options.path, now: f.now }));
  assert.equal((await exited).signal, 'SIGKILL');
  await f.reopen();
  assert.equal(f.core.application.status(f.sessionToken).assets[0].version, 0);
  assert.equal(f.core.application.status(f.sessionToken).assets[0].state, 'ACTIVE');
  assert.equal(f.core.execution.pending(f.workerToken).length, 1);
  assert.equal(f.core.execution.apply(f.workerToken, job.jobId).body.after.version, 1);
});

test('Argon2id 唯一 Salt、Unicode 正規化、長密碼與 Hash 併行上限', async t => {
  const password = '合成測試的很長密碼-' + 'ab'.repeat(30) + 'e\u0301';
  const start = performance.now();
  const first = await hashPassword(password);
  t.diagnostic(`Argon2id 19 MiB／2 passes 單次：${Math.round(performance.now() - start)} ms（本機測量）`);
  const second = await hashPassword(password);
  assert.notEqual(JSON.parse(first).salt, JSON.parse(second).salt);
  assert.notEqual(JSON.parse(first).hash, JSON.parse(second).hash);
  assert.equal(await verifyPassword(password.normalize('NFC'), first), true);
  assert.equal(await verifyPassword(password + 'x', first), false);
  const a = hashPassword(PASSWORD); const b = hashPassword(PASSWORD);
  await assert.rejects(hashPassword(PASSWORD), code('AUTH_CAPACITY'));
  await Promise.all([a, b]);
});

test('Grant 過期／簽章篡改、未知 Worker、偽造事件欄位一律拒絕', async t => {
  const f = await fixture(t); const grant = await publish(f, { expiresAt: f.now + MINUTE }); observe(f);
  assert.throws(() => f.core.execution.claim(token(), { grantId: grant.body.grantId, eventId: 'event-a', assetId: 'api-a', expectedVersion: 0 }), code('WORKER_AUTH_REQUIRED'));
  assert.throws(() => claim(f, grant, { confidence: 100 }), code('SCHEMA_INVALID'));
  const db = new DatabaseSync(f.options.path);
  const original = db.prepare('SELECT body FROM grants WHERE id=?').get(grant.body.grantId).body;
  const changed = JSON.parse(original); changed.maxEffects = 100;
  db.prepare('UPDATE grants SET body=? WHERE id=?').run(JSON.stringify(changed), grant.body.grantId);
  assert.throws(() => claim(f, grant), code('SIGNATURE_INVALID'));
  db.prepare('UPDATE grants SET body=? WHERE id=?').run(original, grant.body.grantId); db.close();
  f.advance(MINUTE);
  assert.throws(() => claim(f, grant), code('GRANT_INACTIVE'));
});

test('全域登入桶限制不同來源／帳號；拒絕請求不無限擴張 counter', async t => {
  const f = await fixture(t);
  // 已有一筆 fixture login；無效短輸入在 Hash 前拒絕但仍消耗 Admission。
  for (let i = 0; i < 119; i++) await assert.rejects(f.core.application.login({ tenantId: 'tenant-a', username: `random-${i}`, password: '' }, `source-${i}`), code('AUTH_FAILED'));
  await assert.rejects(f.core.application.login({ tenantId: 'tenant-a', username: 'last', password: PASSWORD }, 'last-source'), code('AUTH_RATE_LIMIT'));
  const db = new DatabaseSync(f.options.path);
  const count = db.prepare('SELECT count(*) AS n FROM rate_limits').get().n;
  assert.equal(count, 241); db.close();
});
