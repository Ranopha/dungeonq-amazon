import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openStudyStore } from '../server/study-store.mjs';
import { startStudyMcpServer, STUDY_MCP_VERSION } from '../server/study-mcp.mjs';
import { replayStudy } from '../study/experiment.mjs';

const design = { schemaVersion: 'dungeonq.study-design/v1', title: '合成MCP研究驗收', seed: 17, trainingRounds: 2, probeBudget: 1,
  labels: { signalOn: '琥珀光', signalOff: '無光', structureOn: '三角紋', structureOff: '圓紋' } };
const consent = { type: 'consent', accepted: true, participantMode: 'SCRIPTED_FIXTURE' };
const prediction = view => ({ type: 'predict', choiceId: view.choices[0].id, predictedSuccess: null,
  hypothesis: 'unknown', confidence: null, suspicion: null });
const reflection = { type: 'reflect', hypothesis: 'unknown', confidence: null, suspicion: null, nextIntent: 'proceed' };
const envelope = (revision, command) => ({ requestId: `mcp_${revision}`, expectedRevision: revision, command });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dungeonq-study-mcp-'));
  const identity = { design, worldId: 'study-mcp-test', epoch: 'epoch-one', arm: 'CORRELATED', rule: 'structure', nonce: 'a'.repeat(64) };
  const store = openStudyStore({ ...identity, path: join(directory, 'study.sqlite'), maxPending: options.maxPending ?? 64 });
  const direct = openStudyStore({ ...identity, path: join(directory, 'direct.sqlite') });
  const accessToken = randomBytes(32).toString('base64url'); let service; let client;
  t.after(async () => { await client?.close(); await service?.close(); store.close(); direct.close(); await rm(directory, { recursive: true, force: true }); });
  service = await startStudyMcpServer({ store, accessToken, onChange: options.onChange });
  client = new Client({ name: 'study-standard-sdk-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.endpoint), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
    return { ...result, data: result.structuredContent ?? JSON.parse(result.content[0].text) };
  };
  return { store, direct, client, service, accessToken, call };
}

test('官方SDK握手與closed schemas，只提供study view及五種有限命令', async t => {
  const f = await fixture(t); assert.equal(f.client.getServerVersion().name, 'DungeonQ Causal Study');
  const { tools } = await f.client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['dungeonq_study_view', 'dungeonq_study_act']);
  for (const tool of tools) { assert.equal(tool.inputSchema.additionalProperties, false); assert.equal(tool.outputSchema.additionalProperties, false); assert.equal(tool.annotations.openWorldHint, false); }
  const variants = tools[1].inputSchema.properties.command.oneOf;
  assert.deepEqual(variants.map(variant => variant.properties.type.const), ['consent', 'predict', 'act', 'reflect', 'withdraw']);
  assert.ok(variants.every(variant => variant.additionalProperties === false));
  const viewed = await f.call('dungeonq_study_view'); assert.deepEqual(viewed.data, f.store.snapshot());
  assert.equal(viewed.data.phase, 'CONSENT'); assert.equal(viewed.data.debrief, null);
  for (const hidden of ['arm', 'rule', 'nonce', 'design', 'events', 'eventHead', 'beforeDigest', 'afterDigest', 'world']) assert.equal(Object.hasOwn(viewed.data, hidden), false);
});

test('完整MCP預測→動作→反思與直接store一致，重試維持原始結果且最終揭示可核驗', async t => {
  const f = await fixture(t); let first; let firstEnvelope;
  while (f.store.snapshot().phase !== 'COMPLETE') {
    const view = f.store.snapshot();
    const command = view.phase === 'CONSENT' ? consent : view.phase === 'PREDICT' ? prediction(view) : view.phase === 'ACT' ? { type: 'act' } : reflection;
    const input = envelope(view.revision, command); const expected = f.direct.command(input);
    const result = await f.call('dungeonq_study_act', input);
    assert.equal(result.isError, undefined); assert.deepEqual(result.data, { view: expected.view, replayed: false });
    assert.deepEqual(f.store.snapshot(), f.direct.snapshot());
    if (!first) { first = result.data; firstEnvelope = input; }
    assert.ok(f.store.snapshot().revision <= 16, '固定短設計必須在有界步數內完成');
  }
  const final = f.store.snapshot(); assert.ok(final.debrief); assert.equal(final.debrief.rule, 'structure');
  const retry = await f.call('dungeonq_study_act', firstEnvelope);
  assert.deepEqual(retry.data, { ...first, replayed: true }); assert.equal(f.store.snapshot().revision, final.revision);
  const verified = replayStudy(f.store.exportEvidence()); assert.equal(verified.summary.participantMode, 'SCRIPTED_FIXTURE');
  assert.equal(verified.summary.efficacyClaim, 'NOT_ESTABLISHED_FOR_HUMANS_OR_LLMS');
});

test('MCP不可跳過預測或改act選擇，未知工具／欄位拒絕且不生事件', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('dungeonq_study_export')).data.error, 'STUDY_TOOL_UNAVAILABLE');
  assert.equal((await f.call('dungeonq_study_view', { observer: true })).data.error, 'STUDY_INPUT_INVALID');
  assert.equal((await f.call('dungeonq_study_act', envelope(0, { type: 'act' }))).data.error, 'STUDY_PHASE_INVALID');
  const accepted = await f.call('dungeonq_study_act', envelope(0, consent));
  const predict = prediction(accepted.data.view);
  assert.equal((await f.call('dungeonq_study_act', envelope(1, { ...predict, confidence: 0 }))).data.error, 'STUDY_UNKNOWN_CONFIDENCE');
  await f.call('dungeonq_study_act', envelope(1, predict));
  assert.equal((await f.call('dungeonq_study_act', envelope(2, { type: 'act', choiceId: predict.choiceId }))).data.error, 'STUDY_FIELDS_INVALID');
  assert.equal((await f.call('dungeonq_study_act', envelope(2, { type: 'change-rule', rule: 'signal' }))).data.error, 'STUDY_COMMAND_INVALID');
  assert.equal(f.store.snapshot().revision, 2); assert.equal(f.store.snapshot().lastResult, null);
});

test('MCP積壓保留退出容量，提示送達失敗也保留已提交結果', async t => {
  const f = await fixture(t, { maxPending: 2, onChange() { return Promise.reject(new Error('synthetic delivery pause')); } });
  const first = await f.call('dungeonq_study_act', envelope(0, consent));
  await f.call('dungeonq_study_act', envelope(1, prediction(first.data.view)));
  assert.equal((await f.call('dungeonq_study_act', envelope(2, { type: 'act' }))).data.error, 'OBSERVER_BACKLOG_FULL');
  const input = envelope(2, { type: 'withdraw' }); const withdrawn = await f.call('dungeonq_study_act', input);
  assert.equal(withdrawn.isError, undefined); assert.equal(withdrawn.data.view.phase, 'WITHDRAWN'); assert.equal(f.store.pending().length, 3);
  assert.equal((await f.call('dungeonq_study_act', input)).data.replayed, true);
  assert.equal((await f.call('dungeonq_study_act', envelope(3, { type: 'act' }))).data.error, 'STUDY_FINISHED');
});

test('標準MCP用戶端錯誤token拒絕，HTTP transport保留來源／protocol／大小限制', async t => {
  const f = await fixture(t); const other = new Client({ name: 'wrong-study-token', version: '1' }); t.after(() => other.close());
  await assert.rejects(other.connect(new StreamableHTTPClientTransport(new URL(f.service.endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${randomBytes(32).toString('base64url')}` } },
  })), error => /401|AUTH_REQUIRED|Unauthorized/.test(error.message));
  const headers = { Authorization: `Bearer ${f.accessToken}`, 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': STUDY_MCP_VERSION };
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
