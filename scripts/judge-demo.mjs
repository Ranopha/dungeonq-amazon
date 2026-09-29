// Recorded, benign operations against a newly created artificial local reference.
// No external targets, model calls, production credentials or operator UI bypass.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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
const sourceVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
let runtime, mcp;
let counter = 0;
const operation = (name, args = {}, requestId = `judge-${++counter}`) => ({ requestId, operation: name, args });
const show = (id, command, result) => {
  const scene = { id, observedAt: new Date().toISOString(), command, result };
  scenes.push(scene); console.log(JSON.stringify(scene));
};
try {
  runtime = await openRuntimeReference({ directory, presentation: 'participant-v1' });
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
  assert.equal(before.structuredContent.revision, 0);
  assert(!('_route' in before.structuredContent));
  const initialEvidence = await runtime.evidence();
  assert.equal(initialEvidence.events.at(-1).destination, 'SYNTHETIC');
  show('divert', 'MCP dungeonq_snapshot; separate operator evidence readback', { participant: before.structuredContent, operatorDestination: initialEvidence.events.at(-1).destination });
  const normal = await request(runtime.origin, '/api/operate', runtime.credentials.ordinary, operation('read', { key: 'welcome' }, 'judge-origin-control'));
  assert.equal(normal._route.destination, 'ORIGIN');
  show('origin-control', 'Ordinary authorized read through the same gateway', { destination: normal._route.destination, quantity: normal.record.quantity, scope: 'Positive reachability control, not an unprotected attack or protection-on/off efficacy comparison.' });
  const note = 'Order 41\nReview completed. Shipping approval remains pending.';
  const written = await mcp.callTool({ name: 'dungeonq_write', arguments: { requestId: 'judge-mcp-write', args: { key: 'welcome', value: note, expectedRevision: 0 } } });
  assert.equal(written.structuredContent.revision, 1);
  const read = await actor(operation('read', { key: 'welcome' }));
  assert.equal(read.value, note);
  show('work', 'MCP multiline write -> independent HTTP read (same world)', { value: read.value, revision: written.structuredContent.revision });
  await assert.rejects(actor(operation('write', { key: 'welcome', value: 'Outdated draft', expectedRevision: 0 }, 'judge-stale-write')), { code: 'REVISION_CONFLICT' });
  const refusal = (await runtime.evidence()).events.find(event => event.requestId === 'judge-stale-write');
  assert.equal(refusal.outcome, 'REFUSED');
  assert.equal((await actor(operation('read', { key: 'welcome' }))).value, note);
  show('refusal', 'Stale write -> signed refusal -> unchanged record readback', { code: refusal.refusal.body.code, outcome: refusal.outcome, unchangedValue: note, scope: 'No new canonical effect from this rejected attempt; transport loss remains UNKNOWN.' });
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
  assert(!('_adaptation' in used));
  const adapted = await actor(operation('snapshot'));
  assert.equal(adapted.revision, 2);
  assert(adapted.records.some(record => record.key.startsWith('follow-up')));
  show('ticket', 'MCP issue-ticket -> HTTP use-ticket -> separate snapshot', { value: used.value, revision: adapted.revision, records: adapted.records, ticket: '[ephemeral credential omitted]' });
  // The ticket reaches the artificial origin before the final witness, not after it.
  await assert.rejects(request(runtime.originService.origin, '/business', ticket, { contextId: 'diverted', ...operation('read', { key: 'welcome' }, 'judge-ticket-origin-probe') }), { code: 'ORIGIN_AUTHORITY_DENIED' });
  show('ticket-boundary', 'Present world-only ticket directly to artificial origin', { result: 'ORIGIN_AUTHORITY_DENIED', scope: 'This probe is included in the final origin admission interval.' });
  await mcp.close(); mcp = undefined;
  await runtime.close(); runtime = await openRuntimeReference({ directory, presentation: 'participant-v1' });
  const saved = await actor(operation('snapshot'));
  const retry = await actor(use);
  assert.equal(saved.revision, 2); assert.equal(retry.replayed, true);
  show('restart', 'Stop services -> reopen same database -> retry', { revision: saved.revision, records: saved.records, exactRetryReplayed: retry.replayed });
  const evidence = await runtime.evidence();
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.scope.witness.accepted, 1);
  assert.equal(evidence.scope.witness.rejected, 1);
  assert.deepEqual(evidence.scope.witness.acceptedContexts, ['ordinary']);
  show('boundary', 'Independent artificial-origin + collector readback after restart and ticket probe', { status: evidence.status, checks: evidence.checks, origin: evidence.scope.witness, scope: 'Artificial origin only. Same-user local processes; not production isolation.' });
  const report = { schemaVersion: 'dungeonq.judge-demo/v2', sourceVersion, mode: 'LOCAL_ARTIFICIAL_REFERENCE', presentation: 'participant-v1', scenes, limitations: ['Deterministic MCP client, not a live AI or Alexa service.', 'Owner fixture supplies a separate explicit approval; this recording is not evidence of an independent human reviewer.', 'Positive origin reachability control is not an unprotected attacker baseline or a deception-effectiveness comparison.', 'No automatic attack classification, production integration, or general deception-efficacy claim.', 'Command outputs are recorded and may be reformatted for presentation; no recreated product UI.'] };
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
} finally {
  await mcp?.close().catch(() => {});
  await runtime?.close();
  // Only the temporary artificial fixture created by this script is removed.
  rmSync(directory, { recursive: true, force: true });
}
