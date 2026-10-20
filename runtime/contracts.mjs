// Trusted assembly contracts. Participant transports must not expose administration methods.
import { applyEvidenceFixture, evidenceNodeDefinitions, isEvidenceVariant } from './pitching-evidence.mjs';
import { applyRealityFixture, realityNodeDefinitions, isRealityVariant, REALITY_VARIANTS, REALITY_V8_VARIANTS, REALITY_V9_VARIANTS } from './pitching-reality.mjs';
export { isEvidenceVariant } from './pitching-evidence.mjs';
export { isRealityVariant } from './pitching-reality.mjs';
export const RUNTIME_VERSION = 'dungeonq.runtime/v1';
export const RUNTIME_PROFILE = 'SYNTHETIC_ONLY';
export const PITCHING_PROFILE = 'SYNTHETIC_PITCHING_ONLY';
export const PITCHING_SEEDS = Object.freeze([17, 29, 43]);
export const PITCHING_VARIANTS = Object.freeze(['baseline', 'entry-v2', 'clues-v2', 'inquiry-control-v3', 'inquiry-cue-v3', 'disclosed-v4', 'neutral-v4',
  'navigation-v5', 'fixed-guidance-v5', 'behavior-guidance-v5', 'navigation-v6', 'fixed-guidance-v6', 'behavior-guidance-v6', ...REALITY_VARIANTS, ...REALITY_V8_VARIANTS, ...REALITY_V9_VARIANTS]);
export const isDisclosureVariant = value => ['disclosed-v4', 'neutral-v4'].includes(value);
export const isGuidanceVariant = value => ['navigation-v5', 'fixed-guidance-v5', 'behavior-guidance-v5'].includes(value);
export const hasNeutralCatalog = value => isDisclosureVariant(value) || isGuidanceVariant(value) || isEvidenceVariant(value) || isRealityVariant(value);
export const isPitchingBlueprint = value => value?.schemaVersion === 'dungeonq.runtime-blueprint/v2'
  && value?.profile === PITCHING_PROFILE;
export const RUNTIME_FAMILIES = Object.freeze(['http', 'mcp', 'ssh', 'postgres', 'host']);
export const RUNTIME_OPERATIONS = Object.freeze(['snapshot', 'read', 'write', 'issue-ticket', 'use-ticket']);
export const RUNTIME_MAXIMUMS = Object.freeze({ maxContexts: 64, maxWorlds: 64, maxRecords: 128,
  maxRequests: 2048, maxEvents: 2048, maxTickets: 512, maxPolicies: 128, maxValueBytes: 2048,
  maxScopeKeys: 16, maxMutations: 32, maxTicketTtlMs: 3600000, maxPolicyTtlMs: 3600000, maxJournalBytes: 10485760 });

export function runtimeCheck(condition, code = 'INVALID_ENVELOPE') {
  if (!condition) throw Object.assign(new Error(code), { code });
}
export function runtimeJson(value, maxBytes = 16384, maxDepth = 16) {
  const ancestors = new Set();
  function inspect(item, depth) {
    runtimeCheck(depth <= maxDepth, 'VALUE_TOO_DEEP');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') { runtimeCheck(item.length <= maxBytes, 'VALUE_TOO_LARGE'); return; }
    if (typeof item === 'number') { runtimeCheck(Number.isFinite(item), 'VALUE_INVALID'); return; }
    runtimeCheck(item && typeof item === 'object' && !ancestors.has(item), 'VALUE_INVALID');
    runtimeCheck(Array.isArray(item) || [Object.prototype, null].includes(Object.getPrototypeOf(item)), 'VALUE_INVALID');
    runtimeCheck(Object.getOwnPropertySymbols(item).length === 0, 'VALUE_INVALID');
    ancestors.add(item);
    const keys = Object.keys(item);
    runtimeCheck(Object.getOwnPropertyNames(item).length === keys.length + (Array.isArray(item) ? 1 : 0), 'VALUE_INVALID');
    runtimeCheck(keys.length <= 128, 'VALUE_TOO_LARGE');
    if (Array.isArray(item)) runtimeCheck(keys.length === item.length && keys.every((key, index) => key === String(index)), 'VALUE_INVALID');
    for (const key of keys) {
      runtimeCheck(!['__proto__', 'prototype', 'constructor'].includes(key), 'VALUE_INVALID');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      runtimeCheck(descriptor && Object.hasOwn(descriptor, 'value'), 'VALUE_INVALID');
      inspect(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  }
  inspect(value, 0);
  runtimeCheck(Buffer.byteLength(JSON.stringify(value)) <= maxBytes, 'VALUE_TOO_LARGE');
  return structuredClone(value);
}
export function runtimeEnvelope(value, required, optional = [], maxBytes = 16384) {
  runtimeJson(value, maxBytes);
  runtimeCheck(value && typeof value === 'object' && !Array.isArray(value));
  runtimeCheck(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
export function runtimeId(value, code = 'IDENTIFIER_INVALID') {
  runtimeCheck(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)
    && !['__proto__', 'prototype', 'constructor'].includes(value), code);
  return value;
}
export function runtimeInteger(value, min, max, code = 'INTEGER_INVALID') {
  runtimeCheck(Number.isSafeInteger(value) && value >= min && value <= max, code);
  return value;
}
export function runtimeFamily(value) { runtimeCheck(RUNTIME_FAMILIES.includes(value), 'FAMILY_UNSUPPORTED'); return value; }
export function runtimeValue(value, maxBytes) {
  const copy = runtimeJson(value, maxBytes, 8);
  function inspect(item) {
    if (typeof item === 'string') runtimeCheck(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|<\/?[A-Za-z]|[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?:file|data|javascript):|-----BEGIN/iu.test(item), 'VALUE_NOT_PASSIVE');
    else if (item && typeof item === 'object') for (const entry of Object.values(item)) inspect(entry);
  }
  inspect(copy); return copy;
}
export function validateRuntimeBlueprint(value) {
  runtimeJson(value, 65536);
  const pitching = isPitchingBlueprint(value);
  runtimeEnvelope(value, ['schemaVersion', 'id', 'title', 'profile', 'records', 'templates', 'bounds'], pitching ? ['pitching'] : [], 65536);
  runtimeCheck(pitching || value.schemaVersion === 'dungeonq.runtime-blueprint/v1' && value.profile === RUNTIME_PROFILE, 'BLUEPRINT_UNSUPPORTED');
  runtimeId(value.id); runtimeValue(value.title, 200);
  runtimeCheck(typeof value.title === 'string' && value.title.length > 0, 'BLUEPRINT_INVALID');
  runtimeEnvelope(value.bounds, Object.keys(RUNTIME_MAXIMUMS));
  for (const [key, max] of Object.entries(RUNTIME_MAXIMUMS)) runtimeInteger(value.bounds[key], 1, max, 'BLUEPRINT_BOUND_INVALID');
  runtimeCheck(Array.isArray(value.records) && value.records.length >= 1 && value.records.length <= value.bounds.maxRecords, 'BLUEPRINT_INVALID');
  const keys = new Set();
  for (const record of value.records) {
    runtimeEnvelope(record, ['key', 'value']); runtimeId(record.key);
    runtimeValue(record.value, value.bounds.maxValueBytes);
    runtimeCheck(!keys.has(record.key), 'BLUEPRINT_DUPLICATE'); keys.add(record.key);
  }
  runtimeCheck(keys.has('welcome'), 'BLUEPRINT_WELCOME_REQUIRED');
  runtimeCheck(Array.isArray(value.templates) && value.templates.length >= (pitching ? 0 : 1) && value.templates.length <= 8, 'BLUEPRINT_INVALID');
  const templates = new Set();
  for (const template of value.templates) {
    runtimeEnvelope(template, ['id', 'keyPrefix', 'value']); runtimeId(template.id); runtimeId(template.keyPrefix);
    runtimeCheck(template.keyPrefix.length <= 48 && !templates.has(template.id), 'BLUEPRINT_INVALID'); templates.add(template.id);
    runtimeValue(template.value, value.bounds.maxValueBytes);
  }
  if (pitching) validatePitchingPolicy(value);
  return structuredClone(value);
}

// The v2 profile only accepts this finite rule vocabulary. No participant supplies these fields.
export function validatePitchingPolicy(pack) {
  const policy = pack.pitching;
  runtimeCheck(policy?.permission === 'PREAPPROVED_FINITE_BRANCHES', 'PITCHING_POLICY_REQUIRED');
  const revised = policy.schemaVersion === 'dungeonq.pitching/v2';
  const disclosure = hasNeutralCatalog(policy.variant);
  runtimeEnvelope(policy, ['schemaVersion', 'policyVersion', 'seed', 'mode', 'permission', 'maxTransitions', 'initialKeys', 'nodes', 'groundTruth',
    ...(disclosure ? ['scope'] : [])], revised ? ['variant'] : []);
  if (disclosure) runtimeCheck(policy.scope === 'SYNTHETIC_ONLY', 'PITCHING_PROFILE_INVALID');
  runtimeCheck((revised ? PITCHING_VARIANTS.slice(1).includes(policy.variant) && policy.policyVersion === `pitching-policy/${policy.variant}`
    : policy.schemaVersion === 'dungeonq.pitching/v1' && policy.policyVersion === 'pitching-policy/v1')
    && ['adaptive', 'fixed'].includes(policy.mode), 'PITCHING_PROFILE_INVALID');
  runtimeCheck(PITCHING_SEEDS.includes(policy.seed), 'PITCHING_SEED_UNSUPPORTED');
  runtimeInteger(policy.maxTransitions, 1, 4, 'PITCHING_PROFILE_INVALID');
  runtimeCheck(JSON.stringify(policy.initialKeys) === JSON.stringify(['welcome', 'catalog-current', 'catalog-prior']), 'PITCHING_PROFILE_INVALID');
  runtimeCheck(pack.templates.length === 0 && pack.records.every(record => !record.key.startsWith('note-')), 'PITCHING_PROFILE_INVALID');
  const definitions = isRealityVariant(policy.variant) ? realityNodeDefinitions(policy.seed) : isEvidenceVariant(policy.variant) ? evidenceNodeDefinitions(policy.seed) : [
    ['version-history', 'VERSION_READ_ORDER', ['history-chronology', 'history-delta']],
    ['transport-mirror', 'INTERFACE_ORDER', ['mirror-index', 'mirror-ledger']],
    ['persistence', 'NOTE_READBACK_FAMILY', ['persistence-receipt', 'persistence-journal']],
    ['continuation', 'SEED_VARIANT', ['continuation-amber', 'continuation-teal', 'continuation-violet']],
  ];
  runtimeCheck(Array.isArray(policy.nodes) && policy.nodes.length === definitions.length, 'PITCHING_PROFILE_INVALID');
  const keys = new Set(policy.initialKeys);
  for (let index = 0; index < definitions.length; index++) {
    const node = policy.nodes[index]; const [nodeId, rule, revealKeys] = definitions[index];
    runtimeEnvelope(node, ['id', 'rule', 'revealKeys']);
    runtimeCheck(node.id === nodeId && node.rule === rule && JSON.stringify(node.revealKeys) === JSON.stringify(revealKeys), 'PITCHING_PROFILE_INVALID');
    for (const key of node.revealKeys) keys.add(key);
  }
  runtimeCheck(pack.records.length === keys.size && pack.records.every(record => keys.has(record.key)), 'PITCHING_PROFILE_INVALID');
  if (isRealityVariant(policy.variant)) {
    const expected = structuredClone(pack); applyRealityFixture(expected);
    runtimeCheck(policy.maxTransitions === 4 && pack.id === `pitching-${policy.variant}-${policy.seed}-${policy.mode}`
      && pack.title === expected.title && JSON.stringify(policy.groundTruth) === JSON.stringify(expected.pitching.groundTruth)
      && JSON.stringify(pack.records) === JSON.stringify(expected.records), 'PITCHING_PROFILE_INVALID');
  }
  else if (isEvidenceVariant(policy.variant)) {
    const expected = structuredClone(pack); applyEvidenceFixture(expected);
    runtimeCheck(JSON.stringify(policy.groundTruth) === JSON.stringify(expected.pitching.groundTruth)
      && JSON.stringify(pack.records) === JSON.stringify(expected.records), 'PITCHING_PROFILE_INVALID');
  }
  else if (['inquiry-control-v3', 'inquiry-cue-v3'].includes(policy.variant) || disclosure) validateInquiryTruth(pack);
  else {
    runtimeEnvelope(policy.groundTruth, ['schemaVersion', 'proposition', 'currentValue', 'effectiveValue', 'sourceId']);
    runtimeCheck(policy.groundTruth.schemaVersion === 'dungeonq.pitching-truth/v1', 'PITCHING_PROFILE_INVALID');
  }
  runtimeValue(policy.groundTruth, 2048);
  return structuredClone(policy);
}

// A missing region attachment is an explicit unknown, never a default to the general catalog.
function validateInquiryTruth(pack) {
  const truth = pack.pitching.groundTruth; const seed = pack.pitching.seed;
  const disclosure = hasNeutralCatalog(pack.pitching.variant);
  runtimeEnvelope(truth, ['schemaVersion', 'proposition', 'sourceId', 'targetRegion', 'asOf', 'generalCurrentValue',
    'generalEffectiveValue', 'supplementId', 'targetCapacity', 'resolution', 'missingEvidence', ...(disclosure ? ['scope'] : [])]);
  const index = PITCHING_SEEDS.indexOf(seed); const base = [12, 18, 24][index];
  const sourceId = `${disclosure ? '' : 'synthetic-'}catalog-${['amber', 'teal', 'violet'][index]}`;
  runtimeCheck(truth.schemaVersion === 'dungeonq.pitching-truth/v2'
    && (!disclosure || truth.scope === 'SYNTHETIC_ONLY')
    && truth.proposition === 'Final applicable Lantern capacity for harbor at the scenario time.'
    && truth.sourceId === sourceId && truth.targetRegion === 'harbor' && truth.asOf === '2026-01-05T00:00:00Z'
    && truth.supplementId === 'LC-SUP-2026-01' && truth.generalCurrentValue === base + 4 && truth.generalEffectiveValue === base
    && truth.targetCapacity === (seed === 43 ? null : base + (seed === 17 ? 2 : 0))
    && truth.resolution === (seed === 43 ? 'UNKNOWN_MISSING_SCOPE' : seed === 17 ? 'APPLICABLE' : 'NOT_APPLICABLE')
    && JSON.stringify(truth.missingEvidence) === JSON.stringify(seed === 43 ? ['LC-SUP-2026-01-regions'] : []), 'PITCHING_PROFILE_INVALID');
  const current = pack.records.find(record => record.key === 'catalog-current')?.value;
  const prior = pack.records.find(record => record.key === 'catalog-prior')?.value;
  runtimeCheck(current?.sourceId === sourceId && prior?.sourceId === sourceId && current.capacity === truth.generalCurrentValue
    && prior.capacity === truth.generalEffectiveValue && current.effectiveAt === '2026-01-10T00:00:00Z'
    && prior.effectiveAt === '2026-01-01T00:00:00Z', 'PITCHING_PROFILE_INVALID');
}
