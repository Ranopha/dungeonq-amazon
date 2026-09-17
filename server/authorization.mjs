import { requireThat } from './contracts.mjs';

// 唯一角色→能力表。Client 角色、UI 隱藏及 Tool annotation 都不是授權。
const READ = ['READ_STATUS', 'READ_EVIDENCE', 'LOGOUT', 'RENEW_RECOVERY', 'ENROLL_TOTP', 'REMOVE_TOTP'];
const POLICY = Object.freeze({
  TENANT_SUPER_ADMIN: Object.freeze([...READ, 'PREVIEW_GRANT', 'PUBLISH_GRANT', 'REVOKE_GRANTS', 'MANAGE_MEMBERS', 'APPROVE_ROTATION', 'MANAGE_EMAIL']),
  MIS_OPERATOR: Object.freeze([...READ, 'PREVIEW_GRANT']),
  REVIEWER: Object.freeze([...READ, 'PREVIEW_GRANT']),
  AUDITOR: Object.freeze([...READ])
});
export function capabilities(role) { return Object.hasOwn(POLICY, role) ? [...POLICY[role]] : []; }
export function authorize(role, action) { requireThat(capabilities(role).includes(action), 'PERMISSION_DENIED'); }
export const MEMBER_ROLES = Object.freeze(['MIS_OPERATOR', 'REVIEWER', 'AUDITOR']);
