import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createConnection, isIP } from 'node:net';
import nodemailer from 'nodemailer';
import { Store } from './store.mjs';
import { canonicalJson, exact, GovernanceError, requireThat } from './contracts.mjs';

const CONFIG_LIMIT = 16384;
const SEND_TIMEOUT_MS = 4500;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;

function messageId(value) {
  requireThat(typeof value === 'string' && MESSAGE_ID.test(value), 'EMAIL_ID_INVALID');
  return value;
}

function emailAddress(value) {
  requireThat(typeof value === 'string' && value.length <= 254 && /^[\x21-\x7e]+$/u.test(value), 'EMAIL_ADDRESS_INVALID');
  const parts = value.split('@');
  requireThat(parts.length === 2 && parts[0].length > 0 && parts[0].length <= 64
    && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u.test(parts[0])
    && !parts[0].startsWith('.') && !parts[0].endsWith('.') && !parts[0].includes('..')
    && parts[1].includes('.') && parts[1].length <= 253
    && parts[1].split('.').every(label => DOMAIN_LABEL.test(label)), 'EMAIL_ADDRESS_INVALID');
  return value;
}

function emailMessage(value) {
  exact(value, ['id', 'to', 'subject', 'text']);
  messageId(value.id); emailAddress(value.to);
  requireThat(typeof value.subject === 'string' && value.subject.length > 0
    && Buffer.byteLength(value.subject) <= 240 && !/[\x00-\x1f\x7f]/u.test(value.subject), 'EMAIL_SUBJECT_INVALID');
  requireThat(typeof value.text === 'string' && value.text.length > 0 && Buffer.byteLength(value.text) <= 8192
    && !/[\x00-\x08\x0b-\x1f\x7f]/u.test(value.text), 'EMAIL_TEXT_INVALID');
  return { ...value };
}

// This is a local simulation mailbox. ACCEPTED never means external email delivery.
export function openEmailCapture({ path, key }) {
  requireThat(Buffer.isBuffer(key) && key.length === 32, 'EMAIL_CAPTURE_KEY_INVALID');
  const encryptionKey = Buffer.from(key);
  const store = new Store(path);
  let closed = false;
  try {
    store.transaction(() => {
      store.run('CREATE TABLE IF NOT EXISTS email_capture (id TEXT PRIMARY KEY, digest TEXT NOT NULL, sealed TEXT NOT NULL) STRICT');
      const pin = createHash('sha256').update('dungeonq.email-capture-key/v1\0').update(encryptionKey).digest('hex');
      const old = store.get("SELECT value FROM configuration WHERE key='email-capture-key'");
      requireThat(!old || old.value === pin, 'EMAIL_CAPTURE_KEY_PIN_MISMATCH');
      if (!old) store.run("INSERT INTO configuration(key,value) VALUES ('email-capture-key',?)", pin);
    });
  } catch (error) { store.close(); encryptionKey.fill(0); throw error; }

  const checkOpen = () => requireThat(!closed, 'EMAIL_TRANSPORT_CLOSED');
  const contentDigest = value => createHmac('sha256', encryptionKey).update('dungeonq.email-capture/v1\0')
    .update(canonicalJson(value)).digest('hex');
  const receipt = id => ({ state: 'ACCEPTED', providerMessageId: `<dq-capture-${id}@local.invalid>` });
  function unseal(row) {
    try {
      const bytes = Buffer.from(row.sealed, 'base64url');
      requireThat(bytes.length >= 29 && bytes.toString('base64url') === row.sealed, 'EMAIL_CAPTURE_CORRUPT');
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(`dungeonq.email-capture/v1:${row.id}`));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const payload = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
      exact(payload, ['id', 'to', 'subject', 'text', 'acceptedAt']);
      const { acceptedAt, ...message } = payload;
      emailMessage(message);
      requireThat(message.id === row.id && contentDigest(message) === row.digest
        && Number.isSafeInteger(acceptedAt) && acceptedAt >= 0, 'EMAIL_CAPTURE_CORRUPT');
      return payload;
    } catch { throw new GovernanceError('EMAIL_CAPTURE_CORRUPT'); }
  }

  return {
    mode: 'LOCAL_EMAIL_CAPTURE',
    send(input) {
      checkOpen(); const message = emailMessage(input); const hash = contentDigest(message);
      return store.transaction(now => {
        const old = store.get('SELECT * FROM email_capture WHERE id=?', message.id);
        if (old) {
          requireThat(old.digest === hash, 'EMAIL_ID_CONFLICT');
          unseal(old); return receipt(message.id);
        }
        const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
        cipher.setAAD(Buffer.from(`dungeonq.email-capture/v1:${message.id}`));
        const encrypted = Buffer.concat([cipher.update(canonicalJson({ ...message, acceptedAt: now }), 'utf8'), cipher.final()]);
        store.run('INSERT INTO email_capture(id,digest,sealed) VALUES (?,?,?)', message.id, hash,
          Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url'));
        return receipt(message.id);
      });
    },
    preview(ids) {
      checkOpen(); requireThat(Array.isArray(ids) && ids.length <= 50, 'EMAIL_PREVIEW_LIMIT');
      ids.forEach(messageId);
      return [...new Set(ids)].flatMap(id => {
        const row = store.get('SELECT * FROM email_capture WHERE id=?', id);
        return row ? [unseal(row)] : [];
      });
    },
    lookup(id) {
      checkOpen(); messageId(id);
      const row = store.get('SELECT * FROM email_capture WHERE id=?', id);
      if (!row) return undefined;
      unseal(row); return receipt(id);
    },
    close() { if (!closed) { closed = true; store.close(); encryptionKey.fill(0); } },
  };
}

function smtpConfig(input, allowLoopbackTestPort = false) {
  try {
    exact(input, Object.hasOwn(input ?? {}, 'ca')
      ? ['host', 'port', 'secure', 'from', 'user', 'password', 'ca']
      : ['host', 'port', 'secure', 'from', 'user', 'password']);
    requireThat(typeof input.host === 'string' && input.host.length > 0 && input.host.length <= 253
      && (isIP(input.host) !== 0 || input.host.split('.').every(label => DOMAIN_LABEL.test(label))), 'EMAIL_SMTP_CONFIG_INVALID');
    const testPort = allowLoopbackTestPort && ['127.0.0.1', '::1', 'localhost'].includes(input.host)
      && typeof input.ca === 'string' && input.ca.length > 0;
    requireThat(Number.isSafeInteger(input.port) && input.port >= 1 && input.port <= 65535
      && ([465, 587].includes(input.port) || testPort), 'EMAIL_SMTP_CONFIG_INVALID');
    requireThat(typeof input.secure === 'boolean'
      && (testPort || (input.port === 465 ? input.secure : !input.secure)), 'EMAIL_SMTP_CONFIG_INVALID');
    emailAddress(input.from);
    for (const name of ['user', 'password']) requireThat(typeof input[name] === 'string'
      && input[name].length > 0 && Buffer.byteLength(input[name]) <= 2048
      && !/[\x00-\x1f\x7f]/u.test(input[name]), 'EMAIL_SMTP_CONFIG_INVALID');
    if (Object.hasOwn(input, 'ca')) requireThat(typeof input.ca === 'string' && input.ca.length > 0
      && Buffer.byteLength(input.ca) <= 12288 && /^-----BEGIN CERTIFICATE-----\r?\n/u.test(input.ca)
      && /-----END CERTIFICATE-----\s*$/u.test(input.ca), 'EMAIL_SMTP_CONFIG_INVALID');
    return Object.freeze({ ...input });
  } catch { throw new GovernanceError('EMAIL_SMTP_CONFIG_INVALID'); }
}

// No environment fallback: the trusted deployment explicitly supplies this private file.
export function loadSmtpConfigFile(path) {
  let descriptor;
  try {
    requireThat(typeof path === 'string' && isAbsolute(path), 'EMAIL_SMTP_CONFIG_INVALID');
    const before = lstatSync(path);
    requireThat(before.isFile() && !before.isSymbolicLink() && before.nlink === 1
      && (before.mode & 0o777) === 0o600 && before.size > 0 && before.size <= CONFIG_LIMIT, 'EMAIL_SMTP_CONFIG_INVALID');
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    requireThat(opened.isFile() && opened.dev === before.dev && opened.ino === before.ino && opened.nlink === 1
      && (opened.mode & 0o777) === 0o600 && opened.size <= CONFIG_LIMIT, 'EMAIL_SMTP_CONFIG_INVALID');
    const buffer = Buffer.alloc(CONFIG_LIMIT + 1);
    const size = readSync(descriptor, buffer, 0, buffer.length, 0);
    requireThat(size > 0 && size <= CONFIG_LIMIT && size === opened.size, 'EMAIL_SMTP_CONFIG_INVALID');
    return smtpConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))));
  } catch { throw new GovernanceError('EMAIL_SMTP_CONFIG_INVALID'); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

// The optional second argument is exclusively for an in-process loopback TLS fixture.
// It is not accepted by loadSmtpConfigFile and cannot weaken certificate validation.
export function createSmtpEmailTransport(input, testOptions = {}) {
  exact(testOptions, Object.hasOwn(testOptions, 'allowLoopbackTestPort') ? ['allowLoopbackTestPort'] : []);
  requireThat(!Object.hasOwn(testOptions, 'allowLoopbackTestPort') || testOptions.allowLoopbackTestPort === true,
    'EMAIL_SMTP_CONFIG_INVALID');
  const config = smtpConfig(input, testOptions.allowLoopbackTestPort === true);
  const active = new Set(); let closed = false;
  return {
    mode: 'SMTP',
    async send(inputMessage) {
      requireThat(!closed, 'EMAIL_TRANSPORT_CLOSED');
      const message = emailMessage(inputMessage);
      const providerMessageId = `<dq-${message.id}@${config.from.split('@')[1].toLowerCase()}>`;
      return new Promise(resolve => {
        let transporter; let socket; let timer; let settled = false;
        const finish = result => {
          if (settled) return;
          settled = true; clearTimeout(timer); active.delete(cancel);
          socket?.destroy(); transporter?.close(); resolve(result);
        };
        const cancel = () => finish({ state: 'UNKNOWN' });
        active.add(cancel);
        try {
          // Keep the actual socket so a deadline cancels ongoing I/O. A one-shot
          // transport cannot requeue a message after an ambiguous connection loss.
          transporter = nodemailer.createTransport({
            pool: false,
            host: config.host, port: config.port, secure: config.secure,
            getSocket(_options, callback) {
              if (settled) { callback(new GovernanceError('EMAIL_SEND_CANCELLED')); return; }
              socket = createConnection({ host: config.host, port: config.port });
              const failed = error => callback(error);
              socket.once('error', failed);
              socket.once('connect', () => {
                socket.removeListener('error', failed);
                if (settled) { socket.destroy(); callback(new GovernanceError('EMAIL_SEND_CANCELLED')); return; }
                callback(null, { connection: socket });
              });
            },
            requireTLS: true, ignoreTLS: false,
            auth: { user: config.user, pass: config.password }, forceAuth: true,
            tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, ...(config.ca ? { ca: config.ca } : {}) },
            connectionTimeout: 2000, greetingTimeout: 2000, socketTimeout: 4000, dnsTimeout: 2000,
            disableFileAccess: true, disableUrlAccess: true,
            maxRecipients: 1, logger: false, debug: false,
          });
          timer = setTimeout(cancel, SEND_TIMEOUT_MS);
          transporter.sendMail({
            from: config.from, to: message.to, envelope: { from: config.from, to: [message.to] },
            messageId: providerMessageId, subject: message.subject, text: message.text,
            disableFileAccess: true, disableUrlAccess: true,
          }, (error, result) => {
            if (error) {
              const code = error.responseCode;
              finish({ state: Number.isInteger(code) && code >= 400 && code < 500 ? 'RETRY'
                : Number.isInteger(code) && code >= 500 && code < 600 ? 'FAILED' : 'UNKNOWN' });
              return;
            }
            const accepted = result?.accepted;
            finish(Array.isArray(accepted) && accepted.length === 1 && accepted[0] === message.to
              && Array.isArray(result.rejected) && result.rejected.length === 0
              ? { state: 'ACCEPTED', providerMessageId } : { state: 'UNKNOWN' });
          });
        } catch { finish({ state: 'UNKNOWN' }); }
      });
    },
    close() { closed = true; for (const cancel of [...active]) cancel(); },
  };
}
