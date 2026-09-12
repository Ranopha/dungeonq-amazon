import { createHash, randomBytes } from 'node:crypto';
import { canonicalJson } from '../public/src/canonical.mjs';

export class GovernanceError extends Error {
  constructor(code) { super(code); this.name = 'GovernanceError'; this.code = code; }
}
export function requireThat(condition, code) { if (!condition) throw new GovernanceError(code); }
export function exact(value, keys) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype, 'SCHEMA_INVALID');
  requireThat(Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key)), 'SCHEMA_INVALID');
}
export function id(value) {
  requireThat(typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/u.test(value), 'IDENTIFIER_INVALID');
  return value;
}
export function integer(value, min, max) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max, 'SCHEMA_INVALID');
  return value;
}
export function digest(value) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function token() { return randomBytes(32).toString('base64url'); }
export function tokenHash(value) {
  requireThat(typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value), 'AUTH_REQUIRED');
  return digest(value);
}
export function grantDraft(value) {
  exact(value, ['schemaVersion', 'tenantId', 'profile', 'assetIds', 'effect', 'connectorVersion',
    'runbookVersion', 'dependencyDigest', 'expiresAt', 'maxEffects', 'maxConcurrent', 'leaseMs']);
  requireThat(value.schemaVersion === 'dungeonq.lab-grant-draft/v1'
    && value.profile === 'SYNTHETIC_ONLY'
    && value.effect === 'SYNTHETIC_CONTAINMENT'
    && value.connectorVersion === 'sqlite-fixture/v1'
    && value.runbookVersion === 'containment/v1', 'UNSUPPORTED_CAPABILITY');
  id(value.tenantId);
  requireThat(Array.isArray(value.assetIds) && value.assetIds.length > 0 && value.assetIds.length <= 100,
    'SCOPE_INVALID');
  value.assetIds.forEach(id);
  requireThat(new Set(value.assetIds).size === value.assetIds.length, 'SCOPE_INVALID');
  requireThat(typeof value.dependencyDigest === 'string' && /^[a-f0-9]{64}$/u.test(value.dependencyDigest), 'SCHEMA_INVALID');
  integer(value.expiresAt, 0, Number.MAX_SAFE_INTEGER);
  integer(value.maxEffects, 1, 100);
  integer(value.maxConcurrent, 1, 10);
  integer(value.leaseMs, 1000, 300_000);
  return { ...value, assetIds: [...value.assetIds].sort() };
}
export { canonicalJson };

export function memberChange(value) {
  exact(value, ['schemaVersion', 'tenantId', 'username', 'action', 'role', 'expectedEpoch']);
  requireThat(value.schemaVersion === 'dungeonq.lab-member-change/v1', 'SCHEMA_INVALID');
  id(value.tenantId); id(value.username);
  requireThat(['CREATE', 'CHANGE_ROLE', 'DISABLE', 'REISSUE_SETUP'].includes(value.action), 'UNSUPPORTED_CAPABILITY');
  requireThat(['MIS_OPERATOR', 'REVIEWER', 'AUDITOR'].includes(value.role), 'UNSUPPORTED_CAPABILITY');
  integer(value.expectedEpoch, 0, Number.MAX_SAFE_INTEGER - 1);
  requireThat(value.action === 'CREATE' ? value.expectedEpoch === 0 : value.expectedEpoch > 0, 'SCHEMA_INVALID');
  return { ...value };
}
