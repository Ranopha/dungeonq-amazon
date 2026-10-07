// Operator-owned harness. Only fixture startup uses the internal reference factory.
// All observations and approvals below use public HTTP interfaces.
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRuntimeReference } from '../runtime/reference.mjs';
import { createRuntimeClient, evidenceState } from '../sdk/runtime-client.mjs';
import { errorSummary, requireCondition } from '../examples/mcp-shipping-consumer/client.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const consumerDirectory = join(root, 'examples/mcp-shipping-consumer');
export function consumerProcessOptions({ cwd, packageDirectory = consumerDirectory } = {}) {
  return {
    cwd, env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' },
    execArgv: ['--permission', `--allow-fs-read=${realpathSync(packageDirectory)}`, `--allow-fs-read=${join(consumerDirectory, 'node_modules')}`, `--allow-fs-read=${join(root, 'node_modules')}`, `--allow-fs-read=${join(root, 'package.json')}`],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  };
}
export async function verifySecretReadDenied({ cwd, secretPath, packageDirectory } = {}) {
  const options = consumerProcessOptions({ cwd, packageDirectory });
  const probe = 'try { require("node:fs").readFileSync(process.argv[1]); process.exitCode=2; } catch(e) { if(e.code!=="ERR_ACCESS_DENIED") process.exitCode=3; else process.stdout.write(e.code); }';
  const { stdout } = await promisify(execFile)(process.execPath, [...options.execArgv, '-e', probe, secretPath], { cwd, env: options.env, timeout: 8000, maxBuffer: 8192 });
  requireCondition(stdout === 'ERR_ACCESS_DENIED', 'SECRET_READ_NOT_DENIED');
  return { result: 'ERR_ACCESS_DENIED', scope: 'Same Node permission policy as the consumer; fixture storage is outside its read allowlist.' };
}
export async function launchConsumer({ configuration, cwd, packageDirectory = consumerDirectory, onScene = () => {}, onOperatorBoundary = async () => {} } = {}) {
  const child = fork(realpathSync(join(packageDirectory, 'cli.mjs')), [], consumerProcessOptions({ cwd, packageDirectory }));
  let size = 0; let report; let ticket; let failure; let chain = Promise.resolve();
  const completion = new Promise((resolveChild, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(Object.assign(new Error('CONSUMER_TIMEOUT'), { code: 'CONSUMER_TIMEOUT' })); }, 30000);
    // Drain bounded output. Credentials travel only in stdin/private IPC, never logs.
    const drain = data => { size += data.length; if (size > 262144) child.kill('SIGTERM'); };
    child.stdout.on('data', drain); child.stderr.on('data', drain);
    child.stdin.on('error', () => {});
    child.once('error', () => { clearTimeout(timeout); reject(Object.assign(new Error('CONSUMER_START_FAILED'), { code: 'CONSUMER_START_FAILED' })); });
    child.on('message', message => {
      chain = chain.then(async () => {
        if (message.type === 'scene') onScene(message.scene);
        else if (message.type === 'ticket') ticket = message.ticket;
        else if (message.type === 'complete') report = message.report;
        else if (message.type === 'failure') failure = message.error;
        else if (message.type === 'operator-boundary') {
          await onOperatorBoundary({ revision: message.revision });
          child.stdin.write('{"continue":true}\n');
        }
      }).catch(error => { failure = errorSummary(error); child.kill('SIGTERM'); });
    });
    child.once('exit', async code => {
      clearTimeout(timeout); await chain;
      if (code !== 0 || failure || report?.status !== 'PASS') {
        reject(Object.assign(new Error('CONSUMER_FAILED'), { code: failure?.code ?? 'CONSUMER_FAILED' })); return;
      }
      resolveChild({ report, ticket });
    });
  });
  child.stdin.write(JSON.stringify(configuration) + '\n');
  try { return await completion; } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
}
async function originRequest(origin, path, token, input) {
  const response = await fetch(new URL(path, origin), { method: input ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${token}`, ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error('ORIGIN_REJECTED'), { code: value?.error?.code ?? 'ORIGIN_REJECTED' });
  return value;
}
async function expectDenied(operation, allowedCodes) {
  try { await operation(); } catch (error) { requireCondition(allowedCodes.includes(error.code), 'UNEXPECTED_BOUNDARY_FAILURE'); return error.code; }
  requireCondition(false, 'AUTHORITY_BOUNDARY_FAILED');
}
export const requiredEvidenceChecks = ['canonical-replay', 'origin-state-unchanged', 'no-diverted-origin-admission', 'independent-route-census', 'ordinary-admission-census', 'dispatch-outcomes-known', 'real-diversion-observed'];
export function integrationVerdict({ consumer, evidence, originChecks, authorityChecks, policy }) {
  return consumer?.status === 'PASS' && evidenceState(evidence) === 'PASS' && Array.isArray(evidence?.checks)
    && requiredEvidenceChecks.every(id => evidence.checks.filter(check => check.id === id && check.status === 'PASS').length === 1)
    && originChecks?.stateUnchanged === true && originChecks?.ordinaryAccepted === 1 && originChecks?.ticketRejected === 1
    && authorityChecks?.secretRead === 'ERR_ACCESS_DENIED' && authorityChecks?.operatorDenied === true
    && policy?.maxMutations === 8 && policy?.uses === 1 && policy?.followUpCount === 1 ? 'PASS' : 'FAIL';
}
export async function runIntegrationDemo({ output, onScene = () => {} } = {}) {
  requireCondition(typeof output === 'string' && !existsSync(output), 'NEW_OUTPUT_PATH_REQUIRED');
  const directory = mkdtempSync(join(tmpdir(), 'dq-oss-integration-fixture-'));
  const actorCwd = mkdtempSync(join(tmpdir(), 'dq-oss-independent-consumer-'));
  const scenes = [];
  const sourceVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  let runtime; let ticket; let report; let error;
  const show = (id, result) => { const scene = { id, observedAt: new Date().toISOString(), result }; scenes.push(scene); onScene(scene); };
  try {
    runtime = await openRuntimeReference({ directory, presentation: 'participant-v1', network: false, hostBroker: false });
    const operator = createRuntimeClient({ origin: runtime.origin, token: runtime.credentials.owner });
    const actor = createRuntimeClient({ origin: runtime.origin, token: runtime.credentials.actor });
    const ordinary = createRuntimeClient({ origin: runtime.origin, token: runtime.credentials.ordinary });
    const beforeOrigin = await originRequest(runtime.originService.origin, '/witness', runtime.credentials.witness);
    const secretCheck = await verifySecretReadDenied({ cwd: actorCwd, secretPath: join(directory, 'credentials.json') });
    const denied = await Promise.all([
      expectDenied(() => actor.status(), ['UNAUTHORIZED']),
      expectDenied(() => actor.evidence(), ['UNAUTHORIZED']),
      expectDenied(() => actor.preview({ contextId: 'diverted', action: 'GRANT_MUTATION' }), ['UNAUTHORIZED']),
      expectDenied(() => actor.apply({ proposalId: 'not-owned', digest: 'not-owned', confirmation: 'APPLY' }), ['UNAUTHORIZED']),
    ]);
    const authorityChecks = { secretRead: secretCheck.result, operatorDenied: denied.every(code => code === 'UNAUTHORIZED') };
    show('authority-boundary', { ...authorityChecks, nodePermission: true, passedCredentials: ['actorToken'], passedEndpoints: ['MCP endpoint'], inheritedEnvironment: ['PATH', 'NODE_NO_WARNINGS'] });
    const control = await ordinary.operate({ requestId: 'oss-ordinary-control', operation: 'read', args: { key: 'welcome' } });
    requireCondition(control.record?.quantity === 7 && control._route?.destination === 'ORIGIN', 'ORDINARY_CONTROL_FAILED');
    let policyId;
    const consumed = await launchConsumer({ cwd: actorCwd, configuration: { endpoint: runtime.mcpEndpoint, actorToken: runtime.credentials.actor, requestPrefix: 'oss-shipping', waitForOperator: true },
      onScene: scene => { scenes.push(scene); onScene(scene); },
      onOperatorBoundary: async ({ revision }) => {
        const observed = await operator.evidence();
        requireCondition(observed.events.some(event => event.requestId === 'oss-shipping-write' && event.destination === 'SYNTHETIC' && event.outcome === 'SERVED'), 'INDEPENDENT_OBSERVATION_MISSING');
        const preview = await operator.preview({ contextId: 'diverted', action: 'GRANT_MUTATION', reason: 'Scripted operator fixture reviewed the synthetic shipping note.' });
        requireCondition(preview.expectedRevision === revision, 'PREVIEW_REVISION_MISMATCH');
        const applied = await operator.apply({ proposalId: preview.proposalId, digest: preview.digest, confirmation: 'APPLY' });
        const policy = applied.readback.policies.find(item => item.policyId === preview.proposalId);
        requireCondition(applied.state === 'APPLIED' && policy?.maxMutations === 8 && policy.uses === 0, 'FINITE_POLICY_NOT_APPLIED');
        policyId = policy.policyId;
        show('operator-approval', { state: applied.state, authority: 'SCRIPTED_OPERATOR_FIXTURE', observedDestination: 'SYNTHETIC', expectedRevision: revision,
          maxMutations: policy.maxMutations, validitySeconds: 3600, template: 'follow-up', humanPresenceAttested: false });
      },
    });
    ticket = consumed.ticket;
    requireCondition(typeof ticket === 'string' && ticket.length > 0, 'TICKET_PROBE_UNAVAILABLE');
    const ticketDenied = await expectDenied(() => originRequest(runtime.originService.origin, '/business', ticket,
      { contextId: 'diverted', requestId: 'oss-ticket-origin-probe', operation: 'read', args: { key: 'welcome' } }), ['ORIGIN_AUTHORITY_DENIED']);
    const afterOrigin = await originRequest(runtime.originService.origin, '/witness', runtime.credentials.witness);
    const interval = afterOrigin.admissions.slice(beforeOrigin.highWater);
    const originChecks = { stateUnchanged: beforeOrigin.stateDigest === afterOrigin.stateDigest && beforeOrigin.configDigest === afterOrigin.configDigest,
      ordinaryAccepted: interval.filter(row => row.accepted === 1 && row.context === 'ordinary').length,
      ticketRejected: interval.filter(row => row.accepted === 0 && row.request_id === 'oss-ticket-origin-probe').length };
    requireCondition(interval.length === 2 && interval.every(row => !row.accepted || row.context === 'ordinary'), 'ORIGIN_INTERVAL_MISMATCH');
    show('origin-boundary', { ...originChecks, ticketResult: ticketDenied, quantity: control.record.quantity, authority: 'separate artificial-origin witness', productionProtection: 'NOT_ASSESSED' });
    const evidence = await operator.evidence();
    const actorEvents = evidence.events.filter(event => event.contextId === 'diverted');
    const requiredRequests = ['snapshot', 'order', 'policy', 'write', 'readback', 'ticket', 'consume', 'after'].map(suffix => `oss-shipping-${suffix}`);
    requireCondition(actorEvents.length === requiredRequests.length && requiredRequests.every(requestId => actorEvents.some(event =>
      event.requestId === requestId && event.family === 'mcp' && event.destination === 'SYNTHETIC' && event.outcome === 'SERVED')), 'ACTOR_ROUTE_CENSUS_MISMATCH');
    const status = await operator.status();
    const savedPolicy = status.policies.find(item => item.policyId === policyId);
    const world = status.worlds.find(item => item.worldId === 'dungeon');
    const policy = { maxMutations: savedPolicy?.maxMutations, uses: savedPolicy?.uses, followUpCount: world?.records.filter(record => record.key.startsWith('follow-up-')).length };
    const statusResult = integrationVerdict({ consumer: consumed.report, evidence, originChecks, authorityChecks, policy });
    requireCondition(statusResult === 'PASS', 'INTEGRATION_NOT_VERIFIED');
    show('final-evidence', { status: statusResult, checks: evidence.checks.map(({ id, status }) => ({ id, status })), finalRevision: world.revision,
      actorRequests: evidence.events.filter(event => event.contextId === 'diverted').length, policyUses: policy.uses, followUpCount: policy.followUpCount });
    report = { schemaVersion: 'dungeonq.oss-integration/v1', sourceVersion, status: statusResult, mode: 'LOCAL_ARTIFICIAL_REFERENCE', consumer: 'INDEPENDENT_SCRIPTED_MCP_PROCESS',
      operator: 'SCRIPTED_OPERATOR_FIXTURE', productionProtection: 'NOT_ASSESSED', thirdPartyAdoption: 'NOT_ESTABLISHED', scenes,
      evidence: { status: evidence.status, checks: evidence.checks, events: evidence.events.map(({ requestId, family, destination, outcome }) => ({ requestId, family, destination, outcome })),
        origin: { before: { stateDigest: beforeOrigin.stateDigest, configDigest: beforeOrigin.configDigest, highWater: beforeOrigin.highWater },
          after: { stateDigest: afterOrigin.stateDigest, configDigest: afterOrigin.configDigest, highWater: afterOrigin.highWater }, admissions: interval }, authorityChecks, policy } };
  } catch (caught) {
    error = caught;
    report = { schemaVersion: 'dungeonq.oss-integration/v1', sourceVersion, status: 'FAIL', mode: 'LOCAL_ARTIFICIAL_REFERENCE', error: errorSummary(caught), scenes };
  } finally {
    await runtime?.close();
    rmSync(directory, { recursive: true, force: true }); rmSync(actorCwd, { recursive: true, force: true });
  }
  report.limitations = ['Scripted consumer and scripted operator; no live AI, independent human approval, or third-party adoption.',
    'Artificial origin with independently authenticated witness, not a production asset.',
    'Node permission policy limits accidental access by this cooperative example; same-user host and dependency code remain trusted. This is not hostile-code isolation.',
    'The separately scoped runtime isolation suite and research results are not replaced by this integration example.'];
  const encoded = JSON.stringify(report, null, 2) + '\n';
  for (const secret of [...Object.values(runtime?.credentials ?? {}), ticket].filter(Boolean)) requireCondition(!encoded.includes(secret), 'REPORT_SECRET_DETECTED');
  writeFileSync(output, encoded, { flag: 'wx', mode: 0o600 });
  if (error) throw error;
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireCondition(process.argv.length === 3, 'USAGE_NODE_OSS_INTEGRATION_DEMO_NEW_REPORT_JSON');
    await runIntegrationDemo({ output: resolve(process.argv[2]), onScene: scene => process.stdout.write(JSON.stringify(scene) + '\n') });
  } catch (error) { process.stderr.write(JSON.stringify({ status: 'FAIL', error: errorSummary(error) }) + '\n'); process.exitCode = 1; }
}
