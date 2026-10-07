# Architecture and claim boundary — v0.13.0

DungeonQ is a defensive deception runtime for AI-agent workflows. A designated suspicious session continues in a persistent synthetic world, giving human operators and authorized defender agents a place to observe and prepare a response. Additional response time is the design objective; no measured efficacy or production protection is established.

```text
Standalone participant client / model adapter
  actor token; public MCP / HTTP only
                |
                v
Trusted gateway and provisioned context
                |
                v
Synthetic facade -> canonical persistent world
  read / write / world ticket / exact retry
                |
                v
Evidence collector -> separate operator observation
                         |
             exact preview / explicit finite grant
                         |
              bounded world adaptation

Separate ordinary control / artificial-origin witness
  verifies the named reference resource and route interval
```

## Authority and integration

The participant cannot select its own routing disposition, approve a policy, or use a world ticket as origin authority. HTTP, MCP, bounded SSH/PostgreSQL and the private Unix workload broker share runtime contracts. SSH is not a general shell; PostgreSQL is not a general SQL engine; the broker does not intercept arbitrary host activity.

The [standalone consumer](EXTERNAL_INTEGRATION.md) lives in its own package, uses public interfaces and receives only the actor capability. The integration harness keeps operator actions and artificial-origin checks separate. A deterministic external process demonstrates a reusable client boundary; it is still maintainer-authored and is not evidence of outside adoption, independent human review or a live-model run.

Operator mutation requires an exact preview and explicit finite grant, with bounded template, context, expiry and budget. An authorized defender agent may inspect permitted evidence or propose a response; model text cannot grant itself authority. The former governed-assistant profile has its own HTTPS reauthentication path. Its role/account system is not automatically the runtime token model.

## Persistence and evidence

World records, ticket scope/use counts, observations, policy state and request identity are durable. Expected revisions prevent stale writes. Exact retries return the prior result; they are not a fresh state read. Known no-new-effect refusals require authenticated evidence. Unsigned, misbound or lost responses remain UNKNOWN, including a committed write whose response was lost. Transport failure never causes fallback to origin.

The origin witness covers a named artificial resource and measured interval; witness/audit records themselves change. Fresh full admission binds runtime and container reports to the exact clean source. Historical PASS reports cannot certify changed source. The [runtime contract](contracts/RUNTIME_V1.md), [operation guide](RUNTIME.md), [acceptance boundaries](RUNTIME_ACCEPTANCE.md) and [versioned validation](VALIDATION.md) are the detailed contracts.

## Deployment and research limits

The local reference trusts one host/user. The container reference measures network/file separation while still trusting the gateway, Docker administrator and shared kernel. Neither is certification of a production deployment, general attack detection or arbitrary traffic interception. Production connectors, detection/identity admission, legitimate-traffic continuity and recovery need explicitly authorized environment-specific work.

Study, Topology, Defense and Orders Workspace retain their original observations, including negative and qualified model outcomes. Runtime protocol success does not establish a false belief, behavioral delay or general attacker deception. Preserving the original results is part of the product's evidence contract.

<details>
<summary>Historical governed-assistant documentation (v0.4 and earlier scope)</summary>

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

</details>
