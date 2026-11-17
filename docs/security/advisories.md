# Dependency advisories

This file holds the remediation time frames and one dated decision per advisory.

## Policy

Scope: every runtime and build dependency, meaning anything that can change the bytes Archer ships
(the `ts/dist` bundle, the page in `ui/dist`, the package). Test-only tools are dev-only.

| Severity (npm audit) | Where | Decide and fix within |
|---|---|---|
| critical | shipped code | 7 days |
| high | shipped code | 30 days |
| moderate, low, or any dev-only | | the next release |

The clock starts when the advisory is published, or when the audit first reports it, whichever is
later. Each advisory gets a dated decision, one of:

- **fixed in X**: the version, and the lockfile commit that brings it in;
- **not reachable because …**: the code path that keeps the vulnerable function out of Archer's
  use, checked against the source at that date, plus the version that will fix it and its due date.

A decision that relies on reachability is checked again whenever the dependency or the code path
changes.

How it is read: CI runs `npm audit --omit=dev`, `npm audit` and `npm audit signatures` as a
reported step that never blocks (the workflow step "npm audit (reported, not blocking)"). An advisory that step reports and this table lacks needs a row within its time frame.
Locally: `npm audit --json`.

## Decisions

Audit of 2026-10-31 (npm 11.19.1, Node 24.22.1; a second audit with npm 10.9.8
and Node 22 gave the same advisory IDs) on v0.8.0's lockfile: 1 critical, 3 high and 2
moderate packages, 12 advisories. After the upgrades below, `npm audit` reports 0 and
`npm audit signatures` verifies.

| Package (was → now) | Advisory | Severity | Shipped? | Decision (2026-10-31) |
|---|---|---|---|---|
| dompurify 3.4.16 → 3.4.17 | GHSA-cg2g-xh64-v4q7 (SAFE_FOR_TEMPLATES bypass in shadow-root content) | critical | in `ts` dependencies; the bundle aliases it to `ts/scripts/dompurify-stub.mjs` | **Fixed in 3.4.17.** It was not reachable before: Mermaid is its only caller, and `ts/src/mermaid/purify-stub.ts` (unbundled) and the bundle's alias replace `sanitize` with an identity. Archer never sanitizes with DOMPurify; labels are validated (`ts/src/mermaid/labels.ts`) and each painter escapes its output. |
| dompurify | GHSA-mrv2-3pqr-j5jr (IN_PLACE hook leaves handlers armed) | high | as above | **Fixed in 3.4.17.** Not reachable before, for the same reason; Archer never uses `IN_PLACE`. |
| dompurify | GHSA-c6gr-qvv4-5v3f (SMIL `attributeName=href` with an XHTML parser) | low | as above | **Fixed in 3.4.17.** Not reachable before, for the same reason. |
| body-parser 2.3.0 → 2.4.0 | GHSA-27r3-jxmh-p828 (DoS through trailing bytes after a compressed body) | high | no: it comes with express, through `@modelcontextprotocol/sdk` | **Fixed in 2.4.0** (lockfile; within express's `^2.2.1`). It was not reachable before: Archer imports only the SDK's stdio server, client, in-memory transport and types (`ts/src/mcp/`), never its express-based HTTP transports, so express is not in the bundle. Archer's own HTTP service parses bodies itself, with byte caps. |
| zod 4.4.3 → 4.6.7 | GHSA-mrhx-c7xc-m3w5 (memory exhaustion validating oversized constrained collections) | high | yes: the SDK validates MCP messages with it, and the page bundles it through `@modelcontextprotocol/ext-apps` | **Fixed in 4.6.7** (lockfile; within the SDK's `^3.25 \|\| ^4.0` and ext-apps' `^3.25.0 \|\| ^4.0.0`). Reachable before only by the MCP client on stdio (the agent host the person started) and by the MCP host frame. |
| vite 8.1.5 → 8.3.5 | GHSA-587h-7wmj-h5pm (launch-editor `existsSync` check bypass, Windows) | high | build tool: builds `ui/dist`, ships nothing of its own | **Fixed in 8.3.5.** Not reachable before: launch-editor runs only under the dev server's open-in-editor endpoint, on Windows; release builds run `vite build` on Linux CI. |
| vite | GHSA-r825-w8mm-5pxw, GHSA-698v-4r3x-3vcv (launch-editor CLI flags; `%` escaping on Windows) | moderate | build tool | **Fixed in 8.3.5.** Dev server only, as above. |
| vite | GHSA-rq7h-c2jc-7f22 (files outside `server.fs.allow`) | moderate | build tool | **Fixed in 8.3.5.** Dev server only; `vite build` serves nothing. |
| vite | GHSA-9jrq-w75r-8gcw (cross-origin script execution through custom middleware) | low | build tool | **Fixed in 8.3.5.** Dev server only, and Archer adds no custom middleware that serves scripts; its dev proxy rewrites Origin only when it equals the dev server's own host (`ui/vite.config.ts`). |
| vitest 4.1.10 → 4.1.12, @vitest/mocker | GHSA-82fw-gwwq-j7x9 (path traversal through a redirect mock) | moderate | dev-only | **Fixed in 4.1.12.** |
| vitest, @vitest/mocker | GHSA-qxg6-89mg-rqv8 (code injection through manual mock registration) | moderate | dev-only | **Fixed in 4.1.12.** |

`scripts/patch-mermaid.mjs` (the root postinstall) patches only Mermaid, which is unchanged at
12.2.0. After the upgrades: both typechecks, the ts and ui vitest suites, the page build, the ts
bundle and the Mermaid-rendering browser tests pass.
