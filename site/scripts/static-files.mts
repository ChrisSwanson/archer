import { statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { UserConfig } from "vitepress";

// The site is served by VitePress's own Vite (a different copy from the workspace's), so type the plugin by it.
type Plugin = Extract<NonNullable<NonNullable<UserConfig["vite"]>["plugins"]>[number], { name: string }>;

export type StaticLookup =
  | { readonly kind: "file"; readonly file: string; readonly directoryIndex: boolean }
  | { readonly kind: "redirect"; readonly location: string }
  | null;

const kindOf = (path: string): "file" | "directory" | null => {
  try {
    const stat = statSync(path);
    return stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null;
  } catch {
    return null;
  }
};

/**
 * Map a request path to a file the way GitHub Pages serves the built site: a directory serves its
 * `index.html` (a directory named without its slash redirects to the slash form) and, with clean
 * URLs, `/page` serves `page.html`. Paths outside `root` or every `base` find nothing.
 */
export function lookupStatic(
  root: string,
  bases: string | readonly string[],
  pathname: string,
  options: { cleanUrls?: boolean } = {},
): StaticLookup {
  const base = [bases]
    .flat()
    .sort((a, b) => b.length - a.length)
    .find((candidate) => pathname.startsWith(candidate));
  if (base === undefined) return null;
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(base.length));
  } catch {
    return null;
  }
  const top = resolve(root);
  const path = resolve(top, relative);
  if (path !== top && !path.startsWith(top + sep)) return null;
  const kind = kindOf(path);
  if (kind === "file") return { kind: "file", file: path, directoryIndex: false };
  if (kind === "directory") {
    const index = resolve(path, "index.html");
    if (kindOf(index) !== "file") return null;
    return pathname.endsWith("/")
      ? { kind: "file", file: index, directoryIndex: true }
      : { kind: "redirect", location: `${pathname}/` };
  }
  if (options.cleanUrls && !pathname.endsWith("/") && kindOf(`${path}.html`) === "file")
    return { kind: "file", file: `${path}.html`, directoryIndex: false };
  return null;
}

/**
 * Vite does not serve a public directory's `index.html` for the directory's own address; GitHub Pages
 * does. Rewrite those requests in the dev server so `/playground/app/` opens there as it does in production.
 */
export function publicDirectoryIndex(publicDir: string, base: string): Plugin {
  return {
    name: "archer-public-directory-index",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://dev.invalid");
        // The home page is VitePress's own.
        const found = url.pathname === base ? null : lookupStatic(publicDir, base, url.pathname);
        if (found?.kind === "redirect") {
          response.statusCode = 301;
          response.setHeader("location", `${found.location}${url.search}`);
          response.end();
          return;
        }
        if (found?.kind === "file" && found.directoryIndex) request.url = `${url.pathname}index.html${url.search}`;
        next();
      });
    },
  };
}
