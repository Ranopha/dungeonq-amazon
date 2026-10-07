# DungeonQ maintenance plan

DungeonQ is an early-stage Apache-2.0 defensive deception runtime for AI-agent workflows. [Ranopha](https://github.com/Ranopha) is the primary maintainer and is accountable for design decisions, review, validation, releases and claim accuracy. Development is AI-assisted. AI-generated patches, explanations and security findings remain proposals for the maintainer to reproduce and review.

There is no established external adoption, demonstrated downstream dependency or promised support team. At the October 7, 2026 pre-update readback, each public profile had 0 stars and 0 forks; the Amazon profile had no issues or PRs. These are dated observations, not permanent metrics. No download count or outside user population is asserted. The consumer example is maintained by the project and is not a third-party endorsement.

## What the maintainer owns

| Responsibility | Concrete work and evidence |
| --- | --- |
| Reproducible setup | Keep the pinned Node/dependency requirements, independent consumer and documented commands runnable from a clean public checkout; retain failing as well as passing outcomes. |
| Contract and security review | Review actor/operator/origin separation, scope/expiry/revocation, exact retries and UNKNOWN handling; reproduce reported defects with artificial fixtures and add relevant regressions. |
| Contribution review | When a report or PR arrives, check its reproduction, license and scope, explain the decision, and record what is untested. No current incoming volume or review SLA is claimed. |
| Release management | Keep both profiles' version, docs, manifest, source archive, CI and actual public readback aligned; preserve old tags and source-bound evidence. |
| Evidence and documentation | Distinguish reference mechanisms, scripted clients, model studies and external trials. Preserve unfavorable results and avoid extending claims beyond a report's source and scope. |

For non-sensitive setup feedback, use the relevant [Amazon issues](https://github.com/Ranopha/dungeonq-amazon/issues) or [Astra issues](https://github.com/Ranopha/dungeonq-astra/issues). Submit a shared-core issue once and name both profiles if both reproduce it. Potential vulnerabilities follow [SECURITY](../SECURITY.md). Existing users' private labs and credentials never belong in a report.

## Near-term contribution directions

These are available work directions, not claimed community activity, assigned owners or delivery promises. Choose one small reproducible problem and discuss a material contract change before building it.

| Direction | A useful contribution | Acceptance boundary |
| --- | --- | --- |
| Independent client experience | Reproduce the standalone example on a documented platform/client version, improve one setup error, or add a minimal public-interface client. | Uses actor-only authority; records exact source, commands and outcome; no internal kernel shortcut. |
| Protocol and authority regression | A focused test for missing/wrong capability, stale revision, replay, cross-context input or uncertain transport outcome. | Shows the original behavior and corrected positive/negative paths; no live external target. |
| Recovery and evidence clarity | A repeatable restart/readback case or a clearer explanation of a specific report field. | Does not reset state to hide failure; distinguishes a replayed result from a new read. |
| Release reproducibility | A clean-install or export defect, broken link, stale version or source-manifest mismatch with a minimal reproduction. | Both affected profiles remain installable and artifacts bind to the intended source. |
| Research design | A bounded synthetic treatment/control protocol for a specific hypothesis, proposed for review. | Defines outcome, budget, stopping rule and negative-result reporting before a live trial; no efficacy claim from scripted success. |

## How Codex resources would be used

Requested resources would support open-source maintenance: reproduce setup reports, triage genuine issues when they arrive, review scoped patches, investigate authorized security findings, develop synthetic regressions, check dependency/contract changes and prepare source-bound release notes. API credits would support coding, review and maintainer automation for these workflows. This plan does not allocate grant resources to unrelated product workloads or claim an existing automated review service.

The maintainer reviews outputs, verifies relevant behavior and authorizes merges/releases. Security work is limited to owned public repositories and artificial fixtures. Any paid run needs a deliberate budget and stop condition; no credits are assumed granted and no spending, subscription change or autonomous approval follows from this document. A grant application and its acceptance are separate external states.

## Trial feedback template

Copy the following into a non-sensitive issue after an actual attempt. A failure report is useful; do not invent a trial, star, issue or PR for application metrics.

```text
Profile and exact release/commit:
OS, Node and client/SDK versions:
Goal of this trial:
Entry used (standalone consumer / own MCP client / own HTTP client / manual UI):
Commands and minimal artificial input:
Expected result:
Actual result, exit code and named check:
Did retry or restart change the result?
Sanitized report excerpt (no credentials or private installation files):
What was unclear or blocked reuse?
AI assistance used, if relevant:
```

Do not upload the full credential file, actor/operator/origin tokens, private SQLite data, real incidents or company material. A report should make the problem reproducible without those assets. See [CONTRIBUTING](../CONTRIBUTING.md), [EXTERNAL_INTEGRATION](EXTERNAL_INTEGRATION.md) and [RELEASE](RELEASE.md) for the working contracts. There is no production SLA or guaranteed response/release cadence.
