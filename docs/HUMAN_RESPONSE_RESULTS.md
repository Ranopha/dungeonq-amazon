# Human response and closure — October 21, 2026

**One complete, announced and guided human rehearsal reached `HUMAN_CLOSED_CONFIRMED`.** From the accepted LINE provider receipt to verified credential rotation: **84.606 seconds**. From that receipt to completed incident closure: **250.921 seconds**. These are observed response durations, **not extra time caused by DungeonQ**.

The participant was a scripted client in an owned isolated lab with artificial resources. A real person received notifications and used password + TOTP to acknowledge, authorize A-2 rotation, and separately request closure. The agent did not log in or approve on the person's behalf. No paid model call was made. This is not a new AI attack trial.

## Every attempt remains visible

| Attempt | Outcome | Accepted provider receipt → verified rotation | Closure |
| --- | --- | ---: | --- |
| run-01 | UNKNOWN | UNKNOWN | Not performed; email navigation and authenticator readiness prevented ACK |
| run-02 | HUMAN_ROTATION_CONFIRMED | 169.693 s | Not wired into this run; cannot be added retrospectively |
| run-03 | HUMAN_CLOSED_CONFIRMED, 12/12 checks | 84.606 s | Completed after a separate human decision |

Run-02 and run-03 used different notification channels and received operating guidance. Their durations are not a performance comparison. A planned second additional full-closure rehearsal was **not run**; the full M9 acceptance milestone remains **PENDING**. The competition update stops at the evidence actually obtained.

## Run-03 timeline

Times are Asia/Taipei, October 21. Host timing bounds are kept separate from the source clock. Gmail INTERNALDATE observations have one-second resolution.

| Event | Time | Evidence layer |
| --- | --- | --- |
| Scripted participant entered | 16:18:05.407 | Runner event |
| Gmail alert in inbox | 16:18:08 | Independent read-only inbox observation |
| Gmail alert send receipt | UNKNOWN | Original transport result; no resend |
| LINE accepted | 16:18:12.996 | Provider receipt; timing origin |
| Human authenticated ACK | 16:19:18.607 | PASSWORD_TOTP |
| Human A-2 decision | 16:19:22.810 | Incident-bound decision |
| Source atomic rotation | 16:19:28.899 | Source clock; not assumed synchronized |
| Rotation readback completed | 16:19:37.602 | EXECUTED / CONFIRMED |
| Human requested closure | 16:21:58.881 | Separate START_CLOSE decision |
| Closure email in inbox | 16:22:18 | Independent inbox observation; provider still UNKNOWN |
| Incident CLOSED | 16:22:23.917 | Six closure steps recorded DONE |
| Lab resources removed | 16:22:41.687 | Exact named containers/networks/volumes/images |
| Dedicated VM stopped | 16:23:27 | Cleanup observation |

The human also confirmed receiving both entry notifications and reading the closure email. This supplements the transport records; it does not overwrite either Gmail `UNKNOWN`. The runtime's inboxArrival remains `NOT_APPLICABLE` because LINE was the accepted fallback. Independent Gmail observations are a separate evidence layer.

## Timing and protection readback

- Provider → ACK: 65.611 s; ACK → A-2: 4.203 s; A-2 → complete readback: 14.792 s.
- Host-observed A-2 → atomic rotation bounds: 5.975–6.280 s; provider → atomic rotation bounds: 75.789–76.094 s.
- Rotation readback → CLOSED: 166.315 s; human close decision → CLOSED: 25.036 s.
- Old capability: 4/4 paths denied. New capability: 4/4 paths worked. Participant target reads: 0 in the source witness.
- Legitimate synthetic consumer: 328/328 successful probes until the intentional shutdown after fencing. This is not production credential redistribution or an all-consumer continuity guarantee.
- Scripted participant stopped with `NO_AUTHORIZED_PATH`; this is not an autonomous model decision.

## What closure did

The flow froze/fenced the original context, sealed all 18 journal entries, verified rejection of old context/ticket/source authority, retained the fence, recorded notification outcomes, and generated a post-incident report. A release eligibility decision was recorded but **applied=NONE**: the original context stayed fenced. A rule candidate failed its tests and was **not published**.

Stopping the lab did not erase evidence. A separate read-only verification returned VERIFIED with no findings, including the sealed journal and closure record. Keys and anchor storage remained on the same host, so the trust label is **SAME_HOST_SELF_ATTESTED**, not independent external attestation.

The operator initially read A-2 success as closure success; a prompt to use the separate START_CLOSE action was necessary. Gmail arrived while its provider receipt remained UNKNOWN. Both limitations are retained, rather than corrected by rerunning or rewriting the original result.

## Reproducibility and disclosure

The public host now includes the selected DungeonQ policy, source response, human handoff, closure, sealer and negative tests. [Host instructions](../examples/initial-machine-host/README.md) distinguish its no-send automated tests from the explicitly configured human notification runner. The five-stage public console remains a scripted local demonstration; it is not a recreation of the human event.

[Machine-readable projection](../evidence/final-20261022/human-response.json) preserves all three outcomes, original metrics and original process hashes (362 / 194 / 304 rows). Complete original processes, failures, SQLite journals, source witnesses, inbox observations and signing material remain private. Public summaries exclude credentials, recipients, ticket values, target bytes and private paths. A hash commits to retained bytes; it does not prove the reported sensor facts independently.

The historical human run used host commit `ce44db1da25137f35dd746b71499c9c69b30761f` and runtime `361e7183de761d2e95f0c4e0794650dfe6ab6795` (0.15.0-dev.18). The public v0.16 source is a selected, separately tested export, not a claim that the private human run executed the later public commit. Import inventories describe the relationship.

Causal extra time, persistence of a real attacker, repeated human response under unannounced conditions, automatic detection, production isolation and production credential delivery remain **UNKNOWN / NOT_PROVEN / NOT_TESTED** as applicable.
