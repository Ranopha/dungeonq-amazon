import test from 'node:test';
import assert from 'node:assert/strict';
import { runCompanyAcceptance, verifyAcceptanceReport } from '../server/company-acceptance.mjs';
import { referenceClient } from '../server/reference-transport.mjs';
import { digest } from '../server/contracts.mjs';
import https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { startReferenceTransport } from '../server/reference-transport.mjs';
import { createLocalFixture } from '../server/local-fixture.mjs';
import { token } from '../server/contracts.mjs';
import { openLocalNotificationSink } from '../server/local-notification-sink.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('公司交接套件實際 TLS 輪換／拒絕／重啟與持久通知驗收，報告不冒充商用', async () => {
  const report = await runCompanyAcceptance();
  assert.equal(report.result, 'PASS', JSON.stringify(report.checks)); assert.equal(verifyAcceptanceReport(report), true);
  assert.equal(report.checks.length, 9); assert.equal(report.commercialReady, false);
  assert.doesNotMatch(JSON.stringify(report), /BEGIN PRIVATE|apiKey|recoveryCode|https:\/\/|\/Users\//u);
  const tampered = structuredClone(report); tampered.checks[0].status = 'FAIL'; assert.equal(verifyAcceptanceReport(tampered), false);
  const forged = { ...report, commercialReady: true }; delete forged.digest; forged.digest = digest(forged);
  assert.equal(verifyAcceptanceReport(forged), false);
  const missing = structuredClone(report); missing.pending = []; delete missing.digest; missing.digest = digest(missing);
  assert.equal(verifyAcceptanceReport(missing), false);
});

test('公司測試 client 不接受遠端、HTTP、路徑／查詢參數與 URL 憑證', () => {
  for (const origin of ['http://127.0.0.1:1234', 'https://example.com:443', 'https://127.0.0.1:1234/path',
    'https://127.0.0.1:1234/?token=test', 'https://user:pass@127.0.0.1:1234']) {
    assert.throws(() => referenceClient({ origin, ca: 'synthetic' }), error => error.code === 'ENDPOINT_DENIED');
  }
});

test('HTTPS 接點拒絕瀏覽器、錯 Host、無 Broker、未知路徑、過大及多餘欄位，不觸發 Issuer', async t => {
  const fixture = await createLocalFixture(); let calls = 0; const broker = token();
  const service = await startReferenceTransport({ issuer: { rotate() { calls++; return {}; }, acquire() { calls++; } },
    tls: fixture.tls, brokerToken: broker, tenantId: 'tenant-lab', assetId: 'api-orders' });
  t.after(async () => { await service.close(); await fixture.close(); });
  const post = (path, headers = {}, payload = '{}') => new Promise((resolve, reject) => {
    const request = https.request(service.origin + path, { method: 'POST', ca: fixture.tls.cert,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity('127.0.0.1', certificate),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${broker}`, ...headers } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve(JSON.parse(text)));
    }); request.on('error', reject); request.end(payload);
  });
  assert.equal((await post('/rotate', { Origin: service.origin })).error, 'BROWSER_DENIED');
  assert.equal((await post('/rotate', { Host: 'other.example' })).error, 'HOST_DENIED');
  assert.equal((await post('/rotate', { Authorization: `Bearer ${token()}` })).error, 'BROKER_DENIED');
  assert.equal((await post('/bootstrap')).error, 'NOT_FOUND');
  assert.equal((await post('/rotate', {}, 'x'.repeat(9000))).error, 'BODY_TOO_LARGE');
  assert.equal((await post('/acquire', {}, '{"actorType":"HUMAN"}')).error, 'SCHEMA_INVALID');
  assert.equal(calls, 0);
  const wrongTrust = referenceClient({ origin: service.origin, ca: [] });
  await assert.rejects(wrongTrust('/receipt', broker, { manifestDigest: 'a'.repeat(64) }), error => error.code === 'TRANSPORT_UNKNOWN');
});

test('本機通知 sink 嚴格租戶與格式，拒絕任意 details 且不重綁已存在資料庫', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dq-sink-test-')); const path = join(directory, 'sink.sqlite');
  const sink = openLocalNotificationSink({ path, tenantId: 'tenant-a' });
  t.after(async () => { sink.close(); await rm(directory, { recursive: true, force: true }); });
  const message = { schemaVersion: 'dungeonq.lab-notification/v1', eventId: 1, tenantId: 'tenant-a', kind: 'TOTP_ENABLED', subject: 'member-a', auditDigest: 'a'.repeat(64), channel: 'LOCAL_SINK_ONLY' };
  assert.deepEqual(sink.send(message), sink.send(message));
  assert.throws(() => sink.send({ ...message, tenantId: 'tenant-b' }));
  assert.throws(() => sink.send({ ...message, details: 'private-content' }));
  assert.throws(() => openLocalNotificationSink({ path, tenantId: 'tenant-b' }), error => error.code === 'TENANT_DENIED');
});
