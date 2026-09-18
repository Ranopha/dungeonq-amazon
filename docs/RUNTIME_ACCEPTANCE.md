# Runtime acceptance and remaining gates

Recorded on 2026-09-18 before the v0.11 distribution release. These observations cover the shared runtime implementation in an owned artificial reference. The sanitized [recorded summary](../evidence/runtime-v1/summary.json) is a historical engineering baseline, not a fresh attestation of every distribution build.

## Observed results

| Verification | Result | Meaning |
| --- | --- | --- |
| Full repository suite | 448/448 PASS | Existing behavior plus62 runtime tests; fixed synthetic/research profiles preserved |
| Deterministic verification | 3/3 PASS | Legacy Proof Kernel evidence remains valid within its simulation claim |
| Clean-room/source audit | PASS, zero findings | Includes the new runtime browser assets and dependency inventory |
| Type check and build | PASS | Production build generated locally; no deployment |
| Actual reference acceptance | 11/11 required result rows PASS | Five real protocol clients, two SDKs, tickets, persistence, mutation, origin census, negative cases and container evidence |
| Container isolation | 16/16 PASS before and after restart | Actual identities/mounts/networks, direct-IP denials, readable positive controls and correlated operations |
| Container continuity | PASS | Same named volumes/image/source; new container IDs; preserved witness/events; event count2→4 |
| Missing infrastructure | INCONCLUSIVE as required | Verification while containers were stopped could not reuse a previous green result |
| Dirty-candidate gate | DENIED as required | Passing functional checks cannot approve an uncommitted candidate |
| Browser workflow | PASS | Real local English UI: connect, preview, explicit apply, server readback, scope-qualified evidence, reload and disconnect |

The full suite initially encountered three environment-only failures because the system Git required an unaccepted Xcode license. Using the already available fallback Git resolved them. The final complete `npm run check` passed all448 tests and all subsequent checks. No system license was accepted or changed. The build emits its existing Vinext route-classification advisory; it does not prevent completion.

An initial continuity comparison treated Docker's mount-array ordering as significant. Both original observations were retained; comparison now uses unordered named mount identity and has regression coverage. The corrected result does not replace or rewrite the raw observations.

The recorded isolation image preceded distribution-specific package branding. Each public candidate must generate its own source-matching isolation report; the historical report is not reused to approve another source tree.

## Boundary of the result

**P0 reference implementation:** actual integration/diversion, persistent state, useful scoped synthetic tickets, observations, approved finite adaptation and independent artificial-origin evidence are implemented and exercised. The container profile adds measured network/file separation. Preconfigured contexts supply the disposition; no general attack classifier or transparent OS interceptor is included.

**P1 bounded defensive rehearsal:** invalid/poisoned authority and evidence, passive instruction text, stale approval, replay, conflicting routing hints, missing evidence and attempted synthetic-origin crossing are covered. This is not a live-model attack tournament or proof that every attacker/AI will be deceived. Prior negative study results are preserved.

**P2 local acceptance:** source-bound reports and a rejecting gate are implemented. The public workflow includes a dedicated reference acceptance job. Read its run at the exact source commit for current remote evidence. GitHub branch protection and remote PR/merge enforcement are separate settings and are not implied by workflow success.

| Remaining gate | Required next evidence |
| --- | --- |
| Real host deployment | Named authorized connector/resource, detector identity, actual diversion path, legitimate-traffic continuity and rollback |
| Production untouched | Environment-specific baseline, independent complete witness coverage and accepted scope; no production system was accessed here |
| General host/network support | Per-platform adapter implementation and conformance; SSH/PG are bounded operation profiles, host broker is explicit mediation |
| Enterprise operator access | Organization identities, account/recovery policy, optional FIDO and appropriate human-presence assurance |
| Broad unattended response | Multiple incident/connector lifecycle, preauthorized response, recovery/compensation and credential rotation beyond the preserved single-incident fixture |
| Unknown dispatch reconciliation | Durable receipt recovery and independent reconciliation before promoting an uncertain installation back to acceptance |
| Model/client coverage and efficacy | Actual selected model/client sessions and controlled treatment/control evidence; no paid model call was made |
| Remote merge gate | Authorized runner, fresh trusted artifacts, workflow activation and readback of required-check/ruleset enforcement |
| Operations maturity | Backup/restore tooling, migrations, monitoring, retention/export and service objectives |

## Reproduce and inspect

Use [the operation guide](RUNTIME.md), [contract](contracts/RUNTIME_V1.md), [container profile](../deploy/runtime-reference/README.md).

The retained delivery evidence includes final acceptance and details, isolation before/after restart, continuity, the stopped-state negative result and full-check output. It contains no credential configuration files. Installation credentials and private state remain separately permission-restricted. All task-created listeners, containers and the dedicated rehearsal VM were stopped after verification; the pre-existing default environment was not changed.
