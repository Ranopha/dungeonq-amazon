# v0.3.0 validation record

Validated on 2026-09-15 using macOS arm64, Node.js 24.15.0 and LibreSSL 3.3.6 (`req -addext` supported). This records local synthetic acceptance, not production certification or organizer approval.

| Check | Observed result |
|---|---|
| Clean `npm ci --ignore-scripts` | 276 packages installed; advisory check reported 0 vulnerabilities at this checkpoint |
| `npm run doctor` | Required checks passed; occupied default-port warnings were correctly reported without stopping existing services |
| `npm test` | 115 passed, 0 failed |
| `npm run verify` | Three fixed-seed goldens passed, including modeled compensation and compound-failure refusal |
| `npm run demo:proof` | Seven checks passed across HTTPS/CSRF, real MCP, exact effect, signature/tamper, replay and full-stack restart |
| Independent receipt verifier | Original accepted; tampered artifact and wrong key ID rejected with exit 1 |
| Proof negative paths | Existing/symlink output refused; startup failure returns nonzero and removes only its own new fixture |
| `npm run audit` | No release-pattern findings; not a full vulnerability scan |
| `npm run typecheck` / `npm run build` | Passed; retained Vinext unknown-route-classification warning remains |
| Actual launcher | New private lab on random loopback ports, pinned HTTPS GET `/assistant` returned 200, expected review UI present, SIGTERM exit 0 |
| Distribution manifest | SHA-256, byte lengths and source inventory verified; negative tests reject stale, missing, extra and unsafe entries |
| Documentation | Relative Markdown links checked; final public README/release readback is part of publication acceptance |

The proof harness explicitly controls both fixture roles and does not prove human presence. Interactive UI/code was not changed in this release; the existing desktop video/workflow acceptance remains scoped to 0.2.0. The launcher HTTP check is not a new visual or mobile acceptance. Linux, Windows, mobile, real Alexa/Echo, remote hosting, production connectors and external key custody remain unaccepted.

Generated proof outputs contain synthetic receipt/report data and a public key, not the private fixture. The report and export envelope are unsigned. A receipt verifier needs an independently trusted key; receiving a key next to an artifact alone establishes no trusted origin. Live receipt keys/IDs/times vary between installations; only same-request replay and admitted engine output have the stated deterministic comparisons.

Tests were performed on the selected release source. The final version tag and archive identify the published content; do not transfer these results to unrelated edits. Reproduce the commands rather than treating this record as a warranty.
