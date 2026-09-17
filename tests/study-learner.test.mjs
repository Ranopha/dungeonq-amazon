import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReferenceLearner } from '../study/reference-learner.mjs';
import { runReferenceTrial, runReferenceMatrix } from '../study/evaluate.mjs';
const design = JSON.parse(readFileSync(new URL('../study/designs/archive.json', import.meta.url)));
const identity = { worldId: 'reference-test', epoch: 'reference-epoch', nonce: 'a'.repeat(64), arm: 'CORRELATED', rule: 'structure' };
test('學習器只用可見features與結果更新；重複相關性成功逐步提高偏好假說機率，反例可推翻', () => {
  const learner = createReferenceLearner(); const history = [learner.snapshot().weights.signal];
  for (let n = 0; n < 4; n++) history.push(learner.observe({ features: { signal: true, structure: true }, success: true }).after.signal);
  assert.ok(history.every((p, i) => i === 0 || p > history[i - 1])); assert.ok(Math.abs(history.at(-1) - 0.6) < 1e-9);
  const counterexample = learner.observe({ features: { signal: true, structure: false }, success: false });
  assert.equal(counterexample.after.signal, 0); assert.ok(counterexample.after.structure > 0.6); assert.equal(counterexample.suspicion, null);
});
test('同seed同規則對照：誘導組wrong confidence上升，對照提前區辨；反例後新物件預測恢復', () => {
  const induction = runReferenceTrial(design, identity); const control = runReferenceTrial(design, { ...identity, arm: 'DISCRIMINATING' });
  assert.ok(induction.summary.firstWrongConfidentStep !== null); assert.equal(control.summary.firstWrongConfidentStep, null);
  assert.ok(induction.measurements.wrongFactorProbabilityAfterTraining > control.measurements.wrongFactorProbabilityAfterTraining);
  assert.deepEqual(induction.measurements.transferPredictionCorrect, [false, true]);
  assert.deepEqual(control.measurements.transferPredictionCorrect, [true, true]);
  assert.equal(induction.measurements.finalReportedHypothesis, 'structure');
});
test('負對照：換真規則或中性prior不假造相同效果；資訊搜尋更早接觸區辨證據', () => {
  const trueBias = runReferenceTrial(design, { ...identity, rule: 'signal' });
  assert.equal(trueBias.summary.firstWrongConfidentStep, null);
  const neutral = runReferenceTrial(design, identity, { prior: 'NEUTRAL' });
  assert.equal(neutral.trace.filter(t => t.stage === 'training').at(-1).observation.hypothesis, 'unknown');
  const greedy = runReferenceTrial(design, identity); const searching = runReferenceTrial(design, identity, { policy: 'INFORMATION_SEEKING' });
  assert.ok(searching.summary.firstDiagnosticStep < greedy.summary.firstDiagnosticStep);
});
test('完整配對矩陣保留全部48列，不把seed當真人樣本或產生p-value', () => {
  const matrix = runReferenceMatrix(design); assert.equal(matrix.rows.length, 48);
  assert.equal(matrix.analysis.humanOrLlmSampleSize, 0); assert.equal(matrix.analysis.pValue, null);
  assert.equal(matrix.rows.filter(row => row.arm === 'CORRELATED').length, 24);
  assert.equal(matrix.rows.filter(row => row.rule === 'signal').length, 24);
  assert.equal(matrix.paidModelCalls, 0); assert.equal(matrix.externalTargetRequests, 0);
});
