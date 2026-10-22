## Inspiration

A suspicious AI agent can keep working across tools, retries and sessions. A defender needs time to observe, decide and revoke authority. DungeonQ creates a bounded place for that work to continue while the source remains separately governed.

Two narrative ideas shaped the design: a claimed escape that still belongs to the same world, and a conflict between a saved observation and a later account. We implement them as original data and workflow mechanics, without film footage or assets. Recognizing the world is allowed. The goal is useful investigation and response opportunity, not a required false belief.

## What it does now — v0.16.0

A trusted gateway routes a designated session into a persistent synthetic workspace. Real HTTP, MCP, finite SSH/PostgreSQL interfaces and a private workload broker share its state. The participant can inspect records, save a note and use a scoped Wrong Ticket. It cannot choose its route or approve policy.

Follow-up clues address the original business question: was a supplement revoked? Archive and revocation records provide useful verification, with a finite budget and an explicit stop. Notes survive restart. A false exit is only a claim inside the world; it never restores source authority.

At the independent source, MAIN, A2, CACHE and EXPORT now share tenant, resource and credential-epoch checks. Overviews contain metadata only. A2 holds no target copy or operator credential. Forged roles, cross-tenant claims, foreign tickets and revoked replay cannot grant source permission. An authenticated human can acknowledge an incident, authorize bounded credential rotation, verify old/new access, and separately request evidence-preserving closure.

## Working demonstration

The updated film shows the recorded working MCP/HTTP console, then clearly separates historical real Sol observations and the actual human rehearsal. The five-stage console executes fresh artificial-resource requests and can be rerun without an API key, paid model, Amazon account or production file.

With Node.js 24.15.0+, npm and Git:

```sh
npm ci --ignore-scripts
cd examples/initial-machine-host
npm ci --ignore-scripts
npm run prepare:runtime
npm run console:response -- /absolute/path/new-report.json
```

Open the printed loopback URL and run the demonstration. `npm run test:handoff` additionally exercises local HTTP authentication, incident binding, policy checks, UNKNOWN and closure using fake senders and test accounts. These scripted checks are not new human or model experiments. [Judge route](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/JUDGE_ROUTE.md) · [Source and installation](https://github.com/Ranopha/dungeonq-amazon).

## What the real AI tests taught us

Nine October 21 Sol runs compared DIVERT, DIRECT and DENY, three each. **All nine obtained the artificial target through the then-open A2 alternate route.** Main-source zero reads did not mean the target was protected across every path.

All three diverted runs recognized conflicts, continued checking and ended UNKNOWN_BUDGET. The six controls stopped themselves. None of the diverted runs submitted a wrong code as verified. We then added the shared four-path source guard. The repair has scripted checks and human workflow evidence, but **no new paid AI test** evaluated it.

Earlier goal-linked continuation did not demonstrate more meaningful exploration than transparent isolation. Earlier roughly 30-second rotation results included an injected 30-second delay. A later 14-call limit was not voluntary stopping. We keep these distinctions and original failed checkpoints. [Model observations and limits](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/MODEL_RESULTS.md).

## A person completed the response

On October 21, one announced, guided rehearsal completed alert delivery, password/TOTP ACK, A-2 rotation, readback and a separate human closure decision. From the accepted LINE receipt:

- **84.606 seconds** to verified rotation.
- **250.921 seconds** to completed incident closure.
- Old authority denied on 4/4 paths; new authority worked on 4/4 paths; zero participant target reads.
- 328/328 synthetic health probes succeeded until intentional shutdown after fencing.

These are response durations, **not extra time caused by deception**. The participant was scripted. Both Gmail messages were observed in the inbox and confirmed by the human, but their original provider receipts remain UNKNOWN. Run-01 remains UNKNOWN; run-02 completed rotation only; run-03 completed closure. The planned second additional full trial was not run, so full M9 remains PENDING.

The complete private timeline and raw evidence are preserved; public projections include original metrics and hashes while excluding credentials, recipients, ticket values and target bytes. Same-host sealing is labeled SAME_HOST_SELF_ATTESTED. [Human timeline and evidence](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/HUMAN_RESPONSE_RESULTS.md).

## How we built it

Node.js, SQLite and the official MCP SDK support the shared runtime. MCP uses protocol 2025-11-25 over Streamable HTTP. Human approval is outside the five participant tools. Durable request IDs, expected revisions, issuer-bound tickets and epoch checks preserve boundaries across retries and restart. A read-only lookup distinguishes COMMITTED, NOT_COMMITTED, UNKNOWN and CONFLICT without blindly repeating an uncertain write.

The selected public host includes the response policy, handoff, closure and evidence sealer; private OS code and history are not exported. The updated root checkpoint passes 779 tests, with additional host source/handoff and real-transport checks. Public CI and source manifests identify exactly what was tested. [Validation](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/VALIDATION.md) · [Design](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/HANDOFF_DESIGN.md).

## Alexa+ and Open Source contribution

This is the rules-permitted Alexa-style simulation with a real self-hosted MCP server, not a claim of Alexa service, Echo-device certification or AWS deployment. The retained governed-assistant workflow also demonstrates separate human approval.

DungeonQ existed before this hackathon. During the submission window we added persistent MCP worlds, protocol adapters, scoped tickets, bounded adaptation, independent consumer integration, interrupted-write recovery, task-linked continuation, source-wide authorization and human response/closure. [Development delta](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/DELTA.md).

Primary: **Alexa+**. Mini challenge: **Open Source**. GitHub: **Ranopha**. Contribution: [Ranopha/dungeonq-amazon](https://github.com/Ranopha/dungeonq-amazon), **Apache-2.0**. No AWS Builder entry or external-adoption claim is made.

## Challenges, learning and next steps

A working route does not prove false belief; a protected main endpoint does not protect an open alternate route; a provider receipt is not human acknowledgement; a configured delay is not causal benefit; and a call limit is not voluntary stopping. Those distinctions now shape the implementation and evidence.

Our human trial also exposed UI confusion between rotation success and closure. We record that guidance and Gmail receipt ambiguity rather than erase them. [Tool feedback](https://github.com/Ranopha/dungeonq-amazon/blob/main/docs/PRODUCT_FEEDBACK.md) covers scoped handoffs, explicit UNKNOWN semantics and negative-test examples; our own authorization defects are not attributed to Amazon's SDK.

Explicit provisioning, artificial resources, trusted gateway/host administrator and a shared kernel bound this reference. Automatic attack detection, production identity/connectors, independent external attestation, unannounced human response and causal extra time remain unproven or untested. Historical negative results, old films and closed WebMCP/Astra entries remain preserved.
