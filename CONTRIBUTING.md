# Contributing to DungeonQ

DungeonQ is an early-stage Apache-2.0 reference lab. Help make its governance boundary easier to reproduce and harder to misunderstand.

Useful contributions include a synthetic regression, reproducible setup bug, clearer expected result, strict Scenario Pack example or adapter conformance test. Do not manufacture issues or PR activity for a grant or contest.

## Development loop

1. Fork/clone the public repository and branch from current release/main.
2. Run `npm ci --ignore-scripts` and `npm run doctor`.
3. Make one scoped change. Run affected Node tests first, then `npm run check` before a release.
4. For proof changes, run `node --test tests/reviewer-tools.test.mjs` and inspect fresh artifacts. For UI changes, exercise the actual visible workflow; API tests do not replace it.
5. Explain problem, change, tests and claim scope in the PR. List what remains untested.

Keep approval out of MCP; preserve closed schemas, scope/expiry/revocation, idempotency and negative tests. Annotations are not authorization. New effects, transports or real connectors require design/security review and versioned contracts. Do not add arbitrary shell/SQL, production targets, credentials, public tunnels or automatic deployment.

Existing lab directories are user data: never overwrite, reset or delete unknown ones to make tests pass. Do not disable TLS verification; pin a fixture certificate only in that test's client.

## Report bugs safely

Open an [issue](https://github.com/Ranopha/dungeonq-amazon/issues) with release/commit, environment, small synthetic reproduction, exact command, expected/actual results, exit code and redacted output. Say whether a fresh lab reproduces it.

Potential vulnerabilities belong under [SECURITY.md](SECURITY.md), never a public post containing secrets, real incident data or a third-party exploit.

## AI-assisted contributions

AI assistance is welcome when disclosed. Submitters remain responsible for understanding the diff, licenses and tests. Model output is a proposal, not a security authority. Neither AI review nor passing tests is independent certification.

Keep contributions Apache-2.0-compatible and preserve attribution/notices. No separate CLA or response-time guarantee is promised. Maintainer review and release notes record what actually shipped.

