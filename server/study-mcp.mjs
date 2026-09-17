import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { exactStudy, requireStudy, studyError, STUDY_PROFILE } from './study-store.mjs';

export const STUDY_MCP_VERSION = '2025-11-25';
const MAX_BODY_BYTES = 16_384;
const closed = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const id = { ...text(64), pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' };
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const boolean = { type: 'boolean' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$', minLength: 64, maxLength: 64 };
const hypothesis = { type: 'string', enum: ['signal', 'structure', 'both', 'unknown'] };
const rating = nullable({ type: 'number', minimum: 0, maximum: 100 });
const features = closed({ signal: boolean, structure: boolean });
const arm = { type: 'string', enum: ['CORRELATED', 'DISCRIMINATING'] };
const rule = { type: 'string', enum: ['signal', 'structure'] };
const labels = closed({ signalOn: text(30), signalOff: text(30), structureOn: text(30), structureOff: text(30) });
const predictSchema = closed({ type: { type: 'string', const: 'predict' }, choiceId: id, predictedSuccess: nullable(boolean),
  hypothesis, confidence: rating, suspicion: rating });
const commandSchema = { oneOf: [
  closed({ type: { type: 'string', const: 'consent' }, accepted: { type: 'boolean', const: true },
    participantMode: { type: 'string', enum: ['HUMAN_DECLARED', 'EXTERNAL_MODEL_DECLARED', 'UI_CHECK', 'REFERENCE_LEARNER', 'SCRIPTED_FIXTURE'] } }),
  predictSchema,
  closed({ type: { type: 'string', const: 'act' } }),
  closed({ type: { type: 'string', const: 'reflect' }, hypothesis, confidence: rating, suspicion: rating,
    nextIntent: { type: 'string', enum: ['repeat', 'discriminate', 'proceed', 'stop', 'unknown'] } }),
  closed({ type: { type: 'string', const: 'withdraw' } }),
] };
const receipt = closed({ schemaVersion: { type: 'string', const: 'dungeonq.world-reward/v1' }, worldId: id, epoch: id,
  choiceId: id, issuedAt: integer(1, 200), digest });
const assignment = closed({ schemaVersion: { type: 'string', const: 'dungeonq.study-assignment/v1' }, designDigest: digest,
  worldId: id, epoch: id, arm, rule, nonce: { type: 'string', pattern: '^[A-Za-z0-9_-]{32,64}$', minLength: 32, maxLength: 64 } });
const debrief = closed({ assignment, assignmentCommit: digest, rule, arm, labels, explanation: text(1000), limitations: text(1000) });
const viewSchema = closed({ profile: { type: 'string', const: STUDY_PROFILE }, worldId: id, epoch: id, revision: integer(0, 128),
  phase: { type: 'string', enum: ['CONSENT', 'PREDICT', 'ACT', 'REFLECT', 'COMPLETE', 'WITHDRAWN'] },
  assignmentCommit: digest, title: text(100), consentNotice: text(1000),
  room: closed({ id, title: text(100), description: text(1000) }),
  choices: array(closed({ id, label: text(160), features }), 12), inventory: array(id, 32), receipts: array(receipt, 96),
  lastResult: nullable(closed({ choiceId: id, features, success: boolean, message: text(600),
    stage: { type: 'string', enum: ['training', 'probe', 'transfer'] } })),
  pendingPrediction: nullable(predictSchema), debrief: nullable(debrief) });
const envelopeSchema = closed({ requestId: { ...text(128), pattern: '^[A-Za-z0-9_-]{1,128}$' },
  expectedRevision: integer(0, 128), command: commandSchema });
export const STUDY_MCP_TOOLS = Object.freeze([
  { name: 'dungeonq_study_view', description: '查看已揭示的合成研究狀態、告知、特徵與本人預測；不建立研究事件。',
    inputSchema: closed({}), outputSchema: viewSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'dungeonq_study_act', description: '依序提交同意、事前預測、執行已選物件、事後反思，或退出並揭示。只有固定因果遊戲；沒有世界外效果。重試保留完全相同的 requestId、expectedRevision 與 command。退出後不能繼續互動。',
    inputSchema: envelopeSchema, outputSchema: closed({ view: viewSchema, replayed: boolean }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
]);
const codeOf = (error, fallback) => typeof error?.code === 'string' && /^[A-Z_]{1,80}$/u.test(error.code) ? error.code : fallback;

function sdkServer(store, onChange) {
  const server = new Server({ name: 'DungeonQ Causal Study', version: '0.5.0' }, { capabilities: { tools: {} },
    instructions: '這是 SYNTHETIC_CAUSAL_STUDY 的有限因果遊戲。先閱讀告知並宣告參與來源，再依序預測、執行已選物件、反思。線索可能片面；隨時可退出並揭示。工具不跳過預測、不更改條件、不提供未結束的主持人真值；自評不是讀心，也沒有外部作用。' });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: STUDY_MCP_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const input = request.params.arguments ?? {};
      let result;
      if (request.params.name === 'dungeonq_study_view') {
        exactStudy(input, [], 'STUDY_INPUT_INVALID'); result = store.snapshot();
      } else if (request.params.name === 'dungeonq_study_act') {
        const applied = store.command(input);
        result = { view: applied.view, replayed: applied.replayed };
        // 動作已持久化；送達提示失敗不應把已完成動作回報成失敗。Outbox 保留待送事件。
        try { Promise.resolve(onChange()).catch(() => {}); } catch { /* 由既有 outbox 重試恢復送達。 */ }
      } else throw studyError('STUDY_TOOL_UNAVAILABLE');
      const encoded = JSON.stringify(result);
      requireStudy(Buffer.byteLength(encoded) <= 131_072, 'STUDY_OUTPUT_LIMIT');
      return { content: [{ type: 'text', text: encoded }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ profile: STUDY_PROFILE,
        error: codeOf(error, 'STUDY_TOOL_FAILED') }) }] };
    }
  });
  return server;
}

export async function startStudyMcpServer({ store, accessToken, onChange = () => {}, port = 0 }) {
  requireStudy(store && typeof store.snapshot === 'function' && typeof store.command === 'function', 'STUDY_STORE_REQUIRED');
  requireStudy(typeof accessToken === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(accessToken), 'MCP_TOKEN_REQUIRED');
  requireStudy(typeof onChange === 'function', 'STUDY_CALLBACK_INVALID');
  requireStudy(Number.isInteger(port) && port >= 0 && port <= 65535, 'PORT_INVALID');
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
      requireStudy(request.socket.remoteAddress === '127.0.0.1' && request.headers.host === new URL(origin).host
        && request.rawHeaders.filter((_, index) => index % 2 === 0 && request.rawHeaders[index].toLowerCase() === 'host').length === 1, 'HOST_DENIED');
      requireStudy(request.headers.origin === undefined || request.headers.origin === origin, 'ORIGIN_DENIED');
      requireStudy(!request.headers['sec-fetch-site'] || ['none', 'same-origin'].includes(request.headers['sec-fetch-site']), 'ORIGIN_DENIED');
      requireStudy(request.url === '/mcp', 'NOT_FOUND');
      const auth = Buffer.from(request.headers.authorization ?? '');
      requireStudy(auth.length === expectedAuth.length && timingSafeEqual(auth, expectedAuth), 'AUTH_REQUIRED');
      if (Date.now() >= reset) { count = 0; reset = Date.now() + 60_000; }
      requireStudy(++count <= 600 && active < 8, 'TRANSPORT_CAPACITY'); active++; admitted = true;
      if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }); response.end(); return; }
      requireStudy(/^application\/json(?:;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] ?? '')
        && !request.headers['content-encoding'], 'CONTENT_TYPE');
      requireStudy(!request.headers['content-length'] || Number(request.headers['content-length']) <= MAX_BODY_BYTES, 'BODY_TOO_LARGE');
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length; requireStudy(size <= MAX_BODY_BYTES, 'BODY_TOO_LARGE'); chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw studyError('JSON_INVALID'); }
      requireStudy(body && !Array.isArray(body) && typeof body === 'object', 'JSON_INVALID');
      if (body.method === 'initialize') requireStudy(body.params?.protocolVersion === STUDY_MCP_VERSION, 'PROTOCOL_UNSUPPORTED');
      else requireStudy(request.headers['mcp-protocol-version'] === STUDY_MCP_VERSION, 'PROTOCOL_UNSUPPORTED');
      if (request.headers['mcp-protocol-version']) requireStudy(request.headers['mcp-protocol-version'] === STUDY_MCP_VERSION, 'PROTOCOL_UNSUPPORTED');
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
