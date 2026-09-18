# Isolated artificial reference

This profile runs four bounded DungeonQ services in the dedicated `colima-dungeonq-rehearsal` Docker context by default. It is a reference deployment for synthetic acceptance, not a production connector or proof against container escape. The services share one Linux VM kernel; the Docker administrator remains trusted.

The gateway owns canonical state, admission signatures, and operator authority. The participant-facing facade has only its own non-secret configuration and the world network. Origin and evidence services use separate internal networks, credentials, and named state volumes. All four services run as the nonroot preparing user, with a read-only root filesystem, no capabilities, no-new-privileges, bounded memory/PIDs, and a temporary scratch filesystem. No ports are published to the host. Acceptance clients run inside the dedicated gateway container. SSH/PostgreSQL bind to gateway loopback and remain the declared bounded protocol subset.

The VM needs no host filesystem mounts. Role configurations are generated outside the repository with mode `0600` and copied into separate named config volumes through stopped temporary containers. Each running service mounts only its own config volume read-only. Existing config volumes must match their original content digest; startup never replaces credentials behind persisted state.

The image pins Node 24.15.0 by registry digest. Its build context contains only an explicit source allowlist, not the repository, local credentials, or Git history. Locked dependencies include the test clients; install scripts are disabled. A source manifest binds exact staged bytes to an image label. This label is checked against actual image IDs and current source bytes; it is not a cryptographic attestation from an independent builder.

## Run and verify

Run from an installed source checkout. The runner always supplies the dedicated Docker context and never switches the default context or creates/stops a VM.

On an explicitly provisioned disposable Linux runner, set `DUNGEONQ_DOCKER_CONTEXT` to a dedicated context named `dungeonq-*`. The public workflow creates `dungeonq-ci` against that runner's local Docker socket. The default Docker context is never selected or changed. A name is not proof of isolation: the verifier inspects the actual project containers, networks, mounts and source image.

```sh
node scripts/runtime-isolation.mjs prepare
```

Save the returned private directory path as `REFERENCE_DIR` for this task. It contains credentials: do not commit, upload, or print its config files.

```sh
node scripts/runtime-isolation.mjs build --directory "$REFERENCE_DIR"
node scripts/runtime-isolation.mjs up --directory "$REFERENCE_DIR"
node scripts/runtime-isolation.mjs verify --directory "$REFERENCE_DIR"
node scripts/runtime-isolation.mjs down --directory "$REFERENCE_DIR"
```

`build` stages current source into a new immutable build directory. After source changes, rebuild and run `up` again before verification. `up` returns the gateway container identity and internal origin, not a host-accessible URL. `down` stops only this generated Compose project and retains its named volumes and private configuration for restart/continuity acceptance. Never regenerate credentials to reuse existing state.

`verify` performs only scoped artificial read operations and their audit records. From the actual facade container it checks canonical TCP reachability, direct-IP origin/collector denial, operator API denial, unsigned canonical-request rejection, and inability to open real protected files. Positive controls check that those files exist and are readable in their owning container. Actor and ordinary requests must correlate to accepted gateway/collector events, while the independent origin witness preserves its data/configuration digests and counts only the ordinary admission.

The private `isolation-result.json` includes observed container/image/network IDs, mount facts, network outcomes, witness readbacks, source digest, and individual checks. Missing, duplicate, or unobserved checks are `INCONCLUSIVE`; any failed check prevents `PASS`. The gateway's separate local integration report continues to identify its own scope accurately. This external report supplies additional measured infrastructure facts rather than changing a deployment label into proof.

Unit tests validate preparation and the acceptance gate; they do not establish live isolation:

```sh
node --test tests/runtime-isolation.test.mjs
```

No external destinations, enterprise data, real production credentials, remote settings, or public deployment are part of this profile. PostgreSQL uses disposable cleartext credentials only inside the gateway loopback profile; external PostgreSQL/TLS support remains unavailable.
