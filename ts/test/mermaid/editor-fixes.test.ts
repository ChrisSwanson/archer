import { expect, test } from "vitest";
import { editDiagram } from "../../src/authoring/diagram-edit.ts";
import { previewAuthoring } from "../../src/authoring/preview.ts";

const flow = "flowchart LR\n  a[Client]\n  b[API]\n  a calls@-->|HTTP| b\n";

test("flowchart refuses labels it cannot write exactly with edit_invalid_label", async () => {
  for (const label of ["Foo ", " ", "line1\r\nline2", "<b>tag</b>", "<br/>", "%%{init}%%"]) {
    for (const edit of [
      { kind: "relabel-node", id: "a", label },
      { kind: "add-node", id: "c", label },
      { kind: "relabel-edge", id: "calls", label },
      { kind: "connect", id: "e2", source: "a", target: "b", label },
    ] as const) {
      const r = await editDiagram(flow, edit);
      expect(r.ok, JSON.stringify(edit)).toBe(false);
      if (!r.ok) expect(r.source).toBe(flow);
      if (!r.ok) expect(["edit_invalid_label"], `${JSON.stringify(edit)} ${r.code}`).toContain(r.code);
    }
  }
});

test("a refusal on an invalid source carries the compiler diagnostic", async () => {
  const bad = "flowchart LR\n  a --> b\n";
  const r = await editDiagram(bad, { kind: "direction", direction: "tb" });
  expect(r).toMatchObject({
    ok: false,
    code: "edit_requires_valid_flowchart",
    diagnostic: { line: expect.any(Number), message: expect.any(String) },
  });
});

test("edit_relationship_exists keeps existingId through the preview boundary", async () => {
  const er = "erDiagram\n    A\n    B\n    A ||--o{ B : has\n";
  const r = await previewAuthoring(
    { source: er, edit: { kind: "connect", source: "A", target: "B", label: "x" } },
    true,
  );
  expect(r).toMatchObject({ ok: false, code: "edit_relationship_exists", existingId: "A--B" });
});

test("ER retarget works when an endpoint is first mentioned on the edge line", async () => {
  const er = 'erDiagram\n    A\n    A ||--o{ B : has\n    B["b"]\n    C\n';
  const r = await editDiagram(er, { kind: "retarget-edge", id: "A--B", target: "C" });
  expect(r).toEqual({ ok: true, source: er.replace("A ||--o{ B", "A ||--o{ C") });
});

test("ER retarget-edge changes cardinality and identifying, only those tokens", async () => {
  const er = 'erDiagram\r\n    A\r\n    B\r\n    A ||--o{ B : "has"\r\n%% keep\r\n';
  const r = await editDiagram(er, {
    kind: "retarget-edge",
    id: "A--B",
    cardinality: "many-to-many",
    identifying: false,
  });
  expect(r).toEqual({ ok: true, source: er.replace("||--o{", "}o..o{") });
  expect(await editDiagram(er, { kind: "retarget-edge", id: "A--B", cardinality: "one-to-many" })).toEqual({
    ok: true,
    source: er,
  });
  expect(await editDiagram(er, { kind: "retarget-edge", id: "A--B", identifying: false })).toEqual({
    ok: true,
    source: er.replace("||--o{", "||..o{"),
  });
  expect(await editDiagram(er, { kind: "retarget-edge", id: "A--B", cardinality: "x" as "one-to-one" })).toMatchObject({
    ok: false,
    code: "edit_invalid_cardinality",
  });
  const both = await editDiagram(er.replace("B\r\n    A", "B\r\n    C\r\n    A"), {
    kind: "retarget-edge",
    id: "A--B",
    target: "C",
    cardinality: "one-to-one",
  });
  expect(both).toMatchObject({ ok: true });
  if (both.ok) expect(both.source).toContain('A ||--|| C : "has"');
});

test("other families refuse retarget cardinality", async () => {
  expect(await editDiagram(flow, { kind: "retarget-edge", id: "calls", cardinality: "one-to-one" })).toMatchObject({
    ok: false,
    code: "edit_unsupported_for_family",
  });
  const seq = "sequenceDiagram\n  participant a\n  participant b\n  a->>b: x\n";
  expect(await editDiagram(seq, { kind: "retarget-edge", id: "msg-0", identifying: false })).toMatchObject({
    ok: false,
    code: "edit_unsupported_for_family",
  });
});

test("C4 delete of the only element is a named refusal", async () => {
  const c4 = 'C4Context\n    Person(u, "U")\n';
  expect(await editDiagram(c4, { kind: "delete-node", id: "u" })).toEqual({
    ok: false,
    source: c4,
    code: "edit_delete_last_element",
  });
});

test("state keyword ids are reserved as transition endpoints", async () => {
  const st = 'stateDiagram-v2\r\n    state "Plain" as default\r\n';
  expect(await editDiagram(st, { kind: "connect", source: "default", target: "default" })).toMatchObject({
    ok: false,
    code: "edit_id_reserved",
  });
});

test("state choice/fork/join accept an empty label", async () => {
  const st = 'stateDiagram-v2\n    state "A" as a\n';
  expect(await editDiagram(st, { kind: "add-node", id: "c1", label: "", state: "choice" })).toMatchObject({ ok: true });
  expect(await editDiagram(st, { kind: "add-node", id: "c1", label: "x", state: "choice" })).toMatchObject({
    ok: false,
    code: "edit_label_unsupported",
  });
});

test("delete of a last line without a final newline keeps the blank line before it", async () => {
  const er = "erDiagram\n\tA {\n\t}\n\tB\n\n\tA ||--o{ B : has";
  const r = await editDiagram(er, { kind: "delete-edge", id: "A--B" });
  expect(r).toEqual({ ok: true, source: "erDiagram\n\tA {\n\t}\n\tB\n\n" });
});

test("sequence moves splice the original bytes: directives and each line terminator", async () => {
  const src =
    'sequenceDiagram\r\n  participant A %%{init: {"theme": "dark"}}%%\r\n  participant B\n  participant C\r\n  A->>B: one\r\n  B->>C: two\n';
  const r = await editDiagram(src, { kind: "move-node", id: "A", before: null });
  expect(r).toEqual({
    ok: true,
    source:
      'sequenceDiagram\r\n  participant B\n  participant C\r\n  participant A %%{init: {"theme": "dark"}}%%\r\n  A->>B: one\r\n  B->>C: two\n',
  });
  const m = await editDiagram(src, { kind: "move-edge", id: "msg-1", before: "msg-0" });
  expect(m).toEqual({
    ok: true,
    source:
      'sequenceDiagram\r\n  participant A %%{init: {"theme": "dark"}}%%\r\n  participant B\n  participant C\r\n  B->>C: two\n  A->>B: one\r\n',
  });
});

test("moving onto itself is an ok no-op", async () => {
  const seq = "sequenceDiagram\n  participant a\n  participant b\n  a->>b: x\n";
  expect(await editDiagram(seq, { kind: "move-node", id: "a", before: "a" })).toEqual({ ok: true, source: seq });
  expect(await editDiagram(seq, { kind: "move-edge", id: "msg-0", before: "msg-0" })).toEqual({
    ok: true,
    source: seq,
  });
});
