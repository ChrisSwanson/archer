// A private, consistent copy of the checkout's page build (ui/dist) for tests that bundle or package it,
// so `npm --workspace ui run build` in another terminal or agent during the run cannot change the pages
// between the bundle and the comparison (known failure T5). Vite empties ui/dist and then writes it, so a
// copy taken meanwhile can be partial or mixed: it is kept only when complete and still equal to the source.
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pageAssetFiles } from "../../scripts/bundle.ts";
import { REPO } from "../terminal/models.ts";

const UI_DIST = join(REPO, "ui", "dist");
const PAGES = ["index.html", join("mcp", "index.html")];

function consistent(copy: string, source: string): boolean {
  try {
    if (!PAGES.every((page) => readFileSync(join(copy, page)).equals(readFileSync(join(source, page))))) return false;
    // Every worker the page names was copied, byte for byte.
    return pageAssetFiles(join(copy, "index.html")).every((asset) =>
      readFileSync(asset).equals(readFileSync(join(source, "page-assets", basename(asset)))),
    );
  } catch {
    return false;
  }
}

/**
 * Copies ui/dist to `dest` and returns `dest`, or undefined when the checkout has no page build (a bundle
 * then refuses to build). Waits out a build in progress, up to `waitMs`.
 */
export async function snapshotUiDist(dest: string, waitMs = 60_000): Promise<string | undefined> {
  const source = process.env["ARCHER_PAGE"] === undefined ? UI_DIST : dirname(resolve(process.env["ARCHER_PAGE"]));
  if (!existsSync(source)) return undefined;
  const deadline = Date.now() + waitMs;
  for (;;) {
    rmSync(dest, { recursive: true, force: true });
    try {
      cpSync(source, dest, { recursive: true });
    } catch {
      /* changed while copied: try again */
    }
    if (consistent(dest, source)) return dest;
    if (Date.now() >= deadline)
      throw new Error(
        `${source} did not hold still for a consistent copy within ${waitMs} ms: is a page build looping?`,
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * `pages` as the next build would leave it, written to `dest`: the layout worker's bytes differ, so it has
 * another hashed name, and the page names that one. Returns the old and new names.
 */
export function nextUiBuild(
  pages: string,
  dest: string,
): { readonly dest: string; readonly before: string; readonly after: string } {
  rmSync(dest, { recursive: true, force: true });
  cpSync(pages, dest, { recursive: true });
  const page = join(dest, "index.html");
  const [worker] = pageAssetFiles(page).filter((asset) => /elk-layout-worker-/.test(basename(asset)));
  if (worker === undefined) throw new Error(`${page} names no layout worker`);
  const before = basename(worker),
    after = before.replace(/-[\w-]+\.js$/, "-NextBld1.js");
  writeFileSync(join(dest, "page-assets", after), `${readFileSync(worker, "latin1")}\n// the next build\n`, "latin1");
  rmSync(worker);
  writeFileSync(page, readFileSync(page, "latin1").replaceAll(before, after), "latin1");
  return { dest, before, after };
}
