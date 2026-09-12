# Reproducible testing

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
