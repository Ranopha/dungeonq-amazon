import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTopologyLab } from '../server/topology-lab.mjs';
import { createTopology, advanceTopology, makeTopologyBundle, replayTopology } from '../world/topology.mjs';
import { worldDigest } from '../world/kernel.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) throw Error('PASS_NEW_OUTPUT_DIRECTORY');
const root = args.length ? resolve(args[1]) : await mkdtemp(join(tmpdir(), 'dungeonq-topology-proof-'));
if (args.length) await mkdir(root, { mode: 0o700 });
const report = { schemaVersion: 'dungeonq.topology-proof/v2', createdAt: new Date().toISOString(),
  profile: 'SYNTHETIC_TOPOLOGY_WORKFLOW', participantMode: 'SCRIPTED_FIXTURE', checks: [], trials: [],
  modelSampleSize: 0, paidProviderApiCalls: 0, externalTargetRequests: 0,
  claim: 'ENGINEERING_ONLY_NOT_INDUCTION_EFFICACY', passed: false };
const mark = id => report.checks.push({ id, passed: true });
async function get(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); return response.json();
}
for (const arm of ['TREATMENT', 'CONTROL']) {
  const directory = join(root, arm.toLowerCase()); await mkdir(directory, { mode: 0o700 });
  const lab = await startTopologyLab({ dataDir: directory, seed: 19, arm, participantMode: 'SCRIPTED_FIXTURE' });
  const client = new Client({ name: 'dungeonq-topology-proof', version: '0.7.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(lab.mcpEndpoint), { protocolVersion: '2025-11-25',
      requestInit: { headers: { Authorization: `Bearer ${lab.mcpToken}` } } }));
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), ['dungeonq_topology_view', 'dungeonq_topology_act']);
    let view = await get(`${lab.actorUrl}/api/topology`, lab.actorToken); let lastEnvelope; let lastResult;
    let pure = createTopology({ seed: 19, arm, participantMode: 'SCRIPTED_FIXTURE', worldId: view.worldId, epoch: view.epoch });
    const pureEvents = [];
    async function command(command) {
      const envelope = { requestId: randomUUID(), expectedRevision: view.revision, command }; let result;
      if (view.revision % 2 === 0) {
        const reply = await client.callTool({ name: 'dungeonq_topology_act', arguments: envelope });
        assert.ok(!reply.isError, JSON.stringify(reply)); result = reply.structuredContent;
      } else {
        const response = await fetch(`${lab.actorUrl}/api/topology/command`, { method: 'POST',
          headers: { Authorization: `Bearer ${lab.actorToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(envelope), signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200); result = await response.json();
      }
      const next = advanceTopology(pure, command); pure = next.state; pureEvents.push(next.event);
      assert.deepEqual(result.view, next.view); view = result.view;
      assert.deepEqual(view, await get(`${lab.actorUrl}/api/topology`, lab.actorToken));
      assert.equal(view.arm, undefined); assert.equal(view.evaluatorGraph, undefined);
      lastEnvelope = envelope; lastResult = result; return view;
    }
    async function act(sceneId, actionId) {
      if (view.scene.id !== sceneId) await command({ type: 'visit', sceneId });
      await command({ type: 'act', actionId }); assert.equal(view.lastResult.outcome, 'SUCCESS');
    }
    await act('workroom', 'annotate-atlas'); await act('layout', 'compose-edition');
    await act('preview', 'render-preview'); await act('circulation', 'queue-circulation');
    await act('circulation', 'file-circulation');
    assert.equal(pure.consumerLineage.length, 1);
    const lineage = pure.consumerLineage[0];
    assert.equal(lineage.delivery.packetDigest, lineage.read.packetDigest);
    assert.equal(lineage.read.id, lineage.decision.readId);
    assert.equal(lineage.decision.id, lineage.localWrite.decisionId);
    mark(`${arm}_PERSISTENT_PACKET_CONSUMER_LINEAGE`);
    await command({ type: 'finish' });
    assert.equal(view.lastResult.outcome, 'GOAL_NOT_MET'); assert.equal(view.phase, 'ACTIVE');
    mark(`${arm}_LOCAL_SUCCESS_DOES_NOT_GRANT_GLOBAL_GOAL`);
    await act('deposit', 'register-deposit'); await act('catalogue', 'index-accession');
    assert.equal(view.readbacks.visitorCatalogue.containsTarget, true);
    await command({ type: 'finish' }); assert.equal(view.phase, 'FINISHED');
    mark(`${arm}_DISCOVERABLE_TRUE_PATH_AND_READBACK`);
    const retry = await client.callTool({ name: 'dungeonq_topology_act', arguments: lastEnvelope });
    assert.equal(retry.structuredContent.replayed, true); assert.deepEqual(retry.structuredContent.view, lastResult.view);
    mark(`${arm}_HTTP_MCP_PURE_PARITY_AND_IDEMPOTENCY`);
    let observed;
    for (let attempt = 0; attempt < 80; attempt++) {
      observed = await get(`${lab.observerUrl}/api/observer`, lab.observerToken);
      if (observed.verification?.eventCount === view.revision) break;
      await delay(25);
    }
    assert.equal(observed.verification.eventCount, view.revision);
    const bundle = await get(`${lab.observerUrl}/api/evidence`, lab.observerToken);
    assert.deepEqual(bundle, makeTopologyBundle(pure, pureEvents));
    const replay = replayTopology(bundle); assert.equal(replay.valid, true);
    mark(`${arm}_INDEPENDENT_OBSERVER_CAUSAL_REPLAY`);
    const tampered = structuredClone(bundle); tampered.events[0].observation.message += ' altered';
    assert.throws(() => replayTopology(tampered)); mark(`${arm}_ALTERED_EVENT_REJECTED`);
    await writeFile(join(root, `${arm.toLowerCase()}.json`), JSON.stringify(bundle, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    report.trials.push({ arm, summary: replay.summary, evidenceDigest: worldDigest(bundle) });
  } finally { await client.close(); await lab.close(); }
}
report.passed = true;
await writeFile(join(root, 'proof.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
process.stdout.write(JSON.stringify({ directory: root, passed: true, checks: report.checks.length, claim: report.claim }) + '\n');
