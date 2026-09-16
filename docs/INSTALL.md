# Install, run, stop and recover

## Choose the right entry point

- `npm run amazon`: durable assistant + human-review demo; the primary experience.
- `npm run demo:proof`: fresh automated two-role fixture over the same runtime; no browser required.
- `npm run dev`: retained browser-only simulator, **not** the durable assistant.
- `npm run build`: builds that retained browser shell; it does not deploy the lab.

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
