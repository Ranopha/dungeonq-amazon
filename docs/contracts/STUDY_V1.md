# Synthetic causal study contract v1

Owner: DungeonQ. Profile: `SYNTHETIC_CAUSAL_STUDY`. This is a finite causal experiment with no real vulnerabilities or external targets, not an autonomous attack workflow. Rules are fixed beforehand; participants are told that clues can be incomplete and receive the assignment at completion or withdrawal. Self-report is not mind-reading; a reference learner does not establish human/LLM efficacy.

The study namespace and databases coexist with `world/v1` without changing its format. Unknown versions are rejected. The trace boundary is `worldId + epoch + sequence`; test interfaces are pure functions, HTTP/MCP and `study:verify`. See [installation and recovery](../STUDY_LAB.md).

## Pure core: study/experiment.mjs

- `validateStudyDesign(input)` returns a frozen design: `{schemaVersion:'dungeonq.study-design/v1',title,seed,trainingRounds,probeBudget,labels:{signalOn,signalOff,structureOn,structureOff}}`. Training rounds: 2–8; probe budget: 1–5. Maximum JSON: 128 KiB. No code, URLs, credentials or additional fields. Two artificial example designs are supplied.
- `createStudy(design,{worldId,epoch,arm,rule,nonce})` returns JSON state. `arm` is `CORRELATED` or `DISCRIMINATING`; `rule` is `signal` or `structure`. The fixed nonce stays hidden. The first projection includes `assignmentCommit`; debrief reveals the committed assignment. The implementation uses the persistent world kernel and its causal checks.
- `projectStudy(state)` returns `{profile,worldId,epoch,revision,phase,assignmentCommit,title,consentNotice,room:{id,title,description},choices:[{id,label,features:{signal:boolean,structure:boolean}}],inventory,receipts,lastResult,pendingPrediction,debrief}`. Phases: `CONSENT`, `PREDICT`, `ACT`, `REFLECT`, `COMPLETE`, `WITHDRAWN`. Before consent, only the notice is available for participation. Unfinished projections exclude `arm`, `rule`, `nonce`, the full pack and research results. `lastResult` is `{choiceId,features,success,message,stage}` or null; `pendingPrediction` is the saved prediction command or null; `debrief` remains null until termination.
- `advanceStudy(state,command)` is pure and returns `{state,event,view}` without mutating input. Events contain `{schemaVersion:'dungeonq.study-event/v1',worldId,epoch,sequence,command,observation,beforeDigest,afterDigest,previousDigest,digest}`. Before/after digests omit `eventHead`; the final digest covers complete state.
- `summarizeStudy(state,events)` returns `{profile,phase,participantMode,arm,rule,trainingSuccesses,predictions,reflections,firstWrongConfidentStep,firstHighSuspicionStep,firstDiagnosticStep,wrongPredictionCount,missingPredictionCount,beliefStatus,efficacyClaim}`. Times are event sequences, not inferred psychological time. `efficacyClaim` is always `NOT_ESTABLISHED_FOR_HUMANS_OR_LLMS`.
- `makeStudyBundle(state,events)` returns `{schemaVersion:'dungeonq.study-evidence/v1',profile,design,worldId,epoch,arm,rule,nonce,events,finalDigest}`.
- `replayStudy(bundle)` returns `{valid:true,eventCount,finalDigest,summary}` or throws an error code. It reruns every command and compares full events, not only hashes.

## Shared HTTP/MCP commands

```text
{type:'consent',accepted:true,participantMode:
 'HUMAN_DECLARED'|'EXTERNAL_MODEL_DECLARED'|'UI_CHECK'|'REFERENCE_LEARNER'|'SCRIPTED_FIXTURE'}

{type:'predict',choiceId,predictedSuccess:boolean|null,
 hypothesis:'signal'|'structure'|'both'|'unknown',confidence:number|null,suspicion:number|null}

{type:'act'}

{type:'reflect',hypothesis,confidence,suspicion,
 nextIntent:'repeat'|'discriminate'|'proceed'|'stop'|'unknown'}

{type:'withdraw'}
```

`consent` is accepted only in CONSENT; a source declaration is not identity authentication. `predict` is accepted only in PREDICT and immutably records the choice before ACT. Confidence/suspicion accept 0–100 or null; `hypothesis:'unknown'` requires null confidence. Missing values are not zero.

`act` is accepted only in ACT and executes the saved choice; it cannot replace the choice. Fixed-rule feedback advances to REFLECT. `reflect` is accepted only there, preserves the post-result explanation separately, then advances to the next round or COMPLETE. An intention to stop is a report, not the withdrawal command.

`withdraw` ends any unfinished phase and reveals the assignment. Existing local events remain; withdrawal is not deletion or permission to export them.

## Fixed experiment structure

The CORRELATED training condition offers both-feature and neither-feature objects. DISCRIMINATING separates the factors in training round two. Both conditions use the same true rule and number of training rooms; rules do not change to manufacture failure.

Probe rooms offer the familiar both-feature object and two factor-separated objects. Repeated familiar choices are bounded by `probeBudget`, after which transfer is mandatory; a diagnostic choice advances sooner. `transfer` and `transfer-check` use new object names and separated factors. Predictions precede results; the second transfer round can reveal revision after a counterexample. A true causal feature changes world inventory and issues a world-local receipt, never an external effect. Maximum natural flow: 46 study events / 15 world actions.

## Durable store and transport

`openStudyStore({path,design,worldId?,epoch?,arm,rule,nonce?,maxPending=64})` exposes `.snapshot()`, `.command(envelope)`, `.exportEvidence()`, `.pending()`, `.ack(sequence,digest)` and `.close()` with the [world store's](WORLD_V1.md) semantics.

The envelope is `{requestId,expectedRevision,command}`; the store returns `{view,event,replayed}`. An identical request ID/content replays the original response; conflicting reuse is rejected. State, event, request and outbox are transactional. Unknown assignments, identity drift or corrupted state/journal/request/outbox fail closed, never resetting to an empty study. The hard event bound is 128; withdrawal has reserved capacity.

`startStudyLab({dataDir,design,arm,rule,actorPort=0,observerPort=0,mcpPort=0})` returns `{actorUrl,observerUrl,actorToken,observerToken,mcpEndpoint,mcpToken,worldId,observerProcessId,close}`. Observer runs in a separate process/database, acknowledges retention and has no reverse control channel. Backlog blocks ordinary interaction while preserving withdrawal capacity.

| Role | Endpoint | Result |
| --- | --- | --- |
| Actor | `GET /api/study` | Participant projection |
| Actor | `POST /api/study/command` | `{view,replayed}`, no full event |
| Observer | `GET /api/observer` | `{status,worldId,events,summary,verification,lag,profile}` |
| Observer | `GET /api/evidence` | Complete study bundle |

Actor, Observer and MCP use distinct tokens. The Observer can read the true assignment and is not the blind participant's entrance. Old world action routes are not exposed here. MCP 2025-11-25 Streamable HTTP supplies only `dungeonq_study_view` and `dungeonq_study_act`, with identical envelopes/projections. There is no tool to skip prediction, read unfinished truth or change conditions.

Listeners are loopback-only with exact Host/Origin checks, bounded bodies, authentication and CSP. Static files are allowlisted under `public/study`. UI code uses no inline executable content, unsafe HTML insertion or external resources. Tokens move from URL fragments into same-origin session storage. These controls do not isolate either role from an OS administrator.

## Measurement boundary

The reference learner sees only revealed participant observations and uses explicit hypotheses, priors and likelihood updates. It cannot read hidden arm/rule/pack values. Paired presentation seeds, rules and conditions retain stepwise posterior, choice, prediction and revision. Scripted scoring fixtures are not learners.

Reports keep `REFERENCE_LEARNER`, `UI_CHECK`, declared humans and declared external models distinct. High-confidence wrong hypothesis means an explicit hypothesis differing from the fixed truth with confidence ≥60. High suspicion means self-report ≥70. First discrimination means the event receiving an outcome with unequal factor values. Unknown is not correct, failed or zero-confidence. Confidence, outcome surprise and subjective suspicion are separate quantities.

The surface-biased prior is `signal=.15, structure=.05, chance=.80`; the neutral prior assigns each feature .10. Correlated observations preserve the relative odds of the two deterministic hypotheses while reducing chance weight. The 48 presentation/prior/policy/rule/condition units are not 48 independent participants. The two-session Codex pilot's negative induction result and unattested model identity remain explicit in the [results](../STUDY_RESULTS.md).
