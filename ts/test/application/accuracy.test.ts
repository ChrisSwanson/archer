import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { main } from "../../src/bin/main.ts";
import { connect, call, structured } from "../mcp/support.ts";
import { findProject } from "../../src/project/index.ts";
import { cleanup, repo, manifest, FLOW, commit, write } from "../accuracy/support.ts";

afterEach(cleanup);

test("Git operations expose identical core outcomes through API, MCP and CLI", async () => {
  const cwd = repo({ "archer.toml": manifest(), ".archer/flow.mmd": FLOW, "src/app.ts": "old" });
  const from = commit(cwd);
  write(cwd, ".archer/flow.mmd", FLOW.replace("Client", "Browser"));
  const to = commit(cwd);
  write(cwd, "src/app.ts", "new");
  const app = createApplication({ cwd });
  const mcp = await connect({ cwd });
  try {
    for (const [name, args, expected] of [
      ["list_stale_diagrams", {}, { views: [{ viewId: "flow", status: "stale", baselineCommit: to }] }],
      ["read_diagram_at_commit", { viewId: "flow", commit: from }, { status: "compiled", source: { text: FLOW } }],
      [
        "compare_diagrams",
        { viewId: "flow", from, to },
        { sourceChanged: true, semantic: { status: "compared", changes: [{ key: "node:a", status: "changed" }] } },
      ],
    ] as const) {
      const result = await app.call(name, args);
      expect(result.structured).toMatchObject(expected);
      expect(structured(await call(mcp.client, name, args))).toEqual(result.structured);
      let out = "",
        err = "";
      expect(
        await main(["call", name, "--stdin", "--json"], {
          cwd,
          env: {},
          isTTY: false,
          columns: undefined,
          stdin: async () => JSON.stringify(args),
          stdout: (s) => (out += s),
          stderr: (s) => (err += s),
        }),
        err,
      ).toBe(0);
      expect(JSON.parse(out)).toEqual(result.structured);
      expect(JSON.stringify(result.structured)).not.toContain('"sourceBytes"');
      const readable = await call(mcp.client, name, { ...args, outputFormat: "text" });
      expect(readable.structuredContent).toBeUndefined();
      expect(readable.content).toEqual([
        { type: "text", text: (await app.call(name, { ...args, outputFormat: "text" })).text },
      ]);
    }
  } finally {
    app.close();
    await mcp.close();
  }
}, 15_000); // API, MCP and CLI against real Git: 1.3 s idle, 2.2 s under CPU load, 4.9 s beside the UI and browser jobs; timed out at 5 s on CI

test("register preserves existing coverage and can explicitly replace or clear it", async () => {
  const cwd = repo({ "archer.toml": manifest(), ".archer/flow.mmd": FLOW });
  const app = createApplication({ cwd });
  try {
    await app.call("register_diagram", { sourcePath: "flow.mmd", title: "Renamed" });
    expect(findProject(cwd).views[0]?.covers).toEqual(["src/**"]);
    await app.call("register_diagram", { sourcePath: "flow.mmd", covers: ["lib/**"] });
    expect(findProject(cwd).views[0]?.covers).toEqual(["lib/**"]);
    await app.call("register_diagram", { sourcePath: "flow.mmd", covers: [] });
    expect(findProject(cwd).views[0]?.covers).toEqual([]);
  } finally {
    app.close();
  }
});
