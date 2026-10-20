import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ssh2 from 'ssh2';
import pg from 'pg';
import { startNetworkAdapters } from '../runtime/network.mjs';
import { startHostBroker } from '../runtime/host.mjs';
import { openRuntimeReference } from '../runtime/reference.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const token = 'synthetic-ingress-token';
const request = { requestId: 'read-a', operation: 'read', args: { key: 'welcome' } };
const query = value => `SELECT dungeonq('${JSON.stringify(value)}')`;
function hooks() {
  const rows = []; const dispatched = [];
  return {
    rows, dispatched,
    before(input) {
      const row = { ...input, completions: [] }; rows.push(row);
      const scope = { finish(value = {}) { row.completions.push(value); } }; row.scope = scope; return scope;
    },
    async dispatch(input) {
      assert.ok(rows.some(row => row.scope === input.pitchScope), 'the original ingress scope reaches dispatch');
      dispatched.push(input); return { revision: 0, value: 'Synthetic content' };
    },
  };
}
async function sshClient(t, port, password = token, hostKey = privateKey) {
  const client = new ssh2.Client(); client.on('error', () => {}); t.after(() => client.destroy());
  const ready = once(client, 'ready'); client.connect({ host: '127.0.0.1', port, username: 'dungeonq', password,
    hostVerifier: key => key.equals(ssh2.utils.parseKey(hostKey).getPublicSSH()) }); await ready; return client;
}
const exec = (client, command) => new Promise((resolve, reject) => client.exec(command, (error, stream) => {
  if (error) return reject(error); const chunks = []; stream.on('data', chunk => chunks.push(chunk));
  stream.on('error', reject); stream.on('close', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
}));
async function pgClient(t, port, password = token) {
  const client = new pg.Client({ host: '127.0.0.1', port, user: 'dungeonq', database: 'dungeonq', password, ssl: false });
  client.on('error', () => {}); t.after(() => client.end()); await client.connect(); return client;
}
async function hostMessage(path, parts) {
  const socket = net.connect(path); socket.on('error', () => {}); await once(socket, 'connect');
  const chunks = []; socket.on('data', data => chunks.push(data));
  const ended = once(socket, 'end'); for (const part of parts) socket.write(part);
  await ended; socket.destroy(); return JSON.parse(Buffer.concat(chunks).toString());
}

test('SSH and PostgreSQL count authentication and malformed typed operations exactly once', { timeout: 15000 }, async t => {
  const h = hooks(); const adapter = await startNetworkAdapters({ ...h, sshHostKey: privateKey }); t.after(() => adapter.close());
  const ssh = await sshClient(t, adapter.sshPort); const sql = await pgClient(t, adapter.postgresPort);
  assert.equal(h.rows.length, 2); assert.equal(h.dispatched.length, 2);
  assert.ok(h.rows.every(row => row.token === token && row.completions.length === 1));
  const wrongSsh = await exec(ssh, 'dq {"requestId":"bad","operation":"snapshot","args":{"scope":"forged"}}');
  assert.equal(wrongSsh.error.code, 'UNSUPPORTED_REQUEST');
  await assert.rejects(sql.query('SELECT 1'), /UNSUPPORTED_REQUEST/);
  assert.equal(h.rows.length, 4); assert.equal(h.dispatched.length, 2, 'malformed operations are counted without dispatch');
  assert.ok(h.rows.slice(2).every(row => row.completions[0].status === 400 && row.completions[0].error.code === 'UNSUPPORTED_REQUEST'));
  await exec(ssh, `dq ${JSON.stringify(request)}`); await sql.query(query(request));
  assert.equal(h.rows.length, 6); assert.equal(h.dispatched.length, 4);
  assert.ok(h.rows.every(row => row.completions.length === 1));
});

test('ingress budget rejection prevents dispatch while protocol failures stay bounded', { timeout: 15000 }, async t => {
  const h = hooks(); let rejectIngress = false;
  const adapter = await startNetworkAdapters({ sshHostKey: privateKey, dispatch: h.dispatch,
    before(input) { if (rejectIngress) throw Object.assign(new Error('bounded'), { code: 'PITCH_GLOBAL_TOTAL' }); return h.before(input); } });
  t.after(() => adapter.close()); const ssh = await sshClient(t, adapter.sshPort); const sql = await pgClient(t, adapter.postgresPort);
  rejectIngress = true;
  assert.equal((await exec(ssh, 'snapshot')).error.code, 'DISPATCH_DENIED');
  await assert.rejects(sql.query(query(request)), /DISPATCH_DENIED/);
  assert.equal(h.dispatched.length, 2, 'only the two original authentication snapshots reached dispatch');
});

test('host broker counts malformed JSON globally, typed rejections by token, and fragmented frames once', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pitch-ingress-')); const h = hooks();
  const broker = await startHostBroker({ socketPath: join(directory, 'host.sock'), ...h });
  t.after(async () => { await broker.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal((await hostMessage(broker.socketPath, ['{not-json}\n'])).error.code, 'BROKER_REJECTED');
  assert.equal(h.rows[0].token, undefined); assert.equal(h.rows[0].family, 'host'); assert.equal(h.rows[0].completions[0].status, 400);
  await hostMessage(broker.socketPath, [JSON.stringify({ token, ...request, worldId: 'forged' }) + '\n']);
  assert.equal(h.rows[1].token, token); assert.equal(h.rows[1].completions[0].status, 400); assert.equal(h.dispatched.length, 0);
  const wire = JSON.stringify({ token, ...request });
  assert.equal((await hostMessage(broker.socketPath, [wire.slice(0, 8), wire.slice(8), '\n'])).result.value, 'Synthetic content');
  assert.equal(h.rows.length, 3); assert.equal(h.dispatched.length, 1); assert.equal(h.rows[2].completions.length, 1);
});

test('host broker without a hook retains legacy envelope and framing errors', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pitch-ingress-')); const calls = [];
  const broker = await startHostBroker({ socketPath: join(directory, 'host.sock'), dispatch: async input => { calls.push(input); return { revision: 0 }; } });
  t.after(async () => { await broker.close(); rmSync(directory, { recursive: true, force: true }); });
  const wire = JSON.stringify({ token, ...request });
  assert.deepEqual((await hostMessage(broker.socketPath, [wire + '\n'])).result, { revision: 0 });
  assert.deepEqual(calls[0], { token, ...request, family: 'host' });
  assert.equal((await hostMessage(broker.socketPath, ['bad\nextra'])).error.code, 'BROKER_MESSAGE_INVALID');
});

test('real SSH, PostgreSQL and host ingress bind only authenticated contexts in the durable control ledger', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pitch-ingress-reference-'));
  const reference = await openRuntimeReference({ directory, presentation: 'pitching-v1' });
  t.after(async () => { await reference.close(); rmSync(directory, { recursive: true, force: true }); });
  const hostKey = JSON.parse(readFileSync(join(directory, 'ssh-host.json'), 'utf8')).key;
  const ssh = await sshClient(t, reference.protocols.sshPort, reference.credentials.actor, hostKey);
  const sql = await pgClient(t, reference.protocols.postgresPort, reference.credentials.actor);
  assert.equal(reference.status().pitching.global.attempts, 2, 'each authentication snapshot counts once');
  await exec(ssh, 'not-a-supported-command'); await assert.rejects(sql.query('SELECT 1'), /UNSUPPORTED_REQUEST/);
  await hostMessage(reference.brokerPath, ['{invalid}\n']);
  await hostMessage(reference.brokerPath, [JSON.stringify({ token: reference.credentials.actor, ...request, worldId: 'forged' }) + '\n']);
  const served = await hostMessage(reference.brokerPath, [JSON.stringify({ token: reference.credentials.actor, ...request }) + '\n']);
  assert.equal(served.result.key, 'welcome');
  const control = reference.status().pitching;
  assert.equal(control.global.attempts, 7); assert.equal(control.global.errors, 4);
  assert.equal(control.contexts.length, 1); assert.equal(control.contexts[0].contextId, 'diverted');
  assert.equal(control.contexts[0].budget.attempts, 6, 'unparseable input consumes only the global budget');
  assert.equal(control.activeLeases.length, 0); assert.equal(control.incidents.length, 1);
});
