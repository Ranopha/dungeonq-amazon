# v0.3.0 host / public runtime v0.16

This selected Apache-2.0 slice now includes the DungeonQ source-response policy, authenticated incident handoff, six-step closure, evidence sealer and tests. It does not export the private OS. `PROVENANCE.json` and `HANDOFF_PROVENANCE.json` identify source transformations; the runtime is fixed to public commit ae3be61d3f25e9cbf0fd1d1b0eef260cccb5c2e4.

After the existing installation steps below:

```sh
npm run test:handoff
```

This test uses disposable accounts/artificial data and fake senders. It sends no real messages and uses no model API. The historical human evidence is documented in ../../docs/HUMAN_RESPONSE_RESULTS.md; a passing unit test is not a new human rehearsal.

The advanced `demo:human-close:isolated -- /absolute/path/new-directory` uses a test account and fake sender but requires an already configured, host-mount-free `dungeonq-rehearsal` Colima profile. It never starts a paid model. The separate `scripts/dungeonq-host/human-source-drill.mjs` is an opt-in real-notification runner: enroll your own account, configure your own channels privately, obtain the operator's readiness and respect the bounded per-run notification budget. No account, recipient, key or live channel configuration ships here. Do not use production data.

Prior installation/console instructions follow; existing worlds and historical evidence must not be overwritten.

---

# Initial Machine host fixture — v0.2.0

This selected Apache-2.0 host integration runs a real MCP Streamable HTTP server against an independent artificial-file origin. It adds source authorization, alert receipt, connector rotation and restart checks to the retained October 8 integration. The private Initial Machine OS, its target, credentials and history are not distributed.

## Install and run

Use Node.js 24.15.0+, npm and Git. From this directory:

```sh
npm ci --ignore-scripts
npm run prepare:runtime
npm run test:source
npm test
npm run test:response
npm run console:response -- /absolute/path/new-response-report.json
```

`prepare:runtime` clones the public Amazon repository into a **new** ignored `vendor/dungeonq-runtime` directory and checks out runtime commit `345ef3efe46cdd75abff2dde673f57a956cff6db` (v0.15.0). It refuses an existing destination. The host wrapper and runtime have separate version pins so the export is reproducible. The published host source inventory is in `PROVENANCE.json`.

Open the printed loopback URL, run the demonstration and inspect all five result tabs. The same operation without the UI is:

```sh
npm run demo:response -- /absolute/path/another-new-report.json
```

The report filename must be new. Each run creates new random artificial target bytes in a private temporary directory; it cannot attach to an existing production target. Temporary credentials, raw target bytes and installation state are not included in the public report. Stop the console with Ctrl-C or SIGTERM. No model, API key, paid service, external notification or real document is used.

## What is verified

- Five official-SDK MCP tools and cross-interface world state; no participant approval tool.
- A false recovery claim, conflicting prior observation, task-relevant revocation evidence and a finite stop.
- Saved participant note after a real service restart; world requests do not become source requests.
- A real loopback alert receiver, durable incident identity, temporary connector credential rotation and old/new authority readback after restart.
- Metadata-only source overview; forged role, cross-tenant declaration, foreign source ticket and old-epoch replay refusal.

The deterministic `test:source` suite has 21 cases. `test:response` also checks failure/UNKNOWN and duplicate-alert handling. Expected refusals are asserted against the code actually returned; unexpected errors are failures.

## Interpretation

DIRECT deliberately has source permission. DIVERT is explicitly provisioned; neither routing nor this demo classifies arbitrary attacks. A world-issued ticket never becomes source authority. Source business reads distinguish actor requests from exact-ID defender positive controls. The raw containment checkpoint can include defender reads and remain FAIL even when the separately reconciled actor count is zero; the public report retains both.

The console's configured response delay is **zero**. Historical Sol trials used a separately configured 30-second delay; their time is not attributed to deception. This run is scripted, not a live Sol session. See [historical model outcomes](../../docs/MODEL_RESULTS.md), including voluntary UNKNOWN and UNKNOWN_AFTER_LIMIT.

## Historical console

The older `prepare:fixture` / `start` commands and October 8 film remain available as historical assets. Their optional Astra buttons need separate model access and are **not part of the default v0.15 judge route**. They were not used for this update. Never put raw model events, tickets, source contents or private installation files into a public upload.
