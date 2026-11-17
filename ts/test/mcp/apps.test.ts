import { afterEach, expect, test } from "vitest";
import { connect, call, structured, FLOW, removeTempDirs, tempDir } from "./support.ts";

import { startService } from "../../src/service/service.ts";
import { connectService } from "../../src/service/service-client.ts";
afterEach(removeTempDirs);
const URI = "ui://archer/diagram";
const MIME = "text/html;profile=mcp-app";

test("the MCP adapter advertises its shared diagram app on visual tools", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  try {
    const { tools } = await client.listTools();
    for (const name of ["present_diagram", "set_emphasis"]) {
      expect(tools.find((tool) => tool.name === name)?._meta).toMatchObject({
        ui: { resourceUri: URI },
        "ui/resourceUri": URI,
      });
    }
    expect(tools.find((tool) => tool.name === "write_diagram")?._meta).toBeUndefined();
  } finally {
    await close();
  }
});

test("MCP Apps resource supplies the actual standalone page with deny-default network policy", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  try {
    expect((await client.listResources()).resources).toContainEqual(
      expect.objectContaining({ uri: URI, mimeType: MIME }),
    );
    const { contents } = await client.readResource({ uri: URI });
    expect((contents[0] as { text: string }).text.slice(0, 100).toLowerCase()).toContain("<!doctype html>");
    const { text: _html, ...metadata } = contents[0] as { text: string; [key: string]: unknown };
    expect(metadata).toMatchObject({
      uri: URI,
      mimeType: MIME,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: ["blob:"], frameDomains: [], baseUriDomains: [] } } },
    });
  } finally {
    await close();
  }
});

test.each([true, false])("presentation negotiates the actual client capability: embedded=%s", async (embedded) => {
  const opened: string[] = [];
  const state = tempDir();
  const svc = await startService({
    forceHttp: true,
    stateDir: state,
    env: { HOME: state, DISPLAY: ":99" },
    browserOpener: async (url) => {
      opened.push(url);
    },
    log: () => {},
  });
  const { client, close } = await connect(
    { cwd: tempDir({ ".archer/arch.mmd": FLOW }), ensureService: () => connectService(svc.socketPath) },
    embedded ? { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MIME] } } } : {},
  );
  try {
    const result = structured(await call(client, "present_diagram", { viewId: "arch" }));
    expect(result.ui).toMatchObject(embedded ? { mode: "mcp-app", resourceUri: URI } : { mode: "http" });
    expect(opened.length).toBe(embedded ? 0 : 1);
  } finally {
    await close();
    await svc.close();
  }
});

test("embedded emphasis tool results carry the whole authoritative snapshot after replacement and clear", async () => {
  const state = tempDir();
  const svc = await startService({
    forceHttp: true,
    stateDir: state,
    env: { HOME: state, ARCHER_OPEN_BROWSER: "never" },
    log: () => {},
  });
  const { client, close } = await connect(
    { cwd: tempDir({ ".archer/arch.mmd": FLOW }), ensureService: () => connectService(svc.socketPath) },
    { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MIME] } } },
  );
  try {
    const group = { id: "customer", label: "customer", style: "highlight", nodes: ["a"], edges: [] };
    await call(client, "set_emphasis", { id: "first", viewId: "arch", groups: [group] });
    const second = structured(await call(client, "set_emphasis", { id: "second", viewId: "arch", groups: [group] }));
    expect(second).toMatchObject({ schemaVersion: 1, viewId: "arch", emphases: [{ id: "first" }, { id: "second" }] });
    const cleared = structured(await call(client, "set_emphasis", { id: "second", viewId: "arch", groups: [] }));
    expect(cleared).toMatchObject({ schemaVersion: 1, viewId: "arch", emphases: [{ id: "first" }] });
  } finally {
    await close();
    await svc.close();
  }
});

test("explicit text visual output keeps private UI data without model-visible duplication", async () => {
  const state = tempDir();
  const svc = await startService({
    forceHttp: true,
    stateDir: state,
    env: { HOME: state, ARCHER_OPEN_BROWSER: "never" },
    log: () => {},
  });
  const { client, close } = await connect(
    { cwd: tempDir({ ".archer/arch.mmd": FLOW }), ensureService: () => connectService(svc.socketPath) },
    { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MIME] } } },
  );
  try {
    const presented = await call(client, "present_diagram", { viewId: "arch", outputFormat: "text" });
    expect(presented.structuredContent).toBeUndefined();
    expect(presented._meta?.["archer/ui"]).toMatchObject({
      envelope: { view: { id: "arch" } },
      ui: { mode: "mcp-app" },
    });
    const emphasized = await call(client, "set_emphasis", {
      viewId: "arch",
      id: "focus",
      groups: [],
      outputFormat: "text",
    });
    expect(emphasized.structuredContent).toBeUndefined();
    expect(emphasized._meta?.["archer/ui"]).toMatchObject({ viewId: "arch", emphases: [] });
  } finally {
    await close();
    await svc.close();
  }
});
