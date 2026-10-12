import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { interruptedWriteFixture } from './lib/interrupted-write-fixture.mjs';
import { createRuntimeClient } from '../sdk/runtime-client.mjs';
import { request } from '../runtime/transport.mjs';

// Separate from the October 10 proof: the FIRST status lookup occurs after restart.
export async function runRestartBeforeLookup(family) {
  assert(['http', 'mcp'].includes(family));
  const f = await interruptedWriteFixture();
  const input = { requestId: `restart-first-${family}`, operation: 'write', args: {
    key: 'welcome', value: 'Review saved before restart.\nShipping still awaits approval.', expectedRevision: 0 } };
  let mcp, mcpConnections = 0;
  async function connect() {
    mcp = new Client({ name: 'restart-recovery-check', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(f.gateway.mcpEndpoint), {
      requestInit: { headers: { Authorization: `Bearer ${f.credentials.actor}` }, redirect: 'error' }
    }));
    mcpConnections++;
  }
  async function call(operation, args, requestId) {
    const result = await mcp.callTool({ name: `dungeonq_${operation}`, arguments: { args, requestId } });
    if (result.isError) throw Error('EXPECTED_INTERRUPTED_TOOL_CALL');
    assert(result.structuredContent);
    return result.structuredContent;
  }
  try {
    f.fault('after-commit');
    if (family === 'mcp') {
      await connect();
      await assert.rejects(call('write', input.args, input.requestId));
      await mcp.close(); mcp = undefined;
    } else {
      const first = createRuntimeClient({ origin: f.gateway.origin, token: f.credentials.actor });
      await assert.rejects(first.operate(input)); first.disconnect();
    }
    // Observer-only journal evidence is not a client recovery query.
    const event = f.gateway.store.evidence().events.find(e => e.kind === 'EXECUTE' && e.operation === 'write');
    assert(event); assert.equal(f.writeAttempts, 1);
    await f.restart();
    const beforeLookup = f.gateway.store.evidence().verifier;
    // Both lookups are HTTP. The MCP-family route is a companion endpoint,
    // not tools/call; the MCP client is recreated only for the later readback.
    const mcpClientConnectedAtFirstLookup = Boolean(mcp);
    const lookup = () => family === 'mcp'
      ? request(new URL(f.gateway.mcpEndpoint).origin, '/write-status', f.credentials.actor, input)
      : createRuntimeClient({ origin: f.gateway.origin, token: f.credentials.actor }).writeStatus(input);
    const recovered = await lookup();
    assert.equal(recovered.state, 'COMMITTED');
    assert.equal(recovered.automaticRetryAllowed, false);
    assert.equal(recovered.result.value, input.args.value);
    assert.equal(recovered.result.revision, 1);
    assert.equal(recovered.eventDigest, event.digest);
    assert.deepEqual(await lookup(), recovered);
    assert.deepEqual(f.gateway.store.evidence().verifier, beforeLookup, 'status lookup must not mutate canonical state');
    const owner = await request(f.gateway.origin, '/api/operator/write-status', f.credentials.owner,
      { ...input, contextId: 'diverted', family });
    assert.equal(owner.eventDigest, recovered.eventDigest);
    let readback;
    if (family === 'mcp') {
      await connect(); readback = await call('read', { key: 'welcome' }, 'restart-readback');
    } else {
      readback = await createRuntimeClient({ origin: f.gateway.origin, token: f.credentials.actor })
        .operate({ requestId: 'restart-readback', operation: 'read', args: { key: 'welcome' } });
    }
    assert.equal(readback.value, input.args.value);
    const evidence = await f.gateway.evidence();
    const writes = evidence.canonical.events.filter(e => e.kind === 'EXECUTE' && e.operation === 'write');
    const unknown = evidence.events.filter(e => e.requestId === input.requestId && e.outcome === 'UNKNOWN');
    assert.equal(writes.length, 1); assert.equal(f.writeAttempts, 1);
    assert.equal(unknown.length, 1); assert.equal(evidence.status, 'FAIL');
    assert.equal(evidence.scope.witness.accepted, 0);
    return { family, status: 'PASS', firstStatusLookup: 'AFTER_GATEWAY_RESTART',
      writeTransport: family === 'mcp' ? 'MCP_TOOLS_CALL' : 'HTTP',
      recoveryLookupTransport: 'HTTP', recoveryLookupPath: family === 'mcp' ? '/write-status' : '/api/write-status',
      mcpClientConnectedAtFirstLookup,
      readbackTransport: family === 'mcp' ? 'MCP_TOOLS_CALL' : 'HTTP',
      mcpClientRecreatedForReadback: family === 'mcp' && mcpConnections === 2,
      state: recovered.state, eventDigest: recovered.eventDigest,
      operatorMatches: true, separateReadbackMatches: true, repeatedLookupLeavesJournalUnchanged: true,
      revision: recovered.result.revision, canonicalWrites: writes.length, writeAttempts: f.writeAttempts,
      automaticWriteRetries: 0, retainedUnknownAttempts: unknown.length,
      faultedRuntimeEvidence: evidence.status, divertedOriginAdmissions: evidence.scope.witness.accepted };
  } finally { await mcp?.close().catch(() => {}); await f.close(); }
}

export async function runRestartRecoveryDemo() {
  const cases = [];
  for (const family of ['http', 'mcp']) cases.push(await runRestartBeforeLookup(family));
  const sources = ['runtime/store.mjs', 'runtime/server.mjs', 'runtime/mcp.mjs', 'runtime/outcomes.mjs',
    'sdk/runtime-client.mjs', 'scripts/lib/interrupted-write-fixture.mjs', 'scripts/restart-recovery-demo.mjs'];
  return { schemaVersion: 'dungeonq.restart-before-lookup-proof/v1', mode: 'SCRIPTED_LOCAL_FAULT_INJECTION',
    recordedAt: new Date().toISOString(), sourceVersion: JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version,
    status: 'PASS', sourceHashes: Object.fromEntries(sources.map(path => [path,
      createHash('sha256').update(readFileSync(new URL('../' + path, import.meta.url))).digest('hex')])), cases,
    limitations: ['Artificial loopback resources; no model or production test.',
      'Controlled gateway stop and reopen with the same durable directory and credentials; not a power-loss or disk-loss test.',
      'Both families recover through HTTP status endpoints; MCP tools/call is used only for the MCP-family write and later readback, not recovery lookup.',
      'Client retains the exact original request and reconnects to the running endpoint; browser reload persistence is not claimed.',
      'Recovery does not restore missing transport evidence or authorize another write.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [destination, ...extra] = process.argv.slice(2);
  if (!destination || extra.length) throw Error('Provide one NEW report path outside the checkout.');
  const location = relative(fileURLToPath(new URL('../', import.meta.url)), resolve(destination));
  if (!location.startsWith('..') && !isAbsolute(location)) throw Error('Report path must be outside the checkout.');
  const report = await runRestartRecoveryDemo();
  writeFileSync(resolve(destination), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, cases: report.cases }));
}
