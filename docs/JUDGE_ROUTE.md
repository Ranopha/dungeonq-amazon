# Follow the diversion

DungeonQ is a defensive deception runtime for security teams building controlled responses to suspicious human or AI sessions. A designated entry point diverts an admitted session into a persistent synthetic world. The participant can do useful work there; the operator can observe it and authorize bounded changes while checking the separate protected origin.

The current reference uses explicitly provisioned contexts and an artificial origin. It demonstrates the routing and state mechanisms with real clients, without claiming an automatic attack detector or protection of a production host.


## One-command companion for Amazon judges

For a short first pass, run `node scripts/judge-demo.mjs /absolute/path/new-report.json` after dependency installation. It demonstrates real MCP/HTTP operations, persistent records, world-only ticket use, a separate scripted owner grant, restart and independent artificial-origin readbacks. It needs no API key and stops its own temporary reference. [Exact scope and reproduction](AMAZON_JUDGE_DEMO.md). This is a reproducible walkthrough, not a substitute for full container acceptance or independent human review.


## First: inspect six recorded checkpoints

Open the [recorded journey](../evidence/runtime-v1/journey.json), then follow its evidence references into the [runtime acceptance record](RUNTIME_ACCEPTANCE.md) and [source-bound summary](../evidence/runtime-v1/summary.json). These six checkpoints group one recorded owned-reference acceptance run by capability, rather than chronological order. Public CI corroboration is labeled separately. The ticket-to-origin rejection is a later negative check after the main origin-witness snapshot; inspect the record pointers for each claim.

| Checkpoint | What to look for | Why it matters |
| --- | --- | --- |
| DIVERT | An authenticated request reaches `SYNTHETIC` through the gateway and is correlated with canonical and collector records. | A routing label alone cannot establish that traffic went there. |
| Wrong Ticket | A ticket issued through SSH is consumed through the bounded PostgreSQL profile for a useful world read. Origin authorization is separately denied. | The ticket works, but its authority ends at the issuing synthetic world. |
| Persistence | Saved records, consumed-ticket state and exact-retry behavior survive restart. | A return visit does not create a fresh, contradictory world or another effect. |
| Observation | Stored request, context, operation and revision records agree with the route census. | The operator relies on recorded activity rather than the participant's explanation. |
| Adaptation | A separately approved finite grant lets first-time ticket consumption append a bounded follow-up record. | The world can respond to activity without letting participant text authorize policy. |
| Origin | Separate origin witnesses, ordinary-admission accounting and container checks cover the named artificial resource. | Successful decoy work is checked against an independent origin record. |

Read each checkpoint's source, time and scope. The measurements support this reference mechanism. They do not establish whether an attacker believes the world is real.

## Next: operate a private reference

Use Node.js 24.15.0+ and npm. From the extracted release directory:

```sh
npm ci --ignore-scripts
npm run runtime -- --data-dir ../dungeonq-runtime-review
```

Open the printed **Control room** URL. The launcher also prints the MCP endpoint, SSH/PostgreSQL ports, Unix socket and private credential-file path. Keep that installation outside Git. Give a participant or AI client only the `actor` token; keep the `owner` token and the full credential file separate.

1. **Find the route.** Connect the Control room with the owner token. The provisioned `diverted` context targets a synthetic world; `ordinary` has a separate origin capability. Clients cannot choose their own disposition.
2. **Make a real participant request.** In a separate terminal, set `DUNGEONQ_RUNTIME_URL` to the printed HTTP origin and `DUNGEONQ_CONTEXT_TOKEN` to the actor token. Save the following JSON outside the checkout as `../dungeonq-runtime-snapshot.json`, then run the existing CLI:

   ```json
   {"requestId":"judge-snapshot-001","operation":"snapshot","args":{}}
   ```

   ```sh
   node cli/runtime.mjs operate --input ../dungeonq-runtime-snapshot.json
   ```

   Inspect the returned records and `_route.destination`. Read the Control room's evidence to correlate the served request; `_route` alone is not the independent check.
3. **Use a Wrong Ticket.** Use the same CLI with separate JSON files for `issue-ticket` and then `use-ticket`, each with a new request ID. Issue arguments are `{"scope":["welcome"],"ttlMs":300000,"maxUses":1}`. Consume arguments are `{"ticket":"COPY_THE_RETURNED_TICKET","key":"welcome"}`. Replace the placeholder with that run's returned ticket. The result is the synthetic `welcome` value, not an origin credential.
4. **Observe a bounded response.** In the Control room, preview **Grant mutation** for `diverted`, review the exact proposal, then explicitly apply it. Issue and consume a new ticket. The approved policy can append a `follow-up` record, at most eight times within one hour. Inspect the new world revision and observation. Participant requests cannot grant this policy.
5. **Return to the same world.** Stop with Ctrl+C and restart with the same `--data-dir`. Reconnect using the printed endpoints and the existing credentials. Read a new snapshot with a new request ID and inspect retained records. For an exact retry of a previous operation, preserve its original request ID and input; do not treat a replayed snapshot as a new read.
6. **Inspect and stop.** Compare current canonical, route and origin evidence. Fencing is a separate explicit operator action that invalidates outstanding context authority. Stop the launcher with Ctrl+C when finished; preserve its private state for inspection.

The [operation guide](RUNTIME.md) gives the exact HTTP/MCP, SSH, PostgreSQL and Unix-broker contracts plus Node/Python clients. These are five bounded adapters across four entry families. SSH provides no general shell, PostgreSQL provides no general SQL engine, and the Unix broker mediates an explicitly connected workload rather than intercepting arbitrary OS activity.

## Reproduce the broader checks

```sh
npm run test:runtime
```

This runs the shipped automated runtime tests using disposable artificial resources, including real client paths. A successful local suite is distinct from a fresh container-isolation report.

For full source-bound acceptance, use the [container guide](../deploy/runtime-reference/README.md) to obtain the current isolation report, then follow the existing `runtime:proof` and `runtime:gate` commands in [the operation guide](RUNTIME.md#evidence-and-isolation). Full admission requires the exact clean candidate and all required checks; missing isolation, stale evidence or an uncertain outcome cannot become a pass. Preserve failed evidence instead of resetting state.

## Inspect what is still unknown

The container profile measures network/file separation within a trusted Docker administration and shared-kernel boundary. “Origin untouched” refers to the named artificial data/configuration and its measured admission interval; witness and audit records do change. Production protection, general attack classification and general deception efficacy remain unassessed.

Retained studies include [0/2 wrong-high-confidence outcomes](STUDY_RESULTS.md), [0/4 unsupported completion claims](TOPOLOGY_RESULTS.md), [the earlier 0/3 defense pilot](DEFENSE_PILOT_RESULTS.md), and [qualified decoy-data acceptance](WORKSPACE_LAB.md). Original records remain available. The [Astra profile](https://github.com/Ranopha/dungeonq-astra/blob/main/docs/ASTRA.md) and its original model calls are supporting evidence for a separate bounded assistant workflow, not a fresh model evaluation of Runtime v1.
