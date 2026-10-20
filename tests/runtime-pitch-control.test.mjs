import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { openPitchControl } from '../runtime/pitch-control.mjs';

const error = code => cause => cause.code === code;
const baseline = { globalTotal: 100, contextTotal: 50, globalWindow: 100, contextWindow: 50,
  globalConcurrent: 4, contextConcurrent: 2, globalErrors: 50, contextErrors: 25,
  deliveryLeaseMs: 100, deliveryTimeoutMs: 20, retryBaseMs: 10 };
function fixture(t, limits = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dungeonq-pitch-test-'));
  const path = join(directory, 'pitch.sqlite'); let time = 1000000; const handles = [];
  const config = { path, clock: () => time, limits: { ...baseline, ...limits } };
  const open = () => { const handle = openPitchControl(config); handles.push(handle); return handle; };
  t.after(() => { for (const handle of handles) handle.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path, open, config, setTime: value => { time = value; }, advance: delta => { time += delta; } };
}
const begin = (control, contextId = 'context-a', family = 'http') => {
  const lease = control.begin({ family }); control.bind(lease, { contextId }); return lease;
};
const finish = (control, lease, outcome = 'SERVED', code = outcome === 'SERVED' ? 'OK' : 'EXECUTION_FAILED') => control.finish(lease, { outcome, code });
const entry = (contextId = 'context-a', epoch = 1) => ({ contextId, worldId: 'world-a', epoch, eventId: 'route-event-a' });
const entered = control => {
  const lease = begin(control); const { incident } = control.recordEntry(entry()); finish(control, lease); return incident;
};

test('pitch shared context budget spans all transport families and handles', t => {
  const f = fixture(t, { contextTotal: 3 }); const first = f.open(); const second = f.open();
  for (const [index, family] of ['http', 'mcp', 'host'].entries()) {
    const control = index % 2 ? second : first; finish(control, begin(control, 'context-a', family));
  }
  const denied = second.begin({ family: 'ssh' });
  assert.throws(() => second.bind(denied, { contextId: 'context-a' }), error('PITCH_CONTEXT_TOTAL'));
  finish(second, denied, 'REFUSED', 'PITCH_CONTEXT_TOTAL');
  const snapshot = first.snapshot(); assert.equal(snapshot.global.attempts, 4);
  assert.equal(snapshot.contexts[0].budget.attempts, 4); assert.equal(snapshot.contexts[0].budget.admitted, 3);
  assert.equal(snapshot.contexts[0].budget.denials.TOTAL, 1); assert.equal(snapshot.activeLeases.length, 0);
});

test('pitch global total, window and context budgets survive restart', t => {
  const f = fixture(t, { globalTotal: 3, contextTotal: 3, globalWindow: 2, contextWindow: 2 }); let control = f.open();
  finish(control, begin(control)); finish(control, begin(control)); control.close(); control = f.open();
  assert.throws(() => control.begin({ family: 'mcp' }), error('PITCH_GLOBAL_RATE'));
  assert.equal(control.snapshot().global.attempts, 3);
  f.advance(60001); control.close(); control = f.open();
  assert.throws(() => control.begin({ family: 'host' }), error('PITCH_GLOBAL_TOTAL'));
  assert.equal(control.snapshot().global.attempts, 4); assert.equal(control.snapshot().global.denials.RATE, 1);
});

test('pitch rejects changed limits on reopen rather than resetting admission', t => {
  const f = fixture(t); const control = f.open(); finish(control, begin(control)); control.close();
  assert.throws(() => openPitchControl({ ...f.config, limits: { ...f.config.limits, globalTotal: 101 } }), error('PITCH_CONFIG_CHANGED'));
  assert.equal(f.open().snapshot().global.attempts, 1);
});

test('pitch global and context concurrency are atomic across independent handles', t => {
  const f = fixture(t, { globalConcurrent: 2, contextConcurrent: 1 }); const a = f.open(); const b = f.open();
  const one = begin(a); const two = b.begin({ family: 'mcp' });
  assert.throws(() => b.bind(two, { contextId: 'context-a' }), error('PITCH_CONTEXT_CONCURRENT'));
  assert.throws(() => a.begin({ family: 'postgres' }), error('PITCH_GLOBAL_CONCURRENT'));
  finish(b, two, 'REFUSED', 'PITCH_CONTEXT_CONCURRENT'); finish(a, one);
  finish(b, begin(b, 'context-a', 'postgres')); assert.equal(a.snapshot().global.admitted, 3);
});

test('pitch crash leases persist beyond TTL and have an explicit trusted reconciliation path', t => {
  const f = fixture(t, { globalConcurrent: 1, contextConcurrent: 1 }); let control = f.open(); const lease = begin(control);
  control.close(); f.advance(86400000); control = f.open();
  assert.throws(() => control.begin({ family: 'mcp' }), error('PITCH_GLOBAL_CONCURRENT'));
  assert.throws(() => control.reconcile({ ...lease, evidence: { kind: 'TTL_EXPIRED', referenceId: 'proof-a', operatorId: 'owner' } }), error('PITCH_RECONCILIATION_INVALID'));
  assert.equal(control.reconcile({ ...lease, evidence: { kind: 'STOPPED_EXECUTION', referenceId: 'stopped-host-a', operatorId: 'owner' } }).outcome, 'UNKNOWN');
  const proofSample = control.snapshot().samples.at(-1); assert.equal(proofSample.category, 'RECONCILIATION');
  assert.match(proofSample.evidenceDigest, /^[a-f0-9]{64}$/); finish(control, begin(control));
  assert.equal(control.snapshot().global.attempts, 3);
});

test('pitch unknown credential floods remain global-only with bounded samples and one storage row', t => {
  const f = fixture(t, { globalTotal: 200, globalWindow: 200, globalErrors: 200, maxSamples: 3 }); const control = f.open();
  for (let index = 0; index < 100; index++) {
    const lease = control.begin({ family: index % 2 ? 'mcp' : 'http' }); finish(control, lease, 'REFUSED', 'CONTEXT_UNKNOWN');
  }
  const state = control.snapshot(); assert.equal(state.contexts.length, 0); assert.equal(state.samples.length, 3);
  assert.equal(state.global.errors, 100); assert.equal(state.global.attempts, 100);
  const db = new DatabaseSync(f.path, { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM pitch_meta').get().n, 1); }
  finally { db.close(); }
});

test('pitch rejects raw request metadata and never stores arbitrary error text', t => {
  const f = fixture(t); const control = f.open(); const raw = 'RAW_PRIVATE_TOKEN_ABCDEFGHIJKLMN';
  assert.throws(() => control.begin({ family: 'http', token: raw }));
  const lease = control.begin({ family: 'http' });
  assert.throws(() => control.bind(lease, { contextId: 'context-a', ticket: raw }));
  finish(control, lease, 'FAILED', raw);
  assert.ok(!JSON.stringify(control.snapshot()).includes(raw)); control.close();
  assert.ok(!readFileSync(f.path).includes(Buffer.from(raw)));
});

test('pitch persisted error budgets block global and per-context attempts', t => {
  const f = fixture(t, { globalErrors: 3, contextErrors: 1 }); let control = f.open();
  finish(control, begin(control), 'FAILED'); control.close(); control = f.open();
  const denied = control.begin({ family: 'mcp' });
  assert.throws(() => control.bind(denied, { contextId: 'context-a' }), error('PITCH_CONTEXT_ERRORS'));
  finish(control, denied, 'REFUSED', 'PITCH_CONTEXT_ERRORS');
  finish(control, begin(control, 'context-b'), 'UNKNOWN'); control.close(); control = f.open();
  assert.throws(() => control.begin({ family: 'http' }), error('PITCH_GLOBAL_ERRORS'));
});

test('pitch duplicate binding does not re-charge and cannot change identity', t => {
  const f = fixture(t); const control = f.open(); const lease = begin(control);
  assert.equal(control.bind(lease, { contextId: 'context-a' }).replayed, true);
  assert.throws(() => control.bind(lease, { contextId: 'context-b' }), error('PITCH_LEASE_REBOUND'));
  assert.equal(control.snapshot().contexts[0].budget.attempts, 1); finish(control, lease);
  assert.throws(() => finish(control, lease), error('PITCH_LEASE_UNKNOWN'));
  const unbound = control.begin({ family: 'http' }); assert.throws(() => finish(control, unbound), error('PITCH_BIND_REQUIRED'));
  finish(control, unbound, 'REFUSED', 'CONTEXT_UNKNOWN');
});

test('pitch fixed context capacity refuses new trusted identities while owner reads remain available', t => {
  const f = fixture(t, { maxContexts: 1 }); const control = f.open(); finish(control, begin(control));
  const lease = control.begin({ family: 'http' });
  assert.throws(() => control.bind(lease, { contextId: 'context-b' }), error('PITCH_GLOBAL_CONTEXTS'));
  finish(control, lease, 'REFUSED', 'PITCH_GLOBAL_CONTEXTS'); assert.equal(control.snapshot().contexts.length, 1);
});

test('pitch clock rollback cannot reopen a spent window', t => {
  const f = fixture(t, { globalWindow: 1, contextWindow: 1 }); const control = f.open(); finish(control, begin(control));
  f.setTime(10); assert.throws(() => control.begin({ family: 'mcp' }), error('PITCH_GLOBAL_RATE'));
  assert.equal(control.snapshot().clockAt, 1000000);
  f.setTime(1060000); finish(control, begin(control));
});

test('pitch admission reserves one durable incident and outbox before verified entry', async t => {
  const f = fixture(t); let control = f.open(); const lease = begin(control);
  const first = control.reserveEntry(entry()); assert.equal(first.incident.phase, 'ADMITTED');
  assert.equal(first.incident.localInbox, 'AVAILABLE'); assert.equal(first.incident.entryEventId, null);
  const second = f.open(); assert.equal(second.reserveEntry({ ...entry(), eventId: 'another-reservation' }).replayed, true);
  finish(control, lease, 'UNKNOWN'); control.close(); control = f.open();
  assert.equal((await control.deliver({ send: async () => { throw new Error('should not send provisional'); } })).attempted, 0);
  assert.equal(control.snapshot().outbox[0].status, 'PENDING');
  const verified = control.recordEntry({ ...entry(), eventId: 'verified-route-event' });
  assert.equal(verified.incident.phase, 'ENTERED'); assert.equal(verified.incident.entryEventId, 'verified-route-event');
  assert.equal(second.recordEntry({ ...entry(), eventId: 'retry-event' }).replayed, true);
  assert.equal(control.snapshot().incidents.length, 1); assert.equal(control.snapshot().outbox.length, 1);
  assert.equal(control.snapshot().incidents[0].entryEventId, 'verified-route-event');
});

test('pitch inbox acknowledgement, resolution and notification acceptance remain independent', async t => {
  const f = fixture(t, { globalTotal: 1, contextTotal: 1, maxIncidents: 1 }); const control = f.open(); const incident = entered(control);
  assert.throws(() => control.reserveEntry(entry('context-a', 2)), error('PITCH_INCIDENT_CAPACITY'));
  assert.throws(() => control.begin({ family: 'http' }), error('PITCH_GLOBAL_TOTAL'));
  assert.throws(() => control.resolve({ incidentId: incident.incidentId, operatorId: 'owner', resolution: 'FENCED' }), error('PITCH_ACK_REQUIRED'));
  assert.equal(control.acknowledge({ incidentId: incident.incidentId, operatorId: 'owner' }).incident.phase, 'ENTERED');
  assert.equal(control.acknowledge({ incidentId: incident.incidentId, operatorId: 'owner-b' }).replayed, true);
  control.resolve({ incidentId: incident.incidentId, operatorId: 'owner', resolution: 'FENCED' });
  assert.throws(() => control.resolve({ incidentId: incident.incidentId, operatorId: 'owner', resolution: 'REVIEWED' }), error('PITCH_RESOLUTION_CONFLICT'));
  assert.equal(control.snapshot().outbox[0].status, 'PENDING');
  const delivered = await control.deliver({ send: async () => ({ accepted: true, receiptId: 'provider-receipt-a' }) });
  assert.equal(delivered.results[0].status, 'ACCEPTED');
  assert.equal(control.snapshot().incidents[0].resolution.resolution, 'FENCED');
});

test('pitch without a sender remains pending, and null is never delivery success', async t => {
  const f = fixture(t); const control = f.open(); entered(control);
  assert.deepEqual(await control.deliver(), { configured: false, attempted: 0, results: [] });
  assert.equal(control.snapshot().outbox[0].attempts, 0);
  const response = await control.deliver({ send: async () => null });
  assert.equal(response.results[0].status, 'UNKNOWN'); assert.equal(response.results[0].receiptId, null);
  f.advance(1000); assert.equal((await control.deliver({ send: async () => ({ accepted: true, receiptId: 'wrong-blind-retry' }) })).attempted, 0);
});

test('pitch unknown delivery needs receipt reconciliation or proven nonacceptance', async t => {
  const f = fixture(t); let control = f.open(); const incident = entered(control);
  await control.deliver({ send: async () => { throw new Error('may have sent before failure'); } }); control.close(); control = f.open();
  const pending = control.snapshot().outbox[0]; assert.equal(pending.status, 'UNKNOWN');
  assert.throws(() => control.reconcileDelivery({ incidentId: incident.incidentId,
    evidence: { kind: 'DEFINITELY_NOT_ACCEPTED', idempotencyKey: 'wrong', referenceId: 'provider-query-a' } }), error('PITCH_RECONCILIATION_INVALID'));
  control.reconcileDelivery({ incidentId: incident.incidentId, evidence: { kind: 'DEFINITELY_NOT_ACCEPTED',
    idempotencyKey: pending.idempotencyKey, referenceId: 'provider-query-a' } });
  assert.equal(control.snapshot().outbox[0].status, 'PENDING');
  await control.deliver({ send: async () => { throw new Error('again uncertain'); } });
  control.reconcileDelivery({ incidentId: incident.incidentId, evidence: { kind: 'DELIVERY_RECEIPT',
    idempotencyKey: pending.idempotencyKey, referenceId: 'provider-query-b', receiptId: 'provider-confirmed-a' } });
  const result = control.snapshot().outbox[0]; assert.equal(result.status, 'ACCEPTED');
  assert.equal(result.receiptId, 'provider-confirmed-a'); assert.equal(control.snapshot().incidents[0].acknowledgement, null);
});

test('pitch explicitly idempotent callbacks retry unknown results with the identical key', async t => {
  const f = fixture(t); const control = f.open(); entered(control); const keys = [];
  await control.deliver({ send: async input => { keys.push(input.idempotencyKey); throw new Error('uncertain'); } });
  f.advance(10);
  await control.deliver({ idempotent: true, send: async input => { keys.push(input.idempotencyKey); return { accepted: true, receiptId: 'receipt-a' }; } });
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]); assert.equal(control.snapshot().outbox[0].status, 'ACCEPTED');
});

test('pitch definite nonacceptance uses bounded backoff and a finite retry budget', async t => {
  const f = fixture(t, { deliveryAttempts: 2 }); const control = f.open(); entered(control); let calls = 0;
  const send = async () => { calls++; return { accepted: false, definitive: true, retryable: true }; };
  await control.deliver({ send }); assert.equal(control.snapshot().outbox[0].status, 'PENDING');
  assert.equal((await control.deliver({ send })).attempted, 0); f.advance(10);
  await control.deliver({ send }); assert.equal(control.snapshot().outbox[0].status, 'EXHAUSTED');
  f.advance(1000); assert.equal((await control.deliver({ send, idempotent: true })).attempted, 0); assert.equal(calls, 2);
});

test('pitch concurrent delivery handles cannot claim the same live lease', async t => {
  const f = fixture(t, { deliveryTimeoutMs: 100, deliveryLeaseMs: 200 }); const first = f.open(); const second = f.open(); entered(first);
  let release; let notify; const started = new Promise(resolve => { notify = resolve; });
  const send = () => new Promise(resolve => { release = resolve; notify(); });
  const running = first.deliver({ send }); await started;
  assert.equal(second.snapshot().outbox[0].status, 'IN_FLIGHT');
  assert.equal((await second.deliver({ send: async () => ({ accepted: true, receiptId: 'double-send' }) })).attempted, 0);
  release({ accepted: true, receiptId: 'one-send' }); await running;
  assert.equal(second.snapshot().outbox[0].attempts, 1);
});

test('pitch expired delivery leases become UNKNOWN without a blind second send', async t => {
  const f = fixture(t, { deliveryTimeoutMs: 100, deliveryLeaseMs: 200 }); const first = f.open(); const second = f.open(); entered(first);
  let release; let notify; const started = new Promise(resolve => { notify = resolve; });
  const running = first.deliver({ send: () => new Promise(resolve => { release = resolve; notify(); }) }); await started;
  f.advance(201); assert.equal(second.snapshot().outbox[0].status, 'UNKNOWN');
  assert.equal((await second.deliver({ send: async () => ({ accepted: true, receiptId: 'unsafe-retry' }) })).attempted, 0);
  release({ accepted: true, receiptId: 'late-receipt' }); await running;
  assert.equal(second.snapshot().outbox[0].status, 'UNKNOWN');
  const row = second.snapshot().outbox[0];
  second.reconcileDelivery({ incidentId: row.incidentId, evidence: { kind: 'DELIVERY_RECEIPT', idempotencyKey: row.idempotencyKey,
    referenceId: 'late-result-checked', receiptId: 'late-receipt' } });
  assert.equal(second.snapshot().outbox[0].status, 'ACCEPTED');
});

test('pitch sender timeout is bounded and an abort signal is supplied', async t => {
  const f = fixture(t, { deliveryTimeoutMs: 5 }); const control = f.open(); entered(control); let signal;
  const result = await control.deliver({ send: input => { signal = input.signal; return new Promise(() => {}); } });
  assert.equal(signal.aborted, true); assert.equal(result.results[0].status, 'UNKNOWN');
  assert.equal(result.results[0].lastError, 'TIMEOUT');
});

test('pitch batches are bounded independently of participant exhaustion', async t => {
  const f = fixture(t, { globalTotal: 1, contextTotal: 1 }); const control = f.open(); const lease = begin(control);
  for (let epoch = 1; epoch <= 4; epoch++) control.recordEntry(entry('context-a', epoch)); finish(control, lease);
  assert.throws(() => control.begin({ family: 'mcp' }), error('PITCH_GLOBAL_TOTAL'));
  let calls = 0; const response = await control.deliver({ max: 2, send: async () => ({ accepted: true, receiptId: `receipt-${++calls}` }) });
  assert.equal(response.attempted, 2); assert.equal(calls, 2); assert.equal(control.snapshot().outbox.filter(row => row.status === 'PENDING').length, 2);
});

test('pitch validates configuration, closed schemas and persisted state', t => {
  const f = fixture(t);
  for (const limits of [{ unknown: 1 }, { globalTotal: -1 }, { globalWindow: 1.5 }, { deliveryTimeoutMs: 100, deliveryLeaseMs: 100 }]) {
    assert.throws(() => openPitchControl({ ...f.config, limits: { ...baseline, ...limits } }));
    assert.equal(existsSync(f.path), false);
  }
  const control = f.open(); const lease = begin(control);
  assert.throws(() => control.reserveEntry({ ...entry(), rawBody: 'secret' }));
  assert.throws(() => control.recordEntry({ ...entry(), epoch: 0 })); finish(control, lease); control.close();
  assert.throws(() => control.snapshot(), error('PITCH_CONTROL_CLOSED'));
  const db = new DatabaseSync(f.path); db.prepare('UPDATE pitch_meta SET state=?').run('{}'); db.close();
  assert.throws(() => f.open(), error('PITCH_STATE_CORRUPT'));
});

test('pitch configured capacities above 128 remain bounded and reopen correctly', t => {
  const f = fixture(t, { maxIncidents: 130 }); const control = f.open(); const lease = begin(control);
  for (let epoch = 1; epoch <= 130; epoch++) control.reserveEntry(entry('context-a', epoch));
  assert.throws(() => control.reserveEntry(entry('context-a', 131)), error('PITCH_INCIDENT_CAPACITY'));
  finish(control, lease); control.close(); assert.equal(f.open().snapshot().incidents.length, 130);
});

test('pitch simultaneous worker handles cannot overspend a shared durable total', async t => {
  const f = fixture(t, { globalTotal: 25, contextTotal: 25 }); const control = f.open();
  const barrier = new SharedArrayBuffer(4); const flag = new Int32Array(barrier);
  const run = () => new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      import(workerData.module).then(({ openPitchControl }) => {
        const c = openPitchControl({ path: workerData.path, clock: () => 1000000, limits: workerData.limits });
        const flag = new Int32Array(workerData.barrier); parentPort.postMessage({ ready: true });
        Atomics.wait(flag, 0, 0); let served = 0; let denied = 0;
        for (let i = 0; i < 20; i++) {
          let lease;
          try { lease = c.begin({ family: 'mcp' }); c.bind(lease, { contextId: 'context-a' });
            c.finish(lease, { outcome: 'SERVED', code: 'OK' }); served++; }
          catch (error) { if (lease) c.finish(lease, { outcome: 'REFUSED', code: error.code });
            if (error.code !== 'PITCH_GLOBAL_TOTAL') throw error; denied++; }
        }
        c.close(); parentPort.postMessage({ served, denied });
      }).catch(error => { throw error; });
    `, { eval: true, workerData: { module: new URL('../runtime/pitch-control.mjs', import.meta.url).href,
      path: f.path, limits: f.config.limits, barrier } });
    worker.once('error', reject);
    worker.on('message', message => {
      if (message.ready) { ready++; if (ready === 2) { Atomics.store(flag, 0, 1); Atomics.notify(flag, 0); } }
      else resolve(message);
    });
    worker.once('exit', code => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
  });
  let ready = 0; const results = await Promise.all([run(), run()]);
  assert.equal(results.reduce((sum, row) => sum + row.served, 0), 25);
  assert.equal(results.reduce((sum, row) => sum + row.denied, 0), 15);
  assert.equal(control.snapshot().global.attempts, 40); assert.equal(control.snapshot().global.admitted, 25);
});

test('pitch rejects invalid clock before creating storage and closed sender options', async t => {
  const f = fixture(t);
  assert.throws(() => openPitchControl({ ...f.config, clock: () => -1 }), error('CLOCK_INVALID'));
  assert.equal(existsSync(f.path), false); const control = f.open();
  await assert.rejects(() => control.deliver({ send: async () => null, recipient: 'arbitrary' }), error('PITCH_DELIVERY_INVALID'));
  await assert.rejects(() => control.deliver({ get send() { throw new Error('must not invoke getter'); } }), error('PITCH_DELIVERY_INVALID'));
});
