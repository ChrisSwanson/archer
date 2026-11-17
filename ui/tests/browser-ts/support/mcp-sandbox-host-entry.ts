/**
 * The host side of `mcp-sandbox-host.ts`, bundled for the browser: the official MCP Apps `AppBridge`
 * (`@modelcontextprotocol/ext-apps/app-bridge`), as a host embeds it, talking to the double-iframe sandbox
 * proxy over `PostMessageTransport`. Nothing of Archer's is in here: the app is the resource's own HTML,
 * handed to the proxy in `ui/notifications/sandbox-resource-ready`.
 *
 * The test drives it through `window.g7Host`; what the view asks of the host (tool calls, links, messages,
 * model context) goes back to the test through the bindings `g7CallTool` and `g7HostEvent`.
 */
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

type Csp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};
type StartOptions = {
  proxyUrl: string;
  resourceUrl: string;
  sandbox: string;
  csp?: Csp;
  permissions?: Record<string, unknown>;
};
type Bindings = {
  g7CallTool(params: unknown): Promise<unknown>;
  g7HostEvent(kind: string, detail: string): Promise<void>;
};

const bindings = window as unknown as Bindings;
let bridge: AppBridge | undefined;

async function start(options: StartOptions): Promise<void> {
  const html = await (await fetch(options.resourceUrl, { cache: "no-store" })).text();
  const outer = document.createElement("iframe");
  outer.id = "proxy";
  outer.title = "MCP App";
  // The outer frame: another origin, scripts and its own origin (the proxy must post to its inner frame).
  outer.setAttribute("sandbox", "allow-scripts allow-same-origin");
  document.body.append(outer);

  const app = new AppBridge(
    null,
    { name: "archer-g7-host", version: "0" },
    {
      openLinks: {},
      serverTools: {},
      logging: {},
      updateModelContext: { text: {}, structuredContent: {} },
      message: { text: {} },
      sandbox: { csp: options.csp ?? {}, permissions: options.permissions ?? {} },
    },
    { hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline"], platform: "web" } },
  );
  app.oncalltool = async (params) => (await bindings.g7CallTool(params)) as never;
  app.onopenlink = async ({ url }) => {
    await bindings.g7HostEvent("open-link", url);
    return {};
  };
  app.onmessage = async (params) => {
    await bindings.g7HostEvent("message", JSON.stringify(params).slice(0, 400));
    return {};
  };
  app.onupdatemodelcontext = async (params) => {
    await bindings.g7HostEvent("update-model-context", JSON.stringify(params).slice(0, 400));
    return {};
  };
  app.ondownloadfile = async (params) => {
    await bindings.g7HostEvent("download-file", JSON.stringify(params).slice(0, 400));
    return {};
  };
  app.onrequestdisplaymode = async ({ mode }) => {
    await bindings.g7HostEvent("display-mode", String(mode));
    return { mode: "inline" };
  };
  app.addEventListener("sandboxready", () => {
    void app.sendSandboxResourceReady({
      html,
      sandbox: options.sandbox,
      csp: options.csp,
      permissions: options.permissions as never,
    });
  });
  app.addEventListener("initialized", () => {
    void bindings.g7HostEvent("initialized", "");
  });
  app.addEventListener("loggingmessage", (params) => {
    void bindings.g7HostEvent("log", JSON.stringify(params).slice(0, 400));
  });
  await app.connect(new PostMessageTransport(outer.contentWindow!, outer.contentWindow!));
  bridge = app;
  outer.src = options.proxyUrl;
}

(window as unknown as { g7Host: unknown }).g7Host = {
  start,
  toolInput: (args: Record<string, unknown>) => bridge!.sendToolInput({ arguments: args }),
  toolResult: (result: Record<string, unknown>) => bridge!.sendToolResult(result as never),
};
