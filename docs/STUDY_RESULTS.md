# Causal study results and honest limits

Evidence snapshot: September 17, 2026. Included in DungeonQ v0.6.0.

## Finding

DungeonQ now implements a playable, persistent and causally replayable **finite two-feature learning experiment**. It does not create exploitable vulnerabilities, attack chains or external targets, and it is not production intrusion containment.

An explicit reference learner accumulated confidence in a wrong cause under incomplete correlated observations, then revised it after a counterexample. **Neither of the two fresh Codex pilot participants developed a high-confidence wrong hypothesis: 0/2.** These results do not establish general human or LLM deception efficacy. All planned pilot sessions are retained; none was rerun to obtain a preferred outcome.

## What was added

| Question | Implemented evidence | Boundary |
| --- | --- | --- |
| Is the world consistent? | Precommitted assignment; fixed objects, rooms and acceptance rule; independent process replays transitions | Finite feature model, not an operating system or exploitable environment |
| Does local success persist? | Inventory changes and receipts bound to world ID/epoch | No external credential, permission or effect |
| Can incomplete observations support a wrong explanation? | Correlated and early-discriminating conditions; explicit priors/policies; two transfer rounds | Reference-model behavior is not a human/LLM outcome |
| Can someone observe separately? | Separate-process/database Observer; predictions, outcomes, reflection and next intention retained separately | Explicit reports, not hidden beliefs or inferred attack intent |

The participant can withdraw and receive the answer. Missing hypotheses remain `unknown`; missing numerical self-reports remain `null`. The researcher cannot use the Observer API to rewrite the rule. The participant projection withholds the assignment until completion or withdrawal.

## Reference learner: illustrative paired result

The pair uses the same design and true cause (`structure`, the second feature), a surface-biased prior and greedy choice. This is a transparent finite learner, not a paid model or human subject.

| Measure | CORRELATED | DISCRIMINATING |
| --- | ---: | ---: |
| Initial probability assigned to the wrong feature | 15% | 15% |
| Wrong-feature probability after four training rounds | 60% | 0% |
| Training successes | 4 | 3 |
| First high-confidence wrong-hypothesis event | 13 | Not observed |
| First diagnostic-outcome event | 24 | 6 |
| Predictions on two new objects | Wrong → correct | Correct → correct |
| Wrong predictions over the whole study | 1 | 1 |
| Causal replay | 28 events, valid | 22 events, valid |

Event numbers are not seconds. The prespecified thresholds are confidence ≥60 and reported suspicion ≥70; these are not calibrated psychological scales.

The prior is `signal=.15`, `structure=.05`, `chance=.80`. Correlated successes reduce the chance hypothesis's weight while leaving the deterministic hypotheses' **3:1 relative odds unchanged**. This is an existing preference becoming more confident under insufficient discrimination—not evidence that the correlated data favors the false feature over the true one. Earlier discrimination did not reduce the pair's total wrong-prediction count.

The [complete matrix](../evidence/study-v1/reference-matrix.json) contains **48 condition units, not 48 independent subjects**: four presentation seeds × three prior/policy combinations × two true rules × two conditions. It includes neutral-prior and information-seeking controls. No population effect or p-value is claimed.

Sources: [12-check engineering proof](../evidence/study-v1/reference-proof.json), [correlated bundle](../evidence/study-v1/reference-correlated.json), [control bundle](../evidence/study-v1/reference-control.json). Reports and original bundles remain byte-for-byte records, including their original Traditional Chinese object labels.

## Codex pilot: N=2, negative induction result

The [protocol](../evidence/study-v1/codex-pilot-protocol.json) was saved before execution: exactly one completed or withdrawn session per condition, then stop. Fresh Codex tasks received only the assigned Actor interface—not the repository, hidden rule, Observer or other participant's content.

| Participant | Condition | Completion / events | First diagnostic outcome | High-confidence wrong hypothesis |
| --- | --- | --- | ---: | --- |
| A | DISCRIMINATING | COMPLETE / 22 | 6 | None |
| B | CORRELATED | COMPLETE / 22 | 15 | None |

Each completed seven rounds. B retained an unknown hypothesis after four correlated observations and identified the second feature only after a discriminating result. Every non-null pre-action success prediction was correct. An omitted prediction is neither a correct answer nor an error.

**0/2 is a description of this pilot, not a reliable cross-model rate.** Exact model identity was **not independently attested**; these participants must not be relabeled as GPT-6 Astra. The task framing told them observations might be incomplete and encouraged evidence-based choices. Blindness was an input-role restriction, not OS-level isolation. There were no human subjects and no access to private reasoning. Confidence and suspicion were explicit self-reports.

Sources: [pilot results and limitations](../evidence/study-v1/codex-pilot-results.json), [participant A bundle](../evidence/study-v1/codex-pilot-a.json), [participant B bundle](../evidence/study-v1/codex-pilot-b.json). Their source mode is `EXTERNAL_MODEL_DECLARED`; do not pool it with `REFERENCE_LEARNER`, `UI_CHECK` or human declarations.

## Engineering evidence is a different category

The implementation has local HTTP/official MCP parity checks, transactional SQLite persistence, idempotent retries, restart recovery, Observer interruption/catch-up, tamper rejection and reserved withdrawal capacity under backlog. Replay reruns the actual causal rules instead of merely recomputing hashes.

The [UI_CHECK bundle](../evidence/study-v1/ui-check.json) records seven browser-driven rounds / 22 events, including success and failure, with a downloaded bundle accepted by the offline verifier. Its hypotheses were deliberately entered to test the interface; **it is not another successful induction sample**. A separate [withdrawal bundle](../evidence/study-v1/ui-withdraw.json) preserves that UI path.

The study/reference proof makes no paid provider API calls. The two Codex tasks used existing account capacity, not a new provider API experiment. The separate Astra edition retains its earlier recorded live API proof; that proof is not evidence that Astra participated in this study.

## What remains unestablished

This is not arbitrary-world generation, a vulnerability simulator, autonomous attack tooling, live enterprise traffic interception, production isolation or commercial acceptance. Shared-host process separation does not prevent an OS administrator from reading both roles. Local hashes and receipts are not independent attestations.

Broader efficacy would require new prespecified tasks, samples and measurements. Repeatedly strengthening prompts until a participant fails would not validate this retained experiment. The public static site can explain the evidence; only the [self-hosted study](STUDY_LAB.md) runs the separate server/Observer architecture.
