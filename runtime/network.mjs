import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import ssh2 from 'ssh2';
import { BackendError, BackendMessageCode, PostgresConnection } from 'pg-gateway';

export const NETWORK_LIMITS = Object.freeze({
  connections: 32, requestsPerConnection: 128, concurrentSshSessions: 4,
  inputBytes: 16_384, bufferedBytes: 32_768, outputBytes: 65_536,
  tokenBytes: 2_048, dispatchTimeoutMs: 5_000, idleTimeoutMs: 15_000,
  sessionLifetimeMs: 60_000,
});

export const NETWORK_SUPPORTED_SUBSET = Object.freeze({
  version: 'dungeonq-network-v1', bind: 'loopback-only', username: 'dungeonq',
  ssh: 'Password authentication; exec: dq <JSON envelope>, snapshot, read <key>. No shell, PTY, forwarding, environment, or subsystem.',
  postgres: "Protocol 3.0; disposable cleartext password on loopback; simple query SELECT dungeonq('<JSON envelope>'); one JSON result column. No SQL execution, extended queries, transactions, or database connection.",
  postgresLibrary: 'pg-gateway 0.3.0-beta.4 (prerelease; tested subset only)',
  envelope: '{requestId,operation,args}',
  operations: Object.freeze(['snapshot', 'read', 'write', 'issue-ticket', 'use-ticket']),
});

const operations = new Set(NETWORK_SUPPORTED_SUBSET.operations);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const fault = (code) => Object.assign(new Error(code), { code });
const rejectRequest = () => { throw fault('UNSUPPORTED_REQUEST'); };
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function keys(value, required, optional = []) {
  if (!plain(value) || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) rejectRequest();
}

function validateJson(value, depth = 0) {
  if (depth > 12) rejectRequest();
  if (typeof value === 'number' && !Number.isFinite(value)) rejectRequest();
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return;
  if (!Array.isArray(value) && !plain(value)) rejectRequest();
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) rejectRequest();
    validateJson(child, depth + 1);
  }
}

function envelope(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > NETWORK_LIMITS.inputBytes) rejectRequest();
  let value;
  try { value = JSON.parse(text); } catch { rejectRequest(); }
  validateJson(value);
  keys(value, ['requestId', 'operation', 'args']);
  if (!idPattern.test(value.requestId) || typeof value.requestId !== 'string' || !operations.has(value.operation)) rejectRequest();
  const args = value.args;
  switch (value.operation) {
    case 'snapshot': keys(args, []); break;
    case 'read':
      keys(args, ['key']);
      if (typeof args.key !== 'string' || !keyPattern.test(args.key)) rejectRequest();
      break;
    case 'write':
      keys(args, ['key', 'value', 'expectedRevision']);
      if (typeof args.key !== 'string' || !keyPattern.test(args.key)
        || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0) rejectRequest();
      break;
    case 'issue-ticket':
      keys(args, [], ['scope', 'ttlMs', 'maxUses']);
      if (args.scope !== undefined && (!Array.isArray(args.scope) || args.scope.length < 1 || args.scope.length > 32
        || args.scope.some((key) => typeof key !== 'string' || !keyPattern.test(key)))) rejectRequest();
      for (const key of ['ttlMs', 'maxUses']) {
        if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < 1)) rejectRequest();
      }
      break;
    case 'use-ticket':
      keys(args, ['ticket'], ['key']);
      if (typeof args.ticket !== 'string' || args.ticket.length < 1 || Buffer.byteLength(args.ticket) > 8_192
        || (args.key !== undefined && (typeof args.key !== 'string' || !keyPattern.test(args.key)))) rejectRequest();
      break;
  }
  return value;
}

function sshEnvelope(command) {
  if (typeof command !== 'string' || Buffer.byteLength(command) > NETWORK_LIMITS.inputBytes) rejectRequest();
  if (command.startsWith('dq ')) return envelope(command.slice(3));
  if (command === 'snapshot') return { requestId: randomUUID(), operation: 'snapshot', args: {} };
  if (/^read [A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(command)) {
    return { requestId: randomUUID(), operation: 'read', args: { key: command.slice(5) } };
  }
  rejectRequest();
}

function postgresEnvelope(query) {
  const match = /^SELECT dungeonq\('((?:[^']|'')*)'\);?$/.exec(query);
  if (!match) rejectRequest();
  return envelope(match[1].replaceAll("''", "'"));
}

function tokenValid(token) {
  return typeof token === 'string' && token.length > 0
    && Buffer.byteLength(token) <= NETWORK_LIMITS.tokenBytes && !/[\u0000-\u001f\u007f]/.test(token);
}

function encodeResult(result) {
  if (!plain(result) || Object.hasOwn(result, 'error') || result.ok === false) throw fault('DISPATCH_DENIED');
  let serialized;
  try { serialized = JSON.stringify(result); } catch { throw fault('INVALID_DISPATCH_RESULT'); }
  if (Buffer.byteLength(serialized) > NETWORK_LIMITS.outputBytes) throw fault('RESPONSE_LIMIT');
  return serialized;
}

async function boundedDispatch(dispatch, request, signal) {
  if (signal.aborted) throw fault('SESSION_CLOSED');
  let timer;
  let abort;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(fault('DISPATCH_TIMEOUT')), NETWORK_LIMITS.dispatchTimeoutMs);
    abort = () => reject(fault('SESSION_CLOSED'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return encodeResult(await Promise.race([Promise.resolve().then(() => dispatch(request)), deadline]));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

function safeCode(error) {
  return ['UNSUPPORTED_REQUEST', 'DISPATCH_TIMEOUT', 'RESPONSE_LIMIT', 'SESSION_CLOSED'].includes(error?.code)
    ? error.code : 'DISPATCH_DENIED';
}

function pgError(code, fatal = false) {
  return BackendError.create({ severity: fatal ? 'FATAL' : 'ERROR', code: fatal ? '08P01' : '0A000', message: code }).flush();
}

function pgResult(connection, serialized) {
  // The library's backend writer owns framing; this is a single text-format JSON column.
  const writer = connection.bufferWriter;
  writer.addInt16(1).addCString('result').addInt32(0).addInt16(0).addInt32(114).addInt16(-1).addInt32(-1).addInt16(0);
  const description = writer.flush(BackendMessageCode.RowDescriptionMessage);
  const body = Buffer.from(serialized);
  writer.addInt16(1).addInt32(body.length).add(body);
  const row = writer.flush(BackendMessageCode.DataRow);
  writer.addCString('SELECT 1');
  return [description, row, writer.flush(BackendMessageCode.CommandComplete), connection.createReadyForQuery()];
}

function validateStartup(frame) {
  if (frame.length === 8 && frame.readUInt32BE(4) === 80877103) return; // SSLRequest: library returns N.
  if (frame.length < 10 || frame.readUInt32BE(4) !== 196608 || frame.at(-1) !== 0) rejectRequest();
  const fields = decoder.decode(frame.subarray(8)).split('\0');
  if (fields.pop() !== '' || fields.pop() !== '' || fields.length % 2 !== 0) rejectRequest();
  const allowed = new Set(['user', 'database', 'application_name', 'client_encoding']);
  const seen = new Set();
  for (let i = 0; i < fields.length; i += 2) {
    if (!allowed.has(fields[i]) || seen.has(fields[i]) || fields[i + 1].length > 128) rejectRequest();
    seen.add(fields[i]);
    if (['user', 'database'].includes(fields[i]) && fields[i + 1] !== 'dungeonq') rejectRequest();
  }
  if (!seen.has('user')) rejectRequest();
}

function cstring(frame) {
  if (frame.at(-1) !== 0 || frame.subarray(5, -1).includes(0)) rejectRequest();
  return decoder.decode(frame.subarray(5, -1));
}

function postgresSession(socket, dispatch, signal) {
  let token;
  let connection;
  let buffer = Buffer.alloc(0);
  let wake;
  let ended = false;
  let requests = 0;
  socket.pause();
  const notify = () => { wake?.(); wake = undefined; };
  const finish = () => { ended = true; token = undefined; buffer = Buffer.alloc(0); notify(); };
  socket.on('close', finish);
  socket.on('end', finish);
  socket.on('data', (data) => {
    socket.pause();
    if (buffer.length + data.length > NETWORK_LIMITS.bufferedBytes) { socket.destroy(); return; }
    buffer = Buffer.concat([buffer, data]);
    notify();
  });
  const duplex = {
    readable: new ReadableStream({
      async pull(controller) {
        while (!ended) {
          const prefix = connection?.hasStarted ? 1 : 0;
          if (buffer.length >= prefix + 4) {
            const length = buffer.readUInt32BE(prefix);
            if (length < (prefix ? 4 : 8) || length + prefix > NETWORK_LIMITS.inputBytes) {
              socket.destroy(); break;
            }
            if (buffer.length >= length + prefix) {
              // Standalone offset-zero bytes also avoid pooled Buffer offsets in the library reader.
              const frame = Uint8Array.from(buffer.subarray(0, length + prefix));
              buffer = buffer.subarray(length + prefix);
              controller.enqueue(frame);
              return;
            }
          }
          await new Promise((resolve) => { wake = resolve; socket.resume(); });
        }
        controller.close();
      },
      cancel() { socket.destroy(); },
    }, { highWaterMark: 0 }),
    writable: new WritableStream({
      write(data) {
        if (socket.destroyed) return;
        return new Promise((resolve) => socket.write(data, () => resolve()));
      },
      close() { socket.end(); },
      abort() { socket.destroy(); },
    }),
  };
  connection = new PostgresConnection(duplex, {
    serverVersion: '0.1 (DungeonQ bounded synthetic protocol)',
    auth: {
      method: 'password',
      // No password database: the trusted dispatch callback validates the supplied disposable token.
      getClearTextPassword: () => '',
      async validateCredentials({ username, password }) {
        if (username !== 'dungeonq' || !tokenValid(password)) return false;
        try {
          await boundedDispatch(dispatch, { token: password, family: 'postgres', requestId: `auth-${randomUUID()}`, operation: 'snapshot', args: {} }, signal);
          if (signal.aborted) return false;
          token = password;
          return true;
        } catch { return false; }
      },
    },
    async onMessage(data, state) {
      const frame = Buffer.from(data);
      try {
        if (++requests > NETWORK_LIMITS.requestsPerConnection) throw fault('REQUEST_LIMIT');
        if (!state.hasStarted) { validateStartup(frame); return; }
        if (!state.isAuthenticated) {
          if (frame[0] !== 112 || !tokenValid(cstring(frame))) rejectRequest();
          return;
        }
        if (frame[0] === 88 && frame.length === 5) return; // Terminate.
        if (frame[0] !== 81) throw fault('UNSUPPORTED_MESSAGE');
        const request = postgresEnvelope(cstring(frame));
        const result = await boundedDispatch(dispatch, { token, family: 'postgres', ...request }, signal);
        return pgResult(connection, result);
      } catch (error) {
        if (!state.isAuthenticated || ['REQUEST_LIMIT', 'UNSUPPORTED_MESSAGE'].includes(error?.code)) {
          throw BackendError.create({ severity: 'FATAL', code: '08P01', message: 'UNSUPPORTED_PROTOCOL_REQUEST' });
        }
        if (error?.code === 'DISPATCH_TIMEOUT') {
          // The callback may still finish. A client must reconcile using the same requestId.
          throw BackendError.create({ severity: 'FATAL', code: '57014', message: 'DISPATCH_TIMEOUT_OUTCOME_UNKNOWN' });
        }
        return [pgError(safeCode(error)), connection.createReadyForQuery()];
      }
    },
  });
}

/**
 * Local reference transport adapters. The callback is the only authority and state owner.
 * A timeout does not cancel an already dispatched mutation; reconcile with its requestId.
 * This profile intentionally rejects external binds because PostgreSQL TLS is not configured.
 */
export async function startNetworkAdapters({ dispatch, host = '127.0.0.1', sshPort = 0, postgresPort = 0, sshHostKey }) {
  if (typeof dispatch !== 'function' || !['127.0.0.1', '::1'].includes(host)) throw fault('LOOPBACK_DISPATCH_REQUIRED');
  for (const port of [sshPort, postgresPort]) {
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw fault('INVALID_PORT');
  }
  if (!(typeof sshHostKey === 'string' || Buffer.isBuffer(sshHostKey)) || sshHostKey.length === 0) throw fault('SSH_HOST_KEY_REQUIRED');
  const sockets = new Map();
  const sshProtocol = new ssh2.Server({ hostKeys: [sshHostKey], ident: 'DungeonQ_bounded_v1', highWaterMark: NETWORK_LIMITS.inputBytes });
  sshProtocol.on('error', () => {});
  const acceptSocket = (socket, serve) => {
    if (sockets.size >= NETWORK_LIMITS.connections) { socket.destroy(); return; }
    const aborter = new AbortController();
    sockets.set(socket, aborter);
    const lifetime = setTimeout(() => socket.destroy(), NETWORK_LIMITS.sessionLifetimeMs);
    socket.setTimeout(NETWORK_LIMITS.idleTimeoutMs, () => socket.destroy());
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(lifetime); aborter.abort(); sockets.delete(socket); });
    serve(socket, aborter.signal);
  };
  sshProtocol.on('connection', (client) => {
    let token;
    let attempts = 0;
    let requests = 0;
    let sessions = 0;
    let busy = false;
    const aborter = new AbortController();
    client.on('error', () => {});
    client.once('close', () => { token = undefined; aborter.abort(); });
    const deny = (_accept, reject) => {
      reject?.();
      if (++requests > NETWORK_LIMITS.requestsPerConnection) client.end();
    };
    for (const event of ['request', 'tcpip', 'openssh.streamlocal', 'x11']) client.on(event, deny);
    client.on('authentication', async (context) => {
      if (++attempts > 4) { context.reject(); client.end(); return; }
      if (context.method !== 'password' || context.username !== 'dungeonq' || !tokenValid(context.password) || busy) {
        context.reject(['password']); return;
      }
      busy = true;
      let aborted = false;
      context.once('abort', () => { aborted = true; });
      try {
        await boundedDispatch(dispatch, { token: context.password, family: 'ssh', requestId: `auth-${randomUUID()}`, operation: 'snapshot', args: {} }, aborter.signal);
        if (!aborted && !aborter.signal.aborted) { token = context.password; context.accept(); }
      } catch { if (!aborted && !aborter.signal.aborted) context.reject(['password']); }
      finally { busy = false; }
    });
    client.on('session', (accept, reject) => {
      if (!token || sessions >= NETWORK_LIMITS.concurrentSshSessions || ++requests > NETWORK_LIMITS.requestsPerConnection) { reject(); return; }
      const session = accept();
      if (!session) return;
      sessions++;
      let executed = false;
      session.once('close', () => { sessions--; });
      for (const event of ['shell', 'pty', 'env', 'subsystem', 'sftp', 'auth-agent', 'x11', 'signal', 'window-change']) session.on(event, deny);
      session.on('exec', async (acceptExec, rejectExec, info) => {
        if (executed || busy) { rejectExec?.(); return; }
        executed = true;
        const stream = acceptExec?.();
        if (!stream) return;
        stream.on('error', () => {});
        // Commands are complete in the exec request; stdin is never an alternate command path.
        stream.on('data', () => { stream.close(); });
        busy = true;
        try {
          const request = sshEnvelope(info.command);
          const result = await boundedDispatch(dispatch, { token, family: 'ssh', ...request }, aborter.signal);
          if (!stream.destroyed) { stream.write(`${result}\n`); stream.exit(0); stream.end(); }
        } catch (error) {
          if (!stream.destroyed) {
            const details = { code: safeCode(error) };
            if (error?.code === 'DISPATCH_TIMEOUT') details.outcome = 'unknown';
            stream.write(`${JSON.stringify({ ok: false, error: details })}\n`);
            stream.exit(1); stream.end();
          }
          if (error?.code === 'DISPATCH_TIMEOUT') client.end();
        } finally { busy = false; }
      });
    });
  });
  const sshServer = net.createServer({ highWaterMark: NETWORK_LIMITS.inputBytes }, (socket) => acceptSocket(socket, () => sshProtocol.injectSocket(socket)));
  const postgresServer = net.createServer({ highWaterMark: NETWORK_LIMITS.inputBytes }, (socket) => acceptSocket(socket, (sock, signal) => postgresSession(sock, dispatch, signal)));
  let closing;
  const close = () => closing ??= (async () => {
    const closed = [sshServer, postgresServer].map((server) => new Promise((resolve) => {
      if (!server.listening) { resolve(); return; }
      server.close(() => resolve());
    }));
    for (const [socket, aborter] of sockets) { aborter.abort(); socket.destroy(); }
    await Promise.all(closed);
  })();
  try {
    for (const [server, port] of [[sshServer, sshPort], [postgresServer, postgresPort]]) {
      server.listen({ port, host });
      await once(server, 'listening');
      server.on('error', () => { void close(); });
    }
    return { sshPort: sshServer.address().port, postgresPort: postgresServer.address().port, close };
  } catch (error) { await close(); throw error; }
}
