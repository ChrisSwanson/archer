import { afterEach, expect, test, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as application from "../../src/application/index.ts";
import { validateEvalProject } from "../../scripts/evals/validate.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

afterEach(() => {
  vi.restoreAllMocks();
  removeTempDirs();
});

const note = (source: string, name = "lineage") =>
  `---\nauthor: agent\n---\n# Plan\n\n\`\`\`mermaid\n%% archer-id: ${name}\n${source}\`\`\`\n`;

test("validates the actual embedded note through the production application", async () => {
  const dir = tempDir({ ".archer/notes/plan.md": note(FLOW) });
  const result = await validateEvalProject(dir);
  expect(result.status).toBe("compiled");
  expect(result.problems).toEqual([]);
  expect(result.views).toMatchObject([
    { viewId: "notes/plan.md#lineage", compileStatus: "compiled", envelope: { model: { type: "freeform-graph" } } },
  ]);
});

test("validates embedded C4 and standalone views, preserving exact source and revisions", async () => {
  const c4 =
    'C4Component\nContainer_Boundary(worker, "Ingestion worker") {\n  Component(parser, "Parser", "TypeScript", "Extracts text")\n  Component(writer, "Writer", "TypeScript", "Stores results")\n}\nRel(parser, writer, "Sends text")\n';
  const dir = tempDir({
    ".archer/notes/plan.md": note(FLOW) + "\n" + note(c4, "components"),
    ".archer/overview.mmd": FLOW,
  });
  const result = await validateEvalProject(dir);
  expect(result.status).toBe("compiled");
  expect(result.problems).toEqual([]);
  expect(result.views.map((v) => v.viewId)).toEqual(["overview", "notes/plan.md#lineage", "notes/plan.md#components"]);
  expect(result.views[0]).toMatchObject({ source: { text: FLOW }, envelope: { model: { type: "freeform-graph" } } });
  expect(result.views[2]).toMatchObject({
    compileStatus: "compiled",
    envelope: { model: { type: "c4-model", level: "component" } },
  });
  for (const view of result.views) {
    expect(view.sourceRevision).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(view.modelRevision).toBe(view.envelope?.revision);
  }
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});

test.each(["flowchart LR\n  a[A] --> b[B]\n", "classDiagram\n  class User\n"])(
  "rejects invalid current embedded source instead of treating output as nonvisual: %s",
  async (source) => {
    const result = await validateEvalProject(tempDir({ ".archer/notes/plan.md": note(source) }));
    expect(result.status).toBe("failed");
    expect(result.views).toMatchObject([
      { compileStatus: "failed", diagnostics: [expect.objectContaining({ severity: "error" })] },
    ]);
    expect(result.problems).toContainEqual(
      expect.objectContaining({ code: "compile_failed", viewId: "notes/plan.md#lineage" }),
    );
  },
);

test.each([{ ".archer/notes/answer.md": "# Answer\nPort 8080.\n" }, {}])(
  "reports nonvisual only for an inventory without views or problems: %j",
  async (files) => {
    expect(await validateEvalProject(tempDir(files))).toEqual({ status: "nonvisual", views: [], problems: [] });
  },
);

test.each([
  { files: { ".archer/bad name.mmd": FLOW }, code: "invalid_view_id" },
  { files: { ".archer/notes/invalid.md": "---\nauthor: agent\n" }, code: "note_inventory_error" },
  { files: { ".archer/notes/invalid.md": note(FLOW, "bad/name") }, code: "embedded_inventory_error" },
  { files: { ".archer/notes/invalid.md": note(FLOW) + "\n" + note(FLOW) }, code: "embedded_inventory_error" },
])("refuses inventory problems even when no usable view is found: $code", async ({ files, code }) => {
  const result = await validateEvalProject(tempDir(files));
  expect(result.status).toBe("failed");
  expect(result.problems).toContainEqual(expect.objectContaining({ code }));
});

test("rejects current failed source even when the real application retains its last valid model", async () => {
  const dir = tempDir({ ".archer/overview.mmd": FLOW });
  const app = application.createApplication({ cwd: dir });
  try {
    const previous = (await app.call("read_diagram", { viewId: "overview" })).structured;
    expect(previous["compile"]).toMatchObject({ status: "compiled" });
    writeFileSync(join(dir, ".archer/overview.mmd"), "flowchart LR\n  a[A] --> b[B]\n");
    vi.spyOn(application, "createApplication").mockReturnValueOnce(app);
    const result = await validateEvalProject(dir);
    expect(result.status).toBe("failed");
    expect(result.views).toMatchObject([
      { compileStatus: "failed", envelope: previous["envelope"], modelRevision: previous["modelRevision"] },
    ]);
    expect(result.views[0]?.sourceRevision).not.toBe(previous["sourceRevision"]);
    expect(result.views[0]?.diagnostics).toContainEqual(expect.objectContaining({ severity: "error" }));
    expect(result.problems).toContainEqual(expect.objectContaining({ code: "compile_failed" }));
    await expect(app.call("list_diagrams")).rejects.toMatchObject({ data: { code: "invalid_request" } });
  } finally {
    app.close();
  }
});

test.each([false, true])("closes the real application after inventory success or refusal: %s", async (invalid) => {
  const dir = tempDir(invalid ? { "archer.toml": "version = " } : { ".archer/notes/answer.md": "# Answer\n" });
  const close = vi.spyOn(application.Application.prototype, "close");
  const call = vi.spyOn(application.Application.prototype, "call");
  const result = await validateEvalProject(dir);
  expect(result.status).toBe(invalid ? "failed" : "nonvisual");
  if (invalid) expect(result.problems).toContainEqual(expect.objectContaining({ code: "manifest_error" }));
  expect(close).toHaveBeenCalledOnce();
  expect(call.mock.calls.map(([operation]) => operation)).toEqual(["list_diagrams"]);
  const app = close.mock.instances[0] as application.Application;
  await expect(app.call("list_diagrams")).rejects.toMatchObject({ data: { code: "invalid_request" } });
});

test("refuses an unreadable UTF-8 note instead of declaring a nonvisual answer", async () => {
  const dir = tempDir({ ".archer/notes/answer.md": "" });
  writeFileSync(join(dir, ".archer/notes/answer.md"), Buffer.from([0xff, 0xfe]));
  const result = await validateEvalProject(dir);
  expect(result.status).toBe("failed");
  expect(result.views).toEqual([]);
  expect(result.problems).toContainEqual(
    expect.objectContaining({ code: "note_unreadable", source: "notes/answer.md" }),
  );
});

test("collects every standalone view even when one fails compilation", async () => {
  const result = await validateEvalProject(
    tempDir({
      ".archer/good.mmd": FLOW,
      ".archer/unsupported.mmd": "classDiagram\n  class User\n",
    }),
  );
  expect(result.status).toBe("failed");
  expect(result.views).toMatchObject([
    { viewId: "good", compileStatus: "compiled", envelope: { model: { type: "freeform-graph" } } },
    { viewId: "unsupported", compileStatus: "failed", diagnostics: [expect.objectContaining({ severity: "error" })] },
  ]);
  expect(result.problems).toContainEqual(expect.objectContaining({ code: "compile_failed", viewId: "unsupported" }));
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});
