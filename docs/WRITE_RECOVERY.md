# Recover a write whose reply was lost

Theodor N. Engøy raised this case on the October 9 Product Hunt discussion: a saved synthetic note and a lost client reply must not be treated as proof that it is safe to write again. v0.14.0 adds a read-only inspection path. It does not resend a write automatically.

## See the result

Open the [current walkthrough and film](https://dungeonq-astra.kq7dn7jb6r.chatgpt.site/#write-recovery), or inspect [the recorded JSON](../evidence/write-recovery-v1/report.json). In a running reference, the **Control room → Read evidence → request timeline** marks a verified canonical write even when the collector reports UNKNOWN. **World records** shows current contents; the original saved result comes from the exact write-status query below. Later writes may have changed the current record.

The participant workspace displays **Commit recovered from journal; readback pending**, then performs a separate readback. The standalone MCP consumer prints a `write-recovered` scene before its separate read and ticket use. Five MCP tools remain unchanged; recovery is an authenticated companion HTTP endpoint.

## Reproduce the interrupted connection

```sh
npm ci --ignore-scripts
npm run recovery:demo -- /absolute/new/path/write-recovery.json
```

Use a new output path outside the checkout. The harness starts only owned loopback artificial services and closes them afterward. It cuts the facade reply **after** the canonical transaction, runs the real standalone MCP consumer, and verifies exactly one write and zero automatic write retries. It restarts the gateway, finds the same canonical event digest, and tests an authenticated stale-revision refusal and a connection lost before execution. Source hashes accompany the report.

The report's `status: PASS` means its named recovery assertions passed. The deliberately faulted installation's overall evidence remains `FAIL`, with both UNKNOWN attempts preserved. There is no clean-acceptance claim for this faulted run.

## Query the exact original write

Actor HTTP: `POST /api/write-status` on the gateway. MCP-family actor: companion HTTP `POST /write-status` on the MCP listener (same origin as `/mcp`). This route is not an MCP tool and is not invoked with `tools/call`. Authenticate with the same actor Bearer token. Both accept only:

```json
{
  "requestId": "review-001",
  "operation": "write",
  "args": {"key": "welcome", "value": "Review completed.", "expectedRevision": 0}
}
```

The server derives context and adapter from the credential and endpoint. The operator uses `POST /api/operator/write-status`, adding the original `contextId` and `family`, with owner authority. The original operation must match byte-equivalent canonical JSON, including expected revision; do not substitute the current revision. The Node client exposes `writeStatus(input)`, `inspectWrite(input)` and `writeWithRecovery(input)`. The last sends one write and at most one read-only lookup, returning `{result,recovered}` only for a matching proven result. Existing Python and CLI clients can call the documented endpoint explicitly; no new automatic behavior is claimed for them.

| State | What the response establishes | Next step |
| --- | --- | --- |
| COMMITTED | Authenticated journal replay contains the exact successful command and original saved response, sequence and event digest. | Use the saved response, then read current state separately. Do not create another write. |
| NOT_COMMITTED | At the verified journal checkpoint, all observed matching attempts are exact authenticated no-effect refusals and no matching dispatch is pending. | Inspect the refusal and current revision. This is not permission for an automatic retry or a promise about future calls. |
| UNKNOWN | No conclusive commit/refusal, a pending dispatch, an unsigned error, response loss or missing evidence. Absence alone never means not committed. | Retain the request identity and investigate; automatic retry remains disabled. |
| CONFLICT | This request identity was used with a different payload or adapter. | Recover the original request details; do not overwrite the identity. |

Every response sets `automaticRetryAllowed: false`. Corrupt/unverifiable canonical storage fails instead of returning a commit. Actor tokens cannot inspect another context; fenced actors lose lookup access while the operator can inspect retained history. This is authentication within DungeonQ's trusted reference, not third-party attestation or a solution for arbitrary external public writes.

## What if the gateway restarts before the first recovery lookup?

The local October 11 follow-up tests this ordering with the original durable installation and valid actor authority retained: **write commits → reply is lost → client disconnects → gateway stops and reopens → first HTTP write-status query → separate current-state readback**. In the MCP-family case, the MCP client remains disconnected during recovery lookup and is recreated afterward for the readback. The earlier October 10 film recovered before restarting; these are separate recorded checks.

```sh
npm ci --ignore-scripts
npm run recovery:restart -- /absolute/new/path/restart-recovery.json
```

| Request family | Original write | First recovery lookup after restart | Later current-state readback |
| --- | --- | --- | --- |
| HTTP | HTTP `POST /api/operate` | HTTP `POST /api/write-status` via a new runtime SDK client | HTTP `POST /api/operate` |
| MCP | MCP `tools/call` → `dungeonq_write` | Companion HTTP `POST /write-status`; no MCP client connected | Recreate MCP client, then `tools/call` → `dungeonq_read` |

The family binds the original request identity; it does not identify the recovery query protocol. An MCP-only client needs a companion HTTP integration to use this lookup. No MCP-native recovery operation is exposed or tested.

Both cases save exactly one note, recover its original value and commit digest, and perform a separate current-state read. Repeating the status lookup does not alter the canonical journal. Each case keeps its UNKNOWN transport record and overall evidence FAIL; recovery is not a clean transport-acceptance result. [Recorded results](../evidence/restart-recovery-v1/report.json) bind the tested source bytes and name `writeTransport`, `recoveryLookupTransport`, `recoveryLookupPath` and `readbackTransport`. `mcpClientConnectedAtFirstLookup` records the connection state before lookup; `mcpClientRecreatedForReadback` applies only to the later MCP read. These replace the ambiguous `clientRecreated` field. CI reruns this command on Linux and macOS.

For a real client reconnect:

1. Preserve the original request ID and **complete original payload**, including the old expected revision. Do not reconstruct it from a later snapshot or allocate a new ID.
2. Reopen the same private runtime data directory and credentials. Connect to the running endpoint; a launcher using ephemeral ports may print a different URL after restart. Do not initialize a replacement empty world.
3. Use the actor endpoint matching the original adapter: HTTP `POST /api/write-status`, or MCP's companion HTTP `POST /write-status`. A normal HTTP status lookup cannot recover an MCP request as though it were an HTTP request.
4. Only COMMITTED supplies a proven original saved result. For MCP, recreate the MCP client against the running `/mcp` endpoint for the separate `dungeonq_read` tool call. Read the current record separately, because another authorized write may have changed it. UNKNOWN remains unresolved; NOT_COMMITTED describes an authenticated refusal at its checkpoint. Neither authorizes an automatic retry.

Regression checks also retain UNKNOWN and authenticated-refusal distinctions across restart, reject a changed expected revision, and verify that a fenced actor stays blocked after restart while the operator can inspect the historical commit. Lookup never restores revoked authority.

This is a controlled gateway stop/reopen test with intact local storage, not a power-loss, disk-corruption, machine-loss or production-failover test. It does not add persistent browser drafts or an autonomous retry loop. The client must retain its request details; if it cannot, preserve the uncertainty and ask the operator to inspect the retained history.

## Historical walkthrough

The [October 8 Initial Machine film](INITIAL_MACHINE_FILM.md) uses a deliberately pinned v0.13.1 runtime and recorded model comparison. It remains reproducible and unchanged. The new recovery example exercises the **current root DungeonQ runtime** and the standalone consumer; it is a separate local fault-injection result, not a rerun of Astra max.
