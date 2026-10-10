# External MCP integration example — v0.13.0

**v0.14.0 recovery:** the current standalone consumer sends one read-only lookup after an interrupted write and continues only when the exact canonical commit is proven. It never automatically resends the write. See [outcomes, reproduction and limitations](WRITE_RECOVERY.md).

DungeonQ includes an independent shipping-review consumer at [`examples/mcp-shipping-consumer/`](../examples/mcp-shipping-consumer/README.md). It can be copied into another Node project and connect to an existing `participant-v1` reference using only the public MCP interface. Its runtime dependency is the pinned official `@modelcontextprotocol/sdk`; it imports no DungeonQ runtime implementation.

**Maturity:** a working, locally verified, scripted integration with an artificial reference. No independent adopter, live AI, human presence, production connector, or deception-effectiveness result is established by this example.

## Reproduce the complete reference

Prerequisite: Node 24.15+; a clean v0.13.0 checkout.

```sh
npm ci --ignore-scripts
npm run oss:demo -- /absolute/path/new-report.json
node --test tests/oss-integration.test.mjs
```

The root install is sufficient; the harness can also be invoked with `node scripts/oss-integration-demo.mjs /absolute/path/new-report.json`. The report path must be new. No model account, production credential, external target, paid service, or public runtime is needed.

The harness creates private, disposable local storage and starts the existing reference factory with the participant presentation. It disables unneeded SSH, PostgreSQL, and host-broker adapters for this example. Fixture setup is the harness's only private runtime dependency. Consumer operations, operator observations/approvals, ordinary-origin control, and independent witness reads use the public MCP/HTTP surfaces. The fixture is removed after the run; the report is retained.

## Authority and data flow

| Process / role | Receives | Performs |
| --- | --- | --- |
| Independent consumer | Actor MCP endpoint and actor token; non-authority run options | Five public MCP tools: snapshot, read, write, issue ticket, use ticket |
| Trusted operator harness | Disposable reference owner, ordinary and witness capabilities | Observes collector-backed evidence, previews an exact policy, explicitly applies it, checks origin witness |
| Independent artificial origin | Its separately configured ordinary/witness capabilities | Admits the ordinary positive control; rejects the world ticket; reports its data/configuration digests and admission interval |
| Independent collector | Its own producer/reader capabilities | Records gateway events for correlation with canonical state and origin evidence |

The child has a sanitized environment and uses Node's permission model with code/dependency read allowlists, no filesystem writes, and no subprocess grant. A separate probe under the same launch policy confirms `ERR_ACCESS_DENIED` when reading the fixture credential file. The actual actor token is also refused by status, evidence, preview and apply operator endpoints. These are concrete checks of this cooperative program. Node permissions and same-user processes are **not hostile-code, OS, cloud, or administrator isolation**; use the separately documented container reference for that measured boundary.

The operator harness alone starts the reference, and the actor cannot initialize or reconfigure it. Approval in this example is scripted by the operator fixture. An operator bearer and a continuation message do not attest that a human reviewed anything.

## Stable scene and evidence contract

The report schema is `dungeonq.oss-integration/v1`. `sourceVersion` is read from the current checkout. `scenes` have stable IDs, observed timestamps, and allowlisted results suitable for documentation or a recording. Credentials, raw tickets, endpoint URLs, temporary paths, proposal identifiers, and signing material are omitted.

| Scene | What the run measures |
| --- | --- |
| `authority-boundary` | Secret-file read denied; actor rejected by four operator endpoints; actor-only input |
| `consumer-connect` | An actual SDK client discovers the five MCP tools |
| `shipping-review` | Reads Order 41 and the rule that shipping approval is separate |
| `write-readback` | Multiline note written at revision 1 and read through a separate MCP request |
| `operator-approval` | Separate operator observes synthetic routing, previews and applies the finite policy |
| `world-ticket` | One-use ticket returns the saved note; one permitted follow-up appears at revision 2 |
| `origin-boundary` | Ordinary positive reachability, direct world-ticket denial, unchanged artificial data/configuration |
| `final-evidence` | Canonical replay, route census, known outcomes, and independent artificial-origin checks all pass |

The finite runtime policy allows **at most eight** follow-up mutations for **one hour**; this run uses **one**. The ticket itself is valid for at most 60 seconds and one use. The consumer cannot mint an origin capability or authorize policy.

The report retains a minimal route census plus pre/post origin data/configuration digests and the exact admission interval. The ordinary read is a positive reachability control, not an unprotected attacker baseline. The origin is an independently authenticated artificial service with separate storage, not a production asset. Its audit records change as measurement occurs; “unchanged” applies only to the named protected data/configuration.

`PASS` requires consumer success, nonempty all-PASS runtime evidence, the expected independent origin interval, secret/owner denials, and one use of the finite policy. Missing, failed, unknown or inconsistent evidence never becomes a successful integration result. A failed consumer may have already saved its review; reconcile its state rather than assuming rollback or no effect.

This example checks durable canonical state and a separate request readback. It does **not** stop and restart the services; restart/replay acceptance remains in the runtime suites and historical judge demo.

## Connect to an existing reference or your own application

The [package README](../examples/mcp-shipping-consumer/README.md) provides standalone install, stdin configuration, library import, and optional operator handoff instructions. You may copy only that package and install its lockfile outside this repository. The test suite also runs such a detached package against an existing reference, reusing installed public dependencies offline.

Supply only actor authority, provision the shipping fixture through trusted setup, preserve request identity and revision checks, and treat all remote content as data. New business records, actions, origin adapters or policies need their own contracts and tests. No arbitrary SQL, shell, production shipping, account lifecycle, model automation, or transparent traffic interception is provided by this sample.

See [Runtime v1](contracts/RUNTIME_V1.md) for canonical authority and ticket semantics, and [`evidence/oss-integration-v1/report.json`](../evidence/oss-integration-v1/report.json) for the published local execution. This report is authored project evidence. It is not a customer testimonial, deployment acceptance, or external adoption.
