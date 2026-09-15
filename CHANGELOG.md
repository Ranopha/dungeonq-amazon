# Changelog

## 0.3.0 — 2026-09-15

Reviewer-readiness release. No change to the six MCP tools, approval contract, containment mapping or database schema.

- Local setup diagnostics for Node, Argon2, SQLite, OpenSSL, SDK and occupied ports.
- Fresh-lab proof over real HTTPS/CSRF/MCP: refusal before approval, exact read-back, signature/tamper, idempotent replay and full-stack restart.
- Original/tampered evidence and a public key pinned before export, plus independent offline verification.
- Negative tests for existing/symlink output, unsupported existing-lab arguments, wrong-key and tampered evidence; no fixture secrets exported.
- Reworked onboarding, human walkthrough, governance map, troubleshooting and contribution/release guidance.
- Source-manifest verification and fixed-version release packaging.

The automated proof controls both test roles. Human presence, production effectiveness, actual Alexa/Echo, remote OAuth and platforms beyond accepted macOS checks are not claimed. The existing video shows the unchanged 0.2.0 interactive workflow.

## 0.2.0 — 2026-09-12

Initial standalone Amazon source at `b3ec2e22cd53e7c16c7334c39ad9942d890b9c95`.

Real MCP 2025-11-25 Streamable HTTP, six bounded tools, SQLite governance, separate human HTTPS approval, signed receipts, scenario import and negative tests. That checkpoint recorded 110 tests and three fixed-seed goldens. The initial source had no GitHub release tag; this documents its original commit, not a retroactively invented release.
