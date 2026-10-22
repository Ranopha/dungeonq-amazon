// DQ-HANDOFF-015 M3：通知管道轉接器（LINE 推播、Gmail SMTP、IMAP 唯讀量測）。全部使用假傳輸與臨時假設定檔，不讀真實祕密、不連外。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImapInboxProbe, createLinePushChannel, createSmtpAlertChannel, loadLineConfigFile, parseInternalDate,
  privateConfigPresent } from '../server/alert-channels.mjs';

const LINE = { channelId: '1234567890', channelSecret: 'fake-line-secret-0123456789abcdef', to: 'U' + '0'.repeat(32) };
const SMTP = { host: 'smtp.gmail.com', port: 465, secure: true, from: 'alerts@example.test', user: 'admin@example.test', password: 'fake app password' };
function files(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dq-alert-channels-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (name, value, mode = 0o600) => { const path = join(directory, name); writeFileSync(path, JSON.stringify(value), { mode }); return path; };
  return { directory, write, line: write('line.json', LINE), smtp: write('smtp.json', SMTP) };
}
function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), { status: next.status, headers: next.headers ?? {} });
  };
  return { calls, fetchImpl };
}
const tokenOk = { status: 200, body: { access_token: 'stateless-channel-token-0123456789', expires_in: 900, token_type: 'Bearer' } };

test('LINE 設定檔：只接受 0600 一般檔與正確欄位', t => {
  const f = files(t);
  assert.equal(loadLineConfigFile(f.line).to, LINE.to);
  assert.throws(() => loadLineConfigFile(f.write('open.json', LINE, 0o644)), error => error.code === 'LINE_CONFIG_INVALID');
  assert.throws(() => loadLineConfigFile(f.write('extra.json', { ...LINE, token: 'x' })), error => error.code === 'LINE_CONFIG_INVALID');
  assert.throws(() => loadLineConfigFile(f.write('to.json', { ...LINE, to: 'someone' })), error => error.code === 'LINE_CONFIG_INVALID');
  symlinkSync(f.line, join(f.directory, 'link.json'));
  assert.throws(() => loadLineConfigFile(join(f.directory, 'link.json')), error => error.code === 'LINE_CONFIG_INVALID');
  assert.throws(() => loadLineConfigFile('relative.json'), error => error.code === 'LINE_CONFIG_INVALID');
  assert.equal(privateConfigPresent(f.line), 'PRESENT'); assert.equal(privateConfigPresent(join(f.directory, 'none.json')), 'MISSING');
  assert.equal(privateConfigPresent(f.write('loose.json', LINE, 0o640)), 'NOT_PRIVATE');
});

test('LINE 推播：換無狀態權杖後推播；冪等鍵固定；只呼叫換權杖與推播兩個端點', async t => {
  const f = files(t);
  const { calls, fetchImpl } = fakeFetch([tokenOk, { status: 200, headers: { 'x-line-request-id': 'req-1' }, body: { sentMessages: [{ id: 'm1' }] } },
    { status: 200, headers: { 'x-line-request-id': 'req-2' }, body: {} }]);
  const line = createLinePushChannel({ configPath: f.line, fetchImpl });
  const first = await line.send({ idempotencyKey: 'delivery-1', text: '測試' });
  assert.deepEqual(first, { state: 'ACCEPTED', receiptId: 'line:req-1' });
  const second = await line.send({ idempotencyKey: 'delivery-2', text: '測試二' });
  assert.equal(second.state, 'ACCEPTED');
  assert.deepEqual(calls.map(c => c.url), ['https://api.line.me/oauth2/v3/token', 'https://api.line.me/v2/bot/message/push', 'https://api.line.me/v2/bot/message/push'],
    'the 15-minute token is reused; no revoke or long-lived token API is ever called');
  const tokenBody = new URLSearchParams(calls[0].init.body);
  assert.deepEqual([tokenBody.get('grant_type'), tokenBody.get('client_id')], ['client_credentials', LINE.channelId]);
  const push = calls[1].init;
  assert.match(push.headers['X-Line-Retry-Key'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(push.headers['X-Line-Retry-Key'], calls[2].init.headers['X-Line-Retry-Key']);
  assert.deepEqual(JSON.parse(push.body), { to: LINE.to, messages: [{ type: 'text', text: '測試' }] });
  assert(!JSON.stringify(first).includes(LINE.channelSecret));
  const again = fakeFetch([tokenOk, { status: 500 }]);
  const retry = createLinePushChannel({ configPath: f.line, fetchImpl: again.fetchImpl });
  assert.equal((await retry.send({ idempotencyKey: 'delivery-1', text: 'x' })).state, 'RETRY');
  assert.equal(again.calls[1].init.headers['X-Line-Retry-Key'], push.headers['X-Line-Retry-Key'], 'same delivery → same retry key');
});

test('LINE 錯誤對照：429／額度→QUOTA、409 已接受→ACCEPTED、4xx→FAILED、送出後斷線→UNKNOWN、權杖失敗→FAILED', async t => {
  const f = files(t);
  const cases = [
    [[tokenOk, { status: 429, body: { message: 'You have reached your monthly limit.' } }], 'QUOTA'],
    [[{ status: 429 }], 'QUOTA'],
    [[tokenOk, { status: 409, headers: { 'x-line-accepted-request-id': 'req-0' } }], 'ACCEPTED'],
    [[tokenOk, { status: 400 }], 'FAILED'],
    [[tokenOk, new TypeError('socket hang up')], 'UNKNOWN'],
    [[new TypeError('getaddrinfo ENOTFOUND')], 'FAILED'],
    [[{ status: 401 }], 'FAILED']];
  for (const [responses, expected] of cases) {
    const { fetchImpl } = fakeFetch(responses);
    assert.equal((await createLinePushChannel({ configPath: f.line, fetchImpl }).send({ idempotencyKey: 'd', text: 'x' })).state, expected);
  }
  const denied = fakeFetch([]);
  const budgeted = createLinePushChannel({ configPath: f.line, fetchImpl: denied.fetchImpl, budget: { reserve: () => false } });
  assert.equal((await budgeted.send({ idempotencyKey: 'd', text: 'x' })).state, 'FAILED'); assert.equal(denied.calls.length, 0);
  const login = fakeFetch([tokenOk]);
  assert.equal((await createLinePushChannel({ configPath: f.line, fetchImpl: login.fetchImpl }).checkLogin()).state, 'OK');
  assert.equal(login.calls.length, 1, 'self-check only exchanges a token; it never pushes');
  assert.equal((await createLinePushChannel({ configPath: join(f.directory, 'missing.json'), fetchImpl: login.fetchImpl }).send({ idempotencyKey: 'd', text: 'x' })).state, 'FAILED');
});

test('Gmail SMTP 主管道：收件人固定為設定檔 user；覆寫只能改主機；預算不足不建立連線', async t => {
  const f = files(t); const made = [];
  const transportFactory = config => { made.push(config); return { async send(message) { made.push(message); return { state: 'ACCEPTED', providerMessageId: `<dq-${message.id}@example.test>` }; }, close() {} }; };
  const smtp = createSmtpAlertChannel({ configPath: f.smtp, transportFactory });
  const result = await smtp.send({ idempotencyKey: 'delivery-1', subject: 's', text: 't' });
  assert.equal(result.state, 'ACCEPTED'); assert.equal(made[1].to, SMTP.user); assert.match(made[1].id, /^dq[a-f0-9]{40}$/);
  const failing = createSmtpAlertChannel({ configPath: f.smtp, overrides: { host: 'dungeonq-n2.invalid' },
    transportFactory: config => { made.push(config); return { async send() { return { state: 'UNKNOWN' }; }, close() {} }; } });
  assert.equal((await failing.send({ idempotencyKey: 'd2', subject: 's', text: 't' })).state, 'UNKNOWN');
  assert.equal(made.at(-1).host, 'dungeonq-n2.invalid'); assert.equal(made.at(-1).user, SMTP.user);
  assert.throws(() => createSmtpAlertChannel({ configPath: f.smtp, overrides: { user: 'attacker@example.test' } }), error => error.code === 'SMTP_CHANNEL_INVALID');
  const before = made.length;
  const budgeted = createSmtpAlertChannel({ configPath: f.smtp, transportFactory, budget: { reserve: () => false } });
  assert.equal((await budgeted.send({ idempotencyKey: 'd3', subject: 's', text: 't' })).state, 'FAILED'); assert.equal(made.length, before);
  const verified = [];
  const login = createSmtpAlertChannel({ configPath: f.smtp, verify: async config => { verified.push(config.host); return { state: 'OK' }; } });
  assert.equal((await login.checkLogin()).state, 'OK'); assert.deepEqual(verified, ['smtp.gmail.com']);
});

test('IMAP 唯讀量測：LOGIN／EXAMINE／SEARCH／FETCH INTERNALDATE，找不到不回傳；伺服器拒絕即失敗', async t => {
  const f = files(t); const seen = [];
  const server = createServer(socket => {
    socket.setEncoding('utf8'); socket.write('* OK IMAP4rev1 ready\r\n'); let buffer = ''; let mailbox = null;
    socket.on('data', chunk => {
      buffer += chunk; let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2); seen.push(line);
        const [tag, command] = line.split(' ');
        if (command === 'LOGIN') socket.write(line.includes('"fake app password"') ? `${tag} OK LOGIN completed\r\n` : `${tag} NO bad\r\n`);
        else if (command === 'EXAMINE') { mailbox = line.slice(line.indexOf('EXAMINE ') + 8); socket.write(`* FLAGS (\\Seen)\r\n* 3 EXISTS\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`); }
        else if (command === 'LIST') socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\All) "/" "[Gmail]/All Mail"\r\n${tag} OK LIST completed\r\n`);
        else if (command === 'SEARCH') socket.write(`${line.includes('DQA0123456789') && mailbox === 'INBOX' || line.includes('DQAAAAAAAAAAA') && mailbox === '"[Gmail]/All Mail"' ? '* SEARCH 2 3\r\n' : '* SEARCH\r\n'}${tag} OK SEARCH completed\r\n`);
        else if (command === 'FETCH') socket.write(`* 3 FETCH (INTERNALDATE "20-Oct-2026 10:11:12 +0800")\r\n${tag} OK FETCH completed\r\n`);
        else if (command === 'LOGOUT') { socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`); socket.end(); }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const connect = options => netConnect({ host: '127.0.0.1', port: server.address().port, ...(options.servername ? {} : {}) });
  const probe = createImapInboxProbe({ configPath: f.smtp, connect, host: '127.0.0.1', port: server.address().port });
  const result = await probe.find({ tokens: ['DQA0123456789', 'DQAFFFFFFFFFF', 'DQAAAAAAAAAAA'] });
  assert.deepEqual(result.found, { DQA0123456789: Date.UTC(2026, 9, 20, 2, 11, 12), DQAAAAAAAAAAA: Date.UTC(2026, 9, 20, 2, 11, 12) },
    'a self-addressed alert that skipped INBOX is found in the \\All mailbox');
  assert(seen.some(line => / EXAMINE "\[Gmail\]\/All Mail"$/.test(line)));
  assert(seen.some(line => / EXAMINE INBOX$/.test(line)), 'read-only select'); assert(!seen.some(line => / (SELECT|STORE|COPY|EXPUNGE|APPEND) /.test(line)));
  assert(seen.some(line => / FETCH 3 \(INTERNALDATE\)$/.test(line)), 'only the arrival time is fetched, never a body');
  const bad = files(t); const wrong = bad.write('smtp-wrong.json', { ...SMTP, password: 'other' });
  await assert.rejects(createImapInboxProbe({ configPath: wrong, connect, host: '127.0.0.1', port: server.address().port }).find({ tokens: ['DQA0123456789'] }),
    error => error.code === 'IMAP_COMMAND_REJECTED');
  await assert.rejects(probe.find({ tokens: ['not-a-token'] }), error => error.code === 'IMAP_PROBE_INVALID');
  assert.equal(parseInternalDate(' 1-Jan-2026 00:00:00 +0000'), Date.UTC(2026, 0, 1)); assert.equal(parseInternalDate('garbage'), null);
});
