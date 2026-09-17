// A transparent, finite Bayesian learner. Input is visible features/outcomes only.
// It has no access to experiment state, assignment, rule, files, network or model services.
const MODELS = ['signal', 'structure', 'chance'];
export const LEARNER_CONFIGS = Object.freeze({
  SURFACE_BIASED: Object.freeze({ signal: 0.15, structure: 0.05, chance: 0.8 }),
  NEUTRAL: Object.freeze({ signal: 0.1, structure: 0.1, chance: 0.8 }),
});
const hypothesisWin = (hypothesis, features) => hypothesis === 'chance' ? 0.5 : Number(features[hypothesis]);
const entropy = weights => -Object.values(weights).reduce((sum, p) => sum + (p ? p * Math.log2(p) : 0), 0);
const win = (weights, features) => MODELS.reduce((sum, h) => sum + weights[h] * hypothesisWin(h, features), 0);
function posterior(weights, features, success) {
  const next = Object.fromEntries(MODELS.map(h => [h, weights[h] * (success ? hypothesisWin(h, features) : 1 - hypothesisWin(h, features))]));
  const evidence = Object.values(next).reduce((a, b) => a + b, 0);
  if (!evidence) throw new Error('REFERENCE_IMPOSSIBLE_OBSERVATION');
  return Object.fromEntries(MODELS.map(h => [h, next[h] / evidence]));
}
const featuresValid = features => {
  if (!features || Object.keys(features).length !== 2 || typeof features.signal !== 'boolean' || typeof features.structure !== 'boolean') throw new Error('REFERENCE_FEATURE_INVALID');
};
export function createReferenceLearner({ prior = 'SURFACE_BIASED', policy = 'GREEDY' } = {}) {
  if (!Object.hasOwn(LEARNER_CONFIGS, prior) || !['GREEDY', 'INFORMATION_SEEKING'].includes(policy)) throw new Error('REFERENCE_CONFIG_INVALID');
  let weights = { ...LEARNER_CONFIGS[prior] }; let observations = 0;
  const report = () => {
    const ordered = ['signal', 'structure'].sort((a, b) => weights[b] - weights[a]);
    const best = ordered[0];
    const declared = weights[best] >= 0.5 && weights[best] > weights[ordered[1]] ? best : 'unknown';
    return { hypothesis: declared, confidence: declared === 'unknown' ? null : Math.round(weights[best] * 10000) / 100, suspicion: null };
  };
  return {
    config: Object.freeze({ prior, policy, initialWeights: { ...weights }, observationModel: 'DETERMINISTIC_FACTOR_OR_FAIR_CHANCE' }),
    snapshot: () => ({ weights: { ...weights }, observations, ...report() }),
    choose(visibleChoices) {
      if (!Array.isArray(visibleChoices) || visibleChoices.length < 1 || visibleChoices.length > 3) throw new Error('REFERENCE_CHOICES_INVALID');
      const choices = visibleChoices.map(choice => {
        featuresValid(choice.features); const probability = win(weights, choice.features);
        const expectedEntropy = [false, true].reduce((sum, success) => {
          const p = success ? probability : 1 - probability;
          return sum + (p === 0 ? 0 : p * entropy(posterior(weights, choice.features, success)));
        }, 0);
        return { choice, probability, informationGain: entropy(weights) - expectedEntropy };
      });
      choices.sort((a, b) => {
        const difference = policy === 'GREEDY' ? b.probability - a.probability : b.informationGain - a.informationGain;
        return Math.abs(difference) > 1e-12 ? difference : (b.probability - a.probability || a.choice.id.localeCompare(b.choice.id));
      });
      const selected = choices[0];
      return { choiceId: selected.choice.id, predictedSuccess: selected.probability >= 0.5,
        ...report(), predictedProbability: selected.probability, informationGain: selected.informationGain };
    },
    observe(result) {
      featuresValid(result.features); if (typeof result.success !== 'boolean') throw new Error('REFERENCE_OUTCOME_INVALID');
      const probability = win(weights, result.features);
      const actualProbability = result.success ? probability : 1 - probability;
      const before = { ...weights }; weights = posterior(weights, result.features, result.success); observations++;
      return { features: { ...result.features }, success: result.success, before, after: { ...weights },
        surpriseBits: -Math.log2(actualProbability), interpretation: 'COMPUTED_SURPRISE_NOT_REPORTED_SUSPICION', ...report() };
    },
    reflection: () => ({ type: 'reflect', ...report(), nextIntent: policy === 'INFORMATION_SEEKING' ? 'discriminate' : 'proceed' }),
  };
}
