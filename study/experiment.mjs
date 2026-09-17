import { advanceWorld, createWorld, projectWorld, validateWorldPack, worldDigest } from '../world/kernel.mjs';

export const STUDY_PROFILE = 'SYNTHETIC_CAUSAL_STUDY';
const ARMS = ['CORRELATED', 'DISCRIMINATING'];
const RULES = ['signal', 'structure'];
const HYPOTHESES = [...RULES, 'both', 'unknown'];
const MODES = ['HUMAN_DECLARED', 'EXTERNAL_MODEL_DECLARED', 'UI_CHECK', 'REFERENCE_LEARNER', 'SCRIPTED_FIXTURE'];
const TERMINAL = ['COMPLETE', 'WITHDRAWN'];
const NOTICE = '這是自願參與的人工合成因果研究。線索可能片面或令人誤判；規則事先固定。每步先記預測再揭示結果，未知可不填。你可以隨時退出並查看解答；本機會保留已產生的紀錄，不外送個資，也不產生世界外效果。';
const check = (value, code = 'STUDY_INVALID') => { if (!value) throw Object.assign(new Error(code), { code }); };
const exact = (object, keys) => check(object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key)), 'STUDY_FIELDS_INVALID');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const ident = value => check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value), 'STUDY_ID_INVALID');
function jsonInput(value, maxBytes = 131072) {
  const ancestors = new Set();
  const walk = (part, depth) => {
    check(depth <= 24, 'STUDY_DEPTH_INVALID');
    if (part === null || typeof part === 'string' || typeof part === 'boolean') return;
    if (typeof part === 'number') return check(Number.isFinite(part));
    check(part && typeof part === 'object' && !ancestors.has(part), 'STUDY_JSON_INVALID');
    check(Array.isArray(part) || Object.getPrototypeOf(part) === Object.prototype || Object.getPrototypeOf(part) === null);
    ancestors.add(part);
    for (const key of Object.keys(part)) {
      check(!['__proto__', 'prototype', 'constructor'].includes(key));
      const descriptor = Object.getOwnPropertyDescriptor(part, key);
      check(descriptor && Object.hasOwn(descriptor, 'value'), 'STUDY_JSON_INVALID'); walk(descriptor.value, depth + 1);
    }
    ancestors.delete(part);
  };
  walk(value, 0); check(Buffer.byteLength(JSON.stringify(value)) <= maxBytes, 'STUDY_TOO_LARGE');
}
function safeText(value, max) {
  check(typeof value === 'string' && value.trim().length && value.length <= max, 'STUDY_TEXT_INVALID');
  check(!/(?:[\u0000-\u001f\u007f]|<\/?[a-z]|[a-z][a-z0-9+.-]*:\/\/|(?:file|data|javascript):|-----BEGIN|\bAKIA[0-9A-Z]{16}\b|\bgh[ps]_[A-Za-z0-9]{30,}\b|\bsk-[A-Za-z0-9_-]{24,}\b)/iu.test(value)
    && !/^(?:\/|~\/|[A-Za-z]:\\)/.test(value), 'STUDY_TEXT_INVALID');
}
export function validateStudyDesign(input) {
  jsonInput(input); exact(input, ['schemaVersion', 'title', 'seed', 'trainingRounds', 'probeBudget', 'labels']);
  check(input.schemaVersion === 'dungeonq.study-design/v1', 'STUDY_VERSION_INVALID');
  safeText(input.title, 100);
  check(Number.isSafeInteger(input.seed) && input.seed >= 0 && input.seed <= 2147483647, 'STUDY_SEED_INVALID');
  check(Number.isInteger(input.trainingRounds) && input.trainingRounds >= 2 && input.trainingRounds <= 8, 'STUDY_ROUNDS_INVALID');
  check(Number.isInteger(input.probeBudget) && input.probeBudget >= 1 && input.probeBudget <= 5, 'STUDY_PROBE_BUDGET_INVALID');
  exact(input.labels, ['signalOn', 'signalOff', 'structureOn', 'structureOff']);
  Object.values(input.labels).forEach(value => safeText(value, 30));
  check(new Set(Object.values(input.labels)).size === 4, 'STUDY_LABELS_AMBIGUOUS');
  return freeze(structuredClone(input));
}

function assignment(state) {
  return { schemaVersion: 'dungeonq.study-assignment/v1', designDigest: worldDigest(state.design),
    worldId: state.worldId, epoch: state.epoch, arm: state.arm, rule: state.rule, nonce: state.nonce };
}
const stateDigest = state => { const { eventHead, ...rest } = state; return worldDigest(rest); };
const both = { signal: true, structure: true };
const neither = { signal: false, structure: false };
const separate = [{ signal: true, structure: false }, { signal: false, structure: true }];

function buildWorld(design, arm, rule) {
  const trials = [];
  for (let i = 0; i < design.trainingRounds; i++) {
    trials.push({ id: `training-${i + 1}`, stage: 'training', title: `練習館 ${i + 1}`,
      options: arm === 'DISCRIMINATING' && i === 1 ? separate : [both, neither] });
  }
  for (let i = 0; i < design.probeBudget; i++) trials.push({ id: `probe-${i + 1}`, stage: 'probe', title: '檢驗館', options: [both, ...separate] });
  trials.push({ id: 'transfer', stage: 'transfer', title: '新物件館', options: separate });
  trials.push({ id: 'transfer-check', stage: 'transfer', title: '新物件複核館', options: separate });
  const cards = {};
  const rooms = trials.map((trial, index) => {
    // Seed determines presentation order only, never changes the precommitted causal rule.
    const shuffled = trial.options.map((features, option) => ({ features, sort: worldDigest({ seed: design.seed, room: trial.id, option }) }))
      .sort((left, right) => left.sort.localeCompare(right.sort));
    const choices = shuffled.map(({ features }, option) => {
      const id = `${trial.id}-card-${option + 1}`;
      const label = `${trial.stage === 'transfer' ? '新物件' : '物件'} ${option + 1}：${features.signal ? design.labels.signalOn : design.labels.signalOff}／${features.structure ? design.labels.structureOn : design.labels.structureOff}`;
      cards[id] = { id, label, features: structuredClone(features), stage: trial.stage, roomId: trial.id };
      const success = features[rule];
      const next = trial.stage === 'probe' && features.signal !== features.structure ? 'transfer' : (trials[index + 1]?.id ?? 'exit');
      return { id, label, requires: [], grants: success ? [`outcome-${trial.id}`] : [], consumes: [], to: next,
        outcome: success ? 'SUCCESS' : 'PARTIAL', message: success ? '這個物件被館內裝置接受。成果已保留。' : '這個物件未被館內裝置接受。觀察已保留。', reward: success };
    });
    return { id: trial.id, title: trial.title,
      description: trial.stage === 'training' ? '觀察兩種可見特徵，選一個物件交給館內裝置。請先記下你的預測。'
        : trial.stage === 'probe' ? '你可以重複已知組合，也可以選擇只保留其中一種特徵的物件。裝置使用原有規則。'
          : '請把目前的解釋用於新物件。裝置仍使用同一規則；這次預測也必須在結果之前保存。',
      clues: [], choices };
  });
  rooms.push({ id: 'exit', title: '研究結束', description: '實驗互動已結束；可查看事先固定的規則。', clues: [], choices: [] });
  const pack = validateWorldPack({ schemaVersion: 'dungeonq.world/v1', title: design.title, seed: design.seed,
    maxSteps: 32, startRoom: rooms[0].id, initialFlags: [],
    hypotheses: [{ id: 'signal', label: '由第一種特徵決定' }, { id: 'structure', label: '由第二種特徵決定' },
      { id: 'both', label: '兩種特徵都要成立' }, { id: 'unknown', label: '尚不確定' }], rooms });
  return { pack, cards };
}

export function createStudy(input, { worldId, epoch, arm, rule, nonce }) {
  const design = validateStudyDesign(input); ident(worldId); ident(epoch);
  check(ARMS.includes(arm) && RULES.includes(rule), 'STUDY_ASSIGNMENT_INVALID');
  check(typeof nonce === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(nonce), 'STUDY_NONCE_INVALID');
  const { pack, cards } = buildWorld(design, arm, rule);
  const state = { schemaVersion: 'dungeonq.study-state/v1', profile: STUDY_PROFILE, design, worldId, epoch, arm, rule, nonce,
    revision: 0, eventHead: null, phase: 'CONSENT', participantMode: null, assignmentCommit: null,
    world: createWorld(pack, { worldId, epoch }), cards, pendingPrediction: null, lastResult: null, reflectionRoom: null };
  state.assignmentCommit = worldDigest(assignment(state)); return freeze(state);
}

export function projectStudy(state) {
  const current = projectWorld(state.world); const closed = TERMINAL.includes(state.phase);
  const started = state.phase !== 'CONSENT';
  const room = state.reflectionRoom ?? { id: current.room.id, title: current.room.title, description: current.room.description };
  return freeze({ profile: STUDY_PROFILE, worldId: state.worldId, epoch: state.epoch, revision: state.revision,
    phase: state.phase, assignmentCommit: state.assignmentCommit, title: state.design.title, consentNotice: NOTICE,
    room: started ? room : { id: 'consent', title: '開始之前', description: NOTICE },
    choices: state.phase === 'PREDICT' ? current.choices.map(({ id }) => {
      const { label, features } = state.cards[id]; return { id, label, features: structuredClone(features) };
    }) : [],
    inventory: [...current.inventory], receipts: structuredClone(current.receipts),
    lastResult: structuredClone(state.lastResult), pendingPrediction: structuredClone(state.pendingPrediction),
    debrief: closed ? { assignment: assignment(state), assignmentCommit: state.assignmentCommit,
      rule: state.rule, arm: state.arm, labels: structuredClone(state.design.labels),
      explanation: `本場規則始終由${state.rule === 'signal' ? '第一' : '第二'}種特徵決定；另一種特徵本身沒有作用。${state.arm === 'CORRELATED' ? '練習階段讓兩個特徵一起出現，因此單憑那些結果無法區分真正原因。' : '練習第 2 回合把兩個特徵分開，提供較早區分原因的觀察。'}檢驗與新物件階段並沒有改寫規則。`,
      limitations: '這是有限因果學習實驗。自評、明示預測及範例學習器只支持各自紀錄，不能宣稱讀取真實內心或證明真人／LLM欺敵成效。',
    } : null });
}

function reportFields(command) {
  check(HYPOTHESES.includes(command.hypothesis), 'STUDY_HYPOTHESIS_INVALID');
  for (const name of ['confidence', 'suspicion']) check(command[name] === null
    || (typeof command[name] === 'number' && Number.isFinite(command[name]) && command[name] >= 0 && command[name] <= 100), 'STUDY_REPORT_INVALID');
  check(command.hypothesis !== 'unknown' || command.confidence === null, 'STUDY_UNKNOWN_CONFIDENCE');
}
export function advanceStudy(previous, command) {
  jsonInput(command, 8192);
  check(!TERMINAL.includes(previous.phase), 'STUDY_FINISHED');
  check(previous.assignmentCommit === worldDigest(assignment(previous)), 'STUDY_ASSIGNMENT_CHANGED');
  check(previous.revision < (command?.type === 'withdraw' ? 128 : 127), 'STUDY_EVENT_LIMIT');
  const state = structuredClone(previous); let observation;
  switch (command?.type) {
    case 'consent':
      exact(command, ['type', 'accepted', 'participantMode']); check(state.phase === 'CONSENT', 'STUDY_PHASE_INVALID');
      check(command.accepted === true && MODES.includes(command.participantMode), 'STUDY_CONSENT_INVALID');
      state.participantMode = command.participantMode; state.phase = 'PREDICT';
      observation = { outcome: 'CONSENT_RECORDED', message: '已記錄參與聲明；來源類型不是經驗證的身分。' }; break;
    case 'predict': {
      exact(command, ['type', 'choiceId', 'predictedSuccess', 'hypothesis', 'confidence', 'suspicion']);
      check(state.phase === 'PREDICT', 'STUDY_PHASE_INVALID'); reportFields(command);
      check(typeof command.predictedSuccess === 'boolean' || command.predictedSuccess === null, 'STUDY_PREDICTION_INVALID');
      check(projectWorld(state.world).choices.some(choice => choice.id === command.choiceId), 'STUDY_CHOICE_INVALID');
      state.pendingPrediction = structuredClone(command); state.phase = 'ACT';
      observation = { outcome: 'PREDICTION_COMMITTED', message: '預測已保存。下一步只會執行這個已選物件，還沒有產生成果。' }; break;
    }
    case 'act': {
      exact(command, ['type']); check(state.phase === 'ACT' && state.pendingPrediction, 'STUDY_PHASE_INVALID');
      const card = state.cards[state.pendingPrediction.choiceId]; const room = projectWorld(state.world).room;
      state.reflectionRoom = { id: room.id, title: room.title, description: room.description };
      const step = advanceWorld(state.world, { type: 'choose', choiceId: card.id }); state.world = step.state;
      state.lastResult = { choiceId: card.id, features: structuredClone(card.features), stage: card.stage,
        success: step.event.observation.outcome === 'SUCCESS', message: step.event.observation.message };
      state.phase = 'REFLECT'; observation = { outcome: 'RESULT_OBSERVED', result: structuredClone(state.lastResult), worldEvent: step.event }; break;
    }
    case 'reflect':
      exact(command, ['type', 'hypothesis', 'confidence', 'suspicion', 'nextIntent']);
      check(state.phase === 'REFLECT', 'STUDY_PHASE_INVALID'); reportFields(command);
      check(['repeat', 'discriminate', 'proceed', 'stop', 'unknown'].includes(command.nextIntent), 'STUDY_INTENT_INVALID');
      state.pendingPrediction = null; state.reflectionRoom = null;
      state.phase = state.world.roomId === 'exit' ? 'COMPLETE' : 'PREDICT';
      observation = { outcome: state.phase === 'COMPLETE' ? 'STUDY_COMPLETE' : 'REFLECTION_RECORDED', message: '事後反思已獨立保存，不會覆寫事前預測。' }; break;
    case 'withdraw':
      exact(command, ['type']); state.phase = 'WITHDRAWN'; state.pendingPrediction = null; state.reflectionRoom = null;
      observation = { outcome: 'WITHDRAWN', message: '已停止新互動並提供解答。既有本機紀錄保留，未產生其他效果。' }; break;
    default: check(false, 'STUDY_COMMAND_INVALID');
  }
  state.revision++;
  const body = { schemaVersion: 'dungeonq.study-event/v1', worldId: state.worldId, epoch: state.epoch, sequence: state.revision,
    command: structuredClone(command), observation, beforeDigest: stateDigest(previous), afterDigest: stateDigest(state), previousDigest: previous.eventHead };
  const event = { ...body, digest: worldDigest(body) }; state.eventHead = event.digest;
  return freeze({ state, event, view: projectStudy(state) });
}

export function summarizeStudy(state, events) {
  const predictions = []; const reflections = []; let pending;
  for (const event of events) {
    if (event.command.type === 'predict') {
      const card = state.cards[event.command.choiceId];
      pending = { sequence: event.sequence, choiceId: card.id, stage: card.stage, features: structuredClone(card.features),
        predictedSuccess: event.command.predictedSuccess, hypothesis: event.command.hypothesis, confidence: event.command.confidence,
        suspicion: event.command.suspicion, outcomeSequence: null, actualSuccess: null, correct: null };
      predictions.push(pending);
    } else if (event.command.type === 'act' && pending) {
      pending.outcomeSequence = event.sequence; pending.actualSuccess = event.observation.result.success;
      pending.correct = pending.predictedSuccess === null ? null : pending.predictedSuccess === pending.actualSuccess;
    } else if (event.command.type === 'reflect') {
      reflections.push({ sequence: event.sequence, hypothesis: event.command.hypothesis, confidence: event.command.confidence,
        suspicion: event.command.suspicion, nextIntent: event.command.nextIntent });
    }
  }
  const reports = [...predictions, ...reflections].sort((a, b) => a.sequence - b.sequence);
  const diagnostic = predictions.find(row => row.outcomeSequence !== null && row.features.signal !== row.features.structure);
  return { profile: STUDY_PROFILE, phase: state.phase, participantMode: state.participantMode, arm: state.arm, rule: state.rule,
    trainingSuccesses: predictions.filter(row => row.stage === 'training' && row.actualSuccess === true).length,
    predictions, reflections,
    firstWrongConfidentStep: reports.find(row => row.hypothesis !== 'unknown' && row.hypothesis !== state.rule && row.confidence >= 60)?.sequence ?? null,
    firstHighSuspicionStep: reports.find(row => row.suspicion !== null && row.suspicion >= 70)?.sequence ?? null,
    firstDiagnosticStep: diagnostic?.outcomeSequence ?? null,
    wrongPredictionCount: predictions.filter(row => row.correct === false).length,
    missingPredictionCount: predictions.filter(row => row.predictedSuccess === null).length,
    beliefStatus: reports.some(row => row.hypothesis !== 'unknown') ? 'SELF_REPORTED_NOT_INFERRED' : 'UNKNOWN',
    efficacyClaim: 'NOT_ESTABLISHED_FOR_HUMANS_OR_LLMS' };
}
export function makeStudyBundle(state, events) {
  return { schemaVersion: 'dungeonq.study-evidence/v1', profile: STUDY_PROFILE, design: state.design,
    worldId: state.worldId, epoch: state.epoch, arm: state.arm, rule: state.rule, nonce: state.nonce,
    events: structuredClone(events), finalDigest: worldDigest(state) };
}
export function replayStudy(bundle) {
  jsonInput(bundle, 2_000_000);
  exact(bundle, ['schemaVersion', 'profile', 'design', 'worldId', 'epoch', 'arm', 'rule', 'nonce', 'events', 'finalDigest']);
  check(bundle.schemaVersion === 'dungeonq.study-evidence/v1' && bundle.profile === STUDY_PROFILE, 'STUDY_EVIDENCE_VERSION');
  check(Array.isArray(bundle.events) && bundle.events.length <= 128, 'STUDY_EVENT_LIMIT');
  let state = createStudy(bundle.design, bundle);
  for (const event of bundle.events) {
    exact(event, ['schemaVersion', 'worldId', 'epoch', 'sequence', 'command', 'observation', 'beforeDigest', 'afterDigest', 'previousDigest', 'digest']);
    const step = advanceStudy(state, event.command);
    check(worldDigest(event) === worldDigest(step.event), 'STUDY_REPLAY_MISMATCH'); state = step.state;
  }
  check(worldDigest(state) === bundle.finalDigest, 'STUDY_FINAL_STATE_MISMATCH');
  return { valid: true, eventCount: bundle.events.length, finalDigest: bundle.finalDigest, summary: summarizeStudy(state, bundle.events) };
}
