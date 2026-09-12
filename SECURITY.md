# Security policy — local synthetic profile

DungeonQ accepts artificial scenarios only. No production credentials, company data, personal data, real hosts or real defensive effects are allowed. Scenario text is untrusted input, never authority. The runtime rejects unknown fields, active markup, URLs, file references, credential-like values, invalid references and excess scope/budget.

The assistant is untrusted relative to human approval. Its official-SDK MCP client receives a local worker token, not a human password or signing key. No approve/publish/bootstrap tool exists. The human side enforces role capability, secure local HTTPS cookies, CSRF and fresh exact-digest reauthentication; TOTP applies when enabled. Signed grants do not override expiry, revocation, CAS, budget or scope.

Both listeners are loopback-only. MCP HTTP uses a random bearer token and exact Host/Origin checks. Do not expose it publicly, add a tunnel or treat this as remote OAuth. Keep the private generated lab directory out of source control and uploads. Root, malicious same-host software, browser extensions and stolen local secrets are outside the profile's isolation guarantee.

SQLite requests and receipts survive restart. Ed25519 receipt verification proves protected receipt contents under a pinned local key, not sensor truth, full audit completeness, a trustworthy export envelope, external key custody or an uncompromised host. Existing browser-model evidence has weaker, explicitly modeled authority. No WORM, HSM, external checkpoint or commercial readiness is claimed.

Use GitHub Security Advisories for sensitive vulnerability reports, or Issues for non-sensitive defects. Reproduce with synthetic fixtures only. Never include passwords, private keys, production data or third-party attack results. Ordinary release-pattern checks and dependency advisories are not independent security certification.
