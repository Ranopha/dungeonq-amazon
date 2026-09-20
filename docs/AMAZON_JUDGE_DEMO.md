# Amazon judge demo — September 20, 2026

This companion records real, benign MCP and HTTP operations against a newly created **artificial local reference**. It does not connect to Alexa, a model, or production. Output is safe to inspect: generated bearer credentials and the actual ticket are omitted.

```sh
npm ci --ignore-scripts
node scripts/judge-demo.mjs /absolute/path/new-report.json
```

Use Node.js 24.15.0+. Choose a new output filename. The script creates its own private temporary fixture, connects via the MCP SDK, verifies a shared record through HTTP, applies a separate owner-fixture grant, consumes a ticket, closes and restarts the services, verifies exact retry behavior, and checks independent evidence. It stops its own services and removes only its temporary fixture. Failed assertions exit nonzero.

The recorded output is `dungeonq.judge-demo/v1`; its seven scenes retain observed timestamps and selected operation results. Film output excerpts are reformatted, not screen recordings or recreated product UI. The operator action is a separate credential supplied by the script, not proof of independent human review. This narrow walkthrough is **not** the full `runtime:gate`, a container acceptance run, or a live-model efficacy study.

The runtime baseline is v0.11.1. The companion is a subsequent presentation/reproduction addition and does not change runtime behavior. Prior signed reports, release tags and films remain intact.

For manual operation, see [JUDGE_ROUTE.md](JUDGE_ROUTE.md). For the stronger isolation profile, follow [the container guide](../deploy/runtime-reference/README.md).

Fresh September 20 command-output evidence: [recorded JSON](../evidence/judge-demo/2026-09-20.json). Seven walkthrough scenes and seven final independent checks passed. This is separate from prior container evidence.

[September 20 English film](https://youtu.be/ttlfnyuuTIs): 165.167 seconds, recorded command outputs, with the limitations above.
