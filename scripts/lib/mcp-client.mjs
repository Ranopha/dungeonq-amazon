import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// A separately running client has only a worker transport token, never a human handle.
export async function connectLocalMcp({ endpoint, accessToken }) {
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/mcp'
    || url.username || url.password || url.search || url.hash || !/^[A-Za-z0-9_-]{43}$/u.test(accessToken ?? '')) {
    throw new Error('LOCAL_MCP_CONFIGURATION_REQUIRED');
  }
  const client = new Client({ name: 'DungeonQ-external-client', version: '0.4.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` }, redirect: 'error' }
    }), { timeout: 5000 });
    return {
      list: () => client.listTools(undefined, { timeout: 5000 }),
      async call(name, args = {}) {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
        return { failed: result.isError === true, data: result.structuredContent ?? JSON.parse(result.content[0].text) };
      },
      close: () => client.close()
    };
  } catch (error) { await client.close(); throw error; }
}
