# Review DungeonQ's defensive deception runtime

DungeonQ is an Apache-2.0 runtime for developers securing AI-agent tool workflows. It gives designated suspicious sessions a persistent synthetic world to work in while people and authorized defender agents observe activity and prepare a bounded response. Creating response time and separation is the design goal; measured delay, production protection and general deception efficacy remain unestablished.

[Amazon](https://github.com/Ranopha/dungeonq-amazon) and [Astra](https://github.com/Ranopha/dungeonq-astra) are two public profiles of the same core. The current **v0.13.0** emphasizes independent client integration and maintainability. Read [VALIDATION](VALIDATION.md) for the exact source and completed release gates; a candidate label or document edit is not publication evidence.

## First: inspect the reusable boundary

Start with [the independent integration guide](EXTERNAL_INTEGRATION.md) and [standalone shipping consumer](../examples/mcp-shipping-consumer/README.md). The consumer uses public MCP/HTTP with actor-only authority. Separate harness roles inspect operator observations and the artificial origin. The example demonstrates how another application can integrate; it is maintainer-authored scripted evidence, not outside adoption or a model-efficacy trial.

A Wrong Ticket grants useful bounded work inside its issuing world. It does not grant origin access. Operator preview/apply controls finite adaptation. Participant instructions, model output and defender-agent proposals cannot approve themselves. Unknown outcomes remain visible and prevent clean admission.

## Then: run it

From a pinned source checkout with Node.js 24.15.0+:

```sh
npm ci --ignore-scripts
npm run oss:demo -- /absolute/path/new-oss-report.json
```

Choose a new filename outside the checkout. Inspect the actual report, named positive and negative checks and exit status. Use [the manual route](JUDGE_ROUTE.md) to operate the Participant workspace and separate Control room. [INSTALL](INSTALL.md) covers prerequisites and recovery; [RUNTIME](RUNTIME.md) covers protocol contracts and Node/Python clients.

For broader checks, run `npm run test:runtime` and the release checkpoint `npm run check`. Full runtime admission also needs fresh [container evidence](../deploy/runtime-reference/README.md), `runtime:proof` and `runtime:gate` for the exact clean candidate. Missing, stale, uncertain or mismatched evidence cannot become PASS. Public CI is separate from branch-protection settings.

## Evaluate maintenance and honest limits

The [maintenance plan](MAINTAINER_PLAN.md) identifies actual maintainer responsibility, concrete contribution directions, trial feedback and how Codex resources would support upkeep. [CONTRIBUTING](../CONTRIBUTING.md) explains one-change PRs, evidence, AI disclosure and safe reporting. There is no established external adoption, and no community size, downstream use or incoming issue volume is claimed.

The container reference measures specified network/file boundaries while trusting the gateway, Docker administrator and shared kernel. The origin witness covers a named artificial resource and interval, not every asset on a host. Real deployment needs an explicitly authorized integration and environment-specific acceptance.

Retained research includes [0/2 wrong-high-confidence study outcomes](STUDY_RESULTS.md), [0/4 unsupported completion claims](TOPOLOGY_RESULTS.md), [the 0/3 defense pilot](DEFENSE_PILOT_RESULTS.md) and [qualified decoy-data acceptance](WORKSPACE_LAB.md). Engineering checks are not evidence of sustained false belief. Original studies, challenge snapshots and films remain available with their source/date boundaries.

[Security](../SECURITY.md) · [License](../LICENSE) · [Notices](../NOTICE) · [Release policy](RELEASE.md) · [Release history](../CHANGELOG.md) · [繁體中文入門](START_HERE.zh-TW.md). Updating this source does not update an external grant application or prove selection. Application state must be confirmed separately by the maintainer.

<details>
<summary>Earlier review route and profile history</summary>

The earlier route below preserves its dated incident-response focus, original commands and evidence limits. Use the runtime route above for the current product entry point.

# A three-minute open-source review

Public source: [Astra edition](https://github.com/Ranopha/dungeonq-astra) · [Amazon edition](https://github.com/Ranopha/dungeonq-amazon). [繁體中文入門／文件索引](START_HERE.zh-TW.md) includes credential-free setup and a capability/status matrix. Both editions share the runtime and retained synthetic core; their challenge-specific workflows and retained model records remain separately identified.

**Current v0.11 update:** [Deception Runtime](RUNTIME.md) adds real bounded HTTP, MCP, SSH, PostgreSQL-profile and managed-workload entry points, persistent synthetic state, scoped tickets and owner-approved mutation. JavaScript and Python clients use the same contract. The recorded owned-reference baseline covers 11 required acceptance rows and 16 container checks before and after restart. Public CI regenerates source-bound reports; required branch protection remains a separate setting. No real production integration or broad deception efficacy is claimed. Start with `npm run runtime` and inspect [acceptance and limits](RUNTIME_ACCEPTANCE.md).

**v0.10 update:** [Administrator email notifications](EMAIL_NOTIFICATIONS.md) adds verified-recipient binding, a durable encrypted outbox and a credential-free local capture mode. `npm run email:proof` reproduces nine scripted HTTPS/restart checks. Optional Google/GitHub identity and SMTP adapters need explicit deployment configuration; no real provider login or inbox delivery is claimed, and Apple is unavailable. The model cannot choose recipients or approve rotation. Source updates are available at the existing repository URLs; no duplicate OSS application is implied.

**v0.9 update:** [Orders Workspace](WORKSPACE_LAB.md) adds a coherent participant-facing record trail without revealing evaluator-only labels. Two fresh model dialogues accepted decoy answers (19/21 versus origin 7), but both qualified their evidence as synthetic and common-source. This is data acceptance, **not demonstrated sustained origin misbelief**. Complete raw observations and a projection/replay verifier accompany all results, including the prior 0/3 negative pilot. Install with `npm run defense:workspace`; there is no paid call by default. The existing authority/rotation proof below stays separate.

Start with the v0.8.0 [defense reference guide](DEFENSE_LAB.md). It connects a configured synthetic honey contact, a bounded world, a durable local alert, exact Owner approval and an actual loopback TLS rotation under one incident. Earlier governed-containment, Astra and research profiles remain available with their original evidence boundaries.

DungeonQ is Apache-2.0 source for local synthetic evaluation. This guide identifies inspectable behavior and reproducibility; it does not imply selection, endorsement, publication status or production readiness.

## First minute: follow one incident

Open [the recorded proof](../evidence/defense-v1/proof.json). Its 13 named engineering checks connect the incident and world IDs, manifest digest, local notification receipt, rotation receipt and four separate authorization/business readbacks. Read the [world events](../evidence/defense-v1/world.json) and [governance events](../evidence/defense-v1/governance.json) alongside it.

The automated proof controls an Owner fixture credential. It is not proof of human presence, an LLM trial or a transparent traffic-interception product. No provider call or external target is involved. Same-host processes are not production isolation; a local sink receipt is not email delivery.

## Second minute: reproduce the boundary

From an extracted source release, with Node 24.15+, npm and OpenSSL:

```sh
npm ci --ignore-scripts
npm run test:defense
npm run defense:proof -- --out ../dungeonq-review-proof
npm run world:verify -- ../dungeonq-review-proof/world.json
```

Expect 13 successful proof checks only when the run actually completes. A nonzero exit, an unknown outcome or a missing check is not a pass. The proof uses a fresh private installation, genuine local HTTPS/CSRF and official-SDK MCP, exercises a complete restart and exports only the three synthetic evidence files. The [interactive guide](DEFENSE_LAB.md#a-short-interactive-review) describes the separate English Actor and Owner desks.

For the broader source checkpoint, run `npm run check` and `npm run verify:source`. The distribution inventory, SHA-256 manifest, SBOM and notices support inspection; they are not an independent signature or security certification. Review the distribution's validation record for the version actually under review. Local checks, public CI and public deployment are distinct records.

## Third minute: inspect the limits and retained negative results

The defense reference is one fixed synthetic A with one rotation, finite B/C/D worlds, five-minute proposals, a 30-day worker credential and a 30-day certificate. Owner-only refresh and readback reconciliation are explicit. The Actor has no approval, arbitrary target, shell, SQL or network-control tool. A honey contact does not prove AI identity or A compromise.

The [v0.7 pilot](TOPOLOGY_RESULTS.md) retains **2/2** procedural-memo local-chain following versus **0/2** controls, but **0/4** unsupported completion claims; all four ultimately verified the actual goal. The [v0.6 study](STUDY_RESULTS.md) retains **0/2** wrong-high-confidence induction. Its 48 reference-learner conditions are not 48 subjects. No general deception efficacy is claimed, and exact pilot model identities were not independently attested. The Astra edition's earlier live API record is separate and unchanged.

Read the source [README](../README.md), [security policy](../SECURITY.md), [contribution guide](../CONTRIBUTING.md), [changelog](../CHANGELOG.md), [license](../LICENSE) and [notices](../NOTICE). The static website displays saved engineering/research evidence; self-hosting is required to operate the actual separate server roles. A new source version does not prove that an external reviewer has refreshed an earlier application, and does not require a duplicate application.

</details>
