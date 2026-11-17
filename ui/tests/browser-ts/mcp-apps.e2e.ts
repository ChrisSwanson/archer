import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpHost } from "./support/mcp-host";
const base = resolve(import.meta.dirname, "../../../ts");
const load = async (p: string) => import(/* @vite-ignore */ pathToFileURL(resolve(base, p)).href);
const MIME = "text/html;profile=mcp-app";

/** Follow Apps resource-domain mapping. With no worker-src, workers inherit script-src. */
function policy(csp: {
  resourceDomains?: string[];
  connectDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
}): string {
  const domains = csp.resourceDomains?.join(" ") ?? "";
  return `default-src 'none'; script-src 'unsafe-inline' ${domains}; style-src 'unsafe-inline' ${domains}; img-src data: ${domains}; font-src data: ${domains}; media-src ${domains || "'none'"}; connect-src ${csp.connectDomains?.join(" ") || "'none'"}; frame-src ${csp.frameDomains?.join(" ") || "'none'"}; base-uri ${csp.baseUriDomains?.join(" ") || "'self'"}`;
}

for (const outputFormat of ["json", "text"])
  test(`standard MCP App renders, clears emphasis and publishes selection with ${outputFormat} output`, async ({
    page,
  }) => {
    const { connect, tempDir, removeTempDirs, FLOW } = await load("test/mcp/support.ts");
    const { startService } = await load("src/service/service.ts");
    const { connectService } = await load("src/service/service-client.ts");
    const home = tempDir({ "instance.archer.toml": "version = 1\n" });
    const svc = await startService({
      forceHttp: true,
      stateDir: tempDir(),
      env: {
        HOME: home,
        XDG_CONFIG_HOME: resolve(home, ".config"),
        ARCHER_CONFIG: resolve(home, "instance.archer.toml"),
        ARCHER_OPEN_BROWSER: "never",
      },
      log: () => {},
    });
    const { client, close } = await connect(
      {
        cwd: tempDir({ ".archer/arch.mmd": FLOW }),
        ensureService: () => connectService(svc.socketPath),
        uiHtml: () => readFileSync(resolve(import.meta.dirname, "../../dist/mcp/index.html"), "utf8"),
      },
      { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MIME] } } },
    );
    let host: McpHost | undefined;
    try {
      const resource = (await client.readResource({ uri: "ui://archer/diagram" })).contents[0];
      const csp = resource._meta.ui.csp;
      const violations: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") violations.push(message.text());
      });
      host = await McpHost.open(page, {
        html: resource.text.replace(
          /<head>/i,
          `<head><meta http-equiv="Content-Security-Policy" content="${policy(csp)}">`,
        ),
        callTool: (params) => client.callTool(params),
      });
      const present = await client.callTool({ name: "present_diagram", arguments: { viewId: "arch", outputFormat } });
      await host.deliver(present);
      const customer = host.view.locator('.react-flow__node[data-id="a"]');
      await expect(customer, violations.join("\n")).toBeVisible();
      const bounds = await customer.boundingBox();
      expect(bounds?.width).toBeGreaterThan(10);
      expect(bounds?.height).toBeGreaterThan(10);
      await host.view.getByRole("button", { name: "Select mode", exact: true }).click();
      await customer.click();
      await expect
        .poll(async () =>
          (
            await client.callTool({ name: "get_presentation_context", arguments: {} })
          ).structuredContent.selection?.nodes.map((node: { id: string }) => node.id),
        )
        .toEqual(["a"]);
      expect(
        (await host.requests()).some(
          (request) => request.method === "tools/call" && (request.params as { name: string }).name === "set_selection",
        ),
      ).toBe(true);
      await host.deliver(
        await client.callTool({
          name: "set_emphasis",
          arguments: {
            viewId: "arch",
            id: "focus",
            title: "Customer focus",
            outputFormat,
            groups: [{ id: "customer", label: "customer", nodes: ["a"], edges: [], style: "highlight" }],
          },
        }),
      );
      await expect(customer).toHaveClass(/archer-emph-style-highlight/);
      await expect(host.view.getByText("Customer focus", { exact: true })).toBeVisible();
      await host.deliver(
        await client.callTool({
          name: "set_emphasis",
          arguments: { viewId: "arch", id: "focus", outputFormat, groups: [] },
        }),
      );
      await expect(customer).not.toHaveClass(/archer-emph-style-highlight/);
      await expect(host.view.getByText("Customer focus", { exact: true })).toHaveCount(0);
      expect(violations.filter((message) => /Content Security Policy|worker.*violat/i.test(message))).toEqual([]);
    } finally {
      host?.stop();
      await close();
      await svc.close();
      removeTempDirs();
    }
  });
