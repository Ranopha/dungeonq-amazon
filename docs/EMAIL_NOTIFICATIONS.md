# Administrator email alerts — v0.10

DungeonQ remains a **synthetic security lab**, not a deployed enterprise defense system. The default installation uses a private, local simulated mailbox. A separately configured SMTP transport supports real email, but no public demo or recorded lab proof establishes delivery to a real inbox.

[繁體中文入門](START_HERE.zh-TW.md) · [Owner walkthrough](DEFENSE_LAB.md) · [Validation record](VALIDATION.md). Commands below run from the source directory containing `package.json`. They use one private installation, outside the checkout, throughout.

## Google / GitHub sign-in and the administrator email

Optional **Google and GitHub** adapters use the provider's verified email as the administrator's alert address. First sign in with the installation's local Owner account, reauthenticate in **Administrator email & alert delivery**, and link the configured provider. Later provider sign-in identifies that already-linked account; merely owning an email address never creates an Owner. Google requests `openid email`; GitHub requests `user:email`, not repository access. Provider tokens are not retained.

This release supports **one active provider binding at a time**. Linking another provider or starting a manual email replacement invalidates the previous binding and pending deliveries. Your local username remains the recovery route. If local TOTP is enabled, use the local password plus authenticator code: social sign-in fails closed until a separate second-factor flow exists. Provider-email changes require an authenticated relink.

The adapters require your own registered OAuth application and exact callback `https://127.0.0.1:<owner-port>/api/identity/callback`. Put the `google` and/or `github` objects, each containing `clientId` and `clientSecret`, in a private owner-readable-only JSON file outside the checkout. Start with `--identity-config /absolute/private/path/identity-config.json`. The port must match your provider registration. The local self-signed browser certificate still needs the user's explicit handling; do not disable certificate validation. Provider configuration and actual account acceptance are deployment gates, not established by the offline tests.

Example file structure; these are placeholders, not usable credentials. Omit a provider object if you do not intend to configure it:

```json
{
  "google": { "clientId": "REPLACE_GOOGLE_CLIENT_ID", "clientSecret": "REPLACE_GOOGLE_CLIENT_SECRET" },
  "github": { "clientId": "REPLACE_GITHUB_CLIENT_ID", "clientSecret": "REPLACE_GITHUB_CLIENT_SECRET" }
}
```

Create the file with your local editor/secret-management method in a private directory. It must be a regular, non-linked JSON file with permissions **0600**, not a symlink or a world-readable file. Replace the paths below with its actual absolute location. Stop the current lab with Ctrl+C before reopening the same installation:

```sh
chmod 600 /absolute/private/path/identity-config.json
npm run defense:workspace -- --data-dir ../dungeonq-orders-lab --seed 17 --depth 4 --web-port 4196 --identity-config /absolute/private/path/identity-config.json
```

For this command the exact callback is `https://127.0.0.1:4196/api/identity/callback`. The CLI option is `--web-port`. A provider must accept the selected app type and exact callback before this is usable; this document does not promise that every provider registration accepts loopback HTTPS. If it is rejected, keep the provider disabled rather than weakening TLS or changing only the registered URL. Public-domain OAuth deployment is not included in this local profile's acceptance.

No provider application is registered or credential configured in the distributed demo. Its buttons remain visibly unavailable until configured. **Apple sign-in is not implemented in this loopback profile** and stays disabled; the button is a disclosed unavailable option, not a working integration. The scripted proof uses manual capture-mode verification, not a live social sign-in.

Signing in with Google or GitHub does **not** provide a sending service or Gmail send permission. Real alert email additionally needs the SMTP configuration below. A real verified provider identity can supply the recipient, but SMTP acceptance still does not prove inbox delivery.

## Three-step reviewer route

For a first installation only, create a new empty private directory and start the workspace:

```sh
npm ci --ignore-scripts
npm run doctor
mkdir -m 700 ../dungeonq-orders-lab
npm run defense:workspace -- --data-dir ../dungeonq-orders-lab --seed 17 --depth 4
```

1. Open the printed Owner `/defense` page and sign in with the locally generated account. Keep that password outside the Actor and model. Do not open the Actor workspace until the email binding is verified if you want the first contact to produce an email alert.
2. In administrator email settings, expand **Use email-code verification instead**. Enter `owner@example.test`, confirm your password (and TOTP if enabled), request verification, and read the code from the **simulated mailbox**. Confirm it. The address now serves as a simulated login alias; your original local username still works.
3. Open the separate printed Actor URL, enter its Actor-only token, and open the workspace. Follow its snapshot → index → reconciliation actions as described in [the workspace guide](WORKSPACE_LAB.md#run-it). Refresh the Owner desk. The same incident now has both its retained local-sink receipt and a separately tracked email alert addressed to the bound administrator. Inspect the message, event digest and delivery state. Approval and rotation remain separate actions.

Stop with Ctrl+C. Restart with the identical launch command, directory, seed, depth and presentation; do not repeat `mkdir`. Omitting `--data-dir` creates a different temporary installation, not a restart. Never repoint the workspace launcher at an older disclosed-profile lab. If ports are occupied, choose unused `--web-port`, `--actor-port` and `--mcp-port` values and retain them on restart; do not stop unrelated services.

Only future observed contacts are emailed. Binding an address does not resend old incidents. The current reference installation reports the first configured contact of its one bounded campaign; it is not a general traffic detector.

## What controls the recipient

- Only the authenticated Owner can bind, verify or remove their own address, using fresh password/TOTP confirmation. The application stores the binding; models and Actor tools have no email-settings or approval capability.
- Verification is time-limited, attempt-limited and single-use. A pending change suspends the earlier binding. Queued delivery is fenced after removal, account invalidation or a binding/mode change.
- The login alias uses the same local password and configured TOTP. Email verification is **not** OAuth, passwordless login, phishing-resistant authentication or proof of a corporate identity.
- A simulated-mailbox verification does not authorize SMTP delivery. Switching modes requires new verification through the actual selected transport.
- Alert content is a bounded synthetic event summary. It does not include world tokens, Owner credentials, mail-service credentials or an approval link that grants authority.

## Delivery states

`PENDING` means queued. `SENDING` means an attempt is in progress. `RETRY` is reserved for a definite temporary rejection and is bounded with backoff. `FAILED` is a terminal rejection or exhausted retry budget. `UNKNOWN` means the result could not be established and is not automatically resent. `ACCEPTED` means the selected mail transport accepted the message: local capture in simulation mode, or the SMTP server in SMTP mode. **SMTP acceptance is not proof of inbox delivery or reading.**

The existing `LOCAL_SINK_ONLY` receipt is independent of this email state; its `DELIVERED` label refers only to that local event sink.

## Optional real email configuration

This is an explicit deployment-owner choice, not a browser or MCP input. Provide an existing SMTP service using a private regular **0600** configuration file outside the checkout. Example with nonfunctional placeholders:

```json
{
  "host": "smtp.example.invalid",
  "port": 465,
  "secure": true,
  "from": "alerts@example.invalid",
  "user": "REPLACE_SMTP_USER",
  "password": "REPLACE_SMTP_PASSWORD"
}
```

Use your provider's actual hostname, authorized sender and credentials locally, never in a public issue or chat. Stop the running lab first, then reopen the **same** private directory:

```sh
chmod 600 /absolute/private/path/smtp-config.json
npm run defense:workspace -- --data-dir ../dungeonq-orders-lab --seed 17 --depth 4 --email-smtp-config /absolute/private/path/smtp-config.json
```

The JSON requires `host`, `port`, `secure`, `from`, `user` and `password`. Use port 465 with `secure: true`, or port 587 with `secure: false` and mandatory STARTTLS. TLS certificate validation remains enabled. Do not commit the file, paste credentials into a model conversation or upload the installation directory. There is no automatic provider signup, paid resource, public mail relay or fallback to plaintext SMTP.

If using provider sign-in and SMTP together, include both configuration options on every restart:

```sh
npm run defense:workspace -- --data-dir ../dungeonq-orders-lab --seed 17 --depth 4 --web-port 4196 --identity-config /absolute/private/path/identity-config.json --email-smtp-config /absolute/private/path/smtp-config.json
```

Choose the correct binding route before the first Actor contact:

- **Manual email:** open the Owner page, reauthenticate and verify the real address using the code received through SMTP. A capture-mode verification cannot authorize SMTP. Starting this manual replacement invalidates any earlier provider link; do not use it merely to test mail while expecting to keep social sign-in.
- **Provider email:** link the configured provider as the signed-in Owner. A genuine `OAUTH_VERIFIED` binding supplies the verified recipient and does not require an additional manual email-code replacement. An existing active genuinely provider-verified binding remains eligible across transport changes; a simulated fixture binding does not. Relink through the authenticated provider flow if the address or binding is no longer valid.

The reference emits the first configured contact for its one campaign and does not backfill old events. If the simulated walkthrough already created that incident, reopening it with SMTP preserves the old evidence but will not generate another initial alert. For a new real-mail acceptance event, explicitly create a separate private installation, configure SMTP and bind/verify its administrator **before** opening the Actor:

```sh
mkdir -m 700 ../dungeonq-smtp-acceptance-lab
npm run defense:workspace -- --data-dir ../dungeonq-smtp-acceptance-lab --seed 17 --depth 4 --email-smtp-config /absolute/private/path/smtp-config.json
```

Add the identity configuration option too if taking the provider route. Stop the earlier process before reusing its ports, or select distinct ports. Do not delete/reset the earlier lab or interpret absence of a duplicate historical alert as a transport failure. This optional flow sends actual mail while the incident and protected resource remain artificial. Service quotas, sender verification and inbox filtering belong to the selected provider. Real inbox acceptance must be checked separately; it is not included in the saved synthetic proof.

## Reproduce and interpret the evidence

`npm run email:proof -- --out ../dungeonq-email-proof` produces a fresh same-process scripted engineering report using actual HTTPS, durable storage and the local capture transport. The output directory must not already exist; inspect prior evidence instead of overwriting it. It does not invoke a paid model or external email service. The recorded report is under `evidence/email-v1/proof.json`; runtime passwords, verification codes and installation files are excluded.

The test suite additionally exercises a loopback TLS SMTP receiver for acceptance, temporary/permanent rejection and a lost final reply, plus signed local Google-token fixtures and mocked GitHub responses. These prove the tested transport and identity boundaries, **not commercial inbox delivery or live provider acceptance**. Earlier LLM records and their limitations remain unchanged: accepting decoy data is not evidence of sustained mistaken belief.

## Operation and recovery

Keep the lab process running for automatic outbox dispatch. Stop it to stop dispatch; restart with the same private directory and presentation. Schema v7 is additive and preserves existing governance/audit/rotation data. Back up the private installation before upgrading; do not downgrade a migrated database or restore old revoked credentials. No change is made to an already-running older lab. Removing a binding cannot retract mail already accepted by a server.

The public Sites page is a recorded-evidence viewer. The full authenticated email/Owner/MCP runtime is self-hosted from the source release; a static page does not secretly operate a mail service.
