# Release and maintenance policy

## Reproduce a version

Use the fixed tag/commit, lockfile and recorded Node requirement. Do not assume `main` is unchanged. Install with `npm ci --ignore-scripts`; run Doctor, proof, `npm run check`, then `npm run verify:source`.

Source includes tests/docs, Apache-2.0, notices, SBOM and SHA-256 manifest. The manifest excludes itself; it checks content/inventory, not author identity or trustworthy time. Replacing both source and manifest is outside this check. Verify the expected GitHub tag/commit through a trusted channel.

## Compatibility

0.4.0 retains the 0.2.0 MCP/Scenario Pack and SQLite v5 contracts. It adds scenario-aware proof, an external client, public CI and release tooling, not runtime approval powers. Engine/SDK clients may retain component versions; the package version describes the distribution.

Reopen with a compatible lab directory and exact scenario. Never downgrade a database or mix keys/installations. The 30-day worker/certificate lifetime and five-minute authorization window are unchanged. No production SLA or indefinite renewal is promised.

## Maintainer checklist

1. Review scoped changes and preserve the previous commit.
2. Update package/lock version and CHANGELOG; keep dependency/notices/SBOM consistent.
3. Build a clean distribution excluding private history, credentials and local labs.
4. Run clean install, Doctor, proof, affected visual acceptance if UI changed, full checks, dependency advisories and manifest verification. Record environment, failures and limits.
5. Check README links, fixed download/tag, video provenance and expected-failure examples.
6. Publish a new tag and notes with tested source, evidence summary and checksums. Do not force-move tags or silently replace assets.
7. Read back public commit/tag/assets. Local success is not publication evidence.

## Build a source distribution without a private repository

From a clean committed checkout of **this public repository**:

```sh
npm run release:prepare -- ../dungeonq-source-040
npm run verify:source -- ../dungeonq-source-040
```

The second command verifies the new inventory; see the verifier's usage if choosing another directory. The builder uses tracked source only, excludes Git history, rejects secret paths/symlinks/dirty or private checkouts, regenerates SBOM from the lockfile, writes a fresh manifest and verifies its result. The destination must be new and outside the checkout. Untracked contributions must first be reviewed and committed. It creates no tag, upload, network deployment or GitHub release. npm SBOM timestamps/serials mean two distributions need not be byte-identical; source commit and per-file digests provide the comparison boundary.

The inventory in a fixed published tag describes that snapshot. After a normal source commit, it is expected to be stale until release preparation; CI verifies a freshly generated distribution rather than pretending the old manifest covers new files. Do not hand-edit hashes to hide differences. A maintainer may copy the regenerated SBOM/manifest into the release checkout, review and commit those two files, then tag that final commit. The manifest's `sourceCommit`, if present, records the preceding source-input commit; the tag identifies the final packaged snapshot.

The public `Synthetic acceptance` workflow has read-only repository permissions, pinned action revisions and Ubuntu/macOS jobs. It performs no deploy, publish, secret access or model/API calls. Artifacts contain only the disposable proof's public reports, receipts and verification key.

## Competition boundary

This is the standalone Amazon edition, not the older WebMCP deployment. The initial source commit remains available. 0.3.0 improves reproducibility without changing the existing video workflow. GitHub release, Devpost submission and organizer acceptance are separate states; publishing this release does not resubmit the entry.
