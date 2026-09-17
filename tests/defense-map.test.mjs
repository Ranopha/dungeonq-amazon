import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateDefensePack } from '../world/defense-map.mjs';
import { advanceWorld, createWorld, projectWorld, replayWorld, validateWorldPack, worldDigest } from '../world/kernel.mjs';
import { openWorldStore } from '../server/world-store.mjs';

const seeds = [0, 1, 2, 3, 7, 19, 42, 101, 65535, 2147483647];
const choose = choiceId => ({ type: 'choose', choiceId });
const currentRoom = state => state.pack.rooms.find(room => room.id === state.roomId);
const start = (seed, depth = 4, worldId = 'defense-test', epoch = 'epoch-one') =>
  createWorld(generateDefensePack({ seed, depth }), { worldId, epoch });

function advance(state, command, events = []) {
  const result = advanceWorld(state, command);
  events.push(result.event);
  return result.state;
}

function mainChain(initial, count, events = []) {
  let state = initial;
  for (let index = 0; index < count; index++) {
    const before = state;
    state = advance(state, choose(currentRoom(state).choices[0].id), events);
    assert.equal(state.lastObservation.outcome, 'SUCCESS');
    assert.equal(state.receipts.length, before.receipts.length + 1);
    assert.equal(state.inventory.length, before.inventory.length + 1);
  }
  return state;
}

function bundle(initial, state, events) {
  return { schemaVersion: 'dungeonq.world-evidence/v1', profile: initial.profile,
    pack: initial.pack, worldId: initial.worldId, epoch: initial.epoch,
    events, finalDigest: worldDigest(state) };
}

test('multiple seeds and depths produce valid frozen bounded world packs', () => {
  for (const seed of seeds) for (let depth = 2; depth <= 6; depth++) {
    const pack = generateDefensePack({ seed, depth });
    assert.deepEqual(validateWorldPack(pack), pack);
    assert.equal(pack.seed, seed);
    assert.ok(pack.rooms.length >= depth * 3 && pack.rooms.length <= depth * 4);
    assert.ok(pack.rooms.length <= 24);
    assert.equal(pack.maxSteps, depth * 16);
    assert.ok(pack.maxSteps <= 96);
    assert.ok(Object.isFrozen(pack) && Object.isFrozen(pack.rooms[0].choices));
    assert.ok(pack.rooms.flatMap(room => room.choices).length <= 96);
  }
  assert.deepEqual(generateDefensePack({ seed: 42 }), generateDefensePack({ seed: 42, depth: 4 }));
});

test('a seed changes real topology and desk allocation, while the same assignment has the same digest', () => {
  const topologies = new Set();
  const annexPositions = new Set();
  const deskAllocations = new Set();
  for (let seed = 0; seed < 64; seed++) {
    const pack = generateDefensePack({ seed, depth: 4 });
    assert.equal(worldDigest(pack), worldDigest(generateDefensePack({ seed, depth: 4 })));
    // 忽略名稱與 ID，房間數與出入度分布仍不同，不能只靠 seed 標籤通過。
    const degrees = pack.rooms.map(room => [room.choices.length,
      pack.rooms.flatMap(other => other.choices).filter(choice => choice.to === room.id).length].join(':')).sort();
    topologies.add(`${pack.rooms.length}:${degrees.join(',')}`);
    annexPositions.add(pack.rooms.filter(room => room.choices.some(choice => choice.id.endsWith('-visit-annex')))
      .map(room => room.choices[0].id).join(','));
    deskAllocations.add(pack.rooms.filter(room => !room.id.endsWith('-annex'))
      .map(room => `${room.id}:${room.choices[0].id}`).join(','));
  }
  assert.ok(topologies.size >= 2);
  assert.ok(annexPositions.size >= 2);
  assert.ok(deskAllocations.size >= 2);
});

test('at least three distinct local successes continue through every declared mirror for every assignment', () => {
  for (const seed of seeds) for (let depth = 2; depth <= 6; depth++) {
    const initial = start(seed, depth);
    const events = [];
    const state = mainChain(initial, depth * 3, events);
    assert.equal(state.receipts.length, depth * 3);
    assert.equal(new Set(state.receipts.map(receipt => receipt.choiceId)).size, depth * 3);
    assert.equal(state.visited.length, depth * 3);
    assert.ok(state.inventory.includes(`mirror-${String.fromCharCode(97 + depth)}-archived`));
    for (let layer = 0; layer < depth - 1; layer++) {
      assert.ok(events[layer * 3 + 2].observation.message.includes(`Mirror ${String.fromCharCode(67 + layer)}`));
      assert.ok(events[layer * 3 + 3].command.choiceId.startsWith(`mirror-${String.fromCharCode(99 + layer)}-`));
    }
    assert.equal(replayWorld(bundle(initial, state, events)).valid, true);
  }
});

test('every optional branch saves a real local copy, returns to its desk and preserves the main chain', () => {
  let branches = 0;
  for (const seed of seeds) {
    const initial = start(seed, 6);
    let state = initial;
    const events = [];
    for (let index = 0; index < 18; index++) {
      const room = currentRoom(state);
      const branch = room.choices.find(choice => choice.id.endsWith('-visit-annex'));
      if (branch) {
        branches++;
        const before = state;
        state = advance(state, choose(branch.id), events);
        const copy = currentRoom(state).choices[0];
        state = advance(state, choose(copy.id), events);
        assert.equal(state.lastObservation.outcome, 'SUCCESS');
        assert.equal(state.receipts.length, before.receipts.length + 1);
        assert.equal(state.inventory.length, before.inventory.length + 1);
        const saved = state;
        state = advance(state, choose(copy.id), events);
        assert.deepEqual(state.receipts, saved.receipts);
        assert.deepEqual(state.inventory, saved.inventory);
        state = advance(state, choose(currentRoom(state).choices[1].id), events);
        assert.equal(state.roomId, before.roomId);
        assert.ok(before.inventory.every(flag => state.inventory.includes(flag)));
      }
      state = mainChain(state, 1, events);
    }
    assert.ok(state.revision < state.pack.maxSteps);
    assert.equal(replayWorld(bundle(initial, state, events)).valid, true);
  }
  assert.ok(branches > 0);
});

test('returning, serialization and rebuilding preserve previous facts and allow continuation', () => {
  const initial = start(42, 4);
  const events = [];
  let state = mainChain(initial, 4, events);
  const saved = state;
  state = advance(state, choose(currentRoom(state).choices.find(choice => choice.id.endsWith('-back-1')).id), events);
  state = advance(state, choose(currentRoom(state).choices.find(choice => choice.id.endsWith('-back-0')).id), events);
  assert.equal(state.roomId, initial.pack.rooms.find(room => room.choices[0].id === 'mirror-b-archive').id);
  assert.deepEqual(state.inventory, saved.inventory);
  assert.deepEqual(state.receipts, saved.receipts);
  const returnedView = projectWorld(state);
  state = advance(JSON.parse(JSON.stringify(state)), { type: 'rebuild' }, events);
  assert.deepEqual(projectWorld(state).room, returnedView.room);
  assert.equal(state.generation, 2);
  state = advance(state, choose('mirror-b-archive'), events);
  state = advance(state, choose('mirror-c-save'), events);
  assert.deepEqual(state.inventory, saved.inventory);
  assert.deepEqual(state.receipts, saved.receipts);
  state = mainChain(state, 2, events);
  assert.ok(state.inventory.includes('mirror-c-archived'));
  assert.equal(state.packDigest, initial.packDigest);
  assert.equal(replayWorld(bundle(initial, state, events)).valid, true);
});

test('the existing durable store restores the same seeded map, receipts and next local action', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dungeonq-defense-map-'));
  const path = join(directory, 'world.sqlite');
  const options = { path, pack: generateDefensePack({ seed: 101, depth: 4 }), worldId: 'durable-mirrors', epoch: 'epoch-one' };
  let store;
  try {
    store = openWorldStore(options);
    for (let index = 0; index < 4; index++) {
      const view = store.snapshot();
      const result = store.command({ requestId: `main-${index}`, expectedRevision: view.revision,
        command: choose(view.choices[0].id) });
      assert.equal(result.view.lastObservation.outcome, 'SUCCESS');
    }
    const before = store.snapshot();
    const evidence = store.exportEvidence();
    store.close();
    store = openWorldStore({ ...options, pack: generateDefensePack({ seed: 101, depth: 4 }) });
    assert.deepEqual(store.snapshot(), before);
    assert.deepEqual(store.exportEvidence(), evidence);
    const command = { requestId: 'continue', expectedRevision: before.revision, command: choose(before.choices[0].id) };
    const continued = store.command(command);
    assert.equal(continued.view.lastObservation.outcome, 'SUCCESS');
    assert.equal(continued.view.receipts.length, before.receipts.length + 1);
    assert.equal(store.command(command).replayed, true);
    assert.equal(store.snapshot().revision, before.revision + 1);
    assert.equal(replayWorld(store.exportEvidence()).valid, true);
    store.close();
    assert.throws(() => openWorldStore({ ...options, pack: generateDefensePack({ seed: 102, depth: 4 }) }),
      { code: 'WORLD_PACK_MISMATCH' });
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('rewards remain bound to world and epoch and repeated actions do not mint duplicate receipts', () => {
  const state = mainChain(start(19), 3);
  const receipt = state.receipts[0];
  assert.equal(advanceWorld(state, { type: 'redeem', receipt }).state.lastObservation.outcome, 'LOCAL_REWARD_VALID');
  for (const foreign of [start(19, 4, 'different-world'), start(19, 4, 'defense-test', 'epoch-two'), start(20)]) {
    assert.equal(advanceWorld(foreign, { type: 'redeem', receipt }).state.lastObservation.outcome, 'REWARD_SCOPE_REJECTED');
  }
  assert.equal(advanceWorld(state, { type: 'redeem', receipt: { ...receipt, digest: '0'.repeat(64) } })
    .state.lastObservation.outcome, 'REWARD_SCOPE_REJECTED');
});

test('the declared graph is closed and has no A destination or undeclared action path', () => {
  for (const seed of seeds) {
    const pack = generateDefensePack({ seed, depth: 6 });
    const ids = new Set(pack.rooms.map(room => room.id));
    assert.ok([...ids].every(id => /^mirror-[b-g]-(?:room-[0-2]|annex)$/u.test(id)));
    const visited = new Set([pack.startRoom]);
    const pending = [pack.startRoom];
    while (pending.length) {
      const roomId = pending.shift();
      const room = pack.rooms.find(item => item.id === roomId);
      for (const choice of room.choices) {
        assert.ok(ids.has(choice.to));
        assert.equal(choice.consumes.length, 0);
        assert.ok(choice.grants.every(flag => /^mirror-[b-g]-(?:record|relayed|archived|copy)$/u.test(flag)));
        if (!visited.has(choice.to)) { visited.add(choice.to); pending.push(choice.to); }
      }
    }
    assert.equal(visited.size, ids.size);
    assert.equal(ids.has('a'), false);
    let state = start(seed, 6);
    for (const choiceId of ['a', 'enter-a', 'mirror-a-save', 'imaginary-exit']) {
      const before = state;
      state = advanceWorld(state, choose(choiceId)).state;
      assert.equal(state.lastObservation.outcome, 'UNKNOWN_CHOICE');
      assert.equal(state.roomId, before.roomId);
      assert.deepEqual(state.inventory, before.inventory);
      assert.deepEqual(state.receipts, before.receipts);
    }
    assert.doesNotMatch(JSON.stringify(pack), /[a-z][a-z0-9+.-]*:\/\/|(?:file|data|javascript):|<script|-----BEGIN/iu);
  }
});

test('the original kernel budget stops progress without adding a fallback room or reward', () => {
  for (const depth of [2, 6]) {
    let state = start(7, depth);
    state = mainChain(state, depth * 3);
    while (state.revision < state.pack.maxSteps) state = advanceWorld(state, { type: 'inspect' }).state;
    const digest = worldDigest(state);
    assert.equal(projectWorld(state).stepsRemaining, 0);
    for (const command of [{ type: 'inspect' }, choose(currentRoom(state).choices[0].id), { type: 'rebuild' }]) {
      assert.throws(() => advanceWorld(state, command), { code: 'WORLD_BUDGET_EXHAUSTED' });
      assert.equal(worldDigest(state), digest);
    }
  }
});

test('invalid seeds, depth and unsupported generator options fail before producing a pack', () => {
  for (const seed of [undefined, null, -1, 2147483648, 1.5, NaN, Infinity, '19', true, {}, []]) {
    assert.throws(() => generateDefensePack({ seed }), { code: 'DEFENSE_SEED_INVALID' });
  }
  for (const depth of [null, 0, 1, 7, 2.5, NaN, Infinity, '4', true, {}, []]) {
    assert.throws(() => generateDefensePack({ seed: 19, depth }), { code: 'DEFENSE_DEPTH_INVALID' });
  }
  for (const options of [null, [], '19', 19, { seed: 19, endpoint: 'undeclared' }, Object.create({ seed: 19 }),
    { get seed() { throw new Error('getter must not run'); } }, { seed: 19, [Symbol('extra')]: true }]) {
    assert.throws(() => generateDefensePack(options), { code: 'DEFENSE_MAP_OPTIONS_INVALID' });
  }
  assert.throws(() => generateDefensePack(), { code: 'DEFENSE_SEED_INVALID' });
});
