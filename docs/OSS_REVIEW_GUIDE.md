# A three-minute open-source review

DungeonQ is Apache-2.0 source for local synthetic evaluation. This guide helps inspect maintenance and reproducibility; it does not imply selection, endorsement or production readiness.

**First minute — scope and maintenance.** Read the [README](../README.md), [changelog](../CHANGELOG.md) and [new-work/provenance record](DELTA.md). Existing governed MCP remains intact; v0.6.0 adds finite world/study modules. Dependencies are pinned; release archives contain a source inventory, SHA-256 manifest, SBOM and notices. See [contribution](../CONTRIBUTING.md), [security reporting](../SECURITY.md) and [release policy](RELEASE.md). A manifest is not an independent signature.

**Second minute — tests and repeatability.** The v0.6.0 clean Amazon and Astra source checks each passed 214 tests, three goldens, audit, typecheck and build. Each world/study proof passed 12 checks. These are local engineering checks; current [public CI](https://github.com/Ranopha/dungeonq-amazon/actions/workflows/ci.yml) is a separate record. Reproduce from an unpacked source archive:

```sh
npm ci --ignore-scripts
npm run check
npm run study:verify -- evidence/study-v1/codex-pilot-b.json
```

No model API key is needed. The [two-minute interactive route](STUDY_LAB.md#a-two-minute-reviewer-route) is optional after setup. The current study UI is Traditional Chinese with English documentation.

**Third minute — inspect the unfavorable result.** Read [study results](STUDY_RESULTS.md) and the linked original bundles. The transparent learner matrix contains 48 conditions, not subjects. Both planned Codex sessions are retained: wrong-high-confidence induction **0/2**, model identity not independently attested. There is no general human/LLM efficacy claim. UI_CHECK records are not experimental subjects.

[Actual overview capture](../media/study-evidence.png) · [Reference trace capture](../media/study-trace.png). These depict a recorded-evidence explorer; only local installation provides a separate server/Observer. No arbitrary targets, real exploits, external scans or paid API calls are required.
