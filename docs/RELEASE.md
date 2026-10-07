# Release and maintenance policy — v0.13.1

The distribution version identifies a source snapshot. Component contracts may retain their own versions. `main`, a tag, a release page, a source archive, CI and a film are separate artifacts; a change to one does not update the others. [VALIDATION](VALIDATION.md) records each status. A candidate is not a published release.

## Reproduce or integrate a version

Pin the intended public commit/tag and lockfile; use Node.js 24.15.0+. Follow [INSTALL](INSTALL.md), then the independent [MCP/HTTP integration](EXTERNAL_INTEGRATION.md). Run affected checks while changing code and `npm run check` at a release checkpoint. Complete source-bound runtime/container gates when the change affects their boundary.

`npm run verify:source` validates an intact distribution's inventory and SHA-256 manifest. It checks bytes and paths, not author identity, independent certification or trustworthy time. Edited source needs a freshly prepared distribution; do not hand-edit hashes to disguise a change.

## Compatibility and recovery

Runtime, governed-assistant, notification and research profiles have distinct storage/authority contracts. Do not infer one profile's schema or token model from another. Reopen a compatible installation using its exact parameters. Before upgrading, stop services and retain a protected copy of the complete private installation; do not publish it, mix keys/databases, downgrade a schema or resurrect revoked authority. See [RUNTIME](RUNTIME.md) for current refusal and recovery behavior.

## Maintainer release checklist

1. Review the scoped diff, license/notices and dependency changes; preserve the prior commit and identify rollback limits.
2. Align package/lock version, current README, CHANGELOG, contribution/integration documentation and the candidate validation record.
3. Build clean Amazon and Astra distributions without private history, private application materials, credentials or installation data.
4. Run clean installs, independent consumer checks, appropriate positive/negative tests, full source checks and source-manifest verification. Record exact source, environment, commands and outcomes. Add visible workflow review when UI changes.
5. Obtain fresh source-bound runtime/container evidence and public CI for the intended candidate; do not reuse a historical count. Confirm that new docs/examples are in the exported inventory.
6. Publish a new immutable tag, release notes, source archive and checksums only after the release decision. Never force-move an old tag or silently replace historical assets.
7. Read back public commit, tag, release, archive/checksum and CI. Check current media against its recorded source/report; keep older films labeled historical.

Publishing source does not submit a contest entry or grant application, and does not establish organizer acceptance. Prior WebMCP and closed Astra judging snapshots remain preserved. [MAINTAINER_PLAN](MAINTAINER_PLAN.md) describes ongoing responsibility and maintenance resource use without promising a release cadence or support SLA.

## Prepare source from a public checkout

From a clean committed checkout of the public repository:

```sh
npm run release:prepare -- ../dungeonq-source-0131
npm run verify:source -- ../dungeonq-source-0131
```

The new destination must be outside the checkout. The builder uses reviewed tracked source, rejects unsafe/private paths and dirty input, regenerates SBOM and a manifest, then verifies the output. It creates no tag, upload or deployment. Untracked contributions must be reviewed and committed first. Generated SBOM metadata can vary; compare source identity and per-file digests.

A manifest's `sourceCommit` may identify the source-input commit before the packaged SBOM/manifest commit; the tag identifies the final snapshot. Keep that distinction explicit in the validation record. Public CI has read-only repository permissions and no deployment/model-call authority; its test success alone does not establish protected-branch enforcement.

<details>
<summary>Historical governed-assistant documentation (v0.4 and earlier scope)</summary>

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

</details>
