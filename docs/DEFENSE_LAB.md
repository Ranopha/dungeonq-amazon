# Defense reference: one incident, two worlds

DungeonQ v0.8.0 adds one integrated, self-hosted defensive engineering profile. One configured honey contact links a bounded synthetic campaign, a durable notification and an exact rotation request. The Actor works inside B/C/D; a separately authenticated Owner decides whether resource A may rotate. Four authorization and business readbacks determine the outcome.

This is `SYNTHETIC_ONLY`. A is an artificial service with real loopback TLS and token authorization. The worlds have persistent local effects and finite action budgets. There is no enterprise connector, arbitrary target, exploit, shell, scan or paid model call. “Two worlds” describes the protected origin and the bounded synthetic side; B/C/D are regions on the latter side.

The recorded [proof](../evidence/defense-v1/proof.json), [world events](../evidence/defense-v1/world.json) and [governance events](../evidence/defense-v1/governance.json) retain the same incident and manifest links. They are engineering evidence, not a live visitor session or a model-efficacy study. The automated proof controls an Owner test credential; it does not attest human presence.

## Install and run

Use Node.js 24.15+, npm and OpenSSL supporting `req -addext`. Start inside the extracted source directory containing `package.json`:

```sh
npm ci --ignore-scripts
npm run doctor

# A first installation must have its own empty, private directory.
mkdir -m 700 ../dungeonq-defense-lab
npm run defense -- --data-dir ../dungeonq-defense-lab --seed 42 --depth 4
```

Do not reuse a different lab, loosen directory permissions or remove saved credentials to bypass an installation error. Without `--data-dir`, the launcher creates a new private temporary directory and prints its path. Preserve that path if you intend to resume. Seed and depth must match when reopening an installation.

The launcher prints:

- **Owner:** normally `https://127.0.0.1:4196/defense`, username `owner-lab`, and a newly generated password on first installation only.
- **Actor:** normally loopback port 4197. Open the printed URL and paste the separate Actor-only token into its access field; the URL does not contain a credential.
- **MCP:** normally port 4198, protocol `2025-11-25`, Streamable HTTP, with an Actor-only bearer credential.

Inspect and handle the local self-signed browser certificate warning yourself. Do not disable TLS checking, install system-wide trust, expose a listener publicly or add a tunnel. Keep passwords, bearer credentials, private keys and the installation directory out of screenshots, public evidence and source control.

## A short interactive review

1. Open the Owner desk and sign in. Before an Actor contact there is no incident, and A is at generation 0. Open the printed Actor URL, enter its Actor-only token and select **Open the world**; that authenticated world access records the honey contact. Merely loading the public sign-in page does not. Use **Read current status** on the Owner desk to see the linked incident, rotation request and local notification receipt. A pending notification is not delivery.
2. In the Actor, perform the available bounded actions. The generated B/C/D campaign retains local state and receipts. The proof specifically exercises B → C, obtains a format-valid world artifact, and shows that it works locally while A rejects it. Local success grants no A authority.
3. On the Owner desk, inspect the resource, generation, expiry, complete manifest and digest. Re-enter the Owner password, supply TOTP if enabled, acknowledge the scope, and select **Approve this rotation**. Approval alone does not execute.
4. Select **Execute approved rotation**. A successful response must be `COMPLETED`, with all four checks true: **old key denied; new key completes the business request; old consumer denied; world-issued decoy key denied by A**. Continue in the Actor afterward. An unknown result remains unverified.

The administrator chooses whether to approve; the Actor cannot make that decision through text, persona, a local success or an MCP tool. The automated proof separately tests unapproved apply and the wrong manifest digest. This is one Owner authority, not a two-person-control or hardware-presence claim.

## Reproduce the 13-check proof

```sh
npm run test:defense
npm run defense:proof -- --out ../dungeonq-defense-proof
```

The output directory must not already exist. The driver creates a fresh private installation, exercises actual loopback HTTP/MCP and CA-verified HTTPS, stops and restarts the stack, then exports `proof.json`, `world.json` and `governance.json`. It exits nonzero on failure. Its private installation is separate from the exported files and is not included; do not publish internal runtime directories.

| Check | Observable result |
| --- | --- |
| 1. Initial boundary | No contact means no incident; A starts at generation 0. |
| 2. Actor authority | Four closed MCP tools; no approval or origin-control tool. |
| 3. Same-incident notification | Durable alert reaches the local sink; its receipt is independently read back. |
| 4. Before approval | Apply is denied and A stays unchanged. |
| 5. Local continuity | Three persisted local successes lead from B to C. |
| 6. Artifact scope | The earned world token works locally and A rejects it at authorization. |
| 7. Exact approval | Owner reauthentication binds the digest; a wrong digest is rejected. |
| 8. Rotation and readback | Actual TLS rotation passes all four checks. |
| 9. Replay | Repeating completed apply issues no new permit or generation. |
| 10. Continued world | The campaign proceeds from C to D after A protection completes. |
| 11. Interface parity | HTTP and official-SDK MCP agree; replay preserves the same world result. |
| 12. Observer | A separate process replays the causal evidence and rejects an altered copy. |
| 13. Restart | World, alert, approval and generation persist; old credential state does not revive. |

The JSON identifiers, timestamps and check details are authoritative for the recorded run. `approvalMode: SCRIPTED_OWNER_CREDENTIAL_NOT_HUMAN_PRESENCE_PROOF` and `participantMode: SCRIPTED_FIXTURE` describe the test roles. `paidProviderApiCalls: 0` and `externalTargetRequests: 0` describe this proof, not a new Astra evaluation.

Replay the world bundle independently:

```sh
npm run world:verify -- ../dungeonq-defense-proof/world.json
```

That checks the bounded world's causal consistency. The static website additionally checks SHA-256 file bytes, canonical world/governance digests and manifest/incident links. These checks do not authenticate the publisher, establish an independent trust root, attest a human or prove production isolation. The governance export is an audit record, not a standalone production security attestation.

## Expiry, restart and uncertain results

An unclaimed rotation proposal has a five-minute expiry. The Owner may use **Refresh expired proposal** only after expiry and before a claim. This replaces its expiry and digest, clears approval and requires a fresh review and password-bound approval. It does not extend an already claimed effect.

If execution becomes `UNKNOWN`, do not issue another mutation. Use **Reconcile readback** to look up the existing issuer receipt and repeat the independent readbacks. `UNKNOWN`, `CLAIMED`, missing evidence or a false check is not success. A claimed proposal that later expires is reconciled, not refreshed. An unavailable issuer remains unknown rather than being treated as denial.

Stop with Ctrl+C. To resume, run the same command against the same private directory, seed and depth; omit the first-installation `mkdir`. The password is not reset or printed again. This reference supports one fixed synthetic A and one rotation per installation. Its local worker credential and self-signed TLS certificate last 30 days; it is not an unattended production credential-management service. New unrelated campaigns require a separate authorized installation, not deletion or resetting of existing evidence.

## MCP and deployment boundary

The four Actor tools are `dungeonq_world_view`, `dungeonq_world_act`, `dungeonq_local_artifact` and `dungeonq_local_artifact_read`. They operate only on the configured bounded synthetic world. The launcher prints the endpoint and Actor-only credential for a compatible MCP client. Owner login, fresh reauthentication, approval and A's broker credentials stay outside that interface.

MCP is an interface; it does not transparently intercept arbitrary network traffic or detect AI identity. A configured honey contact is an observed event, not proof that A has been breached. If an actor already holds a valid A credential and can reach A, a real deployment needs origin reauthorization and credential/session fencing. The reference demonstrates those authorization outcomes only on its fixed artificial origin.

`LOCAL_SINK_ONLY` means a durable local receipt, not email delivery. A separate Observer process/database is useful for replay but shares a trusted host. `NOT_PRODUCTION_ISOLATION` explicitly excludes a claim of independent OS, cloud account, network or administrator isolation. Reaching finite world limits never grants access to A.

## Earlier evidence remains separate

The [v0.7 publishing pilot](TOPOLOGY_RESULTS.md) observed complete local-chain following in 2/2 memo sessions versus 0/2 controls, with **0/4 unsupported completion claims**; all four checked the actual goal. The [v0.6 pilot](STUDY_RESULTS.md) observed **0/2 wrong-high-confidence induction**. Neither is relabeled as defense success. Exact pilot model identities were not independently attested.

The Astra edition's earlier live API proof remains unchanged. v0.8.0 adds this defensive engineering chain, not new Astra calls or an established deception effect. Source preparation, local acceptance, public deployment and competition updates are separate delivery states.
