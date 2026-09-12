import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLocalFixture } from '../server/local-fixture.mjs';
import { createMcpTools, startMcpServer, MCP_VERSION } from '../server/mcp.mjs';
import { token } from '../server/contracts.mjs';
import { createSimulation } from '../public/src/engine.mjs';

async function fixture(t) {
  const lab = await createLocalFixture(); const accessToken = token();
  const workerToken = lab.core.local.provisionWorker({ tenantId: 'tenant-lab', workerId: 'mcp-worker', expiresAt: Date.now() + 3_600_000 }).workerToken;
  lab.core.local.recordObservation({ tenantId: 'tenant-lab', assetId: 'api-orders', eventId: 'event-one', version: 0 });
  const service = await startMcpServer({ tools: createMcpTools({ execution: lab.core.execution, workerToken }), accessToken });
  const client = new Client({ name: 'independent-test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(service.endpoint), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } });
  t.after(async () => { await client.close(); await service.close(); await lab.close(); });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { ...result, data: result.structuredContent ?? JSON.parse(result.content[0].text) };
  };
  return { lab, accessToken, service, client, call };
}

test('官方 SDK 2025-11-25 握手／列表、同引擎 conformance、未知工具與閉合 schema', async t => {
  const f = await fixture(t);
  assert.equal(f.client.getServerVersion().name, 'DungeonQ');
  const list = await f.client.listTools();
  assert.equal(list.tools.length, 6);
  assert.ok(!list.tools.some(tool => /approve|publish|bootstrap/.test(tool.name)));
  const pack = JSON.parse(await readFile(new URL('../public/scenarios/honey-credential.json', import.meta.url)));
  const result = await f.call('dungeonq_simulate', { scenarioPack: pack });
  assert.deepEqual(result.data.result, JSON.parse(JSON.stringify(await createSimulation(pack))));
  assert.equal(result.data.result.decision.route, 'DENY');
  assert.equal((await f.call('dungeonq_approve', { actorType: 'HUMAN' })).isError, true);
  assert.equal((await f.call('dungeonq_status', { role: 'admin' })).data.error, 'SCHEMA_INVALID');
  assert.equal((await f.call('dungeonq_simulate', { scenarioPack: { ...pack, classification: 'PRODUCTION' } })).isError, true);
});

test('MCP 請求→未核准拒絕→人類核心核准→效果讀回→重播→篡改驗證', async t => {
  const f = await fixture(t);
  const row = (await f.call('dungeonq_response_request', { requestId: 'request-one', eventId: 'event-one', assetId: 'api-orders', expectedVersion: 0 })).data.result;
  assert.equal(row.state, 'AWAITING_HUMAN');
  assert.equal((await f.call('dungeonq_effect_apply', { requestId: row.requestId })).data.error, 'HUMAN_APPROVAL_REQUIRED');
  const app = f.lab.core.application;
  const login = await app.login({ tenantId: 'tenant-lab', username: 'owner-lab', password: f.lab.password }, 'test');
  const intent = await app.reauthenticate(login.sessionToken, { password: f.lab.password, purpose: 'PUBLISH_GRANT', manifestDigest: row.manifestDigest }, 'test');
  app.approveResponse(login.sessionToken, { requestId: row.requestId, manifestDigest: row.manifestDigest, intentToken: intent.intentToken });
  app.logout(login.sessionToken);
  const receipt = (await f.call('dungeonq_effect_apply', { requestId: row.requestId })).data.result;
  assert.equal(receipt.body.after.state, 'CONTAINED');
  assert.deepEqual((await f.call('dungeonq_effect_apply', { requestId: row.requestId })).data.result, receipt);
  assert.equal((await f.call('dungeonq_receipt_verify', { receipt })).data.result.valid, true);
  const tampered = structuredClone(receipt); tampered.body.after.version = 99;
  assert.equal((await f.call('dungeonq_receipt_verify', { receipt: tampered })).data.result.valid, false);
  const evidence = (await f.call('dungeonq_evidence_export', { requestId: row.requestId })).data.result;
  assert.equal(evidence.receiptVerified, true); assert.equal(evidence.commercialReady, false);
  assert.ok(!JSON.stringify(evidence).includes(f.accessToken));
  assert.ok(!JSON.stringify(evidence).includes(f.lab.password));
});

test('HTTP Origin／Host／Auth／Protocol／大小／方法拒絕', async t => {
  const f = await fixture(t);
  const headers = { Authorization: `Bearer ${f.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': MCP_VERSION };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const send = (more = {}, payload = body) => fetch(f.service.endpoint, { method: 'POST', headers: { ...headers, ...more }, body: payload });
  assert.equal((await send({ Origin: 'https://untrusted.example' })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const req = httpRequest(f.service.endpoint, { method: 'POST', headers: { ...headers, Host: 'untrusted.example' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }); req.on('error', reject); req.end(body);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await send({ Authorization: `Bearer ${token()}` })).status, 401);
  assert.equal((await send({ 'MCP-Protocol-Version': '2024-11-05' })).status, 400);
  assert.equal((await send({}, 'x'.repeat(196_609))).status, 413);
  assert.equal((await send({}, '[]')).status, 400);
  assert.equal((await fetch(f.service.endpoint, { headers })).status, 405);
  const init = await send({}, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'judge', version: '1' } } }));
  assert.equal((await init.json()).result.protocolVersion, MCP_VERSION);
});
