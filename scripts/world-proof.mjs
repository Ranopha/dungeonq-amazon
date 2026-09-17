import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startWorldLab } from '../server/world-lab.mjs';
import { replayWorld, worldDigest } from '../world/kernel.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Fixed steps are an integration fixture, never a claim that a model or person was deceived.
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('用法：npm run world:proof -- [--out NEW_DIRECTORY]');
const root = args.length ? resolve(args[1]) : await mkdtemp(join(tmpdir(), 'dungeonq-world-proof-'));
if (args.length) await mkdir(root, { mode: 0o700 });
const pack = JSON.parse(await readFile(new URL('../world/packs/clockwork-archive.json', import.meta.url), 'utf8'));
const otherPack = JSON.parse(await readFile(new URL('../world/packs/reviewer-lanterns.json', import.meta.url), 'utf8'));
const report = { schemaVersion: 'dungeonq.world-proof/v1', profile: 'ABSTRACT_SYNTHETIC_WORLD',
  participantMode: 'SCRIPTED_FIXTURE_NO_MODEL', deceptionEfficacy: 'NOT_EVALUATED', paidModelCalls: 0, externalTargetRequests: 0,
  generatedAt: new Date().toISOString(), checks: [], artifacts: [], passed: false };
const labs = [];
const passed = id => report.checks.push({ id, passed: true });
async function call(lab, plane, path, body, overrideToken) {
  const url = plane === 'actor' ? lab.actorUrl : lab.observerUrl;
  const token = overrideToken ?? (plane === 'actor' ? lab.actorToken : lab.observerToken);
  const response = await fetch(new URL(path, url), { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3000) });
  return { status: response.status, body: await response.json() };
}
let requestCount = 0;
async function act(lab, command) {
  const snap = await call(lab, 'actor', '/api/world'); assert.equal(snap.status, 200);
  const result = await call(lab, 'actor', '/api/world/command', {
    requestId: `fixture-${++requestCount}`, expectedRevision: snap.body.revision, command });
  assert.equal(result.status, 200); assert.equal(result.body.event, undefined); return result.body.view;
}
async function observed(lab, revision) {
  for (let n = 0; n < 50; n++) {
    const response = await call(lab, 'observer', '/api/observer');
    if (response.status === 200 && response.body.events?.length === revision && response.body.verification?.valid === true) return response.body;
    await new Promise(resolveWait => setTimeout(resolveWait, 40));
  }
  throw new Error('OBSERVER_DID_NOT_CATCH_UP');
}
try {
  let lab = await startWorldLab({ dataDir: join(root, 'archive'), pack }); labs.push(lab);
  const stranger = await startWorldLab({ dataDir: join(root, 'visitor'), pack: otherPack }); labs.push(stranger);
  assert.equal((await call(lab, 'observer', '/api/observer', undefined, lab.actorToken)).status, 401);
  assert.equal((await call(lab, 'actor', '/api/world', undefined, lab.observerToken)).status, 401);
  passed('ACTOR_OBSERVER_DISTINCT_AUTHORITY');
  const client = new Client({ name: 'DungeonQ scripted acceptance', version: '1.0.0' });
  let view;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(lab.mcpEndpoint), {
      requestInit: { headers: { Authorization: `Bearer ${lab.mcpToken}` } } }));
    const listing = await client.listTools();
    assert.deepEqual(listing.tools.map(tool => tool.name).sort(), ['dungeonq_world_act', 'dungeonq_world_view']);
    const result = await client.callTool({ name: 'dungeonq_world_act', arguments: {
      requestId: 'sdk-first', expectedRevision: 0, command: { type: 'choose', choiceId: 'take-amber' } } });
    assert.equal(result.isError, undefined);
    view = result.structuredContent.view;
    assert.deepEqual((await call(lab, 'actor', '/api/world')).body, view);
    await observed(lab, view.revision); passed('STANDARD_MCP_HTTP_AND_OBSERVER_SHARE_ONE_WORLD');
  } finally { await client.close(); }
  const reward = view.receipts[0];
  for (const choiceId of ['enter-gallery', 'enter-reading']) view = await act(lab, { type: 'choose', choiceId });
  assert.equal(view.room.id, 'reading'); assert.equal(view.receipts.length, 3); passed('LOCAL_SUCCESS_HAS_PERSISTENT_CONSEQUENCES');
  view = await act(lab, { type: 'choose', choiceId: 'enter-moon' });
  assert.equal(view.lastObservation.outcome, 'BLOCKED'); passed('PRIOR_SUCCESS_DOES_NOT_CREATE_GLOBAL_AUTHORITY');
  view = await act(lab, { type: 'report', hypothesisId: 'context-specific', confidence: 70, suspicion: 80, nextChoiceId: 'reading-hall' });
  const snapshot = await observed(lab, view.revision);
  assert.equal(snapshot.summary.beliefStatus, 'SELF_REPORTED_NOT_INFERRED');
  assert.equal(snapshot.summary.firstHighSuspicionStep, view.revision); passed('INDEPENDENT_OBSERVER_RECORDS_SELF_REPORT_NOT_MIND_READING');
  const original = { worldId: view.worldId, epoch: view.epoch, room: view.room, inventory: view.inventory, receipts: view.receipts, revision: view.revision };
  await lab.close(); labs.splice(labs.indexOf(lab), 1);
  lab = await startWorldLab({ dataDir: join(root, 'archive'), pack }); labs.push(lab);
  const restored = (await call(lab, 'actor', '/api/world')).body;
  for (const key of Object.keys(original)) assert.deepEqual(restored[key], original[key]);
  await observed(lab, restored.revision); passed('PROCESS_RESTART_RETAINS_WORLD_AND_OBSERVER_JOURNALS');
  view = await act(lab, { type: 'rebuild' }); assert.equal(view.generation, 2);
  assert.deepEqual(view.inventory, original.inventory); passed('PRESENTATION_REBUILD_PRESERVES_NARRATIVE');
  const foreign = await act(stranger, { type: 'redeem', receipt: reward });
  assert.equal(foreign.lastObservation.outcome, 'REWARD_SCOPE_REJECTED'); passed('FOREIGN_WORLD_REWARD_REJECTED');
  await act(stranger, { type: 'choose', choiceId: 'blue-switch' });
  assert.equal((await act(stranger, { type: 'choose', choiceId: 'enter-green' })).lastObservation.outcome, 'BLOCKED');
  await act(stranger, { type: 'choose', choiceId: 'green-switch' });
  assert.equal((await act(stranger, { type: 'choose', choiceId: 'enter-green' })).room.id, 'green-room');
  passed('SEPARATE_REVIEWER_PACK_RUNS_UNCHANGED_ENGINE');
  for (const choiceId of ['reading-hall', 'visit-garden', 'take-moon-ticket', 'garden-reading', 'enter-moon']) {
    view = await act(lab, { type: 'choose', choiceId });
  }
  assert.equal(view.room.id, 'moon'); passed('NEW_EVIDENCE_UNLOCKS_PREDECLARED_PATH');
  await observed(lab, view.revision);
  const bundle = (await call(lab, 'observer', '/api/evidence')).body;
  assert.equal(replayWorld(bundle).valid, true); passed('OFFLINE_CAUSAL_REPLAY');
  const altered = structuredClone(bundle); altered.events[0].observation.message = 'changed';
  assert.throws(() => replayWorld(altered)); passed('ALTERED_EVIDENCE_REJECTED');
  const filename = 'world-evidence.json';
  await writeFile(join(root, filename), `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  report.artifacts.push({ name: filename, canonicalDigest: worldDigest(bundle) });
  report.passed = true;
} catch (error) {
  report.error = error.code ?? error.message; process.exitCode = 1;
} finally {
  await Promise.all(labs.map(lab => lab.close()));
  await writeFile(join(root, 'proof-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ ...report, outputDirectory: root })}\n`);
}
