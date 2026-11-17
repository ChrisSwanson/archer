/**
 * The web page these e2e tests serve: `ARCHER_PAGE` (a build elsewhere, such as a scratch `vite build --outDir`), else
 * this checkout's `ui/dist/index.html`. A page that is not there fails the test with what to do (O74), not with the
 * service's own error about a missing file.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** This checkout's build. */
export const DIST_PAGE = resolve(import.meta.dirname, "../../../dist/index.html");

export function testPage(): string {
  const page = process.env["ARCHER_PAGE"] ?? DIST_PAGE;
  if (!existsSync(page)) {
    throw new Error(
      process.env["ARCHER_PAGE"] === undefined
        ? `No page to test: ${DIST_PAGE} is not built. Build it first (npm --workspace ui run build), or set ARCHER_PAGE to a built index.html.`
        : `No page to test: ARCHER_PAGE=${page} does not exist. Point it at a built index.html, or unset it to use ui/dist (npm --workspace ui run build).`,
    );
  }
  return page;
}
