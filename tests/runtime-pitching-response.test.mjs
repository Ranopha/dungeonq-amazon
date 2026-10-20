import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPitchControl } from '../runtime/pitch-control.mjs';
import { openPitchResponse } from '../runtime/pitch-response.mjs';
import { openRuntimeReference } from '../runtime/reference.mjs';
import { createRuntimeClient } from '../sdk/runtime-client.mjs';

const code = expected => error => error.code === expected;
const scope = incident => ({ incidentId: incident.incidentId, contextId: incident.contextId, epoch: incident.epoch });
const active = incident => ({ contextId: incident.contextId, worldId: incident.worldId, epoch: incident.epoch, state: 'ACTIVE' });
function local(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dq-response-')); let at = 1000000;
  const handles = []; const control = () => { const value = openPitchControl({ path: join(directory, 'control.sqlite'), clock: () => at }); handles.push(value); return value; };
  const ledger = () => { const value = openPitchResponse({ path: join(directory, 'response.sqlite'), clock: () => at }); handles.push(value); return value; };
  t.after(() => { handles.forEach(handle => handle.close()); rmSync(directory, { recursive: true, force: true }); });
  const entered = (c, contextId = 'context-a', epoch = 1, provisional = false) => {
    const lease = c.begin({ family: 'http' }); c.bind(lease, { contextId });
    const entry = { contextId, worldId: `world-${contextId}`, epoch, eventId: `entry-${contextId}-${epoch}` };
    const result = provisional ? c.reserveEntry(entry) : c.recordEntry(entry);
    c.finish(lease, { outcome: 'SERVED', code: 'OK' }); return result.incident;
  };
  return { directory, control, ledger, entered, advance(ms = 1) { at += ms; }, setTime(value) { at = value; } };
}
const completion = (incident, claim, extra = {}) => ({ ...scope(incident), claimToken: claim.claimToken,
  outcome: 'ACCEPTED', receiptId: 'receipt-one', referenceId: 'connector-call-one', ...extra });
const event = (incident, kind, extra = {}) => ({ ...scope(incident), kind, referenceId: `evidence-${kind}`,
  evidenceKind: 'USER_CONFIRMATION', performer: 'HUMAN', ...extra });

test('relay durable one-shot claim only enters once; token is absent from status and persisted bytes', t => {
  const f = local(t); const c = f.control(); const second = f.control(); const incident = f.entered(c);
  const claim = c.claimRelay(scope(incident));
  assert.equal(second.snapshot().outbox[0].status, 'IN_FLIGHT');
  assert.equal(second.snapshot().outbox[0].attempts, 1);
  assert.throws(() => second.claimRelay(scope(incident)), code('PITCH_RELAY_NOT_PENDING'));
  assert.ok(!JSON.stringify(c.snapshot()).includes(claim.claimToken));
  assert.ok(!readFileSync(join(f.directory, 'control.sqlite-wal')).includes(Buffer.from(claim.claimToken)));
  const done = completion(incident, claim); assert.equal(c.completeRelay(done).replayed, false);
  assert.equal(second.completeRelay(done).replayed, true);
  assert.equal(second.snapshot().outbox[0].status, 'ACCEPTED');
  assert.equal(second.snapshot().incidents[0].acknowledgement, null);
  assert.throws(() => c.completeRelay({ ...done, receiptId: 'different-receipt' }), code('PITCH_RELAY_STALE'));
  assert.throws(() => c.claimRelay(scope(incident)), code('PITCH_RELAY_NOT_PENDING'));
});

test('relay refuses provisional entry, cross-scope/token completion, extra payload, and concurrent incidents', async t => {
  const f = local(t); const c = f.control(); const provisional = f.entered(c, 'waiting', 1, true);
  assert.throws(() => c.claimRelay(scope(provisional)), code('PITCH_RELAY_ENTRY_REQUIRED'));
  const first = f.entered(c); const second = f.entered(c, 'context-b');
  assert.throws(() => c.claimRelay({ ...scope(first), epoch: 2 }), code('PITCH_RELAY_SCOPE_CONFLICT'));
  assert.throws(() => c.claimRelay({ ...scope(first), recipient: 'private@example.invalid' }), code('INVALID_ENVELOPE'));
  assert.throws(() => c.claimRelay({ ...scope(first), leaseMs: 900001 }), code('PITCH_RELAY_LEASE_INVALID'));
  const claim = c.claimRelay(scope(first));
  assert.throws(() => c.claimRelay(scope(second)), code('PITCH_RELAY_BUSY'));
  assert.equal((await c.deliver({ send: async () => ({ accepted: true, receiptId: 'unsafe' }) })).attempted, 0);
  assert.throws(() => c.completeRelay(completion(second, claim)), code('PITCH_RELAY_STALE'));
  assert.throws(() => c.completeRelay(completion(first, claim, { contextId: second.contextId })), code('PITCH_RELAY_SCOPE_CONFLICT'));
  assert.throws(() => c.completeRelay(completion(first, { claimToken: 'wrong' })), code('PITCH_RELAY_STALE'));
  assert.equal(c.snapshot().outbox.find(row => row.incidentId === first.incidentId).status, 'IN_FLIGHT');
});

test('relay timeout, unknown and restart prohibit blind resend and stale completion; reconcile remains usable', t => {
  const f = local(t); let c = f.control(); const incident = f.entered(c);
  const claim = c.claimRelay({ ...scope(incident), leaseMs: 1000 }); f.advance(1001);
  // Completion itself expires the lease durably; a status poll is not required.
  assert.throws(() => c.completeRelay(completion(incident, claim)), code('PITCH_RELAY_STALE'));
  assert.equal(c.snapshot().outbox[0].status, 'UNKNOWN');
  assert.throws(() => c.claimRelay(scope(incident)), code('PITCH_RELAY_NOT_PENDING'));
  c.reconcileDelivery({ incidentId: incident.incidentId, evidence: { kind: 'DEFINITELY_NOT_ACCEPTED',
    idempotencyKey: claim.idempotencyKey, referenceId: 'provider-query-negative' } });
  const next = c.claimRelay(scope(incident)); c.close(); c = f.control();
  assert.equal(c.recoverRelayClaims().recovered, 1);
  assert.equal(c.snapshot().outbox[0].status, 'UNKNOWN');
  assert.throws(() => c.completeRelay(completion(incident, next)), code('PITCH_RELAY_STALE'));
  assert.throws(() => c.claimRelay(scope(incident)), code('PITCH_RELAY_NOT_PENDING'));
  c.reconcileDelivery({ incidentId: incident.incidentId, evidence: { kind: 'DELIVERY_RECEIPT',
    idempotencyKey: claim.idempotencyKey, referenceId: 'provider-query-positive', receiptId: 'known-receipt' } });
  assert.equal(c.snapshot().outbox[0].status, 'ACCEPTED');
});

test('relay explicit UNKNOWN is durable and replayable without a second attempt', t => {
  const f = local(t); const c = f.control(); const incident = f.entered(c); const claim = c.claimRelay(scope(incident));
  const input = { ...scope(incident), claimToken: claim.claimToken, outcome: 'UNKNOWN', referenceId: 'tool-lost-response' };
  assert.equal(c.completeRelay(input).outbox.status, 'UNKNOWN'); assert.equal(c.completeRelay(input).replayed, true);
  assert.throws(() => c.claimRelay(scope(incident)), code('PITCH_RELAY_NOT_PENDING'));
  assert.equal(c.snapshot().outbox[0].attempts, 1);
});

test('legacy idempotent sender cannot resend unknown external relay after timeout, completion or recovery', async t => {
  for (const mode of ['expiry', 'unknown', 'recovery']) {
    const f = local(t); const c = f.control(); const incident = f.entered(c);
    const claim = c.claimRelay({ ...scope(incident), leaseMs: 1000 });
    if (mode === 'expiry') f.advance(1001);
    if (mode === 'unknown') c.completeRelay({ ...scope(incident), claimToken: claim.claimToken,
      outcome: 'UNKNOWN', referenceId: 'uncertain-external-send' });
    if (mode === 'recovery') c.recoverRelayClaims();
    let calls = 0;
    const send = async () => { calls++; return { accepted: true, receiptId: 'legacy-receipt' }; };
    assert.equal((await c.deliver({ send, idempotent: true })).attempted, 0);
    assert.equal(calls, 0); assert.equal(c.snapshot().outbox[0].lastError, 'RELAY_UNKNOWN');
    c.reconcileDelivery({ incidentId: incident.incidentId, evidence: { kind: 'DEFINITELY_NOT_ACCEPTED',
      idempotencyKey: claim.idempotencyKey, referenceId: 'verified-negative' } });
    assert.equal((await c.deliver({ send, idempotent: true })).attempted, 1);
    assert.equal(calls, 1);
  }
});

test('response separates provider acceptance, reply upper bound, human ACK and canonical action; survives reopen', t => {
  const f = local(t); const c = f.control(); let ledger = f.ledger(); const incident = f.entered(c);
  const claim = c.claimRelay(scope(incident)); f.advance(10); const accepted = c.completeRelay(completion(incident, claim));
  ledger.recordProviderAcceptance(incident, accepted.outbox);
  assert.deepEqual(ledger.snapshot().events.map(row => row.kind), ['PROVIDER_ACCEPTED']);
  f.advance(20); const reply = event(incident, 'DELIVERY_CONFIRMED_BY_REPLY', { evidenceKind: 'EMAIL_REPLY', referenceId: 'reply-one' });
  ledger.record(reply, { incident }); ledger.record(event(incident, 'HUMAN_ACK', { referenceId: 'reply-one' }), { incident });
  const actionId = 'proposal-one'; const start = event(incident, 'ACTION_STARTED', { actionId,
    evidenceKind: 'OWNER_AUTHORIZATION', performer: 'AUTHORIZED_AGENT' });
  f.advance(30); ledger.record(start, { incident, canonical: active(incident) });
  const done = event(incident, 'ACTION_COMPLETED', { actionId, evidenceKind: 'CANONICAL_READBACK', performer: 'AUTHORIZED_AGENT' });
  const canonical = { contextId: incident.contextId, worldId: incident.worldId, epoch: incident.epoch + 1, state: 'FENCED', fenceReason: `${actionId}: authorized` };
  f.advance(40); ledger.record(done, { incident, canonical });
  ledger.close(); ledger = f.ledger(); const rows = ledger.snapshot().events;
  assert.deepEqual(rows.map(row => row.kind), ['PROVIDER_ACCEPTED', 'DELIVERY_CONFIRMED_BY_REPLY', 'HUMAN_ACK', 'ACTION_STARTED', 'ACTION_COMPLETED']);
  assert.equal(rows[0].sourceAt, 1000010); assert.equal(rows[1].observedAt, 1000030); assert.equal(rows[1].sourceAt, null);
  assert.equal(rows[0].assurance, 'OPERATOR_TRANSCRIBED');
  assert.equal(rows[2].assurance, 'OPERATOR_TRANSCRIBED'); assert.equal(rows[3].performer, 'AUTHORIZED_AGENT');
  assert.equal(rows[4].readback.state, 'FENCED'); assert.equal(rows[4].observedAt, 1000100);
  assert.equal(ledger.record(done, { incident, canonical }).replayed, true);
  assert.equal(ledger.record(start, { incident, canonical }).replayed, true);
  assert.equal(ledger.recordProviderAcceptance(incident, accepted.outbox).replayed, true);
});

test('response rejects invented delivery/ACK, forged time, address/body, cross-scope and conflicting replay', t => {
  const f = local(t); const c = f.control(); const ledger = f.ledger(); const incident = f.entered(c); const other = f.entered(c, 'other');
  assert.throws(() => ledger.record(event(incident, 'DELIVERY_CONFIRMED_BY_REPLY'), { incident }), code('PITCH_RESPONSE_ACCEPTANCE_REQUIRED'));
  for (const evidenceKind of ['READ_LABEL', 'OUTBOX_RECEIPT', 'OWNER_AUTHORIZATION'])
    assert.throws(() => ledger.record(event(incident, 'HUMAN_ACK', { evidenceKind }), { incident }), code('PITCH_RESPONSE_EVIDENCE_INVALID'));
  assert.throws(() => ledger.record(event(incident, 'HUMAN_ACK', { performer: 'AUTHORIZED_AGENT' }), { incident }), code('PITCH_RESPONSE_EVIDENCE_INVALID'));
  for (const extra of [{ observedAt: 9999999999 }, { sourceAt: 10 }, { body: 'private mail' }, { recipient: 'private@example.invalid' }])
    assert.throws(() => ledger.record({ ...event(incident, 'HUMAN_ACK'), ...extra }, { incident }), code('INVALID_ENVELOPE'));
  assert.throws(() => ledger.record(event(incident, 'HUMAN_ACK', { referenceId: 'private@example.invalid' }), { incident }), code('IDENTIFIER_INVALID'));
  assert.throws(() => ledger.record(event(incident, 'HUMAN_ACK', { epoch: 2 }), { incident }), code('PITCH_RESPONSE_SCOPE_CONFLICT'));
  const ack = event(incident, 'HUMAN_ACK'); ledger.record(ack, { incident });
  assert.throws(() => ledger.record({ ...ack, evidenceKind: 'EMAIL_REPLY' }, { incident }), code('PITCH_RESPONSE_REPLAY_CONFLICT'));
  assert.throws(() => ledger.record(event(other, 'HUMAN_ACK'), { incident: other }), code('PITCH_RESPONSE_SCOPE_CONFLICT'));
  assert.throws(() => ledger.record(event(incident, 'HUMAN_ACK', { referenceId: 'second-ack' }), { incident }), code('PITCH_RESPONSE_EVENT_EXISTS'));
  assert.throws(() => ledger.record(event(incident, 'PROVIDER_ACCEPTED'), { incident }), code('PITCH_RESPONSE_KIND_INVALID'));
});

test('response rejects future evidence, clock rollback, completion before start and wrong canonical action/epoch', t => {
  const f = local(t); const c = f.control(); const ledger = f.ledger(); const incident = f.entered(c);
  assert.throws(() => ledger.recordProviderAcceptance(incident, { incidentId: incident.incidentId, status: 'ACCEPTED',
    receiptId: 'receipt-future', acceptedAt: 1000001 }), code('PITCH_RESPONSE_TIME_INVALID'));
  f.setTime(999999); assert.throws(() => ledger.snapshot(), code('PITCH_RESPONSE_CLOCK_ROLLBACK')); f.setTime(1000000);
  const actionId = 'proposal'; const done = event(incident, 'ACTION_COMPLETED', { actionId, evidenceKind: 'CANONICAL_READBACK', performer: 'AUTHORIZED_AGENT' });
  const canonical = { contextId: incident.contextId, worldId: incident.worldId, epoch: 2, state: 'FENCED', fenceReason: `${actionId}: test` };
  assert.throws(() => ledger.record(done, { incident, canonical }), code('PITCH_RESPONSE_ACTION_REQUIRED'));
  const start = event(incident, 'ACTION_STARTED', { actionId, evidenceKind: 'OWNER_AUTHORIZATION', performer: 'AUTHORIZED_AGENT' });
  assert.throws(() => ledger.record(start, { incident, canonical }), code('PITCH_RESPONSE_ACTION_STALE'));
  ledger.record(start, { incident, canonical: active(incident) });
  for (const change of [{ state: 'ACTIVE' }, { contextId: 'other' }, { worldId: 'other' }, { epoch: 3 }, { fenceReason: 'other: wrong' }])
    assert.throws(() => ledger.record(done, { incident, canonical: { ...canonical, ...change } }), code('PITCH_RESPONSE_READBACK_INVALID'));
  assert.throws(() => ledger.record({ ...done, performer: 'HUMAN' }, { incident, canonical }), code('PITCH_RESPONSE_ACTION_REQUIRED'));
  assert.equal(ledger.snapshot().events.length, 1);
});

async function runtime(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dq-response-http-')); let r;
  const open = () => openRuntimeReference({ directory, network: false, hostBroker: false, presentation: 'pitching-v1' });
  r = await open(); t.after(async () => { await r.close(); rmSync(directory, { recursive: true, force: true }); });
  const clients = () => ({ owner: createRuntimeClient({ origin: r.origin, token: r.credentials.owner }),
    actor: createRuntimeClient({ origin: r.origin, token: r.credentials.actor }) });
  return { clients, async restart() { await r.close(); r = await open(); return clients(); } };
}

test('owner HTTP relay and response APIs exclude actor, preserve acceptance across restart, and require actual canonical fence', async t => {
  const f = await runtime(t); let { owner, actor } = f.clients();
  await actor.operate({ requestId: 'enter', operation: 'snapshot' }); const incident = (await owner.pitchStatus()).incidents[0];
  for (const operation of [() => actor.pitchResponseStatus(), () => actor.claimAlertRelay(scope(incident)),
    () => actor.completeAlertRelay({}), () => actor.recordPitchResponse(event(incident, 'HUMAN_ACK'))])
    await assert.rejects(operation, code('UNAUTHORIZED'));
  const claim = await owner.claimAlertRelay(scope(incident));
  assert.ok(!JSON.stringify(await owner.pitchStatus()).includes(claim.claimToken));
  await owner.completeAlertRelay(completion(incident, claim));
  let timeline = await owner.pitchResponseStatus(); assert.equal(timeline.events.length, 1);
  assert.equal(timeline.events[0].kind, 'PROVIDER_ACCEPTED');
  await owner.recordPitchResponse(event(incident, 'DELIVERY_CONFIRMED_BY_REPLY', { evidenceKind: 'EMAIL_REPLY' }));
  await owner.recordPitchResponse(event(incident, 'HUMAN_ACK'));
  const preview = await owner.preview({ contextId: incident.contextId, action: 'FENCE' });
  const differentPreview = await owner.preview({ contextId: incident.contextId, action: 'FENCE' });
  const action = { actionId: preview.proposalId, performer: 'AUTHORIZED_AGENT' };
  await owner.recordPitchResponse(event(incident, 'ACTION_STARTED', { ...action, evidenceKind: 'OWNER_AUTHORIZATION' }));
  const done = event(incident, 'ACTION_COMPLETED', { ...action, evidenceKind: 'CANONICAL_READBACK' });
  await assert.rejects(() => owner.recordPitchResponse(done), code('PITCH_RESPONSE_READBACK_INVALID'));
  const snapshot = await actor.operate({ requestId: 'race-before-write', operation: 'snapshot' });
  await actor.operate({ requestId: 'race-write', operation: 'write', args: {
    key: 'note-race', value: 'Participant write during operator response', expectedRevision: snapshot.revision } });
  await owner.apply({ proposalId: preview.proposalId, digest: preview.digest, confirmation: 'APPLY' });
  await assert.rejects(() => owner.apply({ proposalId: differentPreview.proposalId, digest: differentPreview.digest,
    confirmation: 'APPLY' }), code('APPROVAL_STALE'));
  await owner.recordPitchResponse(done);
  await assert.rejects(() => actor.operate({ requestId: 'after-fence', operation: 'snapshot' }), code('CONTEXT_FENCED'));
  ({ owner, actor } = await f.restart());
  timeline = await owner.pitchResponseStatus(); assert.equal(timeline.events.length, 5);
  assert.equal(timeline.events.at(-1).readback.epoch, incident.epoch + 1);
  assert.equal((await owner.pitchStatus()).outbox[0].status, 'ACCEPTED');
  await assert.rejects(() => owner.claimAlertRelay(scope(incident)), code('PITCH_RELAY_NOT_PENDING'));
});

test('gateway restart marks in-flight relay UNKNOWN; owner reconciliation synchronizes response ledger', async t => {
  const f = await runtime(t); let { owner, actor } = f.clients();
  await actor.operate({ requestId: 'enter', operation: 'snapshot' }); const incident = (await owner.pitchStatus()).incidents[0];
  const claim = await owner.claimAlertRelay(scope(incident)); ({ owner } = await f.restart());
  assert.equal((await owner.pitchStatus()).outbox[0].status, 'UNKNOWN');
  await assert.rejects(() => owner.completeAlertRelay(completion(incident, claim)), code('PITCH_RELAY_STALE'));
  await assert.rejects(() => owner.claimAlertRelay(scope(incident)), code('PITCH_RELAY_NOT_PENDING'));
  await owner.reconcileAlertDelivery({ incidentId: incident.incidentId, evidence: { kind: 'DELIVERY_RECEIPT',
    idempotencyKey: claim.idempotencyKey, referenceId: 'verified-provider-query', receiptId: 'found-provider-receipt' } });
  const timeline = await owner.pitchResponseStatus(); assert.equal(timeline.events.length, 1);
  assert.equal(timeline.events[0].referenceId, 'found-provider-receipt');
  assert.equal((await owner.pitchStatus()).incidents[0].acknowledgement, null);
});
