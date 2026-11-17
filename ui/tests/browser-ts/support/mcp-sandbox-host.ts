/**
 * An MCP Apps host built the way the specification asks a host to embed a `ui://` resource, for the
 * security rubric's G7 probe (P6) in a host: docs/quality/rubrics/security.md.
 *
 *   host page    origin A. Runs the official `AppBridge` (support/mcp-sandbox-host-entry.ts, bundled here
 *                with esbuild), as a host's chat page does.
 *   sandbox proxy  origin B (another port, so another origin), in an iframe with
 *                `sandbox="allow-scripts allow-same-origin"`. It answers `sandbox-proxy-ready`, and on
 *                `sandbox-resource-ready` puts the resource's HTML in an inner iframe by `srcdoc` with the
 *                `sandbox` the host chose, then relays JSON-RPC between the bridge and the view.
 *   CSP          built from the resource's own `_meta.ui.csp` by `resourcePolicy` (the specification's
 *                mapping), applied either as the proxy's HTTP header, which the `srcdoc` frame inherits and
 *                the view cannot remove ("header"), or as a `<meta>` the proxy writes first into the
 *                resource's `<head>` ("meta"), or not at all ("none": the positive control only).
 *
 * `HostDetectors` are the G7 detectors (support/xss-detectors.ts) made to see into frames: a sandboxed
 * frame without `allow-modals` or `allow-popups` swallows `alert()` and `window.open()` with a console
 * line, so those lines are detectors here too; every frame's raw `window.__xss` is read as well as the
 * init-script setter, so a frame the init script missed still counts.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Frame, Page, Request } from "@playwright/test";
import { build } from "esbuild";
import { CLOBBER_NAMES, DETECTORS, SCRIPT_URL, scanDocument, type Detector, type Hit } from "./xss-detectors";

const HERE = dirname(fileURLToPath(import.meta.url));

export type ResourceCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};
export type CspMode = "header" | "meta" | "none";

/**
 * The CSP a host builds from a resource's declared domains (MCP Apps specification, "Content Security
 * Policy"): deny by default; inline script and style allowed (the view is one inline file); every
 * declared resource domain for scripts, styles, images, fonts and media; connect, frame and base-uri only
 * as declared.
 */
export function resourcePolicy(csp: ResourceCsp = {}): string {
  const resources = (csp.resourceDomains ?? []).join(" ");
  const join = (...parts: string[]): string => parts.filter((p) => p !== "").join(" ");
  return [
    "default-src 'none'",
    join("script-src 'self' 'unsafe-inline'", resources),
    join("style-src 'self' 'unsafe-inline'", resources),
    join("connect-src 'self'", (csp.connectDomains ?? []).join(" ")),
    join("img-src 'self' data:", resources),
    join("font-src 'self' data:", resources),
    join("media-src 'self' data:", resources),
    `frame-src ${(csp.frameDomains ?? []).join(" ") || "'none'"}`,
    "object-src 'none'",
    `base-uri ${(csp.baseUriDomains ?? []).join(" ") || "'self'"}`,
  ].join("; ");
}

const PROXY_PAGE = (cspMode: CspMode, policy: string): string => `<!doctype html>
<meta charset="utf-8">
<title>sandbox proxy</title>
<style>html, body { margin: 0; height: 100%; overflow: hidden; } iframe { display: block; width: 100vw; height: 100vh; border: 0; }</style>
<script>
  const CSP_MODE = ${JSON.stringify(cspMode)}, POLICY = ${JSON.stringify(policy)};
  let inner = null;
  window.addEventListener("message", (event) => {
    if (event.source === window.parent) {
      const message = event.data;
      if (message && message.method === "ui/notifications/sandbox-resource-ready") {
        let html = message.params.html;
        if (CSP_MODE === "meta") {
          const meta = '<meta http-equiv="Content-Security-Policy" content="' + POLICY.replace(/"/g, "&quot;") + '">';
          html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (head) => head + meta) : meta + html;
        }
        inner = document.createElement("iframe");
        inner.id = "view";
        inner.setAttribute("sandbox", message.params.sandbox || "allow-scripts allow-same-origin");
        document.body.append(inner);
        inner.srcdoc = html;
        return;
      }
      if (inner && inner.contentWindow) inner.contentWindow.postMessage(message, "*");
    } else if (inner && event.source === inner.contentWindow) {
      window.parent.postMessage(event.data, "*");
    }
  });
  window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} }, "*");
</script>`;

const HOST_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>G7 MCP host</title>
<style>html, body { margin: 0; height: 100%; overflow: hidden; } #proxy { display: block; width: 100vw; height: 100vh; border: 0; } .export { position: absolute; left: 0; top: 0; width: 600px; height: 400px; }</style>
<script src="/host.js"></script>
<body></body>`;

let hostBundle: Promise<string> | undefined;
function bundle(): Promise<string> {
  hostBundle ??= build({
    entryPoints: [resolve(HERE, "mcp-sandbox-host-entry.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
  }).then((out) => out.outputFiles[0]!.text);
  return hostBundle;
}

type Served = { body: string | Buffer; type: string; csp?: string };

/** The two origins: A serves the host page, its bundle and the resource bytes; B the proxy and raw files. */
export class HostServers {
  private readonly files = new Map<string, Served>();
  private constructor(
    private readonly a: Server,
    private readonly b: Server,
    readonly hostOrigin: string,
    readonly proxyOrigin: string,
  ) {}

  static async start(): Promise<HostServers> {
    let self: HostServers | undefined;
    const handler = (side: "a" | "b") => async (request: IncomingMessage, response: ServerResponse) => {
      const path = new URL(request.url ?? "/", "http://x").pathname;
      if (side === "a" && path === "/") return send(response, { body: HOST_PAGE, type: "text/html; charset=utf-8" });
      if (side === "a" && path === "/host.js") return send(response, { body: await bundle(), type: "text/javascript" });
      const served = self!.files.get(`${side}${path}`);
      if (served === undefined) {
        response.writeHead(404).end();
        return;
      }
      send(response, served);
    };
    const a = createServer((q, r) => void handler("a")(q, r));
    const b = createServer((q, r) => void handler("b")(q, r));
    for (const s of [a, b]) await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    const port = (s: Server) => (s.address() as { port: number }).port;
    self = new HostServers(a, b, `http://127.0.0.1:${port(a)}`, `http://127.0.0.1:${port(b)}`);
    return self;
  }

  /** Serve `body` on origin A ("a") or B ("b") at `path`; returns its URL. */
  serve(side: "a" | "b", path: string, served: Served): string {
    this.files.set(`${side}${path}`, served);
    return `${side === "a" ? this.hostOrigin : this.proxyOrigin}${path}`;
  }

  /** A sandbox proxy for one run: its CSP as a header (mode "header"), as a meta it writes, or none. */
  proxy(key: string, mode: CspMode, policy: string): string {
    return this.serve("b", `/proxy/${key}`, {
      body: PROXY_PAGE(mode, policy),
      type: "text/html; charset=utf-8",
      ...(mode === "header" ? { csp: policy } : {}),
    });
  }

  stop(): void {
    for (const s of [this.a, this.b]) {
      s.closeAllConnections();
      s.close();
    }
  }
}

function send(response: ServerResponse, served: Served): void {
  response.writeHead(200, {
    "content-type": served.type,
    "cache-control": "no-store",
    ...(served.csp === undefined ? {} : { "content-security-policy": served.csp }),
  });
  response.end(served.body);
}

export type HostEvent = { kind: string; detail: string; where: string };
export type ToolCaller = (params: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;

/** One host page with one app resource in it. */
export class SandboxHost {
  readonly events: HostEvent[] = [];
  private where = "start";
  private constructor(
    readonly page: Page,
    readonly servers: HostServers,
  ) {}

  /**
   * Opens the host at origin A, serves `html` (the resource's text) and a proxy with `cspMode`, and hands the
   * resource to the proxy with `sandbox`; resolves when the view has sent `ui/notifications/initialized`.
   */
  static async open(
    page: Page,
    servers: HostServers,
    options: { key: string; html: string; csp: ResourceCsp; cspMode: CspMode; sandbox: string; callTool: ToolCaller },
  ): Promise<SandboxHost> {
    const host = new SandboxHost(page, servers);
    const resourceUrl = servers.serve("a", `/resource/${options.key}.html`, {
      body: options.html,
      type: "text/html; charset=utf-8",
    });
    const proxyUrl = servers.proxy(options.key, options.cspMode, resourcePolicy(options.csp));
    await page.exposeBinding("g7CallTool", (_source, params: { name: string; arguments?: Record<string, unknown> }) => {
      host.events.push({ kind: "tools/call", detail: params.name, where: host.where });
      return options.callTool(params);
    });
    await page.exposeBinding("g7HostEvent", (_source, kind: string, detail: string) => {
      host.events.push({ kind, detail, where: host.where });
    });
    await page.goto(`${servers.hostOrigin}/`);
    await page.waitForFunction(() => (window as unknown as { g7Host?: unknown }).g7Host !== undefined);
    await page.evaluate(
      (o) => (window as unknown as { g7Host: { start(o: unknown): Promise<void> } }).g7Host.start(o),
      { proxyUrl, resourceUrl, sandbox: options.sandbox, csp: options.csp },
    );
    const deadline = Date.now() + 30_000;
    while (!host.events.some((e) => e.kind === "initialized")) {
      if (Date.now() > deadline)
        throw new Error(`the view never initialized; host events: ${JSON.stringify(host.events)}`);
      await page.waitForTimeout(100);
    }
    return host;
  }

  at(where: string): void {
    this.where = where;
  }

  /** The proxy frame (origin B). */
  proxyFrame(): Frame | undefined {
    return this.page.frames().find((f) => f.url().startsWith(`${this.servers.proxyOrigin}/proxy/`));
  }

  /** The view: the proxy's inner `srcdoc` frame. */
  view(): Frame {
    const proxy = this.proxyFrame();
    const view = proxy?.childFrames()[0];
    if (view === undefined) throw new Error("no view frame inside the sandbox proxy");
    return view;
  }

  toolResult(result: unknown): Promise<void> {
    return this.page.evaluate(
      (r) => (window as unknown as { g7Host: { toolResult(r: unknown): Promise<void> } }).g7Host.toolResult(r),
      result as Record<string, unknown>,
    );
  }

  toolInput(args: Record<string, unknown>): Promise<void> {
    return this.page.evaluate(
      (a) => (window as unknown as { g7Host: { toolInput(a: unknown): Promise<void> } }).g7Host.toolInput(a),
      args,
    );
  }
}

/** The G7 detectors across every frame of a host page (see the file comment). */
export class HostDetectors {
  readonly hits: Hit[] = [];
  private where = "start";
  private readonly expectedPages = new Set<Page>();
  private pendingPages = 0;

  private constructor(
    private readonly page: Page,
    private readonly allowed: readonly string[],
  ) {}

  static async arm(context: BrowserContext, page: Page, allowedOrigins: readonly string[]): Promise<HostDetectors> {
    const d = new HostDetectors(page, allowedOrigins);
    await context.exposeBinding("__g7Report", (_source, detector: Detector, detail: string) =>
      d.hit(detector, String(detail)),
    );
    await context.addInitScript(() => {
      const report = (kind: string, detail: unknown): void => {
        try {
          void (window as unknown as { __g7Report(k: string, d: string): Promise<void> }).__g7Report(
            kind,
            String(detail),
          );
        } catch {
          /* binding gone */
        }
      };
      Object.defineProperty(window, "__g7Armed", { value: true, configurable: false });
      Object.defineProperty(window, "__xss", {
        configurable: false,
        get: () => undefined,
        set: (value: unknown) => report("canary", value),
      });
      document.addEventListener(
        "securitypolicyviolation",
        (event) => report("csp", `${event.violatedDirective} ${event.blockedURI} @ ${location.href.slice(0, 60)}`),
        true,
      );
      for (const name of ["alert", "confirm", "prompt", "print"] as const) {
        (window as unknown as Record<string, unknown>)[name] = (message?: unknown) => {
          report("dialog", `${name}: ${String(message)}`);
          return null;
        };
      }
      const open = window.open.bind(window);
      window.open = (url?: string | URL, ...rest: unknown[]) => {
        const href = String(url ?? "");
        if (/^\s*(?:javascript|vbscript|data:)/i.test(href)) report("navigation", `window.open ${href}`);
        return open(url, ...(rest as [string?, string?]));
      };
    });
    const watch = (watched: Page): void => {
      watched.on("dialog", (dialog) => {
        d.hit("dialog", `${dialog.type()}: ${dialog.message()}`);
        void dialog.dismiss().catch(() => {});
      });
      watched.on("console", (message) => {
        const text = message.text();
        // A sandbox without allow-modals ignores the call; the console line is the only trace.
        const modal = /Ignored call to '(alert|confirm|prompt|print)\(\)'/.exec(text);
        if (modal) d.hit("dialog", `sandbox swallowed ${modal[1]}(): ${text.slice(0, 160)}`);
        const blocked = /Blocked opening '([^']*)'/.exec(text);
        if (blocked && SCRIPT_URL.test(blocked[1]!)) d.hit("navigation", `blocked popup at ${blocked[1]}`);
        if (/Unsafe attempt to initiate navigation|Not allowed to navigate top frame/i.test(text))
          d.hit("navigation", text.slice(0, 200));
      });
      watched.on("framenavigated", (frame) => {
        const url = frame.url();
        if (SCRIPT_URL.test(url)) {
          d.hit("navigation", `frame at ${url}`);
          return;
        }
        if (frame === watched.mainFrame()) {
          if (!d.expectedPages.has(watched) && !url.startsWith(allowedOrigins[0]!) && url !== "about:blank")
            d.hit("navigation", `tab left for ${url}`);
          return;
        }
        if (url === "about:srcdoc" || url === "about:blank" || allowedOrigins.some((o) => url.startsWith(o))) return;
        d.hit("navigation", `frame left for ${url}`);
      });
    };
    watch(page);
    context.on("page", (popup) => {
      if (d.pendingPages > 0) {
        d.pendingPages--;
        d.expectedPages.add(popup);
        return;
      }
      if (d.expectedPages.has(popup)) return;
      watch(popup);
      d.hit("navigation", `popup at ${popup.url()}`);
      void popup.close().catch(() => {});
    });
    await context.route("**/*", async (route) => {
      const request: Request = route.request();
      const url = request.url();
      if (url.startsWith("data:") || url.startsWith("blob:") || allowedOrigins.some((o) => url.startsWith(o)))
        return route.fallback();
      d.hit("request", `${request.method()} ${url}`);
      await route.abort("blockedbyclient");
    });
    return d;
  }

  hit(detector: Detector, detail: string): void {
    this.hits.push({ detector, detail: detail.slice(0, 300), where: this.where });
  }
  at(where: string): void {
    this.where = where;
  }
  /** Opens a page of the test's own (a top-level export): not a popup, and it may sit at any origin. */
  async newPage(context: BrowserContext): Promise<Page> {
    this.pendingPages++;
    const page = await context.newPage();
    this.expectedPages.add(page);
    return page;
  }

  /**
   * Sink and clobber scan of `frame`, plus its raw canary: an init script that did not reach the frame would
   * leave `window.__xss` a plain property. Returns whether the init script had armed the frame.
   */
  async scan(frame: Frame, owned: Readonly<Record<string, number>> = {}): Promise<boolean> {
    if (frame.isDetached()) return false;
    const found = await frame.evaluate(scanDocument, { names: [...CLOBBER_NAMES], owned });
    for (const f of found) this.hit(f.detector, f.detail);
    const raw = await frame.evaluate(() => ({
      armed: (window as unknown as { __g7Armed?: boolean }).__g7Armed === true,
      xss: (window as unknown as { __xss?: unknown }).__xss,
    }));
    if (raw.xss !== undefined) this.hit("canary", `raw window.__xss = ${String(raw.xss)}`);
    return raw.armed;
  }

  /** Click (activate) every link in `frame` that is not a same-document fragment, then scan it. */
  async clickLinks(frame: Frame, owned: Readonly<Record<string, number>> = {}): Promise<number> {
    if (frame.isDetached()) return 0;
    const count = await frame
      .evaluate(() => {
        const links = [...document.querySelectorAll("a, area")].filter((link) => {
          const href = link.getAttribute("href") ?? link.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "";
          return href !== "" && !href.startsWith("#");
        });
        for (const link of links) {
          if (link instanceof HTMLElement) link.click();
          else link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        }
        return links.length;
      })
      .catch(() => 0);
    await this.page.waitForTimeout(count > 0 ? 300 : 0);
    if (!frame.isDetached()) await this.scan(frame, owned).catch(() => false);
    return count;
  }

  counts(filter?: (hit: Hit) => boolean): Record<Detector, number> {
    const out = Object.fromEntries(DETECTORS.map((d) => [d, 0])) as Record<Detector, number>;
    for (const h of this.hits) if (filter === undefined || filter(h)) out[h.detector]++;
    return out;
  }
}
