import { readScenarioFile } from './lib/scenario-file.mjs';
import { resolve } from 'node:path';
import { openAmazonLab } from '../server/amazon-lab.mjs';
import { createMcpTools, startMcpServer } from '../server/mcp.mjs';
import { createAssistantBridge } from '../server/assistant-bridge.mjs';
import { startWorkbench } from '../server/workbench.mjs';

const options = new Map();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  if (!['--scenario', '--data-dir', '--web-port', '--mcp-port'].includes(args[i]) || !args[i + 1] || options.has(args[i])) {
    throw new Error('Use: npm run amazon -- [--scenario file.json] [--data-dir existing-private-directory] [--web-port 4186] [--mcp-port 4187]');
  }
  options.set(args[i], args[i + 1]);
}
const scenarioText = await readScenarioFile(options.has('--scenario') ? resolve(options.get('--scenario')) : new URL('../assistant/scenarios/after-hours.json', import.meta.url));
let lab; let mcp; let bridge; let web; let stopping = false;
const stop = async () => {
  if (stopping) return; stopping = true;
  await web?.close(); await bridge?.close(); await mcp?.close(); lab?.close();
};
try {
  lab = await openAmazonLab({ directory: options.has('--data-dir') ? resolve(options.get('--data-dir')) : undefined, scenario: scenarioText });
  mcp = await startMcpServer({ tools: createMcpTools({ execution: lab.core.execution, workerToken: lab.workerToken }),
    accessToken: lab.accessToken, port: Number(options.get('--mcp-port') ?? 4187) });
  bridge = await createAssistantBridge({ endpoint: mcp.endpoint, accessToken: lab.accessToken, scenario: lab.scenario, seedObservation: lab.seedObservation });
  web = await startWorkbench({ application: lab.core.application, tls: lab.tls, port: Number(options.get('--web-port') ?? 4186), assistant: bridge });
  process.stdout.write(`DungeonQ local synthetic assistant: ${web.origin}/assistant\nMCP 2025-11-25 / Streamable HTTP: ${mcp.endpoint}\nUsername: owner-lab\n`);
  if (lab.password) process.stdout.write(`NEW disposable lab password (save locally): ${lab.password}\n`);
  else process.stdout.write('Existing lab reopened. Use your saved password; no credentials were reset.\n');
  process.stdout.write(`Private local data: ${lab.directory}\nRestart with --data-dir and the same scenario. Do not upload this directory.\nThe self-signed HTTPS certificate is for this loopback lab only. No system trust changes.\nExternal MCP clients: use the accessToken from local-instance.json as a Bearer token; never give them the owner password.\n`);
} catch (error) {
  await stop(); process.stderr.write(`DungeonQ startup failed: ${error.code ?? 'LOCAL_SETUP_FAILED'}\n`); process.exitCode = 1;
}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
