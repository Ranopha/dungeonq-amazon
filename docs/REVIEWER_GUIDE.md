# A short reviewer route

## v0.7.0: a packet is not a publication

Run `npm run topology` and use the [two-minute English workflow route](TOPOLOGY_LAB.md#a-two-minute-engineering-review-contains-spoilers). Inspect persistent preview/queue/filing writes, submit a deliberately premature completion claim and observe rejection, then complete the real deposit/index route. The separate Observer exports causally replayable evidence.

Read [all four model outcomes](TOPOLOGY_RESULTS.md): local-chain following 2/2 memo versus 0/2 controls, but no false completion in any session. The deliberately premature reviewer action is an engineering check, not a model-induction result. The original Alexa-style governed workflow and video below remain separate.

## v0.6.0: two minutes with the causal study

After installation, run `npm run study` and follow the [four-step route](STUDY_LAB.md#a-two-minute-reviewer-route): retain UI_CHECK, predict before acting, inspect the result, then withdraw for debrief and download/replay. The UI is Traditional Chinese; the linked English guide includes labels. This functional review is not a human/LLM efficacy sample.

Inspect [all results](STUDY_RESULTS.md), including 48 reference condition units and the N=2 Codex pilot's 0/2 wrong-high-confidence induction. The original governed workflow below remains separate. [OSS maintenance/release review](OSS_REVIEW_GUIDE.md).

## 30 seconds: understand the claim

Read the README and [governance map](GOVERNANCE.md). The assistant is deterministic; MCP/HTTPS/storage/signatures are real; incidents and effects are synthetic. Watch the [2:35 public demo](https://youtu.be/ezX7cOF2s0s).

## 2 minutes: challenge the implementation

After [installation](INSTALL.md):

```sh
npm run demo:proof -- --out ../dungeonq-review-030
```

Expect seven PASS lines: authentication/real MCP, analysis, refusal without approval, exact approval/read-back, pinned signature/tamper, replay and full-stack restart. `report.json` explicitly says `humanPresenceProven: false`. Use the README's offline verifier commands on original/tampered artifacts. A failing original or passing tampered receipt is a failed check.

This automates **test-role** approval. To personally verify the UX boundary, use the next route; do not present an unattended test as a human approval event.

## 5 minutes: be the reviewer

Run `npm run amazon`, open the printed HTTPS URL and sign in with disposable credentials. Personally inspect/handle the self-signed certificate.

| Action | Expected result |
|---|---|
| Investigate | Route `DENY`, decision details, no mutation |
| Request containment | Pending request with exact digest and one target |
| Apply before approval | `HUMAN_APPROVAL_REQUIRED`; no version increment |
| Review and reauthenticate | Exact digest, target, expiry and one-effect limit; approval is outside MCP |
| Apply after approval | Target `CONTAINED` / v1, other session `ACTIVE` / v0 |
| Verify / tamper | Original accepted, altered copy rejected, original preserved |
| Replay before expiry | Original receipt, no second mutation |
| Export, stop, reopen same directory/scenario | Same account and durable receipt; no credential reset |

Authorization can expire while you read. Start a fresh lab if needed; never edit clocks, grants or timestamps to make filming easier. Inspect changed/unchanged assets and exported evidence rather than relying on a green label.

## Three fixed-seed scenarios

```sh
npm run simulate -- --scenario public/scenarios/honey-credential.json
npm run simulate -- --scenario public/scenarios/compound-pep-failure.json
npm run simulate -- --scenario public/scenarios/false-positive-recovery.json
```

- **Honey credential replay:** strong modeled deception signal and approval-required proposal.
- **Compound PEP failure:** failed controls remove modeled execution capability; no real-route fallback.
- **False-positive recovery:** scoped recovery/contradictory-signal model, not permanent person attribution.

Each canonical JSON bundle reports actual route, assertions and limitations. `npm run verify` checks all three against fixed expectations. These engine cases are distinct from the durable `after-hours.json` installation.

## Bring a new case

Copy `assistant/scenarios/after-hours.json`, retain `dungeonq.scenario/v1` / `SYNTHETIC_ONLY`, and edit artificial IDs, seed or allowed policy/signals. Upload to analyze through MCP. For a different installed environment, start a **fresh** lab with `--scenario ./my-synthetic-scenario.json`.

Unknown fields, credential-like values, URLs and excess budgets should fail. Only the single-session containment mapping executes. The proof accepts `--scenario ./my-synthetic-scenario.json` in a fresh lab, but takes no existing-lab or arbitrary-target argument.

Report failures with version/commit, OS/Node, exact command, sanitized synthetic input, expected/actual result and exit code. Never share the private lab directory. See [contributing](../CONTRIBUTING.md).
