import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { openGovernance } from '../server/governance.mjs';
import { otpAt, matchOtp, seedVault, base32 } from '../server/totp.mjs';
import { digest, canonicalJson } from '../server/contracts.mjs';
import { openReferenceIssuer, ROTATION_DOMAIN } from '../server/reference-issuer.mjs';
import { validateIsolationPlan } from '../server/isolation-plan.mjs';
import { Store } from '../server/store.mjs';

const PASSWORD = 'synthetic-services-password-281';
const err = name => error => error.code === name;
function decode32(text) {
  let bits = ''; for (const char of text) bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char).toString(2).padStart(5, '0');
  return Buffer.from(bits.match(/.{8}/gu).map(byte => parseInt(byte, 2)));
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dq-services-')); let now = 1_790_000_010_000;
  const options = { path: join(directory, 'control.sqlite'), privateKey: generateKeyPairSync('ed25519').privateKey, keyId: 'services-lab', factorKey: randomBytes(32), clock: () => now };
  let core = await openGovernance(options);
  t.after(async () => { core.close(); await rm(directory, { recursive: true, force: true }); });
  const account = await core.local.bootstrap({ tenantId: 'tenant-a', username: 'owner-a', password: PASSWORD, assetIds: ['api-a'] });
  const login = otp => core.application.login({ tenantId: 'tenant-a', username: 'owner-a', password: PASSWORD, ...(otp === undefined ? {} : { otp }) }, 'local-test');
  let session = (await login()).sessionToken;
  return { directory, options, account, login, get core() { return core; }, get now() { return now; }, advance: ms => { now += ms; },
    get session() { return session; }, setSession: value => { session = value; },
    async intent(action, otp) { const state = core.application.status(session); return (await core.application.reauthenticate(session,
      { password: PASSWORD, purpose: action, manifestDigest: digest({ tenantId: state.tenantId, principalId: state.principalId, action }), ...(otp === undefined ? {} : { otp }) }, 'local-test')).intentToken; },
    async reopen() { core.close(); core = await openGovernance(options); }
  };
}

test('RFC 6238 SHA1 向量、六位碼與 AES-GCM 綁定不接受跨帳號或篡改', () => {
  const seed = Buffer.from('12345678901234567890');
  for (const [seconds, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
    assert.equal(otpAt(seed, Math.floor(seconds / 30), 8), expected);
  }
  const now = 60000; assert.equal(matchOtp(seed, otpAt(seed, 2), now), 2); assert.equal(matchOtp(seed, otpAt(seed, 2), now, 2), null);
  const vault = seedVault(randomBytes(32)); const sealed = vault.seal(seed, 'one');
  assert.deepEqual(vault.open(sealed, 'one'), seed); assert.throws(() => vault.open(sealed, 'two'), err('TOTP_CUSTODY_FAILED'));
  assert.throws(() => vault.open('!'+sealed, 'one'), err('TOTP_CUSTODY_FAILED'));
});

test('TOTP 選配：啟用確認、舊 Session 撤銷、缺碼／重播拒絕、重驗不能降級、重啟後仍有效', async t => {
  const f = await fixture(t);
  assert.equal(f.core.application.status(f.session).authentication, 'PASSWORD');
  const enrolled = f.core.application.beginTotp(f.session, await f.intent('ENROLL_TOTP'));
  const seed = decode32(enrolled.secret); assert.equal(base32(seed), enrolled.secret);
  assert.equal(f.core.application.status(f.session).authentication, 'PASSWORD');
  assert.throws(() => f.core.application.confirmTotp(f.session, { otp: 'bad' }, 'local-test'), err('AUTH_FAILED'));
  f.core.application.confirmTotp(f.session, { otp: otpAt(seed, Math.floor(f.now / 30000)) }, 'local-test');
  assert.throws(() => f.core.application.status(f.session), err('AUTH_REQUIRED'));
  await assert.rejects(f.login(), err('AUTH_FAILED'));
  await assert.rejects(f.login(otpAt(seed, Math.floor(f.now / 30000))), err('AUTH_FAILED'));
  f.advance(600_000); await f.reopen();
  const logged = await f.login(otpAt(seed, Math.floor(f.now / 30000))); f.setSession(logged.sessionToken);
  assert.equal(logged.principal.authentication, 'PASSWORD_TOTP');
  assert.ok(f.core.application.evidence(f.session).events.some(event => event.body.kind === 'LOGIN_REJECTED'));
  await assert.rejects(f.intent('REMOVE_TOTP'), err('AUTH_FAILED'));
  f.advance(30000);
  const removal = await f.intent('REMOVE_TOTP', otpAt(seed, Math.floor(f.now / 30000)));
  f.core.application.removeTotp(f.session, removal);
  assert.throws(() => f.core.application.status(f.session), err('AUTH_REQUIRED'));
  f.advance(600_000); assert.equal((await f.login()).principal.authentication, 'PASSWORD');
  const bytes = await readFile(f.options.path); assert.ok(!bytes.includes(Buffer.from(enrolled.secret))); assert.ok(!bytes.includes(seed));
});

test('TOTP 不能換保管 key／遺失 key 後靜默降級；註冊過期與恢復清除因素有明確結果', async t => {
  const f = await fixture(t);
  await assert.rejects(openGovernance({ ...f.options, factorKey: randomBytes(32) }), err('TOTP_KEY_PIN_MISMATCH'));
  await assert.rejects(openGovernance({ ...f.options, factorKey: undefined }), err('TOTP_KEY_REQUIRED'));
  const first = f.core.application.beginTotp(f.session, await f.intent('ENROLL_TOTP')); f.advance(300001);
  assert.throws(() => f.core.application.confirmTotp(f.session, { otp: otpAt(decode32(first.secret), Math.floor(f.now / 30000)) }, 'local-test'), err('TOTP_ENROLLMENT_INVALID'));
  const next = f.core.application.beginTotp(f.session, await f.intent('ENROLL_TOTP'));
  f.core.application.confirmTotp(f.session, { otp: otpAt(decode32(next.secret), Math.floor(f.now / 30000)) }, 'local-test');
  const recovered = await f.core.application.recover({ tenantId: 'tenant-a', username: 'owner-a', recoveryCode: f.account.recoveryCodes[0], newPassword: PASSWORD }, 'local-test');
  assert.equal(recovered.factorRemoved, true); assert.equal(recovered.grantsRevoked, true);
  const session = (await f.login()).sessionToken;
  assert.ok(f.core.application.evidence(session).events.some(x => x.body.details.factorRemoved));
  assert.ok(f.core.application.notifications(session).length > 0);
});

test('通知耐久、並行只送一次、敏感內容不入訊息，未知回應只對帳不重送', async t => {
  const f = await fixture(t); const codes = f.core.application.renewRecoveryCodes(f.session, await f.intent('RENEW_RECOVERY'));
  await f.reopen(); let sends = 0; const receipts = new Map(); let payload;
  const sink = { profile: 'LOCAL_SINK_ONLY', tenantId: 'tenant-a', async send(message) {
    sends++; payload = JSON.stringify(message); const result = { eventId: message.eventId, auditDigest: message.auditDigest, receiptId: digest(message) };
    receipts.set(digest(message), result); throw new Error('response lost secret');
  }, lookup: key => receipts.get(key) ?? null };
  const results = await Promise.all([f.core.notifications.dispatch(sink), f.core.notifications.dispatch(sink)]);
  assert.equal(sends, 1); assert.ok(results.some(x => x.state === 'UNKNOWN')); assert.ok(results.some(x => x.state === 'IDLE'));
  assert.ok(!payload.includes(codes.recoveryCodes[0])); assert.ok(!payload.includes(PASSWORD));
  f.advance(3000); await f.reopen(); const settled = await f.core.notifications.dispatch(sink);
  assert.equal(settled.state, 'DELIVERED'); assert.equal(sends, 1);
  assert.equal(f.core.application.notifications(f.session)[0].status, 'DELIVERED');
});

test('通知明確未接受才限額重試，永遠無回應有 timeout，查不到不得改成已送', async t => {
  const f = await fixture(t); f.core.application.renewRecoveryCodes(f.session, await f.intent('RENEW_RECOVERY'));
  const sink = { profile: 'LOCAL_SINK_ONLY', tenantId: 'tenant-a', send: () => ({ state: 'NOT_ACCEPTED' }), lookup: () => null };
  for (let n = 1; n <= 5; n++) { const result = await f.core.notifications.dispatch(sink); assert.equal(result.state, n === 5 ? 'FAILED' : 'RETRY'); f.advance(61000); }
  f.core.application.renewRecoveryCodes(f.session, await f.intent('RENEW_RECOVERY'));
  let calls = 0; sink.send = () => { calls++; return new Promise(() => {}); };
  assert.equal((await f.core.notifications.dispatch(sink, { timeoutMs: 10 })).state, 'UNKNOWN'); f.advance(3000);
  assert.equal((await f.core.notifications.dispatch(sink)).state, 'UNKNOWN'); assert.equal(calls, 1);
});

test('通知程序中斷留下 SENDING：租約到期只查證；租戶隔離與佇列篡改不得派送', async t => {
  const f = await fixture(t); f.core.application.renewRecoveryCodes(f.session, await f.intent('RENEW_RECOVERY'));
  const writer = new Store(f.options.path, () => f.now); t.after(() => writer.close());
  writer.transaction(now => writer.run("UPDATE notifications SET status='SENDING',claim='interrupted',deadline=?", now + 1000));
  await f.reopen(); let sends = 0; let lookups = 0;
  const sink = { profile: 'LOCAL_SINK_ONLY', tenantId: 'tenant-a', send: () => { sends++; return null; }, lookup: () => { lookups++; return null; } };
  f.advance(1001); assert.equal((await f.core.notifications.dispatch(sink)).state, 'UNKNOWN'); assert.equal(sends, 0); assert.equal(lookups, 1);
  assert.equal((await f.core.notifications.dispatch({ ...sink, tenantId: 'tenant-b' })).state, 'IDLE');
  writer.transaction(() => writer.run("UPDATE notifications SET status='PENDING',next_at=0,body='{}'"));
  await assert.rejects(f.core.notifications.dispatch(sink), err('NOTIFICATION_INTEGRITY')); assert.equal(sends, 0);
});

test('TOTP 同碼並行登入僅一筆成功，確認不得使用別的 Session 或額外 actor 欄位', async t => {
  const f = await fixture(t); const enrolled = f.core.application.beginTotp(f.session, await f.intent('ENROLL_TOTP'));
  const another = (await f.login()).sessionToken; const seed = decode32(enrolled.secret);
  assert.throws(() => f.core.application.confirmTotp(another, { otp: otpAt(seed, Math.floor(f.now / 30000)) }, 'local-test'), err('TOTP_ENROLLMENT_INVALID'));
  assert.throws(() => f.core.application.confirmTotp(f.session, { otp: '123456', actorType: 'HUMAN' }, 'local-test'), err('SCHEMA_INVALID'));
  f.core.application.confirmTotp(f.session, { otp: otpAt(seed, Math.floor(f.now / 30000)) }, 'local-test');
  f.advance(600000); const otp = otpAt(seed, Math.floor(f.now / 30000));
  const attempts = await Promise.allSettled([f.login(otp), f.login(otp)]);
  assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(x => x.status === 'rejected')[0].reason.code, 'AUTH_FAILED');
});

test('Reference Issuer 實際 key 輪換、舊 key 拒絕、舊 Consumer 禁領、新 Consumer 業務讀回及重啟對帳', async t => {
  const f = await fixture(t); const signer = generateKeyPairSync('ed25519');
  const options = { path: join(f.directory, 'issuer.sqlite'), custodyKey: randomBytes(32), authorizationPublicKey: signer.publicKey, clock: () => f.now };
  let issuer = openReferenceIssuer(options); t.after(() => issuer.close());
  const consumers = issuer.bootstrap({ tenantId: 'tenant-a', assetId: 'api-a', consumers: ['old-consumer', 'clean-consumer'] });
  const oldKey = issuer.acquire(consumers['old-consumer'], 'api-a');
  assert.equal(issuer.business({ tenantId: 'tenant-a', assetId: 'api-a', apiKey: oldKey }).quantity, 7);
  const body = { schemaVersion: 'dungeonq.reference-rotation/v1', profile: 'SYNTHETIC_ONLY', tenantId: 'tenant-a', assetId: 'api-a', expectedGeneration: 0, epoch: 1, cleanConsumer: 'clean-consumer', expiresAt: f.now + 120000 };
  const signed = value => ({ body: value, signature: sign(null, Buffer.from(ROTATION_DOMAIN + canonicalJson(value)), signer.privateKey).toString('base64url') });
  assert.throws(() => issuer.rotate({ ...signed(body), body: { ...body, tenantId: 'other-tenant' } }), err('SIGNATURE_INVALID'));
  assert.throws(() => issuer.rotate(signed({ ...body, expectedGeneration: 1 })), err('ROTATION_CONFLICT'));
  issuer.rotate(signed(body)); // 假設成功回應在 caller 端遺失，重啟後先讀回。
  issuer.close(); issuer = openReferenceIssuer(options);
  assert.equal(issuer.receipt(digest(body)).generation, 1); assert.equal(issuer.receipt(digest(body)).businessVerified, false);
  assert.throws(() => issuer.business({ tenantId: 'tenant-a', assetId: 'api-a', apiKey: oldKey }), err('KEY_REJECTED'));
  assert.throws(() => issuer.acquire(consumers['old-consumer'], 'api-a'), err('CONSUMER_FENCED'));
  const newKey = issuer.acquire(consumers['clean-consumer'], 'api-a'); assert.notEqual(newKey, oldKey);
  assert.equal(issuer.business({ tenantId: 'tenant-a', assetId: 'api-a', apiKey: newKey }).generation, 1);
  assert.equal(issuer.rotate(signed(body)).replay, true);
  assert.throws(() => issuer.rotate(signed({ ...body, expectedGeneration: 1, cleanConsumer: 'old-consumer' })), err('CONSUMER_DENIED'));
  issuer.fence(); assert.throws(() => issuer.rotate(signed(body)), err('ROTATION_FENCED'));
  assert.ok(!JSON.stringify(issuer.receipt(digest(body))).includes(newKey));
});

function plan() {
  return { schemaVersion: 'dungeonq.isolation-plan/v1', profile: 'SYNTHETIC_ONLY', tenantId: 'tenant-a',
    planes: ['control', 'broker', 'issuer', 'consumer', 'evidence', 'deception', 'telemetry'].map((name, index) => ({ name,
      identity: `${name}-identity`, storage: `${name}-store`, network: `${name}-network`, uid: 10001 + index,
      readOnlyRoot: true, dropAllCapabilities: true, hostAccess: false, metadataAccess: false,
      secrets: ['deception', 'telemetry'].includes(name) ? [] : [`${name}-only`], egress: name === 'deception' ? ['telemetry'] : [], memoryMiB: 128, pids: 32, cpuMillis: 100 })) };
}
test('隔離設定拒絕共享權限／儲存、metadata、管理回連、秘密、root 與無限資源；設定合格不等於 Runtime 合格', () => {
  const good = validateIsolationPlan(plan()); assert.equal(good.configurationValid, true); assert.equal(good.runtimeIsolation, 'NOT_TESTED'); assert.equal(good.productionAdmission, 'DENIED');
  const mutations = [p => { p.planes[5].identity = p.planes[0].identity; }, p => { p.planes[5].storage = p.planes[0].storage; },
    p => { p.planes[5].metadataAccess = true; }, p => { p.planes[5].hostAccess = true; }, p => { p.planes[5].egress = ['control']; },
    p => { p.planes[6].egress = ['deception']; }, p => { p.planes[5].secrets = ['issuer-only']; }, p => { p.planes[5].uid = 0; },
    p => { p.planes[5].memoryMiB = 0; }, p => { p.profile = 'MANAGED_PRODUCTION'; }];
  for (const mutate of mutations) { const bad = plan(); mutate(bad); assert.throws(() => validateIsolationPlan(bad)); }
});
