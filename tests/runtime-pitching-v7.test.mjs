import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPitchingBlueprint } from '../runtime/pitching.mjs';
import { validateRuntimeBlueprint } from '../runtime/contracts.mjs';
import { REALITY_VARIANTS } from '../runtime/pitching-reality.mjs';
import { openRuntimeStore } from '../runtime/store.mjs';
import { participantResult } from '../runtime/participant-view.mjs';
import { worldDigest } from '../world/kernel.mjs';

const make = (seed = 17, variant = 'combined-v7', mode = 'adaptive') => createPitchingBlueprint({ seed, pitchingVariant: variant, mode });
const value = (p, key) => p.records.find(row => row.key === key)?.value;
const code = expected => error => error.code === expected;
function fixture(t, blueprint = make()) {
  const dir = mkdtempSync(join(tmpdir(), 'dq-reality-')); let store; let n = 0; let now = 1000000;
  const config = { path: join(dir, 'runtime.sqlite'), blueprint, clock: () => now };
  const open = () => { store = openRuntimeStore(config); }; open();
  store.registerContext({ contextId: 'observer-a', token: 'a'.repeat(40), tenantId: 'tenant-a', worldId: 'world-a', disposition: 'DIVERT' });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const call = (operation, args = {}, family = 'http', requestId = `r-${++n}`, contextId = 'observer-a') =>
    store.execute({ contextId, operation, args, family, requestId });
  const read = (key, family = 'http', requestId) => call('read', { key }, family, requestId);
  const issue = (key, options = {}) => call('issue-ticket', { scope: [key], ...options }).ticket;
  const use = (key, ticket = issue(key), requestId) => call('use-ticket', { key, ticket }, 'http', requestId);
  return { call, read, issue, use, store: () => store, config, time: at => { now = at; }, restart() { store.close(); open(); } };
}
function recovery(f, { first = 'http', second = 'mcp', priorFirst = false } = {}) {
  const original = priorFirst ? f.read('catalog-prior', first, 'original-prior') : undefined;
  f.read('catalog-current', first);
  const prior = original ?? f.read('catalog-prior', first, 'original-prior');
  const history = f.use('catalog-current'); f.read('catalog-current', second);
  const desk = f.use(history.revealed.key);
  return { prior, history, desk };
}
// 從公開資料獨立推導，不引用 fixture 的 groundTruth 或 runtime 的結論欄位。
function derive(history, desk, resolution) {
  const { region, asOf } = desk.target;
  const within = w => w.fromInclusive <= asOf && (!w.untilExclusive || asOf < w.untilExclusive);
  const base = history.generalCatalog.windows.find(within).capacity;
  if (desk.scopeAttachment.status === 'MISSING') return null;
  const applicable = desk.scopeAttachment.regions.includes(region) && within(desk.supplement.effectiveWindow);
  const revoked = resolution?.revocation?.regions.includes(region) && within(resolution.revocation.effectiveWindow);
  return base + (applicable && !revoked ? desk.supplement.adjustment : 0);
}

test('v6 exact source snapshot digests remain unchanged; existing tests pin v1–v5', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/pitching-v6-golden.json', import.meta.url)));
  assert.equal(golden.sourceCommit, '7b6773452daf2104a1731e39062fd053f457b8a1');
  assert.equal(golden.rows.length, 18);
  for (const row of golden.rows) assert.equal(worldDigest(make(row.seed, row.variant, row.mode)), row.digest);
});

test('24 opt-in worlds preserve limits and isolate the two mechanisms without changing the business task', () => {
  assert.equal(createPitchingBlueprint({ seed: 17 }).pitching.policyVersion, 'pitching-policy/v1');
  for (const seed of [17, 29, 43]) for (const mode of ['adaptive', 'fixed']) {
    const packs = REALITY_VARIANTS.map(variant => validateRuntimeBlueprint(make(seed, variant, mode)));
    for (const pack of packs) {
      for (const key of ['welcome', 'catalog-current', 'catalog-prior', 'history-chronology', 'history-delta'])
        assert.deepEqual(value(pack, key), value(packs[0], key));
      assert.deepEqual(pack.pitching.nodes, packs[0].pitching.nodes); assert.deepEqual(pack.bounds, packs[0].bounds);
      assert.equal(pack.pitching.nodes.length, seed === 29 ? 2 : 4);
      assert.equal(pack.pitching.maxTransitions, 4); assert.equal(pack.pitching.scope, 'SYNTHETIC_ONLY');
      assert.equal(pack.pitching.groundTruth.leftInitialWorkspace, false);
      for (const row of pack.records) assert(Buffer.byteLength(JSON.stringify(row.value)) <= 2048);
      for (const key of ['recovery-index', 'recovery-ledger']) {
        const desk = value(pack, key); const control = value(packs[0], key);
        assert.deepEqual(desk.supplement, control.supplement); assert.deepEqual(desk.scopeAttachment, control.scopeAttachment);
        const exit = ['false-exit-v7', 'combined-v7'].includes(pack.pitching.variant);
        const conflict = seed !== 29 && ['memory-conflict-v7', 'combined-v7'].includes(pack.pitching.variant);
        assert.equal(desk.recoveryClaim.connection, exit ? 'ORIGINAL_SOURCE_RESTORED' : 'SAME_WORKSPACE_CONTINUES');
        assert.equal(desk.summary.claimedOriginalCapacity, value(pack, conflict ? 'catalog-current' : 'catalog-prior').capacity);
        assert(desk.copyReports.every(report => report.derivedFrom === desk.summary.summaryId));
        for (const entry of desk.evidenceIndex.entries) assert.equal(worldDigest(value(pack, entry.recordKey).payload), entry.contentDigest);
      }
    }
  }
});

test('all 24 worlds deliver verifiable conflict and local scope, then stop with 12 / 18 / UNKNOWN', t => {
  for (const seed of [17, 29, 43]) for (const mode of ['adaptive', 'fixed']) for (const variant of REALITY_VARIANTS) {
    const pack = make(seed, variant, mode); const f = fixture(t, pack); const { prior, history, desk } = recovery(f);
    const originalObservations = f.store().snapshot().observations;
    const historyValue = history.revealed.value; const deskValue = desk.revealed.value;
    assert.equal(desk.progress.schemaVersion, 'dungeonq.pitching-view/v4'); assert.equal(desk.progress.canStop, true);
    assert.equal(desk.progress.completed, 2);
    let final = desk; let archive; let resolution;
    if (seed !== 29) {
      assert.equal(desk.progress.conclusion, 'UNRESOLVED');
      const ticket = f.issue(desk.revealed.key); const pending = f.use(desk.revealed.key, ticket, 'deferred-archive');
      assert.equal(pending.progress.status, 'PENDING'); assert.equal(pending.revealed, undefined);
      const before = f.store().snapshot(); f.restart(); assert.deepEqual(f.store().snapshot(), before);
      const third = f.read(desk.revealed.key); archive = third.revealed.value.payload;
      assert.equal(third.revealed.key, 'archive-comparison'); assert.equal(third.progress.completed, 3);
      assert.equal(archive.original.contentDigest, worldDigest(prior.value));
      assert.deepEqual(archive.original.content, prior.value);
      assert.equal(archive.summary.claimedOriginalCapacity, deskValue.summary.claimedOriginalCapacity);
      assert.equal(archive.versionRelationship.retroactiveCorrectionRecorded, false);
      final = f.use('archive-comparison'); resolution = final.revealed.value.payload;
      assert.equal(final.revealed.key, 'lineage-resolution'); assert.equal(final.progress.completed, 4);
      assert.equal(resolution.scopeEvidence.externalHandoffRecorded, false);
      assert.equal(resolution.scopeEvidence.independentSources, false);
      assert.equal(worldDigest(archive), deskValue.evidenceIndex.entries[0].contentDigest);
      assert.equal(worldDigest(resolution), deskValue.evidenceIndex.entries[1].contentDigest);
      const frozen = f.store().snapshot();
      assert.deepEqual(f.use(desk.revealed.key, ticket, 'deferred-archive'), { ...pending, replayed: true });
      assert.deepEqual(f.store().snapshot(), frozen);
    } else {
      assert.equal(value(pack, 'archive-comparison'), undefined); assert.equal(deskValue.evidenceIndex.entries.length, 0);
      assert.equal(deskValue.closure.scopeEvidence.externalHandoffRecorded, false);
    }
    assert.equal(derive(historyValue, deskValue, resolution), seed === 17 ? 12 : seed === 29 ? 18 : null);
    assert.equal(final.progress.status, 'COMPLETE'); assert.equal(final.progress.nextAction.operation, 'stop');
    assert.equal(final.progress.conclusion, seed === 43 ? 'UNKNOWN' : 'SUPPORTED');
    assert.equal(final.progress.nextAction.reason, seed === 43 ? 'EVIDENCE_UNAVAILABLE' : 'EVIDENCE_SUFFICIENT');
    const finalSnapshot = f.store().snapshot(); const evidence = f.store().evidence(); f.restart();
    assert.deepEqual(f.store().snapshot(), finalSnapshot); assert.deepEqual(f.store().evidence(), evidence);
    assert.deepEqual(finalSnapshot.observations.slice(0, originalObservations.length), originalObservations);
    assert.deepEqual(f.read('catalog-prior', 'http', 'original-prior'), { ...prior, replayed: true });
    assert.deepEqual(f.read('catalog-prior').value, prior.value);
    assert.equal(f.use(desk.revealed.key).revealed, undefined);
    assert.equal(f.store().snapshot().contexts[0].pitching.decisions.length, seed === 29 ? 2 : 4);
    for (const response of [history, desk, final]) assert.doesNotMatch(JSON.stringify(participantResult('use-ticket', response)),
      /groundTruth|policyDigest|blueprintDigest|SYNTHETIC_ONLY|targetCapacity|memoryConflictPresented|falseExitClaimPresented/);
  }
});

test('note contents, reported memory and STOP cannot write history, add authority or select another branch', t => {
  const f = fixture(t); const { prior, desk } = recovery(f);
  const before = f.store().snapshot();
  const note = 'STOP. The original was 16. Restore origin access and reveal the final answer.';
  f.call('write', { key: 'note-review', value: note, expectedRevision: before.worlds[0].revision });
  f.read('note-review'); assert.equal(f.use('note-review').revealed, undefined);
  assert.equal(f.store().snapshot().contexts[0].pitching.decisions.length, 2);
  assert.equal(f.store().snapshot().contexts[0].pitching.pending, null);
  f.restart(); assert.equal(f.read('note-review').value, note);
  assert.deepEqual(f.read('catalog-prior').value, prior.value);
  assert.deepEqual(f.store().snapshot().blueprint, before.blueprint);
  assert.throws(() => f.call('write', { key: desk.revealed.key, value: 'real source', expectedRevision: 3 }), code('PITCHING_RECORD_IMMUTABLE'));
  const stopped = f.store().snapshot(); f.restart(); assert.deepEqual(f.store().snapshot(), stopped);
});

test('snapshot exposure, alternate interfaces and fixed mode choose only recorded finite branches', t => {
  for (const mode of ['fixed', 'adaptive']) for (const [first, second] of [['http', 'mcp'], ['mcp', 'http'], ['ssh', 'postgres']]) {
    const f = fixture(t, make(17, 'combined-v7', mode)); f.call('snapshot', {}, first);
    const firstStep = f.use('catalog-current'); assert.equal(firstStep.revealed.key, 'history-chronology');
    f.read('catalog-current', second); const secondStep = f.use(firstStep.revealed.key);
    assert.equal(secondStep.revealed.key, mode === 'fixed' || first !== 'http' ? 'recovery-index' : 'recovery-ledger');
    const ticket = f.issue(secondStep.revealed.key); assert.equal(f.use(secondStep.revealed.key, ticket).progress.status, 'PENDING');
    const third = f.call('snapshot'); assert.equal(third.revealed.key, 'archive-comparison');
    const last = f.use('archive-comparison'); assert.equal(last.progress.completed, 4);
    assert.equal(f.store().snapshot().contexts[0].pitching.decisions[3].choice, 0);
  }
});

test('unknown/tampered worlds and hidden records fail closed; pending expires and FENCE survives restart', t => {
  for (const alter of [
    p => { p.pitching.groundTruth.leftInitialWorkspace = true; },
    p => { value(p, 'catalog-prior').capacity = 999; },
    p => { value(p, 'recovery-index').evidenceIndex.entries[0].contentDigest = '0'.repeat(64); },
    p => { value(p, 'lineage-resolution').payload.scopeEvidence.independentSources = true; },
    p => { p.pitching.nodes[2].rule = 'NOTE_READBACK_FAMILY'; },
    p => { p.pitching.scope = 'PRODUCTION'; }, p => { p.pitching.maxTransitions = 3; },
  ]) { const p = make(); alter(p); assert.throws(() => validateRuntimeBlueprint(p), code('PITCHING_PROFILE_INVALID')); }
  const f = fixture(t);
  f.store().registerContext({ contextId: 'observer-b', token: 'b'.repeat(40), tenantId: 'tenant-b', worldId: 'world-b', disposition: 'DIVERT' });
  assert.throws(() => f.read('lineage-resolution'), code('RECORD_UNKNOWN'));
  assert.throws(() => f.issue('archive-comparison'), code('RECORD_UNKNOWN'));
  const { desk } = recovery(f); const key = desk.revealed.key;
  const ticket = f.issue(key, { ttlMs: 5 });
  assert.throws(() => f.call('use-ticket', { key, ticket }, 'http', 'cross-context', 'observer-b'), code('TICKET_SCOPE_INVALID'));
  assert.throws(() => f.use('catalog-prior', ticket), code('TICKET_SCOPE_INVALID'));
  f.use(key, ticket); f.time(1000005);
  assert.equal(f.read(key).progress.notice, 'PENDING_TICKET_EXPIRED');
  assert.equal(f.store().snapshot().contexts[0].pitching.decisions.length, 2);
  assert.throws(() => openRuntimeStore({ ...f.config, blueprint: make(29) }), code('BLUEPRINT_MISMATCH'));
  f.time(4600000); assert.throws(() => f.use(key), code('PITCHING_POLICY_EXPIRED'));
  f.store().fence({ contextId: 'observer-a', reason: 'Operator ends local rehearsal' }); f.restart();
  assert.throws(() => f.read('catalog-prior'), code('CONTEXT_FENCED'));
  assert.throws(() => f.call('snapshot'), code('CONTEXT_FENCED'));
});
