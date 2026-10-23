# v0.16.0 tag acceptance investigation — 2026-10-23

This is a correction candidate, not a replacement release or a new human/model trial. The existing v0.16.0 tag, source archive, film and submission are unchanged.

## Source and CI identity

| Evidence | Source | Result |
| --- | --- | --- |
| Main run [39742557591](https://github.com/Ranopha/dungeonq-amazon/actions/runs/39742557591), attempt 1 | `c092e54552fcaf8c87b4d78d63609fd96969de8d` | Five jobs passed. |
| Tag run [39743028595](https://github.com/Ranopha/dungeonq-amazon/actions/runs/39743028595/attempts/1), attempt 1 | Same commit, `v0.16.0` | Four jobs passed; Ubuntu host handoff 44/45. |
| Tag run, attempt 2, [job 120251689574](https://github.com/Ranopha/dungeonq-amazon/actions/runs/39743028595/job/120251689574) | Same commit and tag | Ubuntu stopped at dependency audit before reaching the original test. This is not a successful retest of closure. |

Both original Ubuntu jobs used runner 2.338.0, image `20261012.334.1`, Ubuntu 24.04.5, Node 24.15.0 and npm 11.12.1. Main ran in westus3; the tag ran in westus. The workflow contains no branch/tag-specific test path. Checkout, host lockfile and runtime pin (`ae3be61d3f25e9cbf0fd1d1b0eef260cccb5c2e4`) matched.

The published source archive SHA-256 is `61222b96ac8c58393299972a7cbc873ee1bb196c2a7c0be39605530d0914e846`. All 514 tracked tag files matched the downloaded archive byte-for-byte. Its source manifest verifies and identifies the earlier source-input commit `38dcc71bf765d102bada61fa4a15823b275a4f28`; this is distinct from the final release commit. Byte identity does not make the failed tag CI pass.

## Original failure and measurement timeline

The integration runs a real loopback HTTP consumer every second. The baseline is the BEFORE phase (seven samples in the observed run). After A-2 rotation it collects additional traffic, then calls the closure policy using the previous ten seconds of health. The connector rechecks health before FENCE, applies and reads back FENCE, waits five seconds, then measures only samples starting after the effect. Five samples make nearest-rank p95 equal to their maximum.

The unchanged policy allows a p95 increase of `max(200 ms, baseline * 0.2)` and requires at least five samples, fresh measurement timestamps and the success-rate bound. The original failure happened at the **post-FENCE** health read, not the earlier repaired asynchronous timestamp ordering:

`ALLOW → FENCE applied → post-effect p95 UNHEALTHY → no FENCE rollback available → ROLLBACK_FAILED + CRITICAL escalation → FREEZE_FENCE_NOT_EXECUTED → HALTED`.

Original main: handoff began 2026-10-22 07:44:23 UTC; closure policy health was measured/evaluated at 07:44:47.115 UTC (age 0, ten samples); the test finished CLOSED at 07:44:52 UTC. Original tag: handoff began 07:48:18 UTC; failure was reported at 07:48:46 UTC. The failing job retained neither raw samples nor baseline/current p95 values. CPU, I/O and event-loop load were not captured. Therefore the specific historical latency source cannot be established; a region difference alone is not proof of runner overload.

An instrumented copy of the unchanged source on Linux/Node 24.19.0 completed CLOSED: baseline p95 72.154 ms, post-FENCE p95 65.635 ms. A separate run injected one real 405 ms wait into a successful post-FENCE HTTP probe. Baseline p95 was 54.512 ms and post-FENCE p95 was 475.042 ms (five samples, success rate 1), reproducing the exact original error. The context remained fenced, automation halted, CRITICAL escalation was recorded, and sealing/notification did not run. The injection demonstrates the causal path; it does not identify the cause of the old CI spike.

A preliminary fixed 450 ms injection did not exceed its loaded-run baseline plus the allowed increase (baseline 340.405 ms, current 490.782 ms). Its expected-HALT test failed correctly. The final reproduction derived the delay from the measured baseline; no policy threshold was altered and the preliminary result was retained separately.

## Confirmed closure retry defect and correction

The first fail-closed result was correct. However, calling the closer again while the connector remained halted skipped A-1 because the context was already FENCED, then completed CLOSED. Both the actual-HTTP reproduction and a deterministic regression failed against the original implementation with `CLOSED !== HALTED`.

The correction reads the connector's existing, durable `policyInputState` before **every pending closure step**, including retries and steps after FREEZE. A true halt yields `CLOSE_AUTOMATION_HALTED`; a missing/nonboolean state yields `CLOSE_AUTOMATION_STATE_UNKNOWN`. It never clears the incident/global halt, repeats FENCE, invents an approval, or treats recovered latency as authorization to resume. Operator recovery requires a separately designed and authorized procedure; this patch supplies no automatic reset.

Three regressions cover: retry after irreversible FENCE/latency failure; a halt appearing after FREEZE and persisting across retry; and absent automation state. The real-HTTP fault reproduction now remains HALTED on retry.

## Timing evidence and dependency blocker

The live integration still uses real clocks, real HTTP, the five-second observation window, the same samples and the strict CLOSED assertion. Handoff test files run serially to avoid creating competing test workloads alongside this latency-sensitive integration. This reduces test-induced interference; it is not a guarantee about hosted-runner latency or proof of the historical cause. Failure output now includes sanitized baseline/current measurements and the last twelve sample events so a future failure can be investigated without weakening the gate.

The original tag rerun also exposed [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5): `ip-address <=10.7.3`, patched in 10.7.4. The root and independent MCP consumer lockfiles were minimally updated to 10.7.4; no audit suppression or broad dependency update was used. The host pins dependency-repaired core `dd99765bf2148681467674237a59deb3a44d3c1c`. Previously retained v0.16 runtime identities remain accepted as historical evidence, not repaired evidence.

## Validation and publication boundary

The original root check under root encountered environment-only owner/Unix-socket failures; it is not counted as a complete pass. The three new regression cases and 21 existing closure tests passed (24/24) after the fix. The actual HTTP reproduction passed its negative assertions before and after the fix and verified the corrected retry HALT. Final candidate CI must be read for its exact head/merge/tree identity; previous main/tag results cannot certify this changed source.

This investigation does not change the private host or assert it contains this correction. No real notification, paid model call, new human trial, deployment or competition resubmission is performed.

The whole submitted repository and linked materials freeze at **2026-10-23 19:00 UTC / October 24 03:00 Asia/Taipei** until after the actual organizer winner announcement. Never move v0.16.0 or replace its historical assets. Publishing corrected code requires a distinct release identity and matching regenerated source/manifest/CI evidence before that deadline.
