import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startStudyLab } from '../server/study-lab.mjs';
import { replayStudy } from '../study/experiment.mjs';

const design = { schemaVersion: 'dungeonq.study-design/v1', title: '合成HTTP研究驗收', seed: 17, trainingRounds: 2, probeBudget: 1,
  labels: { signalOn: '琥珀光', signalOff: '無光', structureOn: '三角紋', structureOff: '圓紋' } };
const options = { design, arm: 'CORRELATED', rule: 'structure' };
const consent = { type: 'consent', accepted: true, participantMode: 'UI_CHECK' };
const envelope = (revision, command) => ({ requestId: `http_${revision}`, expectedRevision: revision, command });
async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'dungeonq-study-http-')); const labs = [];
  t.after(async () => { for (const lab of labs) await lab.close(); await rm(dataDir, { recursive: true, force: true }); });
  const lab = await startStudyLab({ dataDir, ...options }); labs.push(lab); return { lab, labs, dataDir };
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
  throw new Error('bounded study observation timeout');
}

test('Study 三個入口／token分離，未結束真值不從Actor取得，舊路徑與錯誤來源拒絕', async t => {
  const { lab } = await setup(t);
  assert.notEqual(lab.observerProcessId, process.pid); assert.equal(new Set([lab.actorToken, lab.observerToken, lab.mcpToken]).size, 3);
  assert.equal((await call(lab.actorUrl, '/api/study')).status, 401);
  assert.equal((await call(lab.actorUrl, '/api/study', { token: lab.observerToken })).status, 401);
  assert.equal((await call(lab.actorUrl, '/api/study', { token: lab.mcpToken })).status, 401);
  assert.equal((await call(lab.observerUrl, '/api/observer', { token: lab.actorToken })).status, 401);
  assert.equal((await call(lab.observerUrl, '/api/study/command', { token: lab.observerToken, body: envelope(0, consent) })).status, 404);
  assert.equal((await call(lab.actorUrl, '/api/evidence', { token: lab.actorToken })).status, 404);
  assert.equal((await call(lab.actorUrl, '/api/world/command', { token: lab.actorToken, body: envelope(0, consent) })).status, 404);
  assert.equal((await call(lab.actorUrl, '/observer.html')).status, 404);
  assert.equal((await call(lab.actorUrl, '/server/study-store.mjs')).status, 404);
  const input = { token: lab.actorToken };
  assert.equal((await call(lab.actorUrl, '/api/study', { ...input, headers: { host: 'localhost:1' } })).status, 403);
  assert.equal((await call(lab.actorUrl, '/api/study', { ...input, headers: { origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await call(lab.actorUrl, '/api/study', { ...input, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const initial = await call(lab.actorUrl, '/api/study', input);
  assert.equal(initial.status, 200); assert.equal(initial.value.phase, 'CONSENT'); assert.equal(initial.value.debrief, null);
  assert.deepEqual(initial.value.choices, []); assert.ok(initial.headers['content-security-policy']);
  assert.equal(initial.headers['access-control-allow-origin'], undefined);
  for (const hidden of ['arm', 'rule', 'nonce', 'design', 'world', 'events', 'summary', 'observerToken']) assert.equal(Object.hasOwn(initial.value, hidden), false);
  const mcpUrl = new URL(lab.mcpEndpoint);
  assert.equal((await call(mcpUrl.origin, '/mcp', { token: lab.actorToken, body: {} })).status, 401);
  assert.equal((await call(mcpUrl.origin, '/mcp', { token: lab.observerToken, body: {} })).status, 401);
});

test('HTTP 驗證體積與必經流程，重送不重算，結果由獨立Observer保存與核驗', async t => {
  const { lab } = await setup(t); const auth = { token: lab.actorToken };
  assert.equal((await call(lab.actorUrl, '/api/study/command', { ...auth, body: ' '.repeat(8193) })).status, 413);
  assert.equal((await call(lab.actorUrl, '/api/study/command', { ...auth, body: '{}', headers: { 'content-type': 'text/plain' } })).status, 400);
  assert.equal((await call(lab.actorUrl, '/api/study/command', { ...auth, body: '{' })).status, 400);
  const skipped = await call(lab.actorUrl, '/api/study/command', { ...auth, body: envelope(0, { type: 'act' }) });
  assert.equal(skipped.value.error, 'STUDY_PHASE_INVALID');
  const first = await call(lab.actorUrl, '/api/study/command', { ...auth, body: envelope(0, consent) });
  assert.equal(first.status, 200); assert.deepEqual(Object.keys(first.value).sort(), ['replayed', 'view']);
  assert.equal((await call(lab.actorUrl, '/api/study/command', { ...auth, body: envelope(0, consent) })).value.replayed, true);
  const prediction = { type: 'predict', choiceId: first.value.view.choices[0].id, predictedSuccess: null,
    hypothesis: 'unknown', confidence: null, suspicion: null };
  const predicted = await call(lab.actorUrl, '/api/study/command', { ...auth, body: envelope(1, prediction) });
  assert.equal(predicted.value.view.phase, 'ACT'); assert.equal(predicted.value.view.lastResult, null);
  assert.deepEqual(predicted.value.view.pendingPrediction, prediction);
  const acted = await call(lab.actorUrl, '/api/study/command', { ...auth, body: envelope(2, { type: 'act' }) });
  assert.equal(acted.value.view.phase, 'REFLECT'); assert.equal(acted.value.view.debrief, null); assert.ok(acted.value.view.lastResult);
  await eventually(async () => (await call(lab.observerUrl, '/api/observer', { token: lab.observerToken })).value.events?.length === 3);
  const bundle = (await call(lab.observerUrl, '/api/evidence', { token: lab.observerToken })).value;
  const verified = replayStudy(bundle); assert.equal(verified.eventCount, 3);
  assert.equal(verified.summary.predictions[0].sequence, 2); assert.equal(verified.summary.predictions[0].outcomeSequence, 3);
  assert.equal(verified.summary.predictions[0].confidence, null);
});

test('完整lab重啟保留指派與事前預測，三個token輪換', async t => {
  const { lab, labs, dataDir } = await setup(t);
  const first = await call(lab.actorUrl, '/api/study/command', { token: lab.actorToken, body: envelope(0, consent) });
  await lab.close(); const restored = await startStudyLab({ dataDir, ...options }); labs.push(restored);
  assert.equal(restored.worldId, lab.worldId);
  for (const key of ['actorToken', 'observerToken', 'mcpToken']) assert.notEqual(restored[key], lab[key]);
  const retry = await call(restored.actorUrl, '/api/study/command', { token: restored.actorToken, body: envelope(0, consent) });
  assert.deepEqual(retry.value, { ...first.value, replayed: true });
  assert.equal((await call(restored.actorUrl, '/api/study', { token: lab.actorToken })).status, 401);
  await eventually(async () => (await call(restored.observerUrl, '/api/observer', { token: restored.observerToken })).value.events?.length === 1);
});

test('Observer暫停仍能退出；真實程序終止後恢復補送，退出後不再act', { skip: process.platform === 'win32' }, async t => {
  const { lab } = await setup(t); const oldPid = lab.observerProcessId; process.kill(oldPid, 'SIGSTOP');
  await call(lab.actorUrl, '/api/study/command', { token: lab.actorToken, body: envelope(0, consent) });
  const withdrawn = await call(lab.actorUrl, '/api/study/command', { token: lab.actorToken, body: envelope(1, { type: 'withdraw' }) });
  assert.equal(withdrawn.status, 200); assert.equal(withdrawn.value.view.phase, 'WITHDRAWN'); assert.ok(withdrawn.value.view.debrief);
  assert.equal((await call(lab.actorUrl, '/api/study/command', { token: lab.actorToken, body: envelope(2, { type: 'act' }) })).value.error, 'STUDY_FINISHED');
  process.kill(oldPid, 'SIGKILL'); await eventually(() => lab.observerProcessId !== oldPid);
  const observation = await eventually(async () => {
    const value = (await call(lab.observerUrl, '/api/observer', { token: lab.observerToken })).value;
    return value.events?.length === 2 && value.lag === 0 && value;
  });
  assert.equal(observation.verification.valid, true); assert.equal(observation.summary.phase, 'WITHDRAWN');
  assert.equal(new Set(observation.events.map(event => event.digest)).size, 2);
});
