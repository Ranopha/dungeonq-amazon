# Security policy — synthetic reference profiles

## Current deception runtime

The runtime separates participant actor tokens from operator owner bearer authority. The Control room uses that owner bearer; it does not inherit the retained assistant profile's cookie login, CSRF or password reauthentication controls. Keep owner tokens and generated private configuration outside participant context, Git and uploads. Explicit trusted provisioning selects diverted contexts; no automatic attack classification or production-host protection is claimed. The standalone consumer walkthrough uses cooperative Node permissions, while the separate container reference measures bounded network and file isolation. See [RUNTIME](docs/RUNTIME.md) and [EXTERNAL_INTEGRATION](docs/EXTERNAL_INTEGRATION.md) for current operation and scope.

## Retained governed-assistant profile

The following HTTPS/cookie/reviewer controls describe the retained governed-assistant lab. They do not describe the current runtime Control room.

DungeonQ accepts artificial scenarios only. No production credentials, company data, personal data, real hosts or real defensive effects are allowed. Scenario text is untrusted input, never authority. The runtime rejects unknown fields, active markup, URLs, file references, credential-like values, invalid references and excess scope/budget.

The assistant is untrusted relative to human approval. Its official-SDK MCP client receives a local worker token, not a human password or signing key. No approve/publish/bootstrap tool exists. The human side enforces role capability, secure local HTTPS cookies, CSRF and fresh exact-digest reauthentication; TOTP applies when enabled. Signed grants do not override expiry, revocation, CAS, budget or scope.

Both listeners are loopback-only. MCP HTTP uses a random bearer token and exact Host/Origin checks. Do not expose it publicly, add a tunnel or treat this as remote OAuth. Keep the private generated lab directory out of source control and uploads. Root, malicious same-host software, browser extensions and stolen local secrets are outside the profile's isolation guarantee.

SQLite requests and receipts survive restart. Ed25519 receipt verification proves protected receipt contents under a pinned local key, not sensor truth, full audit completeness, a trustworthy export envelope, external key custody or an uncompromised host. Existing browser-model evidence has weaker, explicitly modeled authority. No WORM, HSM, external checkpoint or commercial readiness is claimed.

## Reporting findings

For sensitive findings, use GitHub's private vulnerability-reporting option if it is available on this repository. If it is not available, open a minimal issue requesting a private contact channel without vulnerability details, proof-of-concept code or sensitive attachments. Do not assume that a normal issue or draft PR is private. No response-time or bounty commitment is offered.

For non-sensitive defects, use Issues with the affected release/commit, OS/Node version and a minimal synthetic reproduction. Never include passwords, private keys, production data or third-party attack results. Ordinary release-pattern checks and dependency advisories are not independent security certification.

## Historical proof driver

The 0.3.0 proof driver creates its own disposable lab and controls both test-role fixtures, including authenticated reviewer requests. This is a test harness, not a runtime approval tool or evidence of human presence. It cannot attach to an existing lab through its CLI. Only synthetic receipts, a test report and a public key are retained; the fresh private fixture is removed on completion. Verify artifacts from others with a key obtained through an independent trusted channel, never merely the key supplied beside the receipt.

## Current dependency repair — v0.13.1

The redirect-only Vinext wrapper and its unused build toolchain have been removed. The maintained browser rehearsal is built and served by Node using the existing public assets. The former Vinext → CommonJS → dynamic-import → fast-glob → micromatch → braces chain is absent from this release's dependency graph. This removes the affected dependency rather than marking its advisory ignored or overriding it to another affected version. The runtime services and their authorization boundaries are unchanged.

[VALIDATION](docs/VALIDATION.md) and the release record provide the exact install/audit/build/test evidence. A zero-advisory dependency snapshot is not a guarantee that the product has no vulnerabilities; reports still follow the process above. Do not assume a patched current dependency graph changes the safety of an older release.

## Historical dependency status — v0.13.0, October 7, 2026

v0.13.0 updates the MCP SDK to 1.32.1 and refreshes the affected HTTP and build dependencies. Scoped lockfile overrides select patched `sharp@0.35.5` and `satori`'s `fflate@0.7.5`.

One upstream advisory remains: [braces stack-exhaustion denial of service](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), affecting `braces@3.0.3` in Vinext's build/development glob chain. Upstream has no patched release as of this review. npm audit reports **six high-severity dependency nodes for this one advisory**, not six independent defects. The standalone MCP consumer's separate dependency graph reports no known advisories at this date.

Static import and call-site review found no path from DungeonQ's participant MCP/HTTP runtime to this build dependency. Untrusted source patterns processed during development or build may still cause denial of service. Review contributions before executing builds, use isolated CI with bounded job time, and do not expose the development server to untrusted users. This is a disclosed dependency risk, not an audit-clean or independently certified release. Updating or overriding to another affected version would not fix it; the release retains the explicit finding until a verified upstream remedy is available.
