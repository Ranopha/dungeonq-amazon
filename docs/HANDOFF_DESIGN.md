# Source-wide response and human closure contract

v0.16 extends the bounded world with a separately authorized response path. False exits, memory conflict and useful continuation retain the [existing design](CONTINUATION_DESIGN.md). Narrative claims never change a source principal or route.

## Source authority

MAIN, A2, CACHE and EXPORT check the same server-held tenant, resource capability and persistent credential epoch. Overview responses expose keys/metadata only. A2 holds neither a target copy nor an operator credential; it forwards only fixed permitted requests to the origin. Cache requests recheck the origin and return UNKNOWN if it is unavailable, rather than disclosing stale contents. A role string, request ID or world ticket grants no source authority.

Rotation prepares a replacement capability, checks readiness on all four routes and commits atomically with bounded overlap. Cancellation, expiry, repeated requests and restart preserve the revocation contract. Missing authority state fails closed; it cannot silently recreate old authority. Revocation cannot retrieve bytes already disclosed.

## Human control plane

The participant has no ACK or decision tool. A loopback-only page requires the enrolled human account, a single-incident expiring link, password and TOTP when enabled. Same-origin state-changing requests and exact incident/target binding are checked. ACK, A-2 decision and START_CLOSE are separate events. An authenticated ACK is necessary but does not alone authorize rotation.

The selected DungeonQ policy module is the decision point; the connector verifies the decision again. The gateway's fixed source-control operations are unavailable to the participant. An uncertain response triggers a bounded readback; it is not automatically retried as a new side effect. Unknown times stay null/UNKNOWN.

## Closure and evidence

Only confirmed rotation enables human closure. The flow freezes the incident context, seals evidence, revokes old authority and probes it, records fence disposition, notifies the affected operator, and produces a post-incident report. A failed candidate rule remains unpublished. SAME_HOST_SELF_ATTESTED names the current key-custody boundary.

Provider receipt, inbox observation, authenticated ACK, decision, atomic effect, verified effect and closure are distinct facts. Later evidence may supplement an earlier UNKNOWN, never silently replace it. Preserve self-stop, call-budget stop, failed attempts and the source/host clocks separately.

## Integration limits

All default automated checks use artificial resources, fake senders and test accounts. The public human runner is opt-in and requires the operator's own isolated Colima profile, account and channel configuration. No credentials, recipient config or production file ships with this repository. A dedicated VM must not mount host files. No model API call is made by these tests.

The latest public code includes the repaired source boundary, but no new paid AI trial evaluated that repair. The [nine historical Sol sessions](MODEL_RESULTS.md) used an open A2 fixture and disclosed the target in every run. The [human rehearsal](HUMAN_RESPONSE_RESULTS.md) proves only its recorded workflow and fixture checks. Additional response opportunity is the goal; a causal benefit over transparent isolation is unproven.
