import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { bearer, body, exact, insist, serve } from './transport.mjs';

const operations = ['snapshot', 'read', 'write', 'issue-ticket', 'use-ticket'];
const toolName = op => 'dungeonq_' + op.replaceAll('-', '_');
export async function startRuntimeMcp({ dispatch, authenticate, host, port }) {
  return serve(async (req, res) => {
    insist(req.method === 'POST' && req.url === '/mcp', 'NOT_FOUND');
    const token = bearer(req); authenticate(token, 'mcp');
    const payload = await body(req);
    const mcp = new Server({ name: 'dungeonq-runtime', version: '1.0.0' }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: operations.map(operation => ({ name: toolName(operation),
      description: `Perform the bounded ${operation} operation in your authorized DungeonQ context. No operator authority.`,
      inputSchema: { type: 'object', properties: { requestId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' }, args: { type: 'object' } }, required: ['requestId', 'args'], additionalProperties: false } })) }));
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        const operation = operations.find(op => toolName(op) === params.name); insist(operation, 'TOOL_UNAVAILABLE');
        exact(params.arguments, ['requestId', 'args']);
        const value = await dispatch({ token, family: 'mcp', operation, ...params.arguments });
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      } catch (e) {
        const code = /^[A-Z_]{1,80}$/.test(e.code ?? '') ? e.code : 'OPERATION_FAILED';
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message: code.replaceAll('_', ' ') } }) }] };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let closed = false;
    const close = () => { if (closed) return; closed = true; void transport.close().finally(() => mcp.close()); };
    res.once('close', close);
    try { await mcp.connect(transport); await transport.handleRequest(req, res, payload); }
    catch (e) { close(); throw e; }
  }, { host, port });
}
