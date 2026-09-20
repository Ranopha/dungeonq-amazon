// Recorded, benign operations against a newly created artificial local reference.
// No external targets, model calls, production credentials or operator UI bypass.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openRuntimeReference } from '../runtime/reference.mjs';
import { request } from '../runtime/transport.mjs';

const output = process.argv[2] && resolve(process.argv[2]);
if (!output || process.argv.length !== 3) throw Error('Usage: node scripts/judge-demo.mjs /absolute/path/new-report.json');
const directory = mkdtempSync(join(tmpdir(), 'dq-judge-demo-'));
const scenes = [];
let runtime, mcp;
let counter = 0;
const operation = (name, args = {}, requestId = `judge-${++counter}`) => ({ requestId, operation: name, args });
const show = (id, command, result) => {
  const scene = { id, observedAt: new Date().toISOString(), command, result };
  scenes.push(scene); console.log(JSON.stringify(scene));
};
try {
  runtime = await openRuntimeReference({ directory });
  const actor = input => request(runtime.origin, '/api/operate', runtime.credentials.actor, input);
  const owner = (path, input) => request(runtime.origin, path, runtime.credentials.owner, input);
  mcp = new Client({ name: 'dungeonq-judge-demo', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(runtime.mcpEndpoint), {
    requestInit: { headers: { Authorization: `Bearer ${runtime.credentials.actor}` } }
  }));
  const tools = (await mcp.listTools()).tools.map(tool => tool.name);
  assert.equal(tools.length, 5);
  assert(!tools.some(name => /approve|apply|fence/.test(name)));
  show('connect', 'MCP initialize + tools/list', { transport: 'Streamable HTTP', tools });
  const before = await mcp.callTool({ name: 'dungeonq_snapshot', arguments: { requestId: 'judge-mcp-snapshot', args: {} } });
  assert.equal(before.structuredContent._route.destination, 'SYNTHETIC');
  show('divert', 'MCP dungeonq_snapshot', { revision: before.structuredContent.revision, route: before.structuredContent._route });
  const written = await mcp.callTool({ name: 'dungeonq_write', arguments: { requestId: 'judge-mcp-write', args: { key: 'welcome', value: 'Case 42: review the synthetic shipping record.', expectedRevision: 0 } } });
  assert.equal(written.structuredContent.revision, 1);
  const read = await actor(operation('read', { key: 'welcome' }));
  assert.equal(read.value, 'Case 42: review the synthetic shipping record.');
  show('work', 'MCP write -> HTTP read (same world)', { value: read.value, revision: written.structuredContent.revision, route: read._route });
  const preview = await owner('/api/policy/preview', { contextId: 'diverted', action: 'GRANT_MUTATION' });
  const grant = await owner('/api/policy/apply', { proposalId: preview.proposalId, digest: preview.digest, confirmation: 'APPLY' });
  assert.equal(grant.state, 'APPLIED');
  show('authorize', 'Separate owner: preview -> explicit APPLY', { state: grant.state, context: 'diverted', policy: 'GRANT_MUTATION', authority: 'operator fixture; never a participant tool' });
  const issued = await mcp.callTool({ name: 'dungeonq_issue_ticket', arguments: { requestId: 'judge-ticket', args: {} } });
  const ticket = issued.structuredContent.ticket;
  assert.equal(typeof ticket, 'string');
  const use = operation('use-ticket', { ticket }, 'judge-consume-once');
  const used = await actor(use);
  assert.equal(used.value, read.value);
  assert.equal(used._adaptation.template, 'follow-up');
  show('ticket', 'MCP issue-ticket -> HTTP use-ticket', { value: used.value, adaptation: used._adaptation, route: used._route, ticket: '[ephemeral credential omitted]' });
  await mcp.close(); mcp = undefined;
  await runtime.close(); runtime = await openRuntimeReference({ directory });
  const saved = await actor(operation('snapshot'));
  const retry = await actor(use);
  assert.equal(saved.revision, 2); assert.equal(retry.replayed, true);
  show('restart', 'Stop services -> reopen same database -> retry', { revision: saved.revision, records: saved.records, exactRetryReplayed: retry.replayed });
  const evidence = await runtime.evidence();
  assert.equal(evidence.status, 'PASS');
  show('boundary', 'Independent artificial-origin + collector readback', { status: evidence.status, checks: evidence.checks, scope: 'Artificial origin only. Same-user local processes; not production isolation.' });
  const report = { schemaVersion: 'dungeonq.judge-demo/v1', sourceVersion: '0.11.1', mode: 'LOCAL_ARTIFICIAL_REFERENCE', scenes, limitations: ['Deterministic MCP client, not a live AI or Alexa service.', 'Owner fixture supplies a separate explicit approval; this recording is not evidence of an independent human reviewer.', 'No automatic attack classification, production integration, or general deception-efficacy claim.', 'Command outputs are recorded and may be reformatted for presentation; no recreated product UI.'] };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
} finally {
  await mcp?.close().catch(() => {});
  await runtime?.close();
  // Only the temporary artificial fixture created by this script is removed.
  rmSync(directory, { recursive: true, force: true });
}
