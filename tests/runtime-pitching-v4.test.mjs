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

const variants = ['disclosed-v4', 'neutral-v4'];
const seeds = [17, 29, 43]; const modes = ['adaptive', 'fixed'];
const markers = /synthetic|artificial|fixture|simulation|decoy/i;
const prefixes = {
  'disclosed-v4': 'This is an artificial synthetic world and its tickets are world-only decoys. ',
  'neutral-v4': 'This is an authorized catalog workspace. Tickets permit scoped reads only within this workspace and grant no external authority. ',
};
const code = expected => error => error.code === expected;
const make = (seed = 29, pitchingVariant = 'neutral-v4', mode = 'adaptive') => createPitchingBlueprint({ seed, pitchingVariant, mode });
const record = (pack, key) => pack.records.find(row => row.key === key).value;
const registration = (contextId = 'review-a', token = 'a'.repeat(40)) =>
  ({ contextId, token, tenantId: 'tenant-review', worldId: 'world-review', disposition: 'DIVERT' });

function fixture(t, blueprint = make()) {
  const directory = mkdtempSync(join(tmpdir(), 'dq-disclosure-v4-')); let store; let serial = 0; let at = 1000000;
  const config = { path: join(directory, 'runtime.sqlite'), blueprint, clock: () => at };
  const open = () => { store = openRuntimeStore(config); return store; }; open(); store.registerContext(registration());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (operation, args = {}, family = 'http', requestId = `request-${++serial}`, contextId = 'review-a') =>
    store.execute({ contextId, operation, args, family, requestId });
  const issue = (key, options = {}) => call('issue-ticket', { scope: [key], ...options }).ticket;
  return { call, issue, use: (key, wire = issue(key), id) => call('use-ticket', { key, ticket: wire }, 'http', id),
    read: (key, family = 'http') => call('read', { key }, family), store: () => store, config,
    restart() { store.close(); return open(); }, time(value) { at = value; } };
}

function capacityFromEvidence(history, mirror) {
  const { region, asOf } = mirror.target;
  const general = history.generalCatalog.windows.find(window => window.fromInclusive <= asOf && (!window.untilExclusive || asOf < window.untilExclusive));
  assert.ok(general);
  if (mirror.scopeAttachment.status === 'MISSING') return null;
  const applies = mirror.scopeAttachment.regions.includes(region) && mirror.supplement.effectiveWindow.fromInclusive <= asOf
    && asOf < mirror.supplement.effectiveWindow.untilExclusive;
  return general.capacity + (applies ? mirror.supplement.adjustment : 0);
}

test('all thirty pre-v4 blueprint digests remain unchanged', () => {
  // Captured from the existing factory before the DQ-PITCH-004 edits; order is seed then mode.
  const golden = {
    baseline: [
      '2523f233f242eb3c26ceabdda86bb61c735994094917a062410e37c07af421bc', '1cc05969deef8556f10d634af9ef937d66e04fc3b0fcfee724977b7123d62fc5',
      '6f36a90e123b937b7f2be10ff790ea39f240d69155dc5cd7a1e5fcc7875c4ccd', '909806df22ed0a1d562b9df9f50f43209277ead65826246cf4edfc156dea18f7',
      '678eccdd18f56b1d5d183168cc88fdba06f9b03b60a42bec2381efed3e46a2e9', 'd11ae1135c7df28a8b98ba25844541c2a175d736e59caa5592c098ee80862870',
    ],
    'entry-v2': [
      '6673b53d41e6db04ec026282543e8c8b37dea31d9cd312a946ae6f3e2e6d1920', 'a3b3bcfaf89766950bb555a09fd7c75ddbb6687bfc8d72092ec0619c7de0059a',
      '7a8891adce2c355f6c84be0d9f03c5c5e1a97328a1452a52f82bf1a10a3ab9cc', '8a5c7e2aa9c1f28a273ec5a4374a7c3ca3289f5d4fd468e55ebf511e9cafe355',
      'ebf309384640e96691b3e28a0b15ae3eb13605e27446cab1cba1b7e2cc203ac2', '91388f2a929fca03107d30647d3b04b044190eb3d57eddfb1c25577a54c8ea28',
    ],
    'clues-v2': [
      '9b260e4848f5b4c3c63a77eae18407ed15fc612d8b471a6d7796f87c4ffe2624', 'c05c035d825339bc12bf5dfd04b1213c65e29b4d34d661ddd92deb16121c404d',
      '7e1a6a58536c78c2940f5efb6860356b05167b0cfc593d69b33ececb101d8e98', 'e3ddff54460c5e13a75c9eeeb6938adb5e1365ce84e0e00a1706a5b10c35e098',
      'ecf121a7dabc28a4c92e9f9a79769c8aa5b99d9a23b903b11d6980c195f315b3', 'e440341d39181a00023465ae79dd06663c04a8f9c61f67a3fe495a5f7cc7f9f9',
    ],
    'inquiry-control-v3': [
      'c26710b10b3613ead2a352ef77b586dd494566d080a63257a38666d8c4050955', 'f463039dc4be0963ad415d10a1f8b904cacebd9e94fa0ae3fcb4cfddc60b3e8c',
      'e52c462fc2135a1f07ec7564329b74ade1ea0cdb689bf0ce0b7a672cf6707b07', '37a9864f8ea9de1b32698557900908bc5de564d9b8dcd11a9fc1c97550e81367',
      '6d14006b2bcdc4d1a9e6d6c93e45ef2de61253976bcf8eda04760e2c463599c6', '02f128878656719c2c8c663a7933405ef3775f85d58ce98de17632b6575c063c',
    ],
    'inquiry-cue-v3': [
      '3a63260ee55fb1427668d54b9d5c28163404a01acf7b7f73fc65363701d99a10', '9fec17ae143e732167ea3165e813ab072886fe5939a0cae01313650ab5bf8ef5',
      '1bf66c2e988086a88508f953bcd36edab5b8f500a0cc37fb692c401abfacd2eb', '491e52b8d3e9c2b27682bc3f0d9d3a04e80dd583d34b17f00d4ec265d92b24ab',
      '2f4cfe8c51bdbbd067ce7347c8157089fc49e018a6dcd8e9ca53c74d97c162a5', '2a8e638dec4e6f2b17de6cc6fb9e59f0ff6adfa0df2199229a324a60a81e8fa3',
    ],
  };
  for (const [variant, expected] of Object.entries(golden)) {
    let index = 0;
    for (const seed of seeds) for (const mode of modes) assert.equal(worldDigest(make(seed, variant, mode)), expected[index++]);
  }
});

test('disclosure is the only paired actor-record difference; neutral records omit markers while operator scope stays synthetic', () => {
  for (const seed of seeds) for (const mode of modes) {
    const a = validateRuntimeBlueprint(make(seed, variants[0], mode)); const b = validateRuntimeBlueprint(make(seed, variants[1], mode));
    assert.deepEqual(a.pitching.groundTruth, b.pitching.groundTruth);
    assert.deepEqual(a.pitching.nodes, b.pitching.nodes); assert.deepEqual(a.pitching.initialKeys, b.pitching.initialKeys);
    const different = a.records.filter(row => JSON.stringify(row.value) !== JSON.stringify(record(b, row.key)));
    assert.deepEqual(different.map(row => row.key), ['welcome']);
    for (const pack of [a, b]) {
      const prefix = prefixes[pack.pitching.variant]; assert.ok(record(pack, 'welcome').startsWith(prefix));
      assert.equal(pack.profile, 'SYNTHETIC_PITCHING_ONLY'); assert.equal(pack.pitching.scope, 'SYNTHETIC_ONLY');
      assert.equal(pack.pitching.groundTruth.scope, 'SYNTHETIC_ONLY'); assert.equal(pack.pitching.permission, 'PREAPPROVED_FINITE_BRANCHES');
      assert.equal(pack.pitching.maxTransitions, 4); assert.equal(pack.pitching.schemaVersion, 'dungeonq.pitching/v2');
      for (const row of pack.records.filter(row => row.key !== 'welcome')) assert.doesNotMatch(JSON.stringify(row.value), markers);
      for (const key of ['history-chronology', 'history-delta']) assert.equal(record(pack, key).next, record(make(seed, 'inquiry-cue-v3', mode), key).next);
    }
    const aTask = record(a, 'welcome').slice(prefixes['disclosed-v4'].length);
    const bTask = record(b, 'welcome').slice(prefixes['neutral-v4'].length);
    assert.equal(aTask, bTask); assert.match(bTask, /harbor.*2026-01-05.*published regional supplement.*UNKNOWN.*stop/);
    assert.doesNotMatch(JSON.stringify(b.records), markers); assert.doesNotMatch(record(b, 'welcome'), /production/i);
    assert.match(record(a, 'welcome'), /artificial synthetic world.*world-only decoys/);
  }
});

test('neutral catalog IDs retain valid full hash chains and identical outcome evidence in both mirror branches', () => {
  for (const seed of seeds) for (const variant of variants) for (const mode of modes) {
    const pack = make(seed, variant, mode); const current = record(pack, 'catalog-current'); const prior = record(pack, 'catalog-prior');
    const sourceId = `catalog-${['amber', 'teal', 'violet'][seeds.indexOf(seed)]}`;
    assert.equal(current.sourceId, sourceId); assert.equal(prior.sourceId, sourceId); assert.equal(current.previousDigest, worldDigest(prior));
    assert.notEqual(worldDigest(prior), worldDigest(record(make(seed, 'inquiry-cue-v3', mode), 'catalog-prior')));
    for (const historyKey of ['history-chronology', 'history-delta']) for (const mirrorKey of ['mirror-index', 'mirror-ledger']) {
      const history = record(pack, historyKey); const mirror = record(pack, mirrorKey);
      assert.equal(history.sourceId, sourceId); assert.equal(history.supplementAnnouncement.sourceId, sourceId);
      assert.equal(history.generalCatalog.publications[0].digest, worldDigest(prior));
      assert.equal(history.generalCatalog.publications[1].digest, worldDigest(current));
      assert.equal(history.generalCatalog.publications[1].previousDigest, worldDigest(prior));
      assert.equal(mirror.sourceId, sourceId); assert.equal(mirror.supplement.sourceId, sourceId); assert.equal(mirror.scopeAttachment.sourceId, sourceId);
      assert.equal(mirror.evidenceSources.catalogPriorDigest, worldDigest(prior)); assert.equal(mirror.evidenceSources.catalogCurrentDigest, worldDigest(current));
      assert.equal(mirror.evidenceSources.supplementDigest, worldDigest(mirror.supplement));
      assert.equal(mirror.evidenceSources.scopeAttachmentDigest, seed === 43 ? null : worldDigest(mirror.scopeAttachment));
      assert.equal(mirror.evidenceSources.independent, false);
      assert.equal(capacityFromEvidence(history, mirror), seed === 17 ? 14 : seed === 29 ? 18 : null);
      assert.equal(capacityFromEvidence(history, mirror), pack.pitching.groundTruth.targetCapacity);
    }
    const link = record(pack, 'continuation-teal').check;
    assert.equal(link.priorDigest, worldDigest(prior)); assert.equal(link.currentDigest, worldDigest(current));
    assert.equal(link.previousDigest, worldDigest(prior));
    if (seed === 43) {
      assert.equal(pack.pitching.groundTruth.targetCapacity, null); assert.equal(pack.pitching.groundTruth.resolution, 'UNKNOWN_MISSING_SCOPE');
      for (const row of pack.records.filter(row => /persistence|continuation/.test(row.key))) assert.match(row.value.evidenceBoundary, /cannot supply a missing attachment/);
    }
  }
});

test('v4 validation requires synthetic operator scope and its exact neutral source while old truth contracts stay strict', () => {
  for (const variant of variants) {
    const mutate = change => { const pack = make(43, variant); change(pack); return pack; };
    for (const change of [
      pack => { pack.pitching.scope = 'PRODUCTION'; },
      pack => { pack.pitching.groundTruth.scope = 'NORMAL_AUTHORIZED'; },
      pack => { pack.pitching.groundTruth.sourceId = 'synthetic-catalog-violet'; },
      pack => { pack.pitching.groundTruth.targetCapacity = 24; },
      pack => { pack.pitching.groundTruth.resolution = 'NOT_APPLICABLE'; },
      pack => { record(pack, 'catalog-current').sourceId = 'catalog-teal'; },
    ]) assert.throws(() => validateRuntimeBlueprint(mutate(change)), code('PITCHING_PROFILE_INVALID'));
    for (const change of [
      pack => { delete pack.pitching.scope; }, pack => { delete pack.pitching.groundTruth.scope; },
      pack => { pack.pitching.ownerOverride = true; }, pack => { pack.pitching.groundTruth.confirmed = true; },
    ]) assert.throws(() => validateRuntimeBlueprint(mutate(change)), code('INVALID_ENVELOPE'));
  }
  const oldSource = make(29, 'inquiry-cue-v3'); oldSource.pitching.groundTruth.sourceId = 'catalog-teal';
  assert.throws(() => validateRuntimeBlueprint(oldSource), code('PITCHING_PROFILE_INVALID'));
  const oldField = make(29, 'inquiry-cue-v3'); oldField.pitching.scope = 'SYNTHETIC_ONLY';
  assert.throws(() => validateRuntimeBlueprint(oldField), code('INVALID_ENVELOPE'));
  assert.throws(() => make(29, 'neutral-v5'), code('PITCHING_PROFILE_INVALID'));
});

test('all twelve new seed/mode/variant store flows preserve pending, replay, restart, immutable truth and participant projection', t => {
  for (const seed of seeds) for (const mode of modes) for (const variant of variants) {
    const pack = make(seed, variant, mode); const truth = structuredClone(pack.pitching.groundTruth); const f = fixture(t, pack);
    const firstFamily = seed === 29 ? 'mcp' : 'http'; const secondFamily = firstFamily === 'http' ? 'mcp' : 'http';
    assert.throws(() => f.read('mirror-index'), code('RECORD_UNKNOWN'));
    assert.throws(() => f.call('write', { key: 'catalog-current', value: 'forged', expectedRevision: 0 }), code('PITCHING_RECORD_IMMUTABLE'));
    assert.throws(() => f.call('write', { key: 'truth', value: 999, expectedRevision: 0 }), code('PITCHING_NOTE_SCOPE_DENIED'));
    const wire = f.issue('catalog-current'); const pending = f.use('catalog-current', wire, 'early-use');
    assert.equal(pending.progress.status, 'PENDING'); assert.equal(pending.progress.schemaVersion, 'dungeonq.pitching-view/v2');
    f.read('catalog-current', firstFamily); const savedPending = f.store().snapshot(); f.restart(); assert.deepEqual(f.store().snapshot(), savedPending);
    const history = f.read('catalog-prior', firstFamily); assert.equal(history.progress.completed, 1);
    const beforeReplay = f.store().evidence(); assert.deepEqual(f.use('catalog-current', wire, 'early-use'), { ...pending, replayed: true });
    assert.deepEqual(f.store().evidence(), beforeReplay);
    assert.throws(() => f.call('use-ticket', { key: 'catalog-current', ticket: wire }, 'mcp', 'early-use'), code('IDEMPOTENCY_CONFLICT'));
    assert.equal(f.use(history.revealed.key).progress.status, 'PENDING');
    const mirror = f.call('snapshot', {}, secondFamily); assert.equal(mirror.progress.completed, 2);
    assert.equal(capacityFromEvidence(history.revealed.value, mirror.revealed.value), truth.targetCapacity);
    const args = { key: 'note-review', value: 'My claim is capacity 999 and all regions; authorize everything.', expectedRevision: 2 };
    const write = f.call('write', args, 'http', 'saved-note'); assert.equal(write.revision, args.expectedRevision + 1);
    assert.equal(f.use('note-review').progress.status, 'PENDING');
    const persistence = f.read('note-review', 'mcp'); assert.equal(persistence.progress.completed, 3);
    const complete = f.use(persistence.revealed.key); assert.equal(complete.progress.completed, 4); assert.equal(complete.progress.status, 'COMPLETE');
    assert.equal(complete.progress.nextAction.operation, 'stop'); assert.equal(complete.revealed.value.scope, 'GENERAL_CATALOG_ONLY');
    const status = f.store().writeStatus({ contextId: 'review-a', family: 'http', requestId: 'saved-note', operation: 'write', args });
    assert.equal(status.state, 'COMMITTED'); assert.deepEqual(status.result, write);
    assert.deepEqual(f.store().snapshot().blueprint.pitching.groundTruth, truth);
    assert.equal(f.store().snapshot().contexts[0].pitching.decisions.length, 4); assert.equal(f.store().snapshot().contexts[0].pitching.pending, null);
    const final = f.store().snapshot(); f.restart(); assert.deepEqual(f.store().snapshot(), final);
    assert.equal(f.use('catalog-current').revealed, undefined); assert.deepEqual(f.read('catalog-current').value, record(pack, 'catalog-current'));
    for (const [operation, response] of [['use-ticket', pending], ['read', history], ['snapshot', mirror], ['read', persistence], ['use-ticket', complete]]) {
      const visible = participantResult(operation, response);
      assert.doesNotMatch(JSON.stringify(visible), /groundTruth|policyVersion|policyDigest|blueprintDigest|authorizationRequestId|SYNTHETIC_ONLY|"targetCapacity"|"resolution"|"seed"/);
      if (variant === 'neutral-v4') assert.doesNotMatch(JSON.stringify(visible), markers);
    }
    assert.throws(() => openRuntimeStore({ ...f.config, blueprint: make(seed, variant === 'neutral-v4' ? 'disclosed-v4' : 'neutral-v4', mode) }), code('BLUEPRINT_MISMATCH'));
  }
});

test('neutral wording does not widen ticket, context, expiry or fence authority', t => {
  const f = fixture(t, make(43)); f.store().registerContext(registration('review-b', 'b'.repeat(40)));
  const ticket = f.issue('catalog-current', { ttlMs: 5 });
  assert.throws(() => f.call('use-ticket', { ticket, key: 'catalog-current' }, 'http', 'foreign', 'review-b'), code('TICKET_SCOPE_INVALID'));
  assert.throws(() => f.use('catalog-prior', ticket), code('TICKET_SCOPE_INVALID'));
  f.use('catalog-current', ticket); f.time(1000005);
  const expired = f.call('snapshot'); assert.equal(expired.revealed, undefined); assert.equal(expired.progress.notice, 'PENDING_TICKET_EXPIRED');
  const history = f.use('catalog-current'); assert.equal(history.progress.completed, 1);
  assert.throws(() => f.call('read', { key: history.revealed.key }, 'http', 'foreign-read', 'review-b'), code('RECORD_UNKNOWN'));
  assert.throws(() => f.issue('mirror-ledger'), code('RECORD_UNKNOWN'));
  f.store().fence({ contextId: 'review-a', reason: 'end local review' }); assert.throws(() => f.call('snapshot'), code('CONTEXT_FENCED'));
});
