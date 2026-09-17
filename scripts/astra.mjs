import { readScenarioFile } from './lib/scenario-file.mjs';
import { resolve } from 'node:path';
import { startAstraLab } from '../server/astra-runtime.mjs';

const options = new Map(); const args = process.argv.slice(2);
try {
  if (args.length % 2) throw new Error('OPTIONS_INVALID');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--scenario', '--data-dir', '--web-port', '--mcp-port', '--max-usd'].includes(args[i]) || options.has(args[i])) throw new Error('OPTIONS_INVALID');
    options.set(args[i], args[i + 1]);
  }
  const scenario = await readScenarioFile(options.has('--scenario') ? resolve(options.get('--scenario')) : new URL('../assistant/scenarios/after-hours.json', import.meta.url));
  const runtime = await startAstraLab({ scenario, apiKey: process.env.OPENAI_API_KEY,
    directory: options.has('--data-dir') ? resolve(options.get('--data-dir')) : undefined,
    limitUsd: Number(options.get('--max-usd') ?? 0.5), webPort: Number(options.get('--web-port') ?? 4196), mcpPort: Number(options.get('--mcp-port') ?? 4197) });
  process.stdout.write(`DungeonQ Astra / SYNTHETIC_ONLY\nReview desk: ${runtime.web.origin}/assistant\nModel: gpt-6-astra / paid only when an Astra button is used\nLocal data: ${runtime.lab.directory}\nBudget ceiling per persistent lab: ${runtime.budget.status().limitUsd} USD\nUsername: owner-lab\n`);
  if (runtime.lab.password) process.stdout.write(`Disposable lab password (keep local): ${runtime.lab.password}\n`);
  else process.stdout.write('Use your existing local lab password. No credential was reset.\n');
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await runtime.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
} catch (error) { process.stderr.write(`Astra startup stopped: ${error.code ?? 'CONFIGURATION_REQUIRED'}\n`); process.exitCode = 1; }
