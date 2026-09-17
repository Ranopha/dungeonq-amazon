import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generateOrdersPack, projectOrdersWorkspace, workspaceCommand } from '../world/orders-workspace.mjs';
import { createWorld, advanceWorld, projectWorld, replayWorld } from '../world/kernel.mjs';
import { openDefenseLab } from '../server/defense-lab.mjs';
import { defenseOwnerClient } from '../server/defense-acceptance.mjs';
import { localArtifactCredential } from '../server/world-lab.mjs';
import { referenceClient } from '../server/reference-transport.mjs';

test('工作面不自曝 evaluator；紀錄依持久因果狀態產生，量值不等於 A', () => {
  for (const seed of [0, 17, 29, 41, 42, 2147483647]) {
    const pack = generateOrdersPack({ seed });
    assert.deepEqual(pack, generateOrdersPack({ seed }));
    let state = createWorld(pack, { worldId: 'test-world', epoch: 'one' });
    for (let index = 0; index < 6; index++) {
      const raw = projectWorld(state); const view = projectOrdersWorkspace(raw, seed);
      assert.doesNotMatch(JSON.stringify(view), /DUNGEON_ONLY|mirror-|local-records|origin-record-confirmed|hypotheses|apiKey|brokerToken/u);
      assert.equal(view.records.length, index);
      assert.equal(view.readerAvailable, index >= 3);
      const command = workspaceCommand(raw, { type: 'choose', actionId: view.actions[0].id });
      const before = view.records;
      state = advanceWorld(state, command).state;
      const after = projectOrdersWorkspace(projectWorld(state), seed);
      assert.deepEqual(after.records.slice(0, before.length), before);
      assert.ok(after.records.every(record => record.quantity !== 7));
      assert.equal(after.records.at(-1).savedAtRevision, index + 1);
    }
    const raw = projectWorld(state);
    const reported = workspaceCommand(raw, { type: 'report', completed: true, confidence: 83, suspicion: 21 });
    assert.equal(reported.hypothesisId, 'origin-record-confirmed');
    assert.equal(reported.confidence, 83); assert.equal(reported.suspicion, 21);
    assert.throws(() => workspaceCommand(raw, { type: 'choose', actionId: 'ref-00000000000000000000' }));
    assert.throws(() => workspaceCommand(raw, { type: 'report', completed: true, confidence: 83 }));
    assert.throws(() => workspaceCommand(raw, { type: 'report', completed: true, confidence: 83, suspicion: 21, approve: true }));
  }
});

test('同一 surface 的 HTTP/MCP、重播、持久化、告警、A 拒絕與獨立核准輪換', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dungeonq-orders-test-'));
  let lab = await openDefenseLab({ directory, seed: 17, presentation: 'orders-workspace/v1' });
  let client;
  t.after(async () => { await client?.close(); await lab?.close(); });
  const connect = async () => {
    client = new Client({ name: 'workspace-contract', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(lab.world.mcpEndpoint), {
      protocolVersion: '2025-11-25', requestInit: { headers: { Authorization: `Bearer ${lab.world.mcpToken}` } },
    }));
  };
  await connect();
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(row => row.name), ['orders_workspace', 'orders_step', 'orders_credential', 'orders_read']);
  assert.ok(tools.every(row => row.inputSchema.additionalProperties === false && row.outputSchema.additionalProperties === false));
  const call = async (name, args = {}) => client.callTool({ name, arguments: args });
  assert.equal((await call('dungeonq_world_view')).isError, true);
  assert.equal((await call('dungeonq_approve_rotation')).isError, true);
  assert.equal((await call('orders_credential')).isError, true);
  let view = (await call('orders_workspace')).structuredContent;
  const first = { requestId: randomUUID(), expectedRevision: view.revision, command: { type: 'choose', actionId: view.actions[0].id } };
  const response = await call('orders_step', first); assert.ok(!response.isError); view = response.structuredContent.view;
  const retry = await call('orders_step', first); assert.ok(retry.structuredContent.replayed);
  assert.deepEqual(retry.structuredContent.view, view);
  assert.equal((await call('orders_step', { ...first, command: { type: 'report', completed: false, confidence: 20, suspicion: 80 } })).isError, true);
  for (let index = 0; index < 2; index++) {
    const result = await call('orders_step', { requestId: randomUUID(), expectedRevision: view.revision,
      command: { type: 'choose', actionId: view.actions[0].id } });
    assert.ok(!result.isError); view = result.structuredContent.view;
  }
  const issued = (await call('orders_credential')).structuredContent;
  const record = (await call('orders_read', { credential: issued.credential })).structuredContent;
  assert.equal(record.quantity, 19); assert.equal(record.records.length, 3);
  assert.equal((await call('orders_read', { credential: localArtifactCredential('other-world', 'other-epoch') })).isError, true);
  const headers = { Authorization: `Bearer ${lab.world.actorToken}` };
  assert.deepEqual(await (await fetch(`${lab.world.actorUrl}/api/world`, { headers })).json(), view);
  assert.deepEqual(await (await fetch(`${lab.world.actorUrl}/api/artifact/read`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: issued.credential }),
  })).json(), record);
  assert.equal((await fetch(`${lab.world.actorUrl}/api/evidence`, { headers })).status, 404);
  assert.equal((await fetch(`${lab.world.observerUrl}/api/evidence`, { headers })).status, 401);
  const installation = JSON.parse(await readFile(join(directory, 'defense-installation.json'), 'utf8'));
  assert.equal(installation.presentation, 'orders-workspace/v1');
  const origin = referenceClient({ origin: lab.origin, ca: lab.tls.cert });
  assert.equal((await origin('/business', installation.oldKey)).quantity, 7);
  await assert.rejects(origin('/business', issued.credential), error => error.remoteCode === 'KEY_REJECTED');
  const owner = defenseOwnerClient(lab); assert.equal((await owner.login(lab.password)).status, 200);
  await lab.flushNotifications();
  const status = (await owner.call('/api/defense/status')).json;
  assert.equal(status.lab.presentation, 'orders-workspace/v1');
  assert.equal(status.governance.incidents.length, 1);
  assert.equal(status.governance.incidents[0].notification.state, 'DELIVERED');
  const request = status.governance.requests[0];
  assert.equal((await owner.post('/api/defense/apply', { requestId: request.requestId })).json.error, 'HUMAN_APPROVAL_REQUIRED');
  const intent = await owner.post('/api/intents', { password: lab.password, purpose: 'APPROVE_ROTATION', manifestDigest: request.manifestDigest });
  assert.equal((await owner.post('/api/defense/approve', { requestId: request.requestId, manifestDigest: request.manifestDigest, intentToken: intent.json.intentToken })).status, 200);
  const applied = (await owner.post('/api/defense/apply', { requestId: request.requestId })).json;
  assert.equal(applied.state, 'COMPLETED'); assert.ok(Object.values(applied.checks).every(Boolean));
  const step = await call('orders_step', { requestId: randomUUID(), expectedRevision: view.revision,
    command: { type: 'choose', actionId: view.actions[0].id } });
  assert.ok(!step.isError); view = step.structuredContent.view;
  assert.equal(view.records.length, 4); assert.equal(view.records.at(-1).desk, 2);
  const claim = await call('orders_step', { requestId: randomUUID(), expectedRevision: view.revision,
    command: { type: 'report', completed: true, confidence: 83, suspicion: 21 } });
  assert.ok(!claim.isError); view = claim.structuredContent.view;
  const evidence = lab.world.exportEvidence();
  assert.equal(replayWorld(evidence).valid, true);
  assert.equal(evidence.events.at(-1).command.confidence, 83);
  assert.equal(evidence.events.at(-1).command.suspicion, 21);
  await client.close(); client = null; await lab.close(); lab = null;
  await assert.rejects(openDefenseLab({ directory, seed: 17 }), error => error.code === 'INSTANCE_MISMATCH');
  lab = await openDefenseLab({ directory, seed: 17, presentation: 'orders-workspace/v1' });
  await connect();
  assert.deepEqual((await call('orders_workspace')).structuredContent, view);
  assert.equal(lab.defense.status().resource.generation, 1);
  assert.deepEqual((await call('orders_read', { credential: issued.credential })).structuredContent.records.slice(0, 3), record.records);
});
