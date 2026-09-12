import { exact, id, integer, requireThat, digest } from './contracts.mjs';

const PLANES = ['control', 'broker', 'issuer', 'consumer', 'evidence', 'deception', 'telemetry'];
const EDGES = { control: ['broker', 'evidence'], broker: ['issuer', 'evidence'], issuer: [], consumer: ['issuer'], evidence: [], deception: ['telemetry'], telemetry: [] };

// 設定驗證不是 Network Policy enforcement；此函式永遠不回報已部署／商用合格。
export function validateIsolationPlan(input) {
  exact(input, ['schemaVersion', 'profile', 'tenantId', 'planes']);
  requireThat(input.schemaVersion === 'dungeonq.isolation-plan/v1' && input.profile === 'SYNTHETIC_ONLY', 'PROFILE_NOT_AUTHORIZED');
  id(input.tenantId); requireThat(Array.isArray(input.planes) && input.planes.length === PLANES.length, 'ISOLATION_INVALID');
  const seen = new Set(); const identities = new Set(); const stores = new Set(); const networks = new Set();
  for (const plane of input.planes) {
    exact(plane, ['name', 'identity', 'storage', 'network', 'uid', 'readOnlyRoot', 'dropAllCapabilities', 'hostAccess', 'metadataAccess', 'secrets', 'egress', 'memoryMiB', 'pids', 'cpuMillis']);
    requireThat(PLANES.includes(plane.name) && !seen.has(plane.name), 'ISOLATION_INVALID'); seen.add(plane.name);
    for (const [field, set] of [['identity', identities], ['storage', stores], ['network', networks]]) {
      id(plane[field]); requireThat(!set.has(plane[field]), 'ISOLATION_SHARED_RESOURCE'); set.add(plane[field]);
    }
    integer(plane.uid, 10000, 60000); integer(plane.memoryMiB, 64, 1024); integer(plane.pids, 8, 128); integer(plane.cpuMillis, 50, 1000);
    requireThat(plane.readOnlyRoot === true && plane.dropAllCapabilities === true && plane.hostAccess === false && plane.metadataAccess === false, 'ISOLATION_PRIVILEGE');
    requireThat(Array.isArray(plane.secrets) && Array.isArray(plane.egress), 'ISOLATION_INVALID');
    const expectedSecrets = ['deception', 'telemetry'].includes(plane.name) ? [] : [`${plane.name}-only`];
    requireThat(JSON.stringify(plane.secrets) === JSON.stringify(expectedSecrets), 'ISOLATION_SECRET_SCOPE');
    requireThat(new Set(plane.egress).size === plane.egress.length && plane.egress.every(target => EDGES[plane.name].includes(target)), 'ISOLATION_EGRESS');
  }
  requireThat(new Set(input.planes.map(plane => plane.uid)).size === PLANES.length, 'ISOLATION_SHARED_RESOURCE');
  return { schemaVersion: 'dungeonq.isolation-plan-result/v1', digest: digest(input), configurationValid: true,
    runtimeIsolation: 'NOT_TESTED', productionAdmission: 'DENIED', remaining: ['IMAGE_DIGESTS', 'NETWORK_ENFORCEMENT', 'INDEPENDENT_IDENTITIES', 'RESTORE', 'LOAD', 'OWNER_DEPLOYMENT_APPROVAL'] };
}
