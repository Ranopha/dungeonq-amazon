import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorldLab } from '../server/world-lab.mjs';
import { replayWorld } from '../world/kernel.mjs';

const pack = JSON.parse(await readFile(new URL('../world/packs/clockwork-archive.json', import.meta.url), 'utf8'));
const envelope = revision => ({ requestId: `http_${revision}`, expectedRevision: revision, command: { type: 'inspect' } });
async function setup(t, customPack = pack) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dungeonq-world-http-'));
  const lab = await startWorldLab({ dataDir, pack: customPack });
  t.after(async () => { await lab.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { lab, dataDir };
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
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('test request timeout')));
    req.end(data);
  });
}
async function eventually(check, timeout = 8000) {
  const until = Date.now() + timeout;
  do { try { const value = await check(); if (value) return value; } catch {} await delay(30); } while (Date.now() < until);
  throw new Error('bounded observation timeout');
}

test('HTTP Actor／Observer 實際分離程序及 bearer 能力，拒絕錯誤來源與非允許路徑', async t => {
  const { lab } = await setup(t);
  assert.notEqual(lab.observerProcessId, process.pid);
  assert.notEqual(lab.actorToken, lab.observerToken);
  assert.notEqual(lab.actorUrl, lab.observerUrl);
  assert.equal((await call(lab.actorUrl, '/api/world')).status, 401);
  assert.equal((await call(lab.actorUrl, '/api/world', { token: lab.observerToken })).status, 401);
  assert.equal((await call(lab.observerUrl, '/api/observer', { token: lab.actorToken })).status, 401);
  assert.equal((await call(lab.observerUrl, '/api/world/command', { token: lab.observerToken, body: envelope(0) })).status, 404);
  assert.equal((await call(lab.actorUrl, '/api/evidence', { token: lab.actorToken })).status, 404);
  assert.equal((await call(lab.actorUrl, '/api/world', { token: lab.actorToken, headers: { host: 'localhost:1' } })).status, 403);
  assert.equal((await call(lab.actorUrl, '/api/world', { token: lab.actorToken, headers: { origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await call(lab.actorUrl, '/api/world', { token: lab.actorToken, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await call(lab.actorUrl, '/server/world-store.mjs')).status, 404);
  assert.equal((await call(lab.actorUrl, '/observer.html')).status, 404);
  const current = await call(lab.actorUrl, '/api/world', { token: lab.actorToken });
  assert.equal(current.status, 200); assert.ok(current.headers['content-security-policy']);
  assert.equal(current.headers['access-control-allow-origin'], undefined);
  assert.equal(current.value.revision, 0);
  for (const key of ['pack', 'event', 'events', 'observerToken', 'summary', 'requirements']) assert.equal(Object.hasOwn(current.value, key), false);
  assert.ok(current.value.choices.every(choice => Object.keys(choice).sort().join(',') === 'id,label'));
});

test('HTTP body／revision／防重送，Actor 不洩露完整事件且 Observer 可離線重播', async t => {
  const { lab } = await setup(t);
  const options = { token: lab.actorToken };
  const tooLarge = await call(lab.actorUrl, '/api/world/command', { ...options, body: ' '.repeat(16_385) });
  assert.equal(tooLarge.status, 413);
  assert.equal((await call(lab.actorUrl, '/api/world/command', { ...options, body: '{}' , headers: { 'content-type': 'text/plain' } })).status, 400);
  assert.equal((await call(lab.actorUrl, '/api/world/command', { ...options, body: '{' })).status, 400);
  assert.equal((await call(lab.actorUrl, '/api/world/command', { ...options, body: { ...envelope(0), extra: true } })).status, 400);
  const first = await call(lab.actorUrl, '/api/world/command', { ...options, body: envelope(0) });
  assert.equal(first.status, 200); assert.deepEqual(Object.keys(first.value).sort(), ['replayed', 'view']);
  assert.equal(first.value.view.revision, 1);
  const replay = await call(lab.actorUrl, '/api/world/command', { ...options, body: envelope(0) });
  assert.equal(replay.value.replayed, true); assert.equal(replay.value.view.revision, 1);
  assert.equal((await call(lab.actorUrl, '/api/world/command', { ...options, body: { ...envelope(0), requestId: 'stale-http' } })).status, 409);
  await eventually(async () => (await call(lab.observerUrl, '/api/observer', { token: lab.observerToken })).value.events?.length === 1);
  const observation = (await call(lab.observerUrl, '/api/observer', { token: lab.observerToken })).value;
  assert.equal(observation.verification.valid, true); assert.equal(observation.lag, 0);
  const bundle = (await call(lab.observerUrl, '/api/evidence', { token: lab.observerToken })).value;
  assert.equal(replayWorld(bundle).eventCount, 1);
});

test('完整 lab 重啟保留世界／journal並輪換兩個 token', async t => {
  const { lab, dataDir } = await setup(t);
  await call(lab.actorUrl, '/api/world/command', { token: lab.actorToken, body: envelope(0) });
  await lab.close();
  const restored = await startWorldLab({ dataDir, pack }); t.after(() => restored.close());
  assert.equal(restored.worldId, lab.worldId); assert.notEqual(restored.actorToken, lab.actorToken);
  assert.notEqual(restored.observerToken, lab.observerToken);
  const replay = await call(restored.actorUrl, '/api/world/command', { token: restored.actorToken, body: envelope(0) });
  assert.equal(replay.value.replayed, true); assert.equal(replay.value.view.revision, 1);
  await eventually(async () => (await call(restored.observerUrl, '/api/observer', { token: restored.observerToken })).value.events?.length === 1);
});

test('Observer 暫停時64筆積壓阻擋新改變，程序被殺後自動恢復及去重補送', { skip: process.platform === 'win32' }, async t => {
  const { lab } = await setup(t, { ...pack, maxSteps: 100 });
  const firstPid = lab.observerProcessId;
  process.kill(firstPid, 'SIGSTOP');
  for (let revision = 0; revision < 64; revision++) {
    const response = await call(lab.actorUrl, '/api/world/command', { token: lab.actorToken, body: envelope(revision) });
    assert.equal(response.status, 200); assert.equal(response.value.view.revision, revision + 1);
  }
  const full = await call(lab.actorUrl, '/api/world/command', { token: lab.actorToken, body: envelope(64) });
  assert.equal(full.status, 503); assert.equal(full.value.error, 'OBSERVER_BACKLOG_FULL');
  const snapshot = await call(lab.actorUrl, '/api/world', { token: lab.actorToken }); assert.equal(snapshot.value.revision, 64);
  process.kill(firstPid, 'SIGKILL');
  await eventually(() => lab.observerProcessId !== firstPid);
  const recovered = await eventually(async () => {
    const value = (await call(lab.observerUrl, '/api/observer', { token: lab.observerToken })).value;
    return value.events?.length === 64 && value.lag === 0 && value;
  });
  assert.equal(recovered.verification.eventCount, 64); assert.equal(new Set(recovered.events.map(event => event.digest)).size, 64);
  const next = await call(lab.actorUrl, '/api/world/command', { token: lab.actorToken, body: envelope(64) });
  assert.equal(next.status, 200); assert.equal(next.value.view.revision, 65);
  await eventually(async () => (await call(lab.observerUrl, '/api/observer', { token: lab.observerToken })).value.events?.length === 65);
});
