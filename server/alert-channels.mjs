// DQ-HANDOFF-015 M3：執行環境自己的通知管道（Gmail SMTP 主管道、LINE 推播備援）與唯讀收件匣量測。
// 祕密只在寄送、登入檢查或量測的當下由私人 0600 檔讀入；不寫入日誌、事件、錯誤訊息或指令參數。
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import nodemailer from 'nodemailer';
import { createSmtpEmailTransport, loadSmtpConfigFile } from './email-transport.mjs';

const CONFIG_LIMIT = 16384;
const LINE_TOKEN_URL = 'https://api.line.me/oauth2/v3/token';
const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const LINE_TEXT_LIMIT = 5000;
const RESPONSE_LIMIT = 65536;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const coded = code => Object.assign(new Error(code), { code });
const check = (condition, code) => { if (!condition) throw coded(code); };

/** LINE 設定檔：{ channelId, channelSecret, to }，規則與 SMTP 設定檔相同（絕對路徑、一般檔、非連結、0600）。 */
export function loadLineConfigFile(path) {
  let descriptor;
  try {
    check(typeof path === 'string' && isAbsolute(path), 'LINE_CONFIG_INVALID');
    const before = lstatSync(path);
    check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && (before.mode & 0o777) === 0o600
      && before.size > 0 && before.size <= CONFIG_LIMIT, 'LINE_CONFIG_INVALID');
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    check(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && (opened.mode & 0o777) === 0o600, 'LINE_CONFIG_INVALID');
    const buffer = Buffer.alloc(CONFIG_LIMIT + 1); const size = readSync(descriptor, buffer, 0, buffer.length, 0);
    check(size > 0 && size <= CONFIG_LIMIT, 'LINE_CONFIG_INVALID');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)));
    check(value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).sort().join(',') === 'channelId,channelSecret,to', 'LINE_CONFIG_INVALID');
    const channelId = typeof value.channelId === 'number' ? String(value.channelId) : value.channelId;
    check(typeof channelId === 'string' && /^[0-9]{6,20}$/.test(channelId), 'LINE_CONFIG_INVALID');
    check(typeof value.channelSecret === 'string' && /^[\x21-\x7e]{16,128}$/.test(value.channelSecret), 'LINE_CONFIG_INVALID');
    check(typeof value.to === 'string' && /^[UCR][0-9a-f]{32}$/.test(value.to), 'LINE_CONFIG_INVALID');
    return Object.freeze({ channelId, channelSecret: value.channelSecret, to: value.to });
  } catch { throw coded('LINE_CONFIG_INVALID'); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** 私人設定檔是否存在且權限正確；只看檔案屬性，不讀內容。 */
export function privateConfigPresent(path) {
  try {
    if (typeof path !== 'string' || !isAbsolute(path)) return 'INVALID_PATH';
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && (info.mode & 0o777) === 0o600 ? 'PRESENT' : 'NOT_PRIVATE';
  } catch (error) { return error?.code === 'ENOENT' ? 'MISSING' : 'UNREADABLE'; }
}

function retryKeyFor(idempotencyKey) {
  const hex = sha256(`dungeonq.line-retry-key/v1\0${idempotencyKey}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(8 + (parseInt(hex[16], 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function boundedJson(response) {
  const text = await response.text();
  if (text.length > RESPONSE_LIMIT) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const combine = (signal, ms) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

/**
 * LINE 備援管道：每次需要時以 Channel ID＋secret 換 900 秒無狀態權杖（只放記憶體），再以 X-Line-Retry-Key 推播。
 * 絕不呼叫重新發行或撤銷長期權杖的 API。429／額度錯誤回 QUOTA，由告警交接把管道標為不可用。
 */
export function createLinePushChannel({ configPath, fetchImpl = globalThis.fetch, clock = Date.now, budget, name = 'LINE_PUSH' } = {}) {
  check(typeof fetchImpl === 'function' && typeof clock === 'function', 'LINE_CHANNEL_INVALID');
  check(budget === undefined || typeof budget?.reserve === 'function', 'LINE_CHANNEL_INVALID');
  let cached = null;
  async function token(config, signal) {
    if (cached && cached.channelId === config.channelId && cached.expiresAt > clock() + 60000) return { token: cached.token };
    let response;
    try {
      response = await fetchImpl(LINE_TOKEN_URL, { method: 'POST', signal: combine(signal, 5000), redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: config.channelId, client_secret: config.channelSecret }).toString() });
    } catch { return { state: 'FAILED' }; }
    if (response.status === 429) return { state: 'QUOTA' };
    if (response.status !== 200) return { state: response.status >= 500 ? 'RETRY' : 'FAILED' };
    const body = await boundedJson(response);
    if (!body || typeof body.access_token !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(body.access_token)
      || !Number.isSafeInteger(body.expires_in) || body.expires_in < 60) return { state: 'FAILED' };
    cached = { channelId: config.channelId, token: body.access_token, expiresAt: clock() + body.expires_in * 1000 };
    return { token: body.access_token };
  }
  return Object.freeze({
    name, role: 'FALLBACK',
    async checkLogin({ signal } = {}) {
      let config; try { config = loadLineConfigFile(configPath); } catch { return { state: 'FAILED' }; }
      cached = null; const result = await token(config, signal);
      return { state: result.token ? 'OK' : result.state === 'RETRY' ? 'UNKNOWN' : 'FAILED' };
    },
    async send({ idempotencyKey, text }, { signal } = {}) {
      let config; try { config = loadLineConfigFile(configPath); } catch { return { state: 'FAILED' }; }
      if (budget && budget.reserve(name) !== true) return { state: 'FAILED' };
      const access = await token(config, signal);
      if (!access.token) return { state: access.state };
      let response;
      try {
        response = await fetchImpl(LINE_PUSH_URL, { method: 'POST', signal: combine(signal, 6000), redirect: 'error',
          headers: { Authorization: `Bearer ${access.token}`, 'Content-Type': 'application/json', 'X-Line-Retry-Key': retryKeyFor(idempotencyKey) },
          body: JSON.stringify({ to: config.to, messages: [{ type: 'text', text: String(text).slice(0, LINE_TEXT_LIMIT) }] }) });
      } catch { return { state: 'UNKNOWN' }; }
      if (response.status === 200) {
        const body = await boundedJson(response);
        const receipt = response.headers.get('x-line-request-id') ?? body?.sentMessages?.[0]?.id;
        return typeof receipt === 'string' && /^[\x21-\x7e]{1,255}$/.test(receipt) ? { state: 'ACCEPTED', receiptId: `line:${receipt}` } : { state: 'UNKNOWN' };
      }
      if (response.status === 409) {
        // Same retry key already accepted by LINE: the earlier push succeeded; never a second message.
        const accepted = response.headers.get('x-line-accepted-request-id');
        return typeof accepted === 'string' && /^[\x21-\x7e]{1,255}$/.test(accepted) ? { state: 'ACCEPTED', receiptId: `line:${accepted}` } : { state: 'UNKNOWN' };
      }
      if (response.status === 401) cached = null;
      if (response.status === 429) return { state: 'QUOTA' };
      return { state: response.status >= 500 ? 'RETRY' : 'FAILED' };
    }
  });
}

/**
 * Gmail SMTP 主管道：沿用既有 createSmtpEmailTransport（TLS、憑證驗證、一次性連線、不盲目重送），收件人固定為設定檔 user。
 * overrides 只供驗收以無效主機模擬失敗；它不能放寬 TLS 或改收件人。
 */
export function createSmtpAlertChannel({ configPath, transportFactory = createSmtpEmailTransport, verify = smtpVerifyLogin,
  budget, overrides, name = 'GMAIL_SMTP' } = {}) {
  check(typeof transportFactory === 'function' && typeof verify === 'function', 'SMTP_CHANNEL_INVALID');
  check(budget === undefined || typeof budget?.reserve === 'function', 'SMTP_CHANNEL_INVALID');
  check(overrides === undefined || (overrides && Object.keys(overrides).every(key => ['host', 'port', 'secure'].includes(key))), 'SMTP_CHANNEL_INVALID');
  const effective = config => overrides ? { ...config, ...overrides } : config;
  return Object.freeze({
    name, role: 'PRIMARY', inbox: true,
    async checkLogin({ signal } = {}) {
      let config; try { config = effective(loadSmtpConfigFile(configPath)); } catch { return { state: 'FAILED' }; }
      return verify(config, { signal });
    },
    async send({ idempotencyKey, subject, text }, { signal } = {}) {
      let config; try { config = loadSmtpConfigFile(configPath); } catch { return { state: 'FAILED' }; }
      if (budget && budget.reserve(name) !== true) return { state: 'FAILED' };
      let transport;
      try { transport = transportFactory(effective(config)); } catch { return { state: 'FAILED' }; }
      const cancel = () => transport.close();
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const result = await transport.send({ id: `dq${sha256(idempotencyKey).slice(0, 40)}`, to: config.user, subject, text });
        if (result?.state === 'ACCEPTED' && typeof result.providerMessageId === 'string') return { state: 'ACCEPTED', receiptId: result.providerMessageId };
        return { state: ['RETRY', 'FAILED'].includes(result?.state) ? result.state : 'UNKNOWN' };
      } catch { return { state: 'UNKNOWN' }; }
      finally { signal?.removeEventListener('abort', cancel); transport.close(); }
    }
  });
}

/** 只登入不寄送（nodemailer verify：連線、TLS、AUTH）。 */
export async function smtpVerifyLogin(config, { signal } = {}) {
  const transporter = nodemailer.createTransport({ pool: false, host: config.host, port: config.port, secure: config.secure,
    requireTLS: true, ignoreTLS: false, auth: { user: config.user, pass: config.password },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true }, connectionTimeout: 4000, greetingTimeout: 4000, socketTimeout: 5000,
    dnsTimeout: 3000, logger: false, debug: false });
  const cancel = () => transporter.close();
  signal?.addEventListener('abort', cancel, { once: true });
  try { await transporter.verify(); return { state: 'OK' }; }
  catch (error) { return { state: Number.isInteger(error?.responseCode) ? 'FAILED' : 'UNKNOWN' }; }
  finally { signal?.removeEventListener('abort', cancel); transporter.close(); }
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
export function parseInternalDate(text) {
  const match = /^\s?(\d{1,2})-([A-Z][a-z]{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(text ?? '');
  if (!match || !Object.hasOwn(MONTHS, match[2])) return null;
  const offset = (match[7] === '-' ? -1 : 1) * (Number(match[8]) * 60 + Number(match[9])) * 60000;
  const value = Date.UTC(Number(match[3]), MONTHS[match[2]], Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6])) - offset;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const imapQuote = value => {
  check(typeof value === 'string' && value.length <= 1024 && !/[\r\n\0]/.test(value), 'IMAP_ARGUMENT_INVALID');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
};

/** 極小 IMAP 用戶端：只用 LOGIN、EXAMINE（唯讀選取）、SEARCH SUBJECT、FETCH INTERNALDATE、LOGOUT。不讀信件內容、不改旗標。 */
async function imapSession({ host, port, connect, signal, timeoutMs }, work) {
  const socket = connect({ host, port, servername: host, minVersion: 'TLSv1.2', rejectUnauthorized: true });
  let buffer = ''; let waiting = null; let failed = null; let size = 0;
  const lines = [];
  const settle = () => { if (waiting && (lines.length || failed)) { const w = waiting; waiting = null; w(); } };
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    size += chunk.length; if (size > 1_048_576) { failed = coded('IMAP_RESPONSE_LIMIT'); socket.destroy(); }
    buffer += chunk; let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) { lines.push(buffer.slice(0, index)); buffer = buffer.slice(index + 2); }
    settle();
  });
  socket.on('error', () => { failed ??= coded('IMAP_CONNECTION_FAILED'); settle(); });
  socket.on('close', () => { failed ??= coded('IMAP_CONNECTION_CLOSED'); settle(); });
  const timer = setTimeout(() => { failed ??= coded('IMAP_TIMEOUT'); socket.destroy(); settle(); }, timeoutMs);
  const abort = () => { failed ??= coded('IMAP_ABORTED'); socket.destroy(); settle(); };
  signal?.addEventListener('abort', abort, { once: true });
  const nextLine = async () => {
    while (!lines.length) { if (failed) throw failed; await new Promise(resolve => { waiting = resolve; }); }
    return lines.shift();
  };
  let tag = 0;
  const command = async text => {
    const id = `D${++tag}`; socket.write(`${id} ${text}\r\n`);
    const untagged = [];
    for (;;) {
      const line = await nextLine();
      if (line.startsWith(`${id} `)) { if (!/^D\d+ OK\b/.test(line)) throw coded('IMAP_COMMAND_REJECTED'); return untagged; }
      untagged.push(line);
    }
  };
  try {
    const greeting = await nextLine();
    check(/^\* OK\b/.test(greeting), 'IMAP_GREETING_INVALID');
    return await work(command);
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    try { if (!failed) socket.write(`D${++tag} LOGOUT\r\n`); } catch { /* best effort */ }
    socket.end(); setTimeout(() => socket.destroy(), 500).unref?.();
  }
}

/**
 * 收件匣到達量測（D13，使用者授權唯讀）：用同一組 Gmail 應用程式密碼以 IMAP 唯讀查詢告警信主旨的追蹤碼，
 * 回傳伺服器的 INTERNALDATE。只搜尋本系統告警信的追蹤碼，不取信件內容。
 */
export function createImapInboxProbe({ configPath, connect = tlsConnect, host, port = 993, timeoutMs = 9000 } = {}) {
  check(typeof connect === 'function', 'IMAP_PROBE_INVALID');
  return Object.freeze({
    async find({ tokens, signal } = {}) {
      check(Array.isArray(tokens) && tokens.length >= 1 && tokens.length <= 16 && tokens.every(t => typeof t === 'string' && /^DQA[0-9A-F]{10}$/.test(t)), 'IMAP_PROBE_INVALID');
      const config = loadSmtpConfigFile(configPath);
      const imapHost = host ?? (config.host === 'smtp.gmail.com' ? 'imap.gmail.com' : null);
      check(imapHost, 'IMAP_PROBE_UNSUPPORTED');
      return imapSession({ host: imapHost, port, connect, signal, timeoutMs }, async command => {
        await command(`LOGIN ${imapQuote(config.user)} ${imapQuote(config.password)}`);
        const found = {};
        const search = async remaining => {
          for (const token of remaining) {
            const untagged = await command(`SEARCH SUBJECT ${imapQuote(token)}`);
            const ids = untagged.filter(line => line.startsWith('* SEARCH')).flatMap(line => line.slice(8).trim().split(/\s+/).filter(v => /^[1-9][0-9]{0,9}$/.test(v)));
            if (!ids.length) continue;
            const fetched = await command(`FETCH ${ids.at(-1)} (INTERNALDATE)`);
            const date = fetched.map(line => /INTERNALDATE "([^"]+)"/.exec(line)?.[1]).find(Boolean);
            const value = parseInternalDate(date);
            if (value !== null) found[token] = value;
          }
        };
        await command('EXAMINE INBOX');
        await search(tokens);
        // Self-addressed mail may skip INBOX; the RFC 6154 \All mailbox holds every message with the same INTERNALDATE.
        const missing = tokens.filter(token => !Object.hasOwn(found, token));
        if (missing.length) {
          const all = (await command('LIST "" "*"')).map(line => /^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) ("(?:[^"\\]|\\.)*"|[^\s"]+)$/.exec(line))
            .find(match => match && /(?:^|\s)\\All(?:\s|$)/.test(match[1]))?.[2];
          if (all && all.length <= 256) { await command(`EXAMINE ${all}`); await search(missing); }
        }
        return { found };
      });
    }
  });
}
