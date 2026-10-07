# Install, integrate, stop and recover — v0.13.1

Use a source archive or a pinned commit of the public repository. `main` can contain a newer candidate than the latest release; check [VALIDATION](VALIDATION.md) and [release policy](RELEASE.md) before attributing results to a version. The package is private to prevent accidental npm publication; clone/download the open-source repository rather than looking for a published npm package.

## Prerequisites and first run

Use Node.js **24.15.0+**, npm, and OpenSSL with `req -addext`. Python 3 is needed for the Python client checks in the complete suite; `DUNGEONQ_TEST_PYTHON` can select the intended binary. Ubuntu 24.04 and macOS 14 are the CI targets. Native Windows and WSL2 are not separately release-accepted. Node's SQLite/Argon2 features may print experimental warnings.

```sh
npm ci --ignore-scripts
npm run doctor
npm run oss:demo -- /absolute/path/new-oss-report.json
```

Choose a new output filename outside the checkout. The [standalone consumer](../examples/mcp-shipping-consumer/README.md) has an independent package and uses public MCP/HTTP with only actor authority. The harness runs the separate operator/origin fixtures and stops its own services. It is a scripted integration reference, not established third-party adoption. [Exact setup, role separation and report meaning](EXTERNAL_INTEGRATION.md).

Doctor checks the earlier local-lab prerequisites and briefly probes its fixed loopback ports. It is not complete runtime or Docker acceptance. Occupied ports do not authorize stopping another service.

## Operate the current runtime

```sh
npm run runtime -- --data-dir ../dungeonq-runtime-013 --presentation participant-v1
```

Use a new private installation path for a new reference, or deliberately reopen your known compatible path. Open the printed Participant workspace and Control room URLs. Give the participant only its actor token; keep the owner token, ordinary-origin capability and full credential file separate. The [step-by-step route](JUDGE_ROUTE.md) covers persisted read/write, a world-only ticket, observations and a finite operator grant. [RUNTIME](RUNTIME.md) documents all adapters and recovery.

Stop with Ctrl+C. Restart with the same directory and presentation to retain state. A missing `--data-dir` creates a new temporary installation; it is not recovery. Preserve a failed or incomplete directory for diagnosis. Before an upgrade, stop all processes and make a protected copy of the complete installation, including SQLite/WAL state and keys. Do not mix files from installations, downgrade a schema or delete an unknown directory.

## Choose a supporting profile deliberately

| Entry | Purpose |
| --- | --- |
| `npm run runtime` | Current defensive deception runtime and separate participant/operator working views |
| `npm run oss:demo -- /absolute/path/new-report.json` | Standalone consumer through public MCP/HTTP, with separate scripted operator/origin checks |
| `node scripts/judge-demo.mjs /absolute/path/new-report.json` | Retained ten-checkpoint shipping task walkthrough |
| `npm run amazon` / `npm run demo:proof` | Retained governed assistant and separately authenticated review profile |
| `npm run defense:workspace` | Retained Orders Workspace with its own account, notification and rotation contracts |
| `npm run study` / `npm run world` | Retained finite research instruments and original result boundaries |
| `npm run dev` / `npm run build` / `npm start` | Node static source preview, asset build, and built preview; API-backed roles use their own commands |

The Astra distribution additionally includes its bounded model-candidate profile; use [its repository documentation](https://github.com/Ranopha/dungeonq-astra/blob/main/docs/ASTRA.md) and free mock path before considering a paid call. Legacy account/email features do not automatically apply to the runtime owner token.

## Failure and verification

A refused write, exhausted ticket or missing capability can be an expected negative check. Read the named expectation, authenticated result and exit code; do not classify every refusal as a setup failure. A lost response or UNKNOWN result needs readback and must not be turned into success by restarting or deleting evidence.

Run `npm run check` for the complete source checkpoint. On an intact release, `npm run verify:source` checks the inventory; for edited source, regenerate a clean distribution as described in [RELEASE](RELEASE.md). Full runtime admission also needs fresh [container acceptance](../deploy/runtime-reference/README.md) and the exact-source gate. A loopback run alone is not isolation acceptance.

All resources are artificial. Do not expose the local profile with a public tunnel, disable TLS verification, upload credentials/private state, or attach it to a production target. For a reproducible problem, use [the feedback template](MAINTAINER_PLAN.md#trial-feedback-template).

<details>
<summary>Historical governed-assistant documentation (v0.4 and earlier scope)</summary>

# Install, run, stop and recover

## Choose the right entry point

- `npm run amazon`: durable assistant + human-review demo; the primary experience.
- `npm run demo:proof`: fresh automated two-role fixture over the same runtime; no browser required.
- `npm run study`: separate finite causal study and researcher Observer; see the [English study guide](STUDY_LAB.md). Its interface is currently Traditional Chinese.
- `npm run world`: persistent abstract exploration; see [world operation](WORLD_LAB.md).
- `npm run dev`: Node loopback preview of the retained browser-only simulator; durable roles use their dedicated commands.
- `npm run build`: copies public assets and the public browser SDK into `dist/static`; it does not deploy the lab or create a Worker.

Do not add a tunnel or bind publicly. Authentication is a **local-host profile**, not a remotely deployable OAuth setup.

## Prerequisites

Install Node.js 24.15.0+ from [Node.js](https://nodejs.org/en/download) and OpenSSL with `req -addext`. No global DungeonQ CLI is needed. CI targets Ubuntu 24.04 and macOS 14; see [completed validation evidence](VALIDATION.md). Native Windows is not accepted because this local storage profile enforces POSIX private-directory semantics. WSL2 may offer a Linux environment but is not a separately validated platform. Node's SQLite/Argon2 features may print experimental warnings.

From a fresh clone or unpacked release source:

```sh
npm ci --ignore-scripts
npm run doctor
```

Doctor checks the runtime, SQLite, Argon2, OpenSSL and local SDK installation. It briefly probes only `127.0.0.1:4186` and `:4187`, then releases them; readiness can change afterward. Occupied ports are warnings, not permission to stop another service. `--skip-ports` omits those probes; `--json` emits a machine-readable report. It installs nothing and makes no trust or account changes.

## Disposable interactive demo

```sh
npm run amazon
```

The terminal displays the HTTPS URL, `owner-lab`, a fresh password and a private temporary data directory. Open the URL in a desktop browser. The self-signed certificate belongs to this loopback lab; personally inspect/handle that warning. **Never disable certificate verification, install system-wide exceptions or reuse your real password.**

Keep the printed password locally if you intend to reopen. Stop with Ctrl-C. Starting again without `--data-dir` creates a **different lab**, not a reset of the old one. Temporary storage may be removed by the OS.

## Deliberate persistence

Create a new private directory outside the repository:

```sh
mkdir -m 700 ../dungeonq-lab-030
npm run amazon -- --data-dir ../dungeonq-lab-030
```

If that directory already exists, do not overwrite or empty it. Choose a new name or deliberately reopen the known lab with its matching scenario and saved password:

```sh
npm run amazon -- --data-dir ../dungeonq-lab-030
```

Expect `Existing lab reopened` and **no replacement password**. For a custom scenario, supply the identical `--scenario` file on every reopen. A changed seed/contract does not silently rebind the database.

The private directory contains credentials, signing material and SQLite state. Never upload it, attach it to an issue or put it in a release. For local recovery, stop all lab processes before making a protected offline copy of the **complete** directory. Do not mix database/key files across installations or run an older binary against a newer schema. This is not a production backup service.

## Troubleshooting

| Symptom | Safe next step |
|---|---|
| Node/Argon2/SQLite failure | Use the supported Node build, reopen the terminal and rerun Doctor. Do not replace cryptographic checks with stubs. |
| OpenSSL failure | Ensure the executable is on PATH and `openssl req -help` includes `-addext`. |
| Missing MCP SDK | Run `npm ci --ignore-scripts` from the repository root. |
| Port warning / `EADDRINUSE` | Keep unrelated services running. Use `npm run amazon -- --web-port 4286 --mcp-port 4287` and open the printed URL. |
| Certificate warning | Inspect the loopback certificate yourself; no global trust changes. The proof pins its generated certificate in its own HTTPS client. |
| `STORAGE_NOT_PRIVATE` | Use a new empty directory you created with mode 0700. Do not loosen privacy checks or use shared storage. |
| `INSTANCE_MISMATCH` | Reopen with the same scenario, or create a separate fresh lab for the new case. |
| `INSTANCE_INCOMPLETE` | Preserve the failed directory for local diagnosis; start a new empty one. Never delete unknown files to force initialization. |
| `HUMAN_APPROVAL_REQUIRED` | Expected before approval. Review the exact manifest in the human UI. |
| Expired authority | Requests last five minutes; worker/certificate lifetime is 30 days. Use a fresh isolated lab when appropriate. Never change clocks/timestamps to resurrect authority. Historical receipts are evidence, not permission. |
| Proof `OUTPUT_EXISTS` | Pick a new output directory. Existing targets are never merged or overwritten. |
| Tampered verifier exits 1 | Expected rejection. The original should pass with the separately trusted key. |

## Cleanup

The proof removes only its own new disposable private fixture and retains public evidence output. Interactive labs remain yours. Stop the lab, identify the exact printed directory and decide whether you need its state before removing it with your normal file manager. Do not delete parent directories or blindly run recursive cleanup commands.

</details>

## Static source preview and build

```sh
npm run dev
# In a separate invocation, after stopping that preview:
npm run build
npm start
```

The preview binds to `127.0.0.1:4174`; choose a different valid port with `DUNGEONQ_PORT`. Source assets keep their original bytes, MIME types and paths. The existing browser SDK is available at `/runtime/client.mjs`. Runtime/world/study/topology/defense pages depend on their own server-side routes, so start those workspaces with their documented commands. A static preview does not host their APIs.

The build uses Node built-ins and writes `dist/static` plus an internal digest inventory. Rebuilding replaces only an empty directory or a previously generated, unchanged build. Unknown files, manually modified output, symlinks and private filenames are refused. Preserve any edits before changing such an output; the builder will not silently erase them. An optional `npm run build -- --out /absolute/path/new-directory` creates a separate static artifact; `npm start` previews the default `dist/static` directory.

`npm run syntaxcheck` parses actual JavaScript source with `node --check`; no empty `typecheck` alias or TypeScript validation claim is retained. `npm run check` runs this check before the static build.
