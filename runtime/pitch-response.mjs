import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { openAuxiliary } from './auxiliary.mjs';
import { runtimeCheck as check, runtimeEnvelope as envelope, runtimeId as id,
  runtimeInteger as integer } from './contracts.mjs';

export const PITCH_RESPONSE_VERSION = 'dungeonq.pitch-response/v1';
const SCHEMA = 'CREATE TABLE pitch_response_meta (id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL,digest TEXT NOT NULL)';
const MAX_EVENTS = 8192;
const MAX_BYTES = 8 * 1024 * 1024;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const kinds = ['PROVIDER_ACCEPTED', 'DELIVERY_CONFIRMED_BY_REPLY', 'HUMAN_ACK', 'ACTION_STARTED', 'ACTION_COMPLETED'];
const atValue = value => integer(value, 0, Number.MAX_SAFE_INTEGER, 'PITCH_RESPONSE_TIME_INVALID');
const scopeOf = incident => ({ incidentId: incident.incidentId, contextId: incident.contextId,
  worldId: incident.worldId, epoch: incident.epoch });

function validateEvent(event) {
  envelope(event, ['eventId', 'incidentId', 'contextId', 'worldId', 'epoch', 'kind', 'referenceId',
    'evidenceKind', 'performer', 'assurance', 'observedAt', 'sourceAt', 'enteredAt', 'actionId', 'readback']);
  for (const key of ['eventId', 'incidentId', 'contextId', 'worldId', 'referenceId']) id(event[key]);
  integer(event.epoch, 1, Number.MAX_SAFE_INTEGER);
  check(kinds.includes(event.kind), 'PITCH_RESPONSE_KIND_INVALID');
  check(['HUMAN', 'AUTHORIZED_AGENT', 'SYSTEM'].includes(event.performer), 'PITCH_RESPONSE_PERFORMER_INVALID');
  check(['USER_CONFIRMATION', 'EMAIL_REPLY', 'OWNER_AUTHORIZATION', 'CANONICAL_READBACK', 'OUTBOX_RECEIPT', 'VERIFIED_ACK_LINK'].includes(event.evidenceKind), 'PITCH_RESPONSE_EVIDENCE_INVALID');
  check(['OPERATOR_TRANSCRIBED', 'LOCAL_CANONICAL_READBACK', 'LOCAL_OUTBOX_ACCEPTANCE', 'LOCAL_VERIFIED_LOGIN'].includes(event.assurance), 'PITCH_RESPONSE_EVIDENCE_INVALID');
  atValue(event.observedAt); atValue(event.enteredAt);
  check(event.observedAt >= event.enteredAt, 'PITCH_RESPONSE_TIME_INVALID');
  if (event.sourceAt !== null) { atValue(event.sourceAt); check(event.sourceAt >= event.enteredAt && event.sourceAt <= event.observedAt, 'PITCH_RESPONSE_TIME_INVALID'); }
  if (event.actionId !== null) id(event.actionId);
  if (event.readback !== null) {
    envelope(event.readback, ['contextId', 'worldId', 'epoch', 'state', 'actionId']);
    check(event.readback.contextId === event.contextId && event.readback.worldId === event.worldId
      && event.readback.epoch === event.epoch + 1 && event.readback.state === 'FENCED'
      && event.readback.actionId === event.actionId, 'PITCH_RESPONSE_READBACK_INVALID');
  }
  if (event.kind === 'PROVIDER_ACCEPTED') check(event.evidenceKind === 'OUTBOX_RECEIPT' && event.performer === 'SYSTEM'
    && ['LOCAL_OUTBOX_ACCEPTANCE', 'OPERATOR_TRANSCRIBED'].includes(event.assurance)
    && event.sourceAt !== null && event.actionId === null && event.readback === null, 'PITCH_RESPONSE_EVIDENCE_INVALID');
  else {
    check(event.sourceAt === null, 'PITCH_RESPONSE_TIME_INVALID');
    // M3: a HUMAN_ACK is either owner-transcribed (legacy) or a verified single-use ACK link login.
    if (['DELIVERY_CONFIRMED_BY_REPLY', 'HUMAN_ACK'].includes(event.kind)) check(event.performer === 'HUMAN'
      && (['USER_CONFIRMATION', 'EMAIL_REPLY'].includes(event.evidenceKind) && event.assurance === 'OPERATOR_TRANSCRIBED'
        || event.kind === 'HUMAN_ACK' && event.evidenceKind === 'VERIFIED_ACK_LINK' && event.assurance === 'LOCAL_VERIFIED_LOGIN')
      && event.actionId === null && event.readback === null, 'PITCH_RESPONSE_EVIDENCE_INVALID');
    else check(event.actionId !== null && event.performer !== 'SYSTEM'
      && (event.kind === 'ACTION_STARTED' ? event.evidenceKind === 'OWNER_AUTHORIZATION' && event.assurance === 'OPERATOR_TRANSCRIBED' && event.readback === null
        : event.evidenceKind === 'CANONICAL_READBACK' && event.assurance === 'LOCAL_CANONICAL_READBACK' && event.readback !== null), 'PITCH_RESPONSE_EVIDENCE_INVALID');
  }
}

/** Trusted owner assembly. Human statements are transcribed evidence, not human authentication.
 * No email address, body, provider timestamp or free-form text is accepted here.
 */
export function openPitchResponse({ path, clock = Date.now } = {}) {
  check(typeof path === 'string' && isAbsolute(path), 'STORAGE_PATH_INVALID');
  check(typeof clock === 'function', 'CLOCK_INVALID'); atValue(clock());
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  check(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o022) === 0, 'STORAGE_DIRECTORY_INVALID');
  const db = openAuxiliary(path, SCHEMA, 'pitch_response_meta'); let closed = false;
  const validate = state => {
    check(state && Object.keys(state).length === 3 && state.version === PITCH_RESPONSE_VERSION
      && Array.isArray(state.events) && state.events.length <= MAX_EVENTS, 'PITCH_RESPONSE_STATE_INVALID');
    atValue(state.lastAt); const seen = new Set(); let previousAt = 0;
    for (const event of state.events) {
      validateEvent(event); check(!seen.has(event.eventId) && event.observedAt >= previousAt && event.observedAt <= state.lastAt, 'PITCH_RESPONSE_STATE_INVALID');
      seen.add(event.eventId); previousAt = event.observedAt;
    }
    return state;
  };
  const read = () => {
    const row = db.prepare('SELECT * FROM pitch_response_meta WHERE id=1').get();
    check(row && Buffer.byteLength(row.state) <= MAX_BYTES, 'PITCH_RESPONSE_STATE_INVALID');
    const state = JSON.parse(row.state); check(hash(state) === row.digest, 'PITCH_RESPONSE_STATE_CORRUPT'); return validate(state);
  };
  const transact = action => {
    check(!closed, 'PITCH_RESPONSE_CLOSED'); db.exec('BEGIN IMMEDIATE');
    try {
      const state = read(); const at = atValue(clock());
      check(at >= state.lastAt, 'PITCH_RESPONSE_CLOCK_ROLLBACK');
      const result = action(state, at); state.lastAt = at; validate(state);
      const json = JSON.stringify(state); check(Buffer.byteLength(json) <= MAX_BYTES, 'PITCH_RESPONSE_CAPACITY');
      db.prepare('UPDATE pitch_response_meta SET state=?,digest=? WHERE id=1').run(json, hash(state));
      db.exec('COMMIT'); return structuredClone(result);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  try {
    if (!db.prepare('SELECT id FROM pitch_response_meta WHERE id=1').get()) {
      const state = { version: PITCH_RESPONSE_VERSION, lastAt: atValue(clock()), events: [] };
      db.prepare('INSERT INTO pitch_response_meta VALUES(1,?,?)').run(JSON.stringify(state), hash(state));
    }
    read();
  } catch (error) { db.close(); throw error; }

  const append = (state, at, incident, data, validateFresh = () => {}) => {
    check(incident?.phase === 'ENTERED', 'PITCH_RESPONSE_ENTRY_REQUIRED');
    const scope = scopeOf(incident); for (const key of ['incidentId', 'contextId', 'worldId']) id(scope[key]);
    integer(scope.epoch, 1, Number.MAX_SAFE_INTEGER); atValue(incident.enteredAt);
    check(at >= incident.enteredAt, 'PITCH_RESPONSE_TIME_INVALID');
    const key = [data.kind, data.referenceId];
    const eventId = `response-${hash(key)}`;
    const existing = state.events.find(event => event.eventId === eventId);
    const event = { eventId, ...scope, ...data, observedAt: at, enteredAt: incident.enteredAt };
    validateEvent(event);
    // A source reference cannot be rebound to a different incident, even for another event kind.
    check(!state.events.some(row => row.referenceId === data.referenceId && row.incidentId !== incident.incidentId), 'PITCH_RESPONSE_SCOPE_CONFLICT');
    if (existing) {
      check(hash({ ...event, observedAt: existing.observedAt }) === hash(existing), 'PITCH_RESPONSE_REPLAY_CONFLICT');
      return { event: existing, replayed: true };
    }
    validateFresh();
    const related = state.events.filter(row => row.incidentId === incident.incidentId);
    check(!related.some(row => row.kind === data.kind), 'PITCH_RESPONSE_EVENT_EXISTS');
    check(related.length < 5 && state.events.length < MAX_EVENTS, 'PITCH_RESPONSE_CAPACITY');
    if (data.kind === 'DELIVERY_CONFIRMED_BY_REPLY') check(related.some(row => row.kind === 'PROVIDER_ACCEPTED'), 'PITCH_RESPONSE_ACCEPTANCE_REQUIRED');
    if (data.kind === 'ACTION_COMPLETED') {
      const start = related.find(row => row.kind === 'ACTION_STARTED');
      check(start && start.actionId === data.actionId && start.performer === data.performer, 'PITCH_RESPONSE_ACTION_REQUIRED');
    }
    state.events.push(event); return { event, replayed: false };
  };
  return {
    recordProviderAcceptance(incident, outbox) {
      check(outbox?.status === 'ACCEPTED' && outbox.incidentId === incident.incidentId, 'PITCH_RESPONSE_ACCEPTANCE_REQUIRED');
      return transact((state, at) => append(state, at, incident, { kind: 'PROVIDER_ACCEPTED', referenceId: id(outbox.receiptId),
        evidenceKind: 'OUTBOX_RECEIPT', performer: 'SYSTEM',
        assurance: outbox.reconciliationDigest ? 'OPERATOR_TRANSCRIBED' : 'LOCAL_OUTBOX_ACCEPTANCE',
        sourceAt: atValue(outbox.acceptedAt), actionId: null, readback: null }));
    },
    // Trusted runtime only: called after pitch-handoff verified the operator's password (and TOTP when enrolled)
    // through a single-use, incident-bound ACK link. No caller-supplied evidence kind reaches this path.
    recordVerifiedAck(incident, { referenceId }) {
      return transact((state, at) => append(state, at, incident, { kind: 'HUMAN_ACK', referenceId: id(referenceId),
        evidenceKind: 'VERIFIED_ACK_LINK', performer: 'HUMAN', assurance: 'LOCAL_VERIFIED_LOGIN',
        sourceAt: null, actionId: null, readback: null }));
    },
    record(input, { incident, canonical } = {}) {
      envelope(input, ['incidentId', 'contextId', 'epoch', 'kind', 'referenceId', 'evidenceKind', 'performer'], ['actionId']);
      check(incident && input.incidentId === incident.incidentId && input.contextId === incident.contextId
        && input.epoch === incident.epoch, 'PITCH_RESPONSE_SCOPE_CONFLICT');
      check(kinds.includes(input.kind) && input.kind !== 'PROVIDER_ACCEPTED', 'PITCH_RESPONSE_KIND_INVALID');
      id(input.referenceId); const action = ['ACTION_STARTED', 'ACTION_COMPLETED'].includes(input.kind);
      if (action) id(input.actionId); else check(!Object.hasOwn(input, 'actionId'), 'PITCH_RESPONSE_EVIDENCE_INVALID');
      let readback = null;
      if (input.kind === 'ACTION_COMPLETED') {
        check(canonical?.contextId === incident.contextId && canonical.worldId === incident.worldId && canonical.state === 'FENCED'
          && canonical.epoch === incident.epoch + 1 && canonical.fenceReason?.startsWith(`${input.actionId}: `), 'PITCH_RESPONSE_READBACK_INVALID');
        readback = { contextId: canonical.contextId, worldId: canonical.worldId, epoch: canonical.epoch, state: 'FENCED', actionId: input.actionId };
      }
      return transact((state, at) => append(state, at, incident, { kind: input.kind, referenceId: input.referenceId,
        evidenceKind: input.evidenceKind, performer: input.performer,
        assurance: input.kind === 'ACTION_COMPLETED' ? 'LOCAL_CANONICAL_READBACK' : 'OPERATOR_TRANSCRIBED',
        sourceAt: null, actionId: input.actionId ?? null, readback }, () => {
        if (input.kind === 'ACTION_STARTED') check(canonical?.contextId === incident.contextId
          && canonical.worldId === incident.worldId && canonical.epoch === incident.epoch
          && canonical.state === 'ACTIVE', 'PITCH_RESPONSE_ACTION_STALE');
      }));
    },
    snapshot() {
      return transact(state => ({ schemaVersion: PITCH_RESPONSE_VERSION, events: state.events,
        limitations: ['Provider acceptance is not delivery; a transcribed provider receipt is not independently verified.',
          'Reply observation is an upper bound for delivery, not an exact recipient timestamp.',
          'Owner-transcribed human evidence does not attest human identity or presence.',
          'A verified ACK link proves the local operator password (and TOTP when enrolled) on this host, not physical presence or reading time.',
          'Only canonical FENCED readback completes the response action.'] }));
    },
    close() { if (!closed) { closed = true; db.close(); } }
  };
}
