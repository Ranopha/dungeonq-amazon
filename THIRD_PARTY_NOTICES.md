# Third-party notices

DungeonQ's deterministic browser core under `public/src/` has no runtime package dependency. Static build, preview and JavaScript syntax checking use Node built-ins. The runtime services and protocol tests use the packages pinned by `package-lock.json`.

## Direct dependencies

| Package | Pinned version | Declared license | Purpose |
|---|---:|---|---|
| @modelcontextprotocol/sdk | 1.32.1 | MIT | Actual MCP client/server and Streamable HTTP transport |
| ssh2 | 1.17.0 | MIT | Bounded loopback SSH server and real test client |
| pg-gateway | 0.3.0-beta.4 | MIT | Bounded PostgreSQL wire profile; prerelease, no SQL engine |
| pg | 8.23.0 | MIT | Development-only PostgreSQL protocol acceptance client |
| Nodemailer | 10.0.10 | MIT-0 | Explicitly configured, TLS-verified administrator notification transport |
| jose | 6.2.12 | MIT | Google OpenID Connect signature, issuer, audience and nonce verification |

The independently copied MCP consumer pins its own official SDK dependency and lockfile. The Node static builder also copies the existing public browser SDK into `runtime/client.mjs`; no browser bundle or framework runtime is added.

The Vinext redirect wrapper and its React, Vite, Cloudflare and TypeScript build dependencies are no longer part of the current source dependency graph. This removes the unused build-glob dependency chain instead of overriding or suppressing its advisory. Historical releases retain their own dependency manifests and notices.

Complete transitive package names, versions, package URLs, hashes where available, and license identifiers are recorded in the source release's generated `SBOM.cdx.json`. Original license texts remain in each installed package and its upstream repository. No third-party JavaScript, fonts, analytics, images, or styles are loaded by the public browser page.

The selected Initial Machine host example has its own dependency lockfile: `tsx` 4.23.1 (MIT), `esbuild` 0.28.2 (MIT, via tsx), and `zod` 4.4.3 (MIT). It downloads the separately licensed Apache-2.0 DungeonQ runtime at the exact v0.13.1 commit; downloaded code, node_modules, artificial state and private transcripts are excluded from this source distribution. The example lockfile is authoritative for the host graph; the root SBOM does not claim to cover this independent graph.
