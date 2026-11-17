/**
 * A minimal MCP Apps host, so the EMBEDDED shell runs in a real browser.
 *
 * The rest of the suite opens the page the server serves over HTTP, which is
 * the web shell. An MCP host loads the MCP App build instead -- one file with
 * the MCP shell alone: no title bar, no tabs, no routes of its own -- and tells
 * it everything over `postMessage`. Nothing here stubs the bundle: it is
 * `ui/dist/mcp` (or the resource the server offers) loaded into an iframe by
 * `srcdoc`, and this page answers the handshake the SDK inside it makes and
 * hands it tool results.
 *
 * Tool results come from the official SDK in-memory client/server transport
 * in the Apps suite; the host forwards the actual result of `present_diagram`.
 *
 * What this is NOT: a host's sizing, fonts or sandbox. It is one iframe the
 * size of the window.
 */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page } from "@playwright/test";

/** How long the embedded page may take to start: setup, not an assertion. */
const BOOT = 30_000;

/** An MCP tool result, as `present_diagram` returns it. */
export type ToolResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: { type: string; text?: string }[];
};
type Design = "current";
type Scheme = "light" | "dark";

const BUNDLE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../dist/mcp/index.html");

const HOST_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>MCP Apps test host</title>
<style>html, body { margin: 0; height: 100%; overflow: hidden; } iframe { display: block; width: 100vw; height: 100vh; border: 0; }</style>
<iframe id="view" title="Archer"></iframe>
<script>
  const frame = document.getElementById("view");
  window.viewRequests = [];
  window.viewInitialized = false;
  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (event.source !== frame.contentWindow || message === null || typeof message !== "object") return;
    if (message.method === "ui/notifications/initialized") { window.viewInitialized = true; return; }
    if (message.id === undefined || message.method === undefined) return;
    const reply = (result) => frame.contentWindow.postMessage({ jsonrpc: "2.0", id: message.id, result }, "*");
    if (message.method === "ui/initialize") {
      reply({
        protocolVersion: message.params.protocolVersion,
        hostInfo: { name: "archer-browser-suite", version: "0" },
        hostCapabilities: { serverTools: {}, updateModelContext: { text: {}, structuredContent: {} } },
        hostContext: {},
      });
      return;
    }
    // Everything else the view asks for (a tool call, a context update) is
    // recorded and acknowledged, as a host that forwarded it would.
    window.viewRequests.push({ method: message.method, params: message.params });
    try {
      reply(message.method === "tools/call" && window.forwardTool ? await window.forwardTool(message.params) : message.method === "tools/call" ? { content: [] } : {});
    } catch (error) {
      frame.contentWindow.postMessage({jsonrpc: "2.0", id: message.id, error: {code: -32603, message: String(error)}}, "*");
    }
  });
  window.deliverToolResult = (result) =>
    frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result }, "*");
  fetch("bundle").then((response) => response.text()).then((html) => { frame.srcdoc = html; });
</script>`;

export class McpHost {
  private constructor(
    private readonly server: Server,
    private readonly page: Page,
  ) {}

  /** Opens the embedded shell in `page` and waits for its handshake. */
  static async open(
    page: Page,
    options: {
      design?: Design;
      scheme?: Scheme;
      viewport?: { width: number; height: number };
      html?: string;
      callTool?: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
    } = {},
  ): Promise<McpHost> {
    const server = createServer((request, response) => {
      const isBundle = request.url === "/bundle";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(isBundle ? (options.html ?? readFileSync(BUNDLE, "utf8")) : HOST_PAGE);
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const { port } = server.address() as { port: number };

    if (options.viewport !== undefined) {
      await page.setViewportSize(options.viewport);
    }
    await page.emulateMedia({ colorScheme: options.scheme ?? "light" });
    if (options.callTool !== undefined) await page.exposeFunction("forwardTool", options.callTool);
    await page.goto(`http://127.0.0.1:${port}/`);
    const host = new McpHost(server, page);
    // Startup is setup, with its own budget: the 2.9 MB inline bundle took 9 s to mount at 2x throttle under load,
    // most of the 10 s an assertion gets (O269).
    await expect(host.view.locator(".archer-mcp-shell")).toBeVisible({ timeout: BOOT });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { viewInitialized: boolean }).viewInitialized), {
        timeout: BOOT,
      })
      .toBe(true);
    return host;
  }

  /** The embedded page. */
  get view(): FrameLocator {
    return this.page.frameLocator("#view");
  }

  /** Hands the view a tool result, as a host does when the tool it rendered for returns. */
  async deliver(result: ToolResult): Promise<void> {
    await this.page.evaluate(
      (delivered) =>
        (window as unknown as { deliverToolResult: (result: unknown) => void }).deliverToolResult(delivered),
      result as unknown as Record<string, unknown>,
    );
  }

  /** Every request the view has made of the host, in order. */
  requests(): Promise<{ method: string; params: unknown }[]> {
    return this.page.evaluate(
      () => (window as unknown as { viewRequests: { method: string; params: unknown }[] }).viewRequests,
    );
  }

  stop(): void {
    this.server.closeAllConnections();
    this.server.close();
  }
}
