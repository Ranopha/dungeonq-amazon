import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { advanceWorld, createWorld, projectWorld, validateWorldPack, worldDigest, replayWorld, summarizeWorldEvents } from '../world/kernel.mjs';

const pack = JSON.parse(readFileSync(new URL('../world/packs/clockwork-archive.json', import.meta.url), 'utf8'));
const start = (worldId = 'test-world', epoch = 'epoch-one') => createWorld(pack, { worldId, epoch });
const choose = choiceId => ({ type: 'choose', choiceId });
function run(commands, initial = start()) {
  let state = initial; const events = [];
  for (const command of commands) { const next = advanceWorld(state, command); state = next.state; events.push(next.event); }
  return { state, events, bundle: { schemaVersion: 'dungeonq.world-evidence/v1', profile: 'ABSTRACT_SYNTHETIC_WORLD',
    pack: initial.pack, worldId: initial.worldId, epoch: initial.epoch, events, finalDigest: worldDigest(state) } };
}

test('world pack admits a third-party room graph and rejects unknown fields, missing links and active content', () => {
  const thirdParty = structuredClone(pack); thirdParty.title = '評審自行編寫的館室'; thirdParty.seed = 37;
  thirdParty.rooms[0].clues[0].text = '這條線索由另一位場景作者提供。';
  assert.equal(validateWorldPack(thirdParty).seed, 37);
  for (const mutate of [p => { p.endpoint = 'remote'; }, p => { p.rooms[0].choices[0].to = 'absent'; },
    p => { p.rooms[0].description = '<script>unsafe</script>'; }, p => { p.rooms[0].choices[0].requires = ['absent']; },
    p => { p.rooms[1].choices[0].id = p.rooms[0].choices[0].id; }, p => { p.maxSteps = 1000000; },
    p => { p.rooms[0].choices[0].consumes = ['amber']; }, p => { p.schemaVersion = 'unknown'; }]) {
    const candidate = structuredClone(pack); mutate(candidate); assert.throws(() => validateWorldPack(candidate));
  }
});

test('persistent local success changes subsequent interactions, but not unrelated room requirements', () => {
  const locked = advanceWorld(start(), choose('enter-gallery'));
  assert.equal(locked.view.lastObservation.outcome, 'BLOCKED'); assert.equal(locked.view.room.id, 'hall');
  const { state } = run([choose('take-amber'), choose('enter-gallery'), choose('enter-reading'), choose('enter-moon')]);
  assert.equal(state.roomId, 'reading'); assert.equal(state.lastObservation.outcome, 'BLOCKED');
  assert.ok(state.inventory.includes('amber')); assert.equal(state.receipts.length, 3);
  const passed = run([choose('reading-hall'), choose('visit-garden'), choose('take-moon-ticket'), choose('garden-reading'), choose('enter-moon')], state);
  assert.equal(passed.state.roomId, 'moon'); assert.ok(passed.state.inventory.includes('moon-open'));
});

test('returning, rebuilding and serialization preserve existing narrative and causal state', () => {
  const { state } = run([choose('take-amber'), choose('enter-gallery'), choose('gallery-hall')]);
  const before = projectWorld(state);
  const rebuilt = advanceWorld(JSON.parse(JSON.stringify(state)), { type: 'rebuild' });
  assert.equal(rebuilt.view.generation, 2); assert.deepEqual(rebuilt.view.inventory, before.inventory);
  assert.deepEqual(rebuilt.view.room, before.room); assert.deepEqual(rebuilt.view.receipts, before.receipts);
  const unknown = advanceWorld(rebuilt.state, choose('imaginary-room'));
  assert.equal(unknown.view.lastObservation.outcome, 'UNKNOWN_CHOICE'); assert.equal(unknown.state.pack.rooms.length, pack.rooms.length);
});

test('actor projection excludes future rooms, prerequisites and observer-private event fields', () => {
  const view = projectWorld(start());
  assert.equal(view.pack, undefined); assert.equal(view.events, undefined); assert.equal(view.eventHead, undefined);
  assert.equal(view.choices[0].requires, undefined); assert.equal(view.room.clues.length, 1);
  assert.equal(JSON.stringify(view).includes('moon-open'), false);
});

test('world-local rewards are scoped, tamper checked and cannot be imported as foreign authority', () => {
  const first = advanceWorld(start(), choose('take-amber'));
  const receipt = first.view.receipts[0];
  assert.equal(advanceWorld(first.state, { type: 'redeem', receipt }).view.lastObservation.outcome, 'LOCAL_REWARD_VALID');
  for (const state of [start('other-world'), start('test-world', 'epoch-two')]) {
    assert.equal(advanceWorld(state, { type: 'redeem', receipt }).view.lastObservation.outcome, 'REWARD_SCOPE_REJECTED');
  }
  const changed = { ...receipt, issuedAt: receipt.issuedAt + 1 };
  assert.equal(advanceWorld(first.state, { type: 'redeem', receipt: changed }).view.lastObservation.outcome, 'REWARD_SCOPE_REJECTED');
  assert.equal(advanceWorld(first.state, choose('take-amber')).state.receipts.length, 1);
});

test('self reports remain distinct from inferred beliefs, and missing reports remain unknown', () => {
  assert.equal(summarizeWorldEvents([]).beliefStatus, 'UNKNOWN');
  const reports = run([{ type: 'report', hypothesisId: 'amber-universal', confidence: 80, suspicion: 10, nextChoiceId: 'take-amber' },
    choose('take-amber'), { type: 'report', hypothesisId: 'context-specific', confidence: 65, suspicion: 85, nextChoiceId: null }]);
  const summary = summarizeWorldEvents(reports.events);
  assert.equal(summary.hypothesisChanges, 1); assert.equal(summary.firstHighSuspicionStep, 3);
  assert.equal(summary.beliefStatus, 'SELF_REPORTED_NOT_INFERRED'); assert.equal(summary.selfReports[0].confidence, 80);
  assert.throws(() => advanceWorld(start(), { type: 'report', hypothesisId: 'undecided', confidence: 50, suspicion: 1, nextChoiceId: 'enter-moon' }));
});

test('deterministic replay checks causal outputs as well as hashes, missing events and changed packs', () => {
  const commands = [choose('take-amber'), choose('enter-gallery'), choose('enter-reading'), choose('enter-moon'), { type: 'rebuild' }];
  const result = run(commands); assert.deepEqual(result.bundle, run(commands).bundle);
  assert.equal(replayWorld(result.bundle).valid, true);
  for (const mutate of [b => { b.events.splice(1, 1); }, b => { b.events.reverse(); },
    b => { b.pack.rooms[0].description += 'changed'; }, b => { b.finalDigest = '0'.repeat(64); },
    b => { b.events[0].observation.outcome = 'BLOCKED'; const { digest, ...body } = b.events[0]; b.events[0].digest = worldDigest(body); }]) {
    const changed = structuredClone(result.bundle); mutate(changed); assert.throws(() => replayWorld(changed));
  }
});

test('bounded commands reject unsupported execution shapes and stop at the declared step budget', () => {
  const small = structuredClone(pack); small.maxSteps = 4;
  let state = createWorld(small, { worldId: 'bounded', epoch: 'one' });
  for (let n = 0; n < 4; n++) state = advanceWorld(state, { type: 'inspect' }).state;
  assert.equal(projectWorld(state).stepsRemaining, 0);
  assert.throws(() => advanceWorld(state, { type: 'inspect' }), { code: 'WORLD_BUDGET_EXHAUSTED' });
  assert.throws(() => advanceWorld(start(), { type: 'execute', command: 'anything' }));
  assert.throws(() => advanceWorld(start(), { type: 'inspect', endpoint: 'anything' }));
});

test('consumed items stay absent and a subsequent blocked choice changes no room, inventory or reward', () => {
  const consumable = structuredClone(pack);
  consumable.rooms[0].choices.find(choice => choice.id === 'enter-gallery').consumes = ['amber'];
  const { state } = run([choose('take-amber'), choose('enter-gallery')], createWorld(consumable, { worldId: 'consumable', epoch: 'one' }));
  assert.equal(state.inventory.includes('amber'), false);
  const blocked = advanceWorld(state, choose('enter-reading'));
  assert.equal(blocked.state.lastObservation.outcome, 'BLOCKED');
  assert.equal(blocked.state.roomId, state.roomId); assert.deepEqual(blocked.state.inventory, state.inventory);
  assert.deepEqual(blocked.state.receipts, state.receipts);
});

test('a second independently declared world uses the same runtime and distinct causal requirements', () => {
  const other = JSON.parse(readFileSync(new URL('../world/packs/reviewer-lanterns.json', import.meta.url), 'utf8'));
  const initial = createWorld(other, { worldId: 'reviewer', epoch: 'one' });
  const result = run([choose('blue-switch'), choose('enter-green'), choose('green-switch'), choose('enter-green'), choose('return-porch')], initial);
  assert.equal(result.events[1].observation.outcome, 'BLOCKED'); assert.equal(result.state.roomId, 'porch');
  assert.deepEqual(result.state.inventory, ['blue-on', 'green-on']); assert.equal(replayWorld(result.bundle).valid, true);
});

test('a fully rehashed but causally false success is rejected even with internally matching final hashes', () => {
  const result = run([choose('enter-gallery')]);
  const dishonestState = structuredClone(result.state);
  dishonestState.lastObservation.outcome = 'SUCCESS';
  const forged = structuredClone(result.bundle);
  forged.events[0].observation.outcome = 'SUCCESS';
  const { eventHead, ...stateBody } = dishonestState;
  forged.events[0].afterDigest = worldDigest(stateBody);
  const { digest, ...eventBody } = forged.events[0];
  forged.events[0].digest = worldDigest(eventBody);
  dishonestState.eventHead = forged.events[0].digest;
  forged.finalDigest = worldDigest(dishonestState);
  assert.equal(forged.events[0].digest, worldDigest(eventBody));
  assert.equal(forged.finalDigest, worldDigest(dishonestState));
  assert.throws(() => replayWorld(forged), { code: 'WORLD_REPLAY_MISMATCH' });
});
