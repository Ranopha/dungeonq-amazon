# v0.16 source-wide authority and human closure

Release dependency check (2026-10-22): the MCP SDK transitively selected Hono 4.13.7. The lockfile now fixes 4.13.13, outside the affected range in [GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7). The repaired dependency audit reports zero advisories. This does not assert that the advisory was exploitable through DungeonQ.

MAIN, A2, CACHE and EXPORT now share source tenant/resource/epoch checks. A2 does not retain target contents or operator credentials. Missing source state and unavailable cache revalidation fail closed. Human ACK and decisions use incident-bound authentication; the participant cannot approve rotation or closure. The source policy module remains separate from narrative clues. [Design](docs/HANDOFF_DESIGN.md).

One guided, artificial-resource human closure was observed. Gmail provider UNKNOWN is retained despite inbox and human receipt evidence. This is not production-key rotation, independent host attestation or an efficacy claim. Nine earlier Sol runs disclosed the artificial target through an open A2; they are not post-repair trials. [Results](docs/HUMAN_RESPONSE_RESULTS.md).

---

# v0.15 source authority and response boundary

The current host fixture defaults to no protected-target read permission. Every content path, ticket consumption and cached result checks source principal, tenant, scope and current epoch. Snapshot/overview results contain record metadata only. Caller-supplied roles and tenant fields cannot grant authority. Unknown or stale authority fails closed. The broader runtime's world tickets and adaptation grants remain separate from source authorization.

The response demonstration rotates one temporary connector bearer, persists the epoch, verifies old/new requests and repeats readback after restart. It does not rotate an encrypted file password, a production credential or a model-provider key. Alert acknowledgement is a local system receipt, not a human or inbox acknowledgement. These are owned artificial-resource checks, not general penetration resistance. See [design](docs/CONTINUATION_DESIGN.md) and [results](docs/MODEL_RESULTS.md).

Host development dependency Vitest is pinned to 4.1.12. Source/runtime and host lockfile audits are recorded separately. No model call or external deployment is part of CI.


---

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
