// The web page's own files (`shared/page-assets.mts`): the `ui` build writes them to `page-assets/` beside
// the page (today one, the ELK layout worker, ~1.5 MB), each named by its content hash. The service serves
// them at `/-/page-assets/<name>` under the page's credential, so the page and its worker are admitted
// alike (same origin; the worker's fetch carries the cookie) and no route opens without one.
//
// A build's assets are read when its page is, and only the ones it names, so a page and its worker are one
// snapshot even if the build is replaced on disk meanwhile. A service that took over from another
// (`archer upgrade`, ADR 0032) also keeps the previous build's, read at the hand-over: a tab loaded before
// it that has not started its worker yet still gets the one its page names. Older builds are not kept.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { namedPageAssets, PAGE_ASSETS_DIR } from "../../../shared/page-assets.mts";
import { readPrecompressed } from "./page-version.ts";

export interface PageAsset {
  readonly bytes: Buffer;
  /** Compressed copies made at package time of exactly these bytes (`writePrecompressed`), when present. */
  readonly packaged: { readonly gzip: Buffer; readonly br: Buffer } | null;
}

/**
 * The assets `page` (the text of the page at `pagePath`) names, read now from beside it, by name. A name the
 * page gives that is not a file there is left out: that tab's worker cannot start, and it says to reload.
 */
export function readPageAssets(pagePath: string, page: string): ReadonlyMap<string, PageAsset> {
  const dir = join(dirname(pagePath), PAGE_ASSETS_DIR);
  const assets = new Map<string, PageAsset>();
  for (const name of namedPageAssets(page)) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dir, name));
    } catch {
      continue;
    }
    assets.set(name, { bytes, packaged: readPrecompressed(join(dir, name), bytes) });
  }
  return assets;
}

/** The previous build's assets, from its page at `pagePath`; none when that page cannot be read. */
export function readPreviousPageAssets(pagePath: string): ReadonlyMap<string, PageAsset> {
  try {
    return readPageAssets(pagePath, readFileSync(pagePath, "latin1"));
  } catch {
    return new Map();
  }
}
