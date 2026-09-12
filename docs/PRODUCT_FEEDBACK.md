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
