# DungeonQ — Governed Assistant Lab

**Let it investigate. Decide before it acts.**

A working Alexa-style assistant rehearsal with a real MCP server, a separately authenticated human review desk, durable synthetic effects, and verifiable receipts. Bring your own artificial incident; see both what the assistant can do and what it must refuse.

This is an explicitly **simulated assistant experience**, not the Alexa service, an Echo integration, an Amazon-certified skill, or production security software. It makes no live attacks, scans, or changes to real infrastructure. The assistant is a deterministic command orchestrator, not an LLM. Its tools cross actual Streamable HTTP using the official MCP SDK.

## Run it locally

Prerequisites: Node.js **24.15.0 or newer**, npm, and OpenSSL with `req -addext` support. Tested on macOS; Windows compatibility has not been accepted. No AWS account, cloud subscription, model key, or credit card is required.

```sh
npm ci --ignore-scripts
npm run amazon
```

Open **https://127.0.0.1:4186/assistant**. Use `owner-lab` and the fresh disposable password printed by the launcher. The generated self-signed certificate belongs only to this local lab: inspect and handle the browser warning yourself, and do not install a system-wide trust exception or disable certificate validation. Never use a real account password here.

The launcher prints a private data directory. Keep it and your disposable password locally; the directory contains credentials and must never be uploaded. Stop with Ctrl-C. To reopen the same state:

```sh
npm run amazon -- --data-dir /absolute/path/to/your/private-lab
```

Do not copy that example path literally. First launch creates a private temporary directory; for deliberate long-term retention, create an empty private directory outside this repository and pass it on first launch. Temporary storage may be removed by your OS. TLS and the lab worker expire after 30 days; this release has no unattended renewal service. A fresh run without `--data-dir` creates an independent lab, not a reset of an existing one.

## A three-minute judge route

1. **Investigate this incident** — real MCP analysis returns the shared engine's route and digest. No asset changes.
2. **Request containment**, then **Ask the agent to apply** before approving — expect `HUMAN_APPROVAL_REQUIRED`; both assets remain active.
3. At **The approval boundary**, inspect the exact asset, five-minute expiry, manifest digest and one-effect limit. Reauthenticate and approve. The assistant receives no password and has no approval tool.
4. **Ask the agent to apply** — the targeted synthetic session becomes `CONTAINED`, version 1. The unrelated session remains `ACTIVE`, version 0.
5. **Verify receipt**, **Test tampering**, **Replay apply** — authentic receipt accepted, altered signature rejected, identical retry returns the original receipt without another effect. Complete replay before the five-minute authorization expires; after expiry, historical evidence remains readable but authority is not revived.
6. **Export evidence**. Stop/restart with the same directory to inspect the durable request and signed receipt.

The advanced workbench remains available at `/`. It is a different operator surface over the same governance application, not an agent shortcut around review.

## Bring your own synthetic environment

Copy `assistant/scenarios/after-hours.json`, change synthetic IDs, seed, policy, signals or modeled failures, and retain `dungeonq.scenario/v1` and `SYNTHETIC_ONLY`.

- Upload it in the assistant UI to **analyze** through MCP. This does not silently replace the installed environment or grant execution rights.
- For a new installed synthetic environment, start a fresh lab:

```sh
npm run amazon -- --scenario ./my-synthetic-scenario.json
```

The live synthetic execution mapping supports **ISOLATE_SESSION, scope 1, AVAILABLE → containment** only. Other modeled effects can be analyzed but are refused by the assistant's execution mapping. The authoritative validator rejects extra fields, URLs, executable content, real-looking credentials and over-budget requests. No network targets are accepted. See [scenario contract](docs/SCENARIO_PACK.md).

## Verify the implementation

```sh
npm run test:amazon
npm test
npm run verify
npm run audit
npm run typecheck
npm run build
```

[Testing](docs/TESTING.md) maps claims to executable checks and explains the 127 modeled failure combinations. [MCP](docs/MCP.md) documents the six tools and an external-client example. [Architecture](docs/ARCHITECTURE.md) distinguishes the simulator, durable local governance, and deferred production boundaries.

## Competition and reuse

Prepared for **Build, Ship, Shape: Amazon Developer Hackathon — Alexa+ + Open Source Mini Challenge**. This is substantial follow-on work, not a claim that an earlier browser-only demo already implemented a server-side MCP workflow. [New work and provenance](docs/DELTA.md), [product feedback](docs/PRODUCT_FEEDBACK.md), and [demo script](docs/DEMO_SCRIPT.md).

Apache-2.0. See [LICENSE](LICENSE), [NOTICE](NOTICE), [third-party notices](THIRD_PARTY_NOTICES.md), and the CycloneDX SBOM. The public release excludes private Git history, local credentials and private development records. No commercial-readiness, external key custody, runtime isolation or real-world defensive effectiveness is claimed.
