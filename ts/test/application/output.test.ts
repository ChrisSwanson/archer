import { afterEach, expect, test } from "vitest";
import { connect, call, FLOW, tempDir, removeTempDirs } from "../mcp/support.ts";
import { main, type Io } from "../../src/bin/main.ts";
afterEach(removeTempDirs);
test("explicit MCP text output is readable without a duplicated structured model", async () => {
  const mcp = await connect({ cwd: tempDir({ ".archer/flow.mmd": FLOW }) });
  try {
    const result = await call(mcp.client, "read_diagram", { viewId: "flow", outputFormat: "text" });
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result.content)).toContain("Client");
    expect(JSON.stringify(result.content)).toContain("e1");
  } finally {
    await mcp.close();
  }
});
test("CLI explicit text format executes the same readable operation", async () => {
  let out = "",
    err = "";
  const io: Io = {
    cwd: tempDir({ ".archer/flow.mmd": FLOW }),
    env: { ARCHER_SOCKET: "/tmp/archer-output-tests-never-running.sock" },
    isTTY: false,
    columns: undefined,
    stdout: (value) => (out += value),
    stderr: (value) => (err += value),
    stdin: async () => JSON.stringify({ viewId: "flow" }),
  };
  const status = await main(["call", "read_diagram", "--stdin", "--format", "text"], io);
  expect(status, err).toBe(0);
  expect(out).toContain("Client");
  expect(out).toContain("e1");
});

test("invalid format values refuse every operation before service acquisition", async () => {
  const { createApplication, OPERATIONS } = await import("../../src/application/index.ts");
  let acquisitions = 0;
  const app = createApplication({
    cwd: tempDir(),
    ensureService: async () => {
      acquisitions++;
      throw new Error("must not start");
    },
    findService: async () => {
      acquisitions++;
      return null;
    },
  });
  try {
    for (const operation of OPERATIONS)
      for (const outputFormat of [null, false, "yaml", [], {}])
        await expect(app.call(operation.name, { outputFormat })).rejects.toMatchObject({
          data: { code: "invalid_arguments" },
        });
    expect(acquisitions).toBe(0);
  } finally {
    app.close();
  }
});

test("default MCP JSON and explicit CLI JSON retain the complete source", async () => {
  const cwd = tempDir({ ".archer/flow.mmd": FLOW });
  const mcp = await connect({ cwd });
  try {
    const result = await call(mcp.client, "read_diagram", { viewId: "flow" });
    expect(result.structuredContent).toMatchObject({ source: { text: FLOW } });
    const readable = await call(mcp.client, "read_diagram", { viewId: "flow", outputFormat: "text" });
    const expectedText = (readable.content as { text: string }[]).map((item) => item.text).join("\n");
    const { createApplication } = await import("../../src/application/index.ts");
    const app = createApplication({ cwd });
    try {
      expect((await app.call("read_diagram", { viewId: "flow", outputFormat: "text" })).text).toBe(expectedText);
    } finally {
      app.close();
    }
    let human = "";
    expect(
      await main(["call", "read_diagram", "--stdin", "--format", "text"], {
        cwd,
        env: { ARCHER_SOCKET: "/tmp/archer-output-tests-never-running.sock" },
        isTTY: false,
        columns: undefined,
        stdout: (v) => (human += v),
        stderr: () => {},
        stdin: async () => JSON.stringify({ viewId: "flow" }),
      }),
    ).toBe(0);
    expect(human).toBe(expectedText + "\n");
    for (const flag of [["--json"], ["--format", "json"]]) {
      let out = "",
        err = "";
      const status = await main(["call", "read_diagram", "--stdin", ...flag], {
        cwd,
        env: { ARCHER_SOCKET: "/tmp/archer-output-tests-never-running.sock" },
        isTTY: false,
        columns: undefined,
        stdout: (v) => (out += v),
        stderr: (v) => (err += v),
        stdin: async () => JSON.stringify({ viewId: "flow" }),
      });
      expect(status, err).toBe(0);
      expect(JSON.parse(out)).toEqual(result.structuredContent);
    }
  } finally {
    await mcp.close();
  }
});

test("readable projection limits cannot report a completed presentation as failed", async () => {
  const { createApplication } = await import("../../src/application/index.ts");
  const { connectService } = await import("../../src/service/client.ts");
  const { service, cleanUp } = await import("../service/support.ts");
  const source = "sequenceDiagram\nparticipant A as Reader\n" + "A->>A: message\n".repeat(1500);
  const cwd = tempDir({ ".archer/large.mmd": source });
  const { svc } = await service();
  const app = createApplication({
    cwd,
    ensureService: () => connectService(svc.socketPath),
    findService: () => connectService(svc.socketPath),
  });
  try {
    const answer = await app.call("present_diagram", { viewId: "large", outputFormat: "text" });
    expect(answer.text).toContain("completed");
    expect(answer.text).toContain("readable_output_limit");
    expect(answer.text).toContain("do not retry");
    const context = await app.call("get_presentation_context");
    expect(context.structured.presentation).toMatchObject({ viewId: "large" });
    expect((answer.structured.envelope as { model: { events: unknown[] } }).model.events).toHaveLength(1500);
    expect(context.structured.presentation).toEqual(answer.structured.presentation);
  } finally {
    app.close();
    await cleanUp();
  }
}, 30000);
