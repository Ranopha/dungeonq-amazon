// 研究操作者工具。只連本輪 loopback owner；不含郵件傳輸或自動真人確認。
import { readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRuntimeClient } from '../sdk/runtime-client.mjs';

const [directoryArg, command, inputFile] = process.argv.slice(2);
if (!directoryArg || !['status', 'claim', 'complete', 'confirm', 'fence'].includes(command)) throw Error('Use PRIVATE_DATA status|claim|complete|confirm|fence [PRIVATE_INPUT_JSON]');
process.umask(0o077);
const directory = resolve(directoryArg);
const stat = lstatSync(directory);
if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error('PRIVATE_DIRECTORY_REQUIRED');
const read = name => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const save = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const run = read('run-info.json'), credentials = read('credentials.json');
if (run.responseTracking !== true || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(run.runtimeOrigin)) throw Error('LOCAL_RESPONSE_STUDY_REQUIRED');
const owner = createRuntimeClient({ origin: run.runtimeOrigin, token: credentials.owner });
const control = await owner.pitchStatus();
const entered = control.incidents.filter(row => row.phase === 'ENTERED');
if (entered.length !== 1) throw Error('EXACTLY_ONE_ENTERED_INCIDENT_REQUIRED');
const incident = entered[0];
const scope = { incidentId: incident.incidentId, contextId: incident.contextId, epoch: incident.epoch };
const input = inputFile ? JSON.parse(readFileSync(resolve(inputFile), 'utf8')) : null;
const output = value => console.log(JSON.stringify(value));
if (command === 'status') {
  const response = await owner.pitchResponseStatus();
  output({ phase: incident.phase, enteredAt: incident.enteredAt, delivery: control.outbox.find(row => row.incidentId === incident.incidentId)?.status,
    response: response.events.map(({ kind, observedAt, sourceAt, performer, assurance, readback }) => ({ kind, observedAt, sourceAt, performer, assurance, fenced: readback?.state === 'FENCED' })) });
} else if (command === 'claim') {
  if (existsSync(join(directory, 'relay-claim.json'))) throw Error('CLAIM_ALREADY_SAVED_DO_NOT_RESEND');
  const claim = await owner.claimAlertRelay({ ...scope, leaseMs: 300000 });
  save('relay-claim.json', claim);
  output({ state: 'CLAIMED', enteredAt: incident.enteredAt, leaseExpiresAt: claim.leaseExpiresAt });
} else if (command === 'complete') {
  if (!input || !['ACCEPTED', 'UNKNOWN'].includes(input.outcome) || typeof input.referenceId !== 'string') throw Error('ACTUAL_PROVIDER_EVIDENCE_REQUIRED');
  const claim = read('relay-claim.json');
  if (claim.incidentId !== scope.incidentId || claim.contextId !== scope.contextId || claim.epoch !== scope.epoch) throw Error('CLAIM_SCOPE_MISMATCH');
  const result = await owner.completeAlertRelay({ ...scope, claimToken: claim.claimToken, outcome: input.outcome,
    referenceId: input.referenceId, ...(input.outcome === 'ACCEPTED' ? { receiptId: input.receiptId } : {}) });
  save('relay-completion.json', result);
  save('current-response.json', await owner.pitchResponseStatus());
  output({ state: input.outcome, recipientDelivery: 'UNKNOWN' });
} else if (command === 'confirm') {
  if (!input || !['EMAIL_REPLY', 'USER_CONFIRMATION'].includes(input.evidenceKind) || input.explicitReceiptConfirmation !== true
    || input.explicitAcknowledgement !== true || typeof input.referenceId !== 'string') throw Error('EXPLICIT_HUMAN_EVIDENCE_REQUIRED');
  // The caller must supply actual human evidence; this tool does not authenticate a person.
  for (const kind of ['DELIVERY_CONFIRMED_BY_REPLY', 'HUMAN_ACK']) await owner.recordPitchResponse({ ...scope, kind,
    referenceId: input.referenceId, evidenceKind: input.evidenceKind, performer: 'HUMAN' });
  await owner.acknowledgeIncident({ incidentId: incident.incidentId });
  save('human-confirmation.json', input);
  save('current-response.json', await owner.pitchResponseStatus());
  output({ state: 'HUMAN_EVIDENCE_TRANSCRIBED', deliveryTiming: 'UPPER_BOUND_ONLY' });
} else {
  if (existsSync(join(directory, 'fence-preview.json'))) throw Error('FENCE_ALREADY_STARTED_INSPECT_READBACK_DO_NOT_REAPPLY');
  const preview = await owner.preview({ contextId: incident.contextId, action: 'FENCE' });
  save('fence-preview.json', preview);
  const action = { ...scope, actionId: preview.proposalId, performer: 'AUTHORIZED_AGENT', referenceId: `fence-${randomUUID()}` };
  await owner.recordPitchResponse({ ...action, kind: 'ACTION_STARTED', evidenceKind: 'OWNER_AUTHORIZATION' });
  const applied = await owner.apply({ proposalId: preview.proposalId, digest: preview.digest, confirmation: 'APPLY' });
  const completed = await owner.recordPitchResponse({ ...action, kind: 'ACTION_COMPLETED', evidenceKind: 'CANONICAL_READBACK' });
  const actor = createRuntimeClient({ origin: run.runtimeOrigin, token: credentials.actor });
  let rejection;
  try { await actor.operate({ requestId: `operator-fence-proof-${randomUUID()}`, operation: 'snapshot' }); }
  catch (error) { rejection = error.code; }
  if (rejection !== 'CONTEXT_FENCED') throw Error('FENCE_DENIAL_NOT_PROVEN');
  // Keep unresolved if no real human acknowledgement exists; never create one here.
  if (incident.acknowledgement) await owner.resolveIncident({ incidentId: incident.incidentId, resolution: 'FENCED' });
  save('fence-proof.json', { applied, completed, operatorProbe: { operation: 'snapshot', rejection }, checkedAt: Date.now() });
  save('current-response.json', await owner.pitchResponseStatus());
  output({ state: 'FENCED', actorOperationRejected: rejection, performer: 'AUTHORIZED_AGENT', humanAcknowledged: Boolean(incident.acknowledgement) });
}
