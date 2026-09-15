# Security policy — local synthetic profile

DungeonQ accepts artificial scenarios only. No production credentials, company data, personal data, real hosts or real defensive effects are allowed. Scenario text is untrusted input, never authority. The runtime rejects unknown fields, active markup, URLs, file references, credential-like values, invalid references and excess scope/budget.

The assistant is untrusted relative to human approval. Its official-SDK MCP client receives a local worker token, not a human password or signing key. No approve/publish/bootstrap tool exists. The human side enforces role capability, secure local HTTPS cookies, CSRF and fresh exact-digest reauthentication; TOTP applies when enabled. Signed grants do not override expiry, revocation, CAS, budget or scope.

Both listeners are loopback-only. MCP HTTP uses a random bearer token and exact Host/Origin checks. Do not expose it publicly, add a tunnel or treat this as remote OAuth. Keep the private generated lab directory out of source control and uploads. Root, malicious same-host software, browser extensions and stolen local secrets are outside the profile's isolation guarantee.

SQLite requests and receipts survive restart. Ed25519 receipt verification proves protected receipt contents under a pinned local key, not sensor truth, full audit completeness, a trustworthy export envelope, external key custody or an uncompromised host. Existing browser-model evidence has weaker, explicitly modeled authority. No WORM, HSM, external checkpoint or commercial readiness is claimed.

For sensitive findings, use GitHub's private vulnerability-reporting option if it is available on this repository. If it is not available, open a minimal issue requesting a private contact channel without vulnerability details, proof-of-concept code or sensitive attachments. Do not assume that a normal issue or draft PR is private. No response-time or bounty commitment is offered.

For non-sensitive defects, use Issues with the affected release/commit, OS/Node version and a minimal synthetic reproduction. Never include passwords, private keys, production data or third-party attack results. Ordinary release-pattern checks and dependency advisories are not independent security certification.

The 0.3.0 proof driver creates its own disposable lab and controls both test-role fixtures, including authenticated reviewer requests. This is a test harness, not a runtime approval tool or evidence of human presence. It cannot attach to an existing lab through its CLI. Only synthetic receipts, a test report and a public key are retained; the fresh private fixture is removed on completion. Verify artifacts from others with a key obtained through an independent trusted channel, never merely the key supplied beside the receipt.
