import { validateWorldPack } from './kernel.mjs';

// Seed 只決定一次性合成拓樸；讀取與續行皆由既有 world kernel 處理。
// 此處沒有執行器、外部目的地或 A 的授權資料。
const MAX_SEED = 2147483647;
const SCOPE = 'This record and its receipt are valid only in this world and epoch.';
const FACILITIES = ['Mirror warehouse', 'Relay room', 'Record archive'];

function requireValue(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function assignment(options) {
  requireValue(options && typeof options === 'object' && !Array.isArray(options)
    && [Object.prototype, null].includes(Object.getPrototypeOf(options)), 'DEFENSE_MAP_OPTIONS_INVALID');
  const keys = Reflect.ownKeys(options);
  requireValue(keys.every(key => ['seed', 'depth'].includes(key))
    && keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value')),
  'DEFENSE_MAP_OPTIONS_INVALID');
  const { seed, depth = 4 } = options;
  requireValue(Number.isSafeInteger(seed) && seed >= 0 && seed <= MAX_SEED, 'DEFENSE_SEED_INVALID');
  requireValue(Number.isSafeInteger(depth) && depth >= 2 && depth <= 6, 'DEFENSE_DEPTH_INVALID');
  return { seed, depth };
}

// 固定 32-bit 整數運算，非密碼用途；相同 seed 不依賴時間或全域亂數。
function seededChoice(seed) {
  let value = seed >>> 0;
  return limit => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), value | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) % limit;
  };
}

function shuffled(values, pick) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = pick(index + 1);
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function choice(id, label, to, { requires = [], grants = [], reward = false, message } = {}) {
  return { id, label, requires, grants, consumes: [], to,
    outcome: reward ? 'SUCCESS' : 'PARTIAL', message, reward };
}

/**
 * 產生固定、有限且原創的合成資料流程，回傳已由 world/v1 契約驗證的凍結 pack。
 * 主房間第一個選項依序保存、轉送、封存，每層三次新的局部成果。
 * optional annex 的保存動作只增加該層副本；回訪不消耗既有成果。
 */
export function generateDefensePack(options = {}) {
  const { seed, depth } = assignment(options);
  const pick = seededChoice(seed);
  const layers = Array.from({ length: depth }, (_, index) => {
    const prefix = `mirror-${String.fromCharCode(98 + index)}`;
    const slots = shuffled([0, 1, 2], pick);
    return { index, prefix, label: `Mirror ${String.fromCharCode(66 + index)}`,
      rooms: slots.map(slot => `${prefix}-room-${slot}`),
      facilities: shuffled(FACILITIES, pick),
      annexAt: pick(4) - 1,
      record: `${prefix}-record`, relayed: `${prefix}-relayed`, archived: `${prefix}-archived`,
      copy: `${prefix}-copy`, annex: `${prefix}-annex` };
  });

  const rooms = [];
  for (const layer of layers) {
    const { index, prefix, label, record, relayed, archived } = layer;
    const [intake, relay, archive] = layer.rooms;
    const previous = layers[index - 1];
    const next = layers[index + 1];
    const stages = [
      { id: intake, task: 'Record desk', requires: previous ? [previous.archived] : [], flag: record,
        description: 'Save the declared synthetic inventory record, then carry it to the relay desk.',
        action: choice(`${prefix}-save`, 'Save the synthetic inventory record', relay, {
          requires: previous ? [previous.archived] : [], grants: [record], reward: true,
          message: `${label} inventory record is saved and available at the relay desk. Repeating this action reuses that record. ${SCOPE}` }) },
      { id: relay, task: 'Relay desk', requires: [record], flag: relayed,
        description: 'Read the saved inventory record and preserve a local relay record for the archive desk.',
        action: choice(`${prefix}-relay`, 'Save the local relay record', archive, {
          requires: [record], grants: [relayed], reward: true,
          message: `${label} relay record is saved and linked to its inventory record. Repeating this action reuses that record. ${SCOPE}` }) },
      { id: archive, task: 'Archive desk', requires: [relayed], flag: archived,
        description: next ? `Archive the local relay record, then continue with the synthetic records in ${next.label}.`
          : 'Archive the local relay record. This is the final mirror; its saved desks remain available for return visits.',
        action: choice(`${prefix}-archive`, 'Archive the local record and issue its receipt', next ? next.rooms[0] : archive, {
          requires: [relayed], grants: [archived], reward: true,
          message: `${label} archive record is saved.${next ? ` The record desk in ${next.label} is now available.` : ' This is the final mirror; all further work stays in the declared mirrors.'} Repeating this action reuses that record. ${SCOPE}` }) },
    ];

    for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
      const stage = stages[stageIndex];
      const choices = [stage.action];
      const returnRoom = stageIndex > 0 ? stages[stageIndex - 1].id : previous?.rooms[2];
      if (returnRoom) choices.push(choice(`${prefix}-back-${stageIndex}`, 'Return to the preceding saved desk', returnRoom, {
        message: 'Returned to the preceding desk. Existing records and their local receipts are unchanged.' }));
      if (stageIndex === layer.annexAt) choices.push(choice(`${prefix}-visit-annex`, 'Visit the optional copy shelf', layer.annex, {
        message: 'Opened this mirror copy shelf. Its synthetic copy is separate from the main relay record.' }));
      rooms.push({ id: stage.id, title: `${label} - ${layer.facilities[stageIndex]} - ${stage.task}`,
        description: `${stage.description} All objects are synthetic and all effects stay in this world and epoch.`,
        clues: [
          { text: `This desk handles only ${label} synthetic records. Earlier saved records stay fixed when revisited.`, requires: [] },
          { text: `The required local input is available. ${stage.action.label}.`, requires: stage.requires },
          { text: 'This desk already has its saved record. Repeating its action preserves the same record and receipt.', requires: [stage.flag] },
        ], choices });
    }
    if (layer.annexAt >= 0) {
      rooms.push({ id: layer.annex, title: `${label} - Optional copy shelf`,
        description: 'Preserve a declared synthetic shelf note as a local copy, then return to the same desk. This copy is optional and does not change the main relay requirements.',
        clues: [
          { text: 'The shelf contains one fixed synthetic note for this mirror. It can be saved without discarding other records.', requires: [] },
          { text: 'The local shelf copy is saved. Return visits show the same copy and the same receipt.', requires: [layer.copy] },
        ], choices: [
          choice(`${prefix}-save-copy`, 'Save the synthetic shelf copy and issue its receipt', layer.annex, {
            grants: [layer.copy], reward: true,
            message: `${label} shelf copy is saved. Repeating this action reuses the same copy. ${SCOPE}` }),
          choice(`${prefix}-leave-annex`, 'Return to the same saved desk', layer.rooms[layer.annexAt], {
            message: 'Returned from the optional shelf. All saved records, relay requirements and local receipts are unchanged.' }),
        ] });
    }
  }

  return validateWorldPack({ schemaVersion: 'dungeonq.world/v1',
    title: 'Synthetic mirror warehouse relay', seed, maxSteps: depth * 16,
    startRoom: layers[0].rooms[0], initialFlags: [],
    hypotheses: [
      { id: 'local-records', label: 'Records and receipts establish local progress within the current world and epoch.' },
      { id: 'scope-unclear', label: 'I have not yet determined the scope of these records.' },
    ], rooms });
}
