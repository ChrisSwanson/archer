import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { main, type Io } from "../../src/bin/main.ts";
import { connectService } from "../../src/service/client.ts";
import { call, connect, structured } from "../mcp/support.ts";
import { apiBase, cleanUp, ownerFetch, project, service, write, BROKEN } from "../service/support.ts";
afterEach(cleanUp);

test("export shares exact SVG results across API, MCP, CLI and browser operations", async () => {
  const root = project(),
    { svc } = await service({ env: { ARCHER_OPEN_BROWSER: "never" } });
  const options = {
    cwd: root,
    ensureService: () => connectService(svc.socketPath),
    findService: () => connectService(svc.socketPath),
  };
  const app = createApplication(options),
    mcp = await connect(options);
  try {
    await app.call("present_diagram", { viewId: "flow", annotation: "Exported caption" });
    await app.call("set_emphasis", {
      viewId: "flow",
      id: "held",
      groups: [{ id: "a", label: "a", nodes: ["a"], edges: ["e1"], style: "highlight" }],
    });
    const args = { viewId: "flow", format: "svg", mode: "presentation", theme: "light", activeEmphasisId: "held" };
    const api = await app.call("export_diagram", args);
    expect(api.structured).toMatchObject({
      mimeType: "image/svg+xml",
      encoding: "base64",
      lastGood: false,
      activeEmphasisId: "held",
    });
    const svg = Buffer.from(String(api.structured.data), "base64").toString("utf8");
    expect(svg).toContain("Exported caption");
    expect(svg).toContain("SIL OPEN FONT LICENSE");
    expect(structured(await call(mcp.client, "export_diagram", args))).toEqual(api.structured);
    let out = "",
      err = "";
    const io: Io & { stdin: () => Promise<string> } = {
      cwd: root,
      env: { ARCHER_SOCKET: svc.socketPath },
      isTTY: false,
      columns: undefined,
      stdout: (text) => (out += text),
      stderr: (text) => (err += text),
      stdin: async () => JSON.stringify(args),
    };
    expect(await main(["call", "export_diagram", "--stdin", "--json"], io), err).toBe(0);
    expect(JSON.parse(out)).toEqual(api.structured);
    const url = String((await app.call("get_ui_url")).structured.url);
    const response = await ownerFetch(apiBase(url) + "api/operations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "export_diagram", arguments: args }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(api.structured);
    const text = await app.call("export_diagram", { ...args, outputFormat: "text" });
    expect(text.text).not.toContain(String(api.structured.data));
    expect(text.text).toContain("SVG");
  } finally {
    app.close();
    await mcp.close();
  }
}, 15_000); // exports through API, MCP, CLI and HTTP: 1.1 s idle, 5.1 s (timed out) beside the UI and browser jobs

test("export requires explicit last-good consent and preserves current-source diagnostics", async () => {
  const root = project(),
    { svc } = await service();
  const app = createApplication({
    cwd: root,
    findService: () => connectService(svc.socketPath),
    ensureService: () => connectService(svc.socketPath),
  });
  try {
    const current = await app.call("read_diagram", { viewId: "flow" });
    write(root, ".archer/flow.mmd", BROKEN);
    await expect(app.call("export_diagram", { viewId: "flow" })).rejects.toMatchObject({
      data: { code: "export_last_good_requires_opt_in" },
    });
    const accepted = await app.call("export_diagram", { viewId: "flow", allowLastGood: true, format: "png" });
    expect(accepted.structured).toMatchObject({
      mimeType: "image/png",
      lastGood: true,
      revision: current.structured.modelRevision,
      sourceRevision: expect.any(String),
      diagnostics: expect.any(Array),
    });
    expect((accepted.structured.diagnostics as unknown[]).length).toBeGreaterThan(0);
    expect(Buffer.from(String(accepted.structured.data), "base64").subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await expect(
      app.call("export_diagram", { viewId: "flow", allowLastGood: true, expectedRevision: `sha256:${"0".repeat(64)}` }),
    ).rejects.toMatchObject({ data: { code: "revision_conflict" } });
  } finally {
    app.close();
  }
});
