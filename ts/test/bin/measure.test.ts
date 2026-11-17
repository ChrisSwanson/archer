import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { afterEach, expect, test } from "vitest";
import { revisionOf } from "../../src/project/index.ts";
import { main, type Io } from "../../src/bin/main.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);
const heartbeat = readFileSync(new URL("../fixtures/layout/heartbeat-lr.mmd", import.meta.url), "utf8");

async function run(cwd: string, args: string[]) {
  let out = "",
    err = "";
  const io: Io = {
    cwd,
    env: { ARCHER_SOCKET: join(cwd, "absent.sock"), ARCHER_STATE_DIR: join(cwd, "state") },
    isTTY: false,
    columns: undefined,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  };
  const code = await main(args, io);
  return { code, out, err };
}

test("measure resolves a diagram file offline and returns reading geometry as one JSON value", async () => {
  const root = tempDir({ ".archer/diagrams/flow.mmd": FLOW });
  const result = await run(root, ["measure", ".archer/diagrams/flow.mmd", "--json"]);
  expect(result.code, result.err).toBe(0);
  const data = JSON.parse(result.out);
  expect(data).toMatchObject({ version: 1, status: "ready", viewId: "flow", basis: "saved-source", complete: true });
  expect(data.states).toHaveLength(1);
  expect(data.states[0]).toMatchObject({ mode: "full", open: null });
  expect(data.states[0].bounds.width).toBeGreaterThan(0);
  expect(data.states[0].spanScreens.x).toBeGreaterThan(0);
  expect(result.out.trimEnd().split("\n")).toHaveLength(1);
  expect(existsSync(join(root, "state", "archer.lock"))).toBe(false);
});

test("measure passes candidate bytes and explicit canvas without writing the source", async () => {
  const candidate = FLOW.replace("Client", "Candidate Client");
  const root = tempDir({ ".archer/flow.mmd": FLOW, "candidate.mmd": candidate });
  const result = await run(root, [
    "measure",
    "flow",
    "--source",
    "candidate.mmd",
    "--states",
    "full",
    "--canvas",
    "685x696",
    "--json",
  ]);
  expect(result.code, result.err).toBe(0);
  const data = JSON.parse(result.out);
  expect(data).toMatchObject({
    basis: "candidate-source",
    viewport: { canvas: { width: 685, height: 696 }, basis: "explicit" },
  });
  expect(data.sourceRevision).toBe(revisionOf(Buffer.from(candidate)));
  expect(data.sourceRevision).not.toBe(revisionOf(Buffer.from(FLOW)));
  expect(readFileSync(join(root, ".archer/flow.mmd"), "utf8")).toBe(FLOW);
});

test.each([
  [],
  ["flow", "other"],
  ["flow", "--states", "wrong"],
  ["flow", "--states", ""],
  ["flow", "--canvas", "0x896"],
  ["flow", "--canvas", "1025"],
  ["flow", "--open", "group"],
  ["flow", "--nested", "--states", "full"],
  ["flow", "--project"],
  ["--project", "--source", "candidate.mmd"],
])("measure refuses malformed flags %j before analysis", async (...args) => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  const result = await run(root, ["measure", ...(args as string[])]);
  expect(result.code, result.err).toBe(2);
});

test("measure resolves a named note figure and canonical selected nested state", async () => {
  const grouped = "flowchart LR\nsubgraph outer[Outer]\n a[Alpha]\n b[Beta]\n a link@--> b\nend\n";
  const root = tempDir({
    ".archer/notes/story.md": `# Story\n\n\`\`\`mermaid\n%% archer-id: grouped\n${grouped}\`\`\`\n`,
  });
  const result = await run(root, ["measure", "notes/story.md#grouped", "--nested", "--open", "outer", "--json"]);
  expect(result.code, result.err).toBe(0);
  const data = JSON.parse(result.out);
  expect(data).toMatchObject({
    viewId: "notes/story.md#grouped",
    status: "ready",
    states: [{ mode: "nested", open: ["outer"], route: "canonical-fresh" }],
  });
});

test("measure --project explicitly reports coverage including embedded figures and compile failures", async () => {
  const root = tempDir({
    ".archer/flow.mmd": FLOW,
    ".archer/broken.mmd": "flowchart LR\n  broken --> missing\n",
    ".archer/notes/story.md": `# Story\n\n\`\`\`mermaid\n%% archer-id: figure\n${FLOW}\`\`\`\n`,
  });
  const result = await run(root, ["measure", "--project", "--json"]);
  expect(result.code, result.err).toBe(0);
  const data = JSON.parse(result.out);
  expect(data).toMatchObject({
    version: 1,
    status: "partial",
    complete: false,
    coverage: { total: 3, measured: 2, unavailable: 1 },
  });
  expect(data.results.map((item: { viewId: string }) => item.viewId).sort()).toEqual([
    "broken",
    "flow",
    "notes/story.md#figure",
  ]);
  expect(data.results.find((item: { viewId: string }) => item.viewId === "broken")).toMatchObject({
    status: "unavailable",
    reason: "does_not_compile",
  });
  expect(existsSync(join(root, "state", "archer.lock"))).toBe(false);
});

test("validate --json preserves layout advice as a separate optional report and retains exit status", async () => {
  // Owner-requested strengthening: the old assertion accepted every possible review status.
  const root = tempDir({ ".archer/flow.mmd": heartbeat });
  const result = await run(root, ["validate", "flow", "--json"]);
  expect(result.code, result.err).toBe(0);
  const data = JSON.parse(result.out);
  expect(data).toMatchObject({ status: "ok", errors: 0, warnings: 0, diagnostics: [] });
  expect(data.layoutReview).toMatchObject({
    version: 1,
    sourceRevision: revisionOf(Buffer.from(heartbeat)),
    status: "ready",
    suggestions: [{ code: "layout_wide_at_reading_zoom" }],
  });
});

test.each(["validate", "write"])(
  "fresh-process %s delivers the LR tour heartbeat finding before teardown",
  async (operation) => {
    const root = tempDir({
      ".archer/diagrams/heartbeat.mmd": heartbeat,
      "candidate.mmd": heartbeat + "\n%% Candidate saved by the test\n",
      "write.json": JSON.stringify({ viewId: "heartbeat", expectedRevision: revisionOf(Buffer.from(heartbeat)) }),
    });
    const args =
      operation === "validate"
        ? ["validate", "heartbeat", "--json"]
        : ["call", "write_diagram", "--source", "candidate.mmd", "--file", "write.json", "--json"];
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(new URL("../../src/bin/archer.ts", import.meta.url)),
        ...args,
      ],
      {
        cwd: root,
        timeout: 15_000,
        env: {
          ...process.env,
          ARCHER_AUTO_START: "false",
          ARCHER_STATE_DIR: join(root, "state"),
          ARCHER_WRITERS_DIR: join(root, "writers"),
        },
      },
    );
    expect(stderr).toBe("");
    const data = JSON.parse(stdout);
    expect(data.status).toBe(operation === "validate" ? "ok" : "compiled");
    expect(data.layoutReview).toMatchObject({
      status: "ready",
      suggestions: [{ code: "layout_wide_at_reading_zoom" }],
    });
    if (operation === "validate") expect(data).toMatchObject({ errors: 0, warnings: 0, diagnostics: [] });
    else
      expect(readFileSync(join(root, ".archer/diagrams/heartbeat.mmd"), "utf8")).toBe(
        heartbeat + "\n%% Candidate saved by the test\n",
      );
  },
);

test("plain measure prints its summary once; --verbose and --json expose complete fields", async () => {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  const plain = await run(root, ["measure", "flow"]);
  expect(plain.code, plain.err).toBe(0);
  expect(plain.out).toContain("Layout measurement ready");
  expect(plain.out).toContain("Full:");
  expect(plain.out).not.toMatch(/^states |^viewport |^version |^engineVersion /m);
  const verbose = await run(root, ["measure", "flow", "--verbose"]);
  expect(verbose.code, verbose.err).toBe(0);
  expect(verbose.out).toMatch(/^states /m);
  const json = await run(root, ["measure", "flow", "--json"]);
  expect(JSON.parse(json.out)).toMatchObject({ status: "ready", states: [{ mode: "full" }] });
});

test("validate --json cannot attach last-good geometry to a failed current source", async () => {
  const root = tempDir({ ".archer/flow.mmd": "flowchart LR\n a[A] --> b[B]\n" });
  const result = await run(root, ["validate", "flow", "--json"]);
  expect(result.code, result.err).toBe(1);
  const data = JSON.parse(result.out);
  expect(data.errors).toBeGreaterThan(0);
  expect(data.layoutReview).toMatchObject({ status: "unavailable", reason: "does_not_compile" });
});
