# Closed world: install, explore and verify

This is an interactive, persistent **abstract synthetic world**. It adds a real stateful environment alongside the governed decision rehearsal, but is not an exploitable vulnerability environment and does not establish that a person or model was misled. For the separate prediction-before-action experiment, see the [causal study](STUDY_LAB.md).

## Start and resume

Requires Node.js 24.15.0+; no API key or model call is needed.

```sh
npm ci --ignore-scripts
npm run world
```

The terminal prints three loopback entry points: participant, independent Observer and standard MCP. Open the first two in separate tabs. Their credentials differ. Keep token-bearing URLs out of public screenshots, repositories and recordings. Pages move the fragment token into their own origin's session storage and clear the fragment; this is not a vault against local administrators.

Stop with Ctrl+C. Keep the printed data directory. To resume the same world:

```sh
npm run world -- --data-dir ../private-world-data
```

Use the actual directory from the earlier run, or deliberately choose a new private directory for a new world. Keep it outside the repository and accessible only to its owner. Do not commit `world.sqlite`, `observer.sqlite` or their sidecars. Restart preserves identity/state but issues new tokens. For a custom pack, also supply that same `--pack` file.

## A short exploration route

The current world UI is in Traditional Chinese; the default Clockwork Archive uses these labels:

1. Take the amber seal (`拿起琥珀印記`), open the old gallery, then the old reading room. Accepted choices change persistent state and produce three world-local receipts.
2. Try the Moonlight Hall (`嘗試進入月光館`). `BLOCKED` means the previous successes do not satisfy this room's different condition.
3. Optionally report a hypothesis, confidence and suspicion. No default self-report is recorded. In the Observer, select `更新並重播核驗` (refresh and replay); an unreported belief remains UNKNOWN.
4. Return to the hall, visit the garden, obtain the moon ticket and use the new-wing entrance to reach Moonlight Hall. The pre-existing alternative condition now holds.
5. Use `重建合成呈現` (rebuild presentation) and revisit rooms. Inventory, location and outcomes persist. This changes a presentation generation, not a container or deployed runtime; actual process restart is tested by stopping and reopening the same directory.
6. Check a receipt locally. The cross-world rejection control alters its synthetic world identity and should be refused. The proof separately starts genuinely different worlds and checks non-interchangeability.

For an uncertain response, use the pending-action confirmation control; preserve request ID and expected revision rather than sending a new action. The default pack has an 80-step allowance. After exhaustion, snapshots, export and verification remain available.

## Bring an artificial world pack

```sh
npm run world -- --pack world/packs/reviewer-lanterns.json
```

The second example has its own rooms, flags and conditions. Copy an example outside the repository and edit declared title, seed, rooms, choices, requirements, grants, consumption, clues and hypotheses under [WORLD_V1](contracts/WORLD_V1.md). The launcher accepts the operator's local JSON path; the page does not accept arbitrary paths or URLs. Seed fixes pack/replay input, not dynamically generated rooms.

Limits: 24 rooms, 96 choices, 32 flags, 12 hypotheses and 4–200 steps. Unknown fields, broken references, structurally unreachable rooms, external resources and executable content are rejected. Packs cannot carry shell commands, scanners or protocol adapters.

## MCP and repeatable evidence

The launcher serves MCP 2025-11-25 Streamable HTTP. World MCP uses the Actor Bearer token and only `dungeonq_world_view` / `dungeonq_world_act`. Both share the same SQLite state and request ID/revision rules. There is no Observer or approval tool. This endpoint is distinct from the older governed-assistant endpoint and from study MCP, which uses its own dedicated token.

```sh
npm run test:world
npm run world:proof
npm run world:verify -- /absolute/path/to/downloaded-world-evidence.json
```

Download the complete pack/events from the Observer. The offline verifier reruns each causal rule; recomputing digests cannot make an impossible transition valid. `world:proof` starts two separate local worlds and an official MCP client to check persistence, distinct conditions, cross-world rejection, restart, observation and replay. It creates a private temporary output directory and labels itself `SCRIPTED_FIXTURE_NO_MODEL`, with `deceptionEfficacy=NOT_EVALUATED`.

## Limits and recovery

- Actor and Observer use separate processes, SQLite stores and tokens. The Observer cannot control the world. A shared OS administrator can access both; this is not container/VM isolation or an enterprise network boundary.
- Retention ACKs bind sequence/digest. Unacknowledged events remain in a bounded outbox; 64 pending events stop new actions. Observer interruption can restart, catch up and deduplicate. Corruption is not silently ignored or reset.
- Displayed lag is relative to the latest received notification, not a guarantee of complete real-time observation. Replay supports consistency of retained events, not honest source identity, external non-repudiation or actual beliefs.
- This exploration pack is disclosed causal teaching, not a blinded efficacy study. Its results must not be pooled with the separate study's declared participants.
- Stop all lab processes before backing up the complete private directory. Keep existing evidence and use matching pack/state when restoring. World databases are independent of the older governance schema and `scenario/v1`; stopping this launcher leaves those experiences unchanged.

Static public hosting cannot supply this independent server-side Observer. Install locally to test that architecture.
