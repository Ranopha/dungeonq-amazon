# DungeonQ — Governed Assistant Lab

**Let it investigate. Decide before it acts.**

DungeonQ is an Apache-2.0, locally runnable reference lab for **testing the boundary between an assistant's request and a human-authorized effect**. An assistant uses a real MCP server to investigate a synthetic incident and request containment. A separately authenticated reviewer approves an exact manifest. Only then can the assistant change one synthetic session and obtain a verifiable receipt.

For MCP developers, security engineers and reviewers who need more than an approval label: challenge the boundary, inspect what changed, tamper with the evidence, and rerun the checks.

**Synthetic only.** The transport, authentication, SQLite writes and signatures are real; the identities, incident and effects are artificial. This is a deterministic assistant simulator, **not an LLM, the Alexa service, an Echo integration or production security software**. No cloud account, API key, credit card, live attack or real enterprise connection is needed.

[Watch the 2:35 demo](https://youtu.be/ezX7cOF2s0s) · [Download v0.4.0](https://github.com/Ranopha/dungeonq-amazon/releases/tag/v0.4.0) · [Review the evidence map](docs/GOVERNANCE.md) · [Public acceptance runs](https://github.com/Ranopha/dungeonq-amazon/actions/workflows/ci.yml)

## Start in five minutes

Reference runtime: Node.js **24.15.0+**, npm and OpenSSL with `req -addext`. Public CI targets Ubuntu 24.04 and macOS 14; the [validation record](docs/VALIDATION.md) identifies completed runs. Native Windows is not release-accepted. See [installation and troubleshooting](docs/INSTALL.md).

```sh
git clone --branch v0.4.0 --depth 1 https://github.com/Ranopha/dungeonq-amazon.git
cd dungeonq-amazon
npm ci --ignore-scripts
npm run doctor
```

### A. Reproduce the proof without a browser

```sh
npm run demo:proof -- --out ../dungeonq-proof-040
```

Expect **seven PASS checks**, ending with `Result: PASS`. The command starts a fresh lab on random loopback ports, crosses actual HTTPS/CSRF and Streamable HTTP, verifies scope/signature/tamper/replay, stops the entire stack, and verifies persistence after restart. It exits nonzero on failure, refuses an existing output directory and removes only its own disposable private lab.

The output includes `report.json`, original and tampered evidence, and a **public** verification key. No passwords, worker tokens or private keys are exported. The automated driver controls **both fixture roles**; it does not prove human presence or give the runtime assistant an approval tool.

Independently check the signed receipt:

```sh
npm run verify:assistant-evidence -- ../dungeonq-proof-040/evidence.json ../dungeonq-proof-040/trusted-public-key.pem amazon-local-lab
npm run verify:assistant-evidence -- ../dungeonq-proof-040/tampered-evidence.json ../dungeonq-proof-040/trusted-public-key.pem amazon-local-lab
```

The first returns `receiptValid: true` / exit 0. The **second must return false / exit 1**: that is the expected rejection, not a failed installation. The harness pins the key before exporting evidence. For artifacts supplied by someone else, obtain the trusted key independently; accepting an accompanying key proves no trusted origin.

### B. Experience the human approval boundary

```sh
npm run amazon
```

Open **https://127.0.0.1:4186/assistant**. Sign in as `owner-lab` with the new disposable password printed in your terminal. Inspect and handle the local self-signed certificate warning yourself; do not install system trust or disable TLS validation.

1. **Investigate this incident** → see route `DENY` and a decision digest; no asset changes.
2. **Request containment**, then ask the assistant to **Apply** → `HUMAN_APPROVAL_REQUIRED`; both assets stay active.
3. In **The approval boundary**, review the exact session, digest, five-minute expiry and one-effect limit. Reauthenticate and approve.
4. Ask the assistant to **Apply** → target becomes `CONTAINED`, version 1; the other session stays `ACTIVE`, version 0.
5. **Verify receipt**, **Test tampering**, **Replay apply**, **Export evidence** → valid original, rejected altered copy, same receipt and no second mutation.

[Reviewer walkthrough](docs/REVIEWER_GUIDE.md) covers expected outcomes, expiry and restart. The public video records the preceding 0.2.0 workflow; 0.4.0 adds scenario-aware proof, an independent MCP client and public release tooling without changing that UI or approval contract.

## What you can actually verify

| Question | Inspectable result |
|---|---|
| Can the assistant approve its own request? | Six MCP tools, none for approval; an approval command is rejected. Human HTTPS reauthentication is separate. |
| Does approval bind the effect's scope? | Exact digest, worker, observed asset/version, expiry and one-effect limit; unrelated asset remains unchanged. |
| Can a retry execute twice? | Atomic claim and CAS; replay returns the original receipt without incrementing the asset again. |
| Can an edited receipt pass? | Ed25519 verification against a previously pinned key rejects the modified copy. |
| Does restart forget the decision? | Real full-stack restart preserves the account, request, effect and receipt in SQLite. |
| Do combined failures grant more authority? | All 127 nonempty subsets of seven **modeled** failure flags remove capabilities; not 127 infrastructure attacks. |

[Governance and security value](docs/GOVERNANCE.md) maps claims to code, checks, limits and reuse. [Architecture](docs/ARCHITECTURE.md) distinguishes modeled decisions, durable local effects and deferred production guarantees.

## Bring your own synthetic scenario

Copy `assistant/scenarios/after-hours.json` and change its synthetic identifiers, seed, policy or signals. The [Scenario Pack contract](docs/SCENARIO_PACK.md) describes accepted fields and limits.

Run **your file through the complete proof**, not just an analysis preview:

```sh
npm run demo:proof -- --scenario ./my-synthetic-scenario.json --out ../my-scenario-proof
```

Each run reports the scenario ID, input/decision/proposal digests, platform and named outcome. Equal admitted input produces equal decision digests; fresh keys, timestamps and receipts are intentionally not byte-identical. Invalid inputs or incorrect expected assertions exit nonzero. The proof cannot attach to or overwrite an existing lab.

| Shipped proof case | Expected result | What it actually proves |
|---|---|---|
| `assistant/scenarios/after-hours.json` | `APPROVED_EFFECT_VERIFIED`, 7 checks | Pre-approval denial, separate fixture approval, exact effect, signature, tamper, replay, restart |
| `assistant/scenarios/budget-blocked.json` | `POLICY_BLOCKED`, 3 checks | Modeled budget exhaustion prevents observation/request creation; assets unchanged |
| `assistant/scenarios/unsupported-mapping.json` | `UNSUPPORTED_MAPPING_REJECTED`, 3 checks | Rotation is analyzed but this adapter refuses execution; no receipt invented |

Use each path with `--scenario` and a new `--out` directory. The two rejection proofs export `rejection.json`, **not** a signed effect receipt. A PASS means the named expectation held; it does not mean every case executed an effect. A pack whose cost exceeds its declared budget is rejected even earlier at admission.

- **Upload in the UI** to analyze through MCP. Uploading does not replace the installed lab or grant execution rights.
- **Install in a fresh lab** to exercise the supported containment mapping:

```sh
npm run amazon -- --scenario ./my-synthetic-scenario.json
```

Execution supports **ISOLATE_SESSION, scope 1, AVAILABLE → containment** only. Other modeled effects can be analyzed but cannot be executed by this adapter. URLs, real-looking credentials, extra fields, executable content and excess budget are rejected. Never use real incident data.

The [reviewer guide](docs/REVIEWER_GUIDE.md) names three fixed-seed cases and expected outcomes. [MCP documentation](docs/MCP.md) includes the six tool authorities and an external local client.

For a separately running client and a Codex connection example, see [External Agent walkthrough](docs/EXTERNAL_AGENT.md). Only the worker transport token belongs in that process; human approval stays in the HTTPS UI. CI tests the SDK client, not a live LLM or Alexa account.

## Verify, contribute, release

```sh
npm run check
npm run verify:source
```

`check` runs source tests, three fixed-seed goldens, release-pattern audit, type checking and build. It is not independent security certification. `verify:source` checks the distribution's file inventory and SHA-256 manifest; a hash manifest is not a signature or trusted timestamp.

- [Testing and evidence scope](docs/TESTING.md)
- [Versioned validation record](docs/VALIDATION.md): tests, three goldens, full and rejection proofs; limits included.
- [Contributing](CONTRIBUTING.md) · [Security reporting](SECURITY.md)
- [Release notes](CHANGELOG.md) · [Version/release policy](docs/RELEASE.md)
- [Amazon-specific changes and provenance](docs/DELTA.md) · [Developer-tool feedback](docs/PRODUCT_FEEDBACK.md)

Prepared for **Build, Ship, Shape: Amazon Developer Hackathon — Alexa+ + Open Source Mini Challenge**. The older WebMCP entry is separate and unchanged. Public availability and passing local tests do not imply contest acceptance, OpenAI endorsement or production readiness.

Apache-2.0: [LICENSE](LICENSE), [NOTICE](NOTICE), [third-party notices](THIRD_PARTY_NOTICES.md), [SBOM](SBOM.cdx.json). The package is intentionally private to prevent accidental npm publishing; the GitHub source is open source.
