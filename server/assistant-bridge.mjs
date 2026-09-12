import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { exact, requireThat, GovernanceError, digest, id } from './contracts.mjs';

// Deterministic Alexa-style simulator: every action below crosses the real HTTP MCP client.
// It never receives application credentials or a human approval handle.
export async function createAssistantBridge({ endpoint, accessToken, scenario, seedObservation }) {
  const client = new Client({ name: 'DungeonQ-assistant-simulator', version: '0.2.0' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
  await client.connect(transport);
  const tools = await client.listTools();
  let busy = false;
  const trace = [];
  const call = async (name, args = {}) => {
    const output = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
    const result = output.structuredContent ?? JSON.parse(output.content[0].text);
    trace.push({ sequence: (trace.at(-1)?.sequence ?? 0) + 1, tool: name,
      status: output.isError ? 'REJECTED' : 'COMPLETED', inputDigest: digest(args),
      outputDigest: digest(result), code: result.error ?? null });
    if (trace.length > 24) trace.shift();
    return { failed: output.isError === true, result: result.result ?? result };
  };
  return Object.freeze({
    info: { name: 'DungeonQ', simulation: 'DETERMINISTIC_ASSISTANT_NOT_ALEXA_SERVICE',
      protocolVersion: '2025-11-25', transport: 'Streamable HTTP', tools: tools.tools.map(tool => tool.name),
      scenario: { id: scenario.scenarioId, title: scenario.title }, executionEffect: 'SYNTHETIC_CONTAINMENT' },
    async command(input) {
      requireThat(!busy, 'ASSISTANT_BUSY');
      requireThat(input && typeof input.command === 'string', 'SCHEMA_INVALID');
      const required = ['command', ...(['apply', 'replay', 'verify', 'tamper', 'export'].includes(input.command) ? ['requestId'] : []),
        ...(input.command === 'custom' ? ['scenarioPack'] : [])];
      exact(input, required);
      requireThat(['status', 'analyze', 'custom', 'request', 'apply', 'replay', 'verify', 'tamper', 'export'].includes(input.command), 'COMMAND_UNSUPPORTED');
      if (input.requestId) id(input.requestId);
      busy = true;
      try {
        let output;
        if (input.command === 'status') output = await call('dungeonq_status');
        if (['analyze', 'custom'].includes(input.command)) output = await call('dungeonq_simulate', { scenarioPack: input.command === 'custom' ? input.scenarioPack : scenario });
        if (input.command === 'request') {
          const analysis = await call('dungeonq_simulate', { scenarioPack: scenario });
          requireThat(!analysis.failed && analysis.result.proposal.executableAfterApproval, 'SCENARIO_EFFECT_BLOCKED');
          requireThat(scenario.requestedEffect.type === 'ISOLATE_SESSION' && scenario.requestedEffect.scope === 1
            && analysis.result.proposal.expectedBeforeState === 'AVAILABLE', 'EXECUTION_MAPPING_UNSUPPORTED');
          const state = (await call('dungeonq_status')).result;
          const previous = state.responses.find(row => row.assetId === scenario.requestedEffect.targetAssetId
            && ['AWAITING_HUMAN', 'APPROVED', 'CLAIMED', 'COMPLETED'].includes(row.state));
          if (previous) output = { failed: false, result: previous };
          else {
            const asset = state.assets.find(asset => asset.id === scenario.requestedEffect.targetAssetId);
            requireThat(asset?.state === 'ACTIVE', 'ASSET_CONFLICT');
            // Explicit lab fixture, never advertised as a trusted production signal source.
            const eventId = `event-${randomUUID()}`;
            seedObservation({ eventId, assetId: asset.id, version: asset.version });
            output = await call('dungeonq_response_request', { requestId: `request-${randomUUID()}`, eventId,
              assetId: asset.id, expectedVersion: asset.version });
          }
        }
        if (['apply', 'replay'].includes(input.command)) output = await call('dungeonq_effect_apply', { requestId: input.requestId });
        if (input.command === 'export') output = await call('dungeonq_evidence_export', { requestId: input.requestId });
        if (['verify', 'tamper'].includes(input.command)) {
          const evidence = await call('dungeonq_evidence_export', { requestId: input.requestId });
          requireThat(!evidence.failed && evidence.result.response.receipt, 'RECEIPT_UNAVAILABLE');
          const receipt = structuredClone(evidence.result.response.receipt);
          if (input.command === 'tamper') receipt.body.after.version += 7;
          output = await call('dungeonq_receipt_verify', { receipt });
        }
        return { ...output, trace: [...trace], info: this.info };
      } catch (error) {
        if (error instanceof GovernanceError) throw error;
        throw new GovernanceError('ASSISTANT_TRANSPORT_UNKNOWN');
      } finally { busy = false; }
    },
    close: () => client.close()
  });
}
