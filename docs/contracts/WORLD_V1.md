# Closed world contract v1

Owner: DungeonQ. Independent of `scenario/v1` and Astra candidate v1. Fixed profile: `ABSTRACT_SYNTHETIC_WORLD`. Only finite declarative causal interactions are allowed—not exploitable vulnerabilities, arbitrary protocols or a security sandbox. See the [operator guide](../WORLD_LAB.md).

## Pack

```text
{schemaVersion:'dungeonq.world/v1',title,seed,maxSteps,startRoom,
 initialFlags,hypotheses,rooms}

hypotheses:[{id,label}]

room:{id,title,description,clues:[{text,requires:[flag]}],choices:[
 {id,label,requires:[flag],grants:[flag],consumes:[flag],to,outcome,message,reward}
]}
```

Text is length-bounded and excludes active content, URLs, file paths and credential patterns. Limits: 24 rooms, 96 choices, 32 flags, 12 hypotheses; `maxSteps` 4–200; JSON 128 KiB and depth 10. Unknown fields are rejected. Seed fixes pack identity/replay input; v1 does not generate undeclared topology from it.

Hypotheses are selectable explanations, not measured beliefs. Choice outcomes are `SUCCESS`, `PARTIAL` or `DEAD_END`; `reward` is boolean. Room references must exist and choice IDs are globally unique. Unmet conditions yield `BLOCKED` without secretly changing state or inventing a room. Every room must be structurally reachable from the start; this does not guarantee every player obtains every reward.

## Pure kernel: world/kernel.mjs

- `validateWorldPack(input)` returns a deeply frozen normalized pack or throws an Error with `.code`.
- `createWorld(pack,{worldId,epoch})` returns JSON-serializable state; identity fields use restricted characters.
- `projectWorld(state)` returns the Actor view without the full pack, unseen clues, choice requirements, Observer report or full journal.
- `advanceWorld(state,command)` returns `{state,event,view}` without mutating input. Request ID/revision belong to the store, not the command.
- `worldDigest(value)` computes canonical-JSON SHA-256.
- `replayWorld(bundle)` verifies pack, initial identity, complete events and final digest by re-executing causal logic. Success returns `{valid:true,eventCount,finalDigest,summary}`; failure throws.
- `summarizeWorldEvents(events)` returns explicit self-reports and behavioral counts, not inferred private beliefs.

Commands:

```text
{type:'inspect'}
{type:'choose',choiceId}
{type:'report',hypothesisId,confidence:0..100,suspicion:0..100,nextChoiceId:null|string}
{type:'redeem',receipt}
{type:'rebuild'}
```

Every accepted command enters the journal and consumes a step; exhaustion blocks new commands but permits snapshots/export. `rebuild` increments presentation generation while preserving narrative state; it is not a deployed-runtime rebuild. A receipt binds world ID, epoch, choice ID, issue step and digest. Only receipts present in current state can be redeemed.

Actor view:

```text
{profile,worldId,epoch,revision,generation,stepsRemaining,
 room:{id,title,description,clues:[string]},choices:[{id,label}],
 hypotheses:[{id,label}],inventory:[string],visited:[string],receipts:[object],
 lastObservation:{outcome,message,reward:null|object}|null}
```

Revision increments for each accepted command. Events contain sequence, previous digest, command, observation, before/after digests and digest. `state.eventHead` is the previous event digest. Before/after state digests omit `eventHead` to avoid self-reference; the final digest covers complete final state. Comparing strings alone is not causal verification.

Evidence bundle:

```text
{schemaVersion:'dungeonq.world-evidence/v1',profile:'ABSTRACT_SYNTHETIC_WORLD',
 pack,worldId,epoch,events,finalDigest}
```

## Durable store: server/world-store.mjs

`openWorldStore({path,pack,worldId,epoch})` initializes or reopens a database. A mismatched existing pack/world ID/epoch is rejected. It exposes `.snapshot()`, `.command({requestId,expectedRevision,command})`, `.exportEvidence()`, `.pending()`, `.ack(sequence,digest)` and `.close()`.

An identical request ID/content returns its original response without another step. Reusing the ID with different content fails. State/event/outbox updates share one SQLite transaction. Store commands return `{view,event,replayed}`; pending returns unacknowledged events. ACK must match the retained digest. Size, expiry and validation failures never silently grant authority.

## HTTP and process boundaries

`server/world-lab.mjs` and `scripts/world.mjs` provide separate endpoints without changing the governed assistant. Listeners are loopback-only with exact Host/Origin checks, static allowlists, CSP, bounded JSON/body handling and timing-safe Bearer authentication. Actor and Observer credentials differ; the Actor has no Observer control or full-export shortcut.

| Role | Endpoint | Result |
| --- | --- | --- |
| Actor | `GET /api/world` | Actor view |
| Actor | `POST /api/world/command` | `{view,replayed}`; never the full event |
| Observer | `GET /api/observer` | `{status,worldId,events,summary,verification,lag,profile}` |
| Observer | `GET /api/evidence` | Evidence bundle |

Each role's `GET /` serves its UI. Tokens cannot cross roles. Launcher `--pack PATH` / `--data-dir PATH` are explicit local-operator choices, not arbitrary browser imports. Optional `--actor-port`, `--observer-port` and `--mcp-port` default to 0 for automatic assignment. Reopening the same directory restores identity/epoch; tokens are newly issued.

The page reads `#token=...`, clears the fragment and retains the token only in same-origin session storage. API calls use the Authorization header; there is no cross-origin CORS access.

The Observer is a separate process/store receiving immutable events through an internal append channel, with no reverse runtime command API. ACK certifies retained sequence/digest, not permission to act. Pending events survive unavailable observation; a full bounded outbox stops new actions.

## Observation claims

Success, blocked/dead-end counts, first high-suspicion report, hypothesis changes and reported confidence describe retained records only. Without a report, belief status must remain UNKNOWN. Fluent text or successful actions cannot substitute for belief evidence. Fixed drivers must be labeled SCRIPTED, not real human/model deception. Shared-host administrators can access both sides; process separation is not container/VM acceptance.

## Standard MCP adapter

`server/world-mcp.mjs` uses the official SDK for stateless Streamable HTTP, fixed protocol **2025-11-25**. Only `dungeonq_world_view` and `dungeonq_world_act` are available, using the same store instance. The latter accepts exactly the store command envelope. Store checks enforce expected revision and idempotency.

Outputs contain only Actor projection/replayed status, not complete events, undiscovered clues, full pack or Observer identity. The separate loopback MCP endpoint uses the **same Actor token** and gains no Observer authority. There are no model, arbitrary destination, approval or administrative tools. Errors are bounded codes, not shell output. Real SDK-client tests exercise handshake, listTools and callTool parity with direct store behavior.
