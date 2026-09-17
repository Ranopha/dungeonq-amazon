import { exact, requireThat, digest } from './contracts.mjs';
import { validateCandidate, ASTRA_MODEL } from './astra-provider.mjs';
import { randomUUID } from 'node:crypto';

const TASKS = ['prepare', 'execute', 'verify'];
export function createAstraBridge({ delegate, provider, scenario, record = async () => {} }) {
  requireThat(delegate?.command && provider?.propose && provider.model === ASTRA_MODEL, 'ASTRA_CONFIGURATION_INVALID');
  let busy = false;
  let sequence = 0;
  // Sequence is local to this process episode, not a claim of global log ordering.
  const episodeId = randomUUID();
  const info = Object.freeze({ ...delegate.info, model: ASTRA_MODEL, mode: provider.mode,
    simulation: 'SYNTHETIC_EFFECTS_WITH_ASTRA_CANDIDATES', noApprovalTool: true,
    modelData: 'MINIMIZED_ENGINE_ENUMS_AND_NUMBERS', localHumanBoundary: true });
  return Object.freeze({ info,
    async command(input) {
      requireThat(!busy, 'ASSISTANT_BUSY');
      if (input?.command !== 'astra') return delegate.command(input);
      exact(input, ['command', 'task']); requireThat(TASKS.includes(input.task), 'ASTRA_TASK_INVALID');
      busy = true;
      try {
        const analysis = await delegate.command({ command: 'analyze' });
        const snapshot = await delegate.command({ command: 'status' });
        requireThat(!analysis.failed && !snapshot.failed, 'ASTRA_CONTEXT_UNAVAILABLE');
        const row = snapshot.result.responses.findLast(item => item.assetId === scenario.requestedEffect.targetAssetId);
        const mapping = scenario.requestedEffect.type === 'ISOLATE_SESSION' && scenario.requestedEffect.scope === 1
          && analysis.result.proposal.expectedBeforeState === 'AVAILABLE';
        // No free-text scenario fields, usernames, credential material, or tenant ids leave this host.
        const summary = { profile: 'SYNTHETIC_ONLY', task: input.task, trafficRoute: analysis.result.decision.route,
          riskScore: analysis.result.decision.riskScore, executable: analysis.result.proposal.executableAfterApproval,
          mappingSupported: mapping, requestState: row?.state ?? 'NONE', scope: scenario.requestedEffect.scope,
          budgetUnits: scenario.policy.budgetUnits, costUnits: scenario.requestedEffect.costUnits,
          failures: [...scenario.failures], humanApprovalAvailableToAgent: false };
        const proposal = await provider.propose(summary);
        const candidate = validateCandidate(proposal.candidate);
        const candidateEvent = { schemaVersion: 'dungeonq.astra-event/v1', profile: 'SYNTHETIC_ONLY',
          episodeId, sequence: ++sequence, type: 'MODEL_CANDIDATE', task: input.task, ...proposal, summary,
          authority: 'UNTRUSTED_CANDIDATE', summaryDigest: digest(summary) };
        // Evidence persistence must succeed BEFORE a model-proposed command can cross the MCP boundary.
        await record(candidateEvent);
        let result;
        const allowed = ({ prepare: ['request', 'wait'], execute: ['apply', 'wait'], verify: ['verify', 'wait'] })[input.task];
        requireThat(allowed.includes(candidate.action), 'ASTRA_TASK_SCOPE_DENIED');
        if (candidate.action === 'wait') {
          result = { failed: false, result: { state: 'WAITING', reason: 'NO_NEW_AUTHORITY', explanation: candidate.explanation }, trace: snapshot.trace };
        } else if (candidate.action === 'request') {
          requireThat(summary.executable && mapping, 'SCENARIO_EFFECT_BLOCKED');
          result = await delegate.command({ command: 'request' });
        } else {
          requireThat(row, 'RESPONSE_UNAVAILABLE');
          result = await delegate.command({ command: candidate.action, requestId: row.requestId });
        }
        await record({ schemaVersion: 'dungeonq.astra-event/v1', profile: 'SYNTHETIC_ONLY', episodeId, sequence: ++sequence,
          type: 'RUNTIME_RESULT', modelEventSequence: candidateEvent.sequence,
          status: result.failed ? 'REJECTED' : 'COMPLETED', resultDigest: digest(result.result),
          code: result.result.error ?? result.result.reason ?? null, effect: result.result.body?.after ?? null });
        return { ...result, info, astra: proposal, task: input.task };
      } finally { busy = false; }
    }, close: () => delegate.close()
  });
}
