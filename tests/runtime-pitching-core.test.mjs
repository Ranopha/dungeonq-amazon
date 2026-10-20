import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openRuntimeStore } from '../runtime/store.mjs';
import { createPitchingBlueprint } from '../runtime/pitching.mjs';
import { validateRuntimeBlueprint } from '../runtime/contracts.mjs';
import { worldDigest } from '../world/kernel.mjs';

const registration = (contextId = 'context-a', token = 'a'.repeat(40)) =>
  ({ contextId, tenantId: 'tenant-a', worldId: 'world-a', disposition: 'DIVERT', token });
const code = expected => error => error.code === expected;
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dungeonq-pitching-core-'));
  const path = join(directory, 'runtime.sqlite'); let at = 1000000; let store;
  const configuration = { path, clock: () => at, blueprint: createPitchingBlueprint({ seed: 17 }), ...options };
  const open = () => { store = openRuntimeStore(configuration); return store; };
  t.after(() => { store?.close(); rmSync(directory, { recursive: true, force: true }); });
  return { configuration, path, open, setTime(value) { at = value; } };
}
function client(store, contextId = 'context-a') {
  let sequence = 0;
  const execute = (operation, args = {}, family = 'http', requestId = `${contextId}-${++sequence}`) =>
    store.execute({ contextId, family, requestId, operation, args });
  return { execute, read: (key, family = 'http') => execute('read', { key }, family),
    snapshot: () => execute('snapshot'),
    ticket(key, family = 'http', maxUses = 1) {
      return execute('issue-ticket', { scope: [key], maxUses }, family).ticket;
    },
    use(key, ticket, family = 'http', requestId) { return execute('use-ticket', { key, ticket }, family, requestId); },
  };
}
function reachHistory(c, order = ['catalog-current', 'catalog-prior']) {
  for (const key of order) c.read(key);
  return c.use('catalog-current', c.ticket('catalog-current')).revealed;
}
function reachMirror(c) {
  const history = reachHistory(c); c.read('catalog-current', 'mcp');
  return c.use(history.key, c.ticket(history.key)).revealed;
}
function complete(c, { order, readbackFamily = 'mcp' } = {}) {
  const history = reachHistory(c, order); c.read('catalog-current', 'mcp');
  const mirror = c.use(history.key, c.ticket(history.key)).revealed;
  const before = c.snapshot().revision;
  const written = c.execute('write', { key: 'note-review', value: 'Check the effective window.', expectedRevision: before });
  const readback = c.read('note-review', readbackFamily);
  const persistence = c.use('note-review', c.ticket('note-review')).revealed;
  c.read(persistence.key);
  const continuation = c.use(persistence.key, c.ticket(persistence.key)).revealed;
  return { history, mirror, written, readback, persistence, continuation };
}

test('pitching contracts reject missing permission, unbounded or unknown rules and seeds', () => {
  const pack = createPitchingBlueprint({ seed: 17 }); assert.deepEqual(validateRuntimeBlueprint(pack), pack);
  assert.throws(() => createPitchingBlueprint({ seed: 99 }), code('PITCHING_SEED_UNSUPPORTED'));
  assert.throws(() => createPitchingBlueprint({ seed: 17, mode: 'model-selected' }), code('PITCHING_PROFILE_INVALID'));
  const noPermission = structuredClone(pack); delete noPermission.pitching.permission;
  assert.throws(() => validateRuntimeBlueprint(noPermission), code('PITCHING_POLICY_REQUIRED'));
  const changed = structuredClone(pack); changed.pitching.nodes[0].rule = 'PLAYER_TEXT';
  assert.throws(() => validateRuntimeBlueprint(changed), code('PITCHING_PROFILE_INVALID'));
  const overflow = structuredClone(pack); overflow.pitching.maxTransitions = 5;
  assert.throws(() => validateRuntimeBlueprint(overflow), code('PITCHING_PROFILE_INVALID'));
  const hidden = structuredClone(pack); hidden.pitching.initialKeys.push('history-delta');
  assert.throws(() => validateRuntimeBlueprint(hidden), code('PITCHING_PROFILE_INVALID'));
});

test('actor snapshot, guessed reads, ticket scopes and writes cannot expose or forge progress', t => {
  const f = fixture(t); const store = f.open(); store.registerContext(registration()); const c = client(store);
  const initial = c.snapshot(); assert.deepEqual(initial.records.map(item => item.key), ['welcome', 'catalog-current', 'catalog-prior']);
  for (const field of ['groundTruth', 'policyVersion', 'seed', 'mode', 'visibleKeys', 'decisions', 'history-delta', 'maxTransitions'])
    assert.equal(JSON.stringify(initial).includes(field), false);
  for (const key of ['history-delta', 'mirror-index', 'persistence-receipt', 'continuation-amber']) {
    assert.throws(() => c.read(key), code('RECORD_UNKNOWN'));
    assert.throws(() => c.ticket(key), code('RECORD_UNKNOWN'));
    assert.throws(() => c.execute('write', { key, value: 'fake', expectedRevision: 0 }), code('RECORD_UNKNOWN'));
  }
  assert.throws(() => c.execute('write', { key: 'catalog-current', value: 'fake', expectedRevision: 0 }), code('PITCHING_RECORD_IMMUTABLE'));
  for (const key of ['progress', 'policy', 'truth', 'note-'])
    assert.throws(() => c.execute('write', { key, value: 'fake', expectedRevision: 0 }), code('PITCHING_NOTE_SCOPE_DENIED'));
  assert.throws(() => c.execute('snapshot', { visibleKeys: ['history-delta'] }), code('INVALID_ENVELOPE'));
  c.execute('write', { key: 'note-forged', value: { progress: 4, approved: true, restart: true }, expectedRevision: 0 });
  c.read('note-forged'); const unchanged = c.use('note-forged', c.ticket('note-forged'));
  assert.equal(unchanged.revealed, undefined); assert.equal(store.snapshot().contexts[0].pitching.decisions.length, 0);
  const snapshotTicket = c.use('catalog-current', c.ticket('catalog-current'));
  assert.equal(snapshotTicket.revealed, undefined, 'snapshot is not evidence of deliberate version reads');
});

test('all four scenarios are reachable, locally truthful and committed before disclosure', t => {
  const f = fixture(t); const store = f.open(); store.registerContext(registration()); const c = client(store);
  const current = c.read('catalog-current').value; const prior = c.read('catalog-prior').value;
  const result = complete(c);
  assert.equal(current.previousDigest, worldDigest(prior));
  assert.equal(result.history.value.effectiveVersion, 1); assert.equal(result.history.value.chain[1].digest, worldDigest(current));
  assert.equal(result.mirror.value.sourceId, current.sourceId); assert.equal(result.mirror.value.contentDigest, worldDigest(current));
  assert.match(result.mirror.value.independence, /not independent/);
  assert.equal(result.written.revision, 3); assert.equal(result.written.recordRevision, result.written.revision);
  assert.equal(result.readback.value, result.written.value); assert.equal(result.readback.recordRevision, result.written.recordRevision);
  assert.match(result.persistence.value.limitation, /does not assert a process restart/);
  assert.equal(result.continuation.key, 'continuation-amber');
  const trusted = store.snapshot(); const progress = trusted.contexts[0].pitching;
  assert.equal(progress.decisions.length, 4); assert.deepEqual(progress.decisions.map(item => item.budgetAfter), [3, 2, 1, 0]);
  assert.equal(trusted.blueprint.pitching.groundTruth.effectiveValue, prior.capacity);
  const db = new DatabaseSync(f.path, { readOnly: true });
  const persisted = JSON.parse(db.prepare('SELECT state_json FROM runtime_meta').get().state_json); db.close();
  assert.deepEqual(persisted.contexts[0].pitching, progress, 'the returned reveal already has durable decision state');
  const evidence = store.evidence(); assert.deepEqual(evidence.pitching[0].decisions, progress.decisions);
  for (const decision of progress.decisions) {
    assert.ok(decision.observationIds.every(id => trusted.observations.some(item => item.observationId === id)));
    assert.equal(decision.seed, 17); assert.equal(decision.policyDigest, progress.policyDigest);
    assert.equal(evidence.events.find(event => event.sequence === decision.sequence).operation, 'use-ticket');
  }
  assert.equal(c.snapshot().records.length, 8, 'three initial records, four reveals, one player note');
  assert.deepEqual(c.read('catalog-current').value, current, 'version truth is immutable after all reveals');
});

test('same-world contexts have independent progress, note ownership, revisions and ticket authority', t => {
  const f = fixture(t); const store = f.open(); store.registerContext(registration());
  store.registerContext(registration('context-b', 'b'.repeat(40))); const a = client(store); const b = client(store, 'context-b');
  const history = reachHistory(a); assert.equal(b.snapshot().revision, 0);
  assert.throws(() => b.read(history.key), code('RECORD_UNKNOWN'));
  a.execute('write', { key: 'note-private', value: 'A only', expectedRevision: 1 });
  assert.throws(() => b.read('note-private'), code('RECORD_UNKNOWN'));
  b.execute('write', { key: 'note-private', value: 'B only', expectedRevision: 0 });
  assert.equal(a.read('note-private').value, 'A only'); assert.equal(b.read('note-private').value, 'B only');
  assert.throws(() => b.use('catalog-current', a.ticket('catalog-current')), code('TICKET_SCOPE_INVALID'));
  assert.equal(b.use('catalog-current', b.ticket('catalog-current')).revealed, undefined);
  assert.equal(store.snapshot().worlds.length, 2);
});

test('cross-interface evidence requires the same immutable record and a second real family', t => {
  const f = fixture(t); const store = f.open(); store.registerContext(registration()); const c = client(store);
  const history = reachHistory(c);
  c.read('catalog-current'); c.read('catalog-prior', 'mcp');
  assert.equal(c.use(history.key, c.ticket(history.key)).revealed, undefined);
  c.read('catalog-current', 'mcp');
  assert.equal(c.use(history.key, c.ticket(history.key)).revealed.key, 'mirror-ledger');
});

test('only current committed note readback can trigger persistence and writes keep v14 revision semantics', t => {
  const f = fixture(t); const store = f.open(); store.registerContext(registration()); const c = client(store); reachMirror(c);
  const write = { key: 'note-review', value: 'first', expectedRevision: 2 };
  const result = c.execute('write', write, 'http', 'write-first'); assert.equal(result.revision, write.expectedRevision + 1);
  assert.equal(c.use('note-review', c.ticket('note-review')).revealed, undefined);
  c.read('note-review'); c.execute('write', { key: 'note-review', value: 'updated', expectedRevision: 3 });
  assert.equal(c.use('note-review', c.ticket('note-review')).revealed, undefined, 'an older readback cannot prove the current note');
  c.read('note-review', 'mcp');
  assert.equal(c.use('note-review', c.ticket('note-review')).revealed.key, 'persistence-journal');
  const status = store.writeStatus({ contextId: 'context-a', family: 'http', requestId: 'write-first', operation: 'write', args: write });
  assert.equal(status.state, 'COMMITTED'); assert.equal(status.result.revision, 3);
  assert.equal(store.writeStatus({ contextId: 'context-a', family: 'mcp', requestId: 'write-first', operation: 'write', args: write }).state, 'CONFLICT');
});

test('replay, replenished tickets and fresh request IDs never pick another branch; restart is identical', t => {
  const f = fixture(t); let store = f.open(); store.registerContext(registration()); let c = client(store);
  c.read('catalog-current'); c.read('catalog-prior'); const ticket = c.ticket('catalog-current', 'http', 3);
  const first = c.use('catalog-current', ticket, 'http', 'reveal-once');
  const before = store.evidence(); assert.equal(c.use('catalog-current', ticket, 'http', 'reveal-once').replayed, true);
  assert.deepEqual(store.evidence(), before);
  assert.throws(() => c.use('catalog-current', ticket, 'mcp', 'reveal-once'), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(c.use('catalog-current', ticket, 'http', 'fresh-use').revealed, undefined);
  assert.equal(c.use('catalog-current', c.ticket('catalog-current')).revealed, undefined);
  const snapshot = store.snapshot(); const evidence = store.evidence(); store.close(); store = f.open(); c = client(store);
  assert.deepEqual(store.snapshot(), snapshot); assert.deepEqual(store.evidence(), evidence);
  assert.deepEqual(c.use('catalog-current', ticket, 'http', 'reveal-once'), { ...first, replayed: true });
  assert.equal(store.snapshot().contexts[0].pitching.decisions.length, 1);
  assert.throws(() => store.execute({ contextId: 'context-a', family: 'http', requestId: 'new-hidden-read', operation: 'read', args: { key: 'history-chronology' } }), code('RECORD_UNKNOWN'));
});

test('adaptive choices respond to valid operation order while fixed control is reproducible', t => {
  function run(mode, order) {
    const f = fixture(t, { blueprint: createPitchingBlueprint({ seed: 29, mode }) }); const store = f.open();
    store.registerContext(registration()); const result = complete(client(store), { order });
    return { keys: [result.history.key, result.mirror.key, result.persistence.key, result.continuation.key], progress: store.snapshot().contexts[0].pitching };
  }
  const currentFirst = ['catalog-current', 'catalog-prior']; const priorFirst = ['catalog-prior', 'catalog-current'];
  const adaptive = run('adaptive', currentFirst); const changed = run('adaptive', priorFirst);
  assert.notEqual(adaptive.keys[0], changed.keys[0]); assert.equal(adaptive.keys[3], 'continuation-teal');
  assert.deepEqual(run('adaptive', currentFirst), adaptive, 'same seed, script and clock regenerate decisions');
  const fixed = run('fixed', currentFirst); assert.deepEqual(fixed.keys, run('fixed', priorFirst).keys);
  assert.deepEqual(fixed.keys, ['history-chronology', 'mirror-index', 'persistence-receipt', 'continuation-amber']);
  assert.deepEqual(run('fixed', currentFirst), fixed);
});

test('different trusted seeds yield distinct coherent worlds, pinned against restart replacement', t => {
  const outcomes = [];
  for (const seed of [17, 29, 43]) {
    const f = fixture(t, { blueprint: createPitchingBlueprint({ seed }) }); const store = f.open(); store.registerContext(registration());
    const c = client(store); const current = c.read('catalog-current').value; const result = complete(c);
    assert.equal(result.history.value.chain[1].digest, worldDigest(current));
    outcomes.push({ capacity: current.capacity, key: result.continuation.key }); store.close();
    assert.throws(() => openRuntimeStore({ ...f.configuration, blueprint: createPitchingBlueprint({ seed: seed === 17 ? 29 : 17 }) }), code('BLUEPRINT_MISMATCH'));
  }
  assert.equal(new Set(outcomes.map(item => item.capacity)).size, 3);
  assert.equal(new Set(outcomes.map(item => item.key)).size, 3);
});

test('policy budgets, expiry and legacy mutation fail closed, retaining independent fence capacity', t => {
  const pack = createPitchingBlueprint({ seed: 17 }); pack.pitching.maxTransitions = 1;
  const f = fixture(t, { blueprint: pack }); const store = f.open(); store.registerContext(registration()); const c = client(store);
  const history = reachHistory(c); c.read('catalog-current', 'mcp'); const ticket = c.ticket(history.key);
  const before = store.evidence(); assert.throws(() => c.use(history.key, ticket), code('PITCHING_BUDGET_EXHAUSTED'));
  assert.deepEqual(store.evidence(), before, 'budget refusal rolls back ticket use and the whole command');
  assert.throws(() => store.grantMutation({ policyId: 'bypass', contextId: 'context-a', expectedRevision: 1,
    allowedTemplates: ['anything'], maxMutations: 1, expiresAt: 1001000, authority: { kind: 'OWNER', principalId: 'operator' } }), code('PITCHING_LEGACY_MUTATION_DENIED'));
  assert.throws(() => store.mutate({ policyId: 'bypass', contextId: 'context-a', observationId: 'obs-1', requestId: 'bypass', expectedRevision: 1, template: 'anything' }), code('PITCHING_LEGACY_MUTATION_DENIED'));
  store.fence({ contextId: 'context-a', reason: 'Bounded test complete.' });
  assert.throws(() => c.snapshot(), code('CONTEXT_FENCED'));
  assert.throws(() => c.use(history.key, ticket), code('CONTEXT_FENCED'));
  const expiryPack = createPitchingBlueprint({ seed: 17 }); expiryPack.bounds.maxPolicyTtlMs = 10;
  const expiryFixture = fixture(t, { blueprint: expiryPack }); const expiryStore = expiryFixture.open(); expiryStore.registerContext(registration());
  const e = client(expiryStore); e.read('catalog-current'); e.read('catalog-prior'); const validTicket = e.ticket('catalog-current');
  expiryFixture.setTime(1000010);
  assert.throws(() => e.use('catalog-current', validTicket), code('PITCHING_POLICY_EXPIRED'));
  assert.equal(expiryStore.snapshot().contexts[0].pitching.decisions.length, 0);
  const limited = createPitchingBlueprint({ seed: 17 }); limited.bounds.maxEvents = 1; limited.bounds.maxRequests = 1;
  const limitedStore = fixture(t, { blueprint: limited }).open(); limitedStore.registerContext(registration());
  assert.throws(() => client(limitedStore).snapshot(), code('JOURNAL_LIMIT'));
  assert.equal(limitedStore.fence({ contextId: 'context-a', reason: 'Fence after workload exhaustion.' }).state, 'FENCED');
});

test('the existing v1 profile keeps mutable records, shared worlds and the original snapshot shape', t => {
  const blueprint = JSON.parse(readFileSync(new URL('../runtime/blueprints/default.json', import.meta.url), 'utf8'));
  const f = fixture(t, { blueprint }); const store = f.open(); store.registerContext(registration());
  store.registerContext(registration('context-b', 'b'.repeat(40))); const a = client(store); const b = client(store, 'context-b');
  a.execute('write', { key: 'welcome', value: 'v1 remains mutable', expectedRevision: 0 });
  assert.equal(b.read('welcome').value, 'v1 remains mutable'); assert.equal(store.snapshot().worlds.length, 1);
  assert.equal(store.snapshot().contexts[0].pitching, undefined); assert.equal(store.evidence().pitching, undefined);
  assert.deepEqual(Object.keys(a.snapshot()).sort(), ['observationId', 'records', 'replayed', 'revision', 'tenantId', 'worldId']);
});
