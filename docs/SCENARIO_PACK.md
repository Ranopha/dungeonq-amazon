# Scenario Pack authoring guide

Use a Scenario Pack when you want DungeonQ to evaluate your own **simulated** environment without connecting that environment to the lab.

## Start from a golden case

Copy one file from `public/scenarios/` and preserve this sentinel:

```json
{
  "schemaVersion": "dungeonq.scenario/v1",
  "classification": "SYNTHETIC_ONLY"
}
```

All identity-like values must start with `syn-` and use lowercase letters, digits, dot, underscore, or hyphen. Do not paste real hostnames, customer names, credential material, internal paths, callback URLs, or log records.

## Model your simulation

- `subject`: the synthetic credential, session, device, or account being evaluated.
- `environment.assets`: one to thirty-two synthetic application, identity, data-store, edge, or station-simulator assets.
- `policy`: ordered thresholds, scope and budget limits, and effects requiring approval.
- `signals`: one to fifty synthetic observations with source class, independence group, confidence, and a short evidence description.
- `failures`: injected control failures. Adding failures can only remove capabilities.
- `requestedEffect`: one bounded local-state transition.
- `expected`: the result you believe the engine must produce. A mismatch makes verification fail rather than silently changing the expected value.

## Cross-field rules enforced at runtime

- `deceptionThreshold < quarantineThreshold < denyThreshold`.
- Every signal points to the declared subject.
- Logical signal and asset IDs are unique.
- The effect target exists in `environment.assets`.
- Requested scope and cost fit policy bounds.
- Approval-required effect arrays and invariant arrays contain no duplicates.
- Unknown fields and versions fail closed.
- `UNTRUSTED_MODEL` is accepted only as context and always has zero routing authority, regardless of its claimed confidence.
- A requested effect without an explicit matching human-approval policy remains non-executable in this profile.

## Safety and resource limits

| Boundary | Limit |
|---|---:|
| UTF-8 JSON document | 128 KiB |
| Assets | 1–32 |
| Signals | 1–50 |
| Failures | 0–16 |
| Object depth | 8 |
| Object fields | 32 |
| Returned issues | 20 |

Strings are inspected for external references, local absolute paths, credential-like patterns, and active markup. A Scenario Pack is data only: it has no command, code, tool, prompt, URL, callback, or file-read field.

## Declared invariants

| ID | Meaning |
|---|---|
| DQ-INV-001 | Synthetic classification and namespaces |
| DQ-INV-002 | Compound failures never increase capabilities |
| DQ-INV-003 | Separate human approval gate |
| DQ-INV-004 | Exact digest, revision, and idempotency binding |
| DQ-INV-005 | Receipt and Evidence Bundle tamper detection |
| DQ-INV-006 | Append-only compensation |
| DQ-INV-007 | Missing edge context cannot expose a production-response capability |
| DQ-INV-008 | Fresh context does not revive a revoked context |
| DQ-INV-009 | Web, CLI, and WebMCP share one engine result |
| DQ-INV-010 | Import cannot execute code, fetch, or external side effects |

Engine-time results appear inside each simulation. Lifecycle- and adapter-level invariants are proven by the test／verification commands; the runtime does not falsely mark an invariant as passed before its relevant step has occurred.

## Validate and replay

### With a WebMCP agent

Open the live app in ChatGPT's in-app browser, attach or paste the complete Scenario Pack, and ask:

> Inspect DungeonQ's page tools. Admit this complete synthetic Scenario Pack, run the deterministic simulation, and request human review if the proposal is executable. Stop at the human approval gate.

The Agent can use `dungeonq_scenario_admit` only while the lab is still in `VALIDATED`. After simulation the admission tool disappears so the current evidence chain cannot be replaced.

### With the CLI

```bash
node cli/run.mjs --scenario path/to/scenario.json
node cli/run.mjs --scenario path/to/scenario.json --lifecycle --rollback
```

Share the original pack plus the resulting Evidence Bundle. Another evaluator can rerun the pack and compare `inputDigest`, `engineVersion`, assertions, decision, proposal digest, and evidence digest for the same command sequence.
