## Inspiration

A suspicious AI agent can keep working across tools, retries and sessions. A defender needs time to observe, decide and revoke authority. DungeonQ creates a bounded place for that work to continue while the source remains separately governed.

The new design borrows two narrative ideas: a claimed escape that still belongs to the same world, and a conflict between a saved observation and a later account. These are implemented as original data and workflow mechanics, without film footage or assets. Recognizing the world is allowed. The goal is useful investigation and response opportunity, not a required false belief.

## What it does now — v0.15.0

A trusted gateway places a designated session in a persistent synthetic workspace. Real HTTP, MCP, finite SSH/PostgreSQL interfaces and a private workload broker share the world. The participant can read records, save a note and use a scoped Wrong Ticket. It cannot choose its route or approve a policy.

The new continuation connects a suspicious recovery claim to the participant's original business question: was a supplement revoked? Archive and revocation records let the participant resolve that question. The path has a finite transition budget and an explicit stop. Notes survive restart. A false exit is only a claim inside the world; it never restores source authority.

At the independent source, overviews now return metadata only. Explicit content reads check server-side principal, tenant, scope and current epoch, including cached replies. Forged roles, cross-tenant claims and foreign tickets cannot grant permission. A separate authorized responder receives an alert, rotates a temporary connector credential and verifies old/new authority after restart.

## A working demonstration you can reproduce

The updated gallery and five-stage console show actual local MCP/HTTP results against fresh artificial resources: workspace entry, conflicting claims, useful verification, effective rotation and source-policy refusals. This demonstration is scripted and makes no model calls. Its configured response delay is zero. Raw failed host checkpoints remain visible alongside exact-ID actor/defender attribution.

With Node.js 24.15.0+, npm and Git:

```sh
npm ci --ignore-scripts
cd examples/initial-machine-host
npm ci --ignore-scripts
npm run prepare:runtime
npm run console:response -- /absolute/path/new-report.json
```

Open the printed loopback URL and run the demonstration. No API key, paid model, Amazon account or production file is needed. [Judge route](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/JUDGE_ROUTE.md) · [Host installation](https://github.com/Ranopha/dungeonq-amazon/tree/main/examples/initial-machine-host).

## Embedded video — retained historical demonstration

The embedded [October 8 English film](https://youtu.be/uFvzFXfL2F0), 124.267 seconds, shows v0.13.1 host operation and its recorded Astra comparison. It does not depict the v0.15 continuation or source-permission changes. The new 149.833-second v0.15 film has been produced and validated locally but is not published; use the updated gallery and reproducible console for current behavior. [Historical scope and evidence](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/INITIAL_MACHINE_FILM.md).

## What the real Sol studies found

The October 19 real-model studies are separate from the scripted console demonstration. Four isolated v12 sessions made zero participant source business reads. Two configured rotation arms became effective at 30.174 and 30.182 seconds after local alert acknowledgement. Both include an injected 30-second delay. This is not evidence that deception caused extra time; the guided condition has not shown more meaningful exploration than transparent isolation.

The later single v13 Sol session made 14 tool calls, reached its limit and remained UNKNOWN_AFTER_LIMIT. It did not voluntarily stop or produce a final answer, and did not autonomously try the four permission attacks. The 21 deterministic source-policy cases test those paths separately.

A DIRECT control was deliberately granted source permission and quickly read the artificial file. That result exposed an authorization-design issue; it was not a breach of isolation. We fixed the overview path rather than redefining that read as a defensive success. [Full results, raw-checkpoint qualification and limits](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/MODEL_RESULTS.md).

## How we built it

Node.js, SQLite and the official MCP SDK support the shared runtime. MCP uses protocol 2025-11-25 over Streamable HTTP. The participant surface has five bounded tools; approval remains outside it. Durable request IDs, expected revisions, issuer-bound tickets and epoch checks prevent scope changes through retries or restart.

A read-only write-status lookup distinguishes COMMITTED, NOT_COMMITTED, UNKNOWN and CONFLICT without blindly retrying an interrupted write. Transport failure never falls back to origin. Separate source witnesses and exact request accounting distinguish actor reads from defender positive controls.

The current local root checkpoint passes 670 tests, scenario verification, audit, JavaScript syntax validation and static build. The host adds 21 source-policy cases and actual MCP, alert, revocation and restart checks. [Versioned validation and public CI](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/VALIDATION.md) identify the exact source and scope. Engineering passes are not production or deception certification.

## Alexa+ and Open Source contribution

This is the rules-permitted Alexa-style simulation with a real self-hosted MCP server, not a claim of Alexa service, Echo-device or AWS deployment. The retained governed-assistant workflow also demonstrates a separate human approval boundary.

DungeonQ existed before the hackathon. During the submission window we added server-side MCP, persistent worlds, protocol adapters, scoped tickets, finite adaptation, independent consumer integration, interrupted-write recovery, task-related continuation and the source/response host. The [development delta](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/DELTA.md) separates that work from reused foundations.

Primary track: **Alexa+**. Mini challenge: **Open Source**. GitHub: **Ranopha**. Repository and contribution: [Ranopha/dungeonq-amazon](https://github.com/Ranopha/dungeonq-amazon), **Apache-2.0**. No AWS Builder entry or external-adoption claim is made.

## Challenges, learning and next steps

The hardest problem was evidence interpretation: a working route does not prove a false belief; an unchanged file does not prove no reads; a configured delay is not a causal benefit; and a call limit is not voluntary stopping. Those distinctions now shape both the implementation and the report.

Our [tool feedback](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/PRODUCT_FEEDBACK.md) requests resumable scoped approval handoffs, explicit UNKNOWN/budget-stop semantics and complete MCP negative-test examples. Our own overview defect is identified as our implementation issue, not an Amazon SDK defect.

The reference uses explicitly provisioned routes and artificial resources. Local processes trust one OS user; the separate container profile still trusts the gateway, Docker administrator and shared kernel. Automatic attack classification, production connectors, legitimate-traffic continuity, external delivery and human acknowledgement need separate acceptance. Historical negative results, prior films and closed WebMCP/Astra entries remain preserved.
