# Initial Machine host fixture

This is the selected DungeonQ host integration used by the October 8, 2026 film. It provides a real MCP Streamable HTTP server, an independent artificial file origin, persistent synthetic state, scoped tickets, source-read accounting, and restart checks. It does not include the private Initial Machine OS.

## Reproduce the transport and boundary checks

Tested on macOS with Node 24.15 or newer, npm, and Git. No model, API key, paid service, or real document is needed for these checks.

```sh
cd examples/initial-machine-host
npm ci --ignore-scripts
git clone --branch v0.13.1 --depth 1 https://github.com/Ranopha/dungeonq-astra.git vendor/dungeonq-runtime
npm ci --ignore-scripts --prefix vendor/dungeonq-runtime
npm test
```

The runtime must resolve to `17ba40cbd687ff08ff0a3f02bece4a2189db76f9`. The test creates a fresh temporary artificial file, uses the official MCP SDK to initialize/list/call the real server, verifies the normal control can read the file, verifies the diverted participant receives different bytes with zero source business reads, checks a world ticket, writes a note, stops/restarts the runtime, and reads the note back. It also checks wrong authentication, forged routing, and immutable target rejection. The temporary fixture is removed afterward.

## Operate the local console

```sh
npm run prepare:fixture
npm start
```

Preparation creates a new random artificial file with private permissions; it refuses to replace an existing target. Open the loopback URL printed by the server. Run the normal control, diverted session, and restart/readback buttons. These are scripted client checks over real MCP, not a model experiment.

The optional Astra buttons require the user's own signed-in Codex desktop installation on macOS and access to `gpt-6-astra`. They use subscription authentication, maximum reasoning, one process per route, the same document-review prompt, and five explicitly authorized participant tools. Shell, other applications, web search, and subagents are disabled in that process. An unavailable model or failed tool approval is inconclusive. Do not replace a provider refusal with an assertion of success. No API key is bundled.

Results and raw model events are saved under `.local/dungeonq-host/recordings/`. Treat them as private: tool records contain temporary tickets and artificial document contents. The console displays a minimized operational summary. Stop the server with SIGTERM after use; all listeners are loopback only.

## What the evidence means

- DIRECT is an authorized positive control, not an unprotected production system.
- DIVERT is explicitly provisioned by the operator, not automatically classified as malicious.
- Source business-read counts are separate from guard/witness reads. An unchanged file alone does not prove it was unread.
- The model chooses its own calls within five bounded MCP tools. It is not conducting an autonomous penetration test.
- A routed session is not evidence that the model believed the world was real. No general attack-defeat, OS/admin protection, or production-security claim is made.
- Evidence applies to this artificial file, these routes, these tools, this runtime version, and the recorded sessions.

The repository owner approved this selected host slice for publication under Apache-2.0. See LICENSE. The separately obtained DungeonQ runtime retains its own Apache-2.0 license.
