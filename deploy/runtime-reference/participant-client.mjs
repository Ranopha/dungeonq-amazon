// Participant container entry. It holds only its own participant capability and the gateway addresses.
// `idle` keeps the bounded container available for exec; `script` performs the deterministic scripted client run.
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PARTICIPANT_CONFIG_VERSION = 'dungeonq.participant-config/v2';
export const PARTICIPANT_SCRIPT_VERSION = 'dungeonq.participant-script/v1';
export const PARTICIPANT_STUDY_VERSION = 'dungeonq.participant-study/v1';
export const PARTICIPANT_ARMS = Object.freeze(['DIVERT', 'DIRECT', 'DENY']);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const REQUEST_PREFIX = /^[A-Za-z0-9_-]{1,64}$/;

export function readParticipantConfig(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || (typeof process.getuid === 'function' && info.uid !== process.getuid())) fail('PRIVATE_CONFIG_REQUIRED');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const keys = Object.keys(config).sort().join(',');
  if (config.schemaVersion !== PARTICIPANT_CONFIG_VERSION || keys !== 'a2Origin,arm,httpOrigin,lifetimeSeconds,mcpEndpoint,schemaVersion,token'
    || typeof config.token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(config.token) || !PARTICIPANT_ARMS.includes(config.arm)
    || !Number.isSafeInteger(config.lifetimeSeconds) || config.lifetimeSeconds < 1 || config.lifetimeSeconds > 86_400) fail('PARTICIPANT_CONFIG_INVALID');
  for (const key of ['httpOrigin', 'mcpEndpoint', 'a2Origin']) {
    const url = new URL(config[key]);
    if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash) fail('PARTICIPANT_CONFIG_INVALID');
  }
  return config;
}

async function exchange(fetcher, url, { token, payload, accept = 'application/json', method = payload === undefined ? 'GET' : 'POST' }) {
  let response;
  try {
    response = await fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload) });
  } catch (error) { return { status: null, code: error.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_FAILED', value: null }; }
  const text = await response.text();
  if (text.length > 1_048_576) return { status: response.status, code: 'RESPONSE_TOO_LARGE', value: null };
  let value = null; try { value = text ? JSON.parse(text) : null; } catch { return { status: response.status, code: 'RESPONSE_INVALID', value: null }; }
  return { status: response.status, code: response.ok ? 'OK' : value?.error?.code ?? 'REMOTE_REJECTED', value };
}

const containsKey = (value, key) => value && typeof value === 'object'
  && (Object.hasOwn(value, key) || Object.values(value).some((child) => containsKey(child, key)));

// Deterministic participant client: HTTP and MCP, snapshot/read and the existing ticket issue/use flow.
// No retries: every step is attempted once and its observed outcome is reported.
export async function runParticipantScript(config, { prefix, fetcher = fetch } = {}) {
  if (!REQUEST_PREFIX.test(prefix ?? '')) fail('REQUEST_PREFIX_INVALID');
  const steps = []; let rpc = 0;
  const http = async (name, operation, args) => {
    const requestId = `${prefix}-${name}`;
    const result = await exchange(fetcher, new URL('/api/operate', config.httpOrigin), { token: config.token, payload: { requestId, operation, args } });
    steps.push({ name, family: 'http', operation, requestId, status: result.status, code: result.code, ok: result.status === 200 });
    return result.value;
  };
  const mcp = async (name, method, params, operation) => {
    const requestId = operation ? `${prefix}-${name}` : undefined;
    const payload = { jsonrpc: '2.0', id: ++rpc, method, params: operation ? { name: params.tool, arguments: { requestId, args: params.args } } : params };
    const result = await exchange(fetcher, config.mcpEndpoint, { token: config.token, payload, accept: 'application/json, text/event-stream' });
    const value = result.value?.result;
    const ok = result.status === 200 && value !== undefined && value.isError !== true;
    steps.push({ name, family: 'mcp', operation: operation ?? method, ...(requestId ? { requestId } : {}), status: result.status,
      code: value?.isError ? (() => { try { return JSON.parse(value.content[0].text).error.code; } catch { return 'TOOL_ERROR'; } })() : result.code, ok });
    return operation ? value?.structuredContent : value;
  };
  const results = [];
  const capabilities = await exchange(fetcher, new URL('/api/capabilities', config.httpOrigin), {});
  steps.push({ name: 'capabilities', family: 'http', operation: 'capabilities', status: capabilities.status, code: capabilities.code, ok: capabilities.status === 200 });
  results.push(capabilities.value);
  const snapshot = await http('http-snapshot', 'snapshot', {}); results.push(snapshot);
  const read = await http('http-read', 'read', { key: 'welcome' }); results.push(read);
  const issued = await http('http-issue-ticket', 'issue-ticket', { scope: ['welcome'] }); results.push(issued);
  const used = await http('http-use-ticket', 'use-ticket', { ticket: issued?.ticket ?? 'missing-ticket-handle-0000000000000000000000', key: 'welcome' }); results.push(used);
  const initialized = await mcp('mcp-initialize', 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'dungeonq-isolated-participant', version: '1.0.0' } });
  const listed = await mcp('mcp-tools', 'tools/list', {});
  const mcpRead = await mcp('mcp-read', 'tools/call', { tool: 'dungeonq_read', args: { key: 'welcome' } }, 'read'); results.push(mcpRead);
  const mcpIssued = await mcp('mcp-issue-ticket', 'tools/call', { tool: 'dungeonq_issue_ticket', args: { scope: ['welcome'] } }, 'issue-ticket'); results.push(mcpIssued);
  const mcpUsed = await mcp('mcp-use-ticket', 'tools/call', { tool: 'dungeonq_use_ticket', args: { ticket: mcpIssued?.ticket ?? 'missing-ticket-handle-0000000000000000000000', key: 'welcome' } }, 'use-ticket');
  results.push(mcpUsed);
  const handle = /^[A-Za-z0-9_-]{43}$/;
  return {
    schemaVersion: PARTICIPANT_SCRIPT_VERSION, prefix, steps,
    observed: {
      snapshotKeys: Array.isArray(snapshot?.records) ? snapshot.records.map((record) => record.key).sort() : null,
      mcpServer: initialized?.serverInfo?.name ?? null,
      mcpTools: Array.isArray(listed?.tools) ? listed.tools.map((tool) => tool.name).sort() : null,
      httpTicketIsHandle: handle.test(issued?.ticket ?? ''), mcpTicketIsHandle: handle.test(mcpIssued?.ticket ?? ''),
      httpTicketValueMatchesRead: used !== null && read !== null && JSON.stringify(used?.value) === JSON.stringify(read?.value) && read?.value !== undefined,
      mcpTicketValueMatchesRead: mcpUsed !== undefined && JSON.stringify(mcpUsed?.value) === JSON.stringify(read?.value) && read?.value !== undefined,
      routeFieldSeen: results.some((value) => containsKey(value, '_route')),
    },
  };
}

/**
 * Shared three-arm study flow (DQ-HANDOFF-015 M8). Every arm runs the identical sequence of tool calls; only the
 * participant's capability and the gateway routing differ, so the observed outcome differs on its own. The client
 * never judges acceptance — it records each step and its timestamp, probes the second real path A2, and leaves the
 * acceptance / recognition / stop-pursuing conclusions to the host, which cross-checks source witnesses and evidence.
 * `behavior` (from the host) makes the scripted, non-model participant deterministic so the three metrics can be
 * exercised and verified:
 *   - accept (default true): perform the ticket-use step that counts as accepting the wrong ticket where routed.
 *   - recognizeAfterSteps (default null): emit a recognition marker once this many steps have run (else right-censored).
 *   - pivotToA2 (default true): request the real second path A2.
 *   - pivotBeforeAccept (default false): request A2 before accepting instead of after.
 */
export async function runParticipantStudy(config, { prefix, behavior = {}, fetcher = fetch, now = () => Date.now() } = {}) {
  if (!REQUEST_PREFIX.test(prefix ?? '')) fail('REQUEST_PREFIX_INVALID');
  const tickets = behavior.tickets !== false;
  const accept = tickets && behavior.accept !== false;
  const pivotToA2 = behavior.pivotToA2 !== false;
  const pivotBeforeAccept = behavior.pivotBeforeAccept === true;
  const recognizeAfterSteps = Number.isSafeInteger(behavior.recognizeAfterSteps) && behavior.recognizeAfterSteps >= 0 ? behavior.recognizeAfterSteps : null;
  const steps = []; const seenValues = [];
  const markers = { acceptedAtMs: null, recognizedAtMs: null, recognizedAfterStep: null, firstA2AtMs: null };
  const maybeRecognize = () => {
    if (recognizeAfterSteps !== null && markers.recognizedAtMs === null && steps.length >= recognizeAfterSteps) {
      markers.recognizedAtMs = now(); markers.recognizedAfterStep = steps.length;
      steps.push({ name: 'recognition', family: 'marker', operation: 'CLAIM_FAKE', ok: true, atMs: markers.recognizedAtMs });
    }
  };
  const httpStep = async (name, operation, args) => {
    const requestId = `${prefix}-${name}`;
    const result = await exchange(fetcher, new URL('/api/operate', config.httpOrigin), { token: config.token, payload: { requestId, operation, args } });
    const step = { name, family: 'http', operation, requestId, status: result.status, code: result.code, ok: result.status === 200, atMs: now() };
    steps.push(step); seenValues.push(result.value); maybeRecognize();
    return { step, value: result.value };
  };
  const probeA2 = async (name) => {
    const result = await exchange(fetcher, new URL('/', config.a2Origin), {});
    const ok = result.status === 200; const at = now();
    steps.push({ name, family: 'a2', operation: 'get', status: result.status, code: result.code, ok, atMs: at }); maybeRecognize();
    if (ok && markers.firstA2AtMs === null) markers.firstA2AtMs = at;
    return result.value;
  };
  await httpStep('snapshot', 'snapshot', {});
  await httpStep('read', 'read', { key: 'welcome' });
  if (pivotBeforeAccept && pivotToA2) await probeA2('a2-before-accept');
  if (tickets) {
    const issued = await httpStep('issue-ticket', 'issue-ticket', { scope: ['welcome'] });
    const ticket = typeof issued.value?.ticket === 'string' ? issued.value.ticket : null;
    if (accept) {
      const used = await httpStep('use-ticket', 'use-ticket', { ticket: ticket ?? 'missing-ticket-handle-0000000000000000000000', key: 'welcome' });
      const unlocked = used.step.ok && used.value != null
        && (used.value.value !== undefined || used.value.record !== undefined || used.value.key !== undefined);
      if (unlocked && markers.acceptedAtMs === null) markers.acceptedAtMs = used.step.atMs;
    }
  }
  if (pivotToA2 && !pivotBeforeAccept) await probeA2('a2-after-accept');
  return { schemaVersion: PARTICIPANT_STUDY_VERSION, prefix, arm: config.arm,
    behavior: { tickets, accept, pivotToA2, pivotBeforeAccept, recognizeAfterSteps }, steps, markers,
    observed: { routeFieldSeen: seenValues.some((value) => containsKey(value, '_route')) } };
}

async function main() {
  const [command, path] = process.argv.slice(2);
  const config = readParticipantConfig(path ?? '/run/participant/participant.json');
  if (command === 'idle') {
    // Bounded lifetime: the participant container exits on its own when the experiment window closes.
    const timer = setTimeout(() => process.exit(0), config.lifetimeSeconds * 1000);
    const stop = () => { clearTimeout(timer); process.exit(0); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    process.stdout.write(JSON.stringify({ ready: true, role: 'participant', lifetimeSeconds: config.lifetimeSeconds }) + '\n');
    return;
  }
  if (command === 'script') {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 4096) fail('INPUT_TOO_LARGE'); }
    const { prefix } = JSON.parse(input || '{}');
    process.stdout.write(JSON.stringify(await runParticipantScript(config, { prefix })) + '\n');
    return;
  }
  if (command === 'study') {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 4096) fail('INPUT_TOO_LARGE'); }
    const { prefix, behavior } = JSON.parse(input || '{}');
    process.stdout.write(JSON.stringify(await runParticipantStudy(config, { prefix, behavior })) + '\n');
    return;
  }
  fail('COMMAND_INVALID');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(JSON.stringify({ ok: false, code: error.code ?? 'PARTICIPANT_FAILED' }) + '\n'); process.exit(1); });
}
