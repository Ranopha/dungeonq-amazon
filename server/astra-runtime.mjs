import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openAmazonLab } from './amazon-lab.mjs';
import { createMcpTools, startMcpServer } from './mcp.mjs';
import { createAssistantBridge } from './assistant-bridge.mjs';
import { createAstraBridge } from './astra-bridge.mjs';
import { createAstraProvider, openAstraBudget } from './astra-provider.mjs';
import { startWorkbench } from './workbench.mjs';

// Launcher owns the fixtures. Only delegate + minimized state reach the model adapter.
export async function startAstraLab({ scenario, directory, apiKey, limitUsd = 0.5, provider,
  webPort = 0, mcpPort = 0, onEvent = async () => {} }) {
  let lab; let mcp; let bridge; let web; let budget;
  const close = async () => { try { await web?.close(); } finally { try { await bridge?.close(); } finally { try { await mcp?.close(); } finally { budget?.close(); lab?.close(); } } } };
  try {
    lab = await openAmazonLab({ scenario, directory });
    if (!provider) {
      budget = openAstraBudget({ path: join(lab.directory, 'astra-cost.sqlite'), limitUsd });
      provider = createAstraProvider({ apiKey, budget });
    }
    mcp = await startMcpServer({ tools: createMcpTools({ execution: lab.core.execution, workerToken: lab.workerToken }), accessToken: lab.accessToken, port: mcpPort });
    const delegate = await createAssistantBridge({ endpoint: mcp.endpoint, accessToken: lab.accessToken, scenario: lab.scenario, seedObservation: lab.seedObservation });
    bridge = createAstraBridge({ delegate, provider, scenario: lab.scenario, record: async event => {
      await appendFile(join(lab.directory, 'astra-events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
      await onEvent(event);
    } });
    web = await startWorkbench({ application: lab.core.application, tls: lab.tls, port: webPort, assistant: bridge });
    return { lab, mcp, bridge, web, budget, close };
  } catch (error) { await close(); throw error; }
}
