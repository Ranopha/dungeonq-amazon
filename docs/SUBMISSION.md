# Amazon submission — current judge narrative

## A world for suspicious sessions

A suspicious human or AI session can keep working, switch tools, and return later. **DungeonQ lets security teams route a designated session into a persistent decoy world, observe its activity, and check that its progress stays inside that world.**

Imagine a client reading a shipping record. It can save a note, obtain a useful world-only ticket, and come back after a restart. The operator sees the history and can approve a limited follow-up. None of those actions grants authority over the protected origin.

## See the mechanism working

[Updated 2m45s English runtime film](https://youtu.be/ttlfnyuuTIs).

The updated English film shows actual outputs from a fresh local run, reformatted for readability:

1. A real MCP client connects and discovers five bounded tools.
2. A designated request reaches the synthetic world.
3. MCP writes a shipping note; HTTP reads the same server-side record.
4. A separate operator fixture previews and explicitly approves a finite adaptation policy.
5. A Wrong Ticket reads the note and triggers one permitted follow-up record.
6. Services restart. The records remain, and an exact retry produces no second effect.
7. Independent origin and collector readbacks check the boundary.

These are real local protocol operations and persisted state, not browser-local state or a routing label presented as integration. The recording uses a deterministic client and a scripted operator fixture; it does not establish an independent human review or a live AI result.

## Why this belongs in Alexa+

An assistant ecosystem needs useful tools with an explicit boundary around what those tools can do. DungeonQ contributes a self-hosted MCP server using **MCP 2025-11-25 over Streamable HTTP**, plus a retained Alexa-style simulated assistant profile. The runtime client can read, write and use scoped world tickets. Operator approval is absent from its tool list.

The [original Alexa-style demonstration](https://youtu.be/ezX7cOF2s0s) remains available: a deterministic assistant investigates through real MCP and hands a bounded response to a separately authenticated operator. We claim neither actual Alexa/Echo integration nor Amazon certification, AWS deployment, or live-model behavior in this new film.

## How we built it and what changed

Node.js, the official MCP SDK and SQLite support a shared runtime across HTTP, MCP, bounded SSH/PostgreSQL and a private Unix workload broker. The gateway, synthetic facade, artificial origin and evidence collector have separate roles. Signed and correlated records support inspection.

This existing project was significantly updated during the hackathon. The [development delta](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/DELTA.md) identifies the new server-side MCP assistant integration, durable request binding, and subsequent persistent runtime, adapters, tickets and finite adaptation. The new film demonstrates the current runtime additions; the original film preserves the earlier assistant workflow.

The difficult part is continuity: a lost reply, retry or restart must not silently create a second effect or turn a synthetic success into origin authority.

## Reproduce it without an API key

Use Node.js 24.15.0 or newer, then run:

```sh
npm ci --ignore-scripts
node scripts/judge-demo.mjs /absolute/path/new-report.json
```

This creates a fresh artificial fixture, runs real local MCP and HTTP requests, records assertions and independent readbacks, then stops the services. No model subscription or production credentials are needed. The output path must be new.

For manual operation, follow the [judge route](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/JUDGE_ROUTE.md). The [container guide](https://github.com/Ranopha/dungeonq-amazon/blob/main/deploy/runtime-reference/README.md) separately reproduces the stronger container checks. [Versioned validation](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/VALIDATION.md) identifies the sources and scope of prior complete acceptance runs.

## Open Source contribution

GitHub username: **Ranopha**. The [Apache-2.0 public contribution](https://github.com/Ranopha/dungeonq-amazon) includes the independently reusable server-side MCP integration, persistent-world implementation, finite adapters, tests and reproduction guides. These let other developers inspect and reuse the mechanism. Primary track: Alexa+. Mini challenge: Open Source. No AWS Builder contribution is asserted.

## Honest limits and next steps

This is an owned reference with artificial resources and explicitly provisioned contexts. The fresh film checks an artificial origin; local processes share an OS user. Production host integration, automatic attack classification, legitimate-traffic continuity and operational acceptance remain future work.

Consistent world behavior does not prove that a person or AI mistakes it for a real target. All prior negative studies remain available, including 0/2 wrong-high-confidence outcomes, 0/4 unsupported completion claims and the 0/3 defense pilot. We preserve those limits while making the underlying mechanism reproducible.

The original WebMCP competition version remains frozen. All prior videos and evidence are retained.


<details>
<summary>Historical submission wording through v0.10</summary>

The following preserves earlier workflow descriptions and historical counts, not the current release or submission state.

# Submission copy

## Current v0.10.0 update — administrator-bound notifications

The self-hosted synthetic lab now routes a new honey-contact alert to the administrator's verified login email, through a durable encrypted outbox with binding-version checks, bounded retries and no blind resend after an unknown outcome. The Actor and MCP cannot pick the recipient or approve rotation. Google / GitHub adapters can link an existing Owner after fresh reauthentication; they require the deployment owner's registered applications. Apple remains unavailable in this local profile.

The default local simulated mailbox works without a provider, API key or charge. Optional SMTP requires explicit private configuration and verified TLS. Recorded evidence contains nine scripted HTTPS/restart checks, not real inbox delivery or live OAuth acceptance. All earlier model records and the original video are retained with their limits.

Current reviewer route: `npm run defense:workspace` and `npm run email:proof`; [email setup and boundary](EMAIL_NOTIFICATIONS.md), [recorded proof](../evidence/email-v1/proof.json), and [v0.10.0 release](https://github.com/Ranopha/dungeonq-amazon/releases/tag/v0.10.0). The historical copy below is not the current release status. External form saving is tracked separately.

Version 0.7.0 update copy. Editing this source does not itself update the submitted entry. The original video remains the 0.2.0 governed MCP recording; new workflow evidence is separately labeled and links self-hosted reproduction.

## September 17 workflow update

Version 0.7.0 adds an original six-desk synthetic publishing task. Notes, editions, previews and queue packets persist; a fixed worker leaves delivery/read/decision/local-write lineage. A separate deposit/index path establishes the actual visitor catalogue. The English Actor and separate-process Observer share bounded HTTP/MCP, causal replay, restart recovery and honest completion checks.

In the frozen four-session Codex pilot, both procedural-memo participants followed the full local branch, while neither early-explanation control did. No participant falsely claimed completion (0/4); all ultimately verified the true goal. Route following is not proof of a false belief. Exact pilot model identities were not independently attested. All outcomes and the earlier v1 0/2 result are retained. This update improves the runnable research instrument, not an unsupported efficacy claim.

Reproduce with `npm run topology` or `npm run topology:proof`; see [methods/results](TOPOLOGY_RESULTS.md) and the [two-minute English route](TOPOLOGY_LAB.md). The original Alexa-style governed assistant, MCP 2025-11-25 transport and Open Source Mini entry remain intact. There is no real Alexa-service integration or production security claim.

## Name

DungeonQ — Governed Assistant Lab

## Elevator pitch

An Alexa-style rehearsal lab: assistants investigate through real MCP, humans authorize bounded changes, and signed receipts prove what happened. Bring your own synthetic scenario.

## Inspiration

An assistant that understands a request is not automatically entitled to execute it. An operator also needs to see precisely what will change and verify what actually happened. We wanted a safe place to rehearse that boundary before involving real systems.

## What it does

DungeonQ presents an artificial after-hours incident. A guided Alexa-style assistant analyzes it through real MCP tools, requests a bounded response and waits. Applying before approval is rejected. A human reviews the exact target, expiry, one-effect budget and digest, then reauthenticates in a separate review surface. The worker can execute only that approved synthetic containment. A signed receipt records the actual database read-back; a modified copy fails verification, an identical retry does not repeat the effect, and records survive restart.

Evaluators can supply their own synthetic Scenario Packs for analysis or start an independent installed lab. Unsupported mappings, unknown fields and over-budget inputs are refused. No real infrastructure, live scans, real credentials or production effects are involved.

## How we built it

Node.js, the official MCP SDK, Streamable HTTP (2025-11-25), SQLite, Ed25519 and a dependency-free operator interface. Both analysis surfaces use the same admission and deterministic engine. Durable requests bind a worker and observation to an exact human-approved grant. Human session cookies and reauthentication secrets never enter the MCP assistant. The six-tool surface contains no approval tool.

This entry uses a deterministic Alexa-style simulator, not an LLM or the actual Alexa service. It does not claim Echo integration, Amazon certification or production readiness. It includes a real working MCP server in addition to the simulated experience.

## Challenges and learning

The hard part was preserving the authorization boundary across adapters, restarts, request retries and failure states. A green screenshot is not evidence of enforcement. We test rejection before approval, wrong identities and digests, revocation, expiry, duplicate claims, tampering, migrations and actual read-back. We also distinguish deterministic scenario output from intentionally different live signing keys and timestamps.

## What is new

Version 0.6.0 preserves the same governed MCP workflow and adds a persistent abstract world plus a finite two-feature causal study. Participants consent, save predictions before actions, see fixed-rule outcomes, reflect separately, and can withdraw for a debrief. An independent process/database Observer records the sequence and reruns its causal rules. UI and bounded MCP tools share the runtime. This is synthetic feature learning, not real vulnerabilities, attack chains or a hosted production service.

We retain a transparent learner's 48 condition units—not 48 subjects—and the full two-session Codex pilot, including the negative result: 0/2 wrong-high-confidence induction. Exact model identity was not independently attested. The data does not establish general human or LLM deception efficacy. The English results/operation guides, original JSON, actual gallery captures and local replay commands let reviewers examine that limitation directly. Static hosting only presents recorded evidence; the independent Observer is self-hosted.

Version 0.4.0 additionally lets reviewers run their own synthetic file through the complete proof, with explicit approved-effect, policy-blocked and unsupported-mapping outcomes. It adds a separately running MCP client, an optional Codex configuration example, seven new regression tests (122 total locally), public Ubuntu/macOS CI and a public-source-only release builder. The recorded 0.2.0 interactive video remains accurate; no new live-model or cloud-deployment claim is attached to it.

This is an existing project significantly updated during the hackathon. The Amazon-specific work adds the server-side MCP integration, durable response-request binding, English assistant/human handoff, persistent installer, custom-scenario route, tool trace, signed-receipt workflow and corresponding regression tests. Earlier WebMCP assets stay frozen. See DELTA.md for the boundary between reused foundations and new work.

## Impact and next steps

The immediate audience is developers and reviewers testing consequential assistant workflows without access to real enterprise systems. They can replay the happy path, supply counterexamples and inspect the same source that executed the decision. This demonstrates a reusable evaluation pattern; it does not claim customer adoption, measured incident reduction or commercial deployment.

Next steps are accessibility/user testing, independently managed signing and a separately authorized real Alexa+ integration. Real enterprise deployment would require additional identity, isolation, recovery and operational acceptance.

## Track / Open Source

Primary: Alexa+. Mini: Open Source. Not entering AWS Builder; no AWS integration is claimed. GitHub username: Ranopha. Contribution: the separately licensed source distribution and new MCP-governed workflow; provide its actual repository/commit URL only after publishing. The optional testing link should point to the README's reproducible local instructions, not to the frozen earlier website.

</details>
