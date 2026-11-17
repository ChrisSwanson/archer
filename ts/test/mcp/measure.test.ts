import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { call, connect, FLOW, refusal, removeTempDirs, structured, tempDir } from "./support.ts";

afterEach(removeTempDirs);

test("MCP advertises bounded read-only measure_diagram with source and nested state inputs", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  try {
    const tool = (await client.listTools()).tools.find((item) => item.name === "measure_diagram");
    expect(tool).toBeDefined();
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(tool?.inputSchema.properties).toMatchObject({
      source: { type: "string" },
      states: { type: "array", maxItems: 8 },
      viewport: { type: "object" },
      project: { type: "boolean" },
    });
  } finally {
    await close();
  }
});

test("MCP and local Application return identical geometry for the same exact source and state", async () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  const { client, close } = await connect({ cwd: root });
  const app = createApplication({ cwd: root });
  const args = { viewId: "flow", states: [{ mode: "full" }], viewport: { canvas: { width: 685, height: 696 } } };
  try {
    const local = await app.call("measure_diagram", args);
    const mcp = structured(await call(client, "measure_diagram", args));
    expect(mcp).toEqual(local.structured);
    expect(mcp).toMatchObject({ version: 1, status: "ready", complete: true });
  } finally {
    app.close();
    await close();
  }
});

test("MCP rejects more than eight states before loading a diagram", async () => {
  const { client, close } = await connect({ cwd: tempDir() });
  try {
    const error = await refusal(client, "measure_diagram", {
      viewId: "absent",
      states: Array.from({ length: 9 }, () => ({ mode: "full" })),
    });
    expect(error.data.code).toBe("invalid_arguments");
    expect(error.message).toMatch(/states.*8/);
  } finally {
    await close();
  }
});

test("candidate measurements keep exact candidate revisions separate from saved source", async () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  const { client, close } = await connect({ cwd: root });
  try {
    const saved = structured(await call(client, "measure_diagram", { viewId: "flow", states: [{ mode: "full" }] }));
    const candidate = structured(
      await call(client, "measure_diagram", {
        viewId: "flow",
        source: FLOW.replace("Client", "Candidate Client"),
        expectedRevision: saved.sourceRevision,
        states: [{ mode: "full" }],
      }),
    );
    expect(candidate.basis).toBe("candidate-source");
    expect(candidate.sourceRevision).not.toBe(saved.sourceRevision);
    expect(candidate.modelRevision).toBe(candidate.sourceRevision);
  } finally {
    await close();
  }
});

test("explicit framing reservations survive the MCP operation contract", async () => {
  const { client, close } = await connect({ cwd: tempDir({ ".archer/flow.mmd": FLOW }) });
  try {
    const report = structured(
      await call(client, "measure_diagram", {
        viewId: "flow",
        states: [{ mode: "full" }],
        viewport: { canvas: { width: 1025, height: 896 }, reserveHeading: true, reserveLegend: true },
      }),
    );
    expect(report).toMatchObject({
      status: "ready",
      viewport: { basis: "explicit", reserveHeading: true, reserveLegend: true },
    });
  } finally {
    await close();
  }
});

test.each(["standalone", "unpinned-note"] as const)(
  "cached explicit measurement retains exact revision metadata across MCP and Application for %s",
  async (kind) => {
    const { LayoutPool } = await import("../../src/measurement/pool.ts");
    const pool = new LayoutPool();
    const root = tempDir(
      kind === "standalone"
        ? { ".archer/flow.mmd": FLOW }
        : { ".archer/notes/story.md": `# Figure\n\n\`\`\`mermaid\n${FLOW}\`\`\`\n` },
    );
    const app = createApplication({ cwd: root, layoutPool: pool });
    const { client, close } = await connect({ cwd: root, layoutPool: pool });
    try {
      const listed = await app.call("list_diagrams");
      const viewId = kind === "standalone" ? "flow" : (listed.structured.embedded as { address: string }[])[0]!.address;
      const read = await app.call("read_diagram", { viewId });
      const args = { viewId, expectedRevision: read.structured.sourceRevision, states: [{ mode: "full" }] };
      const cold = await app.call("measure_diagram", args);
      expect(cold.structured).toMatchObject({
        status: "ready",
        sourceRevision: read.structured.sourceRevision,
        modelRevision: read.structured.modelRevision,
      });
      expect(cold.structured.modelRevision).toEqual(expect.any(String));
      const cached = structured(await call(client, "measure_diagram", args));
      expect(cached).toEqual(cold.structured);
      expect(pool.stats).toMatchObject({ started: 1, cached: 1 });
    } finally {
      app.close();
      await close();
      pool.close();
    }
  },
);
