# Reproduce a complete DungeonQ task — v0.12.0

Run a real MCP/HTTP task against a newly created artificial local reference with **participant-v1** responses. No model, Alexa service, production credential or cloud account is used.

```sh
npm ci --ignore-scripts
node scripts/judge-demo.mjs /absolute/path/new-report.json
```

Use Node.js 24.15.0+. Choose a new output filename. The script starts its own temporary private fixture, asserts each checkpoint, closes its services and removes only that fixture. An assertion failure exits nonzero and does not produce a completed report.

1. Connect a real MCP SDK client and discover five bounded participant tools.
2. Read the participant world; separately verify its actual synthetic destination in operator evidence.
3. Send one ordinary authorized read through the same gateway to prove the origin is reachable.
4. Write a multiline review note through MCP and read the same value through HTTP.
5. Reject a stale write, verify an authenticated **REFUSED** outcome and unchanged record.
6. Preview and explicitly apply a separate scripted owner grant.
7. Issue and consume a world-only ticket, then read the permitted follow-up record.
8. Present the ticket to the artificial origin and verify its rejection.
9. Stop and restart all services; read retained records and exactly replay prior ticket use.
10. Read independent origin and collector evidence **after** the ticket probe: one ordinary admission, one denied probe, no diverted admission, unchanged protected data/configuration and a complete outcome census.

Output uses `dungeonq.judge-demo/v2`, records the package source version and retains observed timestamps. The origin reachability check is a positive control, **not** an unprotected attacker baseline or a protection-on/off efficacy comparison. The owner is a separate credential supplied by the script, not proof of an independent human reviewer. Refusal proofs use HMAC in the trusted kernel; they are not third-party attestation. Response loss remains UNKNOWN even when a write committed.

This narrow walkthrough does not replace the full `runtime:gate`, container acceptance, a live-model study or production admission. Follow [working-view instructions](RUNTIME.md#try-a-complete-participant-task-v0120) for manual use and [versioned validation](VALIDATION.md) for measured source scopes. A fresh report is shipped as [the September 29 record](../evidence/judge-demo-v2/report.json).

## Preserved September 20 record and film

The [165.167-second English film](https://youtu.be/ttlfnyuuTIs) retains the earlier seven-scene v0.11.1 command-output walkthrough. It is not a recording of the new participant/operator UI, nor of the new negative/control checkpoints. The Amazon distribution preserves its original JSON under `evidence/judge-demo`; no old report or film is rewritten or relabeled as v0.12.0.
