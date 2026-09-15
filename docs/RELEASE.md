# Release and maintenance policy

## Reproduce a version

Use the fixed tag/commit, lockfile and recorded Node requirement. Do not assume `main` is unchanged. Install with `npm ci --ignore-scripts`; run Doctor, proof, `npm run check`, then `npm run verify:source`.

Source includes tests/docs, Apache-2.0, notices, SBOM and SHA-256 manifest. The manifest excludes itself; it checks content/inventory, not author identity or trustworthy time. Replacing both source and manifest is outside this check. Verify the expected GitHub tag/commit through a trusted channel.

## Compatibility

0.3.0 retains the 0.2.0 MCP/Scenario Pack and SQLite v5 contracts. It adds setup/proof tools and docs, not runtime approval powers. Engine/SDK clients may retain component versions; the package version describes the distribution.

Reopen with a compatible lab directory and exact scenario. Never downgrade a database or mix keys/installations. The 30-day worker/certificate lifetime and five-minute authorization window are unchanged. No production SLA or indefinite renewal is promised.

## Maintainer checklist

1. Review scoped changes and preserve the previous commit.
2. Update package/lock version and CHANGELOG; keep dependency/notices/SBOM consistent.
3. Build a clean distribution excluding private history, credentials and local labs.
4. Run clean install, Doctor, proof, affected visual acceptance if UI changed, full checks, dependency advisories and manifest verification. Record environment, failures and limits.
5. Check README links, fixed download/tag, video provenance and expected-failure examples.
6. Publish a new tag and notes with tested source, evidence summary and checksums. Do not force-move tags or silently replace assets.
7. Read back public commit/tag/assets. Local success is not publication evidence.

New source requires a regenerated manifest. Verification must fail for stale, missing or additional distribution files. The independent export pipeline regenerates inventory and SBOM; contributors propose normal source changes and maintainers produce the final distribution rather than hand-editing hashes.

## Competition boundary

This is the standalone Amazon edition, not the older WebMCP deployment. The initial source commit remains available. 0.3.0 improves reproducibility without changing the existing video workflow. GitHub release, Devpost submission and organizer acceptance are separate states; publishing this release does not resubmit the entry.

