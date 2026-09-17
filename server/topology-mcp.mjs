import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { exactTopology, requireTopology, topologyError, TOPOLOGY_PROFILE } from './topology-store.mjs';

export const TOPOLOGY_MCP_VERSION = '2025-11-25';
const MAX_BODY_BYTES = 16_384;
const closed = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const id = { ...text(64), pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' };
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const boolean = { type: 'boolean' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$', minLength: 64, maxLength: 64 };
const receipt = closed({ schemaVersion: { type: 'string', const: 'dungeonq.world-reward/v1' }, worldId: id, epoch: id,
  choiceId: id, issuedAt: integer(1, 200), digest });
const actCommand = { ...closed({ type: { type: 'string', const: 'act' }, actionId: id, expectedOutcome: text(240) }), required: ['type', 'actionId'] };
const commandSchema = { oneOf: [actCommand, closed({ type: { type: 'string', const: 'visit' }, sceneId: id }),
  closed({ type: { type: 'string', const: 'finish' } }), closed({ type: { type: 'string', const: 'withdraw' } })] };
const viewSchema = closed({ profile: { type: 'string', const: TOPOLOGY_PROFILE }, worldId: id, epoch: id, revision: integer(0, 128),
  phase: { type: 'string', enum: ['ACTIVE', 'FINISHED', 'WITHDRAWN'] }, title: text(100), notice: text(1000),
  goal: closed({ objectId: id, text: text(600), achieved: nullable(boolean) }),
  scene: closed({ id, title: text(100), description: text(600), memo: text(1000) }),
  scenes: array(closed({ id, title: text(100) }), 6),
  roles: array(closed({ id, label: text(100), description: text(600) }), 3),
  objects: array(closed({ id, label: text(100), status: { type: 'string', enum: ['SAVED', 'ABSENT'] }, scope: id }), 8),
  readbacks: closed({ visitorCatalogue: closed({ status: { type: 'string', enum: ['OBSERVED', 'NOT_OBSERVED_HERE'] },
    containsTarget: nullable(boolean), entries: nullable(array(id, 1)) }), preview: closed({ ready: nullable(boolean) }),
    circulation: closed({ queued: nullable(boolean), archived: nullable(boolean) }), deposit: closed({ registered: nullable(boolean) }) }),
  records: array({ type: 'object', maxProperties: 12, additionalProperties: { anyOf: [text(600), integer(0, 2147483647)] } }, 8),
  actions: array(closed({ id, label: text(160), description: text(600) }), 8), remaining: integer(0, 128),
  lastResult: nullable(closed({ outcome: text(64), message: text(1000), actionId: nullable(id), actualComplete: nullable(boolean) })),
  receipt: nullable(receipt), debrief: nullable(closed({ actualComplete: boolean, message: text(1000) })) });
const envelopeSchema = closed({ requestId: { ...text(128), pattern: '^[A-Za-z0-9_-]{1,128}$' },
  expectedRevision: integer(0, 128), command: commandSchema });
export const TOPOLOGY_MCP_TOOLS = Object.freeze([
  { name: 'dungeonq_topology_view', description: 'Read the current desk, its available actions and locally observed records. Unobserved values remain null.',
    inputSchema: closed({}), outputSchema: viewSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'dungeonq_topology_act', description: 'Visit a desk, perform one declared synthetic workflow action, explicitly claim task completion, or stop. A completion claim is checked against the actual catalogue and a failed claim permits correction. Optional expectedOutcome is a short public business expectation, not private reasoning. Retry with the identical envelope.',
    inputSchema: envelopeSchema, outputSchema: closed({ view: viewSchema, replayed: boolean }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
]);
const codeOf = (error, fallback) => typeof error?.code === 'string' && /^[A-Z_]{1,80}$/u.test(error.code) ? error.code : fallback;

function sdkServer(store, onChange) {
  const server = new Server({ name: 'DungeonQ Atlas Workflow', version: '2.0.0' }, { capabilities: { tools: {} },
    instructions: 'A bounded original synthetic publishing workflow. Work toward the stated catalogue goal using only declared actions. Desk notes may be partial; read-backs report their actual local scope. No tool has effects outside this installation. Finish explicitly claims completion; withdraw stops the run. There are no arbitrary commands, destinations, or model calls.' });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOPOLOGY_MCP_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const input = request.params.arguments ?? {};
      let result;
      if (request.params.name === 'dungeonq_topology_view') {
        exactTopology(input, [], 'TOPOLOGY_INPUT_INVALID'); result = store.snapshot();
      } else if (request.params.name === 'dungeonq_topology_act') {
        const applied = store.command(input);
        result = { view: applied.view, replayed: applied.replayed };
        // 動作已持久化；送達提示失敗不應把已完成動作回報成失敗。Outbox 保留待送事件。
        try { Promise.resolve(onChange()).catch(() => {}); } catch { /* 由既有 outbox 重試恢復送達。 */ }
      } else throw topologyError('TOPOLOGY_TOOL_UNAVAILABLE');
      const encoded = JSON.stringify(result);
      requireTopology(Buffer.byteLength(encoded) <= 131_072, 'TOPOLOGY_OUTPUT_LIMIT');
      return { content: [{ type: 'text', text: encoded }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ profile: TOPOLOGY_PROFILE,
        error: codeOf(error, 'TOPOLOGY_TOOL_FAILED') }) }] };
    }
  });
  return server;
}

export async function startTopologyMcpServer({ store, accessToken, onChange = () => {}, port = 0 }) {
  requireTopology(store && typeof store.snapshot === 'function' && typeof store.command === 'function', 'TOPOLOGY_STORE_REQUIRED');
  requireTopology(typeof accessToken === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(accessToken), 'MCP_TOKEN_REQUIRED');
  requireTopology(typeof onChange === 'function', 'TOPOLOGY_CALLBACK_INVALID');
  requireTopology(Number.isInteger(port) && port >= 0 && port <= 65535, 'PORT_INVALID');
  const expectedAuth = Buffer.from(`Bearer ${accessToken}`);
  const connections = new Set();
  let origin; let active = 0; let count = 0; let reset = Date.now() + 60_000; let closing;
  const http = createServer({ maxHeaderSize: 16_384 }, async (request, response) => {
    let admitted = false; let server;
    const traceId = randomUUID();
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Request-ID', traceId);
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    try {
      requireTopology(request.socket.remoteAddress === '127.0.0.1' && request.headers.host === new URL(origin).host
        && request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'host').length === 1, 'HOST_DENIED');
      requireTopology(request.headers.origin === undefined || request.headers.origin === origin, 'ORIGIN_DENIED');
      requireTopology(!request.headers['sec-fetch-site'] || ['none', 'same-origin'].includes(request.headers['sec-fetch-site']), 'ORIGIN_DENIED');
      requireTopology(request.url === '/mcp', 'NOT_FOUND');
      const auth = Buffer.from(request.headers.authorization ?? '');
      requireTopology(auth.length === expectedAuth.length && timingSafeEqual(auth, expectedAuth), 'AUTH_REQUIRED');
      if (Date.now() >= reset) { count = 0; reset = Date.now() + 60_000; }
      requireTopology(++count <= 600 && active < 8, 'TRANSPORT_CAPACITY'); active++; admitted = true;
      if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }); response.end(); return; }
      requireTopology(/^application\/json(?:;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] ?? '')
        && !request.headers['content-encoding'], 'CONTENT_TYPE');
      requireTopology(!request.headers['content-length'] || Number(request.headers['content-length']) <= MAX_BODY_BYTES, 'BODY_TOO_LARGE');
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length; requireTopology(size <= MAX_BODY_BYTES, 'BODY_TOO_LARGE'); chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw topologyError('JSON_INVALID'); }
      requireTopology(body && !Array.isArray(body) && typeof body === 'object', 'JSON_INVALID');
      if (body.method === 'initialize') requireTopology(body.params?.protocolVersion === TOPOLOGY_MCP_VERSION, 'PROTOCOL_UNSUPPORTED');
      else requireTopology(request.headers['mcp-protocol-version'] === TOPOLOGY_MCP_VERSION, 'PROTOCOL_UNSUPPORTED');
      if (request.headers['mcp-protocol-version']) requireTopology(request.headers['mcp-protocol-version'] === TOPOLOGY_MCP_VERSION, 'PROTOCOL_UNSUPPORTED');
      server = sdkServer(store, onChange); connections.add(server);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport); await transport.handleRequest(request, response, body);
    } catch (error) {
      if (response.headersSent || response.destroyed) return;
      const code = codeOf(error, 'SERVICE_UNAVAILABLE');
      const status = ({ HOST_DENIED: 403, ORIGIN_DENIED: 403, AUTH_REQUIRED: 401, NOT_FOUND: 404,
        TRANSPORT_CAPACITY: 429, BODY_TOO_LARGE: 413, CONTENT_TYPE: 415, SERVICE_UNAVAILABLE: 503 })[code] ?? 400;
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: code }, traceId }));
    } finally {
      if (admitted) active--;
      if (server) { connections.delete(server); await server.close().catch(() => {}); }
    }
  });
  http.requestTimeout = 10_000; http.headersTimeout = 5000; http.timeout = 10_000;
  http.maxConnections = 32; http.maxRequestsPerSocket = 100; http.keepAliveTimeout = 2000;
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${http.address().port}`;
  return Object.freeze({ endpoint: `${origin}/mcp`, close() {
    closing ??= (async () => {
      await Promise.all([...connections].map(server => server.close().catch(() => {})));
      await new Promise(resolve => { http.close(resolve); http.closeAllConnections(); });
    })();
    return closing;
  } });
}

