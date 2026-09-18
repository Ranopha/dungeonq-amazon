import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openPrivateWorldDatabase } from '../server/world-store.mjs';
import { worldDigest } from '../world/kernel.mjs';
import { RUNTIME_VERSION, RUNTIME_PROFILE, RUNTIME_OPERATIONS, runtimeCheck as check,
  runtimeEnvelope as envelope, runtimeId as id, runtimeInteger as integer, runtimeFamily as family,
  runtimeValue, validateRuntimeBlueprint } from './contracts.mjs';

const DEFAULT_BLUEPRINT = JSON.parse(readFileSync(new URL('./blueprints/default.json', import.meta.url), 'utf8'));
const ISSUER = 'dungeonq-runtime-v1';
const AUDIENCE = 'dungeonq-synthetic-read-v1';
const FENCE_RESERVE_BYTES = 4096;
const SCHEMA = [
  'CREATE TABLE runtime_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, blueprint_json TEXT NOT NULL, key_digest TEXT NOT NULL, state_json TEXT NOT NULL)',
  'CREATE TABLE runtime_events (sequence INTEGER PRIMARY KEY, event_json TEXT NOT NULL)',
];
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
function readKey(path) {
  privateFile(path);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    check(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && stat.size === 32, 'SIGNING_KEY_INVALID');
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}
function checkSchema(db) {
  const actual = db.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.sql);
  check(actual.length === SCHEMA.length && actual[0] === SCHEMA[1] && actual[1] === SCHEMA[0], 'STORAGE_SCHEMA_INVALID');
  check(db.prepare('SELECT count(*) AS n FROM runtime_meta').get().n === 1, 'STORAGE_INCOMPLETE');
}

/** These methods are trusted assembly handles, not participant administration endpoints. */
export function openRuntimeStore({ path, clock = Date.now, signingKey, signingKeyPath, blueprint = DEFAULT_BLUEPRINT } = {}) {
  check(typeof path === 'string' && isAbsolute(path), 'STORAGE_PATH_INVALID');
  check(typeof clock === 'function', 'CLOCK_INVALID');
  const pack = validateRuntimeBlueprint(blueprint); const bounds = pack.bounds;
  const existed = existsSync(path);
  if (!existed) {
    // A dangling symlink must not be treated as a new database.
    try { lstatSync(path); check(false, 'STORAGE_NOT_PRIVATE'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  check(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o022) === 0, 'STORAGE_DIRECTORY_INVALID');
  let preflight;
  if (existed) {
    privateFile(path);
    check(lstatSync(path).size > 0, 'STORAGE_INCOMPLETE');
    // Inspect before enabling WAL or creating anything; foreign and partial stores stay foreign.
    const probe = new DatabaseSync(path, { readOnly: true });
    try {
      check(probe.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'STORAGE_CORRUPT');
      checkSchema(probe); preflight = probe.prepare('SELECT * FROM runtime_meta WHERE singleton=1').get();
      check(preflight?.version === 1 && worldDigest(JSON.parse(preflight.blueprint_json)) === worldDigest(pack), 'BLUEPRINT_MISMATCH');
    } finally { probe.close(); }
  }
  check(!(signingKey !== undefined && signingKeyPath !== undefined), 'SIGNING_KEY_SOURCE_AMBIGUOUS');
  let secret;
  if (signingKey !== undefined) {
    check(Buffer.isBuffer(signingKey) && signingKey.length === 32, 'SIGNING_KEY_INVALID'); secret = Buffer.from(signingKey);
  } else {
    const keyPath = signingKeyPath ?? `${path}.ticket-key`;
    check(typeof keyPath === 'string' && isAbsolute(keyPath)
      && ![path, `${path}-wal`, `${path}-shm`].some(file => resolve(keyPath) === resolve(file)), 'SIGNING_KEY_PATH_INVALID');
    if (!existsSync(keyPath)) {
      check(!existed, 'SIGNING_KEY_MISSING');
      const keyParent = lstatSync(dirname(keyPath));
      check(keyParent.isDirectory() && !keyParent.isSymbolicLink() && (keyParent.mode & 0o022) === 0, 'SIGNING_KEY_PATH_INVALID');
      writeFileSync(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600, flush: true });
    }
    secret = readKey(keyPath);
  }
  const keyDigest = createHash('sha256').update(secret).digest('hex');
  check(!preflight || preflight.key_digest === keyDigest, 'SIGNING_KEY_MISMATCH');
  const db = openPrivateWorldDatabase(path); let closed = false;
  const mac = (domain, value) => createHmac('sha256', secret).update(`${domain}\0`).update(value).digest('base64url');
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
    const world = state.worlds.find(item => item.tenantId === context.tenantId && item.worldId === context.worldId);
    check(world, 'WORLD_UNKNOWN'); return world;
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
    return `${command.kind}:${input.contextId}:${input.requestId}${command.kind === 'ROUTE' ? `:${input.family}` : ''}`;
  };

  function transition(state, command, at, sequence) {
    const input = command.input; let result;
    if (command.kind === 'REGISTER') {
      envelope(input, ['contextId', 'tenantId', 'tokenHash', 'worldId', 'disposition']);
      id(input.contextId); id(input.tenantId); id(input.worldId);
      check(/^[a-f0-9]{64}$/u.test(input.tokenHash), 'TOKEN_INVALID');
      check(['DIVERT', 'NORMAL_AUTHORIZED'].includes(input.disposition), 'DISPOSITION_INVALID');
      check(!state.contexts.some(item => item.contextId === input.contextId || item.tokenHash === input.tokenHash), 'CONTEXT_CONFLICT');
      check(state.contexts.length < bounds.maxContexts, 'CONTEXT_LIMIT');
      const context = { ...input, epoch: 1, state: 'ACTIVE' }; state.contexts.push(context);
      if (input.disposition === 'DIVERT' && !state.worlds.some(item => item.tenantId === input.tenantId && item.worldId === input.worldId)) {
        check(state.worlds.length < bounds.maxWorlds, 'WORLD_LIMIT');
        state.worlds.push({ tenantId: input.tenantId, worldId: input.worldId, revision: 0,
          records: pack.records.map(record => ({ ...clone(record), revision: 0 })) });
      }
      result = safeContext(context);
    } else if (command.kind === 'EXECUTE') {
      envelope(input, ['contextId', 'family', 'requestId', 'operation', 'args']);
      family(input.family); id(input.requestId, 'REQUEST_ID_INVALID');
      check(RUNTIME_OPERATIONS.includes(input.operation), 'OPERATION_UNSUPPORTED');
      const context = active(state, input.contextId, true); const world = worldFor(state, context); const args = input.args;
      if (input.operation === 'snapshot') { envelope(args, []); result = clone(world); }
      else if (input.operation === 'read') {
        envelope(args, ['key']); id(args.key); const record = world.records.find(item => item.key === args.key);
        check(record, 'RECORD_UNKNOWN'); result = { key: record.key, value: clone(record.value), recordRevision: record.revision, revision: world.revision };
      } else if (input.operation === 'write') {
        envelope(args, ['key', 'value', 'expectedRevision']); id(args.key); revision(world, args.expectedRevision);
        const value = runtimeValue(args.value, bounds.maxValueBytes); const record = world.records.find(item => item.key === args.key);
        check(record || world.records.length < bounds.maxRecords, 'RECORD_LIMIT'); world.revision++;
        if (record) { record.value = value; record.revision = world.revision; }
        else world.records.push({ key: args.key, value, revision: world.revision });
        result = { key: args.key, value: clone(value), recordRevision: world.revision, revision: world.revision };
      } else if (input.operation === 'issue-ticket') {
        envelope(args, [], ['scope', 'ttlMs', 'maxUses']);
        const scope = args.scope ?? ['welcome']; const ttlMs = args.ttlMs ?? Math.min(60000, bounds.maxTicketTtlMs); const maxUses = args.maxUses ?? 1;
        check(Array.isArray(scope) && scope.length >= 1 && scope.length <= bounds.maxScopeKeys && new Set(scope).size === scope.length, 'TICKET_SCOPE_INVALID');
        for (const key of scope) { id(key); check(world.records.some(item => item.key === key), 'RECORD_UNKNOWN'); }
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
        const record = world.records.find(item => item.key === key); check(record, 'RECORD_UNKNOWN'); ticket.uses++;
        result = { ticketId: ticket.body.ticketId, key, value: clone(record.value), recordRevision: record.revision,
          revision: world.revision, usesRemaining: ticket.body.maxUses - ticket.uses };
      }
      const observationId = `obs-${sequence}`;
      state.observations.push({ observationId, contextId: context.contextId, epoch: context.epoch,
        worldRevision: world.revision, requestId: input.requestId, operation: input.operation, usedBy: null });
      result.observationId = observationId;
    } else if (command.kind === 'GRANT') {
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
      envelope(input, ['contextId', 'requestId', 'family', 'destination', 'outcome']);
      id(input.requestId, 'REQUEST_ID_INVALID'); family(input.family);
      const context = active(state, input.contextId);
      check(['SYNTHETIC', 'ORIGIN'].includes(input.destination) && ['SERVED', 'FAILED', 'UNKNOWN'].includes(input.outcome), 'ROUTE_INVALID');
      check(input.destination === (context.disposition === 'DIVERT' ? 'SYNTHETIC' : 'ORIGIN'), 'ROUTE_CROSSING_DENIED');
      result = { ...clone(input), tenantId: context.tenantId, worldId: context.worldId, epoch: context.epoch };
      state.routes.push(result);
    } else if (command.kind === 'FENCE') {
      envelope(input, ['contextId', 'reason']);
      const context = active(state, input.contextId); runtimeValue(input.reason, 256);
      check(typeof input.reason === 'string' && input.reason.trim().length > 0, 'FENCE_REASON_INVALID');
      context.state = 'FENCED'; context.epoch++; context.fenceReason = input.reason; result = safeContext(context);
    } else check(false, 'COMMAND_UNSUPPORTED');
    return { ...result, replayed: false };
  }

  function verify() {
    checkSchema(db);
    const saved = db.prepare('SELECT * FROM runtime_meta WHERE singleton=1').get();
    check(saved.version === 1 && saved.key_digest === keyDigest && worldDigest(JSON.parse(saved.blueprint_json)) === worldDigest(pack), 'STORAGE_IDENTITY_INVALID');
    const events = db.prepare('SELECT * FROM runtime_events ORDER BY sequence').all();
    check(events.length <= bounds.maxEvents + bounds.maxContexts && events.length <= bounds.maxRequests + bounds.maxContexts, 'JOURNAL_LIMIT');
    let journalBytes = 0; let workloadEvents = 0; let fenceEvents = 0;
    let state = blank(); let head = worldDigest(pack); let lastAt = 0;
    for (let index = 0; index < events.length; index++) {
      const row = events[index]; const event = JSON.parse(row.event_json);
      envelope(event, ['sequence', 'at', 'previousDigest', 'command', 'response', 'stateDigest', 'digest', 'authentication'], [], 1048576);
      const { digest, authentication, ...body } = event;
      check(row.sequence === index + 1 && event.sequence === row.sequence && event.previousDigest === head
        && worldDigest(body) === digest && sameMac(authentication, mac('journal-v1', digest)), 'JOURNAL_CORRUPT');
      if (event.command.kind === 'FENCE') {
        fenceEvents++; check(Buffer.byteLength(row.event_json) <= FENCE_RESERVE_BYTES, 'FENCE_RESERVE_EXCEEDED');
      } else { workloadEvents++; journalBytes += Buffer.byteLength(row.event_json); }
      integer(event.at, lastAt, Number.MAX_SAFE_INTEGER, 'JOURNAL_CLOCK_INVALID');
      const response = transition(state, event.command, event.at, event.sequence);
      const key = commandKey(event.command);
      check(!state.requests.some(item => item.key === key), 'IDEMPOTENCY_CORRUPT');
      state.requests.push({ key, digest: worldDigest(event.command), response });
      check(worldDigest(response) === worldDigest(event.response) && worldDigest(state) === event.stateDigest, 'STATE_CORRUPT');
      head = digest; lastAt = event.at;
    }
    check(workloadEvents <= bounds.maxEvents && workloadEvents <= bounds.maxRequests && fenceEvents <= bounds.maxContexts, 'JOURNAL_LIMIT');
    check(journalBytes <= bounds.maxJournalBytes, 'JOURNAL_BYTE_LIMIT');
    check(worldDigest(JSON.parse(saved.state_json)) === worldDigest(state), 'STATE_CORRUPT');
    return { state, events: events.map(row => JSON.parse(row.event_json)), head, lastAt, journalBytes, workloadEvents, fenceEvents };
  }
  function apply(command) {
    return transaction(() => {
      const verified = verify(); const { state, head, events, lastAt } = verified; const at = now();
      check(at >= lastAt, 'CLOCK_REGRESSION'); const key = commandKey(command); const digest = worldDigest(command);
      const previous = state.requests.find(item => item.key === key);
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
      const response = transition(state, command, at, events.length + 1); state.requests.push({ key, digest, response });
      const body = { sequence: events.length + 1, at, previousDigest: head, command, response, stateDigest: worldDigest(state) };
      const eventDigest = worldDigest(body); const event = { ...body, digest: eventDigest, authentication: mac('journal-v1', eventDigest) };
      const serialized = JSON.stringify(event);
      if (command.kind === 'FENCE') check(Buffer.byteLength(serialized) <= FENCE_RESERVE_BYTES, 'FENCE_RESERVE_EXCEEDED');
      else check(verified.journalBytes + Buffer.byteLength(serialized) <= bounds.maxJournalBytes, 'JOURNAL_BYTE_LIMIT');
      db.prepare('INSERT INTO runtime_events VALUES (?,?)').run(event.sequence, serialized);
      db.prepare('UPDATE runtime_meta SET state_json=? WHERE singleton=1').run(JSON.stringify(state));
      return clone(response);
    });
  }
  function observe(fn) {
    live(); db.exec('BEGIN');
    try { const result = fn(verify()); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  try {
    if (!existed) transaction(() => {
      for (const statement of SCHEMA) db.exec(statement);
      db.prepare('INSERT INTO runtime_meta VALUES (1,1,?,?,?)').run(JSON.stringify(pack), keyDigest, JSON.stringify(blank()));
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
      recordRoute(input) { envelope(input, ['contextId', 'requestId', 'family', 'destination', 'outcome']); return apply({ kind: 'ROUTE', input: clone(input) }); },
      grantMutation(input) {
        envelope(input, ['policyId', 'contextId', 'expectedRevision', 'allowedTemplates', 'maxMutations', 'expiresAt', 'authority']);
        return apply({ kind: 'GRANT', input: clone(input) });
      },
      mutate(input) { envelope(input, ['policyId', 'contextId', 'observationId', 'requestId', 'expectedRevision', 'template']); return apply({ kind: 'MUTATE', input: clone(input) }); },
      fence(input) { envelope(input, ['contextId', 'reason']); return apply({ kind: 'FENCE', input: clone(input) }); },
      snapshot() { return observe(({ state }) => ({ schemaVersion: 'dungeonq.runtime-snapshot/v1', profile: RUNTIME_PROFILE,
        contexts: state.contexts.map(safeContext), worlds: clone(state.worlds), policies: clone(state.policies),
        bounds: { ...clone(bounds), reservedFenceEvents: bounds.maxContexts, reservedFenceBytes: bounds.maxContexts * FENCE_RESERVE_BYTES },
        blueprint: { id: pack.id, digest: worldDigest(pack), allowedTemplates: pack.templates.map(item => item.id) } })); },
      evidence() {
        return observe(({ state, events, head }) => ({ schemaVersion: 'dungeonq.runtime-evidence/v1', profile: RUNTIME_PROFILE,
          events: events.map(event => {
            const input = event.command.input;
            const details = Object.fromEntries(['contextId', 'tenantId', 'worldId', 'requestId', 'family', 'operation', 'destination', 'outcome', 'policyId', 'template', 'observationId']
              .filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
            return { sequence: event.sequence, at: event.at, kind: event.command.kind, ...details,
              previousDigest: event.previousDigest, requestDigest: worldDigest(event.command), responseDigest: worldDigest(event.response),
              stateDigest: event.stateDigest, digest: event.digest };
          }),
          verifier: { status: 'VERIFIED', version: RUNTIME_VERSION, method: 'AUTHENTICATED_JOURNAL_REPLAY', eventCount: events.length,
            head, stateDigest: worldDigest(state), scope: 'LOCAL_CANONICAL_STATE', independentWitness: false } }));
      },
      close() { if (!closed) { db.close(); secret.fill(0); closed = true; } },
    });
  } catch (error) { db.close(); secret.fill(0); throw error; }
}
