import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { openAuxiliary } from './auxiliary.mjs';
import { runtimeCheck as check, runtimeEnvelope as envelope, runtimeFamily as family,
  runtimeId as identifier, runtimeInteger as integer, runtimeHintLabel as hintLabel,
  WRONG_TICKET_ALERT_BOUNDS, WRONG_TICKET_ALERT_DEFAULTS, WRONG_TICKET_ENTRY_TYPES, WRONG_TICKET_LEDGER_VERSION,
  WRONG_TICKET_OUTCOMES, WRONG_TICKET_POSITIONS, WRONG_TICKET_SEVERITIES, WRONG_TICKET_SPREAD_REASONS,
  WRONG_TICKET_UPDATE_KINDS } from './contracts.mjs';

export const PITCH_CONTROL_VERSION = 'dungeonq.pitch-control/v1';
export const PITCH_CONTROL_DEFAULT_LIMITS = Object.freeze({
  windowMs: 60000, globalWindow: 240, globalTotal: 10000, globalConcurrent: 16,
  contextWindow: 120, contextTotal: 2048, contextConcurrent: 4,
  globalErrors: 512, contextErrors: 128, maxContexts: 64, maxIncidents: 256,
  maxSamples: 128, deliveryAttempts: 5, deliveryLeaseMs: 30000,
  deliveryTimeoutMs: 5000, retryBaseMs: 1000
});
const LIMIT_BOUNDS = Object.freeze({ windowMs: [1, 86400000], globalWindow: [1, 1000000],
  globalTotal: [1, 1000000000], globalConcurrent: [1, 256], contextWindow: [1, 1000000],
  contextTotal: [1, 1000000000], contextConcurrent: [1, 256], globalErrors: [1, 1000000000],
  contextErrors: [1, 1000000000], maxContexts: [1, 256], maxIncidents: [1, 1024],
  maxSamples: [1, 1024], deliveryAttempts: [1, 20], deliveryLeaseMs: [10, 3600000],
  deliveryTimeoutMs: [1, 60000], retryBaseMs: [1, 3600000] });
const SCHEMA = 'CREATE TABLE pitch_meta (id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL,state TEXT NOT NULL,digest TEXT NOT NULL)';
const OUTCOMES = ['SERVED', 'REFUSED', 'FAILED', 'UNKNOWN'];
const DENIALS = ['TOTAL', 'RATE', 'CONCURRENT', 'ERRORS', 'CONTEXTS'];
const DELIVERY_STATES = ['PENDING', 'IN_FLIGHT', 'ACCEPTED', 'UNKNOWN', 'EXHAUSTED'];
const RESOLUTIONS = ['FENCED', 'REVIEWED', 'FALSE_POSITIVE'];
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = value => structuredClone(value);
const increase = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
const counter = at => ({ attempts: 0, admitted: 0, finished: 0, errors: 0,
  window: { startedAt: at, attempts: 0 }, outcomes: Object.fromEntries(OUTCOMES.map(key => [key, 0])),
  denials: Object.fromEntries(DENIALS.map(key => [key, 0])) });
const coded = code => Object.assign(new Error(code), { code });
const nullableId = value => value === null || identifier(value);
const atValue = value => integer(value, 0, Number.MAX_SAFE_INTEGER, 'PITCH_STATE_INVALID');
const nullableAt = value => value === null || atValue(value);
const HEX64 = /^[a-f0-9]{64}$/;
const TICKET_SCHEMA = 'CREATE TABLE pitch_ticket_uses (seq INTEGER PRIMARY KEY,use_id TEXT NOT NULL UNIQUE,record TEXT NOT NULL,digest TEXT NOT NULL)';
const TICKET_USE_FIELDS = ['useId', 'seq', 'trackId', 'incidentId', 'incidentUse', 'at', 'contextId', 'entry', 'position',
  'client', 'source', 'spread', 'severity', 'outcome', 'code', 'replayed', 'settledAt'];
const DELIVERY_FIELDS = ['status', 'attempts', 'nextAttemptAt', 'leaseId', 'leaseExpiresAt', 'receiptId', 'acceptedAt',
  'lastError', 'uncertainAt', 'reconciliationDigest'];
const UPDATE_FIELDS = ['updateId', 'incidentId', 'ordinal', 'kind', 'idempotencyKey', 'severity', 'createdAt', 'fromUse',
  'toUse', 'useCount', 'spreadUses', 'firstSpread', 'distinctContexts', 'distinctSources', ...DELIVERY_FIELDS];

/** Domain-separated digest of a presented participant ticket. The ledger never stores the capability itself. */
export function ticketHandleDigest(handle) {
  check(typeof handle === 'string' && handle.length >= 1 && handle.length <= 4096, 'TICKET_INVALID');
  return createHash('sha256').update('dungeonq.ticket-presentation/v1\0').update(handle).digest('hex');
}

function ticketLimitsFor(value) {
  if (value === undefined || value === false) return null;
  const supplied = value === true ? {} : value;
  envelope(supplied, [], Object.keys(WRONG_TICKET_ALERT_DEFAULTS));
  const limits = { ...WRONG_TICKET_ALERT_DEFAULTS, ...supplied };
  for (const [key, bounds] of Object.entries(WRONG_TICKET_ALERT_BOUNDS)) integer(limits[key], ...bounds, 'PITCH_TICKET_LIMITS_INVALID');
  return limits;
}

function validateDelivery(row, limits) {
  check(DELIVERY_STATES.includes(row.status), 'PITCH_STATE_INVALID');
  integer(row.attempts, 0, limits.deliveryAttempts); atValue(row.nextAttemptAt);
  nullableId(row.leaseId); nullableAt(row.leaseExpiresAt); nullableId(row.receiptId); nullableAt(row.acceptedAt); nullableAt(row.uncertainAt);
  check(row.lastError === null || ['TRANSPORT_UNKNOWN', 'RELAY_UNKNOWN', 'RECEIPT_INVALID', 'NOT_ACCEPTED', 'LEASE_EXPIRED', 'TIMEOUT'].includes(row.lastError), 'PITCH_STATE_INVALID');
  check(row.reconciliationDigest === null || HEX64.test(row.reconciliationDigest), 'PITCH_STATE_INVALID');
  check(row.status === 'IN_FLIGHT' ? row.leaseId !== null && row.leaseExpiresAt !== null
    : row.leaseId === null && row.leaseExpiresAt === null, 'PITCH_STATE_INVALID');
  check(row.status === 'ACCEPTED' ? row.receiptId !== null && row.acceptedAt !== null
    : row.receiptId === null && row.acceptedAt === null, 'PITCH_STATE_INVALID');
}

const label = value => value === null || (typeof value === 'string' && hintLabel(value) === value);
const ordered = (values, vocabulary) => vocabulary.filter(value => values.includes(value));

// Every ledger invariant is re-checked on each transaction; a mismatch is corruption, never a reset.
function validateLedger(ledger, state, limits, ticketLimits) {
  envelope(ledger, ['version', 'useCount', 'refusedAtCapacity', 'tickets', 'incidents', 'updates']);
  check(ledger.version === WRONG_TICKET_LEDGER_VERSION, 'PITCH_SCHEMA_UNSUPPORTED');
  integer(ledger.useCount, 0, ticketLimits.maxUses, 'PITCH_STATE_INVALID'); atValue(ledger.refusedAtCapacity);
  check(Array.isArray(ledger.tickets) && ledger.tickets.length <= ticketLimits.maxTrackedTickets
    && Array.isArray(ledger.incidents) && ledger.incidents.length <= limits.maxIncidents
    && Array.isArray(ledger.updates) && ledger.updates.length <= limits.maxIncidents * ticketLimits.maxUpdatesPerIncident, 'PITCH_STATE_INVALID');
  for (const key of ['trackId', 'handleDigest', 'ticketId']) check(new Set(ledger.tickets.map(row => row[key])).size === ledger.tickets.length, 'PITCH_STATE_INVALID');
  check(new Set(ledger.incidents.map(row => row.incidentId)).size === ledger.incidents.length
    && new Set(ledger.updates.map(row => row.idempotencyKey)).size === ledger.updates.length, 'PITCH_STATE_INVALID');
  for (const row of ledger.tickets) {
    envelope(row, ['trackId', 'ticketId', 'handleDigest', 'incidentId', 'contextId', 'worldId', 'epoch', 'entry', 'issuedAt',
      'expiresAt', 'issuedSource', 'uses', 'accepted', 'contexts', 'sources', 'otherSightings', 'spread']);
    check(/^wt-[a-f0-9]{32}$/.test(row.trackId) && row.trackId === trackIdentity(row.ticketId)
      && HEX64.test(row.ticketId) && HEX64.test(row.handleDigest), 'PITCH_STATE_INVALID');
    identifier(row.contextId); identifier(row.worldId); integer(row.epoch, 1, Number.MAX_SAFE_INTEGER);
    check(row.incidentId === incidentIdentity(row) && state.incidents.some(i => i.incidentId === row.incidentId)
      && WRONG_TICKET_ENTRY_TYPES.includes(row.entry) && label(row.issuedSource), 'PITCH_STATE_INVALID');
    atValue(row.issuedAt); atValue(row.expiresAt); atValue(row.uses); atValue(row.accepted); atValue(row.otherSightings);
    check(row.expiresAt > row.issuedAt && row.accepted <= row.uses, 'PITCH_STATE_INVALID');
    check(Array.isArray(row.contexts) && row.contexts.length <= ticketLimits.maxSightings && new Set(row.contexts).size === row.contexts.length
      && row.contexts.every(value => value === null || identifier(value)), 'PITCH_STATE_INVALID');
    check(Array.isArray(row.sources) && row.sources.length <= ticketLimits.maxSightings && new Set(row.sources).size === row.sources.length
      && row.sources.every(value => value !== null && label(value)), 'PITCH_STATE_INVALID');
    check(Array.isArray(row.spread) && JSON.stringify(row.spread) === JSON.stringify(ordered(row.spread, WRONG_TICKET_SPREAD_REASONS)), 'PITCH_STATE_INVALID');
  }
  let total = 0;
  for (const row of ledger.incidents) {
    envelope(row, ['incidentId', 'severity', 'uses', 'spreadUses', 'firstUseAt', 'lastUseAt', 'updates', 'coveredUses',
      'lastUpdateAt', 'pendingUses', 'pendingSpreadUses', 'pendingSince', 'suppressedUses']);
    check(state.incidents.some(i => i.incidentId === row.incidentId) && WRONG_TICKET_SEVERITIES.includes(row.severity), 'PITCH_STATE_INVALID');
    for (const key of ['uses', 'spreadUses', 'firstUseAt', 'lastUseAt', 'coveredUses', 'pendingUses', 'pendingSpreadUses', 'suppressedUses']) atValue(row[key]);
    integer(row.updates, 0, ticketLimits.maxUpdatesPerIncident, 'PITCH_STATE_INVALID'); nullableAt(row.lastUpdateAt); nullableAt(row.pendingSince);
    const own = ledger.updates.filter(update => update.incidentId === row.incidentId);
    // Summaries only group records: covered + pending + suppressed is exactly the number of recorded uses.
    check(row.uses >= 1 && row.coveredUses + row.pendingUses + row.suppressedUses === row.uses
      && row.spreadUses <= row.uses && row.pendingSpreadUses <= row.pendingUses
      && row.severity === (row.spreadUses > 0 ? 'CRITICAL' : 'HIGH') && row.firstUseAt <= row.lastUseAt
      && own.length === row.updates && (row.updates === 0) === (row.lastUpdateAt === null)
      && (row.pendingUses > 0) === (row.pendingSince !== null)
      && (row.suppressedUses === 0 || row.updates === ticketLimits.maxUpdatesPerIncident && row.pendingUses === 0), 'PITCH_STATE_INVALID');
    let covered = 0;
    for (const [index, update] of own.entries()) {
      check(update.ordinal === index + 1 && update.fromUse === covered + 1 && update.toUse === covered + update.useCount, 'PITCH_STATE_INVALID');
      covered = update.toUse;
    }
    check(covered === row.coveredUses, 'PITCH_STATE_INVALID'); total += row.uses;
  }
  check(total === ledger.useCount, 'PITCH_STATE_INVALID');
  for (const row of ledger.updates) {
    envelope(row, UPDATE_FIELDS);
    check(ledger.incidents.some(i => i.incidentId === row.incidentId) && WRONG_TICKET_UPDATE_KINDS.includes(row.kind)
      && row.kind === (row.ordinal === 1 ? 'FIRST_USE' : 'DIGEST') && WRONG_TICKET_SEVERITIES.includes(row.severity)
      && row.idempotencyKey === `pitch-ticket-update-v1:${row.incidentId}:${row.ordinal}`
      && row.updateId === `ticket-update-${hash([row.incidentId, row.ordinal]).slice(0, 32)}`
      && typeof row.firstSpread === 'boolean', 'PITCH_STATE_INVALID');
    integer(row.ordinal, 1, ticketLimits.maxUpdatesPerIncident, 'PITCH_STATE_INVALID'); atValue(row.createdAt);
    for (const key of ['fromUse', 'toUse', 'useCount', 'distinctContexts']) integer(row[key], 1, Number.MAX_SAFE_INTEGER, 'PITCH_STATE_INVALID');
    atValue(row.spreadUses); atValue(row.distinctSources); check(row.spreadUses <= row.useCount, 'PITCH_STATE_INVALID');
    validateDelivery(row, limits);
  }
}

function trackIdentity(ticketId) {
  return `wt-${hash(['dungeonq.wrong-ticket-track/v1', ticketId]).slice(0, 32)}`;
}

function limitsFor(value = {}) {
  envelope(value, [], Object.keys(PITCH_CONTROL_DEFAULT_LIMITS));
  const limits = { ...PITCH_CONTROL_DEFAULT_LIMITS, ...value };
  for (const [key, bounds] of Object.entries(LIMIT_BOUNDS)) integer(limits[key], ...bounds, 'PITCH_LIMITS_INVALID');
  check(limits.contextConcurrent <= limits.globalConcurrent && limits.contextWindow <= limits.globalWindow
    && limits.contextTotal <= limits.globalTotal && limits.contextErrors <= limits.globalErrors
    && limits.deliveryTimeoutMs < limits.deliveryLeaseMs, 'PITCH_LIMITS_INVALID');
  return limits;
}

function validateCounter(value) {
  envelope(value, ['attempts', 'admitted', 'finished', 'errors', 'window', 'outcomes', 'denials']);
  for (const key of ['attempts', 'admitted', 'finished', 'errors']) atValue(value[key]);
  check(value.admitted <= value.attempts && value.finished <= value.attempts, 'PITCH_STATE_INVALID');
  envelope(value.window, ['startedAt', 'attempts']); atValue(value.window.startedAt); atValue(value.window.attempts);
  envelope(value.outcomes, OUTCOMES); envelope(value.denials, DENIALS);
  for (const number of [...Object.values(value.outcomes), ...Object.values(value.denials)]) atValue(number);
}

function validateState(state, limits, ticketLimits = null) {
  const keys = ['version', 'lastAt', 'global', 'contexts', 'leases', 'samples', 'incidents', 'outbox', ...(ticketLimits ? ['ticketLedger'] : [])];
  check(state && typeof state === 'object' && !Array.isArray(state)
    && Object.keys(state).length === keys.length && keys.every(key => Object.hasOwn(state, key)), 'PITCH_STATE_INVALID');
  check(state.version === PITCH_CONTROL_VERSION, 'PITCH_SCHEMA_UNSUPPORTED'); atValue(state.lastAt);
  validateCounter(state.global);
  for (const [key, maximum] of [['contexts', limits.maxContexts], ['leases', limits.globalConcurrent],
    ['samples', limits.maxSamples], ['incidents', limits.maxIncidents], ['outbox', limits.maxIncidents]]) {
    check(Array.isArray(state[key]) && state[key].length <= maximum, 'PITCH_STATE_INVALID');
  }
  const unique = (rows, key) => check(new Set(rows.map(row => row[key])).size === rows.length, 'PITCH_STATE_INVALID');
  unique(state.contexts, 'contextId'); unique(state.leases, 'leaseId'); unique(state.incidents, 'incidentId'); unique(state.outbox, 'incidentId');
  for (const row of state.contexts) {
    envelope(row, ['contextId', 'budget']); identifier(row.contextId); validateCounter(row.budget);
  }
  for (const row of state.leases) {
    envelope(row, ['leaseId', 'family', 'startedAt', 'contextId', 'binding', 'bindCode']);
    identifier(row.leaseId); family(row.family); atValue(row.startedAt); nullableId(row.contextId);
    check(['UNBOUND', 'BOUND', 'REFUSED'].includes(row.binding), 'PITCH_STATE_INVALID');
    check(row.contextId === null ? row.binding === 'UNBOUND' : state.contexts.some(c => c.contextId === row.contextId), 'PITCH_STATE_INVALID');
    check(row.binding === 'REFUSED' ? /^PITCH_CONTEXT_(TOTAL|RATE|CONCURRENT|ERRORS)$/.test(row.bindCode) : row.bindCode === null, 'PITCH_STATE_INVALID');
  }
  for (const row of state.samples) {
    envelope(row, ['at', 'family', 'contextId', 'outcome', 'category', 'codeDigest', 'evidenceDigest']);
    atValue(row.at); family(row.family); nullableId(row.contextId);
    check(OUTCOMES.includes(row.outcome) && ['SUCCESS', 'AUTHENTICATION', 'BUDGET', 'INPUT', 'EXECUTION', 'RECONCILIATION', 'OTHER'].includes(row.category), 'PITCH_STATE_INVALID');
    check(/^[a-f0-9]{64}$/.test(row.codeDigest), 'PITCH_STATE_INVALID');
    check(row.evidenceDigest === null || /^[a-f0-9]{64}$/.test(row.evidenceDigest), 'PITCH_STATE_INVALID');
  }
  for (const row of state.incidents) {
    envelope(row, ['incidentId', 'contextId', 'worldId', 'epoch', 'phase', 'admittedEventId', 'entryEventId',
      'admittedAt', 'enteredAt', 'localInbox', 'acknowledgement', 'resolution']);
    for (const key of ['incidentId', 'contextId', 'worldId', 'admittedEventId']) identifier(row[key]);
    integer(row.epoch, 1, Number.MAX_SAFE_INTEGER); nullableId(row.entryEventId);
    atValue(row.admittedAt); nullableAt(row.enteredAt);
    check(state.contexts.some(c => c.contextId === row.contextId) && ['ADMITTED', 'ENTERED'].includes(row.phase)
      && row.localInbox === 'AVAILABLE' && row.incidentId === incidentIdentity(row), 'PITCH_STATE_INVALID');
    check(row.phase === 'ADMITTED' ? row.enteredAt === null && row.entryEventId === null
      : row.enteredAt !== null && row.entryEventId !== null, 'PITCH_STATE_INVALID');
    if (row.acknowledgement !== null) {
      envelope(row.acknowledgement, ['operatorId', 'at']); identifier(row.acknowledgement.operatorId); atValue(row.acknowledgement.at);
    }
    if (row.resolution !== null) {
      envelope(row.resolution, ['operatorId', 'at', 'resolution']); identifier(row.resolution.operatorId); atValue(row.resolution.at);
      check(row.acknowledgement !== null && RESOLUTIONS.includes(row.resolution.resolution), 'PITCH_STATE_INVALID');
    }
  }
  check(state.outbox.length === state.incidents.length, 'PITCH_STATE_INVALID');
  for (const row of state.outbox) {
    envelope(row, ['incidentId', 'idempotencyKey', ...DELIVERY_FIELDS]);
    identifier(row.incidentId);
    check(state.incidents.some(i => i.incidentId === row.incidentId) && row.idempotencyKey === `pitch-alert-v1:${row.incidentId}`, 'PITCH_STATE_INVALID');
    validateDelivery(row, limits);
  }
  if (ticketLimits) validateLedger(state.ticketLedger, state, limits, ticketLimits);
  return state;
}

function incidentIdentity({ contextId, worldId, epoch }) {
  return `incident-${hash([contextId, worldId, epoch])}`;
}
function entryInput(value) {
  envelope(value, ['contextId', 'worldId', 'epoch', 'eventId']);
  for (const key of ['contextId', 'worldId', 'eventId']) identifier(value[key]);
  integer(value.epoch, 1, Number.MAX_SAFE_INTEGER);
}
function category(code) {
  if (code === 'OK') return 'SUCCESS';
  if (code === 'LEASE_RECONCILED') return 'RECONCILIATION';
  if (['UNAUTHORIZED', 'CONTEXT_UNKNOWN', 'CONTEXT_FENCED', 'AUTHENTICATION_FAILED'].includes(code)) return 'AUTHENTICATION';
  if (/^PITCH_(GLOBAL|CONTEXT)_/.test(code)) return 'BUDGET';
  if (['INVALID_ENVELOPE', 'REQUEST_ID_INVALID', 'OPERATION_DENIED', 'BODY_LIMIT', 'BODY_INVALID', 'FAMILY_UNSUPPORTED'].includes(code)) return 'INPUT';
  if (['EXECUTION_FAILED', 'TRANSPORT_UNKNOWN'].includes(code)) return 'EXECUTION';
  return 'OTHER';
}

/** Trusted assembly only. The caller authenticates owner APIs and verified contexts.
 * No participant token, ticket, body or arbitrary message is accepted or stored.
 * One local SQLite file coordinates handles; this is not a distributed limiter.
 */
export function openPitchControl({ path, clock = Date.now, limits: supplied, ticketTracking } = {}) {
  check(typeof path === 'string' && isAbsolute(path), 'STORAGE_PATH_INVALID');
  check(typeof clock === 'function', 'CLOCK_INVALID');
  const limits = limitsFor(supplied);
  // Opt-in only. Disabled ledgers keep the exact v1 schema, config bytes and state shape.
  const ticketLimits = ticketLimitsFor(ticketTracking);
  const rawNow = () => integer(clock(), 0, Number.MAX_SAFE_INTEGER - 7200000, 'CLOCK_INVALID');
  const initialAt = rawNow();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  check(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o022) === 0, 'STORAGE_DIRECTORY_INVALID');
  const db = openAuxiliary(path, ticketLimits ? `${SCHEMA};${TICKET_SCHEMA}` : SCHEMA, 'pitch_meta'); let closed = false;
  const config = JSON.stringify({ version: PITCH_CONTROL_VERSION, limits,
    ...(ticketLimits ? { ticketTracking: { version: WRONG_TICKET_LEDGER_VERSION, limits: ticketLimits } } : {}) });
  const live = () => check(!closed, 'PITCH_CONTROL_CLOSED');
  const read = () => {
    const row = db.prepare('SELECT * FROM pitch_meta WHERE id=1').get();
    check(row && row.config === config, 'PITCH_CONFIG_CHANGED');
    check(Buffer.byteLength(row.state) <= MAX_STATE_BYTES, 'PITCH_STATE_INVALID');
    const state = JSON.parse(row.state); check(hash(state) === row.digest, 'PITCH_STATE_CORRUPT');
    validateState(state, limits, ticketLimits);
    if (ticketLimits) {
      // The ledger counter and the append-only use rows must agree before any new decision.
      const rows = db.prepare('SELECT count(*) AS n,coalesce(max(seq),0) AS high FROM pitch_ticket_uses').get();
      check(rows.n === state.ticketLedger.useCount && rows.high === rows.n, 'PITCH_TICKET_LEDGER_CORRUPT');
    }
    return state;
  };
  const write = state => {
    validateState(state, limits, ticketLimits); const json = JSON.stringify(state);
    check(Buffer.byteLength(json) <= MAX_STATE_BYTES, 'PITCH_STATE_LIMIT');
    db.prepare('UPDATE pitch_meta SET state=?,digest=? WHERE id=1').run(json, hash(state));
  };
  const transact = action => {
    live(); db.exec('BEGIN IMMEDIATE');
    try {
      const state = read(); const at = Math.max(rawNow(), state.lastAt); state.lastAt = at;
      const result = action(state, at); write(state); db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  try {
    db.exec('PRAGMA wal_autocheckpoint=64; PRAGMA journal_size_limit=1048576;');
    if (!db.prepare('SELECT id FROM pitch_meta WHERE id=1').get()) {
      const at = initialAt; const state = { version: PITCH_CONTROL_VERSION, lastAt: at, global: counter(at),
        contexts: [], leases: [], samples: [], incidents: [], outbox: [],
        ...(ticketLimits ? { ticketLedger: { version: WRONG_TICKET_LEDGER_VERSION, useCount: 0, refusedAtCapacity: 0,
          tickets: [], incidents: [], updates: [] } } : {}) };
      db.prepare('INSERT INTO pitch_meta VALUES(1,?,?,?)').run(config, JSON.stringify(state), hash(state));
    }
    read();
  } catch (error) { db.close(); throw error; }

  const addSample = (state, lease, outcome, code, at) => {
    state.samples.push({ at, family: lease.family, contextId: lease.contextId, outcome,
      category: category(code), codeDigest: hash(code), evidenceDigest: null });
    if (state.samples.length > limits.maxSamples) state.samples.shift();
  };
  const countAttempt = (budget, at) => {
    if (at - budget.window.startedAt >= limits.windowMs) budget.window = { startedAt: at, attempts: 0 };
    budget.attempts = increase(budget.attempts); budget.window.attempts = increase(budget.window.attempts);
  };
  const denial = (budget, prefix, concurrent) => {
    if (budget.attempts > limits[`${prefix}Total`]) return 'TOTAL';
    if (budget.window.attempts > limits[`${prefix}Window`]) return 'RATE';
    if (concurrent >= limits[`${prefix}Concurrent`]) return 'CONCURRENT';
    if (budget.errors >= limits[`${prefix}Errors`]) return 'ERRORS';
    return null;
  };
  const complete = (state, row, outcome, code, at) => {
    const budgets = [state.global, ...(row.contextId === null ? [] : [state.contexts.find(c => c.contextId === row.contextId).budget])];
    for (const budget of budgets) {
      budget.finished = increase(budget.finished); budget.outcomes[outcome] = increase(budget.outcomes[outcome]);
      if (outcome !== 'SERVED') budget.errors = increase(budget.errors);
    }
    addSample(state, row, outcome, code, at);
    state.leases = state.leases.filter(lease => lease.leaseId !== row.leaseId);
    return { finished: true, outcome };
  };
  const leaseRow = (state, lease) => {
    envelope(lease, ['leaseId']); identifier(lease.leaseId);
    const row = state.leases.find(item => item.leaseId === lease.leaseId);
    check(row, 'PITCH_LEASE_UNKNOWN'); return row;
  };
  const incidentRow = (state, incidentId) => {
    identifier(incidentId); const row = state.incidents.find(item => item.incidentId === incidentId);
    check(row, 'PITCH_INCIDENT_UNKNOWN'); return row;
  };
  const reserve = (state, input, at) => {
    check(state.contexts.some(row => row.contextId === input.contextId), 'PITCH_CONTEXT_UNKNOWN');
    const incidentId = incidentIdentity(input); let incident = state.incidents.find(row => row.incidentId === incidentId);
    if (incident) return { incident, replayed: true };
    check(state.incidents.length < limits.maxIncidents, 'PITCH_INCIDENT_CAPACITY');
    incident = { incidentId, contextId: input.contextId, worldId: input.worldId, epoch: input.epoch,
      phase: 'ADMITTED', admittedEventId: input.eventId, entryEventId: null, admittedAt: at, enteredAt: null,
      localInbox: 'AVAILABLE', acknowledgement: null, resolution: null };
    state.incidents.push(incident);
    state.outbox.push({ incidentId, idempotencyKey: `pitch-alert-v1:${incidentId}`, status: 'PENDING', attempts: 0,
      nextAttemptAt: at, leaseId: null, leaseExpiresAt: null, receiptId: null, acceptedAt: null,
      lastError: null, uncertainAt: null, reconciliationDigest: null });
    return { incident, replayed: false };
  };
  const expireDeliveries = (state, at) => {
    for (const row of state.outbox) if (row.status === 'IN_FLIGHT' && row.leaseExpiresAt <= at) {
      row.status = 'UNKNOWN'; row.uncertainAt = at;
      row.lastError = row.leaseId?.startsWith('relay-') ? 'RELAY_UNKNOWN' : 'LEASE_EXPIRED';
      row.leaseId = null; row.leaseExpiresAt = null;
    }
    // M3 ticket-update claims follow the same rule: an expired claim is UNKNOWN and never re-sent blindly.
    if (ticketLimits) for (const row of state.ticketLedger.updates) if (row.status === 'IN_FLIGHT' && row.leaseExpiresAt <= at) {
      row.status = 'UNKNOWN'; row.uncertainAt = at; row.lastError = 'LEASE_EXPIRED';
      row.leaseId = null; row.leaseExpiresAt = null;
    }
  };
  const clearDeliveryLease = row => { row.leaseId = null; row.leaseExpiresAt = null; };
  const acceptDelivery = (row, receiptId, at) => {
    row.status = 'ACCEPTED'; row.receiptId = receiptId; row.acceptedAt = at; row.lastError = null;
    row.uncertainAt = null; clearDeliveryLease(row);
  };
  const relayScope = (state, input) => {
    const incident = incidentRow(state, input.incidentId);
    check(incident.contextId === input.contextId && incident.epoch === input.epoch, 'PITCH_RELAY_SCOPE_CONFLICT');
    check(incident.phase === 'ENTERED', 'PITCH_RELAY_ENTRY_REQUIRED');
    return { incident, row: state.outbox.find(item => item.incidentId === input.incidentId) };
  };
  const relayResult = result => { if (result.error) throw coded(result.error); return result; };
  const ticketsOn = () => check(ticketLimits !== null, 'PITCH_TICKET_TRACKING_DISABLED');
  const readUse = row => {
    const record = JSON.parse(row.record);
    check(hash(record) === row.digest && record.seq === row.seq && record.useId === row.use_id, 'PITCH_TICKET_LEDGER_CORRUPT');
    envelope(record, TICKET_USE_FIELDS); check(WRONG_TICKET_OUTCOMES.includes(record.outcome), 'PITCH_TICKET_LEDGER_CORRUPT');
    return record;
  };
  const recentUses = count => db.prepare('SELECT * FROM pitch_ticket_uses ORDER BY seq DESC LIMIT ?').all(count).reverse().map(readUse);
  const sighting = (ticket, list, value) => {
    if (list.includes(value)) return;
    if (list.length < ticketLimits.maxSightings) list.push(value); else ticket.otherSightings = increase(ticket.otherSightings);
  };
  // One update groups every not-yet-covered use of the incident; it never drops or merges records.
  const enqueueTicketUpdate = (ledger, row, at) => {
    const ordinal = row.updates + 1;
    const tickets = ledger.tickets.filter(ticket => ticket.incidentId === row.incidentId);
    const contexts = new Set(tickets.flatMap(ticket => ticket.contexts)); const sources = new Set(tickets.flatMap(ticket => ticket.sources));
    ledger.updates.push({ updateId: `ticket-update-${hash([row.incidentId, ordinal]).slice(0, 32)}`, incidentId: row.incidentId, ordinal,
      kind: ordinal === 1 ? 'FIRST_USE' : 'DIGEST', idempotencyKey: `pitch-ticket-update-v1:${row.incidentId}:${ordinal}`,
      severity: row.severity, createdAt: at, fromUse: row.coveredUses + 1, toUse: row.coveredUses + row.pendingUses,
      useCount: row.pendingUses, spreadUses: row.pendingSpreadUses, firstSpread: row.pendingSpreadUses > 0 && row.spreadUses === row.pendingSpreadUses,
      distinctContexts: Math.max(1, contexts.size), distinctSources: sources.size,
      status: 'PENDING', attempts: 0, nextAttemptAt: at, leaseId: null, leaseExpiresAt: null, receiptId: null, acceptedAt: null,
      lastError: null, uncertainAt: null, reconciliationDigest: null });
    row.updates = ordinal; row.coveredUses += row.pendingUses; row.lastUpdateAt = at;
    row.pendingUses = 0; row.pendingSpreadUses = 0; row.pendingSince = null;
  };
  // Lazy and bounded: no timer exists. Status reads, new uses and the M3 read path release due digests.
  const materializeTicketUpdates = (state, at) => {
    if (!ticketLimits) return;
    for (const row of state.ticketLedger.incidents) if (row.pendingUses > 0 && row.updates < ticketLimits.maxUpdatesPerIncident
      && at - row.lastUpdateAt >= ticketLimits.digestIntervalMs) enqueueTicketUpdate(state.ticketLedger, row, at);
  };
  const ledgerView = state => ({ ...state.ticketLedger, limits: ticketLimits, recentUses: recentUses(32),
    pendingUpdates: state.ticketLedger.updates.filter(row => row.status === 'PENDING').length });

  return {
    begin(input) {
      envelope(input, ['family']); family(input.family);
      const result = transact((state, at) => {
        countAttempt(state.global, at); const reason = denial(state.global, 'global', state.leases.length);
        if (reason) {
          state.global.denials[reason] = increase(state.global.denials[reason]);
          state.global.finished = increase(state.global.finished); state.global.errors = increase(state.global.errors);
          state.global.outcomes.REFUSED = increase(state.global.outcomes.REFUSED);
          const code = `PITCH_GLOBAL_${reason}`;
          addSample(state, { family: input.family, contextId: null }, 'REFUSED', code, at);
          return { error: code };
        }
        const leaseId = randomUUID(); state.global.admitted = increase(state.global.admitted);
        state.leases.push({ leaseId, family: input.family, startedAt: at, contextId: null, binding: 'UNBOUND', bindCode: null });
        return { leaseId };
      });
      if (result.error) throw coded(result.error); return result;
    },
    bind(lease, input) {
      envelope(input, ['contextId']); identifier(input.contextId);
      const result = transact((state, at) => {
        const row = leaseRow(state, lease);
        check(row.contextId === null || row.contextId === input.contextId, 'PITCH_LEASE_REBOUND');
        if (row.contextId !== null) return row.bindCode ? { error: row.bindCode } : { contextId: row.contextId, replayed: true };
        let context = state.contexts.find(item => item.contextId === input.contextId);
        if (!context) {
          if (state.contexts.length >= limits.maxContexts) {
            state.global.denials.CONTEXTS = increase(state.global.denials.CONTEXTS);
            return { error: 'PITCH_GLOBAL_CONTEXTS' };
          }
          context = { contextId: input.contextId, budget: counter(at) }; state.contexts.push(context);
        }
        countAttempt(context.budget, at);
        const active = state.leases.filter(item => item.contextId === input.contextId).length;
        row.contextId = input.contextId; const reason = denial(context.budget, 'context', active);
        if (reason) {
          context.budget.denials[reason] = increase(context.budget.denials[reason]);
          row.binding = 'REFUSED'; row.bindCode = `PITCH_CONTEXT_${reason}`; return { error: row.bindCode };
        }
        context.budget.admitted = increase(context.budget.admitted); row.binding = 'BOUND';
        return { contextId: row.contextId, replayed: false };
      });
      if (result.error) throw coded(result.error); return result;
    },
    finish(lease, input) {
      envelope(input, ['outcome', 'code']); check(OUTCOMES.includes(input.outcome), 'PITCH_OUTCOME_INVALID');
      check(typeof input.code === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(input.code), 'PITCH_CODE_INVALID');
      return transact((state, at) => {
        const row = leaseRow(state, lease);
        check(input.outcome !== 'SERVED' || row.binding === 'BOUND', 'PITCH_BIND_REQUIRED');
        return complete(state, row, input.outcome, input.code, at);
      });
    },
    snapshot() {
      return transact((state, at) => {
        expireDeliveries(state, at); materializeTicketUpdates(state, at);
        return copy({ schemaVersion: PITCH_CONTROL_VERSION, limits, global: state.global, contexts: state.contexts,
          activeLeases: state.leases, samples: state.samples, incidents: state.incidents, outbox: state.outbox,
          clockAt: state.lastAt, scope: 'SINGLE_HOST_REFERENCE', ...(ticketLimits ? { ticketLedger: ledgerView(state) } : {}) });
      });
    },
    ticketTracking: ticketLimits !== null,
    // Called only after the canonical store issued a ticket and before its handle leaves the gateway.
    trackTicket(input) {
      ticketsOn();
      envelope(input, ['ticketId', 'handleDigest', 'contextId', 'worldId', 'epoch', 'entry', 'issuedAt', 'expiresAt'], ['source']);
      check(HEX64.test(input.ticketId) && HEX64.test(input.handleDigest) && WRONG_TICKET_ENTRY_TYPES.includes(input.entry), 'PITCH_TICKET_INVALID');
      identifier(input.contextId); identifier(input.worldId); integer(input.epoch, 1, Number.MAX_SAFE_INTEGER);
      atValue(input.issuedAt); atValue(input.expiresAt); check(input.expiresAt > input.issuedAt, 'PITCH_TICKET_INVALID');
      const source = hintLabel(input.source ?? null);
      const result = transact((state, at) => {
        const ledger = state.ticketLedger; materializeTicketUpdates(state, at);
        const trackId = trackIdentity(input.ticketId); const existing = ledger.tickets.find(row => row.trackId === trackId);
        if (existing) {
          check(existing.handleDigest === input.handleDigest && existing.contextId === input.contextId && existing.worldId === input.worldId
            && existing.epoch === input.epoch && existing.issuedAt === input.issuedAt && existing.expiresAt === input.expiresAt, 'PITCH_TICKET_CONFLICT');
          return copy({ ticket: existing, replayed: true });
        }
        check(!ledger.tickets.some(row => row.handleDigest === input.handleDigest), 'PITCH_TICKET_CONFLICT');
        const incidentId = incidentIdentity(input);
        check(state.incidents.some(row => row.incidentId === incidentId), 'PITCH_INCIDENT_UNKNOWN');
        if (ledger.tickets.length >= ticketLimits.maxTrackedTickets) return { error: 'PITCH_TICKET_CAPACITY' };
        const ticket = { trackId, ticketId: input.ticketId, handleDigest: input.handleDigest, incidentId, contextId: input.contextId,
          worldId: input.worldId, epoch: input.epoch, entry: input.entry, issuedAt: input.issuedAt, expiresAt: input.expiresAt,
          issuedSource: source, uses: 0, accepted: 0, contexts: [], sources: [], otherSightings: 0, spread: [] };
        ledger.tickets.push(ticket); return copy({ ticket, replayed: false });
      });
      return relayResult(result);
    },
    // Recorded before any canonical or origin effect. An unrecorded presentation must be refused by the caller.
    recordTicketUse(input) {
      ticketsOn();
      envelope(input, ['handleDigest', 'contextId', 'entry', 'position'], ['client', 'source']);
      check(HEX64.test(input.handleDigest) && WRONG_TICKET_ENTRY_TYPES.includes(input.entry)
        && WRONG_TICKET_POSITIONS.includes(input.position), 'PITCH_TICKET_INVALID');
      nullableId(input.contextId);
      const client = hintLabel(input.client ?? null); const source = hintLabel(input.source ?? null);
      const result = transact((state, at) => {
        const ledger = state.ticketLedger; materializeTicketUpdates(state, at);
        const ticket = ledger.tickets.find(row => row.handleDigest === input.handleDigest);
        if (!ticket) return { tracked: false };
        if (ledger.useCount >= ticketLimits.maxUses) {
          ledger.refusedAtCapacity = increase(ledger.refusedAtCapacity); return { error: 'PITCH_TICKET_LEDGER_LIMIT' };
        }
        let row = ledger.incidents.find(item => item.incidentId === ticket.incidentId);
        if (!row) {
          row = { incidentId: ticket.incidentId, severity: 'HIGH', uses: 0, spreadUses: 0, firstUseAt: at, lastUseAt: at, updates: 0,
            coveredUses: 0, lastUpdateAt: null, pendingUses: 0, pendingSpreadUses: 0, pendingSince: null, suppressedUses: 0 };
          ledger.incidents.push(row);
        }
        const reference = ticket.issuedSource ?? ticket.sources[0] ?? null;
        const spread = ordered([...(input.contextId !== ticket.contextId ? ['CONTEXT'] : []),
          ...(source !== null && reference !== null && source !== reference ? ['SOURCE'] : [])], WRONG_TICKET_SPREAD_REASONS);
        sighting(ticket, ticket.contexts, input.contextId); if (source !== null) sighting(ticket, ticket.sources, source);
        ticket.uses = increase(ticket.uses); ticket.spread = ordered([...ticket.spread, ...spread], WRONG_TICKET_SPREAD_REASONS);
        // D9 supplement (2026-10-20): the first observed spread of an incident is released immediately.
        const firstSpread = spread.length > 0 && row.spreadUses === 0;
        row.uses += 1; row.lastUseAt = at; if (spread.length > 0) row.spreadUses += 1;
        row.severity = row.spreadUses > 0 ? 'CRITICAL' : 'HIGH';
        const seq = ledger.useCount + 1; ledger.useCount = seq;
        if (row.updates >= ticketLimits.maxUpdatesPerIncident) row.suppressedUses += 1;
        else {
          row.pendingUses += 1; if (spread.length > 0) row.pendingSpreadUses += 1; row.pendingSince ??= at;
          // D9: the first use and the first spread are immediate; later uses wait for the per-incident digest window.
          // Both still count toward maxUpdatesPerIncident.
          if (row.updates === 0 || firstSpread || at - row.lastUpdateAt >= ticketLimits.digestIntervalMs) enqueueTicketUpdate(ledger, row, at);
        }
        const record = { useId: `ticket-use-${seq}`, seq, trackId: ticket.trackId, incidentId: ticket.incidentId, incidentUse: row.uses, at,
          contextId: input.contextId, entry: input.entry, position: input.position, client, source, spread,
          severity: spread.length > 0 ? 'CRITICAL' : 'HIGH', outcome: 'PRESENTED', code: null, replayed: null, settledAt: null };
        db.prepare('INSERT INTO pitch_ticket_uses VALUES(?,?,?,?)').run(seq, record.useId, JSON.stringify(record), hash(record));
        return copy({ tracked: true, useId: record.useId, seq, trackId: ticket.trackId, incidentId: ticket.incidentId, spread,
          severity: row.severity, issuing: { contextId: ticket.contextId, worldId: ticket.worldId, epoch: ticket.epoch } });
      });
      return relayResult(result);
    },
    settleTicketUse(input) {
      ticketsOn();
      envelope(input, ['useId', 'outcome', 'code'], ['replayed']);
      check(typeof input.useId === 'string' && /^ticket-use-[1-9][0-9]{0,15}$/.test(input.useId)
        && ['ACCEPTED', 'REFUSED', 'UNKNOWN'].includes(input.outcome) && typeof input.code === 'string'
        && /^[A-Z][A-Z0-9_]{0,127}$/.test(input.code) && (input.replayed === undefined || typeof input.replayed === 'boolean'), 'PITCH_TICKET_INVALID');
      return transact((state, at) => {
        const row = db.prepare('SELECT * FROM pitch_ticket_uses WHERE use_id=?').get(input.useId);
        check(row, 'PITCH_TICKET_USE_UNKNOWN'); const record = readUse(row);
        if (record.outcome !== 'PRESENTED') {
          check(record.outcome === input.outcome && record.code === input.code, 'PITCH_TICKET_SETTLE_CONFLICT'); return copy(record);
        }
        Object.assign(record, { outcome: input.outcome, code: input.code, replayed: input.replayed ?? null, settledAt: at });
        if (input.outcome === 'ACCEPTED') {
          const ticket = state.ticketLedger.tickets.find(item => item.trackId === record.trackId);
          ticket.accepted = increase(ticket.accepted);
        }
        db.prepare('UPDATE pitch_ticket_uses SET record=?,digest=? WHERE use_id=?').run(JSON.stringify(record), hash(record), input.useId);
        return copy(record);
      });
    },
    ticketUses(input = {}) {
      ticketsOn(); envelope(input, [], ['afterSeq', 'limit']);
      const afterSeq = input.afterSeq ?? 0; const count = input.limit ?? 200;
      integer(afterSeq, 0, Number.MAX_SAFE_INTEGER, 'PITCH_TICKET_INVALID'); integer(count, 1, 500, 'PITCH_TICKET_INVALID');
      return transact(state => {
        const uses = db.prepare('SELECT * FROM pitch_ticket_uses WHERE seq>? ORDER BY seq LIMIT ?').all(afterSeq, count).map(readUse);
        const nextAfterSeq = uses.at(-1)?.seq ?? afterSeq;
        return copy({ useCount: state.ticketLedger.useCount, uses, nextAfterSeq, complete: nextAfterSeq >= state.ticketLedger.useCount });
      });
    },
    // M3 delivery interface: due digests are materialized here; rows stay PENDING until M3 claims them.
    // The existing deliver()/claimRelay() never read these rows.
    ticketUpdates() {
      ticketsOn();
      return transact((state, at) => { expireDeliveries(state, at); materializeTicketUpdates(state, at); return copy({ updates: state.ticketLedger.updates,
        incidents: state.ticketLedger.incidents, limits: ticketLimits }); });
    },
    // M3 claim: one send attempt for the oldest due PENDING ticket update. Losing the reply leaves the row
    // IN_FLIGHT until its lease expires (then UNKNOWN); it is never reclaimed or re-sent blindly.
    claimTicketUpdate(input = {}) {
      ticketsOn(); envelope(input, [], ['leaseMs']);
      const leaseMs = input.leaseMs ?? limits.deliveryLeaseMs; integer(leaseMs, 1000, 900000, 'PITCH_RELAY_LEASE_INVALID');
      return transact((state, at) => {
        expireDeliveries(state, at); materializeTicketUpdates(state, at);
        const row = state.ticketLedger.updates.find(item => item.status === 'PENDING'
          && item.attempts < limits.deliveryAttempts && item.nextAttemptAt <= at);
        if (!row) return null;
        const claimToken = randomUUID(); row.attempts++; row.status = 'IN_FLIGHT';
        row.leaseId = `update-${hash(claimToken)}`; row.leaseExpiresAt = at + leaseMs; row.reconciliationDigest = null;
        const incident = state.incidents.find(item => item.incidentId === row.incidentId);
        const summary = state.ticketLedger.incidents.find(item => item.incidentId === row.incidentId);
        return copy({ claimToken, update: row, attempt: row.attempts, leaseExpiresAt: row.leaseExpiresAt,
          incident: { incidentId: incident.incidentId, contextId: incident.contextId, worldId: incident.worldId,
            epoch: incident.epoch, phase: incident.phase, enteredAt: incident.enteredAt },
          ledgerIncident: { severity: summary.severity, uses: summary.uses, spreadUses: summary.spreadUses,
            updates: summary.updates, suppressedUses: summary.suppressedUses, firstUseAt: summary.firstUseAt, lastUseAt: summary.lastUseAt },
          limits: { maxUpdatesPerIncident: ticketLimits.maxUpdatesPerIncident, digestIntervalMs: ticketLimits.digestIntervalMs } });
      });
    },
    completeTicketUpdate(input) {
      ticketsOn();
      envelope(input, ['updateId', 'claimToken', 'outcome'], ['receiptId', 'retryable']);
      identifier(input.updateId); identifier(input.claimToken);
      check(['ACCEPTED', 'REJECTED', 'UNKNOWN'].includes(input.outcome), 'PITCH_RELAY_OUTCOME_INVALID');
      if (input.outcome === 'ACCEPTED') identifier(input.receiptId);
      else check(!Object.hasOwn(input, 'receiptId'), 'PITCH_RELAY_OUTCOME_INVALID');
      check(input.outcome === 'REJECTED' ? typeof input.retryable === 'boolean' : !Object.hasOwn(input, 'retryable'), 'PITCH_RELAY_OUTCOME_INVALID');
      return transact((state, at) => {
        expireDeliveries(state, at);
        const row = state.ticketLedger.updates.find(item => item.updateId === input.updateId);
        check(row, 'PITCH_TICKET_UPDATE_UNKNOWN');
        // A stale completion cannot overwrite an expired or replaced claim.
        if (row.status !== 'IN_FLIGHT' || row.leaseId !== `update-${hash(input.claimToken)}`) return copy({ update: row, stale: true });
        clearDeliveryLease(row);
        if (input.outcome === 'ACCEPTED') acceptDelivery(row, input.receiptId, at);
        else if (input.outcome === 'REJECTED') {
          row.status = input.retryable && row.attempts < limits.deliveryAttempts ? 'PENDING' : 'EXHAUSTED';
          row.lastError = 'NOT_ACCEPTED'; row.uncertainAt = null;
        } else { row.status = 'UNKNOWN'; row.lastError = 'TRANSPORT_UNKNOWN'; row.uncertainAt = at; }
        row.nextAttemptAt = at + Math.min(3600000, limits.retryBaseMs * (2 ** (row.attempts - 1)));
        return copy({ update: row, stale: false });
      });
    },
    // Call after the gateway owner lock is acquired: a previous process cannot still complete its claim.
    recoverTicketUpdateClaims() {
      if (!ticketLimits) return { recovered: 0, outcome: 'UNKNOWN' };
      return transact((state, at) => {
        let recovered = 0;
        for (const row of state.ticketLedger.updates) if (row.status === 'IN_FLIGHT') {
          row.status = 'UNKNOWN'; row.uncertainAt = at; row.lastError = 'LEASE_EXPIRED'; clearDeliveryLease(row); recovered++;
        }
        return { recovered, outcome: 'UNKNOWN' };
      });
    },
    reserveEntry(input) {
      entryInput(input); return transact((state, at) => copy(reserve(state, input, at)));
    },
    recordEntry(input) {
      entryInput(input);
      return transact((state, at) => {
        const reserved = reserve(state, input, at); const incident = reserved.incident;
        const replayed = incident.phase === 'ENTERED';
        if (!replayed) { incident.phase = 'ENTERED'; incident.entryEventId = input.eventId; incident.enteredAt = at; }
        return copy({ incident, replayed });
      });
    },
    acknowledge(input) {
      envelope(input, ['incidentId', 'operatorId']); identifier(input.operatorId);
      return transact((state, at) => {
        const incident = incidentRow(state, input.incidentId); const replayed = incident.acknowledgement !== null;
        if (!replayed) incident.acknowledgement = { operatorId: input.operatorId, at };
        return copy({ incident, replayed });
      });
    },
    resolve(input) {
      envelope(input, ['incidentId', 'operatorId', 'resolution']); identifier(input.operatorId);
      check(RESOLUTIONS.includes(input.resolution), 'PITCH_RESOLUTION_INVALID');
      return transact((state, at) => {
        const incident = incidentRow(state, input.incidentId);
        check(incident.acknowledgement !== null, 'PITCH_ACK_REQUIRED');
        const replayed = incident.resolution !== null;
        check(!replayed || incident.resolution.resolution === input.resolution, 'PITCH_RESOLUTION_CONFLICT');
        if (!replayed) incident.resolution = { operatorId: input.operatorId, at, resolution: input.resolution };
        return copy({ incident, replayed });
      });
    },
    // The owner must establish that the named execution stopped. Time elapsed is not evidence.
    reconcile(input) {
      envelope(input, ['leaseId', 'evidence']);
      envelope(input.evidence, ['kind', 'referenceId', 'operatorId']);
      check(input.evidence.kind === 'STOPPED_EXECUTION', 'PITCH_RECONCILIATION_INVALID');
      identifier(input.evidence.referenceId); identifier(input.evidence.operatorId);
      return transact((state, at) => {
        const result = complete(state, leaseRow(state, { leaseId: input.leaseId }), 'UNKNOWN', 'LEASE_RECONCILED', at);
        state.samples.at(-1).evidenceDigest = hash(input.evidence); return result;
      });
    },
    reconcileDelivery(input) {
      envelope(input, ['incidentId', 'evidence']);
      const proof = input.evidence;
      envelope(proof, ['kind', 'idempotencyKey', 'referenceId'], ['receiptId']); identifier(proof.referenceId);
      check(['DELIVERY_RECEIPT', 'DEFINITELY_NOT_ACCEPTED'].includes(proof.kind), 'PITCH_RECONCILIATION_INVALID');
      if (proof.kind === 'DELIVERY_RECEIPT') identifier(proof.receiptId);
      else check(!Object.hasOwn(proof, 'receiptId'), 'PITCH_RECONCILIATION_INVALID');
      return transact((state, at) => {
        const incident = incidentRow(state, input.incidentId);
        const row = state.outbox.find(item => item.incidentId === incident.incidentId);
        check(row.idempotencyKey === proof.idempotencyKey && incident.phase === 'ENTERED', 'PITCH_RECONCILIATION_INVALID');
        if (row.status === 'ACCEPTED') {
          check(proof.kind === 'DELIVERY_RECEIPT' && row.receiptId === proof.receiptId, 'PITCH_DELIVERY_CONFLICT');
          return copy(row);
        }
        check(row.status === 'UNKNOWN', 'PITCH_DELIVERY_NOT_UNKNOWN');
        row.reconciliationDigest = hash(proof);
        if (proof.kind === 'DELIVERY_RECEIPT') acceptDelivery(row, proof.receiptId, at);
        else { row.status = row.attempts < limits.deliveryAttempts ? 'PENDING' : 'EXHAUSTED'; row.nextAttemptAt = at; row.uncertainAt = null; }
        return copy(row);
      });
    },
    // Owner-only external connector bridge. A claim grants exactly one send attempt;
    // losing its reply never permits reclaiming IN_FLIGHT/UNKNOWN work.
    claimRelay(input) {
      envelope(input, ['incidentId', 'contextId', 'epoch'], ['leaseMs']);
      identifier(input.contextId); integer(input.epoch, 1, Number.MAX_SAFE_INTEGER);
      const leaseMs = input.leaseMs ?? 300000; integer(leaseMs, 1000, 900000, 'PITCH_RELAY_LEASE_INVALID');
      return relayResult(transact((state, at) => {
        expireDeliveries(state, at); const { incident, row } = relayScope(state, input);
        if (row.status !== 'PENDING') return { error: 'PITCH_RELAY_NOT_PENDING' };
        if (state.outbox.some(item => item.status === 'IN_FLIGHT')) return { error: 'PITCH_RELAY_BUSY' };
        if (row.attempts >= limits.deliveryAttempts || row.nextAttemptAt > at) return { error: 'PITCH_RELAY_NOT_READY' };
        const claimToken = randomUUID(); row.attempts++; row.status = 'IN_FLIGHT';
        // Only the digest is durable or visible in status. It is not a completion capability.
        row.leaseId = `relay-${hash(claimToken)}`; row.leaseExpiresAt = at + leaseMs;
        row.reconciliationDigest = null;
        return copy({ claimToken, incidentId: incident.incidentId, contextId: incident.contextId, epoch: incident.epoch,
          idempotencyKey: row.idempotencyKey, attempt: row.attempts, claimedAt: at, leaseExpiresAt: row.leaseExpiresAt,
          authority: 'ONE_EXTERNAL_SEND_ATTEMPT', providerVerified: false });
      }));
    },
    completeRelay(input) {
      envelope(input, ['incidentId', 'contextId', 'epoch', 'claimToken', 'outcome', 'referenceId'], ['receiptId']);
      identifier(input.contextId); integer(input.epoch, 1, Number.MAX_SAFE_INTEGER);
      identifier(input.claimToken); identifier(input.referenceId);
      check(['ACCEPTED', 'UNKNOWN'].includes(input.outcome), 'PITCH_RELAY_OUTCOME_INVALID');
      if (input.outcome === 'ACCEPTED') identifier(input.receiptId);
      else check(!Object.hasOwn(input, 'receiptId'), 'PITCH_RELAY_OUTCOME_INVALID');
      const proofDigest = hash(['EXTERNAL_RELAY', input.incidentId, input.contextId, input.epoch,
        hash(input.claimToken), input.outcome, input.referenceId, input.receiptId ?? null]);
      return relayResult(transact((state, at) => {
        expireDeliveries(state, at); const { row } = relayScope(state, input);
        if (['ACCEPTED', 'UNKNOWN'].includes(row.status) && row.reconciliationDigest === proofDigest)
          return { outbox: copy(row), replayed: true, assurance: 'OPERATOR_TRANSCRIBED', providerVerified: false };
        if (row.status !== 'IN_FLIGHT' || row.leaseId !== `relay-${hash(input.claimToken)}`) return { error: 'PITCH_RELAY_STALE' };
        row.reconciliationDigest = proofDigest;
        if (input.outcome === 'ACCEPTED') acceptDelivery(row, input.receiptId, at);
        else { row.status = 'UNKNOWN'; row.uncertainAt = at; row.lastError = 'RELAY_UNKNOWN'; clearDeliveryLease(row); }
        return { outbox: copy(row), replayed: false, assurance: 'OPERATOR_TRANSCRIBED', providerVerified: false };
      }));
    },
    // Call only after the gateway's exclusive owner lock is acquired on startup.
    // A previous gateway cannot still own a live connector completion capability.
    recoverRelayClaims() {
      return transact((state, at) => {
        let recovered = 0;
        for (const row of state.outbox) if (row.status === 'IN_FLIGHT' && row.leaseId.startsWith('relay-')) {
          row.status = 'UNKNOWN'; row.uncertainAt = at; row.lastError = 'RELAY_UNKNOWN';
          clearDeliveryLease(row); recovered++;
        }
        return { recovered, outcome: 'UNKNOWN' };
      });
    },
    async deliver(options = {}) {
      check(options && typeof options === 'object' && !Array.isArray(options)
        && [Object.prototype, null].includes(Object.getPrototypeOf(options))
        && Reflect.ownKeys(options).every(key => ['send', 'max', 'idempotent'].includes(key)
          && Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value')), 'PITCH_DELIVERY_INVALID');
      const { send, max = 8, idempotent = false } = options;
      live(); integer(max, 1, 32, 'PITCH_DELIVERY_LIMIT_INVALID');
      check(typeof idempotent === 'boolean' && (send === undefined || typeof send === 'function'), 'PITCH_DELIVERY_INVALID');
      if (send === undefined) return { configured: false, attempted: 0, results: [] };
      const results = [];
      for (let index = 0; index < max; index++) {
        const claim = transact((state, at) => {
          expireDeliveries(state, at);
          if (state.outbox.some(item => item.status === 'IN_FLIGHT' && item.leaseId.startsWith('relay-'))) return null;
          const row = state.outbox.find(item => state.incidents.find(i => i.incidentId === item.incidentId).phase === 'ENTERED'
            && (item.status === 'PENDING' || (idempotent && item.status === 'UNKNOWN' && item.lastError !== 'RELAY_UNKNOWN'))
            && item.attempts < limits.deliveryAttempts && item.nextAttemptAt <= at);
          if (!row) return null;
          row.attempts++; row.status = 'IN_FLIGHT'; row.leaseId = randomUUID(); row.leaseExpiresAt = at + limits.deliveryLeaseMs;
          return copy({ outbox: row, incident: state.incidents.find(i => i.incidentId === row.incidentId) });
        });
        if (!claim) break;
        const abort = new AbortController(); let timer; let result; let transportError;
        try {
          result = await Promise.race([
            Promise.resolve().then(() => send({ idempotencyKey: claim.outbox.idempotencyKey, incident: copy(claim.incident),
              attempt: claim.outbox.attempts, signal: abort.signal })),
            new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(coded('TIMEOUT')); }, limits.deliveryTimeoutMs); })
          ]);
        } catch (error) { transportError = error?.code === 'TIMEOUT' ? 'TIMEOUT' : 'TRANSPORT_UNKNOWN'; }
        finally { clearTimeout(timer); }
        let accepted = false; let rejected = false; let retryable = false; let receiptId;
        if (!transportError) {
          try {
            check(result !== null, 'RECEIPT_INVALID');
            if (result.accepted === true) {
              envelope(result, ['accepted', 'receiptId']); receiptId = identifier(result.receiptId); accepted = true;
            } else {
              envelope(result, ['accepted', 'definitive', 'retryable']);
              check(result.accepted === false && result.definitive === true && typeof result.retryable === 'boolean', 'RECEIPT_INVALID');
              rejected = true; retryable = result.retryable;
            }
          } catch { transportError = 'RECEIPT_INVALID'; }
        }
        const saved = transact((state, at) => {
          const row = state.outbox.find(item => item.incidentId === claim.outbox.incidentId);
          // A stale callback cannot overwrite a replacement lease or independently reconciled receipt.
          if (row.leaseId !== claim.outbox.leaseId) return copy(row);
          clearDeliveryLease(row);
          if (accepted) acceptDelivery(row, receiptId, at);
          else if (rejected) {
            row.status = retryable && row.attempts < limits.deliveryAttempts ? 'PENDING' : 'EXHAUSTED';
            row.lastError = 'NOT_ACCEPTED'; row.uncertainAt = null;
          } else { row.status = 'UNKNOWN'; row.lastError = transportError; row.uncertainAt = at; }
          row.nextAttemptAt = at + Math.min(3600000, limits.retryBaseMs * (2 ** (row.attempts - 1)));
          return copy(row);
        });
        results.push(saved);
      }
      return { configured: true, attempted: results.length, results };
    },
    close() { if (!closed) { closed = true; db.close(); } }
  };
}
