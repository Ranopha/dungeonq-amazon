// Trusted assembly contracts. Participant transports must not expose administration methods.
export const RUNTIME_VERSION = 'dungeonq.runtime/v1';
export const RUNTIME_PROFILE = 'SYNTHETIC_ONLY';
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
    if (typeof item === 'string') runtimeCheck(!/[\u0000-\u001f\u007f]|<\/?[A-Za-z]|[A-Za-z][A-Za-z0-9+.-]*:\/\/|(?:file|data|javascript):|-----BEGIN/iu.test(item), 'VALUE_NOT_PASSIVE');
    else if (item && typeof item === 'object') for (const entry of Object.values(item)) inspect(entry);
  }
  inspect(copy); return copy;
}
export function validateRuntimeBlueprint(value) {
  runtimeJson(value, 65536);
  runtimeEnvelope(value, ['schemaVersion', 'id', 'title', 'profile', 'records', 'templates', 'bounds'], [], 65536);
  runtimeCheck(value.schemaVersion === 'dungeonq.runtime-blueprint/v1' && value.profile === RUNTIME_PROFILE, 'BLUEPRINT_UNSUPPORTED');
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
  runtimeCheck(Array.isArray(value.templates) && value.templates.length >= 1 && value.templates.length <= 8, 'BLUEPRINT_INVALID');
  const templates = new Set();
  for (const template of value.templates) {
    runtimeEnvelope(template, ['id', 'keyPrefix', 'value']); runtimeId(template.id); runtimeId(template.keyPrefix);
    runtimeCheck(template.keyPrefix.length <= 48 && !templates.has(template.id), 'BLUEPRINT_INVALID'); templates.add(template.id);
    runtimeValue(template.value, value.bounds.maxValueBytes);
  }
  return structuredClone(value);
}
