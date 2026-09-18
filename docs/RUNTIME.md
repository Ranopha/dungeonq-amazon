# Runtime operation and verification

## Installation and authority

Run `npm ci --ignore-scripts`, then `npm run runtime`. All local listeners bind to loopback. The CLI prints the operator URL, MCP endpoint, SSH/PG ports, workload socket and private credential-file path. Ports are selected dynamically. This is a reference installation with three provisioned contexts: `diverted`, `other` and `ordinary`.

The private `credentials.json` contains separate `owner`, `actor`, `other`, `ordinary`, `seal`, `producer`, `reader`, and `witness` capabilities. Do not pass this file, the signing key or the installation directory to an AI. An AI client receives only the actor token. The owner bearer represents a machine capability, not a password-account system or proof of a human's presence. No external identity provider, model or notification service is invoked.

Keep the installation directory private (0700, files0600). Keep its SQLite files, WAL state, signing key and configuration together when stopped. Start with the same `--data-dir` to resume. Existing incomplete, altered or unknown canonical/auxiliary storage fails closed. No destructive reset or automatic migration is offered.

## Operator workflow

1. Open the printed Control room URL and enter the owner token.
2. Read contexts, worlds and capability readiness. Availability describes an implemented adapter, not production certification.
3. Choose an active diverted context and either Fence context or Grant mutation. Preview changes nothing.
4. Review the exact context, action, proposal digest and expiry, confirm, then apply. Apply is separately authorized by the server and returns persisted readback.
5. Read evidence independently. An installation with no diverted request cannot pass real-diversion acceptance. Unknown, missing or failed checks must not be interpreted as verified.
6. Disconnect to clear the private view and memory-held credential. Reload also disconnects.

A mutation grant permits at most eight follow-up records for one hour, only in the approved synthetic context/epoch. Ticket use supplies a recorded observation. Each mutation consumes budget, checks the current revision, appends a deterministic record and preserves history. Fencing advances the epoch, persists across restart and invalidates outstanding authority. There is no participant unfence tool.

If an operation response is lost, keep its request ID. An exact retry may retrieve its previous canonical result without repeating an effect. Changed input under the same identity is rejected. An uncertain route remains in evidence; automatic reconciliation to a clean acceptance report is **not implemented**. Stop claiming acceptance and inspect the preserved records.

## Human and AI interfaces

Every operation carries `requestId`, `operation`, and `args`. Supported operations are `snapshot`, `read`, `write`, `issue-ticket` and `use-ticket`. The trusted transport supplies the family and derives context from the token. Request payloads cannot choose origin, tenant, authority or context.

JavaScript:

```js
import { createRuntimeClient } from '../sdk/runtime-client.mjs';
const client = createRuntimeClient({ origin: runtimeOrigin, token: participantToken });
const result = await client.operate({
  requestId: 'review-001', operation: 'read', args: { key: 'welcome' }
});
client.disconnect();
```

Python: load `sdk/runtime-client.py`, instantiate `RuntimeClient(runtime_origin, participant_token)`, then call `operate('review-001', 'read', {'key': 'welcome'})`. Both clients reject redirects, bound response/time budgets and avoid automatic mutation retries. Set `DUNGEONQ_TEST_PYTHON` if the test runner needs a particular Python3 binary.

The CLI uses `DUNGEONQ_RUNTIME_URL` and either `DUNGEONQ_OPERATOR_TOKEN` or `DUNGEONQ_CONTEXT_TOKEN`; run `node cli/runtime.mjs` for usage. Never put tokens in a URL or a committed command example.

MCP uses Streamable HTTP at the printed `/mcp` endpoint with a Bearer actor token. Its five `dungeonq_*` tools expose only participant operations; arguments are `{requestId,args}`. The standard MCP SDK is exercised by acceptance. This does not certify every AI vendor or model. No live model was run in this implementation.

SSH authenticates user `dungeonq` with the actor token and a pinned installation host key. The supported exec request is `dq <JSON operation envelope>`; `snapshot` and `read <key>` are convenience forms. PTY, shell, forwarding and subsystems are denied.

PostgreSQL-profile clients authenticate user/database `dungeonq` with the actor token. The only query shape is `SELECT dungeonq('<JSON operation envelope>')`, using normal SQL string escaping. One JSON `result` column is returned. No SQL engine, arbitrary queries, extended-query protocol, remote binding or external TLS support is claimed. Its prerelease gateway dependency is pinned. Disposable tokens travel only over loopback in this profile.

The managed-workload broker accepts one newline-delimited JSON envelope containing actor `token` plus the operation fields on the printed private Unix socket. Keep the connection readable until the response ends. It provides actual mediated execution; the reference acceptance additionally checks a Node permission-restricted subprocess cannot directly read an artificial protected file. Node permissions are not a hostile-code sandbox or general host enforcement agent.

## Evidence and isolation

The local reference starts separate origin, facade and collector processes. Canonical state and the gateway are trusted. Local processes share an OS user; this alone is not an isolation claim.

The [container profile](../deploy/runtime-reference/README.md) adds actual read-only nonroot containers, distinct role configuration/state volumes, dropped capabilities, finite resource limits and three internal networks. It exposes no host port. The facade reaches canonical state but cannot directly reach the artificial origin or evidence collector. Read denial must be paired with a positive read from the owning role. Containers share the dedicated VM's kernel; Docker-admin compromise and container escapes are outside the measured claim.

`npm run runtime:proof -- --out /absolute/private/report.json --isolation-report /absolute/private/isolation-result.json` runs real client/restart/negative acceptance and consumes a current complete source-matching infrastructure report. Evidence details are written beside the report with0600 permissions, using exclusive creation. The output must be outside the checkout. A missing/stale/mismatched isolation report or a dirty candidate prevents full gate acceptance. `DUNGEONQ_GIT` optionally selects the Git executable.

The producer binds commit, tree and the actual source content before/after the run. `npm run runtime:gate -- --report REPORT --commit COMMIT --tree TREE` checks the exact required census and candidate. Reports are local evidence, not independent cryptographic attestation. The public CI workflow runs reference acceptance on a dedicated ephemeral runner context. Repository required-check protection is a separate setting; a successful workflow alone does not prove merge enforcement.

## Failure and recovery

No synthetic transport failure causes an origin fallback. Capacity, invalid authority, stale revision, missing evidence and unreadable state return bounded errors. The gateway reserves a durable attempt before dispatch; interruption cannot disappear into a green result. Owner grant/fence application recovers an exact canonical action if its separate response record was lost.

Stop the CLI with Ctrl+C. Only its own children/listeners are closed; state remains. For containers, use `runtime:isolation -- down --directory ...` in the documented command shape, preserving volumes. Do not delete stores to resolve a failure. Before a future upgrade, preserve the stopped private installation and verify a restore into an isolated location. General upgrade migrations, backup tooling, distributed high availability and automatic unknown-outcome reconciliation remain unavailable.
