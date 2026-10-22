# DungeonQ — Defensive Deception Runtime

**Keep suspicious AI-agent work separated while people and authorized defender agents respond.**

DungeonQ is an Apache-2.0 reference for developers securing AI-agent tool workflows. A trusted gateway routes a designated session into a persistent synthetic world. The participant can investigate, save a note, use a scoped **Wrong Ticket**, and continue across supported interfaces. Separate source authorization, alert receipt and credential-revocation checks determine what was actually protected.

**v0.16.0** adds shared authorization and revocation across MAIN / A2 / CACHE / EXPORT, an authenticated human handoff, and evidence-preserving incident closure. One guided human rehearsal completed alert → ACK → rotation → closure; its measured response durations are **84.606 s to verified rotation** and **250.921 s to closure**. Extra time caused by DungeonQ remains unproven. [Human evidence](docs/HUMAN_RESPONSE_RESULTS.md) · [Current response design](docs/HANDOFF_DESIGN.md).

[**Start the working demonstration**](docs/JUDGE_ROUTE.md) · [**Design and permission contract**](docs/CONTINUATION_DESIGN.md) · [**Real-model results and limits**](docs/MODEL_RESULTS.md) · [Validation](docs/VALIDATION.md)

## See the current system work

Node.js **24.15.0+**, npm and Git are required. No API key, paid model call, Amazon account or production document is needed.

```sh
npm ci --ignore-scripts
cd examples/initial-machine-host
npm ci --ignore-scripts
npm run prepare:runtime
npm run console:response -- /absolute/path/new-response-report.json
```

Open the printed loopback URL and click **Run working demonstration**. Five stages execute real MCP/HTTP requests against new artificial resources:

1. An official-SDK MCP client enters a bounded workspace.
2. A claimed recovery conflicts with a saved observation.
3. A revocation record resolves the original business question; the note survives restart and the path offers a stop.
4. A separate receiver acknowledges an alert, rotates a temporary connector credential, checks old/new authority and verifies the state after restart.
5. Source policy rejects forged roles, cross-tenant declarations, foreign tickets and revoked-authority replay. Overviews contain no record values.

The console shows actual request results, then replays that run. It is a **scripted working-system demonstration**, not a live-model experiment. Its response delay is zero. Credentials and original target bytes stay outside the public report. [Installation and detailed scope](examples/initial-machine-host/README.md).

## Latest real AI finding and repair

Nine October 21 Sol runs **all obtained the artificial target through the then-open A2 alternate source**. The three diverted runs recognized conflicts and continued checking before ending UNKNOWN_BUDGET; six control runs self-stopped. A zero count at the protected main route did not mean zero overall disclosure. This drove the four-path source guard now included in v0.16. The repaired boundary has automated checks and the human rehearsal; **no new paid AI trial has evaluated that repair**. [Model results](docs/MODEL_RESULTS.md).

## Earlier real AI studies

Historical October 19 Sol sessions are reported separately from the new engineering demonstration. Four isolated v12 sessions recorded **zero participant source business reads**. In the two configured 30-second response arms, rotation became effective after **30.174 and 30.182 seconds**. Those numbers include an injected 30-second delay: they do **not** establish extra time caused by deception or an advantage over transparent isolation.

The later single v13 Sol session ended at its **14-call limit**, with zero source reads and **UNKNOWN_AFTER_LIMIT**. It did not autonomously exercise the four permission attacks; deterministic negative tests cover those cases. The v9 comparison did not increase meaningful exploration over its transparent control. Voluntary stopping, call-limit stopping and raw failed checkpoints remain distinguishable in [MODEL_RESULTS](docs/MODEL_RESULTS.md).

DIRECT is a deliberately authorized positive control. Its early content read is evidence of granted permission, not a breach of isolation. An unchanged file alone does not establish that no one read it.

## How the boundaries fit together

| Boundary | Capability | What it does not confer |
| --- | --- | --- |
| Participant | Read/write its world, consume scoped tickets, follow bounded clues or stop | Operator approval, route selection or source access |
| Trusted gateway | Bind an admitted context to its world across HTTP, MCP, finite SSH/PostgreSQL and a private workload broker | Automatic attack classification or arbitrary traffic interception |
| Source policy | Check principal, tenant, resource scope and current epoch on every content request | Authority from a self-declared role or a world ticket |
| Authorized responder | Incident-bound human ACK, policy-checked rotation and separate closure; one guided human event recorded | General delivery guarantee, unannounced human performance or production-key rotation |
| Independent evidence | Reconcile actor reads, defender controls, restart and exact request outcomes | General security certification or established deception efficacy |

Wrong Tickets do useful work only inside their issuing world. The **false exit** is a data claim, not a routing change. Memory conflict is an observable inconsistency, not a rewrite of the participant's saved note. Follow-up clues address an unresolved task question, have a finite budget and expose a stopping condition. [Complete design](docs/CONTINUATION_DESIGN.md).

## Operate and integrate

For the general persistent participant workspace and separate operator Control room:

```sh
npm run runtime -- --data-dir ../dungeonq-reference-015 --presentation participant-v1
```

Use a new private directory for a new installation; retain the full private state for restart. Keep actor and operator credentials separate. [Runtime guide](docs/RUNTIME.md) · [Independent MCP consumer](examples/mcp-shipping-consumer/README.md) · [Interrupted-write recovery](docs/WRITE_RECOVERY.md) · [Container reference](deploy/runtime-reference/README.md).

Transport loss never falls back to origin. A read-only write-status lookup can distinguish **COMMITTED**, **NOT_COMMITTED**, **UNKNOWN** and **CONFLICT** without resending the write. The retained Alexa-style governed-assistant profile uses the official MCP SDK, Streamable HTTP and protocol 2025-11-25; human approval is outside the assistant's tools. This is the rules-permitted simulation, not Alexa service/device certification or an AWS deployment.

## Verify, release and contribute

```sh
npm run check
npm run test:host
npm run test:host-source
npm --prefix examples/initial-machine-host run test:handoff
npm run demo:response -- /absolute/path/new-cli-report.json
```

The root check covers 779 tests, scenario verification, source audit, JavaScript syntax and static build at the recorded v0.16 checkpoint. Host checks use the separately installed pinned runtime. Consult [VALIDATION](docs/VALIDATION.md) for actual source/run scope and public CI, not just expected counts. [Release policy](docs/RELEASE.md) · [Testing](docs/TESTING.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md).

The entry is **Alexa+ primary + Open Source Mini**. [Submission copy](docs/SUBMISSION.md) · [New work and reused foundations](docs/DELTA.md) · [Product feedback](docs/PRODUCT_FEEDBACK.md). The competition's whole-repository and material freeze is recorded in [COMPETITION_FREEZE](docs/COMPETITION_FREEZE.md).

All resources are artificial and routing is explicitly provisioned. Local processes trust one OS user; the container reference still trusts the gateway, Docker administrator and shared kernel. Production identity/detection integration, legitimate-traffic continuity and production response delivery require environment-specific acceptance. The human rehearsal covers only its named artificial lab.

The updated competition film and gallery distinguish the recorded working console from the October 21 model findings and human rehearsal. See [submission](docs/SUBMISSION.md) for the final media link. Prior films and raw failed attempts remain preserved.

The [October 8 film](https://youtu.be/uFvzFXfL2F0), [earlier consumer film](https://youtu.be/8h5yeKb2XzE), and [original assistant film](https://youtu.be/ezX7cOF2s0s) are retained historical records. Earlier [Study](docs/STUDY_RESULTS.md), [Topology](docs/TOPOLOGY_RESULTS.md), [Defense](docs/DEFENSE_PILOT_RESULTS.md) and [Workspace](docs/WORKSPACE_LAB.md) results, including failures, remain available. Closed WebMCP and Astra entries are unchanged.

Apache-2.0. Preserve [LICENSE](LICENSE), [NOTICE](NOTICE) and [third-party notices](THIRD_PARTY_NOTICES.md). Source inventories establish byte integrity, not independent certification.
