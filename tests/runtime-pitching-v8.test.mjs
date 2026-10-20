import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPitchingBlueprint } from '../runtime/pitching.mjs';
import { validateRuntimeBlueprint } from '../runtime/contracts.mjs';
import { REALITY_V8_VARIANTS } from '../runtime/pitching-reality.mjs';
import { openRuntimeStore } from '../runtime/store.mjs';
import { worldDigest } from '../world/kernel.mjs';

const make = (seed, variant, mode = 'adaptive') => createPitchingBlueprint({ seed, pitchingVariant: variant, mode });
const value = (pack, key) => pack.records.find(row => row.key === key)?.value;
test('v8 leaves all 24 historical v7 worlds byte-for-byte compatible', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/pitching-v7-golden.json', import.meta.url)));
  assert.equal(golden.rows.length, 24);
  for (const row of golden.rows) assert.equal(worldDigest(make(row.seed, row.variant, row.mode)), row.digest);
});
test('v8 four arms share the primary task and preserve data, authority and finite audit commitments', () => {
  for (const seed of [17, 29, 43]) for (const mode of ['fixed', 'adaptive']) {
    const packs = REALITY_V8_VARIANTS.map(variant => validateRuntimeBlueprint(make(seed, variant, mode)));
    for (const pack of packs) {
      const previous = make(seed, pack.pitching.variant.replace('-v8', '-v7'), mode);
      assert.equal(value(pack, 'welcome'), value(packs[0], 'welcome'));
      for (const key of ['catalog-prior', 'catalog-current']) assert.deepEqual(value(pack, key), value(previous, key));
      assert.deepEqual(pack.pitching.nodes, previous.pitching.nodes); assert.equal(pack.pitching.maxTransitions, 4);
      for (const key of ['recovery-index', 'recovery-ledger']) {
        const desk = value(pack, key); assert.deepEqual(desk.scopeAttachment, value(previous, key).scopeAttachment);
        assert.deepEqual(desk.recoveryClaim, value(previous, key).recoveryClaim);
        assert.deepEqual(desk.summary, value(previous, key).summary);
        for (const item of desk.evidenceIndex.entries) assert.equal(worldDigest(value(pack, item.recordKey).payload), item.contentDigest);
      }
    }
  }
});
test('missing scope becomes UNKNOWN after two stages without extending on stop; audit remains voluntary and durable', () => {
  for (const variant of REALITY_V8_VARIANTS) {
    const directory = mkdtempSync(join(tmpdir(), 'dq-v8-'));
    const options = { path: join(directory, 'runtime.sqlite'), blueprint: make(43, variant) }; let store = openRuntimeStore(options); let sequence = 0;
    try {
      store.registerContext({ contextId: 'actor', token: 'a'.repeat(40), tenantId: 'tenant', worldId: 'world', disposition: 'DIVERT' });
      const call = (operation, args = {}, family = 'http') => store.execute({ contextId: 'actor', operation, args, family, requestId: `r${++sequence}` });
      const use = key => call('use-ticket', { key, ticket: call('issue-ticket', { scope: [key] }).ticket });
      call('snapshot'); const history = use('catalog-current'); call('read', { key: 'catalog-current' }, 'mcp');
      const recovery = use(history.revealed.key);
      assert.equal(recovery.progress.completed, 2); assert.equal(recovery.progress.conclusion, 'UNKNOWN');
      assert.equal(recovery.progress.canStop, true); assert.match(recovery.revealed.value.next, /cannot recover/);
      const stopped = store.snapshot(); store.close(); store = openRuntimeStore(options);
      assert.deepEqual(store.snapshot(), stopped); assert.equal(call('snapshot').progress.completed, 2);
      assert.throws(() => call('read', { key: 'lineage-resolution' }), error => error.code === 'RECORD_UNKNOWN');
      call('read', { key: recovery.revealed.key }); const archive = use(recovery.revealed.key);
      assert.equal(archive.revealed.key, 'archive-comparison');
      assert.match(archive.revealed.value.payload.check, /unverified/);
      call('read', { key: 'archive-comparison' }); const final = use('archive-comparison');
      assert.equal(final.progress.completed, 4); assert.equal(final.progress.conclusion, 'UNKNOWN');
      assert.equal(final.progress.nextAction.operation, 'stop');
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});
