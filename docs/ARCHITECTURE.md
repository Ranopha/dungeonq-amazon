# Architecture and claim boundary

## One workflow, separate authority

```text
Authenticated human browser
  ├─ Guided assistant → official MCP client → HTTP /mcp → worker interface
  │                       analyze / request / apply / verify / export
  └─ Human review → HTTPS + CSRF + fresh reauthentication → application interface
                                      approve the exact manifest only
                                                │
                                    shared SQLite governance core
                                  request → grant → claim → read-back → receipt
```

The human HTTP session never becomes an MCP credential. The assistant bridge has no application handle and no human password. Human approval requires an authorized application role and a fresh single-use intent bound to the immutable manifest digest. Worker credentials cannot call that path. MCP tool annotations are descriptive, not authorization.

## What is real, and what is simulated?

| Layer | Implemented behavior | Limit |
|---|---|---|
| Assistant | Guided deterministic command orchestration through official SDK HTTP client | No LLM, speech, Alexa account linking, Echo or actual Alexa-service session |
| MCP | Protocol 2025-11-25, six tools, closed schemas, Streamable HTTP JSON responses | Local bearer-token profile; not remote OAuth, SSE or MCP Apps |
| Analysis | Shared strict admission, deterministic decision engine and route-safety overlay | Artificial inputs, no truthful-sensor guarantee or real network routing |
| Human authority | Local Argon2id login, roles, secure cookies, CSRF, exact-digest reauthentication; TOTP when enabled | Local host trust, not external identity or hardware-backed authentication |
| Synthetic effect | SQLite CAS, atomic claims, budgets, grant/worker revocation, signed leases and receipts, actual DB read-back | Changes artificial records only, not real devices or credentials |
| Evidence | Ed25519 verification with a pinned lab key, restart persistence, audit records | Local signer custody; no external checkpoint, WORM or compromised-host defense |

Existing synthetic reference-issuer and notification adapters remain source-tested independently. The assistant containment workflow does not claim to execute their rotations or send real external notifications. Older browser-memory lifecycle demonstrations are also distinct from the new durable core.

## Persistence and recovery

SQLite uses WAL, FULL synchronization, foreign keys and versioned transactional migrations. Schema v5 adds bounded response requests. A failed migration preserves the prior version and data. An old binary must not open a new schema. Keep an offline copy of the complete stopped private lab directory if you need recovery; this is sensitive local material, not a public evidence artifact. There is no production backup service or automatic disaster recovery claim.

A request is bound to its worker, fresh observation, asset and version. It authorizes nothing until approval. A one-effect grant expires five minutes after the observation. Claim/apply retries recover the same effect only while authority is valid; revocation and expiry take precedence over convenience. A completed receipt remains inspectable after authority expires. A crash after claim does not produce a new independent claim on retry. An unknown state is not success.

## Threat and deployment boundary

Treat scenarios, model output, clients and request metadata as untrusted. No arbitrary shell, SQL, callback URL, file path or real-target connector is exposed. Unknown scenarios and unavailable safety controls reduce capability. Neither approval nor simulator text overrides those controls.

This distribution is for a single local synthetic lab. Both servers bind only to `127.0.0.1`; the human side is HTTPS, and the MCP side is HTTP with a separate random bearer token. Host/Origin, payload, connection, request and operation limits are enforced. Do not add a public tunnel or expose the ports. The host owner/root, malicious local software, browser extensions and shared-host credential theft are outside this isolation claim. `runtimeIsolation: NOT_TESTED`; `commercialReady: false`.
