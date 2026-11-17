// A second relationship between the same two ends, in the families whose
// relationship IDs come from their ends (C4, ER, state, architecture): the
// source compiles, the relationship keeps one ID and is drawn once, and a
// warning at the later line says it was not drawn and why.

import { describe, expect, test } from "vitest";
import { editDiagram, type DiagramEdit } from "../../src/authoring/diagram-edit.ts";
import { compile, type Diagnostic } from "../../src/mermaid/index.ts";
import type { C4Model, EntityRelationship, ServiceArchitecture, StateMachine } from "../../src/model/index.ts";
import { errorsOf, located } from "./support/compile-helpers.ts";

const warnings = (diagnostics: Diagnostic[]) => diagnostics.filter((d) => d.severity === "warning");

test("state: the first transition is drawn and the later one is ignored, with a warning", async () => {
  const result = await compile("stateDiagram-v2\n  state A\n  state B\n  A --> B : start\n  A --> B : resume\n");
  expect(errorsOf(result.diagnostics)).toEqual([]);
  expect((result.model as StateMachine).transitions).toEqual([
    { id: "A--B", source: "A", target: "B", label: "start" },
  ]);
  expect(located(warnings(result.diagnostics))).toEqual(["duplicate_transition@5:3"]);
  expect(warnings(result.diagnostics)[0]?.message).toMatch(/line 4.*ignored|ignored.*line 4/);
  expect(warnings(result.diagnostics)[0]?.message).toContain("`A --> B : start / resume`");
});

test("ER: the first relationship is drawn and the later one is ignored, with a warning", async () => {
  const result = await compile("erDiagram\n  A\n  B\n  A ||--o{ B : x\n  A }o--o{ B : y\n");
  expect(errorsOf(result.diagnostics)).toEqual([]);
  const model = result.model as EntityRelationship;
  expect(model.relationships.map((r) => [r.id, r.label, r.sourceCardinality])).toEqual([["A--B", "x", "exactly-one"]]);
  expect(located(warnings(result.diagnostics))).toEqual(["duplicate_relationship@5:3"]);
});

test("ER: the later relationship is still checked against what Mermaid reads", async () => {
  const result = await compile('erDiagram\n  A\n  B\n  A ||--o{ B : x\n  A }o--o{ B : "<b>y</b>"\n');
  expect(located(errorsOf(result.diagnostics))).toEqual(["unsupported_construct@5:16"]);
});

test("architecture: the first edge is drawn and the later one is ignored, with a warning", async () => {
  const result = await compile(
    "architecture-beta\n  service a(server)[A]\n  service b(server)[B]\n  a:L -- R:b\n  a:T --> B:b\n",
  );
  expect(errorsOf(result.diagnostics)).toEqual([]);
  const model = result.model as ServiceArchitecture;
  expect(model.edges).toEqual([{ id: "a--b", source: "a", target: "b", sourceSide: "left", targetSide: "right" }]);
  expect(located(warnings(result.diagnostics))).toEqual(["duplicate_edge@5:3"]);
});

test("C4: Mermaid draws one relationship, the later one's text replacing the first's, with a warning", async () => {
  const result = await compile(
    'C4Context\n  Person(p, "P")\n  System(s, "S")\n  Rel(p, s, "x", "HTTPS", "first")\n  BiRel(p, s, "y")\n',
  );
  expect(errorsOf(result.diagnostics)).toEqual([]);
  const model = result.model as C4Model;
  expect(model.relationships).toEqual([
    {
      id: "p--s",
      source: "p",
      target: "s",
      label: "y",
      technology: "HTTPS",
      description: "first",
      bidirectional: true,
    },
  ]);
  expect(located(warnings(result.diagnostics))).toEqual(["duplicate_relationship@5:3"]);
  expect(warnings(result.diagnostics)[0]?.message).toContain("line 4");
});

test("a relationship the other way round is its own relationship, not a duplicate", async () => {
  const result = await compile("stateDiagram-v2\n  state A\n  state B\n  A --> B\n  B --> A\n");
  expect(result.diagnostics).toEqual([]);
  expect((result.model as StateMachine).transitions.map((t) => t.id)).toEqual(["A--B", "B--A"]);
});

describe("editing a relationship that is written twice", () => {
  const state = "stateDiagram-v2\n  state A\n  state B\n  state C\n  A --> B : start\n  A --> B : resume\n  B --> C\n";
  test("state: relabelling the drawn transition splices its own line and keeps the ignored one", async () => {
    const result = await editDiagram(state, { kind: "relabel-edge", id: "A--B", label: "go" });
    expect(result).toEqual({ ok: true, source: state.replace("A --> B : start", "A --> B : go") });
  });
  test.each([
    { kind: "delete-edge", id: "A--B" },
    { kind: "retarget-edge", id: "A--B", target: "C" },
  ] as DiagramEdit[])("state: $kind is refused, since the repeat would take its place", async (edit) => {
    expect(await editDiagram(state, edit)).toMatchObject({
      ok: false,
      code: "edit_source_mapping_ambiguous",
      source: state,
    });
  });
  test("state: connecting the same two states again is still refused", async () => {
    expect(await editDiagram(state, { kind: "connect", source: "A", target: "B" })).toMatchObject({
      ok: false,
      code: "edit_relationship_exists",
    });
  });
  const er = "erDiagram\n  A\n  B\n  C\n  A ||--o{ B : x\n  A }o--o{ B : y\n  B ||--o{ C : z\n";
  test("ER: deleting a relationship written twice is refused", async () => {
    expect(await editDiagram(er, { kind: "delete-edge", id: "A--B" })).toMatchObject({
      ok: false,
      code: "edit_source_mapping_ambiguous",
    });
  });
  const c4 = 'C4Context\n  Person(p, "P")\n  System(s, "S")\n  Rel(p, s, "x")\n  Rel(p, s, "y")\n';
  test("C4: an edit to a relationship Mermaid merged from two lines is refused", async () => {
    for (const edit of [
      { kind: "relabel-edge", id: "p--s", label: "z" },
      { kind: "delete-edge", id: "p--s" },
    ] as DiagramEdit[]) {
      expect(await editDiagram(c4, edit)).toMatchObject({ ok: false, code: "edit_source_mapping_ambiguous" });
    }
  });
});
