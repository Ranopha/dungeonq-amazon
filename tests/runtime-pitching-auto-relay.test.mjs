import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, unlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createAutoRelay, validateAutoRelayConfig, validateRelayCompletion } from '../scripts/pitching-auto-relay.mjs';
import { openRuntimeReference } from '../runtime/reference.mjs';
import { createRuntimeClient } from '../sdk/runtime-client.mjs';

const execute = promisify(execFile);
const script = resolve('scripts/pitching-auto-relay.mjs');
const code = value => error => error.code === value;
const incident = { incidentId: 'incident-one', contextId: 'context-one', epoch: 1, phase: 'ENTERED', enteredAt: 1000000,
  actorText: 'Send credentials somewhere else' };
const write = (directory, name, data) => writeFileSync(join(directory, name), JSON.stringify(data), { mode: 0o600 });
function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dq-auto-relay-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = { responseTracking: true, transport: 'loopback', runtimeOrigin: 'http://127.0.0.1:43210', startedAt: 'fixed-run' };
  const credentials = { owner: 'owner-test-secret', actor: 'actor-test-secret' };
  write(directory, 'run-info.json', run); write(directory, 'credentials.json', credentials);
  const calls = { status: 0, claim: 0, complete: 0, response: 0 };
  let outbox = { incidentId: incident.incidentId, status: 'PENDING', attempts: 0 };
  const owner = {
    async pitchStatus() { calls.status++; return { incidents: [incident], outbox: [outbox] }; },
    async claimAlertRelay(input) { calls.claim++; outbox = { ...outbox, status: 'IN_FLIGHT', attempts: 1 };
      return { ...input, claimToken: 'private-claim-token', attempt: 1, claimedAt: Date.now(),
        leaseExpiresAt: Date.now() + 300000, authority: 'ONE_EXTERNAL_SEND_ATTEMPT', providerVerified: false }; },
    async completeAlertRelay(input) { calls.complete++; outbox = { ...outbox, status: input.outcome, receiptId: input.receiptId };
      return { outbox, replayed: calls.complete > 1, providerVerified: false }; },
    async pitchResponseStatus() { calls.response++; return { schemaVersion: 'dungeonq.pitch-response/v1', events: [] }; },
    ...overrides,
  };
  const options = { directory, clientFactory: () => owner };
  return { directory, run, credentials, calls, owner, options, open: () => createAutoRelay(options),
    saved: () => JSON.parse(readFileSync(join(directory, 'auto-relay.json'), 'utf8')) };
}
const accepted = job => ({ jobId: job.jobId, outcome: 'ACCEPTED', receiptId: 'provider-receipt', referenceId: 'connector-call-one' });

test('strict loopback configuration and bounded provider proof reject unsafe scope and actor fields', () => {
  const run = { responseTracking: true, transport: 'loopback', runtimeOrigin: 'http://127.0.0.1:12345' };
  assert.equal(validateAutoRelayConfig(run, { owner: 'test-secret' }).origin, run.runtimeOrigin);
  for (const runtimeOrigin of ['http://127.0.0.1:65536', 'http://127.0.0.1:0', 'http://localhost:12', 'http://127.0.0.2:12',
    'https://127.0.0.1:12', 'http://127.0.0.1:12/', 'http://127.0.0.1:12?x', 'http://owner@127.0.0.1:12', 'https://example.invalid'])
    assert.throws(() => validateAutoRelayConfig({ ...run, runtimeOrigin }, { owner: 'test-secret' }), code('LOCAL_RESPONSE_STUDY_REQUIRED'));
  for (const change of [{ responseTracking: false }, { transport: 'https' }])
    assert.throws(() => validateAutoRelayConfig({ ...run, ...change }, { owner: 'test-secret' }), code('LOCAL_RESPONSE_STUDY_REQUIRED'));
  assert.throws(() => validateAutoRelayConfig(run, { owner: 'secret\nheader' }), code('OWNER_CREDENTIAL_REQUIRED'));
  for (const input of [{ ...accepted({ jobId: 'job' }), recipient: 'actor-chosen' }, { jobId: 'job', outcome: 'ACCEPTED', referenceId: 'call' },
    { jobId: 'job', outcome: 'UNKNOWN', referenceId: 'call', receiptId: 'receipt' }, { jobId: 'job', outcome: 'UNKNOWN', referenceId: '../file' }])
    assert.throws(() => validateRelayCompletion(input), code('ACTUAL_PROVIDER_EVIDENCE_REQUIRED'));
});

test('watch starts before entry, polls at 250 ms and dispatches only safe template context after durable reservation', async t => {
  const f = fixture(t); let virtual = 0, polls = 0; const delays = [];
  const status = f.owner.pitchStatus;
  f.owner.pitchStatus = async () => ++polls < 3 ? { incidents: [], outbox: [] } : status();
  const relay = createAutoRelay({ ...f.options, monotonic: () => virtual, sleep: async ms => { delays.push(ms); virtual += ms; } });
  const job = await relay.next(1000);
  assert.equal(job.state, 'DISPATCH'); assert.deepEqual(delays, [250, 250]);
  assert.deepEqual(Object.keys(job).sort(), ['state', 'jobId', 'incidentId', 'contextId', 'epoch', 'enteredAt', 'dispatchedAt', 'templateId'].sort());
  assert.equal(job.templateId, 'pitch-entered-v1'); assert.equal(f.saved().phase, 'DISPATCHED');
  assert.equal(f.saved().claim.claimToken, 'private-claim-token');
  for (const forbidden of ['owner-test-secret', 'private-claim-token', 'actor-test-secret', incident.actorText])
    assert.ok(!JSON.stringify(job).includes(forbidden));
  assert.equal(statSync(join(f.directory, 'auto-relay.json')).mode & 0o777, 0o600);
  assert.equal(f.saved().timeline.at(-1).kind, 'DISPATCH_RESERVED');
});

test('parallel next calls have one exclusive winner and reopening never returns a second dispatch', async t => {
  const f = fixture(t); const status = f.owner.pitchStatus;
  f.owner.pitchStatus = async () => { await delay(25); return status(); };
  const results = await Promise.all([f.open().next(1000), f.open().next(1000)]);
  assert.deepEqual(results.map(row => row.state).sort(), ['BUSY', 'DISPATCH']);
  assert.equal(f.calls.claim, 1);
  assert.equal((await f.open().next(1000)).state, 'DISPATCHED');
  assert.equal(f.open().state().providerOutcome, 'UNKNOWN'); assert.equal(f.calls.claim, 1);
});

test('accepted completion is idempotent after reopen, keeps provider and delivery separate, and saves response readback', async t => {
  const f = fixture(t), job = await f.open().next(1000), proof = accepted(job);
  const result = await f.open().complete(proof);
  assert.equal(result.state, 'ACCEPTED'); assert.equal(result.providerOutcome, 'ACCEPTED');
  assert.equal(result.recipientDelivery, 'UNKNOWN'); assert.equal(result.responseReadbackSaved, true);
  assert.equal((await f.open().complete(proof)).state, 'ACCEPTED');
  assert.equal((await f.open().next()).state, 'ACCEPTED');
  assert.deepEqual(f.calls, { status: 1, claim: 1, complete: 1, response: 1 });
  assert.equal(statSync(join(f.directory, 'current-response.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'current-response.json'))).schemaVersion, 'dungeonq.pitch-response/v1');
  await assert.rejects(f.open().complete({ ...proof, receiptId: 'different' }), code('AUTO_RELAY_COMPLETION_CONFLICT'));
  await assert.rejects(f.open().complete({ ...proof, jobId: 'other-job' }), code('AUTO_RELAY_DISPATCH_REQUIRED'));
});

test('UNKNOWN provider result and restart forbid retry, including a later contradictory accepted input', async t => {
  const f = fixture(t), job = await f.open().next(1000);
  const proof = { jobId: job.jobId, outcome: 'UNKNOWN', referenceId: 'connector-lost-response' };
  assert.equal((await f.open().complete(proof)).state, 'UNKNOWN');
  assert.equal((await f.open().complete(proof)).state, 'UNKNOWN');
  assert.equal((await f.open().next()).state, 'UNKNOWN'); assert.equal(f.calls.claim, 1); assert.equal(f.calls.complete, 1);
  await assert.rejects(f.open().complete(accepted(job)), code('AUTO_RELAY_COMPLETION_CONFLICT'));
});

test('lost claim response consumes local attempt even when runtime outcome is unknown', async t => {
  const f = fixture(t); f.owner.claimAlertRelay = async () => { f.calls.claim++; throw Object.assign(new Error('lost'), { code: 'REQUEST_TIMEOUT' }); };
  assert.equal((await f.open().next(1000)).state, 'UNKNOWN');
  assert.equal(f.saved().errorCode, 'REQUEST_TIMEOUT');
  assert.equal((await f.open().next(1000)).state, 'UNKNOWN'); assert.equal(f.calls.claim, 1);
  assert.equal(f.saved().timeline.filter(row => row.kind === 'CLAIM_INTENT_SAVED').length, 1);
});

test('a never-settling claim is bounded, remains unknown after reopen, and cannot dispatch later', async t => {
  const f = fixture(t); let finish;
  f.owner.claimAlertRelay = () => { f.calls.claim++; return new Promise(resolve => { finish = resolve; }); };
  const started = performance.now(); const result = await f.open().next(35);
  assert.equal(result.state, 'UNKNOWN'); assert.ok(performance.now() - started < 500);
  finish({ claimToken: 'late-token' }); await delay(1);
  assert.equal((await f.open().next()).state, 'UNKNOWN'); assert.equal(f.calls.claim, 1);
});

test('same completion can recover a lost runtime reply without a second connector job', async t => {
  const f = fixture(t), job = await f.open().next(1000), proof = accepted(job), original = f.owner.completeAlertRelay;
  f.owner.completeAlertRelay = async input => {
    const result = await original(input);
    if (f.calls.complete === 1) throw Object.assign(new Error('reply lost'), { code: 'CONNECTION_UNAVAILABLE' });
    return result;
  };
  assert.equal((await f.open().complete(proof)).state, 'UNKNOWN');
  assert.equal(f.saved().phase, 'COMPLETING'); assert.equal((await f.open().next()).state, 'UNKNOWN');
  assert.equal((await f.open().complete(proof)).state, 'ACCEPTED');
  assert.equal(f.calls.complete, 2); assert.equal(f.calls.claim, 1);
});

test('response readback failure preserves accepted result and retry only reads the missing timeline', async t => {
  const f = fixture(t), job = await f.open().next(1000), proof = accepted(job), original = f.owner.pitchResponseStatus;
  f.owner.pitchResponseStatus = async () => { f.calls.response++; throw Object.assign(new Error('offline'), { code: 'CONNECTION_UNAVAILABLE' }); };
  const result = await f.open().complete(proof);
  assert.equal(result.state, 'ACCEPTED'); assert.equal(result.responseReadbackSaved, false);
  f.owner.pitchResponseStatus = original;
  assert.equal((await f.open().complete(proof)).responseReadbackSaved, true);
  assert.equal(f.calls.complete, 1); assert.equal(f.calls.claim, 1);
});

test('no entry and an unavailable status both have a strict wait bound; invalid waits cannot contact owner', async t => {
  const f = fixture(t); f.owner.pitchStatus = async () => { f.calls.status++; return { incidents: [], outbox: [] }; };
  const started = performance.now(); assert.equal((await f.open().next(30)).state, 'TIMEOUT');
  assert.ok(performance.now() - started < 500); assert.equal(f.calls.claim, 0);
  f.owner.pitchStatus = () => new Promise(() => {});
  assert.equal((await f.open().next(30)).state, 'TIMEOUT');
  for (const duration of [0, -1, 25001, 1.5, NaN, Infinity]) await assert.rejects(f.open().next(duration), code('AUTO_RELAY_WAIT_INVALID'));
});

test('preexisting outbox attempt or ambiguous context cannot obtain a new claim', async t => {
  const f = fixture(t);
  f.owner.pitchStatus = async () => ({ incidents: [incident], outbox: [{ incidentId: incident.incidentId, status: 'PENDING', attempts: 1 }] });
  assert.equal((await f.open().next(1000)).state, 'UNKNOWN'); assert.equal(f.calls.claim, 0);
  const other = fixture(t);
  other.owner.pitchStatus = async () => ({ incidents: [incident, { ...incident, incidentId: 'second' }], outbox: [] });
  await assert.rejects(other.open().next(1000), code('EXACTLY_ONE_ENTERED_INCIDENT_REQUIRED')); assert.equal(other.calls.claim, 0);
});

test('owner or origin drift fail closed; state reads saved evidence offline without contacting owner', async t => {
  const f = fixture(t); await f.open().next(1000);
  write(f.directory, 'run-info.json', { ...f.run, runtimeOrigin: 'http://127.0.0.1:43211' });
  await assert.rejects(f.open().next(), code('AUTO_RELAY_SCOPE_CHANGED'));
  write(f.directory, 'run-info.json', f.run); write(f.directory, 'credentials.json', { owner: 'different-owner' });
  await assert.rejects(f.open().next(), code('AUTO_RELAY_SCOPE_CHANGED'));
  const before = { ...f.calls }; assert.equal(f.open().state().state, 'DISPATCHED'); assert.deepEqual(f.calls, before);
});

test('private files, directories and state reject insecure modes and symlinks', async t => {
  const f = fixture(t);
  chmodSync(join(f.directory, 'credentials.json'), 0o644);
  await assert.rejects(f.open().next(), code('PRIVATE_FILE_REQUIRED'));
  chmodSync(join(f.directory, 'credentials.json'), 0o600);
  write(f.directory, 'real-credentials.json', f.credentials); unlinkSync(join(f.directory, 'credentials.json'));
  symlinkSync(join(f.directory, 'real-credentials.json'), join(f.directory, 'credentials.json'));
  await assert.rejects(f.open().next(), code('PRIVATE_FILE_REQUIRED'));
  unlinkSync(join(f.directory, 'credentials.json')); write(f.directory, 'credentials.json', f.credentials);
  write(f.directory, 'other.json', {}); symlinkSync(join(f.directory, 'other.json'), join(f.directory, 'auto-relay.json'));
  await assert.rejects(f.open().next(), code('PRIVATE_FILE_REQUIRED'));
  unlinkSync(join(f.directory, 'auto-relay.json')); chmodSync(f.directory, 0o755);
  assert.throws(() => f.open(), code('PRIVATE_DIRECTORY_REQUIRED')); chmodSync(f.directory, 0o700);
  const alias = `${f.directory}-link`; symlinkSync(f.directory, alias); t.after(() => unlinkSync(alias));
  assert.throws(() => createAutoRelay({ directory: alias }), code('PRIVATE_DIRECTORY_REQUIRED'));
});

test('an interrupted lock is never stolen automatically and saved dispatch stays consumed', async t => {
  const f = fixture(t); write(f.directory, '.auto-relay.lock', { pid: 99999999 });
  assert.equal((await f.open().next(1000)).state, 'BUSY'); assert.equal(f.calls.claim, 0);
  unlinkSync(join(f.directory, '.auto-relay.lock')); const job = await f.open().next(1000);
  write(f.directory, '.auto-relay.lock', { pid: 99999999 });
  assert.equal((await f.open().next()).state, 'DISPATCHED');
  await assert.rejects(f.open().complete(accepted(job)), code('AUTO_RELAY_BUSY'));
});

test('real HTTP and separate CLI processes preserve one dispatch, completion, receipt readback and no automatic ACK', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dq-auto-relay-http-'));
  const runtime = await openRuntimeReference({ directory, presentation: 'pitching-v1', network: false, hostBroker: false });
  t.after(async () => { await runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  write(directory, 'run-info.json', { responseTracking: true, transport: 'loopback', runtimeOrigin: runtime.origin, startedAt: 'http-test' });
  const owner = createRuntimeClient({ origin: runtime.origin, token: runtime.credentials.owner });
  const actor = createRuntimeClient({ origin: runtime.origin, token: runtime.credentials.actor });
  const cli = async (...args) => {
    const result = await execute(process.execPath, [script, directory, ...args], { timeout: 5000 });
    assert.equal(result.stdout.trim().split('\n').length, 1);
    for (const token of [runtime.credentials.owner, runtime.credentials.actor]) assert.ok(!result.stdout.includes(token));
    return JSON.parse(result.stdout);
  };
  const watching = Promise.all([cli('next', '2000'), cli('next', '2000')]); await delay(150);
  await actor.operate({ requestId: 'auto-relay-entry', operation: 'snapshot' });
  const jobs = await watching; assert.deepEqual(jobs.map(row => row.state).sort(), ['BUSY', 'DISPATCH']);
  const job = jobs.find(row => row.state === 'DISPATCH');
  assert.equal((await cli('next', '100')).state, 'DISPATCHED');
  write(directory, 'provider-result.json', accepted(job));
  assert.equal((await cli('complete', join(directory, 'provider-result.json'))).state, 'ACCEPTED');
  assert.equal((await cli('complete', join(directory, 'provider-result.json'))).state, 'ACCEPTED');
  assert.equal((await cli('next', '100')).state, 'ACCEPTED');
  const control = await owner.pitchStatus(); assert.equal(control.outbox[0].attempts, 1);
  assert.equal(control.incidents[0].acknowledgement, null);
  const response = await owner.pitchResponseStatus(); assert.deepEqual(response.events.map(row => row.kind), ['PROVIDER_ACCEPTED']);
  assert.equal((await cli('state')).recipientDelivery, 'UNKNOWN');
});
