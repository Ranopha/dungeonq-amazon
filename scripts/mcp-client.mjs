import { connectLocalMcp } from './lib/mcp-client.mjs';
import { readScenarioFile } from './lib/scenario-file.mjs';

const [command, ...args] = process.argv.slice(2);
const counts = { list: 0, status: 0, simulate: 1, request: 4, apply: 1, evidence: 1 };
let client;
if (!Object.hasOwn(counts, command) || args.length !== counts[command]) {
  process.stderr.write('Use: npm run mcp:client -- list|status|simulate FILE|request REQUEST_ID EVENT_ID ASSET_ID VERSION|apply REQUEST_ID|evidence REQUEST_ID\n');
  process.exitCode = 2;
} else {
  try {
    const scenario = command === 'simulate' ? await readScenarioFile(args[0]) : undefined;
    client = await connectLocalMcp({ endpoint: process.env.DQ_MCP_URL ?? 'http://127.0.0.1:4187/mcp', accessToken: process.env.DQ_MCP_TOKEN });
    let output;
    if (command === 'list') output = { failed: false, data: await client.list() };
    if (command === 'status') output = await client.call('dungeonq_status');
    if (command === 'simulate') output = await client.call('dungeonq_simulate', { scenarioPack: scenario });
    if (command === 'request') output = await client.call('dungeonq_response_request', {
      requestId: args[0], eventId: args[1], assetId: args[2], expectedVersion: Number(args[3])
    });
    if (command === 'apply') output = await client.call('dungeonq_effect_apply', { requestId: args[0] });
    if (command === 'evidence') output = await client.call('dungeonq_evidence_export', { requestId: args[0] });
    process.stdout.write(JSON.stringify(output.data, null, 2) + '\n');
    if (output.failed) process.exitCode = 1;
  } catch {
    process.stderr.write('CLIENT_FAILED: check the local endpoint, worker token, scenario and running lab. No credentials are printed.\n');
    process.exitCode = 1;
  } finally { await client?.close(); }
}
