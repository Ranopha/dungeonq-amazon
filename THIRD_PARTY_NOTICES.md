# Third-party notices

DungeonQ's deterministic core under `public/src/` has no runtime package dependency. The Sites build shell and development toolchain use the packages pinned by `package-lock.json`.

## Direct dependencies

| Package | Pinned version | Declared license | Purpose |
|---|---:|---|---|
| @modelcontextprotocol/sdk | 1.30.0 | MIT | Actual MCP client/server and Streamable HTTP transport |
| ssh2 | 1.17.0 | MIT | Bounded loopback SSH server and real test client |
| pg-gateway | 0.3.0-beta.4 | MIT | Bounded PostgreSQL wire profile; prerelease, no SQL engine |
| pg | 8.23.0 | MIT | Development-only PostgreSQL protocol acceptance client |
| Nodemailer | 10.0.10 | MIT-0 | Explicitly configured, TLS-verified administrator notification transport |
| jose | 6.2.12 | MIT | Google OpenID Connect signature, issuer, audience and nonce verification |
| React | 19.2.8 | MIT | Sites application shell |
| react-dom | 19.2.8 | MIT | Sites rendering |
| react-server-dom-webpack | 19.2.8 | MIT | Vinext peer/runtime integration |
| Vinext | 1.0.0-beta.8 | MIT | Cloudflare/Sites-compatible Next.js build |
| @cloudflare/vite-plugin | 1.54.8 | MIT | Worker build adapter |
| @cloudflare/workers-types | 5.20260911.1 | MIT OR Apache-2.0 | Worker type definitions |
| @openai/sites-vite-plugin | 0.2.0 | MIT | ChatGPT Sites build integration |
| @types/node | 22.19.19 | MIT | Type definitions |
| @types/react | 19.2.14 | MIT | Type definitions |
| @types/react-dom | 19.2.3 | MIT | Type definitions |
| @vitejs/plugin-react | 6.0.2 | MIT | React build plugin |
| @vitejs/plugin-rsc | 0.5.34 | MIT | React Server Components build plugin |
| TypeScript | 5.9.3 | Apache-2.0 | Static checking |
| Vite | 8.2.2 | MIT | Build tool |
| Wrangler | 4.131.1 | MIT OR Apache-2.0 | Local Worker execution and deployment tooling |

Complete transitive package names, versions, package URLs, hashes where available, and license identifiers are recorded in `SBOM.cdx.json`. Original license texts remain in each installed package and its upstream repository. No third-party JavaScript, fonts, analytics, images, or styles are loaded by the public browser page.
