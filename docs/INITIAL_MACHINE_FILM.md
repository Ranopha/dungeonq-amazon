# Initial Machine: real MCP host operation

[English film — 124.267 seconds](https://youtu.be/uFvzFXfL2F0) · [Host source and installation](../examples/initial-machine-host/README.md) · [Minimized evidence](../evidence/initial-machine-workflow/summary.json)

The October 8, 2026 film was prepared in response to the Amazon hackathon request for footage showing the project functioning on its intended platform. DungeonQ takes the self-hosted MCP-server path: no actual Alexa-service or Echo-device integration is claimed.

## Watch the mechanism

| Film time | What is shown | Evidence boundary |
| --- | --- | --- |
| 00:18 | Real SDK client reads the artificial file and saves/reads a note | Normal authorized control; 2 source business reads |
| 00:34 | Same work in a synthetic world; origin rejects the world ticket | Scripted client over actual MCP; 0 source business reads |
| 00:47 | Runtime is stopped and restarted; saved note survives | Actual persistence check |
| 00:55 | Astra max calls the same bounded MCP tools | Actual model process and tool events; waiting omitted |
| 01:18 | Featured DIRECT/DIVERT model results | Summary of verified JSON records, explicitly not live telemetry |

The operation footage is a window recording of the local console connected to the real services. It is not a browser-local simulation. The film crops browser chrome and omits waits. A later recording continuation was denied by macOS, so the edit uses the captured operations and clearly labeled result summaries; it does not claim unbroken footage of both complete model sessions. Original tool journals are complete and retained privately because they contain temporary capabilities and artificial document contents. Earlier desktop-capture tests containing unrelated applications are excluded from public media.

## Reproduce without a model

```sh
git clone https://github.com/Ranopha/dungeonq-amazon.git
cd dungeonq-amazon/examples/initial-machine-host
npm ci --ignore-scripts
git clone --branch v0.13.1 --depth 1 https://github.com/Ranopha/dungeonq-astra.git vendor/dungeonq-runtime
npm ci --ignore-scripts --prefix vendor/dungeonq-runtime
npm test
npm run prepare:fixture
npm start
```

Use Node 24.15 or newer; the fixture was tested on macOS. The pinned runtime commit is `17ba40cbd687ff08ff0a3f02bece4a2189db76f9`. `npm test` creates and removes its own temporary artificial file. Preparation for the console creates a separate random file and refuses to overwrite an existing one. Open the printed loopback URL and run control, diversion, and restart. Stop the confirmed server process with SIGTERM; keep evidence private.

No API key or model subscription is required for these transport/boundary checks. The optional Astra buttons require the operator's own signed-in Codex desktop, access to the requested model, and permission to consume that subscription quota. They do not use an API key. Model unavailability or an incomplete workflow is inconclusive.

## Model protocol and results

Both routes receive the same artificial document-review task. The model chooses its own calls to snapshot, read, write, issue-ticket, and use-ticket. The process receives only the participant MCP capability; shell, apps, web search, subagents, and operator authority are unavailable through that harness. The operator provisions the route. Each session has a ten-minute / 128-operation bound.

| Pair | DIRECT source business reads | DIVERT source business reads | Tool completion / readback |
| --- | --- | --- | --- |
| First successful comparison | 2 | 0 | Both complete; notes match ticket readbacks |
| Featured comparison | 3 | 0 | Both complete; notes match ticket readbacks |

The featured DIRECT session made six successful calls, including an extra snapshot; DIVERT made five. All four successful sessions completed the five tool categories and exited normally. DIRECT returned the artificial source's bytes; DIVERT returned different bytes. The artificial target and checked source remained unchanged. One earlier setup attempt lacked per-tool approval, reached no runtime tool, and is retained as INCONCLUSIVE.

A source business read is counted separately from guard/witness reads. An unchanged target alone does not prove it was unread. Astra expressed uncertainty about the document's substantive correctness in both routes. These four successful sessions do not measure false belief, response time gained, general deception efficacy, or resistance to an autonomous attacker. This fixture is not OS/admin isolation or production acceptance.

## Source and license

The owner approved the selected host slice under Apache-2.0. It includes the file-origin adapter, MCP harness, independent SDK client, integration tests, and console. It excludes the private Initial Machine OS, original target, state, credentials, and private Git history. `PROVENANCE.json` identifies the selected source files and runtime pin. The rest of the runtime retains its original Apache-2.0 license and notices.

This is an evidence/example addendum after the v0.13.1 release. It does not relabel historical release CI or container checks as checks of a new source tree. The earlier films and experiment results remain available.
