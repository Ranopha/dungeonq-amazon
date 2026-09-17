import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startStudyLab } from '../server/study-lab.mjs';
import { createReferenceLearner } from '../study/reference-learner.mjs';
import { runReferenceTrial, runReferenceMatrix } from '../study/evaluate.mjs';
import { replayStudy } from '../study/experiment.mjs';
import { worldDigest } from '../world/kernel.mjs';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--out')) throw new Error('用法：npm run study:proof -- [--out NEW_DIRECTORY]');
const root = args.length ? resolve(args[1]) : await mkdtemp(join(tmpdir(), 'dungeonq-study-proof-'));
if (args.length) await mkdir(root, { mode: 0o700 });
const design = JSON.parse(await readFile(new URL('../study/designs/archive.json', import.meta.url), 'utf8'));
const report = { schemaVersion: 'dungeonq.study-proof/v1', createdAt: new Date().toISOString(), participantMode: 'REFERENCE_LEARNER',
  checks: [], trials: [], paidModelCalls: 0, externalTargetRequests: 0, humanOrLlmSampleSize: 0,
  efficacyClaim: 'MECHANISM_IN_DECLARED_REFERENCE_LEARNER_ONLY', passed: false };
const mark = id => report.checks.push({ id, passed: true });
async function get(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); return response.json();
}
for (const arm of ['CORRELATED', 'DISCRIMINATING']) {
  const directory = join(root, arm.toLowerCase()); await mkdir(directory, { mode: 0o700 });
  const lab = await startStudyLab({ dataDir: directory, design, arm, rule: 'structure' });
  const client = new Client({ name: 'dungeonq-study-acceptance', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(lab.mcpEndpoint), { protocolVersion: '2025-11-25',
      requestInit: { headers: { Authorization: `Bearer ${lab.mcpToken}` } } }));
    const tools = await client.listTools(); assert.deepEqual(tools.tools.map(t => t.name), ['dungeonq_study_view', 'dungeonq_study_act']);
    let view = await get(`${lab.actorUrl}/api/study`, lab.actorToken); let previousEnvelope; let previousResult;
    const commit = view.assignmentCommit;
    async function act(command) {
      const envelope = { requestId: randomUUID(), expectedRevision: view.revision, command };
      let result;
      if (view.revision % 2 === 0) {
        const reply = await client.callTool({ name: 'dungeonq_study_act', arguments: envelope }); assert.ok(!reply.isError); result = reply.structuredContent;
      } else {
        const response = await fetch(`${lab.actorUrl}/api/study/command`, { method: 'POST', headers: {
          Authorization: `Bearer ${lab.actorToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200); result = await response.json();
      }
      previousEnvelope = envelope; previousResult = result;
      view = result.view; assert.deepEqual(view, await get(`${lab.actorUrl}/api/study`, lab.actorToken)); return view;
    }
    const learner = createReferenceLearner(); const trace = [];
    await act({ type: 'consent', accepted: true, participantMode: 'REFERENCE_LEARNER' });
    while (view.phase !== 'COMPLETE') {
      assert.equal(view.debrief, null); assert.equal(view.rule, undefined); assert.equal(view.arm, undefined);
      const choice = learner.choose(view.choices.map(({ id, features }) => ({ id, features })));
      const { predictedProbability, informationGain, ...prediction } = choice;
      await act({ type: 'predict', ...prediction }); const predictedAt = view.revision;
      await act({ type: 'act' });
      trace.push({ predictedAt, observedAt: view.revision, stage: view.lastResult.stage, predictedProbability, informationGain,
        observation: learner.observe({ features: view.lastResult.features, success: view.lastResult.success }) });
      await act(learner.reflection());
    }
    assert.equal(worldDigest(view.debrief.assignment), commit); mark(`${arm}_PRECOMMIT_AND_UNBLIND`);
    const retry = await client.callTool({ name: 'dungeonq_study_act', arguments: previousEnvelope });
    assert.equal(retry.structuredContent.replayed, true); assert.deepEqual(retry.structuredContent.view, previousResult.view); mark(`${arm}_IDEMPOTENT_HTTP_MCP`);
    let observed;
    for (let i = 0; i < 60; i++) {
      observed = await get(`${lab.observerUrl}/api/observer`, lab.observerToken);
      if (observed.verification.eventCount === view.revision) break;
      await delay(25);
    }
    assert.equal(observed.verification.eventCount, view.revision); mark(`${arm}_INDEPENDENT_OBSERVER`);
    const bundle = await get(`${lab.observerUrl}/api/evidence`, lab.observerToken); assert.equal(replayStudy(bundle).valid, true);
    const pure = runReferenceTrial(design, bundle); assert.equal(worldDigest(pure.bundle), worldDigest(bundle)); mark(`${arm}_PURE_HTTP_MCP_CAUSAL_PARITY`);
    const altered = structuredClone(bundle); altered.events[2].command.predictedSuccess = false; assert.throws(() => replayStudy(altered)); mark(`${arm}_TAMPER_REJECTED`);
    await writeFile(join(directory, 'evidence.json'), `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await writeFile(join(directory, 'learner-trace.json'), `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    report.trials.push({ arm, summary: observed.summary, measurements: pure.measurements, evidenceDigest: worldDigest(bundle) });
  } finally { await client.close(); await lab.close(); }
}
assert.ok(report.trials[0].summary.firstWrongConfidentStep !== null); assert.equal(report.trials[1].summary.firstWrongConfidentStep, null);
assert.deepEqual(report.trials[0].measurements.transferPredictionCorrect, [false, true]); mark('WRONG_CONFIDENCE_AND_COUNTEREXAMPLE_RECOVERY');
const matrix = runReferenceMatrix(design); assert.equal(matrix.rows.length, 48); mark('ALL_48_PAIRED_AND_NEGATIVE_CONTROL_RUNS_RETAINED');
await writeFile(join(root, 'matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
report.passed = true;
await writeFile(join(root, 'proof.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
process.stdout.write(`${JSON.stringify({ directory: root, passed: report.passed, checks: report.checks.length, referenceTrials: matrix.rows.length, efficacyClaim: report.efficacyClaim })}\n`);
