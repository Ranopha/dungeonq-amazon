# Independent MCP shipping-review consumer

A small, reusable **scripted** Node client. It imports only the official MCP SDK and Node built-ins, and talks to an existing DungeonQ reference through MCP Streamable HTTP. It does not import the DungeonQ runtime, read a credential bundle, create a server, or receive operator/origin authority.

The task is deliberately narrow: read `order-41` and `review-policy`, save a multiline review to `welcome`, read it back, and issue/use a one-use world ticket. Shipping remains pending. This is synthetic workflow interoperability, not an AI evaluation or shipping connector.

## Fastest complete reproduction

From a DungeonQ checkout with Node 24.15+:

```sh
npm ci --ignore-scripts
npm run oss:demo -- /absolute/path/new-report.json
```

Only the root installation is needed for this command. The operator harness starts a fresh artificial reference, runs this consumer in another process, observes it, explicitly applies a finite operator fixture policy, independently checks the artificial origin, saves a credential-free report, and closes/removes its own temporary fixture. It refuses to overwrite an existing report.

## Copy this package into your own project

Copy this directory, including `package-lock.json`, outside the DungeonQ repository. Then:

```sh
npm ci --ignore-scripts
npm start < /absolute/path/private-actor-input.json
```

The private input is a single JSON line with exactly these required fields:

```json
{"endpoint":"http://127.0.0.1:REPLACE_PORT/mcp","actorToken":null}
```

Replace the illustrative null with the actor-only string supplied privately by the operator. Never use the placeholder as a working configuration.

Have the trusted operator supply an actor-only input through your secret manager or a private file outside source control; never supply the reference's complete `credentials.json`. Keep that file private (mode `0600`). The CLI consumes stdin; it does not open the input path itself. Do not put credentials in command arguments, reports, screenshots, or commits. The process receives no other credential from this package. When launching it yourself, sanitize the environment and apply the filesystem restrictions appropriate to your host.

The existing server must use the `participant-v1` presentation and have the synthetic shipping records. A trusted operator can create that reference separately using `npm run runtime -- --presentation participant-v1`. Only pass the printed MCP endpoint and the **actor** capability to the consumer. Provisioning, storage access, and operator credentials stay with the operator.

Alternatively import the function into a separate Node application:

```js
import { runShippingReview } from './client.mjs';

const result = await runShippingReview({
  endpoint: actorConfiguration.endpoint,
  actorToken: actorConfiguration.actorToken,
});
console.log(JSON.stringify(result));
```

`actorConfiguration` is supplied by your own trusted actor-only configuration source. `requestPrefix` is optional; the default is unique per run. Concurrent edits can cause a revision conflict, and errors propagate instead of producing `PASS`. Do not retry a partially completed run by casually reusing request identities; reconcile it with the operator first.

## Optional operator handoff

Without a handoff, the consumer performs review and ticket use without granting an adaptation policy. Its `PASS` means its own MCP task completed; it says nothing about the origin or operator approval.

For the CLI, set `waitForOperator:true` in the first input line. It emits `{"type":"operator-boundary",...}` after the write/readback and waits for a second line exactly `{"continue":true}`. That line only resumes the script; it grants no authority. A separate authorized operator must preview and explicitly apply any policy through the public operator interface. The fixture harness demonstrates this handshake. Its grant is limited to eight follow-up mutations for one hour and this run consumes one. It is labeled **SCRIPTED_OPERATOR_FIXTURE**, not an independent human approval.

The library exposes `beforeTicket`, `onScene`, and `onTicket` callbacks. `onTicket` handles a short-lived capability: do not log it. The harness receives the ticket over private IPC only to check denial at its artificial origin; normal CLI stdout always omits it.

See [the integration guide](../../docs/EXTERNAL_INTEGRATION.md) in a public release for evidence interpretation, restrictions, and the test command. This example establishes reuse potential, not third-party adoption or general deception effectiveness.
