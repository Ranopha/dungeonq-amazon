# Contributing to DungeonQ

DungeonQ is an early-stage Apache-2.0 defensive deception runtime for AI-agent workflows. Contributions should make an independent client easier to connect, strengthen an actual boundary, or make a result reproducible. The maintainer uses AI assistance and remains responsible for design, review and releases. There is no established external adoption yet.

## Start with one observable problem

Use [the integration guide](docs/EXTERNAL_INTEGRATION.md) and [standalone consumer](examples/mcp-shipping-consumer/README.md) to try the public MCP/HTTP contract. Useful first contributions include a reproducible setup failure, a client compatibility example, a missing denial/retry regression, or an unclear report field. The [maintenance plan](docs/MAINTAINER_PLAN.md) lists concrete directions and a trial-feedback template; it does not imply assigned contributors or promised delivery dates.

## Development and validation

1. Fork or clone [the public repository](https://github.com/Ranopha/dungeonq-amazon) and branch from the intended `main` commit. State that commit or release in your report.
2. Use Node.js 24.15.0+, run `npm ci --ignore-scripts` and `npm run doctor`, and follow [installation](docs/INSTALL.md).
3. Make one scoped change with artificial inputs and new private fixture/output paths. Run affected tests first. For the consumer path, run `npm run oss:demo -- /absolute/path/new-report.json`; inspect its checks and failure status, not only its exit message.
4. Run `npm run check` for a release checkpoint. UI changes also require operating the visible workflow. Protocol, authority or isolation changes need the relevant negative tests and fresh source-bound acceptance; a previous version's report is not transferable.
5. Explain the problem, change, exact commands/results and remaining limits in the PR. Disclose AI assistance and confirm that you understand the diff, licenses and tests.

Keep participant and operator authority separate. Preserve closed schemas, scope, expiry, revocation, request identity, idempotency and UNKNOWN outcomes. A defender agent may propose changes but cannot approve its own proposal. New effects, transports or real connectors need a versioned design and security review. Do not add arbitrary shell/SQL, production targets, public tunnels, automatic deployment or credentials.

Existing lab directories are user data: never overwrite or reset them to make a test pass. Keep fixture credentials out of issues and reports; never disable TLS verification as a setup fix. Paid model calls or real provider integrations need explicit configuration and spending authority.

## Report problems safely

Open a [non-sensitive issue](https://github.com/Ranopha/dungeonq-amazon/issues) with release/commit, OS/Node/client versions, a minimal artificial reproduction, expected/actual result, exit code and redacted output. The template in [MAINTAINER_PLAN](docs/MAINTAINER_PLAN.md#trial-feedback-template) is suitable for a first trial. No stars, issues, PRs or testimonials should be created merely to support an application.

Potential vulnerabilities follow [SECURITY.md](SECURITY.md). Do not post secrets, real incident data, private installations or third-party exploit material. No external attack is required to evaluate this reference.

Contributions must remain Apache-2.0-compatible and preserve attribution/notices. No separate CLA, response-time, acceptance guarantee or production SLA is promised. Passing tests and AI review are not independent certification. The maintainer records what actually shipped in [CHANGELOG](CHANGELOG.md) and [VALIDATION](docs/VALIDATION.md).
