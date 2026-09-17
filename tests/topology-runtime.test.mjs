import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { openTopologyStore } from '../server/topology-store.mjs';
import { openTopologyObserver } from '../server/topology-observer.mjs';
import { replayTopology } from '../world/topology.mjs';

const assignment = { seed: 19, arm: 'TREATMENT', participantMode: 'SCRIPTED_FIXTURE', worldId: 'runtime-test', epoch: 'epoch-one' };
const envelope = (revision, command, requestId = `r_${revision}`) => ({ requestId, expectedRevision: revision, command });
const act = { type: 'act', actionId: 'annotate-atlas' };
async function setup(t) { const directory = await mkdtemp(join(tmpdir(), 'topology-runtime-')); const handles = [];
  t.after(async () => { handles.forEach(store => store.close()); await rm(directory, { recursive: true, force: true }); });
  const open = (extra = {}) => { const store = openTopologyStore({ ...assignment, path: join(directory, 'topology.sqlite'), ...extra }); handles.push(store); return store; };
  return { directory, handles, open }; }

test('state/journal/outbox/dedup survive restart and two writers enforce a single revision', async t => {
  const f = await setup(t); const first = f.open(); const second = f.open(); const input = envelope(0, act);
  const result = first.command(input); assert.equal(result.view.revision, 1);
  assert.throws(() => second.command(envelope(0, act, 'other')), /REVISION_CONFLICT/);
  assert.equal(second.command(input).replayed, true); assert.equal(first.pending().length, 1);
  assert.throws(() => first.command({ ...input, command: { type: 'finish' } }), /IDEMPOTENCY_CONFLICT/);
  first.close(); second.close(); const restored = f.open(); assert.equal(restored.snapshot().revision, 1);
  assert.deepEqual(restored.command(input), { ...result, replayed: true }); assert.equal(replayTopology(restored.exportEvidence()).eventCount, 1);
  assert.throws(() => f.open({ seed: 23 }), /TOPOLOGY_DESIGN_MISMATCH/);
  assert.throws(() => f.open({ arm: 'CONTROL' }), /TOPOLOGY_DESIGN_MISMATCH/);
  assert.throws(() => f.open({ participantMode: 'CODEX_PILOT' }), /TOPOLOGY_DESIGN_MISMATCH/);
});

test('bounded outbox has one withdrawal slot, exact ACKs and no continued actions after stopping', async t => {
  const f = await setup(t); const store = f.open({ maxPending: 1 }); store.command(envelope(0, act));
  assert.throws(() => store.command(envelope(1, { type: 'finish' })), /OBSERVER_BACKLOG_FULL/);
  assert.equal(store.snapshot().revision, 1); assert.equal(store.exportEvidence().events.length, 1);
  const input = envelope(1, { type: 'withdraw' }); const stop = store.command(input); assert.equal(stop.view.phase, 'WITHDRAWN');
  assert.equal(store.pending().length, 2); assert.equal(store.command(input).replayed, true);
  assert.throws(() => store.command(envelope(2, act)), /TOPOLOGY_FINISHED/);
  assert.throws(() => store.ack(1, '0'.repeat(64)), /ACK_MISMATCH/);
  for (const event of store.pending()) store.ack(event.sequence, event.digest);
  assert.equal(store.pending().length, 0); assert.equal(store.exportEvidence().events.length, 2);
});

test('independent observer verifies before atomic append, accepts duplicate delivery and restores without duplicates', async t => {
  const f = await setup(t); const store = f.open(); store.command(envelope(0, act)); store.command(envelope(1, { type: 'visit', sceneId: 'layout' }));
  const path = join(f.directory, 'observer.sqlite'); const observer = openTopologyObserver({ ...assignment, path }); f.handles.push(observer);
  const events = store.exportEvidence().events; const invalid = structuredClone(events); invalid[1].observation.message = 'forged';
  assert.throws(() => observer.append(invalid, 2), /EVENT_CAUSALITY_INVALID/); assert.equal(observer.snapshot().events.length, 0);
  const acks = observer.append(events, 2); assert.equal(acks.length, 2); observer.append(events, 2);
  assert.equal(observer.snapshot().events.length, 2); assert.equal(observer.snapshot().lag, 0); observer.close();
  const restored = openTopologyObserver({ ...assignment, path }); f.handles.push(restored);
  assert.equal(restored.snapshot().verification.valid, true); assert.equal(restored.exportEvidence().events.length, 2);
});

test('restore rejects corrupted state, journal, idempotency and outbox instead of clearing evidence', async t => {
  for (const mutation of ["UPDATE topology_meta SET state_json=json_set(state_json,'$.revision',99)",
    "UPDATE topology_events SET event_json=json_set(event_json,'$.observation.message','changed')",
    "UPDATE topology_requests SET payload_hash='changed'", "UPDATE topology_outbox SET digest='changed'"]) await t.test(mutation.split(' ')[1], async t => {
    const f = await setup(t); const store = f.open(); store.command(envelope(0, act)); store.close();
    const db = new DatabaseSync(join(f.directory, 'topology.sqlite')); db.exec(mutation); db.close();
    assert.throws(() => f.open(), /MISMATCH|CORRUPT/);
  });
});

test('non-private DB files are rejected before use', async t => {
  const f = await setup(t); const path = join(f.directory, 'unsafe.sqlite'); await writeFile(path, ''); await chmod(path, 0o644);
  assert.throws(() => openTopologyStore({ ...assignment, path }), /STORAGE_NOT_PRIVATE/);
});
