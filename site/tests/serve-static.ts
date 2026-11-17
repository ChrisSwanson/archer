import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { lookupStatic } from "../scripts/static-files.mts";

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
};

export interface StaticServer {
  readonly origin: string;
  close(): Promise<void>;
}

export interface ServeOptions {
  /**
   * Send GitHub Pages' caching headers: `Cache-Control: max-age=600` with a `Last-Modified` and an `ETag`, and a
   * 304 for a matching revalidation. Off by default, so other checks always see fresh files.
   */
  readonly pagesCache?: boolean;
}

/** Serve a built site (or its public directory) under one or more bases, as GitHub Pages would, for browser tests. */
export async function serveStatic(
  root: string,
  base: string | readonly string[],
  options: ServeOptions = {},
): Promise<StaticServer> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://site.invalid");
    const found = lookupStatic(root, base, url.pathname, { cleanUrls: true });
    if (found?.kind === "redirect") {
      // As Pages (and the dev server) do: the query goes with the redirect; a Playground route lives in it.
      response.writeHead(301, { location: `${found.location}${url.search}` }).end();
      return;
    }
    if (found === null) {
      // As Pages does: the site's own 404.html, with the 404 status (the public directory alone has none).
      const page = await readFile(join(root, "404.html")).catch(() => null);
      if (page === null) response.writeHead(404).end();
      else response.writeHead(404, { "content-type": types[".html"]! }).end(page);
      return;
    }
    try {
      const bytes = await readFile(found.file);
      const headers: Record<string, string> = {
        "content-type": types[extname(found.file)] ?? "application/octet-stream",
      };
      if (options.pagesCache) {
        const { mtime, size } = await stat(found.file);
        const etag = `"${mtime.getTime().toString(16)}-${size.toString(16)}"`;
        Object.assign(headers, { "cache-control": "max-age=600", "last-modified": mtime.toUTCString(), etag });
        if (request.headers["if-none-match"] === etag) {
          response.writeHead(304, headers).end();
          return;
        }
      }
      response.writeHead(200, headers).end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
  };
}
