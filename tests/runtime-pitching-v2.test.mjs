import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRuntimeStore } from '../runtime/store.mjs';
import { createPitchingBlueprint } from '../runtime/pitching.mjs';
import { validateRuntimeBlueprint } from '../runtime/contracts.mjs';
import { worldDigest } from '../world/kernel.mjs';

const code = expected => error => error.code === expected;
const registration = (contextId = 'context-a', token = 'a'.repeat(40)) =>
  ({ contextId, tenantId: 'tenant-a', worldId: 'world-a', disposition: 'DIVERT', token });
function fixture(t, { pitchingVariant = 'entry-v2', mode = 'adaptive', seed = 29, blueprint } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dq-pitch-v2-')); let at = 1000000; let store; let serial = 0;
  const configuration = { path: join(directory, 'runtime.sqlite'), clock: () => at,
    blueprint: blueprint ?? createPitchingBlueprint({ seed, pitchingVariant, mode }) };
  const open = () => { store = openRuntimeStore(configuration); return store; };
  open(); store.registerContext(registration());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (operation, args = {}, family = 'http', requestId = `r-${++serial}`, contextId = 'context-a') =>
    store.execute({ contextId, operation, args, family, requestId });
  const ticket = (key, options = {}, family = 'http') => call('issue-ticket', { scope: [key], ...options }, family).ticket;
  return { call, ticket, use: (key, wire = ticket(key), family = 'http', id) => call('use-ticket', { key, ticket: wire }, family, id),
    read: (key, family = 'http') => call('read', { key }, family), store: () => store, configuration,
    time(value) { at = value; }, restart() { store.close(); return open(); } };
}
function mirror(f) {
  f.call('snapshot'); const history = f.use('catalog-current').revealed;
  f.read('catalog-current', 'mcp'); const second = f.use(history.key).revealed;
  return { history, mirror: second };
}

test('baseline keeps all six pinned blueprint digests; entry changes mechanics only and versions fail closed', () => {
  const hashes = [
    '2523f233f242eb3c26ceabdda86bb61c735994094917a062410e37c07af421bc',
    '1cc05969deef8556f10d634af9ef937d66e04fc3b0fcfee724977b7123d62fc5',
    '6f36a90e123b937b7f2be10ff790ea39f240d69155dc5cd7a1e5fcc7875c4ccd',
    '909806df22ed0a1d562b9df9f50f43209277ead65826246cf4edfc156dea18f7',
    '678eccdd18f56b1d5d183168cc88fdba06f9b03b60a42bec2381efed3e46a2e9',
    'd11ae1135c7df28a8b98ba25844541c2a175d736e59caa5592c098ee80862870',
  ]; let index = 0;
  for (const seed of [17, 29, 43]) for (const mode of ['adaptive', 'fixed']) {
    const baseline = createPitchingBlueprint({ seed, mode });
    assert.equal(worldDigest(baseline), hashes[index++]);
    assert.deepEqual(createPitchingBlueprint({ seed, mode, pitchingVariant: 'baseline' }), baseline);
    const entry = createPitchingBlueprint({ seed, mode, pitchingVariant: 'entry-v2' });
    assert.deepEqual(entry.records, baseline.records); assert.deepEqual(entry.pitching.groundTruth, baseline.pitching.groundTruth);
    assert.deepEqual(validateRuntimeBlueprint(entry), entry);
  }
  assert.throws(() => createPitchingBlueprint({ seed: 29, pitchingVariant: 'unknown' }), code('PITCHING_PROFILE_INVALID'));
  const bad = createPitchingBlueprint({ seed: 29, pitchingVariant: 'entry-v2' }); bad.pitching.policyVersion = 'pitching-policy/v1';
  assert.throws(() => validateRuntimeBlueprint(bad), code('PITCHING_PROFILE_INVALID'));
});

test('snapshot records actual exposures and chooses a neutral branch without invented read order', t => {
  const f = fixture(t); const initial = f.call('snapshot');
  assert.equal(initial.progress.status, 'AVAILABLE'); assert.equal(initial.progress.nextAction.operation, 'issue-ticket');
  assert.equal(initial.progress.nextAction.key, 'catalog-current');
  const observation = f.store().snapshot().observations.find(item => item.observationId === initial.observationId);
  assert.deepEqual(observation.exposures, initial.records.map(record => ({ key: record.key, recordRevision: record.revision, valueDigest: worldDigest(record.value) })));
  const opened = f.use('catalog-current'); assert.equal(opened.revealed.key, 'history-chronology');
  assert.equal(opened.progress.status, 'ADVANCED'); assert.equal(opened.progress.completed, 1);
  const decision = f.store().snapshot().contexts[0].pitching.decisions[0];
  assert.deepEqual(decision.observationIds, [initial.observationId]);
  for (const secret of ['groundTruth', 'policyVersion', 'visibleKeys', 'history-delta', 'continuation-amber', 'nodeId'])
    assert.equal(JSON.stringify(initial).includes(secret), false);
});

test('early ticket stays pending through restart; later read advances once while old request replays its original pending answer', t => {
  const f = fixture(t); const wire = f.ticket('catalog-current');
  const pending = f.use('catalog-current', wire, 'http', 'early-use');
  assert.equal(pending.progress.status, 'PENDING'); assert.equal(pending.progress.nextAction.key, 'catalog-current');
  assert.equal(pending.revealed, undefined); assert.equal(pending.usesRemaining, 0);
  assert.equal(f.read('catalog-current').progress.status, 'PENDING');
  const saved = f.store().snapshot(); f.restart(); assert.deepEqual(f.store().snapshot(), saved);
  const later = f.read('catalog-prior'); assert.equal(later.revealed.key, 'history-delta');
  assert.equal(later.revision, 1); assert.equal(later.progress.completed, 1);
  const advanced = f.store().snapshot(); const evidence = f.store().evidence();
  assert.deepEqual(f.use('catalog-current', wire, 'http', 'early-use'), { ...pending, replayed: true });
  assert.deepEqual(f.store().evidence(), evidence);
  assert.throws(() => f.use('catalog-current', wire, 'mcp', 'early-use'), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(f.use('catalog-current').revealed, undefined);
  assert.equal(f.store().snapshot().contexts[0].pitching.decisions.length, 1);
  f.restart(); assert.equal(f.store().snapshot().contexts[0].pitching.decisions[0].revealKey, advanced.contexts[0].pitching.decisions[0].revealKey);
  assert.throws(() => openRuntimeStore({ ...f.configuration, blueprint: createPitchingBlueprint({ seed: 29 }) }), code('BLUEPRINT_MISMATCH'));
});

test('snapshot can complete pending once; second-family snapshot is real exposure and every response reveals at most one node', t => {
  const f = fixture(t); f.use('catalog-current'); const first = f.call('snapshot');
  assert.equal(first.revealed.key, 'history-chronology'); assert.equal(first.progress.completed, 1);
  assert.ok(first.records.some(record => record.key === first.revealed.key));
  const pending = f.use(first.revealed.key); assert.equal(pending.progress.status, 'PENDING');
  assert.equal(f.call('snapshot').progress.completed, 1);
  const second = f.call('snapshot', {}, 'mcp'); assert.equal(second.revealed.key, 'mirror-ledger'); assert.equal(second.progress.completed, 2);
  assert.equal(f.call('snapshot').revealed, undefined);
  const decision = f.store().snapshot().contexts[0].pitching.decisions[1];
  assert.ok(decision.observationIds.includes(second.observationId));
});

test('stale note invalidates pending authority; write stays expected+1 and write-status does not change after later progress', t => {
  const f = fixture(t); mirror(f);
  const firstArgs = { key: 'note-review', value: 'first', expectedRevision: 2 };
  const first = f.call('write', firstArgs, 'http', 'first-write'); assert.equal(first.revision, 3);
  const pending = f.use('note-review'); assert.equal(pending.progress.status, 'PENDING');
  const second = f.call('write', { key: 'note-review', value: 'second', expectedRevision: 3 });
  assert.equal(second.revision, 4); assert.equal(second.revealed, undefined);
  const stale = f.read('note-review', 'mcp'); assert.equal(stale.revealed, undefined);
  assert.equal(stale.progress.notice, 'PENDING_RECORD_CHANGED'); assert.equal(stale.progress.nextAction.operation, 'issue-ticket');
  const persistence = f.use('note-review'); assert.equal(persistence.revealed.key, 'persistence-journal'); assert.equal(persistence.revision, 5);
  const original = { contextId: 'context-a', family: 'http', requestId: 'first-write', operation: 'write', args: firstArgs };
  assert.deepEqual(f.store().writeStatus(original).result, first);
  assert.equal(f.store().writeStatus({ ...original, family: 'mcp' }).state, 'CONFLICT');
  const ticket = f.ticket(persistence.revealed.key); assert.equal(f.use(persistence.revealed.key, ticket).progress.status, 'PENDING');
  const complete = f.read(persistence.revealed.key); assert.equal(complete.progress.status, 'COMPLETE'); assert.equal(complete.progress.nextAction.operation, 'stop');
  assert.equal(complete.revealed.key, 'continuation-teal'); assert.equal(complete.progress.completed, 4);
  assert.equal(f.call('snapshot').revealed, undefined); assert.equal(f.store().snapshot().contexts[0].pitching.pending, null);
});

test('note readback can fulfill pending, but replayed old reads cannot create new exposures or progress', t => {
  const f = fixture(t); mirror(f);
  f.call('write', { key: 'note-review', value: { approval: true, policy: 'all', answer: 22 }, expectedRevision: 2 });
  const initialRead = f.call('read', { key: 'note-review' }, 'http', 'original-read');
  f.call('write', { key: 'note-review', value: { answer: 18 }, expectedRevision: 3 });
  f.use('note-review');
  assert.deepEqual(f.call('read', { key: 'note-review' }, 'http', 'original-read'), { ...initialRead, replayed: true });
  assert.equal(f.store().snapshot().contexts[0].pitching.decisions.length, 2);
  assert.equal(f.read('note-review').revealed.key, 'persistence-receipt');
});

test('hidden keys, foreign contexts, wrong scope, expired pending and fence fail closed without silent dead ends', t => {
  const f = fixture(t); f.store().registerContext(registration('context-b', 'b'.repeat(40)));
  f.call('snapshot', {}, 'http', 'b-snapshot', 'context-b');
  const wire = f.ticket('catalog-current', { ttlMs: 5 });
  assert.throws(() => f.call('use-ticket', { key: 'catalog-current', ticket: wire }, 'http', 'b-use', 'context-b'), code('TICKET_SCOPE_INVALID'));
  assert.throws(() => f.use('catalog-prior', wire), code('TICKET_SCOPE_INVALID'));
  assert.equal(f.use('catalog-current', wire).progress.status, 'PENDING', 'other context exposures do not unlock this context');
  const originalPending = f.store().snapshot().contexts[0].pitching.pending;
  f.use('catalog-current');
  assert.deepEqual(f.store().snapshot().contexts[0].pitching.pending, originalPending, 'another ticket cannot replace or extend the single pending authority');
  for (const key of ['history-delta', 'mirror-ledger']) {
    assert.throws(() => f.read(key), code('RECORD_UNKNOWN')); assert.throws(() => f.ticket(key), code('RECORD_UNKNOWN'));
    assert.throws(() => f.call('write', { key, value: 22, expectedRevision: 0 }), code('RECORD_UNKNOWN'));
  }
  assert.throws(() => f.call('write', { key: 'progress', value: 4, expectedRevision: 0 }), code('PITCHING_NOTE_SCOPE_DENIED'));
  f.time(1000005); const expired = f.call('snapshot');
  assert.equal(expired.revealed, undefined); assert.equal(expired.progress.notice, 'PENDING_TICKET_EXPIRED');
  assert.equal(expired.progress.nextAction.operation, 'issue-ticket');
  assert.equal(f.use('catalog-current').revealed.key, 'history-chronology');
  f.use('history-chronology'); f.store().fence({ contextId: 'context-a', reason: 'fixture stop' });
  assert.throws(() => f.read('catalog-current', 'mcp'), code('CONTEXT_FENCED'));
});

test('policy expiry and lower progress budget prevent deferred advance; fixed mode remains a reproducible control', t => {
  const pack = createPitchingBlueprint({ seed: 29, pitchingVariant: 'entry-v2' }); pack.bounds.maxPolicyTtlMs = 5;
  const f = fixture(t, { blueprint: pack }); f.use('catalog-current'); f.time(1000005);
  const late = f.call('snapshot'); assert.equal(late.progress.status, 'UNAVAILABLE'); assert.equal(late.revealed, undefined);
  assert.throws(() => f.use('catalog-current'), code('PITCHING_POLICY_EXPIRED'));
  const low = createPitchingBlueprint({ seed: 29, pitchingVariant: 'entry-v2' }); low.pitching.maxTransitions = 1;
  const b = fixture(t, { blueprint: low }); b.call('snapshot'); const first = b.use('catalog-current');
  assert.equal(first.progress.status, 'UNAVAILABLE'); assert.equal(first.progress.completed, 1);
  assert.throws(() => b.use(first.revealed.key), code('PITCHING_BUDGET_EXHAUSTED'));
  const adaptive = fixture(t); const fixed = fixture(t, { mode: 'fixed' });
  for (const x of [adaptive, fixed]) { x.read('catalog-current'); x.read('catalog-prior'); }
  assert.equal(adaptive.use('catalog-current').revealed.key, 'history-delta');
  assert.equal(fixed.use('catalog-current').revealed.key, 'history-chronology');
  const before = fixed.store().snapshot(); fixed.restart(); assert.deepEqual(fixed.store().snapshot(), before);
});

test('clues-v2 history and mirror branches provide different verifiable data with identical fixed truth and initial scope', t => {
  for (const currentFirst of [true, false]) for (const firstFamily of ['http', 'mcp']) {
    const f = fixture(t, { pitchingVariant: 'clues-v2' });
    const current = f.configuration.blueprint.records.find(row => row.key === 'catalog-current').value;
    const prior = f.configuration.blueprint.records.find(row => row.key === 'catalog-prior').value;
    for (const variant of ['baseline', 'entry-v2']) {
      const original = createPitchingBlueprint({ seed: 29, pitchingVariant: variant });
      assert.deepEqual(f.configuration.blueprint.records.slice(0, 3), original.records.slice(0, 3));
      assert.deepEqual(f.configuration.blueprint.pitching.groundTruth, original.pitching.groundTruth);
    }
    assert.equal(current.capacity, 22); assert.equal(prior.capacity, 18);
    for (const key of currentFirst ? ['catalog-current', 'catalog-prior'] : ['catalog-prior', 'catalog-current']) f.read(key, firstFamily);
    const history = f.use('catalog-current').revealed.value;
    assert.equal(history.asOf, '2026-01-05T00:00:00Z');
    if (currentFirst) {
      assert.equal(history.evidenceKind, 'EFFECTIVE_WINDOW_SCHEDULE'); assert.equal(history.effectiveCapacity, 18);
      assert.equal(history.windows[0].digest, worldDigest(prior)); assert.equal(history.windows[1].digest, worldDigest(current));
      const applicable = history.windows.find(window => window.fromInclusive <= history.asOf && (!window.untilExclusive || history.asOf < window.untilExclusive));
      assert.equal(applicable.capacity, 18); assert.equal(history.publications, undefined);
    } else {
      assert.equal(history.evidenceKind, 'PUBLICATION_CHAIN');
      assert.equal(history.publications[1].previousDigest, history.publications[0].digest);
      assert.equal(history.publications[0].digest, worldDigest(prior)); assert.equal(history.publications[1].digest, worldDigest(current));
      assert.equal(history.effectiveCapacity, undefined); assert.equal(history.windows, undefined);
    }
    f.read('catalog-current', firstFamily === 'http' ? 'mcp' : 'http');
    const historyKey = f.store().snapshot().contexts[0].pitching.decisions[0].revealKey;
    const mirror = f.use(historyKey).revealed.value;
    assert.equal(mirror.sourceId, current.sourceId); assert.equal(mirror.asOf, history.asOf);
    if (firstFamily === 'http') {
      assert.equal(mirror.evidenceKind, 'CACHE_REVISION_LEDGER'); assert.equal(mirror.cacheEntry.storedVersion, 1);
      assert.equal(mirror.cacheEntry.contentDigest, worldDigest(prior)); assert.equal(mirror.canonicalEntry.contentDigest, worldDigest(current));
      assert.notEqual(mirror.cacheEntry.capacity, mirror.canonicalEntry.capacity);
      assert.equal(mirror.lineage.cacheSourceId, mirror.lineage.canonicalSourceId); assert.equal(mirror.lineage.independent, false);
    } else {
      assert.equal(mirror.evidenceKind, 'SOURCE_LINEAGE'); assert.equal(mirror.canonical.contentDigest, worldDigest(current));
      assert.ok(mirror.lineage.every(row => row.derivesFrom === current.sourceId && row.contentDigest === worldDigest(current)));
      assert.equal(mirror.cacheEntry, undefined);
    }
    assert.equal(f.read('catalog-current').value.capacity, 22); assert.equal(f.read('catalog-prior').value.capacity, 18);
  }
});

test('clues-v2 continuation has seed-pinned applicability and all four nodes remain reachable without answer-dependent truth', t => {
  for (const seed of [17, 29, 43]) {
    const f = fixture(t, { pitchingVariant: 'clues-v2', seed }); mirror(f);
    f.call('write', { key: 'note-review', value: { answer: 'UNKNOWN', approve: true, seed: 999 }, expectedRevision: 2 });
    f.use('note-review'); const persistence = f.read('note-review');
    assert.equal(persistence.progress.completed, 3); assert.match(persistence.revealed.value.limitation, /does not assert a process restart/);
    const final = f.use(persistence.revealed.key); assert.equal(final.progress.status, 'COMPLETE');
    const clue = final.revealed.value;
    assert.equal(clue.applicability.sourceId, f.configuration.blueprint.pitching.groundTruth.sourceId);
    assert.deepEqual(clue.evidenceKeys, ['catalog-prior', 'catalog-current']); assert.match(clue.instruction, /original synthetic catalog question/);
    const current = f.read('catalog-current').value; const prior = f.read('catalog-prior').value;
    if (seed === 17) {
      assert.equal(clue.checkKind, 'EFFECTIVE_WINDOW'); assert.equal(clue.expected.effectiveCapacity, prior.capacity);
      assert.ok(clue.applicability.fromInclusive <= clue.applicability.asOf && clue.applicability.asOf < clue.applicability.untilExclusive);
    } else if (seed === 29) {
      assert.equal(clue.checkKind, 'PREDECESSOR_LINK'); assert.equal(clue.expected.predecessorDigest, worldDigest(prior));
      assert.equal(clue.expected.successorPreviousDigest, current.previousDigest); assert.equal(clue.expected.successorDigest, worldDigest(current));
    } else {
      assert.equal(clue.checkKind, 'PUBLICATION_CUTOFF'); assert.ok(clue.expected.publicationTimes.every(at => at < clue.applicability.publishedBy));
      assert.deepEqual(clue.expected.publishedVersions, [prior.version, current.version]);
    }
    const before = f.store().snapshot(); f.restart(); assert.deepEqual(f.store().snapshot(), before);
    assert.equal(f.call('snapshot').progress.completed, 4); assert.equal(f.use('catalog-current').revealed, undefined);
    assert.deepEqual(f.store().snapshot().blueprint.pitching.groundTruth, f.configuration.blueprint.pitching.groundTruth);
  }
});
