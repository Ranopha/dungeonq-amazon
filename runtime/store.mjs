import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPrivateWorldDatabase } from '../server/world-store.mjs';
import { worldDigest } from '../world/kernel.mjs';
import { RUNTIME_VERSION, RUNTIME_PROFILE, RUNTIME_OPERATIONS, RUNTIME_FAMILIES, runtimeCheck as check,
  runtimeEnvelope as envelope, runtimeId as id, runtimeInteger as integer, runtimeFamily as family,
  runtimeValue, validateRuntimeBlueprint, isPitchingBlueprint } from './contracts.mjs';
import { createPitchingProgress, pitchingRecordVisible, pitchingObservation, advancePitching,
  isPitchingV2, pitchingExposures, advancePitchingV2, pitchingProgressView } from './pitching.mjs';

const DEFAULT_BLUEPRINT = JSON.parse(readFileSync(new URL('./blueprints/default.json', import.meta.url), 'utf8'));
const ISSUER = 'dungeonq-runtime-v1';
const AUDIENCE = 'dungeonq-synthetic-read-v1';
const FENCE_RESERVE_BYTES = 4096;
// Full authenticated replay cadence between opens and exports (ADR-DQ-020); whichever bound is reached first.
const FULL_VERIFY_MAX_OPERATIONS = 500;
const FULL_VERIFY_MAX_INTERVAL_MS = 60000;
// Ordinary admission windows (ADR-DQ-021). Ordinary origin traffic is summarised in one authenticated ADMISSION event per
// aligned window instead of one ROUTE event per request. A window is sealed when an admission falls in a later window,
// when it already holds ADMISSION_WINDOW_MAX admissions, on sealAdmissions() and on close(). Replay accepts any window
// length in the range, so the constant can change without breaking older journals.
const ADMISSION_WINDOW_MS = 60000;
const ADMISSION_WINDOW_MAX = 4096;
const ADMISSION_WINDOW_MS_MIN = 1000;
const ADMISSION_WINDOW_MS_MAX = 3600000;
const ADMISSION_LATENCY_MAX_MS = 3600000;
export const ADMISSION_OUTCOMES = Object.freeze(['SERVED', 'REFUSED', 'FAILED', 'UNKNOWN']);
export const ADMISSION_SOURCES = Object.freeze(['LOOPBACK', 'PRIVATE', 'OTHER', 'UNKNOWN']);
const ADMISSION_MODULUS = 1n << 256n;
const attemptTerm = attemptId => BigInt(`0x${createHash('sha256').update('dungeonq-admission-attempt-v1\0').update(attemptId).digest('hex')}`);
const sumHex = value => value.toString(16).padStart(64, '0');
/**
 * Order-independent digest of a multiset of gateway attempt identifiers: the sum of their domain-separated SHA-256 values
 * modulo 2^256. Per-window digests add up to the digest of all attempts, so the gateway attempt table and the journal
 * windows can be compared without listing every attempt in the journal. Attempt identifiers are gateway-generated.
 */
export function admissionAttemptDigest(attemptIds) {
  let sum = 0n; for (const attemptId of attemptIds) sum = (sum + attemptTerm(attemptId)) % ADMISSION_MODULUS; return sumHex(sum);
}
/** Coarse source category of an unverified network hint; the journal never stores the address itself. */
export function admissionSourceClass(hint) {
  if (typeof hint !== 'string' || hint.length === 0) return 'UNKNOWN';
  const address = hint.replace(/^::ffff:/iu, '');
  if (address === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(address)) return 'LOOPBACK';
  if (/^(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$/u.test(address) || /^f[cd][0-9a-f]{2}:/iu.test(address)) return 'PRIVATE';
  return 'OTHER';
}
const EMPTY_ADMISSIONS = Object.freeze({ windows: 0, routes: 0, count: 0, attemptSum: 0n,
  outcomes: Object.freeze(Object.fromEntries(ADMISSION_OUTCOMES.map(outcome => [outcome, 0]))) });
// Running totals of the ordinary admissions recorded in the verified journal: sealed windows plus per-request ORIGIN routes
// (journals written before ADR-DQ-021, or direct recordRoute callers). Returns a new object; the verified cache is shared.
function advanceAdmissions(current, command) {
  const input = command.input;
  if (command.kind === 'ADMISSION') return { windows: current.windows + 1, routes: current.routes, count: current.count + input.count,
    attemptSum: (current.attemptSum + BigInt(`0x${input.attemptDigest}`)) % ADMISSION_MODULUS,
    outcomes: Object.fromEntries(ADMISSION_OUTCOMES.map(outcome => [outcome, current.outcomes[outcome] + input.outcomes[outcome]])) };
  if (command.kind === 'ROUTE' && input.destination === 'ORIGIN') return { ...current, routes: current.routes + 1, count: current.count + 1,
    attemptSum: (current.attemptSum + attemptTerm(input.attemptId ?? `request:${input.requestId}`)) % ADMISSION_MODULUS,
    outcomes: { ...current.outcomes, [input.outcome]: current.outcomes[input.outcome] + 1 } };
  return current;
}
const isLatency = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= ADMISSION_LATENCY_MAX_MS
  && Math.round(value * 1000) / 1000 === value;
const nearestRank = (sorted, q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
const sortedEntries = map => [...map].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
// Sorted top-level keys of the canonical state, and the collections whose canonical text is memoized.
const STATE_ORDER = ['contexts', 'observations', 'policies', 'requests', 'routes', 'tickets', 'worlds'];
const MEMO_KEYS = ['observations', 'requests', 'routes'];
const EMPTY_MEMO = Object.freeze({ count: 0, bytes: Buffer.alloc(0), length: 0 });
const EMPTY_STATE_MEMO = Object.freeze({ texts: Object.freeze(Object.fromEntries(MEMO_KEYS.map(key => [key, EMPTY_MEMO]))),
  contexts: null, policies: null, observed: null, requested: null });
// Byte-for-byte the canonical form hashed by worldDigest() in world/kernel.mjs (sorted keys, JSON scalars).
function canonicalText(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalText(value[key])}`).join(',')}}`;
}
// Version 1 stores (legacy) authenticate the journal with the ticket key. Version 2 stores use a separate journal key.
// The store version is read from the exact schema and runtime_meta.version; existing stores are never migrated.
export const RUNTIME_STORE_LEGACY_SHARED_KEY = 1;
export const RUNTIME_STORE_SEPARATE_JOURNAL_KEY = 2;
const SCHEMA_V1 = [
  'CREATE TABLE runtime_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, blueprint_json TEXT NOT NULL, key_digest TEXT NOT NULL, state_json TEXT NOT NULL)',
  'CREATE TABLE runtime_events (sequence INTEGER PRIMARY KEY, event_json TEXT NOT NULL)',
];
const SCHEMA_V2 = [
  'CREATE TABLE runtime_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, blueprint_json TEXT NOT NULL, key_digest TEXT NOT NULL, journal_key_digest TEXT NOT NULL, state_json TEXT NOT NULL)',
  SCHEMA_V1[1],
];
const SCHEMAS = new Map([[RUNTIME_STORE_LEGACY_SHARED_KEY, SCHEMA_V1], [RUNTIME_STORE_SEPARATE_JOURNAL_KEY, SCHEMA_V2]]);
const clone = value => structuredClone(value);
const hashToken = token => createHash('sha256').update('dungeonq-context-token-v1\0').update(token).digest('hex');
const blank = () => ({ contexts: [], worlds: [], tickets: [], policies: [], requests: [], observations: [], routes: [] });
const safeContext = ({ tokenHash, ...context }) => clone(context);
const contextView = context => ({ contextId: context.contextId, tenantId: context.tenantId, worldId: context.worldId,
  epoch: context.epoch, disposition: context.disposition });

function privateFile(path) {
  const stat = lstatSync(path);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o077) === 0, 'STORAGE_NOT_PRIVATE');
}
function readKey(path, invalidCode = 'SIGNING_KEY_INVALID') {
  privateFile(path);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    check(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && stat.size === 32, invalidCode);
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}
// Inline keys are copied; file keys are created only for a new store and must stay private, regular and 32 bytes.
function loadKey({ inline, keyPath, existed, prefix }) {
  if (inline !== undefined) {
    check(Buffer.isBuffer(inline) && inline.length === 32, `${prefix}_INVALID`); return Buffer.from(inline);
  }
  if (!existsSync(keyPath)) {
    check(!existed, `${prefix}_MISSING`);
    const keyParent = lstatSync(dirname(keyPath));
    check(keyParent.isDirectory() && !keyParent.isSymbolicLink() && (keyParent.mode & 0o022) === 0, `${prefix}_PATH_INVALID`);
    writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600, flush: true });
  }
  return readKey(keyPath, `${prefix}_INVALID`);
}
function checkSchema(db) {
  const actual = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.sql);
  const match = [...SCHEMAS].find(([, schema]) => actual.length === schema.length && actual[0] === schema[1] && actual[1] === schema[0]);
  check(match, 'STORAGE_SCHEMA_INVALID');
  check(db.prepare('SELECT count(*) AS n FROM runtime_meta').get().n === 1, 'STORAGE_INCOMPLETE');
  return match[0];
}

/** These methods are trusted assembly handles, not participant administration endpoints. */
export function openRuntimeStore({ path, clock = Date.now, signingKey, signingKeyPath, journalKey, journalKeyPath,
  blueprint = DEFAULT_BLUEPRINT } = {}) {
  check(typeof path === 'string' && isAbsolute(path), 'STORAGE_PATH_INVALID');
  check(typeof clock === 'function', 'CLOCK_INVALID');
  const pack = validateRuntimeBlueprint(blueprint); const bounds = pack.bounds; const pitching = isPitchingBlueprint(pack);
  const existed = existsSync(path);
  if (!existed) {
    // A dangling symlink must not be treated as a new database.
    try { lstatSync(path); check(false, 'STORAGE_NOT_PRIVATE'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  check(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o022) === 0, 'STORAGE_DIRECTORY_INVALID');
  let preflight; let storeVersion = RUNTIME_STORE_SEPARATE_JOURNAL_KEY;
  if (existed) {
    privateFile(path);
    check(lstatSync(path).size > 0, 'STORAGE_INCOMPLETE');
    // Inspect before enabling WAL or creating anything; foreign and partial stores stay foreign.
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      check(probe.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'STORAGE_CORRUPT');
      storeVersion = checkSchema(probe); preflight = probe.prepare('SELECT * FROM runtime_meta WHERE singleton=1').get();
      check(preflight?.version === storeVersion, 'STORAGE_SCHEMA_INVALID');
      check(worldDigest(JSON.parse(preflight.blueprint_json)) === worldDigest(pack), 'BLUEPRINT_MISMATCH');
    } finally { probe.close(); }
  }
  check(!(signingKey !== undefined && signingKeyPath !== undefined), 'SIGNING_KEY_SOURCE_AMBIGUOUS');
  check(!(journalKey !== undefined && journalKeyPath !== undefined), 'JOURNAL_KEY_SOURCE_AMBIGUOUS');
  const separateJournal = storeVersion === RUNTIME_STORE_SEPARATE_JOURNAL_KEY;
  // A legacy store keeps its original shared-key journal; an explicit journal key there is a configuration error.
  check(separateJournal || (journalKey === undefined && journalKeyPath === undefined), 'JOURNAL_KEY_NOT_APPLICABLE');
  const storeFiles = [path, `${path}-wal`, `${path}-shm`];
  const ticketKeyPath = signingKey === undefined ? signingKeyPath ?? `${path}.ticket-key` : undefined;
  if (ticketKeyPath !== undefined) check(typeof ticketKeyPath === 'string' && isAbsolute(ticketKeyPath)
    && !storeFiles.some(file => resolve(ticketKeyPath) === resolve(file)), 'SIGNING_KEY_PATH_INVALID');
  const journalPath = separateJournal && journalKey === undefined ? journalKeyPath ?? `${path}.journal.key` : undefined;
  if (journalPath !== undefined) check(typeof journalPath === 'string' && isAbsolute(journalPath)
    && ![...storeFiles, ticketKeyPath].some(file => file !== undefined && resolve(journalPath) === resolve(file)), 'JOURNAL_KEY_PATH_INVALID');
  const secret = loadKey({ inline: signingKey, keyPath: ticketKeyPath, existed, prefix: 'SIGNING_KEY' });
  let journalSecret = secret;
  const keyDigest = createHash('sha256').update(secret).digest('hex'); let journalKeyDigest = null;
  try {
    check(!preflight || preflight.key_digest === keyDigest, 'SIGNING_KEY_MISMATCH');
    if (separateJournal) {
      journalSecret = loadKey({ inline: journalKey, keyPath: journalPath, existed, prefix: 'JOURNAL_KEY' });
      journalKeyDigest = createHash('sha256').update(journalSecret).digest('hex');
      check(journalKeyDigest !== keyDigest, 'JOURNAL_KEY_NOT_SEPARATE');
      check(!preflight || preflight.journal_key_digest === journalKeyDigest, 'JOURNAL_KEY_MISMATCH');
    }
  } catch (error) { secret.fill(0); journalSecret.fill(0); throw error; }
  const wipe = () => { secret.fill(0); journalSecret.fill(0); };
  let db;
  try { db = openPrivateWorldDatabase(path); } catch (error) { wipe(); throw error; }
  let closed = false;
  const mac = (domain, value) => createHmac('sha256', secret).update(`${domain}\0`).update(value).digest('base64url');
  // Ticket and journal authentication never share a key in a version 2 store.
  const journalDomain = separateJournal ? 'journal-v2' : 'journal-v1';
  const journalMac = digest => createHmac('sha256', journalSecret).update(`${journalDomain}\0`).update(digest).digest('base64url');
  const sameMac = (left, right) => typeof left === 'string' && left.length === right.length
    && timingSafeEqual(Buffer.from(left), Buffer.from(right));
  const now = () => integer(clock(), 0, Number.MAX_SAFE_INTEGER, 'CLOCK_INVALID');
  const live = () => check(!closed, 'STORE_CLOSED');
  const transaction = fn => {
    live(); db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const active = (state, contextId, synthetic = false) => {
    id(contextId); const context = state.contexts.find(item => item.contextId === contextId);
    check(context, 'CONTEXT_UNKNOWN'); check(context.state === 'ACTIVE', 'CONTEXT_FENCED');
    if (synthetic) check(context.disposition === 'DIVERT', 'SYNTHETIC_CONTEXT_REQUIRED');
    return context;
  };
  const worldFor = (state, context) => {
    const world = state.worlds.find(item => item.tenantId === context.tenantId && item.worldId === context.worldId
      && (!pitching || item.contextId === context.contextId));
    check(world, 'WORLD_UNKNOWN'); return world;
  };
  const visibleRecord = (world, context, key) => {
    check(!pitching || pitchingRecordVisible(context, key), 'RECORD_UNKNOWN');
    const record = world.records.find(item => item.key === key); check(record, 'RECORD_UNKNOWN'); return record;
  };
  const revision = (world, expected) => {
    integer(expected, 0, Number.MAX_SAFE_INTEGER, 'REVISION_INVALID'); check(world.revision === expected, 'REVISION_CONFLICT');
  };
  const encodeTicket = body => {
    const payload = Buffer.from(JSON.stringify(body)).toString('base64url'); return `${payload}.${mac('ticket-v1', payload)}`;
  };
  const inspectTicket = (state, wire, context, at, key) => {
    check(typeof wire === 'string' && wire.length <= 4096 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(wire), 'TICKET_INVALID');
    const [payload, signature] = wire.split('.'); check(sameMac(signature, mac('ticket-v1', payload)), 'TICKET_INVALID');
    let body; try { body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { check(false, 'TICKET_INVALID'); }
    envelope(body, ['schemaVersion', 'ticketId', 'issuer', 'audience', 'contextId', 'tenantId', 'worldId', 'epoch', 'issuedAt', 'expiresAt', 'scope', 'maxUses']);
    check(encodeTicket(body) === wire && body.schemaVersion === 'dungeonq.wrong-ticket/v1'
      && body.issuer === ISSUER && body.audience === AUDIENCE, 'TICKET_SCOPE_INVALID');
    check(body.contextId === context.contextId && body.tenantId === context.tenantId && body.worldId === context.worldId
      && body.epoch === context.epoch, 'TICKET_SCOPE_INVALID');
    check(at >= body.issuedAt && at < body.expiresAt, 'TICKET_EXPIRED');
    if (key !== undefined) check(body.scope.includes(key), 'TICKET_SCOPE_INVALID');
    const ticket = state.tickets.find(item => item.body.ticketId === body.ticketId);
    check(ticket && worldDigest(ticket.body) === worldDigest(body), 'TICKET_UNKNOWN'); return ticket;
  };
  const commandKey = command => {
    const input = command.input;
    if (command.kind === 'REGISTER') return `register:${input.contextId}`;
    if (command.kind === 'GRANT') return `grant:${input.policyId}`;
    if (command.kind === 'FENCE') return `fence:${input.contextId}`;
    // A window is identified by its start and its attempt set; gateway attempt identifiers are unique per attempt.
    if (command.kind === 'ADMISSION') return `admission:${input.windowStart}:${input.attemptDigest}`;
    return `${command.kind}:${input.contextId}:${input.requestId}${command.kind === 'ROUTE' ? `:${input.family}${input.attemptId ? `:${input.attemptId}` : ''}` : ''}`;
  };

  // Every count in a window adds up to the window total; replay rejects an inconsistent window with ADMISSION_INVALID.
  const admissionCounts = (value, keys, total) => {
    envelope(value, [], keys); check(Object.keys(value).length >= 1, 'ADMISSION_INVALID');
    let sum = 0; for (const key of Object.keys(value)) sum += integer(value[key], 1, total, 'ADMISSION_INVALID');
    check(sum === total, 'ADMISSION_INVALID');
  };
  function validateAdmission(state, input, at) {
    envelope(input, ['windowStart', 'windowEnd', 'firstAt', 'lastAt', 'count', 'outcomes', 'latency', 'families', 'sources', 'contexts', 'attemptDigest']);
    integer(input.windowStart, 0, Number.MAX_SAFE_INTEGER - ADMISSION_WINDOW_MS_MAX, 'ADMISSION_INVALID');
    integer(input.windowEnd, input.windowStart + ADMISSION_WINDOW_MS_MIN, input.windowStart + ADMISSION_WINDOW_MS_MAX, 'ADMISSION_INVALID');
    check(input.windowStart % (input.windowEnd - input.windowStart) === 0, 'ADMISSION_INVALID');
    integer(input.firstAt, input.windowStart, input.windowEnd - 1, 'ADMISSION_INVALID');
    integer(input.lastAt, input.firstAt, Math.min(input.windowEnd - 1, at), 'ADMISSION_INVALID');
    const count = integer(input.count, 1, ADMISSION_WINDOW_MAX, 'ADMISSION_INVALID');
    envelope(input.outcomes, ADMISSION_OUTCOMES);
    let outcomes = 0; for (const outcome of ADMISSION_OUTCOMES) outcomes += integer(input.outcomes[outcome], 0, count, 'ADMISSION_INVALID');
    check(outcomes === count, 'ADMISSION_INVALID');
    admissionCounts(input.families, RUNTIME_FAMILIES, count); admissionCounts(input.sources, ADMISSION_SOURCES, count);
    envelope(input.latency, ['samples', 'min', 'p50', 'p95', 'p99', 'max']);
    const quantiles = ['min', 'p50', 'p95', 'p99', 'max'].map(key => input.latency[key]);
    if (integer(input.latency.samples, 0, count, 'ADMISSION_INVALID') === 0) check(quantiles.every(value => value === null), 'ADMISSION_INVALID');
    else check(quantiles.every(isLatency) && quantiles.every((value, index) => index === 0 || quantiles[index - 1] <= value), 'ADMISSION_INVALID');
    check(Array.isArray(input.contexts) && input.contexts.length >= 1 && input.contexts.length <= bounds.maxContexts, 'ADMISSION_INVALID');
    let contexts = 0; let previous = '';
    for (const entry of input.contexts) {
      envelope(entry, ['contextId', 'count']); id(entry.contextId); check(entry.contextId > previous, 'ADMISSION_INVALID'); previous = entry.contextId;
      check(state.contexts.find(item => item.contextId === entry.contextId)?.disposition === 'NORMAL_AUTHORIZED', 'ADMISSION_INVALID');
      contexts += integer(entry.count, 1, count, 'ADMISSION_INVALID');
    }
    check(contexts === count, 'ADMISSION_INVALID');
    check(typeof input.attemptDigest === 'string' && /^[a-f0-9]{64}$/u.test(input.attemptDigest), 'ADMISSION_INVALID');
  }

  function transition(state, command, at, sequence) {
    const input = command.input; let result;
    if (command.kind === 'REGISTER') {
      envelope(input, ['contextId', 'tenantId', 'tokenHash', 'worldId', 'disposition']);
      id(input.contextId); id(input.tenantId); id(input.worldId);
      check(/^[a-f0-9]{64}$/u.test(input.tokenHash), 'TOKEN_INVALID');
      check(['DIVERT', 'NORMAL_AUTHORIZED'].includes(input.disposition), 'DISPOSITION_INVALID');
      check(!state.contexts.some(item => item.contextId === input.contextId || item.tokenHash === input.tokenHash), 'CONTEXT_CONFLICT');
      check(state.contexts.length < bounds.maxContexts, 'CONTEXT_LIMIT');
      const context = { ...input, epoch: 1, state: 'ACTIVE',
        ...(pitching && input.disposition === 'DIVERT' ? { pitching: createPitchingProgress(pack, at) } : {}) }; state.contexts.push(context);
      if (input.disposition === 'DIVERT' && !state.worlds.some(item => item.tenantId === input.tenantId && item.worldId === input.worldId
        && (!pitching || item.contextId === input.contextId))) {
        check(state.worlds.length < bounds.maxWorlds, 'WORLD_LIMIT');
        state.worlds.push({ tenantId: input.tenantId, worldId: input.worldId, revision: 0, ...(pitching ? { contextId: input.contextId } : {}),
          records: pack.records.map(record => ({ ...clone(record), revision: 0 })) });
      }
      result = safeContext(context);
    } else if (command.kind === 'EXECUTE') {
      envelope(input, ['contextId', 'family', 'requestId', 'operation', 'args']);
      family(input.family); id(input.requestId, 'REQUEST_ID_INVALID');
      check(RUNTIME_OPERATIONS.includes(input.operation), 'OPERATION_UNSUPPORTED');
      const context = active(state, input.contextId, true); const world = worldFor(state, context); const args = input.args;
      let usedTicket;
      if (input.operation === 'snapshot') {
        envelope(args, []); result = pitching ? { tenantId: world.tenantId, worldId: world.worldId, revision: world.revision,
          records: clone(world.records.filter(record => pitchingRecordVisible(context, record.key))) } : clone(world);
      }
      else if (input.operation === 'read') {
        envelope(args, ['key']); id(args.key); const record = visibleRecord(world, context, args.key);
        result = { key: record.key, value: clone(record.value), recordRevision: record.revision, revision: world.revision };
      } else if (input.operation === 'write') {
        envelope(args, ['key', 'value', 'expectedRevision']); id(args.key);
        if (pitching) {
          if (pack.records.some(record => record.key === args.key)) {
            visibleRecord(world, context, args.key); check(false, 'PITCHING_RECORD_IMMUTABLE');
          }
          check(/^note-[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(args.key), 'PITCHING_NOTE_SCOPE_DENIED');
        }
        revision(world, args.expectedRevision);
        const value = runtimeValue(args.value, bounds.maxValueBytes); const record = world.records.find(item => item.key === args.key);
        check(record || world.records.length < bounds.maxRecords, 'RECORD_LIMIT'); world.revision++;
        if (record) { record.value = value; record.revision = world.revision; }
        else world.records.push({ key: args.key, value, revision: world.revision });
        result = { key: args.key, value: clone(value), recordRevision: world.revision, revision: world.revision };
      } else if (input.operation === 'issue-ticket') {
        envelope(args, [], ['scope', 'ttlMs', 'maxUses']);
        const scope = args.scope ?? ['welcome']; const ttlMs = args.ttlMs ?? Math.min(60000, bounds.maxTicketTtlMs); const maxUses = args.maxUses ?? 1;
        check(Array.isArray(scope) && scope.length >= 1 && scope.length <= bounds.maxScopeKeys && new Set(scope).size === scope.length, 'TICKET_SCOPE_INVALID');
        for (const key of scope) { id(key); visibleRecord(world, context, key); }
        integer(ttlMs, 1, bounds.maxTicketTtlMs, 'TICKET_TTL_INVALID'); integer(maxUses, 1, 8, 'TICKET_USES_INVALID');
        check(state.tickets.length < bounds.maxTickets, 'TICKET_LIMIT');
        const body = { schemaVersion: 'dungeonq.wrong-ticket/v1', ticketId: worldDigest({ contextId: context.contextId, epoch: context.epoch, requestId: input.requestId }),
          issuer: ISSUER, audience: AUDIENCE, contextId: context.contextId, tenantId: context.tenantId, worldId: context.worldId,
          epoch: context.epoch, issuedAt: at, expiresAt: at + ttlMs, scope: clone(scope), maxUses };
        check(Number.isSafeInteger(body.expiresAt), 'CLOCK_INVALID'); state.tickets.push({ body, uses: 0 });
        result = { ...clone(body), ticket: encodeTicket(body), revision: world.revision };
      } else {
        envelope(args, ['ticket'], ['key']); const key = args.key ?? 'welcome'; id(key);
        const ticket = inspectTicket(state, args.ticket, context, at, key); check(ticket.uses < ticket.body.maxUses, 'TICKET_EXHAUSTED');
        const record = visibleRecord(world, context, key); ticket.uses++;
        usedTicket = ticket;
        const revealed = pitching && !isPitchingV2(pack) ? advancePitching({ pack, context, world, observations: state.observations, input, at, sequence }) : null;
        result = { ticketId: ticket.body.ticketId, key, value: clone(record.value), recordRevision: record.revision,
          revision: world.revision, usesRemaining: ticket.body.maxUses - ticket.uses, ...(revealed ? { revealed } : {}) };
      }
      const observationId = `obs-${sequence}`;
      const observation = { observationId, contextId: context.contextId, epoch: context.epoch,
        worldRevision: world.revision, requestId: input.requestId, operation: input.operation, usedBy: null,
        ...(pitching ? pitchingObservation(input, result, pack) : {}) };
      state.observations.push(observation);
      if (isPitchingV2(pack)) {
        const options = { pack, context, world, observations: state.observations, tickets: state.tickets, input, at, sequence, usedTicket };
        const advanced = advancePitchingV2(options);
        Object.assign(result, advanced, { revision: world.revision }); observation.worldRevision = world.revision;
        if (input.operation === 'snapshot') result.records = clone(world.records.filter(record => pitchingRecordVisible(context, record.key)));
        observation.exposures = pitchingExposures(input, result);
        if (input.operation === 'read' && result.revealed) observation.exposures.push({ key: result.revealed.key,
          recordRevision: world.records.find(item => item.key === result.revealed.key).revision, valueDigest: worldDigest(result.revealed.value) });
        result.progress = pitchingProgressView(options, { advanced: Boolean(result.revealed), reason: advanced.progress.notice });
      }
      result.observationId = observationId;
    } else if (command.kind === 'GRANT') {
      check(!pitching, 'PITCHING_LEGACY_MUTATION_DENIED');
      envelope(input, ['policyId', 'contextId', 'expectedRevision', 'allowedTemplates', 'maxMutations', 'expiresAt', 'authority']);
      id(input.policyId); envelope(input.authority, ['principalId', 'kind']); id(input.authority.principalId);
      check(input.authority.kind === 'OWNER', 'OWNER_AUTHORITY_REQUIRED');
      const context = active(state, input.contextId, true); const world = worldFor(state, context); revision(world, input.expectedRevision);
      check(Array.isArray(input.allowedTemplates) && input.allowedTemplates.length >= 1
        && input.allowedTemplates.length <= pack.templates.length && new Set(input.allowedTemplates).size === input.allowedTemplates.length, 'MUTATION_TEMPLATE_INVALID');
      for (const template of input.allowedTemplates) check(pack.templates.some(item => item.id === template), 'MUTATION_TEMPLATE_INVALID');
      integer(input.maxMutations, 1, bounds.maxMutations, 'MUTATION_LIMIT_INVALID');
      integer(input.expiresAt, at + 1, at + bounds.maxPolicyTtlMs, 'POLICY_EXPIRY_INVALID');
      check(state.policies.length < bounds.maxPolicies, 'POLICY_LIMIT');
      check(!state.policies.some(item => item.policyId === input.policyId), 'POLICY_CONFLICT');
      const policy = { policyId: input.policyId, contextId: context.contextId, tenantId: context.tenantId, worldId: context.worldId,
        epoch: context.epoch, allowedTemplates: clone(input.allowedTemplates), maxMutations: input.maxMutations, uses: 0,
        expiresAt: input.expiresAt, principalId: input.authority.principalId };
      state.policies.push(policy); result = { ...clone(policy), revision: world.revision, remaining: policy.maxMutations };
    } else if (command.kind === 'MUTATE') {
      check(!pitching, 'PITCHING_LEGACY_MUTATION_DENIED');
      envelope(input, ['policyId', 'contextId', 'observationId', 'requestId', 'expectedRevision', 'template']);
      id(input.policyId); id(input.observationId); id(input.requestId, 'REQUEST_ID_INVALID'); id(input.template);
      const context = active(state, input.contextId, true); const world = worldFor(state, context); revision(world, input.expectedRevision);
      const policy = state.policies.find(item => item.policyId === input.policyId);
      check(policy && policy.contextId === context.contextId && policy.tenantId === context.tenantId
        && policy.worldId === context.worldId && policy.epoch === context.epoch, 'MUTATION_POLICY_REQUIRED');
      check(at < policy.expiresAt, 'MUTATION_POLICY_EXPIRED'); check(policy.uses < policy.maxMutations, 'MUTATION_BUDGET_EXHAUSTED');
      check(policy.allowedTemplates.includes(input.template), 'MUTATION_TEMPLATE_DENIED');
      const observation = state.observations.find(item => item.observationId === input.observationId);
      check(observation && observation.contextId === context.contextId && observation.epoch === context.epoch, 'OBSERVATION_INVALID');
      check(!observation.usedBy, 'OBSERVATION_CONSUMED');
      check(observation.worldRevision === world.revision, 'OBSERVATION_STALE');
      check(world.records.length < bounds.maxRecords, 'RECORD_LIMIT');
      const template = pack.templates.find(item => item.id === input.template);
      const key = `${template.keyPrefix}-${worldDigest({ policyId: policy.policyId, requestId: input.requestId }).slice(0, 24)}`;
      check(!world.records.some(item => item.key === key), 'MUTATION_RECORD_CONFLICT');
      world.revision++; policy.uses++; observation.usedBy = input.requestId;
      world.records.push({ key, value: clone(template.value), revision: world.revision });
      result = { policyId: policy.policyId, contextId: context.contextId, observationId: input.observationId, template: template.id,
        key, value: clone(template.value), revision: world.revision, uses: policy.uses, remaining: policy.maxMutations - policy.uses };
    } else if (command.kind === 'ROUTE') {
      envelope(input, ['contextId', 'requestId', 'family', 'destination', 'outcome'], ['attemptId']);
      if (input.attemptId !== undefined) id(input.attemptId);
      id(input.requestId, 'REQUEST_ID_INVALID'); family(input.family);
      const context = active(state, input.contextId);
      check(['SYNTHETIC', 'ORIGIN'].includes(input.destination) && ['SERVED', 'REFUSED', 'FAILED', 'UNKNOWN'].includes(input.outcome), 'ROUTE_INVALID');
      check(input.destination === (context.disposition === 'DIVERT' ? 'SYNTHETIC' : 'ORIGIN'), 'ROUTE_CROSSING_DENIED');
      result = { ...clone(input), tenantId: context.tenantId, worldId: context.worldId, epoch: context.epoch };
      state.routes.push(result);
    } else if (command.kind === 'FENCE') {
      envelope(input, ['contextId', 'reason']);
      const context = active(state, input.contextId); runtimeValue(input.reason, 256);
      check(typeof input.reason === 'string' && input.reason.trim().length > 0, 'FENCE_REASON_INVALID');
      context.state = 'FENCED'; context.epoch++; context.fenceReason = input.reason; result = safeContext(context);
    } else if (command.kind === 'ADMISSION') {
      // A sealed window of ordinary admissions. Contexts may have been fenced after admission; disposition never changes.
      validateAdmission(state, input, at);
      result = { windowStart: input.windowStart, windowEnd: input.windowEnd, count: input.count,
        successes: input.outcomes.SERVED, attemptDigest: input.attemptDigest };
    } else check(false, 'COMMAND_UNSUPPORTED');
    return { ...result, replayed: false };
  }

  // Verified-state cache (ADR-DQ-020). A full authenticated replay runs on open, before evidence export, after any
  // write by another connection, and at least every FULL_VERIFY_MAX_OPERATIONS operations or FULL_VERIFY_MAX_INTERVAL_MS.
  // Between full replays each operation confirms that nothing else wrote the database, that the identity row and the
  // exact verified head row are unchanged and that no row exists beyond the head; the only rows appended in between
  // are this connection's own committed writes, built and authenticated in apply(). Any mismatch falls back to a full
  // replay, so a failing full replay refuses the operation with the same code as before (JOURNAL_CORRUPT, STATE_CORRUPT...).
  let cache = null; let memoEnabled = true;
  const prepared = new Map(); const statement = sql => {
    let found = prepared.get(sql); if (!found) { found = db.prepare(sql); prepared.set(sql, found); } return found;
  };
  const identitySql = separateJournal
    ? 'SELECT version, key_digest, journal_key_digest, blueprint_json FROM runtime_meta WHERE singleton=1'
    : 'SELECT version, key_digest, blueprint_json FROM runtime_meta WHERE singleton=1';
  const dataVersion = () => statement('PRAGMA data_version').get().data_version;
  // Memo of the canonical state text. Requests and routes are append-only and never mutated after their transition
  // returns (responses are fresh copies); observations change only through MUTATE, which resets their memo; a ticket
  // body never changes after issue (only its use count does). Two SHA-256 checkpoints reuse the unchanged prefix of the
  // text: through the observations while contexts are unchanged and observations only grew, and through the requests
  // while, in addition, no observation was added and policies are unchanged. A full replay compares the result with an
  // uncached digest of the final state and, on any difference, repeats itself without the memo, so the memo can never
  // change a verdict. Memo bytes beyond a memo's own length may be overwritten by a later attempt and are never read.
  const appendBytes = (memo, entry) => {
    const size = Buffer.byteLength(entry) + (memo.count ? 1 : 0); let { bytes } = memo;
    if (memo.length + size > bytes.length) {
      const grown = Buffer.allocUnsafe(Math.max(bytes.length * 2, memo.length + size, 4096)); bytes.copy(grown, 0, 0, memo.length); bytes = grown;
    }
    let length = memo.length; if (memo.count) bytes[length++] = 0x2c;
    length += bytes.write(entry, length, 'utf8');
    return { count: memo.count + 1, bytes, length };
  };
  const memoBytes = memo => memo.bytes.subarray(0, memo.length);
  const extend = (checkpoint, entries) => {
    for (const entry of entries) { checkpoint.hash.update(checkpoint.count ? `,${entry}` : entry); checkpoint.count++; }
    return checkpoint;
  };
  const ticketBodies = new WeakMap();
  const ticketsText = tickets => {
    if (!Array.isArray(tickets)) return canonicalText(tickets);
    const parts = [];
    for (const ticket of tickets) {
      const body = ticket?.body; const keys = ticket && typeof ticket === 'object' ? Object.keys(ticket) : [];
      if (keys.length !== 2 || !Object.hasOwn(ticket, 'uses') || !body || typeof body !== 'object' || Array.isArray(body)) { parts.push(canonicalText(ticket)); continue; }
      let text = ticketBodies.get(body); if (text === undefined) { text = canonicalText(body); ticketBodies.set(body, text); }
      parts.push(`{"body":${text},"uses":${canonicalText(ticket.uses)}}`);
    }
    return `[${parts.join(',')}]`;
  };
  const advanceMemo = (memo, state, command) => {
    if (!memo || Object.keys(state).length !== STATE_ORDER.length || !STATE_ORDER.every(key => Object.hasOwn(state, key))) return null;
    const texts = {}; const added = {};
    for (const key of MEMO_KEYS) {
      const items = state[key]; const reset = key === 'observations' && command.kind === 'MUTATE';
      let text = reset ? EMPTY_MEMO : memo.texts[key];
      if (!Array.isArray(items) || text.count > items.length) return null;
      const fresh = [];
      while (text.count < items.length) {
        const item = items[text.count]; if (!item || typeof item !== 'object') return null;
        const entry = canonicalText(item); fresh.push(entry); text = appendBytes(text, entry);
      }
      texts[key] = text; added[key] = reset ? null : fresh;
    }
    const contexts = canonicalText(state.contexts); const policies = canonicalText(state.policies);
    const reuseObserved = memo.observed?.contexts === contexts && added.observations !== null;
    const observed = reuseObserved
      ? extend({ hash: memo.observed.hash.copy(), contexts, count: memo.observed.count }, added.observations)
      : { hash: createHash('sha256').update(`{"contexts":${contexts},"observations":[`).update(memoBytes(texts.observations)),
        contexts, count: texts.observations.count };
    const requested = reuseObserved && added.observations.length === 0 && memo.requested?.policies === policies
      ? extend({ hash: memo.requested.hash.copy(), policies, count: memo.requested.count }, added.requests)
      : { hash: observed.hash.copy().update(`],"policies":${policies},"requests":[`).update(memoBytes(texts.requests)),
        policies, count: texts.requests.count };
    return { texts, contexts, policies, observed, requested };
  };
  // Equal to worldDigest(state) for the state the memo was just advanced on; without a memo it is computed directly.
  const digestState = (state, memo, withText = false) => {
    if (!memo) {
      if (!withText) return { digest: worldDigest(state) };
      const text = canonicalText(state); return { digest: createHash('sha256').update(text).digest('hex'), text };
    }
    const tickets = ticketsText(state.tickets); const worlds = canonicalText(state.worlds);
    const digest = memo.requested.hash.copy().update('],"routes":[').update(memoBytes(memo.texts.routes))
      .update(`],"tickets":${tickets},"worlds":${worlds}}`).digest('hex');
    if (!withText) return { digest };
    const decoded = key => memo.texts[key].bytes.toString('utf8', 0, memo.texts[key].length);
    return { digest, text: `{"contexts":${memo.contexts},"observations":[${decoded('observations')}],"policies":${memo.policies},`
      + `"requests":[${decoded('requests')}],"routes":[${decoded('routes')}],"tickets":${tickets},"worlds":${worlds}}` };
  };
  const forkState = state => {
    // Transitions mutate contexts, worlds, tickets, policies and (MUTATE) observations; the verified cache must survive a refusal.
    const copy = clone({ contexts: state.contexts, worlds: state.worlds, tickets: state.tickets, policies: state.policies, observations: state.observations });
    return { contexts: copy.contexts, worlds: copy.worlds, tickets: copy.tickets, policies: copy.policies,
      requests: [...state.requests], observations: copy.observations, routes: [...state.routes] };
  };
  // One authenticated journal row: chain, digest, HMAC, accounting, deterministic transition and recorded state.
  function replayRow(run, row, expectedSequence) {
    const event = JSON.parse(row.event_json);
    envelope(event, ['sequence', 'at', 'previousDigest', 'command', 'response', 'stateDigest', 'digest', 'authentication'], [], 1048576);
    const { digest, authentication, ...body } = event;
    check(row.sequence === expectedSequence && event.sequence === row.sequence && event.previousDigest === run.head
      && worldDigest(body) === digest && sameMac(authentication, journalMac(digest)), 'JOURNAL_CORRUPT');
    if (event.command.kind === 'FENCE') {
      run.fenceEvents++; check(Buffer.byteLength(row.event_json) <= FENCE_RESERVE_BYTES, 'FENCE_RESERVE_EXCEEDED');
    } else { run.workloadEvents++; run.journalBytes += Buffer.byteLength(row.event_json); }
    integer(event.at, run.lastAt, Number.MAX_SAFE_INTEGER, 'JOURNAL_CLOCK_INVALID');
    const response = transition(run.state, event.command, event.at, event.sequence);
    const key = commandKey(event.command);
    check(!run.requestIndex.has(key), 'IDEMPOTENCY_CORRUPT');
    const commandDigest = worldDigest(event.command); const entry = { key, digest: commandDigest, response };
    run.state.requests.push(entry); run.requestIndex.set(key, entry);
    run.admissions = advanceAdmissions(run.admissions, event.command);
    run.memo = advanceMemo(run.memo, run.state, event.command);
    const responseDigest = worldDigest(response); const stateDigest = digestState(run.state, run.memo).digest;
    check(responseDigest === worldDigest(event.response) && stateDigest === event.stateDigest, 'STATE_CORRUPT');
    run.head = digest; run.headJson = row.event_json; run.lastAt = event.at; run.stateDigest = stateDigest;
    run.events.push(event); run.commandDigests.push(commandDigest); run.responseDigests.push(responseDigest);
  }
  function verifyFull() {
    cache = null;
    check(checkSchema(db) === storeVersion, 'STORAGE_IDENTITY_INVALID');
    const saved = statement('SELECT * FROM runtime_meta WHERE singleton=1').get();
    check(saved.version === storeVersion && saved.key_digest === keyDigest
      && (!separateJournal || saved.journal_key_digest === journalKeyDigest)
      && worldDigest(JSON.parse(saved.blueprint_json)) === worldDigest(pack), 'STORAGE_IDENTITY_INVALID');
    const rows = statement('SELECT * FROM runtime_events ORDER BY sequence').all();
    check(rows.length <= bounds.maxEvents + bounds.maxContexts && rows.length <= bounds.maxRequests + bounds.maxContexts, 'JOURNAL_LIMIT');
    const useMemo = memoEnabled;
    const run = { state: blank(), head: worldDigest(pack), headJson: null, lastAt: 0, journalBytes: 0, workloadEvents: 0, fenceEvents: 0,
      events: [], commandDigests: [], responseDigests: [], requestIndex: new Map(), memo: useMemo ? EMPTY_STATE_MEMO : null,
      stateDigest: null, admissions: EMPTY_ADMISSIONS };
    for (let index = 0; index < rows.length; index++) replayRow(run, rows[index], index + 1);
    check(run.workloadEvents <= bounds.maxEvents && run.workloadEvents <= bounds.maxRequests && run.fenceEvents <= bounds.maxContexts, 'JOURNAL_LIMIT');
    check(run.journalBytes <= bounds.maxJournalBytes, 'JOURNAL_BYTE_LIMIT');
    const stateDigest = worldDigest(run.state);
    // Safety net for the memo: an uncached digest of the final state must equal the last memo-based digest.
    if (useMemo && rows.length > 0 && stateDigest !== run.stateDigest) { memoEnabled = false; return verifyFull(); }
    check(worldDigest(JSON.parse(saved.state_json)) === stateDigest, 'STATE_CORRUPT');
    cache = { ...run, stateDigest, sequence: rows.length, blueprintJson: saved.blueprint_json, dataVersion: dataVersion(),
      operations: 0, verifiedAt: performance.now() };
    return cache;
  }
  // Cheap per-operation confirmation that the cached replay still describes the committed database.
  function cacheCurrent(entry) {
    if (entry.operations >= FULL_VERIFY_MAX_OPERATIONS || performance.now() - entry.verifiedAt >= FULL_VERIFY_MAX_INTERVAL_MS) return false;
    try {
      if (dataVersion() !== entry.dataVersion || checkSchema(db) !== storeVersion) return false;
      const saved = statement(identitySql).get();
      if (saved?.version !== storeVersion || saved.key_digest !== keyDigest || saved.blueprint_json !== entry.blueprintJson
        || (separateJournal && saved.journal_key_digest !== journalKeyDigest)) return false;
      const tail = statement('SELECT count(*) AS n, max(sequence) AS m FROM runtime_events').get();
      if (tail.n !== entry.sequence || (tail.m ?? 0) !== entry.sequence) return false;
      return entry.sequence === 0
        || statement('SELECT event_json FROM runtime_events WHERE sequence=?').get(entry.sequence)?.event_json === entry.headJson;
    } catch { return false; }
  }
  function verify({ full = false } = {}) {
    if (!full && cache && cacheCurrent(cache)) { cache.operations++; return cache; }
    return verifyFull();
  }
  function apply(command) {
    let next;
    const result = transaction(() => {
      const verified = verify(); const { state, head, events, lastAt } = verified; const at = now();
      check(at >= lastAt, 'CLOCK_REGRESSION'); const key = commandKey(command); const digest = worldDigest(command);
      const previous = verified.requestIndex.get(key);
      if (previous) {
        check(previous.digest === digest, 'IDEMPOTENCY_CONFLICT');
        if (command.kind === 'REGISTER') active(state, command.input.contextId);
        if (['EXECUTE', 'MUTATE', 'GRANT'].includes(command.kind)) {
          const context = active(state, command.input.contextId, true);
          if (command.input.operation === 'use-ticket') inspectTicket(state, command.input.args.ticket, context, at, command.input.args.key ?? 'welcome');
          if (command.input.operation === 'issue-ticket') inspectTicket(state, previous.response.ticket, context, at);
          if (['MUTATE', 'GRANT'].includes(command.kind)) check(at < state.policies.find(item => item.policyId === command.input.policyId).expiresAt, 'MUTATION_POLICY_EXPIRED');
        }
        return { ...clone(previous.response), replayed: true };
      }
      // Workload exhaustion cannot consume the capacity needed to revoke each context once.
      if (command.kind === 'FENCE') check(verified.fenceEvents < bounds.maxContexts, 'FENCE_RESERVE_EXCEEDED');
      else check(verified.workloadEvents < bounds.maxEvents && verified.workloadEvents < bounds.maxRequests, 'JOURNAL_LIMIT');
      const working = forkState(state);
      const response = transition(working, command, at, events.length + 1);
      const entry = { key, digest, response }; working.requests.push(entry);
      const memo = advanceMemo(verified.memo, working, command);
      // state_json holds the canonical text whose SHA-256 is stateDigest; readers parse it as before.
      const { digest: stateDigest, text: stateText } = digestState(working, memo, true);
      const body = { sequence: events.length + 1, at, previousDigest: head, command, response, stateDigest };
      const eventDigest = worldDigest(body); const event = { ...body, digest: eventDigest, authentication: journalMac(eventDigest) };
      const serialized = JSON.stringify(event);
      const bytes = Buffer.byteLength(serialized);
      if (command.kind === 'FENCE') check(bytes <= FENCE_RESERVE_BYTES, 'FENCE_RESERVE_EXCEEDED');
      else check(verified.journalBytes + bytes <= bounds.maxJournalBytes, 'JOURNAL_BYTE_LIMIT');
      statement('INSERT INTO runtime_events VALUES (?,?)').run(event.sequence, serialized);
      statement('UPDATE runtime_meta SET state_json=? WHERE singleton=1').run(stateText);
      const fence = command.kind === 'FENCE';
      next = { ...verified, state: working, memo, head: eventDigest, headJson: serialized, sequence: event.sequence, lastAt: at, stateDigest,
        journalBytes: verified.journalBytes + (fence ? 0 : bytes), workloadEvents: verified.workloadEvents + (fence ? 0 : 1),
        fenceEvents: verified.fenceEvents + (fence ? 1 : 0), admissions: advanceAdmissions(verified.admissions, command),
        commit() {
          verified.requestIndex.set(key, entry); verified.events.push(JSON.parse(serialized));
          verified.commandDigests.push(digest); verified.responseDigests.push(worldDigest(response));
        } };
      return clone(response);
    });
    // The cache advances only after COMMIT; a refused or rolled-back command leaves the verified cache untouched.
    if (next) { const { commit, ...entry } = next; commit(); cache = entry; }
    return result;
  }
  function observe(fn, options) {
    live(); db.exec('BEGIN');
    try { const result = fn(verify(options)); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  // The open admission window (ADR-DQ-021) lives in memory until it is sealed into one ADMISSION event. It is not
  // authenticated and is lost if the process ends without close(); the gateway attempt table keeps every attempt.
  let openWindow = null;
  const alignedStart = at => at - (at % ADMISSION_WINDOW_MS);
  const admissionDue = (window, at) => alignedStart(at) !== window.windowStart || window.count >= ADMISSION_WINDOW_MAX;
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  const admissionInput = window => {
    const sorted = [...window.latencies].sort((left, right) => left - right);
    return { windowStart: window.windowStart, windowEnd: window.windowStart + ADMISSION_WINDOW_MS, firstAt: window.firstAt,
      lastAt: window.lastAt, count: window.count, outcomes: { ...window.outcomes },
      latency: sorted.length === 0 ? { samples: 0, min: null, p50: null, p95: null, p99: null, max: null }
        : { samples: sorted.length, min: sorted[0], p50: nearestRank(sorted, 0.5), p95: nearestRank(sorted, 0.95),
          p99: nearestRank(sorted, 0.99), max: sorted.at(-1) },
      families: Object.fromEntries(sortedEntries(window.families)), sources: Object.fromEntries(sortedEntries(window.sources)),
      contexts: sortedEntries(window.contexts).map(([contextId, count]) => ({ contextId, count })), attemptDigest: sumHex(window.attemptSum) };
  };
  // Sealing is an ordinary journal write: it needs workload capacity and refuses with the same codes (JOURNAL_LIMIT...).
  // On refusal the window stays open, so its counts are neither lost nor double counted.
  function sealAdmissionWindow() {
    const window = openWindow; if (!window) return null;
    const sealed = apply({ kind: 'ADMISSION', input: admissionInput(window) });
    if (openWindow === window) openWindow = null;
    return sealed;
  }
  const admissionView = admissions => {
    const open = openWindow && { windowStart: openWindow.windowStart, windowEnd: openWindow.windowStart + ADMISSION_WINDOW_MS,
      firstAt: openWindow.firstAt, lastAt: openWindow.lastAt, count: openWindow.count, outcomes: { ...openWindow.outcomes },
      attemptDigest: sumHex(openWindow.attemptSum), authenticated: false };
    return { schemaVersion: 'dungeonq.runtime-admissions/v1', windowMs: ADMISSION_WINDOW_MS, maxPerWindow: ADMISSION_WINDOW_MAX,
      sealed: { windows: admissions.windows, perRequestRoutes: admissions.routes, count: admissions.count, outcomes: { ...admissions.outcomes },
        attemptDigest: sumHex(admissions.attemptSum) },
      open,
      total: { count: admissions.count + (open?.count ?? 0),
        outcomes: Object.fromEntries(ADMISSION_OUTCOMES.map(outcome => [outcome, admissions.outcomes[outcome] + (open?.outcomes[outcome] ?? 0)])),
        attemptDigest: sumHex((admissions.attemptSum + (openWindow?.attemptSum ?? 0n)) % ADMISSION_MODULUS) } };
  };
  function recordAdmission(input) {
    envelope(input, ['contextId', 'requestId', 'family', 'outcome', 'attemptId'], ['latencyMs', 'source']);
    id(input.contextId); id(input.requestId, 'REQUEST_ID_INVALID'); family(input.family); id(input.attemptId, 'ATTEMPT_ID_INVALID');
    check(ADMISSION_OUTCOMES.includes(input.outcome), 'ROUTE_INVALID');
    check(input.latencyMs === undefined || (typeof input.latencyMs === 'number' && Number.isFinite(input.latencyMs)
      && input.latencyMs >= 0 && input.latencyMs <= ADMISSION_LATENCY_MAX_MS), 'ADMISSION_LATENCY_INVALID');
    const source = input.source ?? 'UNKNOWN'; check(ADMISSION_SOURCES.includes(source), 'ADMISSION_SOURCE_INVALID');
    live(); let at = now();
    if (openWindow && admissionDue(openWindow, at)) { sealAdmissionWindow(); at = now(); }
    // Same admission rules as an ORIGIN route: an active context that is not diverted, and a clock that never goes back.
    observe(({ state, lastAt }) => {
      check(at >= lastAt && (!openWindow || at >= openWindow.lastAt), 'CLOCK_REGRESSION');
      check(active(state, input.contextId).disposition === 'NORMAL_AUTHORIZED', 'ROUTE_CROSSING_DENIED');
    });
    const window = openWindow ?? { windowStart: alignedStart(at), firstAt: at, lastAt: at, count: 0, latencies: [], attempts: new Map(),
      outcomes: Object.fromEntries(ADMISSION_OUTCOMES.map(outcome => [outcome, 0])), families: new Map(), sources: new Map(),
      contexts: new Map(), attemptSum: 0n };
    const detail = worldDigest({ contextId: input.contextId, requestId: input.requestId, family: input.family, outcome: input.outcome });
    const response = replayed => ({ windowStart: window.windowStart, windowEnd: window.windowStart + ADMISSION_WINDOW_MS, pending: window.count, replayed });
    // Within the open window the attempt identifier is idempotent; gateway attempt identifiers are unique per attempt.
    const previous = window.attempts.get(input.attemptId);
    if (previous !== undefined) { check(previous === detail, 'IDEMPOTENCY_CONFLICT'); return response(true); }
    window.attempts.set(input.attemptId, detail); window.count++; window.lastAt = at; window.outcomes[input.outcome]++;
    bump(window.families, input.family); bump(window.sources, source); bump(window.contexts, input.contextId);
    if (input.latencyMs !== undefined) window.latencies.push(Math.round(input.latencyMs * 1000) / 1000);
    window.attemptSum = (window.attemptSum + attemptTerm(input.attemptId)) % ADMISSION_MODULUS;
    openWindow = window;
    return response(false);
  }

  try {
    if (!existed) transaction(() => {
      for (const statement of SCHEMA_V2) db.exec(statement);
      db.prepare('INSERT INTO runtime_meta VALUES (1,2,?,?,?,?)').run(JSON.stringify(pack), keyDigest, journalKeyDigest, JSON.stringify(blank()));
    });
    observe(() => true);
    return Object.freeze({
      registerContext(input) {
        envelope(input, ['contextId', 'tenantId', 'token', 'worldId', 'disposition']);
        check(typeof input.token === 'string' && /^[A-Za-z0-9_-]{32,256}$/u.test(input.token), 'TOKEN_INVALID');
        const { token, ...rest } = input; return apply({ kind: 'REGISTER', input: { ...clone(rest), tokenHash: hashToken(token) } });
      },
      decide(input) {
        envelope(input, ['token', 'family']); family(input.family);
        check(typeof input.token === 'string' && /^[A-Za-z0-9_-]{32,256}$/u.test(input.token), 'TOKEN_INVALID');
        return observe(({ state }) => {
          const context = state.contexts.find(item => item.tokenHash === hashToken(input.token));
          check(context, 'CONTEXT_UNKNOWN'); active(state, context.contextId); return contextView(context);
        });
      },
      execute(input) { envelope(input, ['contextId', 'family', 'requestId', 'operation', 'args']); return apply({ kind: 'EXECUTE', input: clone(input) }); },
      recordRoute(input) { envelope(input, ['contextId', 'requestId', 'family', 'destination', 'outcome'], ['attemptId']); return apply({ kind: 'ROUTE', input: clone(input) }); },
      // Ordinary origin traffic: counted into the open window, one journal event per sealed window (ADR-DQ-021).
      recordAdmission(input) { return recordAdmission(clone(input)); },
      sealAdmissions() { live(); return sealAdmissionWindow(); },
      // Verified totals of ordinary admissions: sealed (authenticated journal) and the open window (memory only).
      admissionCensus() { return observe(({ admissions }) => admissionView(admissions)); },
      // A verified, read-only lookup of the exact original command, never a retry.
      writeStatus(input) {
        envelope(input, ['contextId', 'family', 'requestId', 'operation', 'args']);
        id(input.contextId); id(input.requestId); family(input.family);
        check(input.operation === 'write', 'WRITE_STATUS_ONLY');
        const command = { kind: 'EXECUTE', input: clone(input) };
        return observe(({ state, events, head, stateDigest, requestIndex, commandDigests }) => {
          const context = state.contexts.find(item => item.contextId === input.contextId);
          check(context?.disposition === 'DIVERT', 'SYNTHETIC_CONTEXT_REQUIRED');
          const commandDigest = worldDigest(command);
          const saved = requestIndex.get(commandKey(command));
          const checkpoint = { head, eventCount: events.length, stateDigest };
          if (!saved) return { state: 'NOT_OBSERVED', commandDigest, checkpoint };
          if (saved.digest !== commandDigest) return { state: 'CONFLICT', commandDigest, checkpoint };
          const event = events.find((item, index) => item.command.kind === 'EXECUTE' && commandDigests[index] === commandDigest);
          check(event, 'COMMIT_EVIDENCE_MISSING');
          return { state: 'COMMITTED', commandDigest, checkpoint, sequence: event.sequence,
            eventDigest: event.digest, result: clone(saved.response) };
        });
      },
      grantMutation(input) {
        envelope(input, ['policyId', 'contextId', 'expectedRevision', 'allowedTemplates', 'maxMutations', 'expiresAt', 'authority']);
        return apply({ kind: 'GRANT', input: clone(input) });
      },
      mutate(input) { envelope(input, ['policyId', 'contextId', 'observationId', 'requestId', 'expectedRevision', 'template']); return apply({ kind: 'MUTATE', input: clone(input) }); },
      fence(input) { envelope(input, ['contextId', 'reason']); return apply({ kind: 'FENCE', input: clone(input) }); },
      snapshot() { return observe(({ state }) => ({ schemaVersion: 'dungeonq.runtime-snapshot/v1', profile: pack.profile,
        contexts: state.contexts.map(safeContext), worlds: clone(state.worlds), policies: clone(state.policies), observations: clone(state.observations),
        bounds: { ...clone(bounds), reservedFenceEvents: bounds.maxContexts, reservedFenceBytes: bounds.maxContexts * FENCE_RESERVE_BYTES },
        blueprint: { id: pack.id, digest: worldDigest(pack), allowedTemplates: pack.templates.map(item => item.id),
          ...(pitching ? { profile: pack.profile, pitching: clone(pack.pitching) } : {}) } })); },
      evidence() {
        // Export always follows a full authenticated replay, never the cache alone.
        return observe(({ state, events, head, stateDigest, commandDigests, responseDigests, admissions }) => ({ schemaVersion: 'dungeonq.runtime-evidence/v1', profile: pack.profile,
          events: events.map((event, index) => {
            const input = event.command.input;
            const details = Object.fromEntries(['contextId', 'tenantId', 'worldId', 'requestId', 'family', 'operation', 'destination', 'outcome', 'policyId', 'template', 'observationId']
              .filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
            return { sequence: event.sequence, at: event.at, kind: event.command.kind, ...details,
              ...(event.command.kind === 'ADMISSION' ? { admission: clone(input) } : {}),
              previousDigest: event.previousDigest, requestDigest: commandDigests[index], responseDigest: responseDigests[index],
              stateDigest: event.stateDigest, digest: event.digest };
          }),
          ...(pitching ? { pitching: state.contexts.filter(context => context.pitching).map(context => ({ contextId: context.contextId,
            ...clone(context.pitching) })) } : {}),
          admissions: admissionView(admissions),
          verifier: { status: 'VERIFIED', version: RUNTIME_VERSION, method: 'AUTHENTICATED_JOURNAL_REPLAY', eventCount: events.length,
            head, stateDigest, scope: 'LOCAL_CANONICAL_STATE', independentWitness: false,
            journalKey: separateJournal ? 'SEPARATE' : 'LEGACY_SHARED' } }), { full: true });
      },
      // Trusted presentation adapter only. Handles do not grant or widen canonical authority.
      participantTicket(wire) {
        check(typeof wire === 'string' && wire.length <= 4096, 'TICKET_INVALID');
        return createHmac('sha256', secret).update('participant-ticket-v1\0' + wire).digest('base64url');
      },
      resolveParticipantTicket(handle, contextId) {
        check(typeof handle === 'string' && /^[A-Za-z0-9_-]{43}$/.test(handle), 'TICKET_INVALID');
        return observe(({ state }) => {
          active(state, contextId, true);
          const ticket = state.tickets.find(item => item.body.contextId === contextId
            && timingSafeEqual(Buffer.from(handle), Buffer.from(createHmac('sha256', secret)
              .update('participant-ticket-v1\0' + encodeTicket(item.body)).digest('base64url'))));
          check(ticket, 'TICKET_INVALID');
          return encodeTicket(ticket.body);
        });
      },
      close() {
        if (closed) return;
        // A graceful close seals the open window. If sealing is refused, the gateway attempt table still lists every
        // attempt and the gateway's ordinary-admission-census reports the gap.
        try { sealAdmissionWindow(); } catch { /* reported by the census */ }
        db.close(); wipe(); closed = true;
      },
    });
  } catch (error) { db.close(); wipe(); throw error; }
}
