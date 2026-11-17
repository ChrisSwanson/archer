// Pasting ordinary Mermaid: a flowchart whose edges have no IDs is refused,
// and each refusal names the fix, `add-edge-ids`, which writes a readable ID
// on every such edge and changes nothing else in the source.

import { expect, test } from "vitest";
import { editDiagram } from "../../src/authoring/diagram-edit.ts";
import { previewAuthoring } from "../../src/authoring/preview.ts";
import { addMissingEdgeIds } from "../../src/mermaid/flowchart/edge-ids.ts";
import { compile } from "../../src/mermaid/index.ts";
import { errorsOf } from "./support/compile-helpers.ts";

const pasted = [
  "%% from the wiki",
  "flowchart LR",
  "    a[Client] --> b[API]",
  "    b -->|reads| db[(Orders)]",
  "    b a_b@-.-> a",
  "    a ==> b",
  "    b <--> c(Cache)",
  "",
].join("\r\n");

const fixed = [
  "%% from the wiki",
  "flowchart LR",
  "    a[Client] a_b_2@--> b[API]",
  "    b b_db@-->|reads| db[(Orders)]",
  "    b a_b@-.-> a",
  "    a a_b_3@==> b",
  "    b b_c@<--> c(Cache)",
  "",
].join("\r\n");

test("each edge without an ID is an error that names the fix", async () => {
  const result = await compile(pasted);
  expect(result.model).toBeNull();
  const missing = errorsOf(result.diagnostics);
  expect(missing.map((d) => [d.span.start.line, d.fix?.operation])).toEqual([
    [3, "add-edge-ids"],
    [4, "add-edge-ids"],
    [6, "add-edge-ids"],
    [7, "add-edge-ids"],
  ]);
});

test("add-edge-ids writes a readable, unique ID on each edge and touches nothing else", async () => {
  const result = addMissingEdgeIds(pasted);
  expect(result.source).toBe(fixed);
  expect(result.added).toEqual([
    { line: 3, id: "a_b_2" },
    { line: 4, id: "b_db" },
    { line: 6, id: "a_b_3" },
    { line: 7, id: "b_c" },
  ]);
  const compiled = await compile(result.source);
  expect(errorsOf(compiled.diagnostics)).toEqual([]);
  // Applying it again changes nothing.
  expect(addMissingEdgeIds(fixed)).toEqual({ source: fixed, added: [], declared: [] });
});

test("an edge glued to its source gets a space before its ID", () => {
  expect(addMissingEdgeIds("flowchart LR\n  a[A]-->b[B]").source).toBe("flowchart LR\n  a[A] a_b@-->b[B]");
});

test("other problems stay for the author: the fix only adds IDs", async () => {
  const source = "flowchart LR\n  a[A] --> b[B];\n";
  const result = addMissingEdgeIds(source);
  expect(result.source).toBe("flowchart LR\n  a[A] a_b@--> b[B];\n");
  expect(errorsOf((await compile(result.source)).diagnostics).map((d) => d.code)).toEqual(["unsupported_construct"]);
});

test("the edit operation applies it, and leaves other families alone", async () => {
  expect(await editDiagram(pasted, { kind: "add-edge-ids" })).toEqual({ ok: true, source: fixed });
  expect(await editDiagram(fixed, { kind: "add-edge-ids" })).toEqual({ ok: true, source: fixed });
  const sequence = "sequenceDiagram\n  participant a as A\n";
  expect(await editDiagram(sequence, { kind: "add-edge-ids" })).toMatchObject({
    ok: false,
    code: "edit_unsupported_for_family",
  });
});

test("the browser edit route takes it on a source that does not compile yet", async () => {
  const result = (await previewAuthoring({ source: pasted, edit: { kind: "add-edge-ids" } }, true)) as {
    ok: boolean;
    source: string;
    envelope: unknown;
  };
  expect(result.ok).toBe(true);
  expect(result.source).toBe(fixed);
  expect(result.envelope).not.toBeNull();
});

test("link text written without spaces is one edge, as Mermaid reads it: no ID is written into its text", async () => {
  // Mermaid reads `a--text-->b` as one edge from a to b labelled "text" (not `a --> text --> b`).
  const glued = "flowchart LR\n  a[A]--text-->b[B]\n  c[C]==heavy==>d[D]\n  e[E]-.dots.->f[F]\n";
  const before = errorsOf((await compile(glued)).diagnostics);
  expect(before.map((d) => [d.span.start.line, d.message.split(":")[0]])).toEqual([
    [2, "link text goes between pipes after the link"],
    [3, "link text goes between pipes after the link"],
    [4, "link text goes between pipes after the link"],
  ]);
  // Each refusal's rewrite is the whole fix: pipes and the ID together.
  expect(before.map((d) => d.hint)).toEqual([
    expect.stringContaining("a[A] a_b@-->|text|b[B]"),
    expect.stringContaining("c[C] c_d@==>|heavy|d[D]"),
    expect.stringContaining("e[E] e_f@-.->|dots|f[F]"),
  ]);
  expect(addMissingEdgeIds(glued)).toEqual({ source: glued, added: [], declared: [] });
});

test("an `a--b` edge Mermaid cannot read is left to its own refusal, whose rewrite names the ID", async () => {
  const source = "flowchart LR\n  a[A]--b[B]\n  c[C] --> d[D]\n";
  const before = errorsOf((await compile(source)).diagnostics);
  expect(before.map((d) => [d.span.start.line, d.fix?.operation])).toEqual([
    [2, undefined],
    [3, "add-edge-ids"],
  ]);
  expect(before[0]?.hint).toContain("a[A] a_b@-->b[B]");
  const result = addMissingEdgeIds(source);
  expect(result.source).toBe("flowchart LR\n  a[A]--b[B]\n  c[C] c_d@--> d[D]\n");
  expect(result.added).toEqual([{ line: 3, id: "c_d" }]);
});

test("an edge whose only other problem is its label still gets the ID the diagnostic offers (codex review)", async () => {
  const source = "flowchart LR\n  a[A] -->|| b[B]\n";
  expect(errorsOf((await compile(source)).diagnostics).some((d) => d.fix?.operation === "add-edge-ids")).toBe(true);
  expect(addMissingEdgeIds(source).source).toBe("flowchart LR\n  a[A] a_b@-->|| b[B]\n");
});

test("two-way link text is one edge, as Mermaid reads it: no ID goes into its text (codex review)", async () => {
  const source = "flowchart LR\n  a[A] <-- text --> b[B]\n";
  expect(addMissingEdgeIds(source)).toEqual({ source, added: [], declared: [] });
  const errors = errorsOf((await compile(source)).diagnostics);
  expect(errors.map((d) => d.message.split(":")[0])).toEqual(["link text goes between pipes after the link"]);
  expect(errors[0]?.hint).toContain("a[A] a_b@<-->|text| b[B]");
});

test("pasted `a --> b` becomes valid in one click: each node only ever named is declared with its ID as its label (smoke-c#7)", async () => {
  const pasted = "flowchart LR\r\n    a --> b\r\n    b-->c\r\n    c[Cache] --> a\r\n";
  const before = errorsOf((await compile(pasted)).diagnostics);
  expect(before.filter((d) => d.code === "undeclared_node").map((d) => d.fix?.operation)).toEqual([
    "add-edge-ids",
    "add-edge-ids",
  ]);
  expect(before.find((d) => d.code === "undeclared_node")?.message).toContain("`add-edge-ids`");
  const result = addMissingEdgeIds(pasted);
  expect(result.source).toBe("flowchart LR\r\n    a[a] a_b@--> b[b]\r\n    b b_c@-->c\r\n    c[Cache] c_a@--> a\r\n");
  expect(result.declared).toEqual([
    { line: 2, id: "a" },
    { line: 2, id: "b" },
  ]);
  expect(errorsOf((await compile(result.source)).diagnostics)).toEqual([]);
  expect(addMissingEdgeIds(result.source)).toEqual({ source: result.source, added: [], declared: [] });
});

test("a glued edge between two bare names gets both declarations and its ID", async () => {
  const result = addMissingEdgeIds("flowchart LR\n  a-->b\n");
  expect(result.source).toBe("flowchart LR\n  a[a] a_b@-->b[b]\n");
  expect(errorsOf((await compile(result.source)).diagnostics)).toEqual([]);
});

test("a line that starts with a directive still takes the fix it is offered (codex review)", async () => {
  const source = "flowchart LR\n%%{init: {}}%% a e@--> b\n";
  expect(errorsOf((await compile(source)).diagnostics).filter((d) => d.fix?.operation === "add-edge-ids")).toHaveLength(
    2,
  );
  expect(addMissingEdgeIds(source).source).toBe("flowchart LR\n%%{init: {}}%% a[a] e@--> b[b]\n");
});

test("a node whose ID is not a stable ID is not declared: the fix is not offered for it (codex review)", async () => {
  const source = "flowchart LR\n  /a --> b\n";
  expect(
    errorsOf((await compile(source)).diagnostics)
      .filter((d) => d.code === "undeclared_node" && d.fix !== undefined)
      .map((d) => d.message.slice(0, 9)),
  ).toEqual(["node 'b' "]);
  const once = addMissingEdgeIds(source).source;
  expect(once).not.toContain("[/a]");
  expect(addMissingEdgeIds(once).source).toBe(once);
});
