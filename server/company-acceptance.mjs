import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createLocalFixture } from './local-fixture.mjs';
import { openReferenceIssuer, ROTATION_DOMAIN } from './reference-issuer.mjs';
import { startReferenceTransport, referenceClient } from './reference-transport.mjs';
import { openLocalNotificationSink } from './local-notification-sink.mjs';
import { digest, canonicalJson, token, requireThat, exact } from './contracts.mjs';

export const ACCEPTANCE_CHECKS = Object.freeze(['HTTPS_VALIDATED', 'BROKER_BOUNDARY', 'NEW_KEY_BUSINESS', 'OLD_KEY_DENIED',
  'OLD_CONSUMER_DENIED', 'EXACT_REPLAY', 'ISSUER_RESTART_READBACK', 'NOTIFICATION_DELIVERED_LOCAL', 'NOTIFICATION_RESTART_READBACK']);
const SOURCES = ['company-acceptance.mjs', 'reference-transport.mjs', 'reference-issuer.mjs', 'local-notification-sink.mjs',
  'governance.mjs', 'store.mjs', 'contracts.mjs', 'notifications.mjs', 'totp.mjs', 'passwords.mjs', 'authorization.mjs', 'local-fixture.mjs'];
const PENDING = ['REAL_ENTERPRISE_CONNECTOR', 'LONG_LIVED_ROTATION_GRANT', 'RUNTIME_ISOLATION', 'EXTERNAL_NOTIFICATION',
  'WEBAUTHN', 'EXTERNAL_CHECKPOINT_RESTORE', 'GATEWAY_AND_DUNGEON_RUNTIME', 'LOAD_SOAK', 'DAYBREAK_REVIEW'];

// 固定人工場域，不接受企業 endpoint／credential 參數。
export async function runCompanyAcceptance() {
  const checks = ACCEPTANCE_CHECKS.map(id => ({ id, status: 'NOT_RUN' }));
  const directory = await mkdtemp(join(tmpdir(), 'dq-acceptance-'));
  let fixture; let issuer; let transport; let sink;
  const check = async (id, operation) => {
    const result = checks.find(check => check.id === id);
    try { await operation(); result.status = 'PASS'; }
    catch { result.status = 'FAIL'; throw new Error('ACCEPTANCE_FAILED'); }
  };
  const denied = async operation => {
    let rejected = false;
    try { await operation(); } catch (error) { rejected = error.code === 'REMOTE_REJECTED'; }
    requireThat(rejected, 'CHECK_FAILED');
  };
  try {
    fixture = await createLocalFixture();
    const authority = generateKeyPairSync('ed25519'); const broker = token();
    const options = { path: join(directory, 'issuer.sqlite'), custodyKey: randomBytes(32), authorizationPublicKey: authority.publicKey };
    issuer = openReferenceIssuer(options);
    const consumers = issuer.bootstrap({ tenantId: 'tenant-lab', assetId: 'api-orders', consumers: ['old-consumer', 'clean-consumer'] });
    const start = async () => {
      transport = await startReferenceTransport({ issuer, tls: fixture.tls, brokerToken: broker, tenantId: 'tenant-lab', assetId: 'api-orders' });
      return referenceClient({ origin: transport.origin, ca: fixture.tls.cert });
    };
    let call = await start(); let oldKey;
    await check('HTTPS_VALIDATED', async () => {
      oldKey = (await call('/acquire', consumers['old-consumer'])).apiKey;
      requireThat((await call('/business', oldKey)).quantity === 7, 'CHECK_FAILED');
    });
    const manifest = { schemaVersion: 'dungeonq.reference-rotation/v1', profile: 'SYNTHETIC_ONLY', tenantId: 'tenant-lab',
      assetId: 'api-orders', expectedGeneration: 0, epoch: 1, cleanConsumer: 'clean-consumer', expiresAt: Date.now() + 120000 };
    const permit = { body: manifest, signature: sign(null, Buffer.from(ROTATION_DOMAIN + canonicalJson(manifest)), authority.privateKey).toString('base64url') };
    await check('BROKER_BOUNDARY', () => denied(() => call('/rotate', consumers['old-consumer'], permit)));
    await check('NEW_KEY_BUSINESS', async () => {
      const rotated = await call('/rotate', broker, permit); requireThat(rotated.generation === 1 && rotated.businessVerified === false, 'CHECK_FAILED');
      const key = (await call('/acquire', consumers['clean-consumer'])).apiKey;
      requireThat(key !== oldKey && (await call('/business', key)).generation === 1, 'CHECK_FAILED');
    });
    await check('OLD_KEY_DENIED', () => denied(() => call('/business', oldKey)));
    await check('OLD_CONSUMER_DENIED', () => denied(() => call('/acquire', consumers['old-consumer'])));
    await check('EXACT_REPLAY', async () => requireThat((await call('/rotate', broker, permit)).replay === true, 'CHECK_FAILED'));
    await check('ISSUER_RESTART_READBACK', async () => {
      await transport.close(); transport = null; issuer.close(); issuer = openReferenceIssuer(options); call = await start();
      requireThat((await call('/receipt', broker, { manifestDigest: digest(manifest) })).generation === 1, 'CHECK_FAILED');
      await denied(() => call('/business', oldKey)); await denied(() => call('/acquire', consumers['old-consumer']));
    });
    sink = openLocalNotificationSink({ path: join(directory, 'sink.sqlite'), tenantId: 'tenant-lab' });
    const app = fixture.core.application;
    const login = await app.login({ tenantId: 'tenant-lab', username: 'owner-lab', password: fixture.password }, 'acceptance-lab');
    const intent = await app.reauthenticate(login.sessionToken, { password: fixture.password, purpose: 'RENEW_RECOVERY',
      manifestDigest: digest({ tenantId: 'tenant-lab', principalId: login.principal.principalId, action: 'RENEW_RECOVERY' }) }, 'acceptance-lab');
    app.renewRecoveryCodes(login.sessionToken, intent.intentToken);
    let receipt;
    await check('NOTIFICATION_DELIVERED_LOCAL', async () => {
      requireThat((await fixture.core.notifications.dispatch(sink)).state === 'DELIVERED', 'CHECK_FAILED');
      receipt = app.notifications(login.sessionToken)[0].receipt; requireThat(!!sink.lookup(receipt), 'CHECK_FAILED');
    });
    await check('NOTIFICATION_RESTART_READBACK', async () => {
      sink.close(); sink = openLocalNotificationSink({ path: join(directory, 'sink.sqlite'), tenantId: 'tenant-lab' });
      requireThat(sink.lookup(receipt)?.receiptId === receipt, 'CHECK_FAILED');
      requireThat((await fixture.core.notifications.dispatch(sink)).state === 'IDLE', 'CHECK_FAILED');
    });
  } catch { /* 詳細錯誤不輸出：可能含環境、路徑或秘密。 */ }
  finally {
    try { if (transport) await transport.close(); }
    finally { try { try { issuer?.close(); } finally { sink?.close(); } } finally { try { await fixture?.close(); } finally { await rm(directory, { recursive: true, force: true }); } } }
  }
  const sourceDigests = {};
  for (const source of SOURCES) sourceDigests[source] = createHash('sha256').update(await readFile(new URL(source, import.meta.url))).digest('hex');
  sourceDigests['canonical.mjs'] = createHash('sha256').update(await readFile(new URL('../public/src/canonical.mjs', import.meta.url))).digest('hex');
  const report = { schemaVersion: 'dungeonq.company-acceptance/v1', profile: 'SYNTHETIC_ONLY',
    result: checks.every(check => check.status === 'PASS') ? 'PASS' : 'FAIL', authority: 'TEST_SIGNER_ONLY',
    commercialReady: false, runtimeIsolation: 'NOT_TESTED', notificationChannel: 'LOCAL_SINK_ONLY',
    node: process.versions.node, checks, pending: [...PENDING], sourceDigests };
  return { ...report, digest: digest(report) };
}

export function verifyAcceptanceReport(value) {
  try {
    exact(value, ['schemaVersion', 'profile', 'result', 'authority', 'commercialReady', 'runtimeIsolation', 'notificationChannel', 'node', 'checks', 'pending', 'sourceDigests', 'digest']);
    const { digest: checksum, ...body } = value;
    requireThat(value.schemaVersion === 'dungeonq.company-acceptance/v1' && value.profile === 'SYNTHETIC_ONLY'
      && value.authority === 'TEST_SIGNER_ONLY' && value.commercialReady === false && value.runtimeIsolation === 'NOT_TESTED'
      && value.notificationChannel === 'LOCAL_SINK_ONLY' && typeof value.node === 'string' && /^\d+\.\d+\.\d+$/u.test(value.node), 'REPORT_INVALID');
    requireThat(JSON.stringify(value.pending) === JSON.stringify(PENDING) && Array.isArray(value.checks) && value.checks.length === ACCEPTANCE_CHECKS.length, 'REPORT_INVALID');
    value.checks.forEach((check, index) => { exact(check, ['id', 'status']); requireThat(check.id === ACCEPTANCE_CHECKS[index] && ['PASS', 'FAIL', 'NOT_RUN'].includes(check.status), 'REPORT_INVALID'); });
    exact(value.sourceDigests, [...SOURCES, 'canonical.mjs']);
    requireThat(Object.values(value.sourceDigests).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)), 'REPORT_INVALID');
    requireThat(value.result === (value.checks.every(check => check.status === 'PASS') ? 'PASS' : 'FAIL') && checksum === digest(body), 'REPORT_INVALID');
    return true;
  } catch { return false; }
}
