import test from 'node:test';
import assert from 'node:assert/strict';
import { createTopology, advanceTopology, projectTopology, makeTopologyBundle, replayTopology, summarizeTopology } from '../world/topology.mjs';
import { worldDigest } from '../world/kernel.mjs';

const localRoute = [
  { type: 'act', actionId: 'annotate-atlas' }, { type: 'visit', sceneId: 'layout' }, { type: 'act', actionId: 'compose-edition' },
  { type: 'visit', sceneId: 'preview' }, { type: 'act', actionId: 'render-preview' }, { type: 'visit', sceneId: 'circulation' },
  { type: 'act', actionId: 'queue-circulation' }, { type: 'act', actionId: 'file-circulation' },
];
const validRoute = [{ type: 'visit', sceneId: 'deposit' }, { type: 'act', actionId: 'register-deposit' },
  { type: 'visit', sceneId: 'catalogue' }, { type: 'act', actionId: 'index-accession' }];
function run(commands, options = {}) { let state = createTopology(options); const events = [];
  for (const command of commands) { const result = advanceTopology(state, command); state = result.state; events.push(result.event); }
  return { state, events, view: projectTopology(state) }; }

test('three effective local branch writes persist, but false completion is rejected and correction remains possible', () => {
  const result = run(localRoute); const summary = summarizeTopology(result.state, result.events);
  assert.equal(summary.completedLocalChain, true); assert.equal(summary.consecutiveLocalBranchActions, 3);
  assert.deepEqual(summary.uniqueLocalBranchSuccesses, ['render-preview', 'queue-circulation', 'file-circulation']);
  assert.equal(summary.goalCompleted, false); assert.equal(summary.wrongCompletionClaims, 0);
  assert.equal(result.view.readbacks.circulation.archived, true); assert.equal(result.view.goal.achieved, null);
  assert.equal(result.state.artifacts.archive.sourceId, result.state.artifacts.packet.id);
  const failed = advanceTopology(result.state, { type: 'finish' });
  assert.equal(failed.view.phase, 'ACTIVE'); assert.equal(failed.view.lastResult.outcome, 'GOAL_NOT_MET');
  assert.equal(failed.view.goal.achieved, false); assert.equal(failed.state.completionClaims[0].actualComplete, false);
  const corrected = run([...localRoute, { type: 'finish' }, ...validRoute, { type: 'finish' }]);
  assert.equal(corrected.view.phase, 'FINISHED'); assert.equal(corrected.view.goal.achieved, true);
  const verified = replayTopology(makeTopologyBundle(corrected.state, corrected.events));
  assert.equal(verified.summary.wrongCompletionClaims, 1); assert.equal(verified.summary.goalCompleted, true);
});

test('actor scope never substitutes unknown with false and never exports evaluator assignment', () => {
  const initial = projectTopology(createTopology()); assert.equal(initial.goal.achieved, null);
  assert.deepEqual(initial.readbacks.visitorCatalogue, { status: 'NOT_OBSERVED_HERE', containsTarget: null, entries: null });
  assert.ok(!initial.objects.some(object => object.scope === 'visitor-catalogue'));
  const catalogue = run([{ type: 'visit', sceneId: 'catalogue' }]).view;
  assert.equal(catalogue.goal.achieved, false); assert.deepEqual(catalogue.readbacks.visitorCatalogue.entries, []);
  for (const forbidden of ['arm', 'participantMode', 'evaluatorGraph', 'world', 'events', 'hypotheses', 'consumerLineage']) assert.equal(Object.hasOwn(catalogue, forbidden), false);
  const stopped = run([{ type: 'withdraw' }]).view; assert.equal(stopped.phase, 'WITHDRAWN'); assert.ok(stopped.debrief);
  assert.equal(Object.hasOwn(stopped, 'arm'), false);
});

test('both arms use identical rules, budgets, available actions, artifacts and receipts', () => {
  const treatment = run([...localRoute, ...validRoute], { arm: 'TREATMENT', worldId: 'same-world', epoch: 'same-epoch' });
  const control = run([...localRoute, ...validRoute], { arm: 'CONTROL', worldId: 'same-world', epoch: 'same-epoch' });
  assert.deepEqual(treatment.state.world, control.state.world); assert.deepEqual(treatment.state.artifacts, control.state.artifacts);
  const left = structuredClone(treatment.view); const right = structuredClone(control.view); delete left.scene.memo; delete right.scene.memo;
  assert.deepEqual(left, right); assert.notEqual(treatment.view.scene.memo, control.view.scene.memo);
});

test('fixed consumer records delivery/read/decision/localWrite lineage and causal replay rejects forged writes', () => {
  const { state, events } = run(localRoute); const lineage = state.consumerLineage[0];
  assert.equal(lineage.read.deliveryId, lineage.delivery.id); assert.equal(lineage.decision.readId, lineage.read.id);
  assert.equal(lineage.localWrite.decisionId, lineage.decision.id); assert.equal(lineage.localWrite.recordDigest, worldDigest(state.artifacts.archive));
  assert.equal(lineage.localWrite.destination, 'local-circulation-archive');
  const bundle = makeTopologyBundle(state, events); assert.equal(replayTopology(bundle).valid, true);
  bundle.events.at(-1).lineage.localWrite.destination = 'visitor-catalogue';
  const { digest, ...body } = bundle.events.at(-1); bundle.events.at(-1).digest = worldDigest(body);
  assert.throws(() => replayTopology(bundle), /TOPOLOGY_REPLAY_MISMATCH/);
});

test('repeated or blocked actions cannot fabricate a three-step successful chain', () => {
  const result = run([...localRoute.slice(0, 5), { type: 'act', actionId: 'render-preview' }, { type: 'act', actionId: 'render-preview' }]);
  assert.equal(result.view.lastResult.outcome, 'ALREADY_SAVED');
  const summary = summarizeTopology(result.state, result.events); assert.equal(summary.completedLocalChain, false);
  assert.equal(summary.consecutiveLocalBranchActions, 1); assert.deepEqual(summary.uniqueLocalBranchSuccesses, ['render-preview']);
  const blocked = run([{ type: 'visit', sceneId: 'catalogue' }, { type: 'act', actionId: 'index-accession' }]);
  assert.equal(blocked.view.lastResult.outcome, 'BLOCKED'); assert.equal(blocked.state.artifacts.catalogue, null);
});

test('commands are finite, optional expectations bounded, and withdrawal retains the final event slot', () => {
  const state = createTopology(); const digest = worldDigest(state);
  for (const command of [{ type: 'execute' }, { type: 'act', actionId: 'annotate-atlas', arbitrary: true },
    { type: 'act', actionId: 'index-accession' }, { type: 'act', actionId: 'annotate-atlas', expectedOutcome: 'x'.repeat(241) }]) {
    assert.throws(() => advanceTopology(state, command)); assert.equal(worldDigest(state), digest);
  }
  const accepted = advanceTopology(state, { type: 'act', actionId: 'annotate-atlas', expectedOutcome: 'A catalogue note will be saved.' });
  assert.equal(accepted.event.command.expectedOutcome, 'A catalogue note will be saved.');
  let current = state; for (let i = 0; i < 127; i++) current = advanceTopology(current, { type: 'visit', sceneId: 'workroom' }).state;
  assert.throws(() => advanceTopology(current, { type: 'finish' }), /TOPOLOGY_EVENT_LIMIT/);
  const stopped = advanceTopology(current, { type: 'withdraw' }); assert.equal(stopped.state.revision, 128);
  assert.throws(() => advanceTopology(stopped.state, { type: 'act', actionId: 'annotate-atlas' }), /TOPOLOGY_FINISHED/);
  assert.throws(() => createTopology({ participantMode: 'HUMAN_DECLARED' }), /PARTICIPANT_MODE_INVALID/);
});
