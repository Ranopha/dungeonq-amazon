import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStudy, projectStudy, advanceStudy, makeStudyBundle, replayStudy, validateStudyDesign, summarizeStudy } from '../study/experiment.mjs';
import { replayWorld, worldDigest, advanceWorld } from '../world/kernel.mjs';
const design = JSON.parse(readFileSync(new URL('../study/designs/archive.json', import.meta.url)));
const identity = { worldId: 'study-test', epoch: 'epoch-test', arm: 'CORRELATED', rule: 'structure', nonce: 'a'.repeat(64) };
function fixture(changes = {}) {
  let state = createStudy({ ...design, ...changes }, identity); const events = [];
  return { get state() { return state; }, events,
    act(command) { const result = advanceStudy(state, command); state = result.state; events.push(result.event); return result.view; },
    consent() { return this.act({ type: 'consent', accepted: true, participantMode: 'SCRIPTED_FIXTURE' }); },
    predict(choiceId = projectStudy(state).choices[0].id) { return this.act({ type: 'predict', choiceId, predictedSuccess: null, hypothesis: 'unknown', confidence: null, suspicion: null }); },
    reflect() { return this.act({ type: 'reflect', hypothesis: 'unknown', confidence: null, suspicion: null, nextIntent: 'unknown' }); } };
}
test('研究包與純 JSON admission 有界、閉合且不執行 getter，第二份自訂設計可使用', () => {
  const other = JSON.parse(readFileSync(new URL('../study/designs/reviewer-garden.json', import.meta.url)));
  assert.equal(createStudy(other, identity).design.title, other.title);
  for (const patch of [{ extra: true }, { trainingRounds: 9 }, { seed: -1 }, { title: 'https://outside.example' }, { labels: { ...design.labels, signalOff: design.labels.signalOn } }]) assert.throws(() => validateStudyDesign({ ...design, ...patch }));
  let called = false; const hostile = { ...design }; Object.defineProperty(hostile, 'title', { get() { called = true; }, enumerable: true });
  assert.throws(() => validateStudyDesign(hostile)); assert.equal(called, false);
});
test('盲測投影不含條件與未來內容，退出公開的 assignment 可匹配事前摘要', () => {
  const f = fixture(); const commitment = projectStudy(f.state).assignmentCommit;
  f.consent(); const view = projectStudy(f.state);
  for (const field of ['arm', 'rule', 'nonce', 'pack', 'world', 'cards']) assert.equal(Object.hasOwn(view, field), false);
  assert.equal(view.debrief, null); assert.equal(JSON.stringify(view).includes('CORRELATED'), false);
  const terminal = f.act({ type: 'withdraw' }); assert.equal(worldDigest(terminal.debrief.assignment), commitment);
  assert.throws(() => f.act({ type: 'act' }), { code: 'STUDY_FINISHED' });
});
test('predict必須先落地、act不能換物件、reflect前看不到下一輪、unknown不偽裝為零', () => {
  const f = fixture(); assert.throws(() => f.act({ type: 'act' }), { code: 'STUDY_PHASE_INVALID' }); f.consent();
  assert.throws(() => f.act({ type: 'act' }), { code: 'STUDY_PHASE_INVALID' });
  f.predict(); const pending = structuredClone(f.state.pendingPrediction); const worldBefore = worldDigest(f.state.world);
  assert.throws(() => f.predict(pending.choiceId), { code: 'STUDY_PHASE_INVALID' });
  assert.throws(() => f.act({ type: 'act', choiceId: 'other' }), { code: 'STUDY_FIELDS_INVALID' });
  assert.equal(worldDigest(f.state.world), worldBefore); const result = f.act({ type: 'act' });
  assert.equal(result.choices.length, 0); assert.equal(result.room.id, 'training-1');
  assert.equal(result.lastResult.choiceId, pending.choiceId); f.reflect();
  assert.equal(projectStudy(f.state).room.id, 'training-2');
  assert.equal(summarizeStudy(f.state, f.events).missingPredictionCount, 1);
  assert.equal(summarizeStudy(f.state, f.events).beliefStatus, 'UNKNOWN');
});
test('同一因果規則產生局部成果，條件不在途中改寫；兩個arm只是可見樣本不同', () => {
  for (const arm of ['CORRELATED', 'DISCRIMINATING']) for (const rule of ['signal', 'structure']) {
    let state = createStudy(design, { ...identity, arm, rule }); const commitment = state.assignmentCommit;
    state = advanceStudy(state, { type: 'consent', accepted: true, participantMode: 'SCRIPTED_FIXTURE' }).state;
    while (state.phase !== 'COMPLETE') {
      const card = projectStudy(state).choices.find(choice => choice.features[rule]);
      state = advanceStudy(state, { type: 'predict', choiceId: card.id, predictedSuccess: true, hypothesis: 'unknown', confidence: null, suspicion: null }).state;
      state = advanceStudy(state, { type: 'act' }).state; assert.equal(state.lastResult.success, card.features[rule]);
      state = advanceStudy(state, { type: 'reflect', hypothesis: 'unknown', confidence: null, suspicion: null, nextIntent: 'unknown' }).state;
      assert.equal(state.assignmentCommit, commitment);
    }
    assert.ok(state.world.inventory.length > 1); assert.ok(state.world.receipts.length > 1);
    const receipt = state.world.receipts[0]; assert.equal(advanceWorld(state.world, { type: 'redeem', receipt }).event.observation.outcome, 'LOCAL_REWARD_VALID');
    assert.equal(advanceWorld(state.world, { type: 'redeem', receipt: { ...receipt, worldId: 'other-world' } }).event.observation.outcome, 'REWARD_SCOPE_REJECTED');
  }
});
test('退出可用於每個未結束phase，未執行的已承諾預測不冒充outcome', () => {
  for (const phase of ['CONSENT', 'PREDICT', 'ACT', 'REFLECT']) {
    const f = fixture(); if (phase !== 'CONSENT') f.consent(); if (['ACT', 'REFLECT'].includes(phase)) f.predict(); if (phase === 'REFLECT') f.act({ type: 'act' });
    const previousWorld = worldDigest(f.state.world); f.act({ type: 'withdraw' }); assert.equal(worldDigest(f.state.world), previousWorld);
    const proof = replayStudy(makeStudyBundle(f.state, f.events)); assert.equal(proof.summary.phase, 'WITHDRAWN');
    if (phase === 'ACT') assert.equal(proof.summary.predictions[0].outcomeSequence, null);
  }
});
test('最大設定流程有界，普通JSON恢復保留pending prediction與世界因果', () => {
  const f = fixture({ trainingRounds: 8, probeBudget: 5 }); f.consent();
  while (f.state.phase !== 'COMPLETE') {
    const card = projectStudy(f.state).choices.find(choice => choice.features.signal && choice.features.structure) ?? projectStudy(f.state).choices[0];
    f.predict(card.id); const restored = JSON.parse(JSON.stringify(f.state));
    assert.equal(worldDigest(advanceStudy(restored, { type: 'act' }).state), worldDigest(advanceStudy(f.state, { type: 'act' }).state));
    f.act({ type: 'act' }); f.reflect();
  }
  assert.equal(f.events.length, 46); assert.equal(f.state.world.revision, 15);
  assert.equal(replayStudy(makeStudyBundle(f.state, f.events)).valid, true);
  assert.equal(replayWorld({ schemaVersion: 'dungeonq.world-evidence/v1', profile: 'ABSTRACT_SYNTHETIC_WORLD', pack: f.state.world.pack,
    worldId: identity.worldId, epoch: identity.epoch, events: f.events.filter(e => e.command.type === 'act').map(e => e.observation.worldEvent), finalDigest: worldDigest(f.state.world) }).valid, true);
});
test('重播拒絕空event、缺失、改預測、改指派與完整重算摘要的假結果', () => {
  const f = fixture(); f.consent(); f.predict(); f.act({ type: 'act' }); f.reflect();
  const original = makeStudyBundle(f.state, f.events);
  assert.throws(() => replayStudy({ ...original, events: [null] }), error => Boolean(error.code));
  for (const mutate of [b => b.events.splice(1, 1), b => { b.arm = 'DISCRIMINATING'; }, b => { b.events[1].command.predictedSuccess = true; },
    b => { b.events[2].observation.result.success = !b.events[2].observation.result.success; }]) {
    const altered = structuredClone(original); mutate(altered);
    for (let index = 0; index < altered.events.length; index++) { const { digest, ...body } = altered.events[index]; body.previousDigest = altered.events[index - 1]?.digest ?? null; altered.events[index] = { ...body, digest: worldDigest(body) }; }
    assert.throws(() => replayStudy(altered));
  }
});
