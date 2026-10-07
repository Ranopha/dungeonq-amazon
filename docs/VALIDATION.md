# v0.13.0 validation and publication record — October 7, 2026

This source contains the locally verified v0.13.0 release candidate. The [immutable release record](https://github.com/Ranopha/dungeonq-amazon/releases/tag/v0.13.0) is the authority for final publication: it binds the tag/commit, completed CI run, runtime/container evidence, archives and checksums. A candidate branch alone is not a released artifact. Earlier records below retain their original scope.

| Gate | Evidence and interpretation |
| --- | --- |
| Source identity | Exact files and SHA-256 inventory in `RELEASE_MANIFEST.json`; final public commit/tree and tag are bound by the release record. |
| Clean local Amazon profile | Node 24.15.0 on macOS arm64: `npm ci --ignore-scripts`, `npm run check` and `npm run verify:source` passed; **489/489 tests**, 3 fixed-seed scenarios, zero source-audit findings, typecheck and build. |
| Independent consumer | [Recorded v0.13.0 run](../evidence/oss-integration-v1/report.json), SHA-256 `90069a5282cad6c5f2c0bf9ca10a50e7cb32ec3af38c613f78e5c038c103ca71`: 8 scenes, 8 actor MCP requests, 7 runtime checks, denied owner endpoints and credential-file probe. Seven positive/negative tests pass. |
| Public Ubuntu/macOS CI | The release record links the exact-source `Synthetic acceptance` run. It installs and audits the detached consumer package and saves fresh integration evidence. A workflow definition is not a passing run. |
| Runtime/container gate | The same CI run must bind a complete 11-check runtime census and 16 container checks to its exact commit/tree. Its downloadable artifact is the current evidence; historical records below cannot substitute for it. |
| Download integrity | Release assets contain the reviewed source archive and `SHA256SUMS`; source verification checks the extracted inventory. Hashes are byte integrity, not independent certification. |
| English film | [v0.13.0 integration film](https://youtu.be/8h5yeKb2XzE), 130.67 seconds, English narration and 30-cue subtitles; eight scenes from the recorded run above. Full decode, timing and rendered-frame review passed. |
| Dependency findings | [SECURITY](../SECURITY.md) lists the remaining unpatched braces build-tool advisory (six affected nodes), separate from the zero-finding private-data/source audit. The standalone consumer lockfile audit is clean at this date. |

The independent consumer uses public MCP/HTTP and artificial resources. Its actor process does not receive operator or origin authority. The separate harness controls the operator fixture and independent origin checks; that remains maintainer-authored scripted evidence, not an independent human trial, a live model evaluation or external adoption. See [EXTERNAL_INTEGRATION](EXTERNAL_INTEGRATION.md).

A full gate needs fresh complete evidence for the exact clean candidate. A locally passing consumer or full test suite cannot replace current container measurements or public release readback. UNKNOWN, missing, stale or mismatched evidence stays unresolved. Public CI does not itself prove protected-branch enforcement. No production protection, quantified response delay or general deception efficacy is established.

<details>
<summary>Historical validation records — v0.12.0 and earlier</summary>

# v0.12.0 working-view and outcome validation — September 29, 2026

The integrated development candidate passed **489/489 tests**, three fixed-seed scenario checks, a zero-finding source audit, typecheck and build on Node 24.15.0. Focused regressions include a write committed before response loss, unsigned/misbound refusal rejection, multiline persistence, participant HTTP write/readback and operator cross-context/adapter correlation. These use owned artificial fixtures and deterministic clients.

Chrome readback confirmed a participant multiline save and separate server read, the same operator-visible record, exact preview/apply with persisted policy readback, a follow-up record, a visible rejected attempt, seven scoped evidence checks, and private-state clearing on disconnect/reload. The [September 29 report](../evidence/judge-demo-v2/report.json) records ten real MCP/HTTP checkpoints including an ordinary-origin positive control and ticket-origin rejection before the final witness. Screenshots are recorded UI, not live hosted execution or model-efficacy evidence.

Public source verification and CI are separate from this integrated local result. Consult the exact published commit's Actions run. Historical v0.11 container PASS results below do **not** certify this changed runtime; fresh source-bound isolation/runtime acceptance is required for full gate admission. Production protection and model deception remain unassessed by these engineering checks. The retained Vinext route-classification warning does not prevent the build.

The clean Amazon distribution also passed **482/482 tests**, scenario verification, audit, typecheck, build and source-manifest verification locally. Remote CI and container acceptance are reported separately for the published commit.

---

# v0.11.1 presentation validation — September 18, 2026

The updated clean Amazon distribution passed **460/460 tests**, three deterministic scenarios, zero-finding source audit, typecheck and build. The Astra site's seven focused checks additionally exercise recorded chapter selection, unavailable-evidence handling, complete static packaging and local asset links. Desktop and mobile readback verified the new journey and access to retained historical profiles.

This release restores DungeonQ's diversion-first narrative, adds a sanitized six-checkpoint extract of the existing reference run and fixes the CI detailed-report artifact filename. It changes no runtime implementation and adds no model-efficacy or production result. The journey preserves its original v0.11.0 source/version/time; its public CI corroboration is separately attributed.

Remote checks are generated for the exact published candidate. Consult [Actions](https://github.com/Ranopha/dungeonq-amazon/actions) and the v0.11.1 release for their result; the local checks above do not predeclare remote acceptance. Required branch protection remains a separate repository setting.

---

# v0.11.0 local distribution validation — September 18, 2026

The clean Amazon distribution passed **460/460 tests**, three deterministic scenarios, zero-finding source audit, typecheck, build and source-manifest verification. Both public profiles additionally passed all16 targeted runtime integration/proof/gate/isolation-contract tests. These tests use disposable artificial resources; they do not establish production acceptance or general deception efficacy.

The public workflow adds `runtime-acceptance` on a dedicated ephemeral Linux Docker context, alongside Ubuntu/macOS acceptance. It builds and inspects the candidate's actual container reference, produces11 required source-bound result rows and rejects incomplete evidence. Consult the repository Actions run for the exact commit; this document does not predeclare remote success. Required branch protection is a separate repository setting.

Published v0.11.0 source `1ce468368b2e54699e59f734171bf5c43eb511dc` subsequently passed [remote CI](https://github.com/Ranopha/dungeonq-amazon/actions/runs/35303213743): Ubuntu24.04, macOS14 and the dedicated runtime job. Downloaded artifacts confirmed a clean candidate,11/11 required result rows and16/16 actual container checks. Release assets and checksums were read back. A later documentation correction clarifies that public CI is active; the immutable v0.11.0 archive retains its original wording in the contract's CI paragraph. No runtime behavior changed.

The [runtime record](RUNTIME_ACCEPTANCE.md) retains the earlier448-test development baseline and16/16 before/after-restart container observations. It is not substituted for a fresh distribution-specific isolation report. Historical studies, videos and earlier release results below remain unchanged.

---

# Versioned validation record

## v0.10.0 — 2026-09-17 source checkpoint

Both clean public distributions subsequently passed **386/386 tests**, all three goldens, audit, typecheck, build and source-manifest verification locally. The email proof contains nine passing checks. Remote GitHub CI and publishing remain separately recorded release gates.

Publication was subsequently verified: [v0.10.0 source release](https://github.com/Ranopha/dungeonq-amazon/releases/tag/v0.10.0), source commit `a6b4ce22175e2a139fa64873f8c68fc04d96fd38`, and [tag CI 35198999465](https://github.com/Ranopha/dungeonq-amazon/actions/runs/35198999465) passed on Ubuntu 24.04 and macOS 14. Later `main` documentation clarifies installation and recovery; it does not rewrite this tag, certify Alexa integration or retroactively rerun a model study.

The integrated source covers 386 tests including notification, identity, TLS transport and HTTP boundaries. The first full run found one export-test fixture missing the newly added document; the fixture was corrected and all eight affected packaging checks passed. Remaining 385 full-run tests passed. Three goldens, audit, typecheck and build passed. The nine-check email proof runs actual local HTTPS and restart with a simulated mailbox, not external delivery. Google JWTs and GitHub replies in tests are fixtures; no real OAuth application is configured. Public-distribution checks and CI are separate release records.

## v0.9.0 — 2026-09-17 source checkpoint

The integrated source and both clean public distributions each passed **296 tests**, three goldens, release-pattern audit, typecheck and build on the local Node 24.15+ reference environment. Orders-specific acceptance includes shared HTTP/MCP behavior, exact retries, credential scope, presentation pin/restart, local alerts and independent Owner rotation. Actual Actor UI capture/index/reconcile/readback and static evidence verification were exercised. The recorded N=2 research outcome is qualified data acceptance, not general cognitive-defense efficacy; see [the full interpretation](WORKSPACE_LAB.md). Clean public source manifests, remote CI and deployment are separate evidence gates and must be checked at their actual release revision.

## v0.6.0 — 2026-09-17 local clean-source checkpoint

Both clean public distributions passed **214 tests, three fixed-seed goldens, source audit, typecheck and build**. Each distribution's world and study proofs passed 12 checks each. The original study JSON is preserved byte-for-byte; source manifests identify final packaged contents. These are local clean-export results, not a claim that the new public CI or deployment has completed. Consult the actual release/CI record for those separate gates.

The new functionality is finite synthetic learning and persistence, not real vulnerabilities or general LLM efficacy. The N=2 Codex pilot recorded 0/2 wrong-high-confidence induction; its exact model identity was not independently attested. [Results and evidence](STUDY_RESULTS.md).

## v0.4.0 — 2026-09-16

Clean export on macOS arm64 / Node 24.15.0: **122 tests passed, zero failed**; all three existing deterministic goldens, release-pattern audit, typecheck, build and 118-file source inventory passed. Clean install audited 277 packages and reported zero known vulnerabilities at this checkpoint. The retained Vinext unknown-route classification warning remains; build success does not deploy the assistant.

New acceptance includes a judge-authored QUARANTINE scenario through all seven proof checks, equal input/decision/proposal digests on two fresh installations, incorrect-assertion rejection, bounded file admission, modeled-budget and unsupported-mapping rejection with unchanged state, a separate-process MCP client and a public-only distribution builder. The approval fixture remains separate from the client process. No live LLM, human-presence, native Windows, real Alexa/Echo or production certification claim is made.

Public CI: [completed acceptance run 35044834584](https://github.com/Ranopha/dungeonq-amazon/actions/runs/35044834584), source commit `7fd5d29299abe7876a5d343861a00293e875a6c8`: **Ubuntu 24.04 and macOS 14 both succeeded**. Each ran clean install, Doctor, full checks, approved-effect proof, both rejection proofs and public-source release preparation. Sanitized proof artifacts are available on that run. Later release documentation/inventory changes do not alter the tested runtime; release notes identify the final packaged commit. A queued or failed later run is not new platform acceptance.

The three shipped CLI proofs are explicitly different: after-hours has 7 checks and a real local signed receipt; modeled budget exhaustion and unsupported rotation mapping each have 3 checks and a rejection report, with no invented receipt. An invalid over-budget pack fails before lab allocation instead of being reported as an executed scenario.

## Historical v0.3.0

Validated on 2026-09-15 using macOS arm64, Node.js 24.15.0 and LibreSSL 3.3.6 (`req -addext` supported). This records local synthetic acceptance, not production certification or organizer approval.

| Check | Observed result |
|---|---|
| Clean `npm ci --ignore-scripts` | 276 packages installed; advisory check reported 0 vulnerabilities at this checkpoint |
| `npm run doctor` | Required checks passed; occupied default-port warnings were correctly reported without stopping existing services |
| `npm test` | 115 passed, 0 failed |
| `npm run verify` | Three fixed-seed goldens passed, including modeled compensation and compound-failure refusal |
| `npm run demo:proof` | Seven checks passed across HTTPS/CSRF, real MCP, exact effect, signature/tamper, replay and full-stack restart |
| Independent receipt verifier | Original accepted; tampered artifact and wrong key ID rejected with exit 1 |
| Proof negative paths | Existing/symlink output refused; startup failure returns nonzero and removes only its own new fixture |
| `npm run audit` | No release-pattern findings; not a full vulnerability scan |
| `npm run typecheck` / `npm run build` | Passed; retained Vinext unknown-route-classification warning remains |
| Actual launcher | New private lab on random loopback ports, pinned HTTPS GET `/assistant` returned 200, expected review UI present, SIGTERM exit 0 |
| Distribution manifest | SHA-256, byte lengths and source inventory verified; negative tests reject stale, missing, extra and unsafe entries |
| Documentation | Relative Markdown links checked; final public README/release readback is part of publication acceptance |

The proof harness explicitly controls both fixture roles and does not prove human presence. Interactive UI/code was not changed in this release; the existing desktop video/workflow acceptance remains scoped to 0.2.0. The launcher HTTP check is not a new visual or mobile acceptance. Linux, Windows, mobile, real Alexa/Echo, remote hosting, production connectors and external key custody remain unaccepted.

Generated proof outputs contain synthetic receipt/report data and a public key, not the private fixture. The report and export envelope are unsigned. A receipt verifier needs an independently trusted key; receiving a key next to an artifact alone establishes no trusted origin. Live receipt keys/IDs/times vary between installations; only same-request replay and admitted engine output have the stated deterministic comparisons.

Tests were performed on the selected release source. The final version tag and archive identify the published content; do not transfer these results to unrelated edits. Reproduce the commands rather than treating this record as a warranty.


## September 20 — Amazon judge companion

Added a benign, self-contained MCP/HTTP walkthrough and plain-English judging narrative. The runtime implementation is unchanged. The recorded output has seven scenes and seven passing independent artificial-origin checks; it is not a container acceptance run or model-efficacy study.

Validation: existing suite 458/460 initially passed; two Python-dependent tests were blocked by the local system Python installation. With the existing Homebrew Python, the affected client suite passed 12/12 and integration passed 1/1. Verification, source audit, typecheck and build passed. No OS license or production settings were changed.

New English video: 165.167 seconds, 1080p H.264/AAC; HyperFrames layout/runtime/contrast checks and complete decode passed. Actual command outputs are reformatted; this is not a product UI screen recording. Original v0.2 video and historical tags remain intact. Publication status is tracked separately from local rendering.

Rollback: revert this presentation/helper commit and restore the original Devpost video link. No database migration or existing runtime state changes are required.

</details>
