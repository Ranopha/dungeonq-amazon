import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openGovernance } from '../server/governance.mjs';
import { openEmailCapture } from '../server/email-transport.mjs';
import { digest } from '../server/contracts.mjs';

const PASSWORD = 'Synthetic-email-owner-password-2026';
const code = value => error => error.code === value;
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dq-email-core-'));
  let now = 1_790_000_000_000;
  const factorKey = randomBytes(32);
  const capture = openEmailCapture({ path: join(directory, 'capture.sqlite'), key: factorKey });
  let transport = options.transport ?? capture;
  const config = { path: join(directory, 'core.sqlite'), privateKey: generateKeyPairSync('ed25519').privateKey,
    rotationPrivateKey: generateKeyPairSync('ed25519').privateKey, keyId: 'email-test', factorKey, clock: () => now };
  let core = await openGovernance({ ...config, emailTransport: transport });
  t.after(async () => { core.close(); capture.close(); await rm(directory, { recursive: true, force: true }); });
  const boot = await core.local.bootstrap({ tenantId: 'tenant-a', username: 'owner-a', password: PASSWORD, assetIds: ['api-orders'] });
  const login = await core.application.login({ tenantId: 'tenant-a', username: 'owner-a', password: PASSWORD }, 'test');
  core.local.registerRotationTarget({ tenantId: 'tenant-a', assetId: 'api-orders', expectedGeneration: 0, epoch: 1, cleanConsumer: 'clean-consumer' });
  let number = 0;
  const f = { get core() { return core; }, directory, config, capture, session: login.sessionToken, ownerId: login.principal.principalId, recoveryCode: boot.recoveryCodes[0],
    advance(ms) { now += ms; },
    edit(sql, ...args) { const db = new DatabaseSync(config.path); try { return db.prepare(sql).run(...args); } finally { db.close(); } },
    read(sql, ...args) { const db = new DatabaseSync(config.path); try { return db.prepare(sql).all(...args); } finally { db.close(); } },
    async reopen(next = transport) { core.close(); transport = next; core = await openGovernance({ ...config, emailTransport: transport }); },
    async intent(manifest, session = f.session) { return (await core.application.reauthenticate(session, {
      password: PASSWORD, purpose: 'MANAGE_EMAIL', manifestDigest: digest(manifest) }, 'test')).intentToken; },
    async begin(email = 'owner@example.test') {
      const intentToken = await f.intent({ action: 'BIND_EMAIL', email: email.trim().toLowerCase() });
      return core.application.beginEmailVerification(f.session, { email, intentToken }, 'test');
    },
    async bind(email = 'owner@example.test') {
      const challenge = await f.begin(email); await core.emailNotifications.dispatch();
      const current = core.application.emailStatus(f.session);
      const text = current.captureMessages.find(item => item.to === challenge.email && item.text.includes('驗證碼')).text;
      const otp = text.match(/驗證碼：(\d{6})/u)[1];
      core.application.confirmEmailVerification(f.session, { challengeId: challenge.challengeId, code: otp }, 'test');
      return { ...challenge, code: otp };
    },
    event(tenantId = 'tenant-a') { const incidentId = `incident-${++number}`;
      return core.local.recordDecoyContact({ tenantId, incidentId, assetId: 'api-orders', worldId: 'world-b', eventDigest: digest({ incidentId }) }); },
    async link(provider = 'google', email = 'owner@example.test', mode = 'REAL_VERIFIED', subject = 'synthetic-subject') {
      const intentToken = await f.intent({ action: 'LINK_IDENTITY', provider });
      return core.local.linkExternalIdentity(f.session, { provider, subject, email, mode, intentToken });
    }
  };
  return f;
}

test('Owner本機模擬驗證、信箱別名及既有username登入；通知事件與recipient版本固定，沒有歷史補寄', async t => {
  const f = await fixture(t); f.event(); const verified = await f.bind(' OWNER@EXAMPLE.TEST ');
  let status = f.core.application.emailStatus(f.session);
  assert.equal(status.recipient.state, 'SIMULATED_VERIFIED'); assert.equal(status.claimBoundary, 'LOCAL_SIMULATION_ONLY');
  assert.equal(status.recipient.email, 'owner@example.test');
  assert.equal(status.deliveries.filter(row => row.kind === 'DECOY_CONTACT').length, 0);
  for (const username of ['OWNER@EXAMPLE.TEST', 'owner-a']) {
    assert.equal((await f.core.application.login({ tenantId: 'tenant-a', username, password: PASSWORD }, 'test')).principal.principalId, f.ownerId);
  }
  f.event(); status = f.core.application.emailStatus(f.session);
  assert.equal(status.deliveries.filter(row => row.kind === 'DECOY_CONTACT').length, 1);
  const result = await f.core.emailNotifications.dispatch(); assert.equal(result.state, 'ACCEPTED');
  assert.equal((await f.core.emailNotifications.dispatch()).state, 'IDLE');
  const exported = JSON.stringify(f.core.application.evidence(f.session));
  assert.equal(exported.includes(verified.code), false); assert.equal(exported.includes('owner@example.test'), false);
  const raw = Buffer.concat([await readFile(f.config.path), await readFile(`${f.config.path}-wal`)]).toString();
  assert.equal(raw.includes(verified.code), false); assert.equal(raw.includes('owner@example.test'), false);
  await f.reopen(); assert.equal((await f.core.emailNotifications.dispatch()).state, 'IDLE');
});

test('Owner-only及跨租戶挑戰/預覽隔離，登入前不能自行指定收件人', async t => {
  const f = await fixture(t); const challenge = await f.begin();
  await f.core.local.provisionMember({ tenantId: 'tenant-a', username: 'reviewer-a', password: PASSWORD, role: 'REVIEWER' });
  const member = await f.core.application.login({ tenantId: 'tenant-a', username: 'reviewer-a', password: PASSWORD }, 'test');
  assert.throws(() => f.core.application.emailStatus(member.sessionToken), code('PERMISSION_DENIED'));
  await assert.rejects(f.intent({ action: 'BIND_EMAIL', email: 'x@example.test' }, member.sessionToken), code('PERMISSION_DENIED'));
  await f.core.local.bootstrap({ tenantId: 'tenant-b', username: 'owner-b', password: PASSWORD, assetIds: ['api-orders'] });
  const other = await f.core.application.login({ tenantId: 'tenant-b', username: 'owner-b', password: PASSWORD }, 'test');
  assert.throws(() => f.core.application.confirmEmailVerification(other.sessionToken, { challengeId: challenge.challengeId, code: '000000' }, 'test'), code('EMAIL_CHALLENGE_INVALID'));
  assert.deepEqual(f.core.application.emailStatus(other.sessionToken).captureMessages, []);
  assert.throws(() => f.core.application.beginEmailVerification(f.session, { email: 'x@example.test', intentToken: 'x', tenantId: 'tenant-b' }, 'test'), code('SCHEMA_INVALID'));
});

test('一次性challenge／intent、錯碼累計跨重啟保存並鎖定，過期和session綁定拒絕', async t => {
  const f = await fixture(t); const challenge = await f.begin();
  await f.core.emailNotifications.dispatch();
  const otp = f.core.application.emailStatus(f.session).captureMessages[0].text.match(/驗證碼：(\d{6})/u)[1];
  const wrong = otp === '999999' ? '111111' : '999999';
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) { f.advance(31_000); await f.reopen(); }
    assert.throws(() => f.core.application.confirmEmailVerification(f.session, { challengeId: challenge.challengeId, code: wrong }, 'test'),
      code(attempt === 4 ? 'EMAIL_VERIFICATION_LOCKED' : 'EMAIL_CODE_INVALID'));
  }
  f.advance(31_000);
  assert.throws(() => f.core.application.confirmEmailVerification(f.session, { challengeId: challenge.challengeId, code: otp }, 'test'), code('EMAIL_VERIFICATION_LOCKED'));
  assert.equal(f.read('SELECT attempts FROM email_challenges')[0].attempts, 5);
  const second = await f.begin('second@example.test');
  const newLogin = await f.core.application.login({ tenantId: 'tenant-a', username: 'owner-a', password: PASSWORD }, 'test');
  f.advance(31_000);
  assert.throws(() => f.core.application.confirmEmailVerification(newLogin.sessionToken, { challengeId: second.challengeId, code: otp }, 'test'), code('EMAIL_CHALLENGE_INVALID'));
  f.advance(10 * 60_000);
  assert.throws(() => f.core.application.confirmEmailVerification(f.session, { challengeId: second.challengeId, code: otp }, 'test'), code('EMAIL_CHALLENGE_INVALID'));
});

test('收件者注入與錯誤digest拒絕，不消耗可用意圖；成功後不可重播', async t => {
  const f = await fixture(t); const intentToken = await f.intent({ action: 'BIND_EMAIL', email: 'owner@example.test' });
  for (const email of ['owner@example.test\r\nBcc:x@example.test', 'one@example.test,two@example.test', 'x@@example.test', '.x@example.test']) {
    assert.throws(() => f.core.application.beginEmailVerification(f.session, { email, intentToken }, 'test'), code('EMAIL_INVALID'));
  }
  assert.throws(() => f.core.application.beginEmailVerification(f.session, { email: 'wrong@example.test', intentToken }, 'test'), code('INTENT_INVALID'));
  const challenge = f.core.application.beginEmailVerification(f.session, { email: 'owner@example.test', intentToken }, 'test');
  assert.throws(() => f.core.application.beginEmailVerification(f.session, { email: 'owner@example.test', intentToken }, 'test'), code('INTENT_INVALID'));
  await f.core.emailNotifications.dispatch();
  const otp = f.core.application.emailStatus(f.session).captureMessages[0].text.match(/驗證碼：(\d{6})/u)[1];
  f.core.application.confirmEmailVerification(f.session, { challengeId: challenge.challengeId, code: otp }, 'test');
  assert.throws(() => f.core.application.confirmEmailVerification(f.session, { challengeId: challenge.challengeId, code: otp }, 'test'), code('EMAIL_CHALLENGE_INVALID'));
});

test('移除與更換立即fence既有待寄，舊email不能登入；新驗證不接收舊事件', async t => {
  const f = await fixture(t); await f.bind(); f.event();
  const intentToken = await f.intent({ action: 'REMOVE_EMAIL' });
  f.core.application.removeEmailBinding(f.session, { intentToken });
  assert.equal((await f.core.emailNotifications.dispatch()).state, 'IDLE');
  assert.equal(f.core.application.emailStatus(f.session).deliveries.find(row => row.kind === 'DECOY_CONTACT').state, 'FENCED');
  await assert.rejects(f.core.application.login({ tenantId: 'tenant-a', username: 'owner@example.test', password: PASSWORD }, 'test'), code('AUTH_FAILED'));
  await f.bind('new@example.test'); f.event(); await f.begin('third@example.test');
  assert.equal(f.core.application.emailStatus(f.session).deliveries.filter(row => row.kind === 'DECOY_CONTACT').every(row => row.state === 'FENCED'), true);
});

test('capture驗證切SMTP必須重驗，舊capture payload不送SMTP或出現在預覽', async t => {
  const f = await fixture(t); await f.bind(); f.event(); let sends = 0;
  await f.reopen({ mode: 'SMTP', send() { sends++; return { state: 'ACCEPTED', providerMessageId: '<test@example.test>' }; } });
  const state = f.core.application.emailStatus(f.session);
  assert.equal(state.recipient.state, 'REVERIFICATION_REQUIRED'); assert.deepEqual(state.captureMessages, []);
  assert.equal((await f.core.emailNotifications.dispatch()).state, 'IDLE'); assert.equal(sends, 0);
  await assert.rejects(f.core.application.login({ tenantId: 'tenant-a', username: 'owner@example.test', password: PASSWORD }, 'test'), code('AUTH_FAILED'));
});

test('SMTP驗證碼只在transport出現，ACCEPTED僅代表提供者接受；沒有inbox或公開preview', async t => {
  const sent = []; const f = await fixture(t, { transport: { mode: 'SMTP', send(message) { sent.push(message); return { state: 'ACCEPTED', providerMessageId: '<smtp@example.test>' }; } } });
  const challenge = await f.begin(); await f.core.emailNotifications.dispatch();
  assert.deepEqual(f.core.application.emailStatus(f.session).captureMessages, []);
  f.core.application.confirmEmailVerification(f.session, { challengeId: challenge.challengeId, code: sent[0].text.match(/驗證碼：(\d{6})/u)[1] }, 'test');
  f.event(); assert.equal((await f.core.emailNotifications.dispatch()).state, 'ACCEPTED');
  assert.equal(sent.length, 2); assert.equal(f.core.application.emailStatus(f.session).claimBoundary, 'SMTP_ACCEPTANCE_NOT_INBOX_DELIVERY');
});

test('明確RETRY有耐久退避且最多五次，UNKNOWN逾時/例外/重啟絕不盲重送', async t => {
  const f = await fixture(t); await f.bind(); let sends = 0;
  const adapter = { mode: 'LOCAL_EMAIL_CAPTURE', preview: ids => f.capture.preview(ids), send() { sends++; return { state: 'RETRY' }; } };
  await f.reopen(adapter); f.event();
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await f.core.emailNotifications.dispatch();
    assert.equal(result.attempts, attempt); assert.equal(result.state, attempt === 5 ? 'FAILED' : 'RETRY');
    assert.equal((await f.core.emailNotifications.dispatch()).state, 'IDLE');
    f.advance(60_000); await f.reopen(adapter);
  }
  assert.equal(sends, 5);
  const unknown = { ...adapter, send() { sends++; return new Promise(() => {}); } };
  await f.reopen(unknown); f.event();
  assert.equal((await f.core.emailNotifications.dispatch({ timeoutMs: 10 })).state, 'UNKNOWN');
  await f.reopen(unknown); f.advance(60_000);
  assert.equal((await f.core.emailNotifications.dispatch()).state, 'IDLE'); assert.equal(sends, 6);
});

test('舊SENDING重啟後轉UNKNOWN且不重送；並行dispatch不能重複寄送', async t => {
  const f = await fixture(t); await f.bind(); f.event();
  f.edit("UPDATE email_outbox SET status='SENDING',attempts=1,claim='old-process',deadline=0 WHERE kind='DECOY_CONTACT'");
  await f.reopen(); assert.equal((await f.core.emailNotifications.dispatch()).state, 'IDLE');
  assert.equal(f.core.application.emailStatus(f.session).deliveries.find(row => row.kind === 'DECOY_CONTACT').state, 'UNKNOWN');
  f.event(); const results = await Promise.all([f.core.emailNotifications.dispatch(), f.core.emailNotifications.dispatch()]);
  assert.deepEqual(results.map(row => row.state).sort(), ['ACCEPTED', 'IDLE']);
});

test('帳號停用或epoch變更阻斷待寄；audit/payload竄改failclosed；入列失敗回復原始事件', async t => {
  for (const mutation of ["UPDATE users SET disabled=1", "UPDATE users SET epoch=epoch+1"]) {
    const f = await fixture(t); await f.bind(); f.event(); f.edit(mutation);
    assert.equal((await f.core.emailNotifications.dispatch()).state, 'IDLE');
    assert.equal(f.read("SELECT status FROM email_outbox WHERE kind='DECOY_CONTACT'")[0].status, 'FENCED');
  }
  const f = await fixture(t); await f.bind(); f.event();
  f.edit("UPDATE email_outbox SET sealed='invalid' WHERE kind='DECOY_CONTACT'");
  await assert.rejects(f.core.emailNotifications.dispatch(), code('EMAIL_CUSTODY_INVALID'));
  const g = await fixture(t); await g.bind(); const before = g.read('SELECT count(*) AS n FROM audit')[0].n;
  g.edit("CREATE TRIGGER reject_email BEFORE INSERT ON email_outbox BEGIN SELECT RAISE(ABORT,'SYNTHETIC_QUEUE_FAILURE'); END");
  assert.throws(() => g.event(), /SYNTHETIC_QUEUE_FAILURE/u);
  assert.equal(g.read('SELECT count(*) AS n FROM audit')[0].n, before); assert.equal(g.read('SELECT count(*) AS n FROM decoy_incidents')[0].n, 0);
});

test('受信提供者連結才建立email登入及通知，無matching-email自動Owner；地址漂移、mode或subject冒用拒絕', async t => {
  const f = await fixture(t); const proof = { provider: 'google', subject: 'synthetic-subject', email: 'owner@example.test', mode: 'REAL_VERIFIED' };
  await assert.rejects(f.core.local.loginExternalIdentity(proof), code('SOCIAL_IDENTITY_UNAVAILABLE'));
  await f.link(); assert.equal(f.core.application.emailStatus(f.session).recipient.verificationMethod, 'OAUTH_VERIFIED');
  assert.equal((await f.core.local.loginExternalIdentity(proof)).principal.principalId, f.ownerId);
  for (const change of [{ email: 'changed@example.test' }, { subject: 'another-subject' }, { mode: 'SIMULATED' }]) {
    await assert.rejects(f.core.local.loginExternalIdentity({ ...proof, ...change }), code('SOCIAL_IDENTITY_UNAVAILABLE'));
  }
  f.event(); assert.equal((await f.core.emailNotifications.dispatch()).state, 'ACCEPTED');
  await f.link('google', 'changed@example.test');
  await assert.rejects(f.core.local.loginExternalIdentity(proof), code('SOCIAL_IDENTITY_UNAVAILABLE'));
  assert.equal((await f.core.local.loginExternalIdentity({ ...proof, email: 'changed@example.test' })).principal.principalId, f.ownerId);
  const intentToken = await f.intent({ action: 'REMOVE_EMAIL' }); f.core.application.removeEmailBinding(f.session, { intentToken });
  await assert.rejects(f.core.local.loginExternalIdentity({ ...proof, email: 'changed@example.test' }), code('SOCIAL_IDENTITY_UNAVAILABLE'));
});

test('social不能繞過已啟用TOTP，合成proof不可升格成SMTP權限，低角色不能連結', async t => {
  const f = await fixture(t); await f.link();
  f.edit("INSERT INTO factors(user_id,sealed,state,expires) VALUES (?,'synthetic-unused','ACTIVE',0)", f.ownerId);
  await assert.rejects(f.core.local.loginExternalIdentity({ provider: 'google', subject: 'synthetic-subject', email: 'owner@example.test', mode: 'REAL_VERIFIED' }), code('SOCIAL_TOTP_STEP_UP_REQUIRED'));
  const g = await fixture(t); await g.link('github', 'owner@example.test', 'SIMULATED');
  const proof = { provider: 'github', subject: 'synthetic-subject', email: 'owner@example.test', mode: 'SIMULATED' };
  assert.equal((await g.core.local.loginExternalIdentity(proof)).principal.principalId, g.ownerId);
  await g.reopen({ mode: 'SMTP', send: () => ({ state: 'ACCEPTED', providerMessageId: 'synthetic' }) });
  await assert.rejects(g.core.local.loginExternalIdentity(proof), code('SOCIAL_IDENTITY_UNAVAILABLE'));
  await assert.rejects(g.core.local.loginExternalIdentity({ ...proof, mode: 'REAL_VERIFIED' }), code('SOCIAL_IDENTITY_UNAVAILABLE'));
  await g.core.local.provisionMember({ tenantId: 'tenant-a', username: 'auditor-a', password: PASSWORD, role: 'AUDITOR' });
  const member = await g.core.application.login({ tenantId: 'tenant-a', username: 'auditor-a', password: PASSWORD }, 'test');
  assert.throws(() => g.core.local.linkExternalIdentity(member.sessionToken, { ...proof, intentToken: member.sessionToken }), code('PERMISSION_DENIED'));
});

test('驗證郵件十五分鐘最多三次，重啟保留限速；過期意圖與舊epoch不能綁新信箱', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 3; index++) { await f.begin(`owner${index}@example.test`); f.advance(31_000); }
  await f.reopen(); await assert.rejects(f.begin('extra@example.test'), code('EMAIL_RATE_LIMIT'));
  const g = await fixture(t); const old = await g.intent({ action: 'BIND_EMAIL', email: 'owner@example.test' });
  g.advance(5 * 60_000);
  assert.throws(() => g.core.application.beginEmailVerification(g.session, { email: 'owner@example.test', intentToken: old }, 'test'), code('INTENT_INVALID'));
  const intentToken = await g.intent({ action: 'BIND_EMAIL', email: 'owner@example.test' });
  g.edit('UPDATE users SET epoch=epoch+1');
  assert.throws(() => g.core.application.beginEmailVerification(g.session, { email: 'owner@example.test', intentToken }, 'test'), code('AUTH_REQUIRED'));
});

test('明文method竄改不能把capture信任轉成SMTP；來源audit篡改拒絕派送', async t => {
  const f = await fixture(t); await f.bind();
  f.edit("UPDATE email_bindings SET method='SMTP'");
  await f.reopen({ mode: 'SMTP', send: () => assert.fail('must not send') });
  await assert.rejects(f.core.application.login({ tenantId: 'tenant-a', username: 'owner@example.test', password: PASSWORD }, 'test'), code('EMAIL_BINDING_INTEGRITY'));
  const g = await fixture(t); await g.bind(); g.event();
  g.edit('DROP TRIGGER audit_no_update');
  g.edit("UPDATE audit SET digest=? WHERE seq=(SELECT event_id FROM email_outbox WHERE kind='DECOY_CONTACT')", 'a'.repeat(64));
  await assert.rejects(g.core.emailNotifications.dispatch(), code('EMAIL_INTEGRITY'));
});

test('未配置外部transport保留相容status與不寄信，驗證begin不可誤称可用', async t => {
  const f = await fixture(t); await f.reopen(undefined);
  // reopen預設保留adapter；明確重開未配置核心。
  const raw = await openGovernance({ ...f.config });
  try {
    assert.equal(raw.application.emailStatus(f.session).mode, 'NOT_CONFIGURED');
    assert.equal((await raw.emailNotifications.dispatch()).state, 'IDLE');
    assert.throws(() => raw.application.beginEmailVerification(f.session, { email: 'x@example.test', intentToken: 'x' }, 'test'), code('EMAIL_NOT_CONFIGURED'));
  } finally { raw.close(); }
});
