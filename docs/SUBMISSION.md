# Amazon submission copy — v0.13.0

## Name

DungeonQ — Defensive Deception for AI-Agent Workflows

## Elevator pitch

Give suspicious AI-agent sessions a persistent synthetic world to work in, creating time and space for people and authorized defender agents to observe and prepare a bounded response.

**Publication status:** this is prepared copy. Current source checks, public CI, release artifacts and media must be read back in [VALIDATION](VALIDATION.md). Saving this file does not update the external entry.

## Inspiration

An AI agent can keep working across tools, retries, and sessions. For security teams investigating suspicious behavior, a useful defensive environment needs to preserve that continuity and show what actually happened.

DungeonQ explores that problem through a persistent synthetic world. A designated session can perform useful, bounded work there while a separate operator follows its activity and controls any adaptation. The objective is to create response time and separation for human operators and authorized defender agents. The reference makes the mechanism inspectable; it does not yet measure time gained or establish defensive efficacy.

## What it does

Start with a shipping-record review. A participant reads the record, saves a review note, obtains a world-scoped ticket, and returns after a restart. The note stays available across supported clients. The English Participant workspace saves multiline findings and reads them back through a separate HTTP request. In the separate Control room, the operator sees the same records, canonical observations and a request timeline, approves a finite follow-up policy and checks the artificial origin. Neither interface stores runtime authority in browser storage.

DungeonQ provides real HTTP, MCP, bounded SSH and PostgreSQL interfaces, plus a private managed-workload broker. They reach the same persistent synthetic world. The trusted setup determines which contexts are diverted; the participant cannot choose its own route or grant itself operator authority.

A **Wrong Ticket** is useful inside its issuing world: it permits a scoped read with expiry and a durable use count. It grants no authority over the protected origin. After a separate operator grant, first-time ticket use can trigger a bounded follow-up record. An exact retry returns its previous canonical result without consuming the ticket again. An earlier uncertain route outcome remains visible and prevents clean acceptance.

## Current integration and film

v0.13.0 adds a [standalone MCP shipping consumer](https://github.com/Ranopha/dungeonq-amazon/tree/main/examples/mcp-shipping-consumer) with its own package. It talks to public MCP/HTTP using only actor authority; the harness keeps operator observations and artificial-origin checks in separate roles. A defender agent could consume appropriately scoped evidence or propose action, but cannot approve its own proposal. The example is maintained by this project and is not a third-party adoption claim.

**Current English film:** [Watch the v0.13.0 integration film](https://youtu.be/8h5yeKb2XzE), 130.67 seconds with English subtitles. It follows the recorded standalone consumer run; the September 20 film below remains a historical demonstration.

<details>
<summary>Historical September 20 runtime film — v0.11 companion scope</summary>

## Watch one task cross the system

[Watch the September 20 English runtime film](https://youtu.be/ttlfnyuuTIs), approximately 2 minutes 45 seconds.

The recorded walkthrough shows:

1. A real MCP client connects and discovers five bounded participant tools.
2. A designated request reaches the synthetic world.
3. MCP writes a shipping-review note; HTTP reads that same server-side record.
4. A separate owner fixture previews and explicitly applies a finite adaptation grant.
5. A world-scoped ticket reads the note and triggers one permitted follow-up.
6. The services restart; records remain, and the exact retry returns the prior result.
7. Artificial-origin and collector readbacks independently check the recorded activity.

The film presents actual command outputs reformatted for readability. It uses deterministic clients and a scripted owner fixture, rather than a live model or an independent human reviewer. Its [recorded evidence and reproduction guide](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/AMAZON_JUDGE_DEMO.md) identify that scope.

</details>

## How we built it

Node.js, SQLite, and the official MCP SDK support a shared runtime. The MCP server implements **MCP 2025-11-25 over Streamable HTTP**. Participant operations are limited to snapshot, read, write, issue-ticket, and use-ticket. Operator approval is absent from that tool surface.

The gateway, synthetic facade, canonical state, artificial origin, and evidence collector have distinct responsibilities. Writes check the expected revision. Ticket authority is bound to its context, world, scope, epoch, expiry, and use budget. Durable records preserve state and exact retries across restart.

Operator changes follow preview, review of the exact proposal, explicit apply, and persisted readback. A failed synthetic transport does not fall back to the origin. Authenticated canonical refusals now distinguish a known rejected attempt with no new effect from UNKNOWN transport or response-loss outcomes. A stale write cannot overwrite a newer record. Even if a write committed before its response was lost, the outcome stays UNKNOWN and prevents a clean acceptance claim; an unsigned error string cannot make it pass.

## Why Alexa+ and Open Source

An assistant ecosystem needs useful tools with a clear limit on their authority. DungeonQ contributes a self-hosted MCP runtime that developers can run and inspect through real clients. A retained Alexa-style simulated assistant profile also demonstrates the earlier governed investigation and separate approval workflow.

This entry does not depend on the gated Alexa+ preview tools. It claims a working MCP server and an inspectable local reference, not an integration with the actual Alexa service or an Echo device.

The project existed before this hackathon. The [development delta](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/DELTA.md) separates reused WebMCP foundations from work added during the submission window: server-side MCP integration, durable request binding, persistent worlds, protocol adapters, scoped tickets, finite adaptation, tests, and reproduction guides. The September 20 companion adds a concrete cross-protocol task and film. The September 29 v0.12.0 source update added the participant/operator working views, multiline notes, authenticated refusal handling and ten reproducible checkpoints with positive and negative controls.

The v0.13.0 adds an independently packaged public-interface consumer, separate-role integration checks, reproducible installation, a trial-feedback template and an explicit maintenance plan. It does not claim established external adoption. See [the contribution table](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/DELTA.md).

**Primary track:** Alexa+
**Mini challenge:** Open Source
**GitHub username:** Ranopha
**Repository and contribution:** [Ranopha/dungeonq-amazon](https://github.com/Ranopha/dungeonq-amazon), Apache-2.0.
**AWS Builder:** No AWS integration is claimed.

## Challenges and what we learned

The difficult part is preserving meaning when a client changes tools, a response is lost, or a process restarts. A successful synthetic action must remain scoped to that world. An exact retry must retrieve the previous outcome without silently repeating the effect. The operator needs recorded evidence beyond the participant's explanation.

We also learned to separate engineering results from behavioral conclusions. A coherent world and a working ticket demonstrate mechanisms. They do not establish that an attacker or AI believes the world is real. Earlier negative study results remain available rather than being replaced by a broader success claim.

## Reproduce the walkthrough

With Node.js 24.15.0 or newer, clone the public repository and run:

```sh
npm ci --ignore-scripts
npm run oss:demo -- /absolute/path/new-report.json
```

Choose a new output filename. The script creates its own artificial fixture, exercises real local MCP and HTTP requests, checks retained state and independent readbacks, and stops its services. No model subscription or production credential is required.

The retained `node scripts/judge-demo.mjs /absolute/path/new-report.json` command reproduces the v0.12.0 ten-checkpoint route, including an ordinary authorized-origin reachability control, a stale-write refusal and a world-ticket denial before the final origin witness. The ordinary control establishes reachability; it is not an unprotected-attacker or deception-efficacy comparison. The September 20 film retains the earlier seven-scene walkthrough and does not depict the new working views or added checks.

For independent client installation and report interpretation, follow [EXTERNAL_INTEGRATION](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/EXTERNAL_INTEGRATION.md).

For manual operation, follow the [judge route](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/JUDGE_ROUTE.md). The [container guide](https://github.com/Ranopha/dungeonq-amazon/blob/main/deploy/runtime-reference/README.md) covers the separate isolation profile. The walkthrough alone is not a full container acceptance run; [versioned validation](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/VALIDATION.md) identifies the source and scope of broader checks.

## Scope and next steps

The verified scope is an owned reference with artificial resources and explicitly provisioned contexts. Local processes share an OS user; the container profile has a separate measured boundary that still trusts Docker administration and the shared kernel. SSH and PostgreSQL expose finite operations, not a general shell or SQL engine.

The next product work is to evaluate selected model/client sessions with controlled comparisons and implement specifically authorized host integrations. Real deployment requires an authorized connector, detection and identity integration, legitimate-traffic continuity, recovery, and environment-specific acceptance.

DungeonQ does not claim general production protection, automatic attack classification, unrestricted self-adaptation, or established deception efficacy. The original WebMCP submission, prior films, and historical evidence remain preserved.
