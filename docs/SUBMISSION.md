# Submission copy

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

This is an existing project significantly updated during the hackathon. The Amazon-specific work adds the server-side MCP integration, durable response-request binding, English assistant/human handoff, persistent installer, custom-scenario route, tool trace, signed-receipt workflow and corresponding regression tests. Earlier WebMCP assets stay frozen. See DELTA.md for the boundary between reused foundations and new work.

## Impact and next steps

The immediate audience is developers and reviewers testing consequential assistant workflows without access to real enterprise systems. They can replay the happy path, supply counterexamples and inspect the same source that executed the decision. This demonstrates a reusable evaluation pattern; it does not claim customer adoption, measured incident reduction or commercial deployment.

Next steps are accessibility/user testing, independently managed signing and a separately authorized real Alexa+ integration. Real enterprise deployment would require additional identity, isolation, recovery and operational acceptance.

## Track / Open Source

Primary: Alexa+. Mini: Open Source. Not entering AWS Builder; no AWS integration is claimed. GitHub username: Ranopha. Contribution: the separately licensed source distribution and new MCP-governed workflow; provide its actual repository/commit URL only after publishing. The optional testing link should point to the README's reproducible local instructions, not to the frozen earlier website.
