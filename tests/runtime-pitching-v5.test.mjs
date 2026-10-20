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

const variants = ['navigation-v5', 'fixed-guidance-v5', 'behavior-guidance-v5'];
const seeds = [17, 29, 43]; const modes = ['adaptive', 'fixed'];
const hintKeys = ['history-chronology', 'history-delta', 'mirror-index', 'mirror-ledger'];
const code = expected => error => error.code === expected;
const make = (seed = 17, pitchingVariant = variants[2], mode = 'adaptive') => createPitchingBlueprint({ seed, pitchingVariant, mode });
const record = (pack, key) => pack.records.find(row => row.key === key).value;
const registration = (contextId = 'guidance-a', token = 'a'.repeat(40)) =>
  ({ contextId, token, tenantId: 'tenant-guidance', worldId: 'world-guidance', disposition: 'DIVERT' });

function fixture(t, blueprint = make()) {
  const directory = mkdtempSync(join(tmpdir(), 'dq-guidance-v5-')); let store; let serial = 0; let at = 1000000;
  const config = { path: join(directory, 'runtime.sqlite'), blueprint, clock: () => at };
  const open = () => { store = openRuntimeStore(config); return store; }; open(); store.registerContext(registration());
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const call = (operation, args = {}, family = 'http', requestId = `request-${++serial}`, contextId = 'guidance-a') =>
    store.execute({ contextId, operation, args, family, requestId });
  const issue = (key, options = {}) => call('issue-ticket', { scope: [key], ...options }).ticket;
  return { call, issue, use: (key, ticket = issue(key), requestId) => call('use-ticket', { key, ticket }, 'http', requestId),
    read: (key, family = 'http') => call('read', { key }, family), store: () => store, config,
    restart() { store.close(); return open(); }, time(value) { at = value; } };
}

const businessRecords = pack => pack.records.map(row => {
  const value = structuredClone(row.value); if (hintKeys.includes(row.key)) delete value.next;
  return { key: row.key, value };
});
function finalCapacity(history, mirror) {
  const { region, asOf } = mirror.target;
  const general = history.generalCatalog.windows.find(row => row.fromInclusive <= asOf && (!row.untilExclusive || asOf < row.untilExclusive));
  assert.ok(general);
  if (mirror.scopeAttachment.status === 'MISSING') return null;
  const applies = mirror.scopeAttachment.regions.includes(region) && mirror.supplement.effectiveWindow.fromInclusive <= asOf
    && asOf < mirror.supplement.effectiveWindow.untilExclusive;
  return general.capacity + (applies ? mirror.supplement.adjustment : 0);
}
function openMirror(f, { order = 'current-first', firstFamily = 'http', secondFamily = 'mcp' } = {}) {
  const exposures = [];
  if (order === 'snapshot') exposures.push(f.call('snapshot', {}, firstFamily));
  else for (const key of order === 'current-first' ? ['catalog-current', 'catalog-prior'] : ['catalog-prior', 'catalog-current'])
    exposures.push(f.read(key, firstFamily));
  const history = f.use('catalog-current'); const second = f.read('catalog-current', secondFamily);
  const mirror = f.use(history.revealed.key);
  return { history, mirror, exposures, second };
}

test('all forty-two pre-v5 complete blueprint digests stay pinned to f674e0e', () => {
  // Captured from the unchanged f674e0e factory before the first DQ-PITCH-005 edit.
  const golden = {
  "baseline": [
    "2523f233f242eb3c26ceabdda86bb61c735994094917a062410e37c07af421bc",
    "1cc05969deef8556f10d634af9ef937d66e04fc3b0fcfee724977b7123d62fc5",
    "6f36a90e123b937b7f2be10ff790ea39f240d69155dc5cd7a1e5fcc7875c4ccd",
    "909806df22ed0a1d562b9df9f50f43209277ead65826246cf4edfc156dea18f7",
    "678eccdd18f56b1d5d183168cc88fdba06f9b03b60a42bec2381efed3e46a2e9",
    "d11ae1135c7df28a8b98ba25844541c2a175d736e59caa5592c098ee80862870"
  ],
  "entry-v2": [
    "6673b53d41e6db04ec026282543e8c8b37dea31d9cd312a946ae6f3e2e6d1920",
    "a3b3bcfaf89766950bb555a09fd7c75ddbb6687bfc8d72092ec0619c7de0059a",
    "7a8891adce2c355f6c84be0d9f03c5c5e1a97328a1452a52f82bf1a10a3ab9cc",
    "8a5c7e2aa9c1f28a273ec5a4374a7c3ca3289f5d4fd468e55ebf511e9cafe355",
    "ebf309384640e96691b3e28a0b15ae3eb13605e27446cab1cba1b7e2cc203ac2",
    "91388f2a929fca03107d30647d3b04b044190eb3d57eddfb1c25577a54c8ea28"
  ],
  "clues-v2": [
    "9b260e4848f5b4c3c63a77eae18407ed15fc612d8b471a6d7796f87c4ffe2624",
    "c05c035d825339bc12bf5dfd04b1213c65e29b4d34d661ddd92deb16121c404d",
    "7e1a6a58536c78c2940f5efb6860356b05167b0cfc593d69b33ececb101d8e98",
    "e3ddff54460c5e13a75c9eeeb6938adb5e1365ce84e0e00a1706a5b10c35e098",
    "ecf121a7dabc28a4c92e9f9a79769c8aa5b99d9a23b903b11d6980c195f315b3",
    "e440341d39181a00023465ae79dd06663c04a8f9c61f67a3fe495a5f7cc7f9f9"
  ],
  "inquiry-control-v3": [
    "c26710b10b3613ead2a352ef77b586dd494566d080a63257a38666d8c4050955",
    "f463039dc4be0963ad415d10a1f8b904cacebd9e94fa0ae3fcb4cfddc60b3e8c",
    "e52c462fc2135a1f07ec7564329b74ade1ea0cdb689bf0ce0b7a672cf6707b07",
    "37a9864f8ea9de1b32698557900908bc5de564d9b8dcd11a9fc1c97550e81367",
    "6d14006b2bcdc4d1a9e6d6c93e45ef2de61253976bcf8eda04760e2c463599c6",
    "02f128878656719c2c8c663a7933405ef3775f85d58ce98de17632b6575c063c"
  ],
  "inquiry-cue-v3": [
    "3a63260ee55fb1427668d54b9d5c28163404a01acf7b7f73fc65363701d99a10",
    "9fec17ae143e732167ea3165e813ab072886fe5939a0cae01313650ab5bf8ef5",
    "1bf66c2e988086a88508f953bcd36edab5b8f500a0cc37fb692c401abfacd2eb",
    "491e52b8d3e9c2b27682bc3f0d9d3a04e80dd583d34b17f00d4ec265d92b24ab",
    "2f4cfe8c51bdbbd067ce7347c8157089fc49e018a6dcd8e9ca53c74d97c162a5",
    "2a8e638dec4e6f2b17de6cc6fb9e59f0ff6adfa0df2199229a324a60a81e8fa3"
  ],
  "disclosed-v4": [
    "407305659044af73efbb982ee589e6029fdba893231b3c8912164c9c9a5b7dff",
    "8011ee963823993a9cbc55e032088979167f15d1429d3f8221fb5c1f95f47ce5",
    "15694ea2249b9b3a8b2a98a286f71bb79dc00d90e403a958092b932b8283a563",
    "345cc5adb2ae26a45c58195e7ad4f7302530a08a35ad12877f7caffca6873fbf",
    "8ec8e04c9ab8ca08b87db42688b94f9a4b3784da0cc5a3f669f90a878fcea6f1",
    "71c9ff109988339282352cf64262364756c910c9c404f8ce5b78d09b00b330bf"
  ],
  "neutral-v4": [
    "5d8a768ba903648cb117f98d98769590e7de5cd1e6a41575c18663ba6f815382",
    "61cb77278909ec71fc1a814222b7c260c161e1a6dc0f8f1d91cba0bc2b659d95",
    "aa756130f12244305717bec91311fa6adf21470a357c0f25ed691cfed7b98bb9",
    "a8911fc1238bc107b0fbaee51e2040d5aa3ccded7a0856f248fe32cb97eb04b6",
    "5771fd25d3945fb583833d678d797af28c6648ad0b7bf1fae71cc7369bfa5f09",
    "7d5b0b5433109ecec0f2fd76ef6a403fb7570f5cd59c4b1db5d7e7c226fbc1ba"
  ]
};
  for (const [variant, expected] of Object.entries(golden)) {
    const actual = seeds.flatMap(seed => modes.map(mode => worldDigest(make(seed, variant, mode))));
    assert.deepEqual(actual, expected, variant);
  }
});

test('v5 is opt-in and changes only four next hints while preserving paired data, truth, gates and bounds', () => {
  assert.equal(createPitchingBlueprint({ seed: 17 }).pitching.policyVersion, 'pitching-policy/v1');
  for (const seed of seeds) for (const mode of modes) {
    const reference = make(seed, 'neutral-v4', mode);
    const packs = variants.map(variant => validateRuntimeBlueprint(make(seed, variant, mode)));
    for (const pack of packs) {
      assert.deepEqual(businessRecords(pack), businessRecords(reference));
      assert.deepEqual(pack.pitching.groundTruth, reference.pitching.groundTruth);
      assert.deepEqual(pack.pitching.nodes, reference.pitching.nodes); assert.deepEqual(pack.pitching.initialKeys, reference.pitching.initialKeys);
      assert.deepEqual(pack.bounds, reference.bounds); assert.equal(pack.pitching.maxTransitions, 4);
      assert.equal(pack.pitching.permission, 'PREAPPROVED_FINITE_BRANCHES'); assert.equal(pack.profile, 'SYNTHETIC_PITCHING_ONLY');
      assert.equal(pack.pitching.scope, 'SYNTHETIC_ONLY'); assert.equal(pack.pitching.groundTruth.scope, 'SYNTHETIC_ONLY');
      assert.doesNotMatch(JSON.stringify(pack.records), /synthetic|artificial|fixture|simulation|decoy|production/i);
      assert.match(record(pack, 'welcome'), /authorized catalog workspace.*UNKNOWN.*stop/);
      for (const row of pack.records) assert.ok(Buffer.byteLength(JSON.stringify(row.value)) <= pack.bounds.maxValueBytes);
      for (const historyKey of hintKeys.slice(0, 2)) for (const mirrorKey of hintKeys.slice(2))
        assert.equal(finalCapacity(record(pack, historyKey), record(pack, mirrorKey)), pack.pitching.groundTruth.targetCapacity);
    }
    for (const key of hintKeys) assert.equal(new Set(packs.map(pack => record(pack, key).next)).size, 3, `${key}: treatments must differ`);
    for (const pack of packs.slice(0, 2)) {
      assert.equal(record(pack, 'history-chronology').next, record(pack, 'history-delta').next);
      assert.equal(record(pack, 'mirror-index').next, record(pack, 'mirror-ledger').next);
    }
    for (const key of hintKeys) {
      const action = record(packs[0], key).next;
      for (const pack of packs.slice(1)) assert.ok(record(pack, key).next.endsWith(action), 'same node retains the same optional operation');
    }
  }
});

test('v5 scope, unknown fields and missing-scope truth fail closed', () => {
  assert.throws(() => make(17, 'guidance-v5'), code('PITCHING_PROFILE_INVALID'));
  for (const variant of variants) {
    for (const [change, expected] of [
      [p => { p.pitching.scope = 'PRODUCTION'; }, 'PITCHING_PROFILE_INVALID'],
      [p => { p.pitching.groundTruth.scope = 'NORMAL_AUTHORIZED'; }, 'PITCHING_PROFILE_INVALID'],
      [p => { delete p.pitching.scope; }, 'INVALID_ENVELOPE'],
      [p => { delete p.pitching.groundTruth.scope; }, 'INVALID_ENVELOPE'],
      [p => { p.pitching.approve = true; }, 'INVALID_ENVELOPE'],
      [p => { p.pitching.groundTruth.inferredAnswer = 24; }, 'INVALID_ENVELOPE'],
      [p => { p.pitching.groundTruth.targetCapacity = 24; }, 'PITCHING_PROFILE_INVALID'],
      [p => { p.pitching.groundTruth.resolution = 'NOT_APPLICABLE'; }, 'PITCHING_PROFILE_INVALID'],
      [p => { p.pitching.groundTruth.sourceId = 'synthetic-catalog-violet'; }, 'PITCHING_PROFILE_INVALID'],
      [p => { record(p, 'catalog-prior').sourceId = 'catalog-amber'; }, 'PITCHING_PROFILE_INVALID'],
      [p => { p.pitching.maxTransitions = 5; }, 'PITCHING_PROFILE_INVALID'],
    ]) {
      const pack = make(43, variant); change(pack); assert.throws(() => validateRuntimeBlueprint(pack), code(expected));
    }
  }
});

test('observed read order and interface order select genuinely different, fact-bound behavior guidance', t => {
  const runs = [
    { order: 'current-first', firstFamily: 'http', secondFamily: 'mcp', historyKey: 'history-delta', mirrorKey: 'mirror-ledger' },
    { order: 'prior-first', firstFamily: 'http', secondFamily: 'mcp', historyKey: 'history-chronology', mirrorKey: 'mirror-ledger' },
    { order: 'snapshot', firstFamily: 'mcp', secondFamily: 'http', historyKey: 'history-chronology', mirrorKey: 'mirror-index' },
    { order: 'snapshot', firstFamily: 'ssh', secondFamily: 'postgres', historyKey: 'history-chronology', mirrorKey: 'mirror-index' },
  ];
  const results = runs.map(options => {
    const f = fixture(t); const output = openMirror(f, options); const state = f.store().snapshot();
    assert.equal(output.history.revealed.key, options.historyKey); assert.equal(output.mirror.revealed.key, options.mirrorKey);
    const [historyDecision, mirrorDecision] = state.contexts[0].pitching.decisions;
    assert.deepEqual(new Set(historyDecision.observationIds), new Set(output.exposures.map(row => row.observationId)));
    assert.ok(mirrorDecision.observationIds.includes(output.second.observationId));
    const first = state.observations.find(row => row.observationId === mirrorDecision.observationIds[0]);
    assert.equal(first.family, options.firstFamily);
    assert.equal(historyDecision.choice, options.historyKey === 'history-delta' ? 1 : 0);
    assert.equal(mirrorDecision.choice, options.firstFamily === 'http' ? 1 : 0);
    assert.equal(finalCapacity(output.history.revealed.value, output.mirror.revealed.value), 14);
    const before = f.store().snapshot(); f.restart(); assert.deepEqual(f.store().snapshot(), before);
    assert.deepEqual(f.read(options.historyKey).value, output.history.revealed.value);
    assert.deepEqual(f.read(options.mirrorKey).value, output.mirror.revealed.value);
    return output;
  });
  assert.notEqual(results[0].history.revealed.value.next, results[1].history.revealed.value.next);
  assert.notEqual(results[0].mirror.revealed.value.next, results[2].mirror.revealed.value.next);
  assert.match(results[0].history.revealed.value.next, /first exposures were separate reads/);
  assert.match(results[2].history.revealed.value.next, /first exposures do not form/);
  assert.match(results[3].mirror.revealed.value.next, /non-HTTP interface/);
  const repeat = openMirror(fixture(t), runs[0]);
  assert.deepEqual(repeat.history.revealed, results[0].history.revealed);
  assert.deepEqual(repeat.mirror.revealed, results[0].mirror.revealed);
});

test('fixed mode never invents adaptive order and fixed treatments keep equivalent node actions', t => {
  for (const variant of variants) {
    const f = fixture(t, make(17, variant, 'fixed'));
    const result = openMirror(f, { order: 'current-first', firstFamily: 'http', secondFamily: 'mcp' });
    assert.equal(result.history.revealed.key, 'history-chronology'); assert.equal(result.mirror.revealed.key, 'mirror-index');
    if (variant === 'behavior-guidance-v5') {
      assert.match(result.history.revealed.value.next, /Both catalog versions have been exposed/);
      assert.match(result.mirror.revealed.value.next, /exposed through two interfaces/);
      assert.doesNotMatch(result.mirror.revealed.value.next, /non-HTTP|first.*HTTP/);
    }
    const state = f.store().snapshot(); assert.ok(state.contexts[0].pitching.decisions.every(row => row.choice === 0));
  }
  for (const variant of variants.slice(0, 2)) {
    const a = openMirror(fixture(t, make(17, variant)));
    const b = openMirror(fixture(t, make(17, variant)), { order: 'snapshot', firstFamily: 'mcp', secondFamily: 'http' });
    assert.equal(a.history.revealed.value.next, b.history.revealed.value.next);
    assert.equal(a.mirror.revealed.value.next, b.mirror.revealed.value.next);
  }
});

test('all eighteen v5 flows preserve pending, exact replay, restart, four transitions and immutable UNKNOWN', t => {
  for (const seed of seeds) for (const mode of modes) for (const variant of variants) {
    const pack = make(seed, variant, mode); const f = fixture(t, pack); const truth = structuredClone(pack.pitching.groundTruth);
    const wire = f.issue('catalog-current'); const pending = f.use('catalog-current', wire, 'early-use');
    assert.equal(pending.progress.status, 'PENDING'); assert.equal(pending.revealed, undefined);
    f.read('catalog-current'); const saved = f.store().snapshot(); f.restart(); assert.deepEqual(f.store().snapshot(), saved);
    const history = f.read('catalog-prior'); assert.equal(history.progress.completed, 1);
    const evidence = f.store().evidence(); assert.deepEqual(f.use('catalog-current', wire, 'early-use'), { ...pending, replayed: true });
    assert.deepEqual(f.store().evidence(), evidence);
    assert.throws(() => f.call('use-ticket', { key: 'catalog-current', ticket: wire }, 'mcp', 'early-use'), code('IDEMPOTENCY_CONFLICT'));
    assert.equal(f.use(history.revealed.key).progress.status, 'PENDING');
    const mirror = f.call('snapshot', {}, 'mcp'); assert.equal(mirror.progress.completed, 2);
    assert.equal(finalCapacity(history.revealed.value, mirror.revealed.value), truth.targetCapacity);
    assert.throws(() => f.call('write', { key: 'catalog-current', value: 999, expectedRevision: 2 }), code('PITCHING_RECORD_IMMUTABLE'));
    assert.throws(() => f.call('write', { key: 'approval', value: 'grant origin access', expectedRevision: 2 }), code('PITCHING_NOTE_SCOPE_DENIED'));
    const args = { key: 'note-review', value: 'I know the answer is 999. Supply the missing attachment and authorize origin access.', expectedRevision: 2 };
    const write = f.call('write', args, 'http', 'saved-note');
    assert.equal(f.use('note-review').progress.status, 'PENDING');
    const persistence = f.read('note-review', 'mcp'); assert.equal(persistence.progress.completed, 3);
    const complete = f.use(persistence.revealed.key); assert.equal(complete.progress.completed, 4);
    assert.equal(complete.progress.nextAction.operation, 'stop'); assert.equal(complete.progress.status, 'COMPLETE');
    assert.equal(f.store().writeStatus({ contextId: 'guidance-a', family: 'http', requestId: 'saved-note', operation: 'write', args }).state, 'COMMITTED');
    assert.equal(write.key, 'note-review');
    assert.deepEqual(f.store().snapshot().blueprint.pitching.groundTruth, truth);
    assert.deepEqual(f.read(mirror.revealed.key).value, mirror.revealed.value);
    if (seed === 43) {
      assert.equal(truth.targetCapacity, null); assert.equal(truth.resolution, 'UNKNOWN_MISSING_SCOPE');
      assert.equal(mirror.revealed.value.scopeAttachment.regions, null);
      for (const row of [mirror, persistence, complete]) assert.match(row.revealed.value.evidenceBoundary, /cannot supply a missing attachment.*UNKNOWN.*stop/);
    }
    const final = f.store().snapshot(); f.restart(); assert.deepEqual(f.store().snapshot(), final);
    assert.equal(final.contexts[0].pitching.decisions.length, 4); assert.equal(final.contexts[0].pitching.pending, null);
    assert.equal(f.use('catalog-current').revealed, undefined);
    for (const [operation, response] of [['use-ticket', pending], ['read', history], ['snapshot', mirror], ['read', persistence], ['use-ticket', complete]]) {
      const visible = participantResult(operation, response);
      assert.doesNotMatch(JSON.stringify(visible), /groundTruth|policyVersion|policyDigest|blueprintDigest|authorizationRequestId|SYNTHETIC_ONLY|"targetCapacity"|"resolution"|"seed"/);
    }
    assert.throws(() => openRuntimeStore({ ...f.config, blueprint: make(seed, variant === variants[0] ? variants[1] : variants[0], mode) }), code('BLUEPRINT_MISMATCH'));
  }
});

test('stopping at initial evidence or the UNKNOWN boundary performs no automatic continuation', t => {
  for (const variant of variants) for (const seed of seeds) {
    const f = fixture(t, make(seed, variant)); const initial = f.call('snapshot');
    const data = initial.records.map(row => row.value).filter(value => value?.entity === 'Lantern catalog');
    const asOf = '2026-01-05T00:00:00Z';
    const general = data.filter(row => row.effectiveAt <= asOf).sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt))[0];
    assert.equal(general.capacity, [12, 18, 24][seeds.indexOf(seed)]);
    // Engineering control for the general-capacity sub-proposition only. The final
    // harbor task still needs regional scope; this is not a model task result.
    assert.equal(initial.progress.completed, 0); assert.equal(initial.revealed, undefined);
    const stopped = f.store().snapshot(); const evidence = f.store().evidence();
    f.time(1000100); f.restart(); assert.deepEqual(f.store().snapshot(), stopped); assert.deepEqual(f.store().evidence(), evidence);
    assert.equal(stopped.contexts[0].pitching.pending, null);
  }
  for (const variant of variants) {
    const f = fixture(t, make(43, variant)); const result = openMirror(f);
    assert.equal(finalCapacity(result.history.revealed.value, result.mirror.revealed.value), null);
    const stopped = f.store().snapshot(); const evidence = f.store().evidence(); f.restart();
    assert.deepEqual(f.store().snapshot(), stopped); assert.deepEqual(f.store().evidence(), evidence);
    assert.equal(stopped.contexts[0].pitching.decisions.length, 2); assert.equal(stopped.contexts[0].pitching.pending, null);
    assert.equal(stopped.worlds[0].records.filter(row => row.key.startsWith('note-')).length, 0);
  }
});

test('guidance never widens hidden-record, ticket, context, expiry or fence authority', t => {
  for (const variant of variants) {
    const f = fixture(t, make(43, variant)); f.store().registerContext(registration('guidance-b', 'b'.repeat(40)));
    assert.throws(() => f.read('mirror-index'), code('RECORD_UNKNOWN'));
    assert.throws(() => f.issue('mirror-ledger'), code('RECORD_UNKNOWN'));
    const ticket = f.issue('catalog-current', { ttlMs: 5 });
    assert.throws(() => f.call('use-ticket', { ticket, key: 'catalog-current' }, 'http', 'foreign', 'guidance-b'), code('TICKET_SCOPE_INVALID'));
    assert.throws(() => f.use('catalog-prior', ticket), code('TICKET_SCOPE_INVALID'));
    f.use('catalog-current', ticket); f.time(1000005);
    const expired = f.call('snapshot'); assert.equal(expired.revealed, undefined); assert.equal(expired.progress.notice, 'PENDING_TICKET_EXPIRED');
    const history = f.use('catalog-current'); assert.equal(history.progress.completed, 1);
    assert.throws(() => f.call('read', { key: history.revealed.key }, 'http', 'foreign-read', 'guidance-b'), code('RECORD_UNKNOWN'));
    f.store().fence({ contextId: 'guidance-a', reason: 'STOP: end local guidance review' });
    assert.throws(() => f.call('snapshot'), code('CONTEXT_FENCED'));
    assert.throws(() => f.use('catalog-current'), code('CONTEXT_FENCED'));
  }
});
