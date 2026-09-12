import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { readFile, rm } from 'node:fs/promises';
import { openAmazonLab } from '../server/amazon-lab.mjs';
import { createMcpTools, startMcpServer } from '../server/mcp.mjs';
import { createAssistantBridge } from '../server/assistant-bridge.mjs';
import { startWorkbench } from '../server/workbench.mjs';

async function setup(t) {
  const scenario = await readFile(new URL('../assistant/scenarios/after-hours.json', import.meta.url), 'utf8');
  let lab = await openAmazonLab({ scenario });
  const directory = lab.directory;
  const mcp = await startMcpServer({ tools: createMcpTools({ execution: lab.core.execution, workerToken: lab.workerToken }), accessToken: lab.accessToken });
  const bridge = await createAssistantBridge({ endpoint: mcp.endpoint, accessToken: lab.accessToken, scenario: lab.scenario, seedObservation: lab.seedObservation });
  const web = await startWorkbench({ application: lab.core.application, tls: lab.tls, assistant: bridge });
  const jar = new Map();
  const call = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const request = https.request(web.origin + path, { method: body === undefined ? 'GET' : 'POST', ca: lab.tls.cert,
      headers: { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), ...(body ? { Origin: web.origin, 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; }); res.on('end', () => {
        for (const value of res.headers['set-cookie'] ?? []) { const [pair] = value.split(';'); const [key, val] = pair.split('='); if (val) jar.set(key, val); else jar.delete(key); }
        let json; try { json = JSON.parse(text); } catch { /* static */ }
        resolve({ status: res.statusCode, json, text });
      });
    }); request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const post = async (path, body, headers) => call(path, body, { 'X-DQ-CSRF': (await call('/api/context')).json.csrfToken, ...headers });
  t.after(async () => { await web.close(); await bridge.close(); await mcp.close(); lab.close(); await rm(directory, { recursive: true, force: true }); });
  return { get lab() { return lab; }, scenario, web, call, post,
    async reopen() { lab.close(); lab = await openAmazonLab({ directory, scenario }); } };
}

test('獨立英文面與真實 HTTPS/CSRF/HTTP-MCP 人類核准完整流程', async t => {
  const f = await setup(t);
  const page = await f.call('/assistant'); assert.equal(page.status, 200); assert.match(page.text, /Not the Alexa service/);
  assert.equal((await f.call('/api/assistant/context')).status, 401);
  assert.equal((await f.post('/api/login', { tenantId: 'tenant-lab', username: 'owner-lab', password: f.lab.password })).status, 200);
  assert.equal((await f.post('/api/assistant/command', { command: 'request' }, { 'X-DQ-CSRF': '' })).status, 403);
  const analysis = await f.post('/api/assistant/command', { command: 'analyze' });
  assert.equal(analysis.json.result.decision.route, 'DENY');
  const requested = await f.post('/api/assistant/command', { command: 'request' });
  assert.equal(requested.status, 200); assert.equal(requested.json.result.state, 'AWAITING_HUMAN');
  const row = requested.json.result;
  assert.equal((await f.post('/api/assistant/command', { command: 'apply', requestId: row.requestId })).json.result.error, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal((await f.post('/api/assistant/command', { command: 'approve', requestId: row.requestId })).status, 400);
  const intent = await f.post('/api/intents', { password: f.lab.password, purpose: 'PUBLISH_GRANT', manifestDigest: row.manifestDigest });
  const approve = await f.post('/api/assistant/approve', { requestId: row.requestId, manifestDigest: row.manifestDigest, intentToken: intent.json.intentToken });
  assert.equal(approve.status, 200); assert.equal(approve.json.state, 'APPROVED');
  const apply = await f.post('/api/assistant/command', { command: 'apply', requestId: row.requestId });
  assert.equal(apply.json.result.body.after.state, 'CONTAINED');
  assert.equal((await f.post('/api/assistant/command', { command: 'verify', requestId: row.requestId })).json.result.valid, true);
  const tamper = await f.post('/api/assistant/command', { command: 'tamper', requestId: row.requestId });
  assert.equal(tamper.json.result.valid, false);
  assert.ok(tamper.json.trace.some(call => call.code === 'HUMAN_APPROVAL_REQUIRED'));
  assert.ok(!tamper.json.trace.some(call => /approve|publish/.test(call.tool)));
  const replay = await f.post('/api/assistant/command', { command: 'replay', requestId: row.requestId });
  assert.deepEqual(replay.json.result, apply.json.result);
  const info = await f.call('/api/context');
  assert.equal(info.json.state.assets.find(asset => asset.id === row.assetId).version, 1);
  assert.equal(info.json.state.assets.find(asset => asset.id !== row.assetId).version, 0);
});

test('本機安裝停止／重開保留請求與帳號，變更場景不准偷偷重綁', async t => {
  const f = await setup(t);
  const password = f.lab.password;
  const worker = f.lab.workerToken;
  const token = f.lab.accessToken;
  f.lab.seedObservation({ eventId: 'event-one', assetId: 'syn-orders-session', version: 0 });
  const row = f.lab.core.execution.requestResponse(worker, { requestId: 'request-one', eventId: 'event-one', assetId: 'syn-orders-session', expectedVersion: 0 });
  await f.reopen();
  assert.equal(f.lab.password, undefined); assert.equal(f.lab.accessToken, token); assert.equal(f.lab.workerToken, worker);
  assert.deepEqual(f.lab.core.execution.inspect(worker).responses[0], row);
  const login = await f.lab.core.application.login({ tenantId: 'tenant-lab', username: 'owner-lab', password }, 'test');
  assert.equal(f.lab.core.application.status(login.sessionToken).role, 'TENANT_SUPER_ADMIN');
  const changed = JSON.parse(f.scenario); changed.seed = 'DQ-DIFFERENT-SEED';
  await assert.rejects(openAmazonLab({ directory: f.lab.directory, scenario: changed }), error => error.code === 'INSTANCE_MISMATCH');
});

test('外部合成情境可經 MCP 分析，惡意額外欄位與超過預算拒絕', async t => {
  const f = await setup(t);
  await f.post('/api/login', { tenantId: 'tenant-lab', username: 'owner-lab', password: f.lab.password });
  const custom = JSON.parse(f.scenario); custom.scenarioId = 'syn-judge-authored'; custom.seed = 'DQ-JUDGE-SEED';
  custom.failures = ['APPROVAL_UNAVAILABLE', 'EVIDENCE_AUTHORITY_UNAVAILABLE']; custom.expected.effectExecutable = false;
  const analysis = await f.post('/api/assistant/command', { command: 'custom', scenarioPack: custom });
  assert.equal(analysis.json.result.assertionsPassed, true); assert.equal(analysis.json.result.proposal.executableAfterApproval, false);
  assert.equal((await f.post('/api/assistant/command', { command: 'custom', scenarioPack: { ...custom, approval: true } })).json.failed, true);
  custom.requestedEffect.costUnits = 101;
  assert.equal((await f.post('/api/assistant/command', { command: 'custom', scenarioPack: custom })).json.failed, true);
});
