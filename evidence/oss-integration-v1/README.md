# Independent MCP consumer: local reference evidence

`report.json` is a v0.13.0 execution of `node scripts/oss-integration-demo.mjs <new-report-path>`, recorded on 2026-10-07. It contains 8 stable scenes, 8 actor MCP requests, 7 passing runtime evidence checks, one finite policy use/follow-up, and a separate artificial-origin witness interval with one ordinary admission and one world-ticket denial.

The consumer and operator are **scripted fixtures**. The origin is **artificial**. Credentials, raw tickets, endpoint URLs and local paths are omitted. This demonstrates a separately running public-protocol consumer and the measured local authority boundary. It does not establish third-party adoption, human presence, a deceived AI, production protection, or a restarted service.

Reproduce from the release root with `npm ci --ignore-scripts` then `npm run oss:demo -- /absolute/path/new-report.json`. Reports use exclusive creation and will not overwrite this evidence. See `docs/EXTERNAL_INTEGRATION.md` for the evidence and failure semantics.
