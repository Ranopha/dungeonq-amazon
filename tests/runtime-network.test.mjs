import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import ssh2 from 'ssh2';
import pg from 'pg';
import { NETWORK_LIMITS, NETWORK_SUPPORTED_SUBSET, startNetworkAdapters } from '../runtime/network.mjs';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const disposableToken = 'synthetic-participant-token';
const request = (operation, args = {}, requestId = randomUUID()) => ({ requestId, operation, args });
const query = (value) => `SELECT dungeonq('${JSON.stringify(value).replaceAll("'", "''")}')`;

function syntheticAuthority() {
  const calls = [];
  const state = new Map([['welcome', 'Synthetic welcome']]);
  let revision = 0;
  let revoked = false;
  const tickets = new Map();
  return {
    calls,
    revoke() { revoked = true; },
    async dispatch(value) {
      calls.push(structuredClone(value));
      if (value.token !== disposableToken || revoked) throw Object.assign(new Error('Authority denied token'), { code: 'TOKEN_REJECTED' });
      switch (value.operation) {
        case 'snapshot': return { revision, resources: Object.fromEntries(state) };
        case 'read': return { revision, value: state.get(value.args.key) ?? null };
        case 'write': {
          assert.equal(value.args.expectedRevision, revision);
          state.set(value.args.key, value.args.value);
          return { revision: ++revision };
        }
        case 'issue-ticket': {
          const ticket = `synthetic-ticket-${randomUUID()}`;
          tickets.set(ticket, true);
          return { ticket, revision };
        }
        case 'use-ticket': {
          if (!tickets.delete(value.args.ticket)) throw new Error('Ticket rejected');
          return { revision, value: state.get(value.args.key ?? 'welcome') };
        }
        default: throw new Error('Unexpected test operation');
      }
    },
  };
}

async function start(t, dispatch) {
  const authority = syntheticAuthority();
  const adapter = await startNetworkAdapters({ dispatch: dispatch ?? authority.dispatch, sshHostKey: privateKey });
  t.after(() => adapter.close());
  return { adapter, authority };
}

async function connectSsh(t, port, password = disposableToken) {
  const client = new ssh2.Client();
  client.on('error', () => {});
  t.after(() => client.destroy());
  const ready = once(client, 'ready');
  client.connect({ host: '127.0.0.1', port, username: 'dungeonq', password, readyTimeout: 3_000,
    // Pin the ephemeral server key, rather than silently accepting any host key.
    hostVerifier: (key) => key.equals(ssh2.utils.parseKey(privateKey).getPublicSSH()),
  });
  await ready;
  return client;
}

async function sshExec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) { reject(error); return; }
      const chunks = [];
      stream.on('data', (data) => chunks.push(data));
      stream.on('error', reject);
      stream.on('close', (code) => resolve({ code, result: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
  });
}

async function connectPg(t, port, password = disposableToken) {
  const client = new pg.Client({ host: '127.0.0.1', port, user: 'dungeonq', database: 'dungeonq',
    password, ssl: false, connectionTimeoutMillis: 3_000, query_timeout: 7_000 });
  client.on('error', () => {});
  t.after(() => client.end());
  await client.connect();
  return client;
}

test('actual SSH and PostgreSQL clients share bounded synthetic state and tickets through dispatch', { timeout: 15_000 }, async (t) => {
  const { adapter, authority } = await start(t);
  const ssh = await connectSsh(t, adapter.sshPort);
  const sql = await connectPg(t, adapter.postgresPort);
  assert.equal((await sshExec(ssh, 'snapshot')).result.revision, 0);
  const write = request('write', { key: 'welcome', value: "Synthetic O'Brien", expectedRevision: 0 }, 'cross-surface-write');
  const written = await sql.query(query(write));
  assert.deepEqual(written.rows, [{ result: { revision: 1 } }]);
  assert.deepEqual((await sshExec(ssh, 'read welcome')).result, { revision: 1, value: "Synthetic O'Brien" });
  const issued = await sshExec(ssh, `dq ${JSON.stringify(request('issue-ticket', { scope: ['welcome'], ttlMs: 1000, maxUses: 1 }))}`);
  assert.equal(issued.code, 0);
  const used = await sql.query(query(request('use-ticket', { ticket: issued.result.ticket })));
  assert.equal(used.rows[0].result.value, "Synthetic O'Brien");
  await assert.rejects(sql.query(query(request('use-ticket', { ticket: issued.result.ticket }))), /DISPATCH_DENIED/);
  const mutation = authority.calls.find((item) => item.requestId === 'cross-surface-write');
  assert.deepEqual(mutation, { token: disposableToken, family: 'postgres', ...write });
  const authCalls = authority.calls.filter((item) => item.requestId.startsWith('auth-'));
  assert.equal(authCalls.length, 2);
  assert.equal(new Set(authCalls.map((item) => item.requestId)).size, 2);
  assert.deepEqual(new Set(authCalls.map((item) => item.family)), new Set(['ssh', 'postgres']));
});

test('both real protocol clients reject invalid credentials and recheck revoked tokens', { timeout: 15_000 }, async (t) => {
  const { adapter, authority } = await start(t);
  await assert.rejects(connectSsh(t, adapter.sshPort, 'invalid-synthetic-token'), /authentication/i);
  await assert.rejects(connectPg(t, adapter.postgresPort, 'invalid-synthetic-token'), /authentication/i);
  const ssh = await connectSsh(t, adapter.sshPort);
  const sql = await connectPg(t, adapter.postgresPort);
  authority.revoke();
  assert.deepEqual((await sshExec(ssh, 'snapshot')).result, { ok: false, error: { code: 'DISPATCH_DENIED' } });
  await assert.rejects(sql.query(query(request('snapshot'))), /DISPATCH_DENIED/);
});

test('SSH rejects shell, PTY, forwarding, unknown commands, and injected route fields', { timeout: 15_000 }, async (t) => {
  const { adapter, authority } = await start(t);
  const ssh = await connectSsh(t, adapter.sshPort);
  await assert.rejects(new Promise((resolve, reject) => ssh.shell(false, (error, stream) => error ? reject(error) : resolve(stream))));
  await assert.rejects(new Promise((resolve, reject) => ssh.exec('snapshot', { pty: true }, (error, stream) => error ? reject(error) : resolve(stream))));
  await assert.rejects(new Promise((resolve, reject) => ssh.forwardOut('127.0.0.1', 0, '127.0.0.1', 1, (error, stream) => error ? reject(error) : resolve(stream))));
  assert.equal((await sshExec(ssh, 'unsupported-command')).code, 1);
  assert.equal((await sshExec(ssh, `dq ${JSON.stringify({ ...request('snapshot'), family: 'host', token: 'other' })}`)).code, 1);
  assert.equal(authority.calls.length, 1, 'unsupported requests never enter dispatch');
  assert.equal((await sshExec(ssh, 'snapshot')).code, 0, 'supported exec still works');
});

test('PostgreSQL advertises only the bounded subset and rejects SQL, extra fields, and extended queries', { timeout: 15_000 }, async (t) => {
  const { adapter, authority } = await start(t);
  const sql = await connectPg(t, adapter.postgresPort);
  assert.match(NETWORK_SUPPORTED_SUBSET.postgres, /No SQL execution/);
  await assert.rejects(sql.query('SELECT 1'), /UNSUPPORTED_REQUEST/);
  await assert.rejects(sql.query(query({ ...request('snapshot'), route: 'production' })), /UNSUPPORTED_REQUEST/);
  await assert.rejects(sql.query(query(request('write', { key: 'welcome', value: 'bounded', expectedRevision: -1 }))), /UNSUPPORTED_REQUEST/);
  assert.equal(authority.calls.length, 1);
  assert.equal((await sql.query(query(request('snapshot')))).rows[0].result.revision, 0);
  await assert.rejects(sql.query({ text: 'SELECT $1', values: [1] }), /UNSUPPORTED_PROTOCOL_REQUEST/);
});

test('oversized or incomplete PostgreSQL frames are bounded and close without dispatch', { timeout: 10_000 }, async (t) => {
  const { adapter, authority } = await start(t);
  const socket = net.connect(adapter.postgresPort, '127.0.0.1');
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const closed = once(socket, 'close');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(NETWORK_LIMITS.inputBytes + 1);
  socket.write(header);
  await closed;
  assert.equal(authority.calls.length, 0);
  const sql = await connectPg(t, adapter.postgresPort);
  assert.equal((await sql.query(query(request('snapshot')))).rows.length, 1);
});

test('actual PostgreSQL client tolerates fragmented transport writes', { timeout: 10_000 }, async (t) => {
  const { adapter } = await start(t);
  const socket = new net.Socket();
  const originalWrite = socket.write.bind(socket);
  let fragmentedFrames = 0;
  // Split every client frame, including startup/password/query, into separate writes.
  const fragmentWrite = (chunk, encoding, callback) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
    if (data.length < 2) return originalWrite(chunk, encoding, callback);
    fragmentedFrames++;
    const accepted = originalWrite(data.subarray(0, 2));
    setTimeout(() => originalWrite(data.subarray(2), typeof encoding === 'function' ? encoding : callback), 5);
    return accepted;
  };
  socket.once('connect', () => { socket.write = fragmentWrite; });
  const sql = new pg.Client({ host: '127.0.0.1', port: adapter.postgresPort, user: 'dungeonq', database: 'dungeonq',
    password: disposableToken, stream: socket, ssl: false, connectionTimeoutMillis: 3_000 });
  sql.on('error', () => {});
  t.after(() => sql.end());
  await sql.connect();
  assert.equal((await sql.query(query(request('snapshot')))).rows[0].result.revision, 0);
  assert.ok(fragmentedFrames >= 3, 'startup, password, and query must actually be fragmented');
});

test('connection and PostgreSQL request budgets reject excess work and recover after close', { timeout: 15_000 }, async (t) => {
  const { adapter, authority } = await start(t);
  const sockets = [];
  for (let i = 0; i < NETWORK_LIMITS.connections; i++) {
    const socket = net.connect(adapter.postgresPort, '127.0.0.1');
    socket.on('error', () => {});
    sockets.push(socket);
    t.after(() => socket.destroy());
    await once(socket, 'connect');
  }
  const excess = net.connect(adapter.postgresPort, '127.0.0.1');
  excess.on('error', () => {});
  await once(excess, 'close');
  assert.equal(authority.calls.length, 0);
  await Promise.all(sockets.map((socket) => {
    const closed = once(socket, 'close');
    socket.destroy();
    return closed;
  }));
  const sql = await connectPg(t, adapter.postgresPort);
  // Startup and password each consume one frame from the connection budget.
  for (let i = 0; i < NETWORK_LIMITS.requestsPerConnection - 2; i++) {
    await sql.query(query(request('snapshot')));
  }
  await assert.rejects(sql.query(query(request('snapshot'))), /UNSUPPORTED_PROTOCOL_REQUEST/);
  const fresh = await connectPg(t, adapter.postgresPort);
  assert.equal((await fresh.query(query(request('snapshot')))).rows.length, 1);
});

test('invalid dispatch results never authenticate and oversized output is bounded', { timeout: 10_000 }, async (t) => {
  const rejected = await start(t, async () => ({ error: false }));
  await assert.rejects(connectPg(t, rejected.adapter.postgresPort), /authentication/i);
  await assert.rejects(connectSsh(t, rejected.adapter.sshPort), /authentication/i);
  const { adapter } = await start(t, async ({ operation }) => operation === 'snapshot'
    ? { revision: 0 } : { value: 'x'.repeat(NETWORK_LIMITS.outputBytes) });
  const sql = await connectPg(t, adapter.postgresPort);
  await assert.rejects(sql.query(query(request('read', { key: 'welcome' }))), /RESPONSE_LIMIT/);
});

test('dispatch timeout returns unknown-outcome failures over both protocols', { timeout: 12_000 }, async (t) => {
  const mutations = [];
  const { adapter } = await start(t, async (value) => {
    if (value.operation === 'snapshot') return { revision: 0 };
    mutations.push(value);
    return new Promise(() => {});
  });
  const sql = await connectPg(t, adapter.postgresPort);
  const ssh = await connectSsh(t, adapter.sshPort);
  const change = request('write', { key: 'welcome', value: 'synthetic', expectedRevision: 0 }, 'retry-same-id');
  const [sshResponse] = await Promise.all([
    sshExec(ssh, `dq ${JSON.stringify(change)}`),
    assert.rejects(sql.query(query(change)), /DISPATCH_TIMEOUT_OUTCOME_UNKNOWN/),
  ]);
  assert.deepEqual(sshResponse.result, { ok: false, error: { code: 'DISPATCH_TIMEOUT', outcome: 'unknown' } });
  assert.equal(mutations.length, 2);
  assert.ok(mutations.every((value) => value.requestId === 'retry-same-id'));
});

test('close is idempotent, disconnects active clients, and releases both listening ports', { timeout: 10_000 }, async (t) => {
  const { adapter } = await start(t);
  const ssh = await connectSsh(t, adapter.sshPort);
  const sql = await connectPg(t, adapter.postgresPort);
  const sshClosed = once(ssh, 'close');
  // A server shutdown can emit an expected pg error before end.
  const pgEnded = new Promise((resolve) => sql.once('end', resolve));
  await adapter.close();
  await Promise.all([sshClosed, pgEnded, adapter.close()]);
  for (const port of [adapter.sshPort, adapter.postgresPort]) {
    const server = net.createServer();
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rejects external bind, missing host key, and cleans up partial startup', { timeout: 10_000 }, async (t) => {
  await assert.rejects(startNetworkAdapters({ dispatch: async () => ({}), host: '0.0.0.0', sshHostKey: privateKey }), /LOOPBACK/);
  await assert.rejects(startNetworkAdapters({ dispatch: async () => ({}) }), /SSH_HOST_KEY_REQUIRED/);
  const occupied = net.createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  await assert.rejects(startNetworkAdapters({ dispatch: async () => ({}), sshHostKey: privateKey, postgresPort: occupied.address().port }), { code: 'EADDRINUSE' });
});
