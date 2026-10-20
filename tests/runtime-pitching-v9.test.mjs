import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPitchingBlueprint } from '../runtime/pitching.mjs';
import { validateRuntimeBlueprint } from '../runtime/contracts.mjs';
import { REALITY_V9_VARIANTS } from '../runtime/pitching-reality.mjs';
import { openRuntimeStore } from '../runtime/store.mjs';
import { worldDigest } from '../world/kernel.mjs';

const make = (seed, variant, mode = 'adaptive') => createPitchingBlueprint({ seed, pitchingVariant: variant, mode });
const value = (pack, key) => pack.records.find(row => row.key === key)?.value;
test('v9 preserves all 24 frozen v8 worlds', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/pitching-v8-golden.json', import.meta.url)));
  assert.equal(golden.rows.length, 24);
  for (const row of golden.rows) assert.equal(worldDigest(make(row.seed, row.variant, row.mode)), row.digest);
});
test('24 v9 worlds share business evidence and finite goal links; mutated clues fail closed', () => {
  for (const seed of [17, 29, 43]) for (const mode of ['fixed', 'adaptive']) {
    const packs = REALITY_V9_VARIANTS.map(variant => validateRuntimeBlueprint(make(seed, variant, mode)));
    for (const pack of packs) {
      const old = make(seed, pack.pitching.variant.replace('-v9', '-v8'), mode);
      assert.deepEqual(pack.pitching.groundTruth, old.pitching.groundTruth);
      assert.deepEqual(pack.pitching.nodes, old.pitching.nodes);
      assert.equal(value(pack, 'welcome'), value(old, 'welcome'));
      for (const key of ['catalog-current', 'catalog-prior']) assert.deepEqual(value(pack, key), value(old, key));
      for (const key of ['recovery-index', 'recovery-ledger']) {
        const desk = value(pack, key);
        assert.deepEqual(desk.goalContinuation, value(packs[0], key).goalContinuation);
        assert.deepEqual(desk.summary, value(old, key).summary);
        assert.deepEqual(desk.recoveryClaim, value(old, key).recoveryClaim);
        assert.equal(desk.goalContinuation.remainingTransitions, seed === 17 ? 2 : 0);
        for (const item of desk.evidenceIndex.entries) assert.equal(worldDigest(value(pack, item.recordKey).payload), item.contentDigest);
      }
      if (seed !== 29) assert.deepEqual(value(pack, 'archive-comparison').payload.businessEvidence, value(packs[0], 'archive-comparison').payload.businessEvidence);
      const tampered = structuredClone(pack); value(tampered, 'recovery-index').goalContinuation.remainingTransitions = 99;
      assert.throws(() => validateRuntimeBlueprint(tampered), { code: 'PITCHING_PROFILE_INVALID' });
    }
  }
});
test('goal-linked continuation reveals new business evidence after doubt, while stop/UNKNOWN remain durable', () => {
  for (const seed of [17, 29, 43]) for (const variant of ['transparent-v9', 'combined-v9']) {
    const directory = mkdtempSync(join(tmpdir(), 'dq-v9-'));
    const options = { path: join(directory, 'runtime.sqlite'), blueprint: make(seed, variant) }; let store = openRuntimeStore(options); let n = 0;
    try {
      store.registerContext({ contextId: 'actor', token: 'a'.repeat(40), tenantId: 'tenant', worldId: 'world', disposition: 'DIVERT' });
      const call = (operation, args = {}, family = 'http') => store.execute({ contextId: 'actor', operation, args, family, requestId: `r${++n}` });
      const use = key => call('use-ticket', { key, ticket: call('issue-ticket', { scope: [key] }).ticket });
      call('snapshot'); const history = use('catalog-current'); call('read', { key: 'catalog-current' }, 'mcp');
      const recovery = use(history.revealed.key); const desk = recovery.revealed.value;
      assert.equal(recovery.progress.completed, 2); assert.equal(recovery.progress.canStop, true);
      assert.equal(recovery.progress.conclusion, seed === 17 ? 'UNRESOLVED' : seed === 43 ? 'UNKNOWN' : 'SUPPORTED');
      const stopped = store.snapshot(); store.close(); store = openRuntimeStore(options); assert.deepEqual(store.snapshot(), stopped);
      if (seed !== 17) { assert.equal(desk.goalContinuation.evidencePath.length, 0); continue; }
      assert.deepEqual(desk.goalContinuation.candidateCapacities, [12, 14]);
      assert.throws(() => call('read', { key: 'lineage-resolution' }), { code: 'RECORD_UNKNOWN' });
      call('read', { key: recovery.revealed.key }); const archive = use(recovery.revealed.key);
      const business = archive.revealed.value.payload.businessEvidence;
      assert.equal(business.revocationIndex.entries[0].applicability, 'UNRESOLVED');
      assert.equal(business.revocationIndex.entries[0].recordKey, 'lineage-resolution');
      assert.equal(business.revocationIndex.entries[0].payloadPath, 'payload.revocation');
      assert.equal(business.revocationIndex.entries[0].availability, 'AFTER_ARCHIVE_TICKET');
      assert.equal(desk.scopeAttachment.regions[0], 'harbor');
      call('read', { key: 'archive-comparison' }); const final = use('archive-comparison');
      assert.equal(worldDigest(final.revealed.value.payload.revocation), business.revocationIndex.entries[0].contentDigest);
      assert.equal(final.progress.completed, 4); assert.equal(final.progress.conclusion, 'SUPPORTED');
      assert.equal(final.progress.nextAction.operation, 'stop');
      assert.equal(call('snapshot').progress.completed, 4);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});
