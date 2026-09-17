import { createStudy, projectStudy, advanceStudy, summarizeStudy, makeStudyBundle, replayStudy } from './experiment.mjs';
import { createReferenceLearner } from './reference-learner.mjs';
import { worldDigest } from '../world/kernel.mjs';

// This driver knows the assignment; the learner receives only projected choices and revealed observations.
export function runReferenceTrial(design, identity, learnerOptions = {}) {
  let state = createStudy(design, identity); const events = []; const trace = [];
  const learner = createReferenceLearner(learnerOptions);
  const initial = learner.snapshot();
  const advance = command => { const result = advanceStudy(state, command); state = result.state; events.push(result.event); return result.view; };
  advance({ type: 'consent', accepted: true, participantMode: 'REFERENCE_LEARNER' });
  while (state.phase !== 'COMPLETE') {
    const view = projectStudy(state);
    const selected = learner.choose(view.choices.map(({ id, features }) => ({ id, features })));
    const { predictedProbability, informationGain, ...prediction } = selected;
    const before = learner.snapshot();
    advance({ type: 'predict', ...prediction }); const predictionSequence = state.revision;
    const result = advance({ type: 'act' });
    const observation = learner.observe({ features: result.lastResult.features, success: result.lastResult.success });
    trace.push({ predictionSequence, outcomeSequence: state.revision, stage: result.lastResult.stage,
      choiceId: selected.choiceId, predictedProbability, informationGain, before, observation });
    advance(learner.reflection());
  }
  const bundle = makeStudyBundle(state, events); replayStudy(bundle);
  const summary = summarizeStudy(state, events);
  const lastTraining = trace.filter(row => row.stage === 'training').at(-1);
  const transfer = trace.filter(row => row.stage === 'transfer');
  return { schemaVersion: 'dungeonq.reference-trial/v1', source: 'REFERENCE_LEARNER', config: learner.config, initial,
    trace, summary, measurements: {
      wrongFactorProbabilityAfterTraining: lastTraining.observation.after[identity.rule === 'signal' ? 'structure' : 'signal'],
      wrongFactorProbabilityInitially: initial.weights[identity.rule === 'signal' ? 'structure' : 'signal'],
      transferPredictionCorrect: transfer.map(row => (row.predictedProbability >= 0.5) === row.observation.success),
      finalReportedHypothesis: learner.snapshot().hypothesis,
      finalTrueFactorProbability: learner.snapshot().weights[identity.rule],
    }, bundle, bundleDigest: worldDigest(bundle), efficacyClaim: 'REFERENCE_LEARNER_ONLY_NOT_HUMAN_OR_LLM' };
}

export function runReferenceMatrix(design) {
  const seeds = [101, 202, 303, 404];
  const configs = [{ prior: 'SURFACE_BIASED', policy: 'GREEDY' },
    { prior: 'NEUTRAL', policy: 'GREEDY' }, { prior: 'SURFACE_BIASED', policy: 'INFORMATION_SEEKING' }];
  const rows = [];
  for (const seed of seeds) for (const config of configs) for (const rule of ['signal', 'structure']) for (const arm of ['CORRELATED', 'DISCRIMINATING']) {
    const key = { seed, config, rule, arm };
    const run = runReferenceTrial({ ...design, seed }, {
      worldId: `reference-${worldDigest(key).slice(0, 24)}`, epoch: 'reference-v1', arm, rule, nonce: worldDigest({ key, purpose: 'NON_SECRET_REPRODUCIBLE_FIXTURE' }),
    }, config);
    rows.push({ seed, config, rule, arm, measurements: run.measurements,
      firstWrongConfidentStep: run.summary.firstWrongConfidentStep, firstDiagnosticStep: run.summary.firstDiagnosticStep,
      wrongPredictionCount: run.summary.wrongPredictionCount, bundleDigest: run.bundleDigest });
  }
  return { schemaVersion: 'dungeonq.reference-matrix/v1', participantMode: 'REFERENCE_LEARNER', rows,
    analysis: { units: rows.length, seedReplicates: seeds.length,
      comparison: 'PAIRED_PRESENTATION_SEEDS_FIXED_PRIORS_COUNTERBALANCED_TRUE_RULE',
      populationInference: 'NONE', pValue: null, humanOrLlmSampleSize: 0,
      limitations: 'Presentation seeds are not independent human subjects. The learner priors and policies are explicit model assumptions; no general deception efficacy follows.' },
    paidModelCalls: 0, externalTargetRequests: 0 };
}
