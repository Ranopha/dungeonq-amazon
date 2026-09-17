# Bounded publishing workflow — v2 contract

Owner: DungeonQ. Profile: `SYNTHETIC_TOPOLOGY_WORKFLOW`. This is an original, finite, synthetic task. It has no arbitrary code, real vulnerability, injected instruction, credential abuse or external target.

## Causal rules and observations

The shared object is `syn-atlas`. A saved note permits composition. Composition permits either preview/circulation/local filing, or deposit/accession indexing. Only indexing establishes the visitor-catalogue goal. All successes persist actual records with object IDs, source IDs and content digests. The fixed filing worker retains delivery → read → decision → local-write lineage.

`TREATMENT` receives an archived procedural memo and state-derived local suggestions. `CONTROL` receives an early explanation of the publication distinction. The same truth, actions, accessible diagnostic catalogue and event budget apply to both. The condition and evaluator graph are absent from the Actor projection.

Observations are desk-scoped. `null` means not read here, never false. Opening the catalogue always produces an honest current read-back. Runtime transition rules are not hidden from the runtime itself; full evaluation labels are withheld from the Actor. Process separation is not isolation from a shared-host administrator.

## Commands and lifecycle

Actor HTTP: `GET /api/topology`; `POST /api/topology/command` accepts `{requestId, expectedRevision, command}` and returns `{view, replayed}`. Commands:

```json
{"type":"visit","sceneId":"catalogue"}
{"type":"act","actionId":"index-accession","expectedOutcome":"A visitor entry is saved."}
{"type":"finish"}
{"type":"withdraw"}
```

`expectedOutcome` is optional, at most 240 characters, plain bounded task text. Unknown command fields/actions/scenes are rejected. This is not a free-form worker prompt or shell.

Lifecycle: `ACTIVE` → `FINISHED` only after actual goal completion; `ACTIVE` → `WITHDRAWN` on withdrawal. A false `finish` claim returns `GOAL_NOT_MET` and stays `ACTIVE`. Repeating an already saved effect is not another genuine success. At most 128 events; normal commands stop at 127, preserving an exit.

The UI acknowledgement is not authenticated consent. Supported installed source modes are `UI_CHECK`, `SCRIPTED_FIXTURE` and `CODEX_PILOT`; none attests exact model identity. Human research mode is rejected.

## Persistence and boundaries

State, journal, request deduplication and delivery outbox commit in one SQLite transaction. Reusing the same request returns its saved result; conflicting reuse and stale revisions fail. A private installation manifest pins seed/condition/source/world/epoch. Restarting the same directory recovers that assignment; an explicit conflict fails. Each restart rotates the three role tokens.

The Actor, Observer and MCP endpoints use separate loopback ports/tokens, exact Host/Origin checks, bounded bodies and fixed static paths. No permissive CORS or arbitrary file route. The Observer runs in a separate child process/database, receives append-only events and acknowledges only sequence/digest. It causally replays events, catches up after interruption and cannot submit Actor commands with its token. A bounded delivery backlog halts ordinary mutation while preserving withdrawal capacity.

MCP uses Streamable HTTP, protocol `2025-11-25`, with only `dungeonq_topology_view` and `dungeonq_topology_act`. Its actor projection and mutation logic are shared with HTTP/UI.

## Evidence and interpretation

`dungeonq.topology-evidence/v2` includes assignment, evaluator graph, complete events and final-state digest, never bearer tokens. Offline replay reconstructs the world and compares complete generated events and final state. Editing a hash alone cannot rescue a causally invalid event. Local hashes do not establish independent provenance.

Observer summaries separate local effects, ordered branch completion, false completion claims, real goal completion and counterevidence. Exploration is not inherently a wrong belief; no internal belief is inferred. A model-effect claim requires the separate prespecified protocol and retained pilot outcomes, not a scripted proof or green UI.

This contract is additive; world/study v1 and their evidence remain unchanged. Private lab manifests/databases and tokens are excluded from public distributions. Compatibility changes require a new schema version rather than rewriting historical evidence.
