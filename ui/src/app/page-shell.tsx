/**
 * The shell the page's entry (`main.tsx`) mounts: the browser-served page (`App`) or the MCP-App view
 * (`McpApp`), chosen by the protocol (`hostMode`), so the dev server and the tests run either.
 *
 * A page build mounts its target's shell and nothing else: `pageBuildAliases` (vite.config.ts) puts
 * `page-shell-web.ts` or `page-shell-mcp.ts` in this module's place, so neither build reaches the other
 * shell's modules. Choosing at runtime in a build would keep both, and loading one by `import()` costs
 * the one-file web page about 7 KB gzip of lazy-module wrappers.
 */
import type { JSX } from "react";
import { App } from "./App";
import { hostMode } from "./host-bridge";
import { McpApp } from "./McpApp";

export function PageShell(): JSX.Element {
  return hostMode() === "mcp" ? <McpApp /> : <App />;
}
