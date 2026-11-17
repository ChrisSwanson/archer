// The web page's layout worker: its own content-hashed file (`vite.config.ts`, `page-assets/`), which
// the service serves at `/-/page-assets/<name>` under the page's own credential. The MCP App build
// replaces this module with `elk-worker-script-inline.ts` (one self-contained file, ADR 0003).
import builtAddress from "./elk-layout-worker?worker&url";
import { PAGE_ASSETS_DIR } from "../../../shared/page-assets.mts";

/** Where the page fetches its worker; the dev server serves the module itself, as an ES module. */
export function layoutWorkerAddress(built: string, dev: boolean): string {
  if (dev) return built;
  const name = new URL(built, "http://page.invalid/").pathname.split("/").pop() ?? "";
  return `/-/${PAGE_ASSETS_DIR}/${name}`;
}

export function createLayoutWorker(): Worker {
  const dev = import.meta.env.DEV;
  return new Worker(layoutWorkerAddress(builtAddress, dev), dev ? { type: "module" } : undefined);
}
