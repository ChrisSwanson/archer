// What an agent gets back for ordinary Mermaid it pastes: the edge-ID fix as
// text it can write, and warnings that leave a diagram compiled.

import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { renderOperation } from "../../src/application/render.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

test("validate_diagram hands back the source with the missing edge IDs written in", async () => {
  const app = createApplication({ cwd: tempDir({ ".archer/flow.mmd": FLOW }) });
  try {
    const source = "flowchart LR\n  a[Client] --> b[API]\n  b -->|reads| a\n";
    const result = await app.call("validate_diagram", { viewId: "flow", source });
    expect(result.structured.valid).toBe(false);
    expect(result.structured.fix).toEqual({
      operation: "add-edge-ids",
      source: "flowchart LR\n  a[Client] a_b@--> b[API]\n  b b_a@-->|reads| a\n",
      added: [
        { line: 2, id: "a_b" },
        { line: 3, id: "b_a" },
      ],
    });
    expect(result.text).toContain("add-edge-ids");
    expect(result.text).toContain("a[Client] a_b@--> b[API]");
    expect(renderOperation("validate_diagram", result)).toContain("b b_a@-->|reads| a");
    const fixed = await app.call("validate_diagram", {
      viewId: "flow",
      source: String((result.structured.fix as { source: string }).source),
    });
    expect(fixed.structured.valid).toBe(true);
    expect(fixed.structured.fix).toBeUndefined();
  } finally {
    app.close();
  }
});

test("validate_diagram declares the nodes pasted Mermaid only names, so `a --> b` is valid in one step (smoke-c#7)", async () => {
  const app = createApplication({ cwd: tempDir({ ".archer/flow.mmd": FLOW }) });
  try {
    const result = await app.call("validate_diagram", { viewId: "flow", source: "flowchart LR\n  a --> b\n" });
    expect(result.structured.fix).toEqual({
      operation: "add-edge-ids",
      source: "flowchart LR\n  a[a] a_b@--> b[b]\n",
      added: [{ line: 2, id: "a_b" }],
      declared: [
        { line: 2, id: "a" },
        { line: 2, id: "b" },
      ],
    });
    expect(result.text).toContain("declared: a (line 2), b (line 2)");
    const fixed = await app.call("validate_diagram", {
      viewId: "flow",
      source: String((result.structured.fix as { source: string }).source),
    });
    expect(fixed.structured.valid).toBe(true);
  } finally {
    app.close();
  }
});

test("a warning leaves the diagram compiled, and read_diagram and validate_diagram both report it", async () => {
  const source = "stateDiagram-v2\n  state A\n  state B\n  A --> B : start\n  A --> B : resume\n";
  const app = createApplication({ cwd: tempDir({ "archer.toml": "version = 1\n", ".archer/states.mmd": source }) });
  try {
    await app.call("register_diagram", { sourcePath: "states.mmd" });
    const read = await app.call("read_diagram", { viewId: "states" });
    const compile = read.structured.compile as { status: string; diagnostics: { code: string; severity: string }[] };
    expect(compile.status).toBe("compiled");
    expect(compile.diagnostics).toMatchObject([{ code: "duplicate_transition", severity: "warning" }]);
    expect(read.text).toContain("1 warning");
    expect(read.text).toContain("[duplicate_transition] line 5:3");
    const valid = await app.call("validate_diagram", { viewId: "states", source });
    expect(valid.structured.valid).toBe(true);
    expect(valid.text).toContain("[duplicate_transition] line 5:3");
  } finally {
    app.close();
  }
});

test("validate_diagram accepts a category's meaning and refuses a key for a class the diagram does not declare", async () => {
  const source =
    "flowchart TB\n  %% archer-key gpu: Model server on a GPU\n  a[Farm model server]:::gpu\n  b[Gateway] e1@--> a\n  classDef gpu fill:#ecfdf5,stroke:#0f766e\n";
  const app = createApplication({ cwd: tempDir({ ".archer/flow.mmd": FLOW }) });
  try {
    const valid = await app.call("validate_diagram", { viewId: "flow", source });
    expect(valid.structured.valid).toBe(true);
    expect(valid.text).toMatch(
      /^Valid\.(?:\nLayout review pending \(non-blocking\)\. Run measure_diagram with the inspect arguments to get the result; it is not delivered automatically\.)?$/,
    );
    expect(valid.structured.layoutReview).toMatchObject({ version: 1, profile: "desktop-1025x896-gutter24" });
    const wrong = await app.call("validate_diagram", { viewId: "flow", source: source.replace("key gpu", "key gpus") });
    expect(wrong.structured.valid).toBe(false);
    expect(wrong.text).toContain("[key_target_unknown] line 2");
    expect(wrong.text).toContain("did you mean 'gpu'");
  } finally {
    app.close();
  }
});
