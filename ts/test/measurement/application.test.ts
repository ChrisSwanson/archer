import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { FLOW, BROKEN, tempDir, removeTempDirs } from "../project/support.ts";
import { readFileSync } from "node:fs";

const applications: ReturnType<typeof createApplication>[] = [];
afterEach(() => {
  for (const app of applications.splice(0)) app.close();
  removeTempDirs();
});
function application(files: Record<string, string> = { ".archer/flow.mmd": FLOW }) {
  const app = createApplication({
    cwd: tempDir(files),
    ensureService: () => {
      throw new Error("measurement must stay offline");
    },
  });
  applications.push(app);
  return app;
}

test("measurement displays the non-suggestion fit-text note in human output", async () => {
  const source = readFileSync(
    new URL("../../../examples/archer-tour/.archer/diagrams/comment-thread.mmd", import.meta.url),
    "utf8",
  );
  const app = application({ ".archer/thread.mmd": source });
  const measured = await app.call("measure_diagram", { viewId: "thread", outputFormat: "text" });
  expect(measured.structured.suggestions).toEqual([]);
  expect(measured.text).toContain(
    "Layout note: Full view: smallest text at fit is 6.19px, below the 12px reading floor. Zoom in to read the text.",
  );
});

test("authoring attaches bounded non-blocking layout review without replacing rename suggestions", async () => {
  const app = application();
  const checked = await app.call("validate_diagram", { viewId: "flow", source: FLOW, suggest: true });
  expect(checked.structured.valid).toBe(true);
  expect(checked.structured.suggestions).toEqual([]);
  expect(checked.structured.layoutReview).toMatchObject({
    version: 1,
    profile: "desktop-1025x896-gutter24",
    sourceRevision: checked.structured.revision,
  });
  expect(["ready", "pending"]).toContain((checked.structured.layoutReview as { status: string }).status);
  const read = await app.call("read_diagram", { viewId: "flow" });
  const written = await app.call("write_diagram", {
    viewId: "flow",
    source: FLOW,
    expectedRevision: read.structured.sourceRevision,
  });
  expect(written.structured.status).toBe("unchanged");
  expect(written.structured.layoutReview).toMatchObject({ sourceRevision: written.structured.sourceRevision });
});

test("failed current source has unavailable geometry, never the last good drawing", async () => {
  const app = application();
  await app.call("read_diagram", { viewId: "flow" });
  const checked = await app.call("validate_diagram", { viewId: "flow", source: BROKEN });
  expect(checked.structured.valid).toBe(false);
  expect(checked.structured.layoutReview).toMatchObject({ status: "unavailable", reason: "does_not_compile" });
  const measured = await app.call("measure_diagram", { viewId: "flow", source: BROKEN });
  expect(measured.structured).toMatchObject({
    status: "unavailable",
    complete: false,
    reason: "does_not_compile",
    basis: "candidate-source",
    states: [],
  });
});

test("explicit measurement returns revision-bound source facts and candidate inspection keeps bytes", async () => {
  const app = application();
  const measured = await app.call("measure_diagram", { viewId: "flow" });
  expect(measured.structured).toMatchObject({
    version: 1,
    status: "ready",
    complete: true,
    basis: "saved-source",
    viewId: "flow",
    presentation: { mode: "source", revision: null },
  });
  expect(measured.structured.sourceRevision).toBe(measured.structured.modelRevision);
  expect((measured.structured.states as { bounds: { width: number } }[])[0]!.bounds.width).toBeGreaterThan(0);
  const source = FLOW.replace("Client", "Candidate client");
  const checked = await app.call("validate_diagram", { viewId: "flow", source });
  expect(checked.structured.layoutReview).toMatchObject({
    inspect: { tool: "measure_diagram", arguments: { viewId: "flow", source } },
  });
  await expect(
    app.call("measure_diagram", { viewId: "flow", expectedRevision: `sha256:${"0".repeat(64)}` }),
  ).rejects.toMatchObject({ data: { code: "revision_conflict" } });
});

test("explicit project measurement covers admitted standalone and note diagrams and reports invalid sources", async () => {
  const app = application({
    ".archer/flow.mmd": FLOW,
    ".archer/broken.mmd": BROKEN,
    ".archer/notes/explanation.md": `# Example\n\n\`\`\`mermaid\n%% archer-id: named\n${FLOW}\`\`\`\n`,
  });
  const measured = await app.call("measure_diagram", { project: true });
  expect(measured.structured).toMatchObject({
    version: 1,
    status: "partial",
    complete: false,
    coverage: { total: 3, measured: 2, unavailable: 1 },
  });
  expect((measured.structured.results as { viewId: string }[]).map((r) => r.viewId)).toContain(
    "notes/explanation.md#named",
  );
});

test("saved unpinned fence measurement preserves read_diagram's source identity", async () => {
  const app = application({ ".archer/explanation.md": `# Figure\n\n\`\`\`mermaid\n${FLOW}\`\`\`\n` });
  const listed = await app.call("list_diagrams");
  const viewId = (listed.structured.embedded as { address: string }[])[0]!.address;
  const read = await app.call("read_diagram", { viewId });
  const measured = await app.call("measure_diagram", { viewId, expectedRevision: read.structured.sourceRevision });
  expect(measured.structured.sourceRevision).toBe(read.structured.sourceRevision);
  expect(measured.structured.modelRevision).toBe(read.structured.modelRevision);
});

test("layout worker failure after commit preserves the successful write and exact file bytes", async () => {
  const { LayoutPool } = await import("../../src/measurement/pool.ts");
  const { readFileSync } = await import("node:fs");
  const pool = new LayoutPool({ worker: new URL("file:///missing-archer-layout-worker.js") });
  const cwd = tempDir({ ".archer/flow.mmd": FLOW });
  const app = createApplication({ cwd, layoutPool: pool });
  applications.push(app);
  try {
    const read = await app.call("read_diagram", { viewId: "flow" });
    const source = FLOW.replace("Client", "Updated client");
    const written = await app.call("write_diagram", {
      viewId: "flow",
      source,
      expectedRevision: read.structured.sourceRevision,
    });
    expect(written.structured.status).toBe("compiled");
    expect(written.structured.layoutReview).toMatchObject({ status: "unavailable", reason: "worker_failed" });
    expect(readFileSync(`${cwd}/.archer/flow.mmd`, "utf8")).toBe(source);
    await expect(
      app.call("write_diagram", { viewId: "flow", source, expectedRevision: read.structured.sourceRevision }),
    ).rejects.toMatchObject({ data: { code: "revision_conflict" } });
  } finally {
    pool.close();
  }
});

test("viewport and group inclusion reuse geometry while unsupported saved presentation reports its limitation", async () => {
  const { LayoutPool } = await import("../../src/measurement/pool.ts");
  const pool = new LayoutPool();
  const cwd = tempDir({ ".archer/flow.mmd": FLOW });
  const app = createApplication({ cwd, layoutPool: pool });
  applications.push(app);
  try {
    const desktop = await app.call("measure_diagram", { viewId: "flow" });
    const phone = await app.call("measure_diagram", {
      viewId: "flow",
      viewport: { canvas: { width: 390, height: 685 } },
      includeGroups: false,
    });
    expect(phone.structured.sourceRevision).toBe(desktop.structured.sourceRevision);
    expect(phone.structured.states).not.toEqual(desktop.structured.states);
    expect(pool.stats.started).toBe(1);
    expect(pool.stats.cached).toBe(1);
    const saved = await app.call("measure_diagram", {
      viewId: "flow",
      presentation: { mode: "saved", revision: "positions-v1" },
    });
    expect(saved.structured).toMatchObject({
      status: "unavailable",
      reason: "unsupported_presentation",
      states: [],
      complete: false,
    });
  } finally {
    pool.close();
  }
});

test("project measurement admits more views than the worker waiting room can hold at once", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 35 }, (_, i) => [
      `.archer/view-${String(i).padStart(2, "0")}.mmd`,
      "sequenceDiagram\n participant reader as Reader\n reader->>reader: Review\n",
    ]),
  );
  const measured = await application(files).call("measure_diagram", { project: true });
  expect(measured.structured).toMatchObject({
    status: "ready",
    complete: true,
    coverage: { total: 35, measured: 35, unavailable: 0 },
    errors: [],
  });
  expect((measured.structured.results as { viewId: string }[]).map((result) => result.viewId)).toEqual(
    Array.from({ length: 35 }, (_, i) => `view-${String(i).padStart(2, "0")}`),
  );
});
