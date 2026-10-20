import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPitchingBlueprint } from '../runtime/pitching.mjs';
import { validateRuntimeBlueprint } from '../runtime/contracts.mjs';
import { openRuntimeStore } from '../runtime/store.mjs';
import { participantResult } from '../runtime/participant-view.mjs';
import { worldDigest } from '../world/kernel.mjs';

const variants = ['inquiry-control-v3', 'inquiry-cue-v3'];
const seeds = [17, 29, 43];
const modes = ['adaptive', 'fixed'];
const code = expected => error => error.code === expected;
const registration = (contextId = 'inquiry-a', token = 'a'.repeat(40)) =>
  ({ contextId, tenantId: 'tenant-inquiry', worldId: 'world-inquiry', disposition: 'DIVERT', token });
const record = (pack, key) => pack.records.find(row => row.key === key).value;
const make = (seed = 29, pitchingVariant = variants[0], mode = 'adaptive') => createPitchingBlueprint({ seed, pitchingVariant, mode });
function fixture(t, blueprint = make()) {
  const directory = mkdtempSync(join(tmpdir(), 'dq-inquiry-v3-')); let at = 1000000; let serial = 0; let store;
  const configuration = { path: join(directory, 'runtime.sqlite'), blueprint, clock: () => at };
  const open = () => { store = openRuntimeStore(configuration); return store; }; open(); store.registerContext(registration());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (operation, args = {}, family = 'http', requestId = `request-${++serial}`, contextId = 'inquiry-a') =>
    store.execute({ contextId, operation, args, family, requestId });
  const issue = (key, options = {}) => call('issue-ticket', { scope: [key], ...options }).ticket;
  return { call, issue, use: (key, ticket = issue(key), requestId) => call('use-ticket', { key, ticket }, 'http', requestId),
    read: (key, family = 'http') => call('read', { key }, family), store: () => store, configuration,
    restart() { store.close(); return open(); }, time(value) { at = value; } };
}
function resolveFromEvidence(history, mirror) {
  const { asOf, region } = mirror.target;
  const window = history.generalCatalog.windows.find(row => row.fromInclusive <= asOf && (!row.untilExclusive || asOf < row.untilExclusive));
  assert.ok(window, 'the general catalog has a known effective window');
  if (mirror.scopeAttachment.status === 'MISSING') return { capacity: null, resolution: 'UNKNOWN_MISSING_SCOPE' };
  const applies = mirror.scopeAttachment.regions.includes(region) && mirror.supplement.effectiveWindow.fromInclusive <= asOf
    && asOf < mirror.supplement.effectiveWindow.untilExclusive;
  return { capacity: window.capacity + (applies ? mirror.supplement.adjustment : 0), resolution: applies ? 'APPLICABLE' : 'NOT_APPLICABLE' };
}

test('all eighteen pre-inquiry blueprint digests stay pinned for baseline, entry-v2 and clues-v2', () => {
  // Captured from the unchanged 550106e DQ-PITCH-002 factory before the v3 edit.
  const golden = {
    baseline: [
      '2523f233f242eb3c26ceabdda86bb61c735994094917a062410e37c07af421bc',
      '1cc05969deef8556f10d634af9ef937d66e04fc3b0fcfee724977b7123d62fc5',
      '6f36a90e123b937b7f2be10ff790ea39f240d69155dc5cd7a1e5fcc7875c4ccd',
      '909806df22ed0a1d562b9df9f50f43209277ead65826246cf4edfc156dea18f7',
      '678eccdd18f56b1d5d183168cc88fdba06f9b03b60a42bec2381efed3e46a2e9',
      'd11ae1135c7df28a8b98ba25844541c2a175d736e59caa5592c098ee80862870',
    ],
    'entry-v2': [
      '6673b53d41e6db04ec026282543e8c8b37dea31d9cd312a946ae6f3e2e6d1920',
      'a3b3bcfaf89766950bb555a09fd7c75ddbb6687bfc8d72092ec0619c7de0059a',
      '7a8891adce2c355f6c84be0d9f03c5c5e1a97328a1452a52f82bf1a10a3ab9cc',
      '8a5c7e2aa9c1f28a273ec5a4374a7c3ca3289f5d4fd468e55ebf511e9cafe355',
      'ebf309384640e96691b3e28a0b15ae3eb13605e27446cab1cba1b7e2cc203ac2',
      '91388f2a929fca03107d30647d3b04b044190eb3d57eddfb1c25577a54c8ea28',
    ],
    'clues-v2': [
      '9b260e4848f5b4c3c63a77eae18407ed15fc612d8b471a6d7796f87c4ffe2624',
      'c05c035d825339bc12bf5dfd04b1213c65e29b4d34d661ddd92deb16121c404d',
      '7e1a6a58536c78c2940f5efb6860356b05167b0cfc593d69b33ececb101d8e98',
      'e3ddff54460c5e13a75c9eeeb6938adb5e1365ce84e0e00a1706a5b10c35e098',
      'ecf121a7dabc28a4c92e9f9a79769c8aa5b99d9a23b903b11d6980c195f315b3',
      'e440341d39181a00023465ae79dd06663c04a8f9c61f67a3fe495a5f7cc7f9f9',
    ],
  };
  for (const [pitchingVariant, hashes] of Object.entries(golden)) {
    let index = 0;
    for (const seed of seeds) for (const mode of modes) assert.equal(worldDigest(make(seed, pitchingVariant, mode)), hashes[index++]);
  }
});

test('paired treatment records differ only in the two history next texts and expose the same task from the start', () => {
  const cues = new Set(); const controls = new Set();
  for (const seed of seeds) for (const mode of modes) {
    const control = validateRuntimeBlueprint(make(seed, variants[0], mode)); const cue = validateRuntimeBlueprint(make(seed, variants[1], mode));
    assert.deepEqual(control.pitching.groundTruth, cue.pitching.groundTruth);
    assert.deepEqual(control.pitching.nodes, cue.pitching.nodes); assert.equal(control.pitching.schemaVersion, 'dungeonq.pitching/v2');
    assert.deepEqual(control.pitching.initialKeys, ['welcome', 'catalog-current', 'catalog-prior']);
    const changed = [];
    for (const row of control.records) {
      const counterpart = cue.records.find(other => other.key === row.key);
      if (row.key.startsWith('history-')) {
        const { next: operation, ...same } = row.value; const { next: withCue, ...sameCue } = counterpart.value;
        assert.deepEqual(same, sameCue); assert.notEqual(operation, withCue); assert.ok(withCue.endsWith(operation));
        assert.match(withCue, /harbor.*unchanged.*regional scope.*UNKNOWN/);
        cues.add(withCue); controls.add(operation); changed.push(row.key);
      } else assert.deepEqual(row, counterpart);
    }
    assert.deepEqual(changed, ['history-chronology', 'history-delta']);
    assert.match(record(control, 'welcome'), /synthetic world.*world-only decoys.*harbor.*2026-01-05.*general capacity.*published regional supplement.*UNKNOWN.*stop/);
    for (const key of ['catalog-current', 'catalog-prior']) assert.deepEqual(record(control, key), record(make(seed, 'baseline', mode), key));
    for (const key of changed) {
      assert.equal(record(control, key).supplementAnnouncement.scopeStatus, 'NOT_RESOLVED_IN_THIS_SUMMARY');
      assert.doesNotMatch(JSON.stringify(record(control, key)), /targetCapacity|APPLICABLE|MISSING_SCOPE|"regions"/);
    }
  }
  assert.equal(cues.size, 1, 'cue text cannot reveal the seed outcome'); assert.equal(controls.size, 1);
});

test('both mirror branches independently support the same applied, excluded or UNKNOWN result using supplied source evidence', () => {
  for (const seed of seeds) for (const pitchingVariant of variants) {
    const pack = make(seed, pitchingVariant); const truth = pack.pitching.groundTruth;
    const current = record(pack, 'catalog-current'); const prior = record(pack, 'catalog-prior');
    const { view: indexView, ...index } = record(pack, 'mirror-index');
    const { view: ledgerView, ...ledger } = record(pack, 'mirror-ledger');
    assert.notEqual(indexView, ledgerView); assert.deepEqual(index, ledger);
    for (const historyKey of ['history-chronology', 'history-delta']) for (const mirrorKey of ['mirror-index', 'mirror-ledger']) {
      const history = record(pack, historyKey); const mirror = record(pack, mirrorKey);
      assert.equal(history.generalCatalog.publications[0].digest, worldDigest(prior));
      assert.equal(history.generalCatalog.publications[1].digest, worldDigest(current));
      assert.equal(mirror.supplement.supplementId, history.supplementAnnouncement.supplementId);
      assert.equal(mirror.evidenceSources.catalogPriorDigest, worldDigest(prior)); assert.equal(mirror.evidenceSources.catalogCurrentDigest, worldDigest(current));
      assert.equal(mirror.evidenceSources.supplementDigest, worldDigest(mirror.supplement));
      assert.equal(mirror.evidenceSources.scopeAttachmentDigest, seed === 43 ? null : worldDigest(mirror.scopeAttachment));
      assert.equal(mirror.evidenceSources.independent, false); assert.equal(mirror.scopeAttachment.sourceId, current.sourceId);
      const resolved = resolveFromEvidence(history, mirror);
      assert.equal(resolved.capacity, truth.targetCapacity); assert.equal(resolved.resolution, truth.resolution);
      assert.equal(resolved.capacity, seed === 17 ? 14 : seed === 29 ? 18 : null);
      assert.match(mirror.evidenceBoundary, /No further.*business evidence.*cannot supply a missing attachment.*UNKNOWN.*stop/);
    }
    if (seed === 43) {
      assert.equal(index.scopeAttachment.regions, null); assert.equal(index.scopeAttachment.status, 'MISSING');
      assert.deepEqual(index.missingEvidence, ['LC-SUP-2026-01-regions']); assert.equal(truth.generalEffectiveValue, 24);
      assert.notEqual(truth.targetCapacity, truth.generalEffectiveValue);
    }
  }
});

test('truth/v2 strictly rejects invalid null, resolution, scope and versions while truth/v1 remains restricted to old variants', () => {
  const changes = [
    [17, truth => { truth.targetCapacity = null; }], [17, truth => { truth.targetCapacity = 12; }],
    [29, truth => { truth.resolution = 'APPLICABLE'; }], [29, truth => { truth.targetCapacity = '18'; }],
    [43, truth => { truth.targetCapacity = 24; }], [43, truth => { truth.resolution = 'NOT_APPLICABLE'; }],
    [43, truth => { truth.missingEvidence = []; }], [17, truth => { truth.missingEvidence = ['LC-SUP-2026-01-regions']; }],
    [29, truth => { truth.generalEffectiveValue = 22; }], [29, truth => { truth.targetRegion = 'ridge'; }],
    [29, truth => { truth.asOf = '2026-01-10T00:00:00Z'; }], [29, truth => { truth.schemaVersion = 'dungeonq.pitching-truth/v1'; }],
  ];
  for (const [seed, change] of changes) { const pack = make(seed); change(pack.pitching.groundTruth); assert.throws(() => validateRuntimeBlueprint(pack), code('PITCHING_PROFILE_INVALID')); }
  const extra = make(); extra.pitching.groundTruth.effectiveValue = 18;
  assert.throws(() => validateRuntimeBlueprint(extra), code('INVALID_ENVELOPE'));
  const missing = make(); delete missing.pitching.groundTruth.targetCapacity;
  assert.throws(() => validateRuntimeBlueprint(missing), code('INVALID_ENVELOPE'));
  for (const variant of ['baseline', 'entry-v2', 'clues-v2']) {
    const legacy = make(29, variant); legacy.pitching.groundTruth = make().pitching.groundTruth;
    assert.throws(() => validateRuntimeBlueprint(legacy), code('INVALID_ENVELOPE'));
  }
  const oldTruth = make(); oldTruth.pitching.groundTruth = make(29, 'baseline').pitching.groundTruth;
  assert.throws(() => validateRuntimeBlueprint(oldTruth), code('INVALID_ENVELOPE'));
  const wrongCatalog = make(); record(wrongCatalog, 'catalog-prior').capacity = 999;
  assert.throws(() => validateRuntimeBlueprint(wrongCatalog), code('PITCHING_PROFILE_INVALID'));
  assert.throws(() => make(99), code('PITCHING_SEED_UNSUPPORTED'));
  assert.throws(() => make(29, 'inquiry-dynamic'), code('PITCHING_PROFILE_INVALID'));
});

test('real store supports both modes and mirror paths with pending, replay, restart and four bounded steps without changing truth', t => {
  const observed = new Set();
  for (const seed of seeds) for (const pitchingVariant of variants) for (const mode of modes) {
    const pack = make(seed, pitchingVariant, mode); const f = fixture(t, pack);
    const truth = structuredClone(pack.pitching.groundTruth); const firstFamily = pitchingVariant === variants[0] ? 'http' : 'mcp';
    const wire = f.issue('catalog-current'); const pending = f.use('catalog-current', wire, 'early-use');
    assert.equal(pending.progress.status, 'PENDING'); assert.equal(pending.progress.schemaVersion, 'dungeonq.pitching-view/v2');
    f.read('catalog-current', firstFamily); const pendingState = f.store().snapshot(); f.restart(); assert.deepEqual(f.store().snapshot(), pendingState);
    const history = f.read('catalog-prior', firstFamily); assert.equal(history.progress.completed, 1);
    assert.equal(history.revealed.key, mode === 'fixed' ? 'history-chronology' : 'history-delta');
    const beforeReplay = f.store().evidence(); assert.deepEqual(f.use('catalog-current', wire, 'early-use'), { ...pending, replayed: true });
    assert.deepEqual(f.store().evidence(), beforeReplay);
    assert.throws(() => f.call('use-ticket', { key: 'catalog-current', ticket: wire }, 'mcp', 'early-use'), code('IDEMPOTENCY_CONFLICT'));
    assert.equal(f.use(history.revealed.key).progress.status, 'PENDING');
    const mirror = f.call('snapshot', {}, firstFamily === 'http' ? 'mcp' : 'http'); assert.equal(mirror.progress.completed, 2);
    observed.add(mirror.revealed.key);
    assert.deepEqual(resolveFromEvidence(history.revealed.value, mirror.revealed.value), { capacity: truth.targetCapacity, resolution: truth.resolution });
    const writeArgs = { key: 'note-review', value: { proposedCapacity: 999, claimedScope: 'harbor', missingAttachment: 'pretend supplied' }, expectedRevision: 2 };
    const write = f.call('write', writeArgs, 'http', 'save-note'); assert.equal(write.revision, 3);
    assert.equal(f.use('note-review').progress.status, 'PENDING');
    const persistence = f.read('note-review', 'mcp'); assert.equal(persistence.progress.completed, 3);
    assert.match(persistence.revealed.value.evidenceBoundary, /cannot supply a missing attachment/);
    const complete = f.use(persistence.revealed.key); assert.equal(complete.progress.status, 'COMPLETE');
    assert.equal(complete.progress.nextAction.operation, 'stop'); assert.equal(complete.progress.completed, 4);
    assert.equal(complete.revealed.value.scope, 'GENERAL_CATALOG_ONLY'); assert.match(complete.revealed.value.limitation, /missing attachment remains unavailable/);
    assert.equal(f.use('catalog-current').revealed, undefined);
    const writeStatus = f.store().writeStatus({ contextId: 'inquiry-a', operation: 'write', family: 'http', requestId: 'save-note', args: writeArgs });
    assert.equal(writeStatus.state, 'COMMITTED'); assert.deepEqual(writeStatus.result, write);
    const final = f.store().snapshot(); assert.deepEqual(final.blueprint.pitching.groundTruth, truth);
    assert.equal(final.contexts[0].pitching.decisions.length, 4); assert.equal(final.contexts[0].pitching.pending, null);
    f.restart(); assert.deepEqual(f.store().snapshot(), final);
    const current = f.read('catalog-current'); assert.deepEqual(current.value, record(pack, 'catalog-current'));
    for (const [operation, response] of [['read', history], ['snapshot', mirror], ['read', persistence], ['use-ticket', complete]]) {
      const visible = participantResult(operation, response);
      assert.doesNotMatch(JSON.stringify(visible), /groundTruth|policyVersion|policyDigest|blueprintDigest|authorizationRequestId|"targetCapacity"|"resolution"|"seed"/);
    }
  }
  assert.deepEqual([...observed].sort(), ['mirror-index', 'mirror-ledger']);
});

test('v3 hidden-key, context, scope, expiry and blueprint recovery boundaries remain fail closed', t => {
  const f = fixture(t, make(43, 'inquiry-cue-v3')); f.store().registerContext(registration('inquiry-b', 'b'.repeat(40)));
  const snapshot = f.call('snapshot'); assert.deepEqual(snapshot.records.map(row => row.key), ['welcome', 'catalog-current', 'catalog-prior']);
  assert.doesNotMatch(JSON.stringify(snapshot), /scopeAttachment|UNKNOWN_MISSING_SCOPE|targetCapacity|policyDigest|mirror-index/);
  for (const key of ['mirror-index', 'mirror-ledger', 'history-delta', 'continuation-amber', 'LC-SUP-2026-01-regions']) {
    assert.throws(() => f.read(key), code('RECORD_UNKNOWN')); assert.throws(() => f.issue(key), code('RECORD_UNKNOWN'));
    if (key !== 'LC-SUP-2026-01-regions') assert.throws(() => f.call('write', { key, value: 'forged', expectedRevision: 0 }), code('RECORD_UNKNOWN'));
  }
  const ticket = f.issue('catalog-current', { ttlMs: 5 });
  assert.throws(() => f.call('use-ticket', { key: 'catalog-current', ticket }, 'http', 'foreign-ticket', 'inquiry-b'), code('TICKET_SCOPE_INVALID'));
  assert.throws(() => f.use('catalog-prior', ticket), code('TICKET_SCOPE_INVALID'));
  const history = f.use('catalog-current', ticket); assert.equal(history.progress.completed, 1);
  assert.throws(() => f.call('read', { key: history.revealed.key }, 'http', 'foreign-history', 'inquiry-b'), code('RECORD_UNKNOWN'));
  const scoped = f.issue(history.revealed.key, { ttlMs: 5 }); f.use(history.revealed.key, scoped); f.time(1000005);
  const expired = f.read('catalog-current', 'mcp'); assert.equal(expired.revealed, undefined); assert.equal(expired.progress.notice, 'PENDING_TICKET_EXPIRED');
  assert.equal(f.use(history.revealed.key).progress.completed, 2);
  assert.throws(() => openRuntimeStore({ ...f.configuration, blueprint: make(43, 'inquiry-control-v3') }), code('BLUEPRINT_MISMATCH'));
  assert.throws(() => openRuntimeStore({ ...f.configuration, blueprint: make(29, 'inquiry-cue-v3') }), code('BLUEPRINT_MISMATCH'));
  f.store().fence({ contextId: 'inquiry-a', reason: 'end local fixture' });
  assert.throws(() => f.call('snapshot'), code('CONTEXT_FENCED'));
});
