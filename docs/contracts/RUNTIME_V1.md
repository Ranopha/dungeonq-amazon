# DungeonQ Runtime v1 contract

Status: implemented owned-reference contract, 2026-09-18. Owner: DungeonQ repository owner. Source: `runtime/`, `sdk/runtime-client.*`, `public/runtime/`, `deploy/runtime-reference/`. The specification preserves the Proof Kernel, World, Study, Topology, Defense and competition profiles. No production or public-submission promotion follows from this document.

## Product and priority

DungeonQ supports human security operators and AI clients through one governed product. Routine security management, unattended policy-authorized response/recovery and persistent deception are separate responsibilities. Priority is fixed: P0 real integration/diversion/persistence/observation/adaptation; P1 adversarial defensive rehearsal; P2 continuous acceptance. This version implements a complete bounded reference of the new integration loop; the remaining product/deployment gates are listed explicitly below.

An `ALLOW_DECEPTION` label, browser-local state, a screenshot or a simulation is never evidence of actual diversion. The reference must pass real client requests through the intended service and correlate canonical, gateway, collector and protected-origin observations.

## Authority and trust boundaries

| Role | Authority and reachable resources |
| --- | --- |
| Participant | Token-derived context; five finite operations. No operator, route, tenant or policy selection. |
| Operator | Separately authenticated owner capability; exact preview/apply for fence and mutation grant; state/evidence reads. |
| Gateway / canonical kernel | Trusted policy enforcement, transport admission, signing, durable world state and journal. |
| Synthetic facade | Forwards already sealed finite operations to canonical state; owns neither signing key nor state DB. |
| Origin | Independently authenticates its ordinary capability; reference reads only, separate storage/witness. |
| Collector | Separate producer/reader capabilities, append-only chained event storage and exact event replay checks. |
| Model / imported text | Untrusted proposal or passive data; never identity, policy authority or approval. |

The local setup uses same-user processes. The isolated profile enforces separate container mounts and network memberships. Its Docker administrator, shared VM kernel and trusted gateway remain in the trusted computing base. These are measured reference boundaries, not claims against a compromised host administrator, hypervisor or gateway.

## Ingress compatibility

Four families contain five concrete adapters: web/API (HTTP), AI/tool (MCP Streamable HTTP), network service (SSH exec and PostgreSQL simple-query profile), and managed workload (private Unix-domain broker). Each adapter supplies its own family. Unsupported commands/protocol features fail closed.

HTTP uses `POST /api/operate` with Bearer participant authority and exact `{requestId,operation,args}`. MCP exposes five `dungeonq_*` tools. SSH and PostgreSQL implement the documented finite operations, not arbitrary shells/SQL. The host broker is explicit mediation, not transparent interception of arbitrary processes or kernel events. Node/Python SDKs and an MCP client are exercised; compatibility with every model, provider, device or protocol is not asserted.

A context is server-registered with context, tenant, world, token digest, disposition and epoch. Only `DIVERT` and independently authorized `NORMAL_AUTHORIZED` registrations exist. Callers cannot register themselves or change disposition. This reference does not contain a general attack detector: its suspicious/ordinary contexts are explicitly provisioned by trusted setup.

## Dispatch and persistence invariants

1. Authentication derives identity before dispatch. Payload identities or authority hints never override it.
2. A `DIVERT` context always targets its synthetic world. Error, timeout, missing witness or exhausted quota never falls back to origin.
3. Canonical execution requires an HMAC-sealed admitted operation bound to context, epoch, family, request, arguments and short expiry. Returned data must match an authenticated canonical result and exact admitted-input digest.
4. Tenant/world separation is enforced in canonical state, not by UI filters.
5. Writes require the expected world revision. Effects and canonical journal entries are committed together. Exact retries return the original outcome; changed replays fail.
6. Signing keys are private and pinned across restart. Canonical journal replay authenticates history against stored state. Existing unknown or incomplete databases are never silently adopted.
7. A durable pending dispatch is reserved before external work. Final outcome/collector outbox insertion removes that pending entry transactionally. Crash gaps and unknown outcomes prevent a clean report.
8. Collector acknowledgements are exact; missing collector evidence prevents successful acceptance. A successful canonical effect with a lost response remains uncertain to the caller.
9. Fence advances the context epoch, invalidates its tickets and persists. Dedicated canonical capacity remains reserved for fencing after event/byte budgets are exhausted.
10. Origin authentication and witness storage are independent of participant assertions. Synthetic tickets cannot grant origin access.

The gateway and canonical store are separate SQLite databases. Owner actions recover only an exact persisted canonical grant or proposal-bound fence if the gateway receipt was lost. Automatic dispatch-outcome reconciliation, distributed consensus and arbitrary schema migrations are not implemented. Do not erase history to make an uncertain installation pass.

## Wrong Ticket

A Wrong Ticket is a useful synthetic capability, not a fake error page or an origin credential. It grants a bounded read inside its issuing world. Authenticated fields include version, issuer, audience, ticket ID, context, tenant, world, epoch, issue/expiry times, key scope and maximum uses. Consumption is durable, replay-aware and checked at every ingress. Default validity is60seconds and one use; the core permits at most one hour and eight uses. Wrong issuer/audience, scope crossing, expiration, altered signature, exhausted use and fencing are denied.

The network and integration suites exercise a ticket issued through actual SSH and consumed through actual PostgreSQL. Restart checks preserve consumption and exact retry behavior. This demonstrates mechanism behavior, not whether a human or AI believes the world is real.

## Persistent reality, observations and mutation

A versioned passive JSON blueprint defines initial records, allowed templates and limits. Values cannot include active markup, executable links or secret-shaped material. The blueprint digest is pinned. Reads and writes across adapters share canonical records and revision history. Worlds survive process restart; another tenant cannot use their tickets.

Each successful canonical operation records an observation with context, epoch, operation, request identity and world revision. Route evidence is separate from model self-report. There is no inference that missing attacker feedback means confidence or deception success.

Mutation needs owner authority, exact current revision, an allowed template, unexpired finite policy, unused matching observation and remaining budget. The gateway's automatic trigger is successful first-time ticket consumption. The default operator grant allows eight follow-up mutations for one hour. Templates append bounded synthetic records; they do not modify production, execute scripts, alter past observations or authorize themselves. Replayed ticket use cannot produce another mutation. Untrusted instructions stored as passive data have no policy effect.

## Operator and API contracts

Public `GET /api/capabilities` reveals adapter readiness without private context identifiers. Owner-only `GET /api/status` returns canonical state; `GET /api/evidence` returns explicitly scoped evidence. Owner-only `POST /api/policy/preview` accepts `{contextId,action,reason?}`. The returned proposal binds action, current epoch/revision, expiry, changes and digest. `POST /api/policy/apply` accepts only `{proposalId,digest,confirmation:'APPLY'}`. Stale/expired/conflicting proposals fail. Exact applied proposals replay their saved result.

The browser stores no credential or authority in persistent browser storage. It renders text safely, uses a restrictive CSP, separates preview/apply, shows uncertain outcomes, and clears private views on disconnect/reload. English product text includes explicit English date/time formatting. The operator bearer is a reference access capability; organization accounts, password recovery, FIDO and human-presence attestation are separate requirements.

## Evidence and untouched scope

Reference acceptance requires all of:

- Authenticated canonical journal replay and state agreement.
- Artificial-origin data/configuration digests unchanged from a pre-dispatch baseline.
- Continuous origin admission sequence preserving that baseline and admitting only the registered ordinary context.
- Every ordinary admission in the measured interval reconciled with gateway served attempts.
- Exact gateway/independent-collector event census, with no missing or extra event.
- No pending/unknown dispatch and at least one actual authenticated synthetic result.

Origin audit records and collector records do change, because they record the measurement. “Untouched” refers to the named artificial protected data/configuration and denied synthetic admissions, not to all machine activity. No production asset was inspected. Therefore the correct production result is `NOT_ASSESSED`, not `PASS`.

Container acceptance independently checks actual identities, read-only mounts, separate volumes, internal network graph, effective resource/capability limits, direct-IP denial and positive reachability/read controls. It binds running images to current source bytes. Missing or duplicated checks are inconclusive. A source label or static Compose file alone is insufficient.

## P1 rehearsal matrix

| Family | Required defensive outcome | Evidence |
| --- | --- | --- |
| Poisoned evidence | Forged canonical response/admission fails authentication; missing evidence cannot pass | Integration, boundaries, gate tests |
| Prompt instructions | Passive content cannot approve policy or become executable behavior | Core passive JSON validation; actual write/read and unchanged authority |
| Forged identity | Unknown token, participant operator call and context/scope substitution denied | HTTP/MCP/network and core tests |
| Stale approval | Changed revision, epoch or expiry denies the proposal | Integration and store tests |
| Replay | Same request has one effect; changed request denied; ticket use count survives restart | Store and real integrated protocol tests |
| Conflicting signals | Client route hints rejected; missing/unmatched witness/census fails | Boundaries and gate tests |
| Synthetic-to-origin crossing | Ticket lacks origin authority; facade direct-IP route denied | Real origin denial and container acceptance |
| Failure/recovery | No origin fallback; pending dispatch blocks acceptance; exact owner action recovers | Boundary tests and restart acceptance |

These are bounded invalid-input fixtures in an owned environment. No exploit, autonomous offensive agent, live target scan or claim of resisting all model-generated attacks is included. Live-model adversarial efficacy and comparative treatment/control studies remain separate.

## P2 continuous acceptance

`dungeonq.runtime-acceptance/v1` binds candidate commit/tree, clean-worktree assertion, content digest, start/finish time and exactly eleven mandatory results: http, mcp, ssh, postgres, host, wrong-ticket, persistence, mutation, origin-untouched, adversarial, isolation. Each requires `PASS` and nonempty evidence references. Missing, duplicate, unexpected, stale candidate or inconclusive entries reject. Reduced check sets are explicitly scoped and cannot be called full acceptance.

The producer runs actual clients and validates a fresh current-source infrastructure report. The gate validates the report contract; it does not authenticate third-party evidence independently. The CI template is deliberately outside active workflows. The private repository's disabled-CI boundary and public submission freeze remain in effect. A real PR/merge gate requires a provisioned runner, trusted artifact handling, activation and independently read-back required checks/rulesets. None is inferred from a green local run.

## Limits, ownership and future admission

All operations have bounded messages, connections, requests, journals and policy budgets. The canonical blueprint caps contexts64, worlds64, records128/world, requests/events2048, tickets512, policies128 and aggregate journal10MiB, with fence reserve. Network adapters bound session duration and work; evidence retrieval has a separate16MiB ceiling consistent with collector capacity. Startup/configuration/host identity is trusted; production-grade account lifecycle, multi-node operation, encryption-at-rest, periodic evidence checkpoint export and operations dashboards are not included.

Before production: select each real host connector and protected resource; integrate real identity and detection; establish rollout/rollback and unaffected legitimate traffic; replace reference credentials; verify transport/security boundaries; rehearse backup/restore and recovery; define service objectives; independently verify witness coverage; then obtain environment-specific authorization. Before broad AI claims: test actual supported clients/models, preserve negative results and measure treatment/control effects. Before remote CI claims: read back the activated protected-branch policy.

Legacy deterministic proofs, fixed-incident response/rotation, research history and competition materials remain preserved. This runtime is the new integration foundation; it is not a declaration that every original product intention or production gate has been completed.
