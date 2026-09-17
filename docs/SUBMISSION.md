# Submission copy

Version 0.6.0 update copy. Editing this source does not itself update the submitted entry. The original video remains the 0.2.0 governed MCP recording; the new gallery uses actual study evidence-explorer captures and links self-hosted reproduction.

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
