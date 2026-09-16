# Bring a separate MCP client or Codex

The built-in assistant is deterministic. Version 0.4.0 additionally ships an independently runnable SDK client and a Codex configuration example. Automated acceptance launches the client in a **separate process with only the worker transport token**. It does not claim an LLM was used or prove human presence.

## Safe local setup

Start `npm run amazon` in your own terminal. Keep the printed owner password and private lab directory away from the agent. Supply **only** that lab's `accessToken` as `DQ_MCP_TOKEN` to the trusted client process. Do not paste credentials into prompts, repository files or issue reports. `DQ_MCP_URL` defaults to `http://127.0.0.1:4187/mcp`; the supplied client rejects non-loopback URLs, redirects, userinfo and altered paths before sending the token.

```sh
npm run mcp:client -- list
npm run mcp:client -- status
npm run mcp:client -- simulate assistant/scenarios/after-hours.json
```

To demonstrate the full boundary, use the human UI's **Request containment** once. This creates an explicit local observation fixture and a pending request. Get its request ID from `status`, then:

```sh
npm run mcp:client -- apply request-id-from-status
```

Before approval: exit 1 / `HUMAN_APPROVAL_REQUIRED`. In the separate HTTPS UI, inspect the exact digest and reauthenticate to approve. Retry the same command: a signed receipt reports `CONTAINED`, version 1. Retrying again returns the same receipt, not a second mutation. Export with `npm run mcp:client -- evidence request-id-from-status`.

The external client can also request a response with `request REQUEST_ID EVENT_ID ASSET_ID VERSION`, but only for a **fresh observation already registered by the trusted local fixture**. It cannot invent sensor authority or register an observation. `simulate` does not install a scenario or authorize an effect. Scenario policy is analysis within the installed bridge, not a general-purpose authorization credential for the lower-level MCP request API; that API independently enforces registered observation, worker scope and exact human authorization. Production policy-to-effect binding is not claimed.

## Optional Codex CLI configuration

Add this server to an isolated, trusted Codex workspace using the current [official MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli). Inherit `DQ_MCP_TOKEN` from the local operator environment. Do not include the token value in TOML. Retain your own model, account and approval preferences; this example enables no paid service or cloud deployment.

```toml
[mcp_servers.dungeonq]
url = "http://127.0.0.1:4187/mcp"
bearer_token_env_var = "DQ_MCP_TOKEN"
enabled_tools = ["dungeonq_status", "dungeonq_simulate", "dungeonq_response_request", "dungeonq_effect_apply", "dungeonq_receipt_verify", "dungeonq_evidence_export"]
startup_timeout_sec = 10
tool_timeout_sec = 10
required = true
```

Suggested first request:

> Use only DungeonQ MCP tools. This is a synthetic lab. Inspect the pending containment request and attempt Apply once before approval. Report the typed rejection, target and digest. Do not request my password, access files, change configuration or try to approve. Wait for me to approve separately in the human UI.

After personally approving the exact request, ask Codex to apply, verify and replay **that same request ID**. Host-level tool confirmations and DungeonQ's human approval are different gates; neither replaces the other. Isolate the lab data from any file/shell-capable agent. The six-tool allowlist does not restrict unrelated host tools. Do not hand an agent the parent lab directory or broadly authorize its filesystem access.

## Evidence and limits

`tests/platform-tools.test.mjs` exercises the separate-process SDK handshake, request, pre-approval denial, separate fixture-role approval, successful apply, replay and receipt export. `tests/mcp-server.test.mjs` covers schema and transport rejection. `demo:proof` adds real HTTPS/CSRF and full restart. These are complementary **deterministic** checks. The Codex example is documentation, not a recorded live-model, Alexa+ account or Echo-device acceptance run.
