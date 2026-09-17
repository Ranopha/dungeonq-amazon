import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, chmod, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { createServer as createTlsServer, createSecureContext, TLSSocket } from 'node:tls';
import { DatabaseSync } from 'node:sqlite';
import { createSmtpEmailTransport, loadSmtpConfigFile, openEmailCapture } from '../server/email-transport.mjs';

const message = { id: '574c0b93-6690-4dd5-9365-6ecf90354494', to: 'recipient@fixture.test',
  subject: 'DungeonQ verification', text: 'Synthetic verification only.\nCode: capture-secret-123456' };
const config = { host: 'smtp.example.test', port: 465, secure: true, from: 'alerts@fixture.test',
  user: 'synthetic-user', password: 'synthetic-password' };
let certificate; let certificatesDir;

before(async () => {
  certificatesDir = await mkdtemp(join(tmpdir(), 'dq-email-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-keyout', join(certificatesDir, 'key.pem'), '-out', join(certificatesDir, 'cert.pem'),
    '-subj', '/CN=DungeonQ email fixture', '-addext', 'subjectAltName=IP:127.0.0.1'],
  { stdio: 'ignore', timeout: 15000 });
  certificate = { key: await readFile(join(certificatesDir, 'key.pem')),
    cert: await readFile(join(certificatesDir, 'cert.pem')) };
});
after(async () => { if (certificatesDir) await rm(certificatesDir, { recursive: true, force: true }); });

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'dq-email-test-'));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}

async function smtpFixture(t, { outcome = 'accept', starttls = false, advertiseStarttls = true } = {}) {
  const sockets = new Set(); const commands = []; const messages = [];
  let tlsErrors = 0; let connections = 0;
  const secureContext = createSecureContext(certificate);
  const track = socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
  };
  function attach(socket, secured, greeting = true) {
    track(socket); let buffered = ''; let data = false; let body = [];
    if (greeting) socket.write('220 fixture.test synthetic SMTP\r\n');
    function consume(chunk) {
      buffered += chunk.toString('utf8');
      if (buffered.length > 32768) { socket.destroy(); return; }
      let end;
      while ((end = buffered.indexOf('\r\n')) !== -1) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        if (data) {
          if (line !== '.') { body.push(line); continue; }
          data = false; messages.push(body.join('\r\n')); body = [];
          if (outcome === 'lost-reply') socket.destroy();
          else if (outcome === 'silent-reply') { /* The client deadline must close this socket. */ }
          else if (outcome === 'temporary-data') socket.write('451 4.3.0 temporarily unavailable\r\n');
          else if (outcome === 'permanent-data') socket.write('550 5.7.1 message refused\r\n');
          else socket.write('250 2.0.0 queued fixture-only\r\n');
          continue;
        }
        const verb = line.split(' ')[0].toUpperCase();
        commands.push({ verb, secured, ...(verb === 'RCPT' || verb === 'MAIL' ? { line } : {}) });
        if (verb === 'EHLO' || verb === 'HELO') {
          if (!secured && advertiseStarttls) socket.write('250-fixture.test\r\n250 STARTTLS\r\n');
          else socket.write('250-fixture.test\r\n250 AUTH PLAIN\r\n');
        } else if (verb === 'STARTTLS') {
          if (!advertiseStarttls) { socket.write('502 5.5.1 STARTTLS unavailable\r\n'); continue; }
          socket.write('220 2.0.0 begin TLS\r\n'); socket.removeListener('data', consume);
          const upgraded = new TLSSocket(socket, { isServer: true, secureContext });
          attach(upgraded, true, false); return;
        } else if (verb === 'AUTH') {
          if (!secured) { socket.write('530 5.7.0 TLS required\r\n'); continue; }
          socket.write('235 2.7.0 authenticated fixture\r\n');
        } else if (verb === 'MAIL') socket.write('250 2.1.0 sender accepted\r\n');
        else if (verb === 'RCPT') {
          if (outcome === 'temporary-rcpt') socket.write('450 4.1.0 mailbox temporarily unavailable\r\n');
          else if (outcome === 'permanent-rcpt') socket.write('550 5.1.1 recipient refused\r\n');
          else socket.write('250 2.1.5 recipient accepted\r\n');
        } else if (verb === 'DATA') { data = true; socket.write('354 end with dot\r\n'); }
        else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('500 unsupported fixture command\r\n');
      }
    }
    socket.on('data', consume);
  }
  const server = starttls ? createNetServer(socket => attach(socket, false))
    : createTlsServer({ ...certificate, minVersion: 'TLSv1.2' }, socket => attach(socket, true));
  server.on('connection', socket => { connections++; track(socket); });
  server.on('tlsClientError', () => tlsErrors++);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); for (const socket of sockets) socket.destroy(); }));
  const smtp = { ...config, host: '127.0.0.1', port: server.address().port,
    secure: !starttls, ca: certificate.cert.toString('utf8') };
  return { smtp, commands, messages, sockets, get connections() { return connections; }, get tlsErrors() { return tlsErrors; } };
}

function transport(t, value) {
  const adapter = createSmtpEmailTransport(value, { allowLoopbackTestPort: true });
  t.after(() => adapter.close()); return adapter;
}

test('本機擷取加密內容、耐久重啟、固定 key 與相同 ID 冪等', async t => {
  const dir = await directory(t); const path = join(dir, 'capture.sqlite'); const key = randomBytes(32);
  let capture = openEmailCapture({ path, key });
  assert.equal(capture.mode, 'LOCAL_EMAIL_CAPTURE');
  const result = capture.send(message);
  assert.equal(result.state, 'ACCEPTED'); assert.doesNotMatch(result.providerMessageId, /recipient/u);
  assert.deepEqual(capture.send(message), result);
  assert.throws(() => capture.send({ ...message, text: 'different' }), { code: 'EMAIL_ID_CONFLICT' });
  const preview = capture.preview([message.id]);
  assert.deepEqual(preview.map(({ acceptedAt, ...rest }) => rest), [message]);
  assert.ok(Number.isSafeInteger(preview[0].acceptedAt));
  assert.deepEqual(capture.lookup(message.id), result);
  assert.equal(capture.lookup('absent'), undefined);
  assert.throws(() => capture.preview(Array(51).fill(message.id)), { code: 'EMAIL_PREVIEW_LIMIT' });
  for (const filename of await readdir(dir)) {
    const bytes = await readFile(join(dir, filename));
    for (const secret of [message.to, message.subject, 'capture-secret-123456']) assert.equal(bytes.includes(Buffer.from(secret)), false);
  }
  capture.close();
  assert.throws(() => openEmailCapture({ path, key: randomBytes(32) }), { code: 'EMAIL_CAPTURE_KEY_PIN_MISMATCH' });
  capture = openEmailCapture({ path, key }); t.after(() => capture.close());
  assert.deepEqual(capture.preview([message.id]), preview);
  assert.deepEqual(capture.send(message), result);
  assert.throws(() => openEmailCapture({ path: join(dir, 'invalid.sqlite'), key: Buffer.alloc(31) }), { code: 'EMAIL_CAPTURE_KEY_INVALID' });
});

test('擷取拒絕非私有檔案／symlink並檢出密文竄改', async t => {
  const dir = await directory(t); const path = join(dir, 'capture.sqlite'); const key = randomBytes(32);
  const capture = openEmailCapture({ path, key }); capture.send(message); capture.close();
  const alias = join(dir, 'alias.sqlite'); await symlink(path, alias);
  assert.throws(() => openEmailCapture({ path: alias, key }), { code: 'STORAGE_NOT_PRIVATE' });
  await chmod(path, 0o644);
  assert.throws(() => openEmailCapture({ path, key }), { code: 'STORAGE_NOT_PRIVATE' });
  await chmod(path, 0o600);
  const db = new DatabaseSync(path);
  db.prepare('UPDATE email_capture SET sealed=? WHERE id=?').run(randomBytes(64).toString('base64url'), message.id); db.close();
  const reopened = openEmailCapture({ path, key }); t.after(() => reopened.close());
  assert.throws(() => reopened.preview([message.id]), { code: 'EMAIL_CAPTURE_CORRUPT' });
  assert.throws(() => reopened.lookup(message.id), { code: 'EMAIL_CAPTURE_CORRUPT' });
});

test('郵件閉合 schema／地址／header injection 在網路操作前拒絕', async t => {
  const dir = await directory(t); const capture = openEmailCapture({ path: join(dir, 'capture.sqlite'), key: randomBytes(32) });
  t.after(() => capture.close());
  const f = await smtpFixture(t); const smtp = transport(t, f.smtp);
  for (const candidate of [
    { ...message, to: 'a@fixture.test,b@fixture.test' }, { ...message, to: 'Name <a@fixture.test>' },
    { ...message, to: 'a@fixture.test\r\nBcc: b@fixture.test' }, { ...message, to: '人@fixture.test' },
    { ...message, subject: 'Safe\r\nBcc: b@fixture.test' }, { ...message, id: 'unsafe\nMessage-ID' },
    { ...message, text: 'text\u0000' }, { ...message, text: 'x'.repeat(8193) },
    { ...message, attachments: [] }, { ...message, html: '<b>hello</b>' }, { ...message, from: 'other@fixture.test' },
    { ...message, cc: 'other@fixture.test' }, { ...message, bcc: 'other@fixture.test' },
  ]) {
    assert.throws(() => capture.send(candidate));
    await assert.rejects(smtp.send(candidate));
  }
  assert.equal(f.connections, 0);
});

test('SMTP 真實 localhost TLS、單收件人 DATA 與固定 Message-ID', async t => {
  const f = await smtpFixture(t); const smtp = transport(t, f.smtp);
  assert.equal(smtp.mode, 'SMTP');
  const result = await smtp.send(message);
  assert.deepEqual(result, { state: 'ACCEPTED', providerMessageId: `<dq-${message.id}@fixture.test>` });
  assert.equal(f.messages.length, 1);
  assert.equal(f.commands.filter(command => command.verb === 'RCPT').length, 1);
  assert.ok(f.commands.every(command => command.secured));
  assert.match(f.messages[0], /From: alerts@fixture\.test\r\n/u);
  assert.match(f.messages[0], /To: recipient@fixture\.test\r\n/u);
  assert.match(f.messages[0], /Content-Type: text\/plain/u);
  assert.ok(f.messages[0].includes(`Message-ID: <dq-${message.id}@fixture.test>`));
  assert.doesNotMatch(f.messages[0], /(?:^|\r\n)(?:Cc|Bcc|Content-Disposition):/u);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-password|recipient/u);
});

test('587 模式在 STARTTLS 完成前不傳認證或郵件', async t => {
  const f = await smtpFixture(t, { starttls: true }); const smtp = transport(t, f.smtp);
  assert.equal((await smtp.send(message)).state, 'ACCEPTED');
  assert.ok(f.commands.some(command => command.verb === 'STARTTLS'));
  assert.ok(f.commands.filter(command => ['AUTH', 'MAIL', 'RCPT', 'DATA'].includes(command.verb)).every(command => command.secured));
  assert.equal(f.messages.length, 1);
});

test('缺 STARTTLS 時拒絕降級，不傳認證或郵件', async t => {
  const f = await smtpFixture(t, { starttls: true, advertiseStarttls: false }); const smtp = transport(t, f.smtp);
  assert.equal((await smtp.send(message)).state, 'FAILED');
  assert.equal(f.messages.length, 0);
  assert.equal(f.commands.some(command => ['AUTH', 'MAIL', 'RCPT', 'DATA'].includes(command.verb)), false);
});

test('明確 SMTP 4xx 可重試／5xx失敗，含最終 DATA 拒收', async t => {
  for (const [outcome, expected] of [['temporary-rcpt', 'RETRY'], ['permanent-rcpt', 'FAILED'],
    ['temporary-data', 'RETRY'], ['permanent-data', 'FAILED']]) await t.test(outcome, async t => {
    const f = await smtpFixture(t, { outcome }); const smtp = transport(t, f.smtp);
    assert.deepEqual(await smtp.send(message), { state: expected });
    assert.equal(f.connections, 1);
  });
});

test('DATA 後回覆遺失保持 UNKNOWN，不自動重送', async t => {
  const f = await smtpFixture(t, { outcome: 'lost-reply' }); const smtp = transport(t, f.smtp);
  assert.deepEqual(await smtp.send(message), { state: 'UNKNOWN' });
  assert.equal(f.messages.length, 1); assert.equal(f.connections, 1);
});

test('最終回覆逾時有界且取消 socket，仍保持 UNKNOWN', async t => {
  const f = await smtpFixture(t, { outcome: 'silent-reply' }); const smtp = transport(t, f.smtp);
  const start = Date.now(); assert.deepEqual(await smtp.send(message), { state: 'UNKNOWN' });
  assert.ok(Date.now() - start < 5000); assert.equal(f.messages.length, 1); assert.equal(f.connections, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok([...f.sockets].every(socket => socket.destroyed || socket.writableEnded));
});

test('錯誤 CA 驗證失敗，不寄出 DATA且不暴露 provider error', async t => {
  const f = await smtpFixture(t);
  const smtp = createSmtpEmailTransport({ ...f.smtp, ca: '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----\n' },
    { allowLoopbackTestPort: true }); t.after(() => smtp.close());
  assert.deepEqual(await smtp.send(message), { state: 'UNKNOWN' });
  assert.equal(f.messages.length, 0); assert.equal(f.commands.length, 0);
});

test('私有 SMTP 設定檔嚴格 schema、port、0600、regular、size 和無 secret 錯誤', async t => {
  const dir = await directory(t); const path = join(dir, 'smtp.json');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(loadSmtpConfigFile(path), config);
  assert.throws(() => loadSmtpConfigFile('smtp.json'), { code: 'EMAIL_SMTP_CONFIG_INVALID' });
  for (const value of [
    { ...config, port: 25 }, { ...config, port: 465, secure: false }, { ...config, port: 587, secure: true },
    { ...config, host: 'https://smtp.example.test' }, { ...config, password: 'secret\r\n' },
    { ...config, from: 'Name <alerts@fixture.test>' }, { ...config, tls: { rejectUnauthorized: false } },
    { ...config, allowLoopbackTestPort: true }, { ...config, port: 2525, host: '127.0.0.1', ca: certificate.cert.toString() },
  ]) {
    await writeFile(path, JSON.stringify(value));
    assert.throws(() => loadSmtpConfigFile(path), { message: 'EMAIL_SMTP_CONFIG_INVALID' });
    assert.throws(() => createSmtpEmailTransport(value), { message: 'EMAIL_SMTP_CONFIG_INVALID' });
  }
  assert.throws(() => createSmtpEmailTransport({ ...config, port: 2525, ca: certificate.cert.toString() },
    { allowLoopbackTestPort: true }), { code: 'EMAIL_SMTP_CONFIG_INVALID' });
  assert.throws(() => createSmtpEmailTransport({ ...config, host: '127.0.0.1', port: 2525 },
    { allowLoopbackTestPort: true }), { code: 'EMAIL_SMTP_CONFIG_INVALID' });
  await writeFile(path, JSON.stringify(config)); await chmod(path, 0o644);
  assert.throws(() => loadSmtpConfigFile(path), { code: 'EMAIL_SMTP_CONFIG_INVALID' });
  await chmod(path, 0o600); const alias = join(dir, 'link.json'); await symlink(path, alias);
  assert.throws(() => loadSmtpConfigFile(alias), { code: 'EMAIL_SMTP_CONFIG_INVALID' });
  const hardlink = join(dir, 'hardlink.json'); await link(path, hardlink);
  assert.throws(() => loadSmtpConfigFile(path), { code: 'EMAIL_SMTP_CONFIG_INVALID' });
  assert.throws(() => loadSmtpConfigFile(dir), { code: 'EMAIL_SMTP_CONFIG_INVALID' });
  const oversized = join(dir, 'oversized.json'); await writeFile(oversized, ' '.repeat(16385), { mode: 0o600 });
  assert.throws(() => loadSmtpConfigFile(oversized), { code: 'EMAIL_SMTP_CONFIG_INVALID' });
  const invalid = join(dir, 'invalid.json'); await writeFile(invalid, Buffer.from([0xff]), { mode: 0o600 });
  assert.throws(() => loadSmtpConfigFile(invalid), { code: 'EMAIL_SMTP_CONFIG_INVALID' });
});
