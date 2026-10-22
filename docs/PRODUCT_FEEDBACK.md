# October 22 follow-up from actual human operation

The operator initially interpreted successful A-2 rotation as completed closure. Our UI needs to distinguish these stages and their next action more clearly. Gmail arrived while our provider receipt remained UNKNOWN; receiver evidence and provider acknowledgement should have separate fields and explicit timeout semantics. These are observed integration/UX issues in our implementation, not claims of an Amazon SDK defect.

For MCP tooling, examples of human handoff should keep authenticated ACK, exact action approval and completion readback distinct. For model evaluation APIs, budget stops should remain separate from voluntary stopping and semantic UNKNOWN. The nine historical Sol sessions also showed why alternate data paths need the same source policy; this was our fixture's authorization gap.

# Current feedback — October 20, 2026

Track: Alexa+ simulation + Open Source. The current official MCP SDK is **1.32.1**, using Streamable HTTP and protocol 2025-11-25. The reference was built and exercised locally with Node 24, artificial resources and a separate human/operator authority. No real Alexa device/service, Amazon account linking or AWS deployment was tested; no firsthand AWS Builder feedback is claimed.

## What the extended implementation taught us

1. **Important: distinguish permission from descriptive metadata.** A convenient source overview originally carried content even when it should only describe available records. We replaced it with metadata-only responses and required explicit, current source permission for content, including cached replies. This was our implementation defect, not an Amazon or MCP SDK defect.
2. **Important: make response provenance resumable.** An assistant needs to distinguish alert sent, receiver acknowledged, human acknowledged and rotation verified. Stable incident IDs and authenticated old/new readbacks survive transport loss and restart. A platform-native, scoped human handoff with operation ID, expiry and exact manifest would reduce custom work without exposing approval credentials to the assistant.
3. **Useful: preserve UNKNOWN in agent tooling.** A 14-call budget ended one Sol session without a final answer. Tooling should label a budget stop separately from the model's own choice to stop and from successful task completion. Missing transport or model evidence must not be inferred as success.
4. **Useful: ship bounded local MCP examples with negative tests.** Official SDK handshake, tool listing and invocation made our independent client and judge demo reproducible. Examples spanning metadata-only enumeration, tenant binding, ticket issuer binding, stale epochs and replay would shorten secure integration work.

We would reuse MCP for a standard client interface. Actual Alexa+ device/service onboarding remains future work; the simulation does not establish platform certification. The default judge route needs no API key or paid service. Earlier implementation observations below are retained as dated history; the Vinext wrapper mentioned there was removed in v0.13.1.


---

# Product feedback and friction log

Recorded from implementation on September 12, 2026. No AWS account, Amazon hardware, Alexa service API or production incident data was used. We cannot report firsthand Alexa account-linking/device SDK behavior. This is the rules-permitted simulated assistant route with an actual local MCP implementation.

## Tools used

| Tool | Use | What worked | What needs attention |
|---|---|---|---|
| Official MCP TypeScript SDK 1.30.0 | Server, client, Streamable HTTP and tool schemas | Real handshake and tools/list/call tests make transport claims reproducible | A concise authenticated-local example combining closed JSON schemas, explicit human handoff, and negative tests would reduce custom integration work |
| Node.js 24.15.0 | HTTP/HTTPS, crypto, SQLite, test runner | One local runtime supports deterministic tests and real signed durable effects without cloud setup | Experimental SQLite warnings and platform/OpenSSL differences need explicit onboarding documentation |
| OpenSSL | Disposable loopback certificate | Tests can pin the generated certificate without disabling TLS | Browser warning is a genuine first-run interruption; a trusted development setup guide would help. No global trust change was made |
| Vinext/React/Vite | Retained original browser shell build | Existing source builds without a new hosted service | An existing unknown-route-classification build warning is still visible. This is not claimed as an Amazon SDK defect |
| Codex | Implementation assistance, source/test iteration and local build orchestration | Enables keeping contracts, failure tests and UI changes together | The author still must verify executable behavior, screenshots, provenance and claims; generated code is not independent certification |

## Specific observed friction

### Local HTTPS onboarding — Important

Task: open the new human-review interface after starting the generated local lab.

Steps: launch the lab, navigate to its HTTPS loopback URL in a fresh browser. Expected: local login screen. Actual: browser rejected the self-signed certificate before rendering. Workaround: the operator must inspect and handle the warning personally. Automated API checks pin the exact generated certificate. Do not disable TLS or install a system-wide exception.

Suggestion: provide a documented, narrow development-certificate workflow for local approval surfaces. This is local web onboarding friction, not a failure observed in Amazon's service.

### Negative Host-header test — Important for maintainers

Task: prove an arbitrary Host header is rejected. Expected: test emits the supplied header. Actual: the initial fetch-based test did not transmit the intended Host value. Workaround: use Node's explicit HTTP request API in the test; the server's Host check was not relaxed. Suggestion: transport examples should demonstrate the actual transmitted request for security-sensitive negative cases.

## Requested platform feature

**Important:** a documented assistant-to-human approval handoff carrying a stable operation ID, exact readable scope, expiry and manifest digest, with a resumable reference after approval. The assistant should not need to receive the person's password or approval credential. DungeonQ implements this locally; a platform-native surface could make the distinction clearer and more accessible.

## Onboarding and future use

The local MCP hello world required only the official SDK and Node; production authentication is a separate problem. We would use MCP again for a standardized tool boundary. We would evaluate real Alexa+ integration next, but cannot claim that device/service onboarding has been tested or commit to its suitability before that work.

This log records specific observed behavior and a feature request. It makes no entitlement claim to a feedback bonus.
