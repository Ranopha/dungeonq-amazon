import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { openAuxiliary } from './auxiliary.mjs';
import { runtimeCheck as check, runtimeEnvelope as envelope, runtimeFamily as family,
  runtimeId as identifier, runtimeInteger as integer } from './contracts.mjs';

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

function validateState(state, limits) {
  const keys = ['version', 'lastAt', 'global', 'contexts', 'leases', 'samples', 'incidents', 'outbox'];
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
    envelope(row, ['incidentId', 'idempotencyKey', 'status', 'attempts', 'nextAttemptAt', 'leaseId', 'leaseExpiresAt',
      'receiptId', 'acceptedAt', 'lastError', 'uncertainAt', 'reconciliationDigest']);
    identifier(row.incidentId);
    check(state.incidents.some(i => i.incidentId === row.incidentId) && row.idempotencyKey === `pitch-alert-v1:${row.incidentId}`
      && DELIVERY_STATES.includes(row.status), 'PITCH_STATE_INVALID');
    integer(row.attempts, 0, limits.deliveryAttempts); atValue(row.nextAttemptAt);
    nullableId(row.leaseId); nullableAt(row.leaseExpiresAt); nullableId(row.receiptId); nullableAt(row.acceptedAt); nullableAt(row.uncertainAt);
    check(row.lastError === null || ['TRANSPORT_UNKNOWN', 'RELAY_UNKNOWN', 'RECEIPT_INVALID', 'NOT_ACCEPTED', 'LEASE_EXPIRED', 'TIMEOUT'].includes(row.lastError), 'PITCH_STATE_INVALID');
    check(row.reconciliationDigest === null || /^[a-f0-9]{64}$/.test(row.reconciliationDigest), 'PITCH_STATE_INVALID');
    check(row.status === 'IN_FLIGHT' ? row.leaseId !== null && row.leaseExpiresAt !== null
      : row.leaseId === null && row.leaseExpiresAt === null, 'PITCH_STATE_INVALID');
    check(row.status === 'ACCEPTED' ? row.receiptId !== null && row.acceptedAt !== null
      : row.receiptId === null && row.acceptedAt === null, 'PITCH_STATE_INVALID');
  }
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
export function openPitchControl({ path, clock = Date.now, limits: supplied } = {}) {
  check(typeof path === 'string' && isAbsolute(path), 'STORAGE_PATH_INVALID');
  check(typeof clock === 'function', 'CLOCK_INVALID');
  const limits = limitsFor(supplied);
  const rawNow = () => integer(clock(), 0, Number.MAX_SAFE_INTEGER - 7200000, 'CLOCK_INVALID');
  const initialAt = rawNow();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  check(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o022) === 0, 'STORAGE_DIRECTORY_INVALID');
  const db = openAuxiliary(path, SCHEMA, 'pitch_meta'); let closed = false;
  const config = JSON.stringify({ version: PITCH_CONTROL_VERSION, limits });
  const live = () => check(!closed, 'PITCH_CONTROL_CLOSED');
  const read = () => {
    const row = db.prepare('SELECT * FROM pitch_meta WHERE id=1').get();
    check(row && row.config === config, 'PITCH_CONFIG_CHANGED');
    check(Buffer.byteLength(row.state) <= MAX_STATE_BYTES, 'PITCH_STATE_INVALID');
    const state = JSON.parse(row.state); check(hash(state) === row.digest, 'PITCH_STATE_CORRUPT');
    return validateState(state, limits);
  };
  const write = state => {
    validateState(state, limits); const json = JSON.stringify(state);
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
        contexts: [], leases: [], samples: [], incidents: [], outbox: [] };
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
        expireDeliveries(state, at);
        return copy({ schemaVersion: PITCH_CONTROL_VERSION, limits, global: state.global, contexts: state.contexts,
          activeLeases: state.leases, samples: state.samples, incidents: state.incidents, outbox: state.outbox,
          clockAt: state.lastAt, scope: 'SINGLE_HOST_REFERENCE' });
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
