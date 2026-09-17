import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openWorldStore } from '../server/world-store.mjs';
import { startWorldMcpServer, WORLD_MCP_VERSION } from '../server/world-mcp.mjs';

const token = () => randomBytes(32).toString('base64url');
const pack = JSON.parse(await readFile(new URL('../world/packs/clockwork-archive.json', import.meta.url), 'utf8'));
const choose = choiceId => ({ type: 'choose', choiceId });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dungeonq-world-mcp-'));
  const identity = { pack, worldId: 'world-mcp-test', epoch: 'epoch-one' };
  const store = openWorldStore({ ...identity, path: join(directory, 'world.sqlite') });
  const direct = openWorldStore({ ...identity, path: join(directory, 'direct.sqlite') });
  const accessToken = token(); let changes = 0; let service; let client;
  t.after(async () => {
    await client?.close(); await service?.close(); store.close(); direct.close();
    await rm(directory, { recursive: true, force: true });
  });
  service = await startWorldMcpServer({ store, accessToken, onChange() { changes++; return options.onChange?.(); } });
  client = new Client({ name: 'world-standard-sdk-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  }));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
    return { ...result, data: result.structuredContent ?? JSON.parse(result.content[0].text) };
  };
  return { store, direct, client, service, accessToken, call, get changes() { return changes; } };
}

test('世界 MCP 使用官方 SDK 握手及完整封閉 schema，只提供 view 與有限 act', async t => {
  const f = await fixture(t);
  assert.equal(f.client.getServerVersion().name, 'DungeonQ Closed World');
  const { tools } = await f.client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['dungeonq_world_view', 'dungeonq_world_act']);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.outputSchema.additionalProperties, false);
    assert.equal(tool.annotations.openWorldHint, false);
  }
  const variants = tools[1].inputSchema.properties.command.oneOf;
  assert.deepEqual(variants.map(variant => variant.properties.type.const), ['inspect', 'choose', 'report', 'redeem', 'rebuild']);
  assert.ok(variants.every(variant => variant.additionalProperties === false));
  const viewed = await f.call('dungeonq_world_view');
  assert.deepEqual(viewed.data, f.store.snapshot());
  assert.equal(viewed.data.profile, 'ABSTRACT_SYNTHETIC_WORLD');
  assert.equal(viewed.data.revision, 0); assert.equal(f.changes, 0);
  const serialized = JSON.stringify(viewed.data);
  for (const hidden of ['pack', 'events', 'eventHead', 'beforeDigest', 'afterDigest', 'requires', 'moon-open']) {
    assert.ok(!serialized.includes(`"${hidden}"`), `未揭露 ${hidden}`);
  }
});

test('MCP 與直接共用 store 的五種世界動作投影一致，重試不重複計步', async t => {
  const f = await fixture(t); let sequence = 0;
  const perform = async command => {
    const envelope = { requestId: `step-${++sequence}`, expectedRevision: f.store.snapshot().revision, command };
    const expected = f.direct.command(envelope);
    const result = await f.call('dungeonq_world_act', envelope);
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.data, { view: expected.view, replayed: false });
    assert.deepEqual(Object.keys(result.data).sort(), ['replayed', 'view']);
    assert.deepEqual(f.store.snapshot(), f.direct.snapshot());
    return { envelope, result };
  };
  await perform({ type: 'inspect' });
  const blocked = await perform(choose('enter-gallery'));
  assert.equal(blocked.result.data.view.lastObservation.outcome, 'BLOCKED');
  const picked = await perform(choose('take-amber'));
  await perform({ type: 'report', hypothesisId: 'context-specific', confidence: 75, suspicion: 20, nextChoiceId: 'enter-gallery' });
  await perform({ type: 'redeem', receipt: picked.result.data.view.receipts[0] });
  const rebuilt = await perform({ type: 'rebuild' });
  assert.equal(rebuilt.result.data.view.generation, 2);
  const retry = await f.call('dungeonq_world_act', picked.envelope);
  assert.deepEqual(retry.data, { view: picked.result.data.view, replayed: true });
  assert.equal(f.store.snapshot().revision, sequence);
  assert.equal(f.store.exportEvidence().events.length, sequence);
  assert.equal(f.changes, sequence + 1);
  assert.equal((await f.call('dungeonq_world_act', { ...picked.envelope, command: { type: 'inspect' } })).data.error, 'IDEMPOTENCY_CONFLICT');
  // 從介面所用的相同 store 寫入，也會由 MCP 即時讀回。
  f.store.command({ requestId: 'direct-ui-step', expectedRevision: sequence, command: choose('enter-gallery') });
  assert.deepEqual((await f.call('dungeonq_world_view')).data, f.store.snapshot());
});

test('未知工具、未知動作、額外欄位與舊 revision 明確拒絕且不建立世界事件', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('dungeonq_world_export')).data.error, 'WORLD_TOOL_UNAVAILABLE');
  assert.equal((await f.call('dungeonq_world_view', { observer: true })).data.error, 'WORLD_INPUT_INVALID');
  assert.equal((await f.call('dungeonq_world_act', {
    requestId: 'unknown', expectedRevision: 0, command: { type: 'unlisted' },
  })).data.error, 'WORLD_COMMAND_INVALID');
  assert.equal((await f.call('dungeonq_world_act', {
    requestId: 'extra', expectedRevision: 0, command: { type: 'inspect', alternateRoom: 'moon' },
  })).data.error, 'WORLD_INVALID');
  assert.equal((await f.call('dungeonq_world_act', {
    requestId: 'stale', expectedRevision: 1, command: { type: 'inspect' },
  })).data.error, 'REVISION_CONFLICT');
  assert.equal(f.store.snapshot().revision, 0); assert.equal(f.store.pending().length, 0); assert.equal(f.changes, 0);
});

test('觀測者 token 無法以標準 MCP client 連入 Actor 世界', async t => {
  const f = await fixture(t);
  const observerClient = new Client({ name: 'observer-token-test', version: '1.0.0' });
  t.after(() => observerClient.close());
  await assert.rejects(observerClient.connect(new StreamableHTTPClientTransport(new URL(f.service.endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${token()}` } },
  })), error => /401|Unauthorized|AUTH_REQUIRED/u.test(error.message));
  assert.equal(f.store.snapshot().revision, 0);
});

test('世界 MCP 保留 Host、Origin、JSON、協議、大小與方法界線', async t => {
  const f = await fixture(t);
  const headers = { Authorization: `Bearer ${f.accessToken}`, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': WORLD_MCP_VERSION };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const send = (more = {}, payload = body) => fetch(f.service.endpoint, { method: 'POST', headers: { ...headers, ...more }, body: payload });
  assert.equal((await send({ Origin: 'http://localhost:1' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(f.service.endpoint, { method: 'POST', headers: { ...headers, Host: 'localhost:1' } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    }); request.once('error', reject); request.end(body);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await send({ 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await send({ 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal((await send({ 'MCP-Protocol-Version': '2024-11-05' })).status, 400);
  assert.equal((await send({}, 'x'.repeat(16_385))).status, 413);
  assert.equal((await send({}, '[]')).status, 400);
  assert.equal((await send({}, '{')).status, 400);
  assert.equal((await fetch(f.service.endpoint, { headers })).status, 405);
  const init = await send({}, JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {
    protocolVersion: WORLD_MCP_VERSION, capabilities: {}, clientInfo: { name: 'world-initialize-test', version: '1' },
  } }));
  assert.equal((await init.json()).result.protocolVersion, WORLD_MCP_VERSION);
  assert.equal(init.headers.get('mcp-session-id'), null);
});

test('Observer 送達提示失敗保留已提交結果與待送事件，重試仍去重', async t => {
  const f = await fixture(t, { onChange() { return Promise.reject(new Error('暫時無法送達')); } });
  const envelope = { requestId: 'delivery-retry', expectedRevision: 0, command: choose('take-amber') };
  const first = await f.call('dungeonq_world_act', envelope);
  assert.equal(first.isError, undefined); assert.equal(first.data.view.revision, 1);
  assert.equal(f.store.pending().length, 1);
  const retry = await f.call('dungeonq_world_act', envelope);
  assert.equal(retry.data.replayed, true); assert.equal(f.store.snapshot().revision, 1);
});
