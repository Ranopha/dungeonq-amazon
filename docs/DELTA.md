# New work and provenance

DungeonQ is an existing project, significantly updated for this entry. The earlier WebMCP submission is frozen and is not the deployment or submission target of this version.

## Earlier work retained

The original public project supplied strict fixed-seed Scenario Packs, a deterministic synthetic decision engine, browser UI/WebMCP adapter, modeled receipts and failure-property tests. Later development supplied the local SQLite governance, identity/roles, reauthentication, signed grants/leases/receipts, workbench and synthetic reference services. These are reused foundations, not all presented as newly invented for Amazon.

## Amazon-specific work started September 12, 2026

- Actual official-SDK MCP server/client, protocol 2025-11-25 and Streamable HTTP; not a renamed browser tool.
- A six-tool limited worker surface with no approve/publish tool, typed errors and admission limits.
- Durable response-request schema and exact request-to-human-grant binding, preserving existing authorization and revocation rules.
- Guided English Alexa-style assistant experience, separated human review, visible protocol trace and failure demonstrations.
- Persistent local installer with generated credentials, reopen support and explicit scenario binding.
- Bring-your-own synthetic analysis and fresh-lab installation, with unsupported execution mappings rejected.
- New cross-adapter, transport, approval, scope, restart, migration, replay and tamper regressions; independent offline receipt verification.
- Separate source distribution and judge documentation explaining what is modeled, cryptographically checked, locally executed, or not tested.

This distribution intentionally excludes private Git history and local data. Source-file digests in `RELEASE_MANIFEST.json` identify the exported release content. Preserve that manifest, Apache-2.0 license and notices when inspecting provenance. It is a reproducibility record, not an external signature or timestamp authority.

The version does not claim production connectors, actual Alexa-service integration, speech recognition, external key custody, fleet isolation or commercial acceptance. Its value is a working rehearsal boundary an evaluator can challenge with their own synthetic inputs.
