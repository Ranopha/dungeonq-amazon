// 有界、單次的私人 connector spool。此模組沒有郵件能力，也不會建立真人 ACK。
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, fstatSync,
  lstatSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntimeClient } from '../sdk/runtime-client.mjs';

export const AUTO_RELAY_VERSION = 'dungeonq.pitch-auto-relay/v1';
const MAX_WAIT_MS = 25000, POLL_MS = 250, REQUEST_MS = 2000;
const STATE_FILE = 'auto-relay.json', LOCK_FILE = '.auto-relay.lock';
const phases = new Set(['WAITING', 'CLAIMING', 'DISPATCHED', 'COMPLETING', 'ACCEPTED', 'UNKNOWN']);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
const safeError = error => /^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code ?? '') ? error.code : 'AUTO_RELAY_FAILED';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const timestamp = value => Number.isSafeInteger(value) && value >= 0;

function privateStat(path, directory = false) {
  const stat = lstatSync(path);
  check(!stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile())
    && !(stat.mode & 0o077) && (typeof process.getuid !== 'function' || stat.uid === process.getuid())
    && (directory || stat.nlink === 1), directory ? 'PRIVATE_DIRECTORY_REQUIRED' : 'PRIVATE_FILE_REQUIRED');
  return stat;
}

function readPrivate(path, optional = false) {
  let before;
  try { before = privateStat(path); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  check(before.size <= 1_048_576, 'PRIVATE_FILE_TOO_LARGE');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = fstatSync(fd);
    check(actual.dev === before.dev && actual.ino === before.ino, 'PRIVATE_FILE_CHANGED');
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

function syncDirectory(directory) {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writePrivate(directory, name, value) {
  privateStat(directory, true);
  const destination = join(directory, name);
  try { privateStat(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = join(directory, `.auto-relay-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temporary, destination); syncDirectory(directory); }
  catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
}

function acquire(directory) {
  privateStat(directory, true);
  const path = join(directory, LOCK_FILE);
  let fd;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    privateStat(path); return null;
  }
  const identity = fstatSync(fd);
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() })); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncDirectory(directory);
  return () => {
    const current = privateStat(path);
    check(current.dev === identity.dev && current.ino === identity.ino, 'AUTO_RELAY_LOCK_CHANGED');
    unlinkSync(path); syncDirectory(directory);
  };
}

export function validateAutoRelayConfig(run, credentials) {
  check(object(run) && run.responseTracking === true && run.transport === 'loopback'
    && typeof run.runtimeOrigin === 'string', 'LOCAL_RESPONSE_STUDY_REQUIRED');
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(run.runtimeOrigin);
  check(match && Number(match[1]) <= 65535, 'LOCAL_RESPONSE_STUDY_REQUIRED');
  check(object(credentials) && typeof credentials.owner === 'string' && credentials.owner.length > 0
    && credentials.owner.length <= 4096 && !/[\s\x00-\x1f\x7f]/.test(credentials.owner), 'OWNER_CREDENTIAL_REQUIRED');
  return { origin: run.runtimeOrigin, ownerDigest: digest(credentials.owner),
    runStartedAt: typeof run.startedAt === 'string' ? run.startedAt : null };
}

export function validateRelayCompletion(input) {
  check(object(input) && Object.keys(input).every(key => ['jobId', 'outcome', 'referenceId', 'receiptId'].includes(key))
    && id(input.jobId) && id(input.referenceId) && ['ACCEPTED', 'UNKNOWN'].includes(input.outcome)
    && (input.outcome === 'ACCEPTED' ? id(input.receiptId) : !Object.hasOwn(input, 'receiptId')),
  'ACTUAL_PROVIDER_EVIDENCE_REQUIRED');
  return { jobId: input.jobId, outcome: input.outcome, referenceId: input.referenceId,
    ...(input.outcome === 'ACCEPTED' ? { receiptId: input.receiptId } : {}) };
}

function readState(directory) {
  const state = readPrivate(join(directory, STATE_FILE), true);
  if (!state) return null;
  check(object(state) && state.schemaVersion === AUTO_RELAY_VERSION && phases.has(state.phase)
    && object(state.binding) && Array.isArray(state.timeline) && state.timeline.length <= 16, 'AUTO_RELAY_STATE_INVALID');
  if (state.phase !== 'WAITING') check(id(state.jobId) && object(state.scope) && id(state.scope.incidentId)
    && id(state.scope.contextId) && Number.isSafeInteger(state.scope.epoch) && state.scope.epoch > 0
    && timestamp(state.enteredAt), 'AUTO_RELAY_STATE_INVALID');
  return state;
}

export function publicRelayState(state) {
  if (!state) return { state: 'NOT_STARTED', retryAllowed: false, recipientDelivery: 'UNKNOWN' };
  return { state: ['CLAIMING', 'COMPLETING'].includes(state.phase) ? 'UNKNOWN' : state.phase,
    dispatchState: state.phase, ...(state.jobId ? { jobId: state.jobId, incidentId: state.scope.incidentId,
      contextId: state.scope.contextId, epoch: state.scope.epoch, enteredAt: state.enteredAt } : {}),
    ...(state.dispatchedAt !== undefined ? { dispatchedAt: state.dispatchedAt } : {}),
    providerOutcome: state.runtimeCompletion ? state.completionInput.outcome : 'UNKNOWN',
    recipientDelivery: 'UNKNOWN', retryAllowed: false, responseReadbackSaved: state.responseReadbackSaved === true,
    ...(state.errorCode ? { errorCode: state.errorCode } : {}) };
}

// clientFactory / clocks / sleep are injected only by trusted local tests, never by the CLI or actor.
export function createAutoRelay({ directory: directoryArg, clientFactory = createRuntimeClient,
  clock = Date.now, monotonic = () => performance.now(), sleep = delay } = {}) {
  check(typeof directoryArg === 'string' && directoryArg.length > 0, 'PRIVATE_DIRECTORY_REQUIRED');
  const directory = resolve(directoryArg);
  privateStat(directory, true);

  function configuration() {
    privateStat(directory, true);
    const run = readPrivate(join(directory, 'run-info.json'));
    const credentials = readPrivate(join(directory, 'credentials.json'));
    return { binding: validateAutoRelayConfig(run, credentials), token: credentials.owner };
  }
  function bound(state, config) {
    check(!state || digest(state.binding) === digest(config.binding), 'AUTO_RELAY_SCOPE_CHANGED');
  }
  function save(state) { writePrivate(directory, STATE_FILE, state); }
  function event(state, kind) {
    const at = clock(); check(timestamp(at), 'AUTO_RELAY_CLOCK_INVALID');
    state.timeline.push({ kind, at }); check(state.timeline.length <= 16, 'AUTO_RELAY_TIMELINE_LIMIT'); return at;
  }
  async function request(config, method, input, deadline) {
    const remaining = Math.ceil(deadline - monotonic());
    check(remaining > 0, 'AUTO_RELAY_TIMEOUT');
    const timeoutMs = Math.min(REQUEST_MS, remaining);
    const client = clientFactory({ origin: config.binding.origin, token: config.token, timeoutMs });
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => client[method](input)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('AUTO_RELAY_TIMEOUT'),
          { code: 'AUTO_RELAY_TIMEOUT' })), timeoutMs); })]);
    } finally { clearTimeout(timer); client.disconnect?.(); }
  }

  async function next(timeoutMs = MAX_WAIT_MS) {
    check(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= MAX_WAIT_MS, 'AUTO_RELAY_WAIT_INVALID');
    const deadline = monotonic() + timeoutMs, config = configuration();
    let state = readState(directory); bound(state, config);
    if (state && state.phase !== 'WAITING') return publicRelayState(state);
    const release = acquire(directory);
    if (!release) return { state: 'BUSY', retryAllowed: false, recipientDelivery: 'UNKNOWN' };
    try {
      state = readState(directory); bound(state, config);
      if (state && state.phase !== 'WAITING') return publicRelayState(state);
      if (!state) {
        state = { schemaVersion: AUTO_RELAY_VERSION, binding: config.binding, phase: 'WAITING', timeline: [] };
        event(state, 'WATCH_STARTED'); save(state);
      }
      while (monotonic() < deadline) {
        let control;
        try { control = await request(config, 'pitchStatus', undefined, deadline); }
        catch (error) { if (['AUTO_RELAY_TIMEOUT', 'REQUEST_TIMEOUT'].includes(error.code)) break; throw error; }
        check(object(control) && Array.isArray(control.incidents) && Array.isArray(control.outbox), 'AUTO_RELAY_STATUS_INVALID');
        const incidents = control.incidents.filter(row => row.phase === 'ENTERED');
        check(incidents.length <= 1, 'EXACTLY_ONE_ENTERED_INCIDENT_REQUIRED');
        if (incidents.length) {
          const incident = incidents[0];
          check(id(incident.incidentId) && id(incident.contextId) && Number.isSafeInteger(incident.epoch)
            && incident.epoch > 0 && timestamp(incident.enteredAt), 'AUTO_RELAY_INCIDENT_INVALID');
          state.scope = { incidentId: incident.incidentId, contextId: incident.contextId, epoch: incident.epoch };
          state.jobId = `auto-relay-${randomUUID()}`; state.enteredAt = incident.enteredAt;
          event(state, 'ENTRY_OBSERVED');
          const outbox = control.outbox.filter(row => row.incidentId === incident.incidentId);
          if (outbox.length !== 1 || outbox[0].status !== 'PENDING' || outbox[0].attempts !== 0) {
            state.phase = 'UNKNOWN'; state.errorCode = 'AUTO_RELAY_ALREADY_ATTEMPTED'; save(state);
            return publicRelayState(state);
          }
          // Reserve before making the remote mutation. A lost claim response can never be reclaimed here.
          state.phase = 'CLAIMING'; event(state, 'CLAIM_INTENT_SAVED'); save(state);
          try {
            const claim = await request(config, 'claimAlertRelay', { ...state.scope, leaseMs: 300000 }, deadline);
            check(object(claim) && claim.incidentId === state.scope.incidentId && claim.contextId === state.scope.contextId
              && claim.epoch === state.scope.epoch && id(claim.claimToken) && claim.authority === 'ONE_EXTERNAL_SEND_ATTEMPT'
              && claim.attempt === 1 && timestamp(claim.claimedAt) && timestamp(claim.leaseExpiresAt)
              && claim.leaseExpiresAt > clock(), 'AUTO_RELAY_CLAIM_INVALID');
            state.claim = claim; event(state, 'CLAIM_SAVED');
            state.phase = 'DISPATCHED'; state.dispatchedAt = event(state, 'DISPATCH_RESERVED'); save(state);
            // This is the only branch allowed to produce DISPATCH, after the fsync above has completed.
            return { state: 'DISPATCH', jobId: state.jobId, ...state.scope, enteredAt: state.enteredAt,
              dispatchedAt: state.dispatchedAt, templateId: 'pitch-entered-v1' };
          } catch (error) {
            state.phase = 'UNKNOWN'; state.errorCode = safeError(error); event(state, 'CLAIM_OR_DISPATCH_UNKNOWN'); save(state);
            return publicRelayState(state);
          }
        }
        const remaining = deadline - monotonic();
        if (remaining > 0) await sleep(Math.min(POLL_MS, remaining));
      }
      return { state: 'TIMEOUT', retryAllowed: false, recipientDelivery: 'UNKNOWN', pollIntervalMs: POLL_MS };
    } finally { release(); }
  }

  async function complete(rawInput) {
    const input = validateRelayCompletion(rawInput), config = configuration();
    const release = acquire(directory);
    check(release, 'AUTO_RELAY_BUSY');
    try {
      const state = readState(directory); bound(state, config);
      check(state?.jobId === input.jobId && state.claim && state.dispatchedAt !== undefined, 'AUTO_RELAY_DISPATCH_REQUIRED');
      check(!state.completionInput || digest(state.completionInput) === digest(input), 'AUTO_RELAY_COMPLETION_CONFLICT');
      const deadline = monotonic() + MAX_WAIT_MS;
      if (!state.runtimeCompletion) {
        if (!state.completionInput) {
          state.completionInput = input; state.phase = 'COMPLETING'; event(state, 'PROVIDER_RESULT_RECORDED'); save(state);
        }
        try {
          const result = await request(config, 'completeAlertRelay', { ...state.scope, claimToken: state.claim.claimToken,
            outcome: input.outcome, referenceId: input.referenceId,
            ...(input.outcome === 'ACCEPTED' ? { receiptId: input.receiptId } : {}) }, deadline);
          check(object(result) && result.outbox?.incidentId === state.scope.incidentId && result.outbox.status === input.outcome
            && (input.outcome !== 'ACCEPTED' || result.outbox.receiptId === input.receiptId), 'AUTO_RELAY_COMPLETION_INVALID');
          state.runtimeCompletion = result; state.phase = input.outcome; delete state.errorCode;
          event(state, 'RUNTIME_COMPLETED'); save(state);
        } catch (error) {
          state.errorCode = safeError(error); save(state); return publicRelayState(state);
        }
      }
      if (!state.responseReadbackSaved) {
        try {
          const response = await request(config, 'pitchResponseStatus', undefined, deadline);
          check(response?.schemaVersion === 'dungeonq.pitch-response/v1' && Array.isArray(response.events), 'AUTO_RELAY_RESPONSE_INVALID');
          writePrivate(directory, 'current-response.json', response);
          state.responseReadbackSaved = true; delete state.errorCode; event(state, 'RESPONSE_READBACK_SAVED'); save(state);
        } catch (error) { state.errorCode = safeError(error); save(state); }
      }
      return publicRelayState(state);
    } finally { release(); }
  }

  function state() { privateStat(directory, true); return publicRelayState(readState(directory)); }
  return Object.freeze({ next, complete, state });
}

export async function runAutoRelayCLI(args) {
  const [directory, command, argument, ...extra] = args;
  check(directory && ['next', 'complete', 'state'].includes(command) && extra.length === 0
    && (command !== 'state' || argument === undefined) && (command !== 'complete' || argument), 'AUTO_RELAY_USAGE');
  const relay = createAutoRelay({ directory });
  if (command === 'state') return relay.state();
  if (command === 'next') return relay.next(argument === undefined ? MAX_WAIT_MS : Number(argument));
  const path = resolve(argument); privateStat(dirname(path), true);
  return relay.complete(readPrivate(path));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.umask(0o077);
  try { console.log(JSON.stringify(await runAutoRelayCLI(process.argv.slice(2)))); }
  catch (error) { console.log(JSON.stringify({ state: 'ERROR', code: safeError(error), retryAllowed: false })); process.exitCode = 1; }
}
