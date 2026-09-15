# Why this lab matters — and what it does not prove

An assistant proposing an action is not the same as a person authorizing that exact action. Tool labels and convincing UI do not enforce the separation. DungeonQ gives MCP builders an executable example with rejection paths and one inspectable effect: contain **one artificial session**, leave the other untouched, then verify what happened.

## Threat → control → evidence

| Challenge | Runtime control | Reproduce / inspect |
|---|---|---|
| Assistant tries to authorize itself | No approval MCP tool; separate human role and single-use reauthentication intent | Proof refusal check; `tests/assistant.test.mjs`, `tests/mcp-server.test.mjs` |
| Approved content or scope changes | Digest/request/worker/asset/version binding, expiry and revocation | `tests/response-governance.test.mjs`; `server/governance.mjs` |
| Retry repeats the effect | Atomic claim, SQLite CAS and idempotent receipt recovery | Proof replay check; response-governance tests |
| Receipt edited or wrong key used | Ed25519 verification against a pinned key and exact receipt format | Original/tampered artifacts; `tests/reviewer-tools.test.mjs` |
| Restart loses the record | Durable account/request/grant/effect/receipt with transactional migrations | Proof full-stack restart; migration tests |
| UI and tools disagree | Shared admission/engine/application contracts; real SDK client over HTTP | MCP conformance and HTTPS integration tests |
| Several controls fail | Modeled capability set can only shrink | `tests/security-properties.test.mjs`: 127 nonempty subsets of seven modeled flags |

`npm run demo:proof` gives a seven-check route; `npm run check` runs the broader suite. A proof report is an unsigned **test report**, not a certificate. The individual synthetic receipt can be checked cryptographically with the correct pinned key.

## Three levels of evidence

1. **Deterministic model:** identical admitted Scenario Packs yield identical decision output. This is not a truth oracle for attacker-controlled inputs.
2. **Local runtime:** real HTTPS/CSRF, MCP transport, Argon2id login, roles, SQLite effects and Ed25519 receipts. This proves behavior in a local synthetic installation.
3. **Not delivered:** enterprise connectors, actual Alexa/Echo, trusted sensors, isolated infrastructure, hardware key custody, external checkpoints, production backups, detection accuracy or commercial readiness.

Live receipts from different installations differ because keys, times and IDs differ. Compare deterministic engine output, or idempotent retries of the **same request in the same lab**, not full receipt bytes across installations.

## Reuse without false guarantees

MCP developers can reuse exact-approval workflows and negative-test patterns, or author synthetic cases to test expectations. Security reviewers can challenge scope, expiry, roles and evidence handling. These are reference patterns, not a plug-in production firewall.

The test harness owns both fixture roles to run unattended. It does not prove a human clicked Approve. In the interactive demo the reviewer signs in and reauthenticates in the UI; the assistant bridge receives no approval handle or human password. Neither mode protects against host root, stolen local secrets or malicious extensions.

New effect mappings, public endpoints and real enterprise connections require a new threat model and acceptance process—not a configuration toggle justified by this release.

## Maintenance value

This is an early-stage project, not a broad-adoption claim. Contribution surfaces include scenario admission, adapter conformance, setup diagnostics, offline verification and regression tests. Useful changes make a boundary easier to test, explain or preserve. [Contributing](../CONTRIBUTING.md) requires a reproducible case and scoped claims; [Security policy](../SECURITY.md) covers sensitive reports.
