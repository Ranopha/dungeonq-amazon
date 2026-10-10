# PR #1 independent source security review — 2026-10-10

## Scope and identity

Reviewed PR #1 from `d744c66573cf2b682b753c3163e83098f1b17540` to `802bae735ef29dbeadf3a047658428bf2f973d97`, merged as `6ee781d7ec8730af29abb23a7943c8817995f75f`. Latest main at review start was `7e6033053c9fe0cbd1814669c28b2883c8d9b572`; its only subsequent change was the validation record. There were no open pull requests at review start.

This is a separate source review and synthetic fault-injection exercise. The unavailable automated Codex review on PR #1 is **not a passing security review**. Existing CI and 500/500 functional results were read as prior evidence, not rerun or relabeled as independent security certification. The Codex Security skill's hosted scan tools/reference helpers were unavailable in this environment; no hosted scan ID, generated SARIF or formal service completion is claimed.

All 25 changed files were reviewed, with supporting code traced only where needed:

| Changed surface | Coverage |
| --- | --- |
| Authority, persistence, proofs | `runtime/server.mjs`, `runtime/store.mjs`, `runtime/outcomes.mjs`, `runtime/mcp.mjs` |
| Clients and rendering | `sdk/runtime-client.mjs`, `examples/mcp-shipping-consumer/client.mjs`, `public/runtime/app.mjs`, `public/runtime/participant.mjs` |
| Tests and reproduction | `tests/runtime-write-recovery.test.mjs`, `tests/runtime-participant-ui.test.mjs`, `scripts/interrupted-write-demo.mjs`, `scripts/lib/interrupted-write-fixture.mjs` |
| CI, versions and recorded evidence | `.github/workflows/ci.yml`, `package.json`, `package-lock.json`, `evidence/write-recovery-v1/report.json` |
| Contracts and claims | `CHANGELOG.md`, `README.md`, `docs/EXTERNAL_INTEGRATION.md`, `docs/RELEASE.md`, `docs/RUNTIME.md`, `docs/VALIDATION.md`, `docs/WRITE_RECOVERY.md`, `docs/contracts/RUNTIME_V1.md`, `examples/mcp-shipping-consumer/README.md` |

Supporting review included admission contracts, transport, participant projection, auxiliary storage, synthetic origin/collector, canonical JSON hashing and the existing store/outcome/client/participant tests. This was not a repository-wide dependency, authentication, deployment or legacy-profile audit.

## Threat model for this review

- Assets: synthetic world integrity; exact write identity and original result; context/tenant separation; operator-only evidence; truthful uncertainty.
- Untrusted inputs: actor HTTP/MCP requests, IDs and passive values, concurrently arriving operations, interrupted or manipulated facade replies. A participant does not acquire the canonical signing key or owner token.
- Trusted computing base: the gateway, canonical store and local signing material. The facade is not trusted to establish success/refusal without proof. The operator is separately authenticated and may inspect historical evidence, including fenced contexts.
- Persistence boundary: canonical SQLite transaction versus gateway pending/attempt journal versus collector acknowledgment. A gap between them is possible and cannot become a clean acceptance report.
- Namespaces: execution identity is context plus request ID; the command digest additionally binds family, operation and arguments. Reusing an ID across adapters conflicts. World contents are selected by trusted tenant/world provisioning; deliberately sharing the same tenant/world is not per-context data separation.
- Deployment boundary: owned artificial resources and provisioned contexts. A compromised gateway/host/key, real customer data, public multi-tenant hosting and arbitrary external writes are outside the established guarantee.

## Confirmed findings and minimum corrections

### R1 — uncertain execution surfaced as a definite rejection (medium, recovery integrity)

Original controls: `runtime/server.mjs:99-108`, `sdk/runtime-client.mjs:80-85,106-113`, and the participant error path. The gateway correctly recorded `UNKNOWN`, but forwarded an upstream error's code. The SDK classified most 4xx errors as certain and skipped recovery. The participant then cleared its retained uncertain request; a conflict allowed snapshot refresh and another newly identified write.

Reproduction: forward an admitted synthetic write to the real canonical endpoint, then replace its reply with unsigned `409 REVISION_CONFLICT`, or with an invalid result MAC. Both committed once but caused `writeWithRecovery` to reject with `uncertain: false`. Separately, a test-only SQLite trigger rejected the gateway attempt receipt insert after a canonical commit; the SDK received `ERR_SQLITE_ERROR`, also with `uncertain: false`. These three regressions failed against the unchanged main runtime.

The faulting facade needs neither the actor's owner token nor a signing key: it forwards the already admitted envelope before replacing the response. The storage-failure variant requires an operational failure rather than an actor-controlled database. The actual impact is loss of the recovery/paused-client guarantee, not bypass of canonical idempotency. Exact retries still cannot duplicate the committed effect; another request with a refreshed revision is a distinct accepted command. No automatic duplicate write or origin write was demonstrated.

Correction: after dispatch, only a verified canonical refusal retains a definite rejection. Other facade/proof failures return `DISPATCH_UNKNOWN`; failure to append, record or flush evidence after a verified result returns `EVIDENCE_INCOMPLETE`. The pending reservation or recorded attempt remains intact. Existing SDK uncertainty handling now performs one status lookup and either recovers the proven result or keeps the original request paused. Negative evidence is not rewritten.

### R2 — actor write-status exposed activity outside its context (low, metadata disclosure)

Original control: `runtime/server.mjs:139-142` returned the canonical global checkpoint and commit sequence to both actor and operator callers.

Reproduction: an `other` actor queried an unseen request before and after a `diverted` actor write. The outcome remained `UNKNOWN`, but `checkpoint.eventCount` changed from 3 to 5 and global head/state digests changed. A valid low-privilege actor could observe other-context activity without reading those records. This regression failed against unchanged main. No other tenant's values, credential or operator capability was recovered.

Correction: global checkpoints and sequence numbers are returned only by the owner endpoint. Actor HTTP and MCP responses retain the requested state, command digest and original committed result/event digest. An unseen request's response stays identical when another context writes. The same restriction applies to diagnostic and participant presentations.

### Additional contract correction — reject body authority fields

The HTTP endpoint previously overrode and stripped supplied `token` and `family` fields before enforcing the remaining envelope. They could not override the authenticated credential or endpoint family, so this was not an authorization bypass. It now rejects these fields outright, consistently with MCP, and also rejects `contextId` and `operatorView`. This is input-contract hardening, not a third security vulnerability.

## Proven protections and dismissed hypotheses

| Concern | Evidence and supported conclusion |
| --- | --- |
| Same request submitted concurrently | Six real concurrent HTTP writes yielded one canonical write and five saved-result replays. Eight resulting attempts, including two conflicts, remained separately recorded. |
| New requests race at one revision | Two identities competing with the same expected revision produced one commit and one authenticated refusal. CAS prevents both from committing. |
| ID reused with another value or adapter | Exact command digest mismatch is rejected; status returns `CONFLICT`. An identical request ID in another context has independent state. |
| UNKNOWN mistakenly accepted | SDK negative cases cover UNKNOWN, CONFLICT, NOT_COMMITTED, absent fields and mismatched request/value/revisions, including replies carrying plausible result fields. All reject without resending a write. |
| Lost reply with real commit | Existing tests exercise real socket loss, restart, a stable original commit and one-effect recovery. New tests cover unsigned rejection, invalid MAC and gateway receipt failure after commit. |
| No proven commit | An unsigned error before execution remains UNKNOWN, has no result, and produces one write attempt only. Absence never becomes NOT_COMMITTED by itself. |
| Cross-context/owner/fence access | Server derives context from the bearer credential, reauthenticates MCP lookup after reading its body, requires DIVERT and enforces active authority. Existing tests reject context injection, actor access to owner inspection and fenced lookup. Owner historical lookup remains allowed. |
| Corrupt canonical history | Lookup replays authenticated journal entries and compares materialized state before returning a commit; the existing corruption regression rejects. |
| User-visible uncertainty | Two added real-gateway UI cases verify either recovered readback or disabled new operations with the original request retained when lookup is unavailable. |
| Recovery erases transport failure | New and existing tests retain UNKNOWN/pending attempts and overall evidence FAIL after successful commit recovery. |

Hash collision, signing-key compromise and a malicious trusted gateway were not reproduced as vulnerabilities in this change. They are assumptions/limits, not additional findings. NOT_COMMITTED remains a statement about the exact command at an observed checkpoint, never permission to retry automatically or a promise about future requests.

## Validation of the correction

Environment: Node 24.19.0, Linux. Dependencies installed from the existing lockfile with lifecycle scripts disabled; no dependency/version changes.

- Before the runtime correction: the initial seven-test security suite had **3 passes and 4 expected regression failures** (R1's three cases and R2). This establishes the findings against actual original code, not a rewritten model.
- After correction: **53 targeted tests attempted, 51 passed and 2 environment-blocked**. All **11 newly added tests** passed (nine security cases and two UI cases). The two existing broader integration cases failed at Unix-socket `listen EPERM`; neither reached its assertions. They are not counted as passes.
- Files exercised: `runtime-write-security`, `runtime-write-recovery`, `runtime-outcomes`, `runtime-participant-ui`, `runtime-client`, `runtime-integration` and `runtime-participant-view` test suites.
- `git diff --check` passed. Fresh public CI for the correction is required to establish Ubuntu/macOS and runtime/container acceptance; PR #1's passing CI cannot certify these changed bytes. The workflow automatically includes the new test file in `tests/*.test.mjs`.

No full baseline suite, model evaluation, film or historical evidence artifact was recreated. The prior recorded recovery proof remains bound to its original source hashes. This correction has no database migration or change to canonical request keys, replay algorithm or persisted history.

## Commercialization boundary and concrete acceptance work

The supported deliverable is an inspectable, self-hosted synthetic reference with independently reviewable recovery logic. This review does **not** establish a production security product. Before selling a deployment that promises to protect customer systems, the following need a defined target environment and measured acceptance:

| Missing production evidence/capability | Acceptance requirement |
| --- | --- |
| Real connector and business effect semantics | Name the authorized connector, operation and idempotency contract; prove interruption before/after its actual commit and reconcile its authoritative ledger. A synthetic SQLite result cannot certify an external service. |
| Production identity and operator access | Integrate the chosen identity provider, context provisioning, revocation and operator roles; test credential rotation and tenant boundaries. Reference owner bearer authority is not a production login/MFA system. |
| Public exposure and tenant availability | Specify ingress/TLS, network/filesystem isolation and per-tenant limits; test that one participant cannot exhaust other tenants. Current journals have global bounds and verification replays history; no throughput/long-running-service guarantee is established. |
| Durable operational recovery | Establish consistent backup/restore of canonical state, keys and gateway history, retention/archival and restore drills. Process restart tests are not disaster recovery or externally anchored tamper evidence. |
| Detection and legitimate traffic | Define the diversion signal and authorization source; prove normal traffic continuity and false-positive handling. Contexts are currently explicitly provisioned. |
| Product claims | Measure deception/delay efficacy in a separate authorized evaluation before making that promise; engineering PASS alone is insufficient. |

These are explicit deployment/acceptance dependencies, not newly claimed exploitable defects. No real connector, customer authority, deployment policy or sales commitment was invented to mark them complete. Existing Apache-2.0 notices and historical competition artifacts remain unchanged.
