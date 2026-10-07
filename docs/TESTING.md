# Reproducible testing — v0.13.1

Use a pinned public source checkout, Node.js 24.15.0+ and the prerequisites in [INSTALL](INSTALL.md). The [current validation record](VALIDATION.md) binds observed results to source and environment. A command below describes what to run; it is not a predeclared PASS or a substitute for source-bound acceptance.

| Command or route | Scope |
| --- | --- |
| `npm ci --ignore-scripts` then `npm run doctor` | Locked dependency installation and local prerequisite checks |
| `npm run oss:demo -- /absolute/path/new-report.json` | Independent public MCP/HTTP consumer, actor-only authority, separate scripted operator/origin checks; use a new output filename |
| `npm run test:runtime` | Runtime protocol, state, authority and failure-path regressions |
| `npm run check` | Complete source checkpoint, scenario verification, audit, actual JavaScript syntax checking and static asset build |
| `npm run verify:source` | Intact distribution inventory and digest check; edited source needs release preparation |
| [Container reference](../deploy/runtime-reference/README.md) plus `runtime:proof` / `runtime:gate` | Fresh full runtime admission against the exact clean source and current isolation evidence |
| [Manual participant/operator route](JUDGE_ROUTE.md) | Actual visible task, separate readback, operator evidence, finite grant and restart |

The [standalone consumer guide](EXTERNAL_INTEGRATION.md) explains each role and report field. Root installation is sufficient for the harness; a separately copied consumer package has its own installation step. Its scripted protocol checks do not test service restart or measure model deception, response delay, external adoption or human presence. Use the manual route and dedicated runtime acceptance for restart claims.

Treat a named expected denial differently from an unexpected failure. Preserve the report and examine its authenticated outcome; UNKNOWN, missing checks, source mismatch and stale isolation evidence cannot become PASS. Never delete a fixture or reset credentials to hide a failed run. Keep all outputs synthetic and credentials/private installation data out of reports.

UI changes need actual visible workflow review. Model experiments require a separately stated hypothesis, controls, budget and stopping rule; no paid call is needed for the default integration or source checks. The current runtime and retained assistant/Astra/research profiles have different authority and evidence contracts.

## Static toolchain checks

`npm run syntaxcheck` runs `node --check` over the real exported JavaScript modules. Invalid syntax or an empty source set fails. It does not execute the modules or claim semantic TypeScript validation. The unused TypeScript/framework wrapper and `typecheck` command have been removed.

`tests/static-build.test.mjs` exercises byte-for-byte public asset copying, the browser SDK path, MIME and relative imports, safe repeat builds, refusal of unknown/modified output, link and traversal denial, and actual invalid JavaScript. `npm run build` produces `dist/static`; `npm start` serves that output on loopback. Dedicated API-backed workspaces retain their own launch commands.

<details>
<summary>Historical profile-specific test maps</summary>

# Reproducible testing

## Reviewer entry points (0.4.0)

Use `--scenario your-synthetic.json` with `demo:proof` to install that admitted pack in a fresh disposable lab. See the README's three **proof** cases and exact expected outcomes; these are additional to the three original browser-engine goldens below. Wrong authored expectations fail instead of silently changing expected results. `tests/platform-tools.test.mjs` covers custom inputs, deterministic digests, explicit rejection paths, a separate-process MCP client and public-source release preparation.

The public CI matrix runs the same source on Ubuntu 24.04 and macOS 14 using Node 24.15.0. It uses no production secrets or live model calls, never deploys, and uploads only synthetic proof output. Consult the linked run/commit in the release notes for actual acceptance, not the existence of a workflow file.

`npm run doctor` checks prerequisites without installing or changing trust. `npm run demo:proof -- --out ../dungeonq-proof-030` runs a fresh two-role fixture through actual HTTPS/CSRF and MCP, and exports seven named checks plus original/tampered receipts. The expected result is seven PASS checks and exit 0. The tampered artifact must fail the independent receipt verifier with exit 1. See the README and [reviewer guide](REVIEWER_GUIDE.md).

`tests/reviewer-tools.test.mjs` covers diagnostics, proof/restart, original/tampered/wrong-key offline verification, refusal to overwrite an existing or symlinked output, unsupported existing-lab arguments, and manifest hash/inventory/path checks. The proof controls both fixture roles and explicitly sets `humanPresenceProven: false`; it supplements rather than replaces interactive human review.

`npm run verify:source` applies to the clean public distribution. It compares all non-generated source files to `RELEASE_MANIFEST.json`, rejecting missing, extra, duplicate, unsafe-path or changed entries. It does not prove authorship. Keep proof output outside the source tree so it is not mistaken for distribution source.

Run from a clean checkout with Node 24.15.0 or newer and OpenSSL. Install with `npm ci --ignore-scripts`.

| Command | Evidence |
|---|---|
| `npm run test:amazon` | Actual official MCP client, transport restrictions, human gate, request persistence, scope, revocation, expiry, tamper and replay |
| `npm test` | Full source regression, including migrations, existing identity/roles/workbench and synthetic reference services |
| `npm run verify` | Three fixed-seed original engine goldens, determinism, modeled lifecycle and evidence |
| `npm run audit` | Release metadata, forbidden private-data patterns, asset/browser checks; not a complete vulnerability scan |
| `npm run typecheck` / `npm run build` | Retained browser shell static checking and build; not production acceptance |

The `test:amazon` suite was exercised through HTTPS with its generated certificate pinned in the test client, not by disabling TLS verification. A passing HTTP integration test does not replace visual/browser acceptance.

## Proof map

- `tests/response-governance.test.mjs`: exact binding, no approval authority for a worker, wrong digest/role/tenant/worker, durable retry, receipt tamper, expiry/revocation.
- `tests/mcp-server.test.mjs`: official SDK handshake and tool calls, shared-engine conformance, no approval tool, host/origin/auth/version/body rejection.
- `tests/assistant.test.mjs`: authenticated human HTTPS → assistant → HTTP MCP → actual SQLite change; untouched asset assertion; uploaded scenario; reopening an installed lab without resetting credentials.
- `tests/governance-migration.test.mjs`: upgrade from legacy schema and rollback on schema conflict, preserving revoked epochs and evidence.
- `tests/security-properties.test.mjs`: all **127 non-empty subsets of seven modeled failure flags**. Each result must not increase the engine's capabilities, route to real access, or permit a modeled effect. This is a model-level exhaustive subset check, not 127 real infrastructure attacks or an exhaustive distributed-system test.

## Named synthetic scenarios

| File | What to observe |
|---|---|
| `assistant/scenarios/after-hours.json` | New durable single-session containment workflow; unauthorized apply rejected; exact approval and signed read-back |
| `public/scenarios/honey-credential.json` | Honey replay engine decision, approval-required modeled effect and verifiable modeled lifecycle |
| `public/scenarios/compound-pep-failure.json` | Compound modeled failures remove execution capability; no real-route fallback |
| `public/scenarios/false-positive-recovery.json` | Scoped recovery and false-positive modeling, not permanent person attribution |

Do not compare complete live signed receipts across separate lab installations: timestamps, generated IDs and signing keys intentionally differ. Deterministic equality applies to admitted scenario/engine output. Idempotent live retries are checked against the same request and same installation.

## Manual acceptance

Use the README judge route on desktop and a narrow viewport. Check visible result text, exact human manifest, unchanged unrelated asset, trace and exported JSON. Request/approval expires after five minutes: request a fresh one if it expires, and never edit timestamps or disable checks for filming. Restart and authenticate again before asserting persistence. Verify the original receipt and a mutated copy independently. These are local synthetic claims only.

</details>
