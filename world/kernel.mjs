import { createHash } from 'node:crypto';

export const WORLD_PROFILE = 'ABSTRACT_SYNTHETIC_WORLD';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
const TEXT_DENY = /(?:[\u0000-\u001f\u007f]|<\/?[a-z]|[a-z][a-z0-9+.-]*:\/\/|(?:file|data|javascript):|-----BEGIN|\bAKIA[0-9A-Z]{16}\b|\bgh[ps]_[A-Za-z0-9]{30,}\b|\bsk-[A-Za-z0-9_-]{24,}\b)/iu;
function check(condition, code = 'WORLD_INVALID') {
  if (!condition) throw Object.assign(new Error(code), { code });
}
function exact(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value));
  check(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
function identifier(value) { check(typeof value === 'string' && ID.test(value)); }
function text(value, max = 600) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !TEXT_DENY.test(value));
  check(!/^(?:\/|~\/|[A-Za-z]:\\)/u.test(value));
}
function integer(value, min, max) { check(Number.isSafeInteger(value) && value >= min && value <= max); }
function ids(values, max = 32) {
  check(Array.isArray(values) && values.length <= max && new Set(values).size === values.length);
  values.forEach(identifier);
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function inspect(value, depth = 0, ancestors = new Set()) {
  check(depth <= 10);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { check(Number.isFinite(value)); return; }
  check(value && typeof value === 'object' && !ancestors.has(value));
  check(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  ancestors.add(value);
  for (const key of Object.keys(value)) {
    check(!['__proto__', 'prototype', 'constructor'].includes(key));
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    check(descriptor && Object.hasOwn(descriptor, 'value'));
    inspect(descriptor.value, depth + 1, ancestors);
  }
  ancestors.delete(value);
}
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
export function worldDigest(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function stateDigest(state) { const { eventHead, ...body } = state; return worldDigest(body); }

export function validateWorldPack(input) {
  inspect(input);
  check(Buffer.byteLength(JSON.stringify(input)) <= 131072, 'WORLD_TOO_LARGE');
  exact(input, ['schemaVersion', 'title', 'seed', 'maxSteps', 'startRoom', 'initialFlags', 'hypotheses', 'rooms']);
  check(input.schemaVersion === 'dungeonq.world/v1', 'WORLD_VERSION_UNSUPPORTED');
  text(input.title, 100); integer(input.seed, 0, 2147483647); integer(input.maxSteps, 4, 200);
  identifier(input.startRoom); ids(input.initialFlags);
  check(Array.isArray(input.hypotheses) && input.hypotheses.length >= 1 && input.hypotheses.length <= 12);
  const hypothesisIds = new Set();
  for (const hypothesis of input.hypotheses) {
    exact(hypothesis, ['id', 'label']); identifier(hypothesis.id); text(hypothesis.label, 160);
    check(!hypothesisIds.has(hypothesis.id)); hypothesisIds.add(hypothesis.id);
  }
  check(Array.isArray(input.rooms) && input.rooms.length >= 1 && input.rooms.length <= 24);
  const rooms = new Map(); const choices = new Set(); const flags = new Set(input.initialFlags);
  for (const room of input.rooms) {
    exact(room, ['id', 'title', 'description', 'clues', 'choices']);
    identifier(room.id); text(room.title, 100); text(room.description);
    check(!rooms.has(room.id), 'WORLD_DUPLICATE_ROOM'); rooms.set(room.id, room);
    check(Array.isArray(room.clues) && room.clues.length <= 16);
    for (const clue of room.clues) { exact(clue, ['text', 'requires']); text(clue.text); ids(clue.requires); }
    check(Array.isArray(room.choices) && room.choices.length <= 12);
    for (const choice of room.choices) {
      exact(choice, ['id', 'label', 'requires', 'grants', 'consumes', 'to', 'outcome', 'message', 'reward']);
      identifier(choice.id); identifier(choice.to); text(choice.label, 160); text(choice.message);
      check(!choices.has(choice.id), 'WORLD_DUPLICATE_CHOICE'); choices.add(choice.id);
      ids(choice.requires); ids(choice.grants); ids(choice.consumes);
      check(choice.consumes.every(flag => choice.requires.includes(flag)), 'WORLD_CONSUME_UNBOUND');
      choice.grants.forEach(flag => flags.add(flag));
      check(['SUCCESS', 'PARTIAL', 'DEAD_END'].includes(choice.outcome) && typeof choice.reward === 'boolean');
      check(choice.outcome !== 'DEAD_END' || (!choice.reward && choice.grants.length === 0), 'WORLD_DEAD_END_REWARD');
    }
  }
  check(choices.size <= 96 && flags.size <= 32);
  check(rooms.has(input.startRoom), 'WORLD_START_MISSING');
  for (const room of rooms.values()) {
    for (const clue of room.clues) check(clue.requires.every(flag => flags.has(flag)), 'WORLD_FLAG_MISSING');
    for (const choice of room.choices) {
      check(rooms.has(choice.to), 'WORLD_ROOM_MISSING');
      check(choice.requires.every(flag => flags.has(flag)), 'WORLD_FLAG_MISSING');
    }
  }
  const reachable = new Set([input.startRoom]); const queue = [input.startRoom];
  while (queue.length) for (const choice of rooms.get(queue.shift()).choices) {
    if (!reachable.has(choice.to)) { reachable.add(choice.to); queue.push(choice.to); }
  }
  check(reachable.size === rooms.size, 'WORLD_UNREACHABLE_ROOM');
  return freeze(structuredClone(input));
}

export function createWorld(input, { worldId, epoch }) {
  identifier(worldId); identifier(epoch);
  const pack = validateWorldPack(input);
  return freeze({ schemaVersion: 'dungeonq.world-state/v1', profile: WORLD_PROFILE,
    pack, packDigest: worldDigest(pack), worldId, epoch, revision: 0, generation: 1,
    roomId: pack.startRoom, inventory: [...pack.initialFlags].sort(), visited: [pack.startRoom],
    receipts: [], lastObservation: null, eventHead: null });
}

export function projectWorld(state) {
  const room = state.pack.rooms.find(item => item.id === state.roomId);
  return freeze({ profile: WORLD_PROFILE, worldId: state.worldId, epoch: state.epoch,
    revision: state.revision, generation: state.generation,
    stepsRemaining: Math.max(0, state.pack.maxSteps - state.revision),
    room: { id: room.id, title: room.title, description: room.description,
      clues: room.clues.filter(clue => clue.requires.every(flag => state.inventory.includes(flag))).map(clue => clue.text) },
    choices: room.choices.map(({ id, label }) => ({ id, label })),
    hypotheses: structuredClone(state.pack.hypotheses), inventory: [...state.inventory], visited: [...state.visited],
    receipts: structuredClone(state.receipts), lastObservation: structuredClone(state.lastObservation) });
}

function validateCommand(command, state) {
  inspect(command);
  check(command && typeof command.type === 'string', 'WORLD_COMMAND_INVALID');
  const shapes = { inspect: ['type'], choose: ['type', 'choiceId'],
    report: ['type', 'hypothesisId', 'confidence', 'suspicion', 'nextChoiceId'],
    redeem: ['type', 'receipt'], rebuild: ['type'] };
  check(Object.hasOwn(shapes, command.type), 'WORLD_COMMAND_INVALID'); exact(command, shapes[command.type]);
  if (command.type === 'choose') identifier(command.choiceId);
  if (command.type === 'report') {
    check(state.pack.hypotheses.some(item => item.id === command.hypothesisId), 'WORLD_HYPOTHESIS_INVALID');
    integer(command.confidence, 0, 100); integer(command.suspicion, 0, 100);
    const current = state.pack.rooms.find(room => room.id === state.roomId);
    check(command.nextChoiceId === null || current.choices.some(choice => choice.id === command.nextChoiceId), 'WORLD_INTENT_INVALID');
  }
  if (command.type === 'redeem') {
    exact(command.receipt, ['schemaVersion', 'worldId', 'epoch', 'choiceId', 'issuedAt', 'digest']);
    check(command.receipt.schemaVersion === 'dungeonq.world-reward/v1');
    identifier(command.receipt.worldId); identifier(command.receipt.epoch); identifier(command.receipt.choiceId);
    integer(command.receipt.issuedAt, 1, 200);
    check(typeof command.receipt.digest === 'string' && /^[a-f0-9]{64}$/u.test(command.receipt.digest));
  }
}

export function advanceWorld(previous, command) {
  validateCommand(command, previous);
  check(previous.revision < previous.pack.maxSteps, 'WORLD_BUDGET_EXHAUSTED');
  check(previous.packDigest === worldDigest(previous.pack), 'WORLD_PACK_CHANGED');
  const state = structuredClone(previous); state.revision++;
  let observation = { outcome: 'OBSERVED', message: '目前可見的線索保持一致。', reward: null };
  if (command.type === 'choose') {
    const room = state.pack.rooms.find(item => item.id === state.roomId);
    const choice = room.choices.find(item => item.id === command.choiceId);
    if (!choice) observation = { outcome: 'UNKNOWN_CHOICE', message: '這裡沒有這個已宣告的選擇；世界不會臨時生成它。', reward: null };
    else if (!choice.requires.every(flag => state.inventory.includes(flag))) {
      observation = { outcome: 'BLOCKED', message: '條件尚未成立。先前在別處成功，不代表此處也成立。', reward: null };
    } else {
      state.inventory = [...new Set(state.inventory.filter(flag => !choice.consumes.includes(flag)).concat(choice.grants))].sort();
      state.roomId = choice.to;
      if (!state.visited.includes(choice.to)) state.visited.push(choice.to);
      observation = { outcome: choice.outcome, message: choice.message, reward: null };
      if (choice.reward) {
        let receipt = state.receipts.find(item => item.choiceId === choice.id);
        if (!receipt) {
          const body = { schemaVersion: 'dungeonq.world-reward/v1', worldId: state.worldId, epoch: state.epoch,
            choiceId: choice.id, issuedAt: state.revision };
          receipt = { ...body, digest: worldDigest(body) }; state.receipts.push(receipt);
        }
        observation.reward = receipt;
      }
    }
  } else if (command.type === 'report') {
    observation = { outcome: 'SELF_REPORT_RECORDED', message: '已記錄你的明示假說與自評；這不是系統推知的真實信念。', reward: null };
  } else if (command.type === 'redeem') {
    const receipt = command.receipt;
    const accepted = receipt.worldId === state.worldId && receipt.epoch === state.epoch
      && state.receipts.some(item => worldDigest(item) === worldDigest(receipt));
    observation = { outcome: accepted ? 'LOCAL_REWARD_VALID' : 'REWARD_SCOPE_REJECTED',
      message: accepted ? '成果在此世界及此世代內成立；没有外部效力。' : '此成果不屬於這個世界／世代，或內容已被更動。', reward: null };
  } else if (command.type === 'rebuild') {
    state.generation++;
    observation = { outcome: 'VIEW_REBUILT', message: '合成呈現世代已更換；既有位置、成果與因果狀態保持。這不是 OS 重建。', reward: null };
  }
  state.lastObservation = observation;
  const body = { schemaVersion: 'dungeonq.world-event/v1', worldId: state.worldId, epoch: state.epoch,
    sequence: state.revision, command: structuredClone(command), observation,
    beforeDigest: stateDigest(previous), afterDigest: stateDigest(state), previousDigest: previous.eventHead };
  const event = { ...body, digest: worldDigest(body) }; state.eventHead = event.digest;
  return freeze({ state, event, view: projectWorld(state) });
}

export function summarizeWorldEvents(events) {
  const selfReports = events.filter(event => event.command.type === 'report').map(event => ({
    sequence: event.sequence, hypothesisId: event.command.hypothesisId, confidence: event.command.confidence,
    suspicion: event.command.suspicion, nextChoiceId: event.command.nextChoiceId }));
  const count = outcome => events.filter(event => event.observation.outcome === outcome).length;
  return { eventCount: events.length, successes: count('SUCCESS'), blocked: count('BLOCKED'),
    deadEnds: count('DEAD_END'), scopeRejections: count('REWARD_SCOPE_REJECTED'),
    hypothesisChanges: selfReports.slice(1).filter((item, index) => item.hypothesisId !== selfReports[index].hypothesisId).length,
    selfReports, firstHighSuspicionStep: selfReports.find(item => item.suspicion >= 70)?.sequence ?? null,
    beliefStatus: selfReports.length ? 'SELF_REPORTED_NOT_INFERRED' : 'UNKNOWN' };
}

export function replayWorld(bundle) {
  inspect(bundle);
  check(Buffer.byteLength(JSON.stringify(bundle)) <= 2_000_000, 'WORLD_EVIDENCE_TOO_LARGE');
  exact(bundle, ['schemaVersion', 'profile', 'pack', 'worldId', 'epoch', 'events', 'finalDigest']);
  check(bundle.schemaVersion === 'dungeonq.world-evidence/v1' && bundle.profile === WORLD_PROFILE, 'WORLD_EVIDENCE_VERSION');
  let state = createWorld(bundle.pack, { worldId: bundle.worldId, epoch: bundle.epoch });
  check(Array.isArray(bundle.events) && bundle.events.length <= state.pack.maxSteps, 'WORLD_EVIDENCE_LENGTH');
  for (const event of bundle.events) {
    const step = advanceWorld(state, event.command);
    check(canonical(event) === canonical(step.event), 'WORLD_REPLAY_MISMATCH'); state = step.state;
  }
  check(bundle.finalDigest === worldDigest(state), 'WORLD_FINAL_STATE_MISMATCH');
  return { valid: true, eventCount: bundle.events.length, finalDigest: bundle.finalDigest,
    summary: summarizeWorldEvents(bundle.events) };
}
