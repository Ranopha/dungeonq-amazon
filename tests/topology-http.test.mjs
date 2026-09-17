import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat, chmod, writeFile, lstat } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startTopologyLab } from '../server/topology-lab.mjs';
import { replayTopology } from '../world/topology.mjs';

const options = { seed: 19, arm: 'TREATMENT', participantMode: 'UI_CHECK' };
const envelope = (revision, command) => ({ requestId: `http_${revision}`, expectedRevision: revision, command });
async function setup(t, extra = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dungeonq-topology-http-')); const labs = [];
  t.after(async () => { for (const lab of labs) await lab.close(); await rm(dataDir, { recursive: true, force: true }); });
  const lab = await startTopologyLab({ dataDir, ...options, ...extra }); labs.push(lab); return { lab, labs, dataDir };
}
function call(base, path, { token, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = request(`${base}${path}`, { method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data !== null ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers,
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let value; try { value = JSON.parse(text); } catch { value = text; }
        resolve({ status: res.statusCode, headers: res.headers, value });
      });
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('test request timeout'))); req.end(data);
  });
}
async function eventually(check, timeout = 8000) {
  const until = Date.now() + timeout;
  do { try { const value = await check(); if (value) return value; } catch {} await delay(30); } while (Date.now() < until);
  throw new Error('bounded topology observation timeout');
}

test('three scoped origins enforce exact auth, Host, Origin, body limits and no evaluator routes', async t => {
  const { lab } = await setup(t); assert.notEqual(lab.observerProcessId, process.pid);
  assert.equal(new Set([lab.actorToken, lab.observerToken, lab.mcpToken]).size, 3);
  for (const token of [undefined, lab.observerToken, lab.mcpToken]) assert.equal((await call(lab.actorUrl, '/api/topology', { token })).status, 401);
  assert.equal((await call(lab.observerUrl, '/api/observer', { token: lab.actorToken })).status, 401);
  const auth = { token: lab.actorToken }; const initial = await call(lab.actorUrl, '/api/topology', auth);
  assert.equal(initial.status, 200); assert.equal(initial.value.goal.achieved, null); assert.ok(initial.headers['content-security-policy']);
  for (const field of ['arm', 'participantMode', 'events', 'evaluatorGraph', 'world', 'observerToken']) assert.equal(Object.hasOwn(initial.value, field), false);
  for (const path of ['/api/evidence', '/api/observer', '/api/study', '/api/world', '/server/topology-store.mjs', '/observer.html'])
    assert.equal((await call(lab.actorUrl, path, auth)).status, 404);
  assert.equal((await call(lab.observerUrl, '/api/topology/command', { token: lab.observerToken, body: {} })).status, 404);
  assert.equal((await call(lab.actorUrl, '/api/topology', { ...auth, headers: { host: 'localhost:1' } })).status, 403);
  assert.equal((await call(lab.actorUrl, '/api/topology', { ...auth, headers: { origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await call(lab.actorUrl, '/api/topology', { ...auth, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await call(lab.actorUrl, '/api/topology/command', { ...auth, body: ' '.repeat(8193) })).status, 413);
  assert.equal((await call(lab.actorUrl, '/api/topology/command', { ...auth, body: '{' })).status, 400);
  assert.equal((await call(lab.actorUrl, '/api/topology/command', { ...auth, body: '{}', headers: { 'content-type': 'text/plain' } })).status, 400);
  assert.equal(initial.headers['access-control-allow-origin'], undefined);
});

test('HTTP success persists across restart, assignment and participant provenance cannot drift, tokens rotate', async t => {
  const { lab, labs, dataDir } = await setup(t);
  const input = envelope(0, { type: 'act', actionId: 'annotate-atlas' });
  const first = await call(lab.actorUrl, '/api/topology/command', { token: lab.actorToken, body: input });
  assert.equal(first.status, 200); assert.deepEqual(Object.keys(first.value).sort(), ['replayed', 'view']);
  assert.equal(first.value.view.lastResult.outcome, 'SUCCESS');
  await lab.close();
  const metadata = JSON.parse(await readFile(join(dataDir, 'topology-installation.json'), 'utf8'));
  assert.equal(metadata.participantMode, 'UI_CHECK'); assert.equal((await stat(join(dataDir, 'topology-installation.json'))).mode & 0o777, 0o600);
  for (const override of [{ seed: 23 }, { arm: 'CONTROL' }, { participantMode: 'CODEX_PILOT' }])
    await assert.rejects(startTopologyLab({ dataDir, ...override }), /INSTALLATION_ASSIGNMENT_MISMATCH/);
  const restored = await startTopologyLab({ dataDir }); labs.push(restored); assert.equal(restored.worldId, lab.worldId);
  for (const key of ['actorToken', 'observerToken', 'mcpToken']) assert.notEqual(restored[key], lab[key]);
  const retry = await call(restored.actorUrl, '/api/topology/command', { token: restored.actorToken, body: input });
  assert.deepEqual(retry.value, { ...first.value, replayed: true });
  await eventually(async () => (await call(restored.observerUrl, '/api/observer', { token: restored.observerToken })).value.events?.length === 1);
  const bundle = (await call(restored.observerUrl, '/api/evidence', { token: restored.observerToken })).value;
  assert.equal(replayTopology(bundle).summary.participantMode, 'UI_CHECK'); assert.equal(bundle.arm, 'TREATMENT');
  assert.equal(JSON.stringify(bundle).includes(restored.actorToken), false);
});

test('paused child causes real bounded backlog; reserved withdrawal survives child death and redelivery', { skip: process.platform === 'win32' }, async t => {
  const { lab } = await setup(t, { maxPending: 1 }); const pid = lab.observerProcessId; process.kill(pid, 'SIGSTOP');
  const auth = { token: lab.actorToken };
  assert.equal((await call(lab.actorUrl, '/api/topology/command', { ...auth, body: envelope(0, { type: 'act', actionId: 'annotate-atlas' }) })).status, 200);
  assert.equal((await call(lab.actorUrl, '/api/topology/command', { ...auth, body: envelope(1, { type: 'finish' }) })).value.error, 'OBSERVER_BACKLOG_FULL');
  assert.equal((await call(lab.actorUrl, '/api/topology/command', { ...auth, body: envelope(1, { type: 'withdraw' }) })).value.view.phase, 'WITHDRAWN');
  process.kill(pid, 'SIGKILL'); await eventually(() => lab.observerProcessId !== pid);
  const observer = await eventually(async () => { const result = (await call(lab.observerUrl, '/api/observer', { token: lab.observerToken })).value;
    return result.events?.length === 2 && result.lag === 0 && result; });
  assert.equal(observer.verification.valid, true); assert.equal(new Set(observer.events.map(event => event.digest)).size, 2);
  assert.equal((await call(lab.actorUrl, '/api/topology/command', { ...auth, body: envelope(2, { type: 'visit', sceneId: 'layout' }) })).value.error, 'TOPOLOGY_FINISHED');
});

test('invalid ports do not create an installation, and unsafe or orphaned metadata fails closed', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'topology-admission-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  for (const port of [-1, 65536, 1.5]) await assert.rejects(startTopologyLab({ dataDir, actorPort: port }), /PORT_INVALID/);
  await assert.rejects(lstat(join(dataDir, 'topology-installation.json')), { code: 'ENOENT' });
  await writeFile(join(dataDir, 'topology.sqlite'), '', { mode: 0o600 });
  await assert.rejects(startTopologyLab({ dataDir }), /INSTALLATION_INCOMPLETE/);
  await assert.rejects(lstat(join(dataDir, 'topology-installation.json')), { code: 'ENOENT' });
  await chmod(dataDir, 0o755); await assert.rejects(startTopologyLab({ dataDir }), /STORAGE_NOT_PRIVATE/);
});

