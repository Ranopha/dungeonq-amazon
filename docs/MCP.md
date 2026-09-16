# MCP client/server contract

`server/mcp.mjs` uses the official `@modelcontextprotocol/sdk` **1.30.0**. Initialization and subsequent HTTP requests negotiate **2025-11-25**. Transport is **Streamable HTTP**, stateless, with JSON responses. POST `/mcp` is supported; GET/DELETE return 405. The server has no approval, user-management, bootstrap, arbitrary-code or file-write tool.

| Tool | Input | Authority |
|---|---|---|
| `dungeonq_status` | `{}` | This lab worker's tenant and requests |
| `dungeonq_simulate` | `{scenarioPack}` | Pure admitted synthetic analysis |
| `dungeonq_response_request` | `{requestId,eventId,assetId,expectedVersion}` | Request only; fresh registered observation required |
| `dungeonq_effect_apply` | `{requestId}` | Exactly scoped, separately human-approved effect |
| `dungeonq_receipt_verify` | `{receipt}` | Signature/read-back check against the server's pinned key |
| `dungeonq_evidence_export` | `{requestId}` | Own request, receipt and public verification metadata |

All inputs are closed objects. Tool outputs contain `profile: SYNTHETIC_ONLY` and a structured result. Tool failures return `isError: true` with a typed code. Transport failures use HTTP status codes and a trace ID. The authoritative schema is exported as `MCP_TOOLS` and delivered unchanged by `tools/list`.

## External local client

For the runnable 0.4.0 client, complete approval-boundary walkthrough and optional Codex configuration, use [Bring a separate MCP client or Codex](EXTERNAL_AGENT.md).

Start the lab first. Read **only the MCP access token** from your own private `local-instance.json`; do not give the human password, private signing key or entire file to an agent. Supply that token to a trusted client as `DQ_MCP_TOKEN` in its local environment, without storing it in a repository or pasting it into a chat.

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'my-local-test-client', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(
  new URL('http://127.0.0.1:4187/mcp'),
  { requestInit: { headers: { Authorization: `Bearer ${process.env.DQ_MCP_TOKEN}` } } }
));
console.log(await client.listTools());
console.log(await client.callTool({ name: 'dungeonq_status', arguments: {} }));
await client.close();
```

`tests/mcp-server.test.mjs` is the executable end-to-end client example, including real request/approval/apply/verify behavior. Test fixtures possess a human handle solely to exercise both sides. The runtime assistant does not.

## Evidence verification

Exporting a public key beside a receipt does not make that key trustworthy. Obtain and pin the lab public key and key ID through your own trusted lab before receiving an artifact. Then verify the signed receipt offline:

```sh
npm run verify:assistant-evidence -- evidence.json trusted-public-key.pem trusted-key-id
```

This checks the signed receipt only, not the export envelope or truth of an external event. Changing the receipt, supplying the wrong pinned key, or receiving an unsigned result fails. Never upload a private key. The in-UI tamper demonstration changes a copy, leaving the original durable receipt intact.
