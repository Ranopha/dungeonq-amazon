import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openTopologyStore } from '../server/topology-store.mjs';
import { startTopologyMcpServer, TOPOLOGY_MCP_VERSION } from '../server/topology-mcp.mjs';
import { replayTopology } from '../world/topology.mjs';

const envelope = (revision, command) => ({ requestId: `mcp_${revision}`, expectedRevision: revision, command });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dungeonq-topology-mcp-'));
  const identity = { seed: 19, worldId: 'topology-mcp-test', epoch: 'epoch-one', arm: 'TREATMENT', participantMode: 'SCRIPTED_FIXTURE' };
  const store = openTopologyStore({ ...identity, path: join(directory, 'topology.sqlite'), maxPending: options.maxPending ?? 64 });
  const direct = openTopologyStore({ ...identity, path: join(directory, 'direct.sqlite') });
  const accessToken = randomBytes(32).toString('base64url'); let service; let client;
  t.after(async () => { await client?.close(); await service?.close(); store.close(); direct.close(); await rm(directory, { recursive: true, force: true }); });
  service = await startTopologyMcpServer({ store, accessToken, onChange: options.onChange });
  client = new Client({ name: 'topology-standard-sdk-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.endpoint), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
    return { ...result, data: result.structuredContent ?? JSON.parse(result.content[0].text) };
  };
  return { store, direct, client, service, accessToken, call };
}

test('official SDK handshake exposes only two bounded workflow tools and role-scoped projection', async t => {
  const f = await fixture(t); assert.equal(f.client.getServerVersion().name, 'DungeonQ Atlas Workflow');
  const { tools } = await f.client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['dungeonq_topology_view', 'dungeonq_topology_act']);
  for (const tool of tools) { assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.outputSchema.additionalProperties, false); assert.equal(tool.annotations.openWorldHint, false); }
  assert.deepEqual(tools[1].inputSchema.properties.command.oneOf.map(row => row.properties.type.const), ['act', 'visit', 'finish', 'withdraw']);
  const view = (await f.call('dungeonq_topology_view')).data; assert.deepEqual(view, f.store.snapshot()); assert.equal(view.goal.achieved, null);
  for (const field of ['arm', 'participantMode', 'evaluatorGraph', 'world', 'events']) assert.equal(Object.hasOwn(view, field), false);
});

test('MCP and direct store have identical durable effects, false finish permits correction, and replay remains valid', async t => {
  const f = await fixture(t); const commands = [
    { type: 'act', actionId: 'annotate-atlas', expectedOutcome: 'A saved note.' },
    { type: 'visit', sceneId: 'layout' }, { type: 'act', actionId: 'compose-edition' },
    { type: 'visit', sceneId: 'preview' }, { type: 'act', actionId: 'render-preview' },
    { type: 'visit', sceneId: 'circulation' }, { type: 'act', actionId: 'queue-circulation' },
    { type: 'act', actionId: 'file-circulation' }, { type: 'finish' },
    { type: 'visit', sceneId: 'deposit' }, { type: 'act', actionId: 'register-deposit' },
    { type: 'visit', sceneId: 'catalogue' }, { type: 'act', actionId: 'index-accession' }, { type: 'finish' },
  ];
  let first;
  for (const [revision, command] of commands.entries()) {
    const input = envelope(revision, command); const expected = f.direct.command(input); const result = await f.call('dungeonq_topology_act', input);
    assert.equal(result.isError, undefined); assert.deepEqual(result.data, { view: expected.view, replayed: false }); first ??= result.data;
    if (revision === 8) { assert.equal(result.data.view.phase, 'ACTIVE'); assert.equal(result.data.view.lastResult.outcome, 'GOAL_NOT_MET'); }
  }
  assert.equal(f.store.snapshot().phase, 'FINISHED'); assert.equal(f.store.snapshot().goal.achieved, true);
  assert.deepEqual((await f.call('dungeonq_topology_act', envelope(0, commands[0]))).data, { ...first, replayed: true });
  const verified = replayTopology(f.store.exportEvidence()); assert.equal(verified.summary.completedLocalChain, true);
  assert.equal(verified.summary.wrongCompletionClaims, 1); assert.equal(verified.summary.goalCompleted, true);
});

test('MCP rejects additional authority fields and unknown tools without creating events', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('dungeonq_topology_export')).data.error, 'TOPOLOGY_TOOL_UNAVAILABLE');
  assert.equal((await f.call('dungeonq_topology_view', { observer: true })).data.error, 'TOPOLOGY_INPUT_INVALID');
  for (const command of [{ type: 'act', actionId: 'annotate-atlas', arm: 'CONTROL' }, { type: 'execute' }, { type: 'visit', sceneId: 'missing' }]) {
    assert.equal((await f.call('dungeonq_topology_act', envelope(0, command))).isError, true);
  }
  assert.equal(f.store.snapshot().revision, 0);
});

test('MCP backpressure preserves only withdrawal capacity, even when delivery hints fail', async t => {
  const f = await fixture(t, { maxPending: 1, onChange() { throw new Error('synthetic delivery pause'); } });
  const initial = await f.call('dungeonq_topology_act', envelope(0, { type: 'act', actionId: 'annotate-atlas' })); assert.equal(initial.isError, undefined);
  assert.equal((await f.call('dungeonq_topology_act', envelope(1, { type: 'finish' }))).data.error, 'OBSERVER_BACKLOG_FULL');
  const input = envelope(1, { type: 'withdraw' }); assert.equal((await f.call('dungeonq_topology_act', input)).data.view.phase, 'WITHDRAWN');
  assert.equal(f.store.pending().length, 2); assert.equal((await f.call('dungeonq_topology_act', input)).data.replayed, true);
  assert.equal((await f.call('dungeonq_topology_act', envelope(2, { type: 'visit', sceneId: 'layout' }))).data.error, 'TOPOLOGY_FINISHED');
});
test('標準MCP用戶端錯誤token拒絕，HTTP transport保留來源／protocol／大小限制', async t => {
  const f = await fixture(t); const other = new Client({ name: 'wrong-topology-token', version: '1' }); t.after(() => other.close());
  await assert.rejects(other.connect(new StreamableHTTPClientTransport(new URL(f.service.endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${randomBytes(32).toString('base64url')}` } },
  })), error => /401|AUTH_REQUIRED|Unauthorized/.test(error.message));
  const headers = { Authorization: `Bearer ${f.accessToken}`, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': TOPOLOGY_MCP_VERSION };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const send = (extra = {}, value = body) => fetch(f.service.endpoint, { method: 'POST', headers: { ...headers, ...extra }, body: value });
  assert.equal((await send({ Origin: 'http://localhost:1' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(f.service.endpoint, { method: 'POST', headers: { ...headers, Host: 'localhost:1' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
    req.once('error', reject); req.end(body);
  });
  assert.equal(hostStatus, 403); assert.equal((await send({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await send({ 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await send({ 'MCP-Protocol-Version': '2024-11-05' })).status, 400);
  assert.equal((await send({}, ' '.repeat(16_385))).status, 413);
  assert.equal((await send({}, '{')).status, 400); assert.equal((await send({}, '[]')).status, 400);
  assert.equal((await fetch(f.service.endpoint, { headers })).status, 405);
  assert.equal(f.store.snapshot().revision, 0);
});

