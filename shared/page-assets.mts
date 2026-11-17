// The web page's own files: the `ui` build writes them to `page-assets/` beside the page, each named by its
// content hash, and the service serves them at `/-/page-assets/<name>`. One directory name and one name rule
// for the build, the page, the service, the bundle and their tests.

/** The directory beside the page, and the route segment after `/-/`. */
export const PAGE_ASSETS_DIR = "page-assets";

/** A built asset's name: no directory, no leading dot, a script. */
export const PAGE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.js$/;

/** The assets a built page names (`page-assets/<name>`), each once, in order. */
export function namedPageAssets(page: string): string[] {
  const found = page.match(new RegExp(`(?<=${PAGE_ASSETS_DIR}/)[\\w.-]+`, "g")) ?? [];
  return [...new Set(found.filter((name) => PAGE_ASSET_NAME.test(name)))];
}
