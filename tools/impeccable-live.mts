// Dev only: Impeccable's live picker served from the page's own origin, for the UI's Vite dev server
// (ui/vite.config.ts) and the docs' VitePress dev server (site/.vitepress/config.mts).
// Typed structurally: the two servers run different copies of Vite, so this returns a plain plugin object
// either one accepts.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "node:http";

type LiveOptions = {
  /** The helper's `server.json` (`<app root>/.impeccable/live/server.json`). */
  serverJson: URL;
  /** Add the script tag to served HTML while the helper runs (for a page with no HTML entry to inject into). */
  inject?: boolean;
};

type LiveServer = {
  middlewares: { use(handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): unknown };
  config: { logger: { warn(message: string): void } };
};

const LIVE_PREFIX = "/__impeccable";
const LIVE_CLIENTS = new Set([
  "127.0.0.1",
  "::1",
  ...(process.env.IMPECCABLE_LIVE_ALLOW ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean),
]);

/** `*` explicitly shares the dev helper with every client reaching this dev server. */
export function liveClientAllowed(
  remoteAddress: string | undefined,
  allowed: ReadonlySet<string> = LIVE_CLIENTS,
): boolean {
  const client = (remoteAddress ?? "").replace(/^::ffff:/, "");
  return client !== "" && (allowed.has("*") || allowed.has(client));
}

/** The Impeccable live helper's port and token from its `server.json`, or null when it is not running. */
function liveHelper(serverJson: URL): { port: number; token: string | undefined } | null {
  try {
    const info = JSON.parse(readFileSync(serverJson, "utf8"));
    return typeof info.port === "number" ? { port: info.port, token: info.token } : null;
  } catch {
    return null;
  }
}

/**
 * Dev only: serve Impeccable's live helper from the page's own origin.
 *
 * The helper listens on loopback and its script calls `http://localhost:PORT`,
 * which from a browser on another machine is that machine. Rewriting the
 * script to call `/__impeccable/…` and forwarding those requests here lets the
 * picker work from a LAN or tunnelled browser. The helper writes source and
 * anyone who loads the page can read its token, so only this host and the
 * addresses in `IMPECCABLE_LIVE_ALLOW` (comma-separated) may reach it. An
 * explicit `*` admits every client; use it only for a deliberately shared dev server.
 */
export function impeccableSameOrigin(options: LiveOptions) {
  return {
    name: "archer:impeccable-same-origin",
    apply: "serve" as const,
    transformIndexHtml(html: string): string {
      const rewritten = html.replace(/http:\/\/localhost:\d+\/live\.js/, `${LIVE_PREFIX}/live.js`);
      // A page with no HTML entry to inject into (VitePress) gets the tag here while the helper runs.
      const helper = options.inject ? liveHelper(options.serverJson) : null;
      if (!helper || rewritten.includes(`${LIVE_PREFIX}/live.js`)) return rewritten;
      return rewritten.replace(
        "</body>",
        `<script src="${LIVE_PREFIX}/live.js?token=${helper.token ?? ""}"></script>\n</body>`,
      );
    },
    configureServer(server: LiveServer) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(`${LIVE_PREFIX}/`)) return next();
        if (!liveClientAllowed(req.socket.remoteAddress)) {
          server.config.logger.warn(
            `Impeccable live helper refused ${req.socket.remoteAddress ?? "unknown address"}; add it to IMPECCABLE_LIVE_ALLOW.`,
          );
          res.statusCode = 403;
          res.end("Impeccable live helper is not shared with this address");
          return;
        }
        const port = liveHelper(options.serverJson)?.port ?? null;
        if (port === null) {
          res.statusCode = 503;
          res.end("Impeccable live helper is not running");
          return;
        }
        const path = req.url.slice(LIVE_PREFIX.length);
        const upstream = request(
          // HTTP/2 pseudo-headers (`:method`, …) are not valid HTTP/1 header names.
          {
            host: "127.0.0.1",
            port,
            path,
            method: req.method,
            headers: {
              ...Object.fromEntries(Object.entries(req.headers).filter(([name]) => !name.startsWith(":"))),
              host: `127.0.0.1:${port}`,
            },
          },
          (helper) => {
            // Connection-level headers are refused on an HTTP/2 (HTTPS) response.
            for (const name of ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"])
              delete helper.headers[name];
            if (!path.startsWith("/live.js")) {
              res.writeHead(helper.statusCode ?? 502, helper.headers);
              helper.pipe(res);
              return;
            }
            const chunks: Buffer[] = [];
            helper.on("data", (chunk: Buffer) => chunks.push(chunk));
            helper.on("end", () => {
              // A LAN address over plain HTTP is not a secure context, so the
              // browser withholds `crypto.randomUUID`, which the script needs
              // to start. `getRandomValues` is available either way.
              const script = (
                "if (!crypto.randomUUID) crypto.randomUUID = () => " +
                "'10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => " +
                "(c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));\n" +
                Buffer.concat(chunks).toString("utf8")
              )
                .replaceAll("'http://localhost:' + PORT", `(location.origin + '${LIVE_PREFIX}')`)
                // biome-ignore lint/suspicious/noTemplateCurlyInString: the helper script's own template literal, matched as text.
                .replaceAll("http://localhost:${PORT}", `\${location.origin}${LIVE_PREFIX}`);
              const { "content-length": _length, ...headers } = helper.headers;
              res.writeHead(helper.statusCode ?? 502, headers);
              res.end(script);
            });
          },
        );
        upstream.on("error", () => {
          res.statusCode = 502;
          res.end("Impeccable live helper is unreachable");
        });
        req.pipe(upstream);
      });
    },
  };
}
