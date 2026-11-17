import { expect, test } from "vitest";
import { previewAuthoring, parseAuthoringPreview } from "../../src/authoring/preview.ts";
import { ER_CARDINALITIES } from "../../src/authoring/er-edit.ts";
import { AuthoringInputError } from "../../../shared/authoring-contract.mts";

const er = 'erDiagram\r\n    CUSTOMER\r\n    ORDER-LINE["Line"]\r\n    CUSTOMER ||--o{ ORDER-LINE : places\r\n';

test("ER parameters are accepted on connect", () => {
  for (const cardinality of [undefined, ...ER_CARDINALITIES])
    for (const identifying of [undefined, true, false]) {
      const edit = {
        kind: "connect",
        source: "ORDER-LINE",
        target: "CUSTOMER",
        label: "",
        ...(cardinality === undefined ? {} : { cardinality }),
        ...(identifying === undefined ? {} : { identifying }),
      };
      expect(parseAuthoringPreview({ source: er, edit }, true).edit).toEqual(edit);
    }
  const full = {
    kind: "connect",
    id: "ORDER-LINE--CUSTOMER",
    source: "ORDER-LINE",
    target: "CUSTOMER",
    label: "x",
    cardinality: "one-to-one",
    identifying: false,
  };
  expect(parseAuthoringPreview({ source: er, edit: full }, true).edit).toEqual(full);
});

test("ER parameters keep their closed values and their operation", () => {
  for (const edit of [
    { kind: "connect", source: "a", target: "b", cardinality: "one-or-more" },
    { kind: "connect", source: "a", target: "b", cardinality: "__proto__" },
    { kind: "connect", source: "a", target: "b", cardinality: 1 },
    { kind: "connect", source: "a", target: "b", identifying: "true" },
    { kind: "connect", source: "a", target: "b", identifying: 0 },
    { kind: "connect", source: "a", target: "b", cardinality: "one-to-one", extra: 1 },
    { kind: "add-node", id: "n", label: "N", cardinality: "one-to-one" },
    { kind: "relabel-edge", id: "a--b", label: "x", identifying: true },
    { kind: "delete-edge", id: "a--b", cardinality: "one-to-one" },
  ])
    expect(() => parseAuthoringPreview({ source: er, edit }, true), JSON.stringify(edit)).toThrow(AuthoringInputError);
});

test("an ER edit request dispatches and keeps the preview response shape", async () => {
  const edited = (await previewAuthoring(
    {
      source: er,
      edit: {
        kind: "connect",
        source: "ORDER-LINE",
        target: "CUSTOMER",
        label: "billed to",
        cardinality: "many-to-many",
        identifying: false,
      },
    },
    true,
  )) as any;
  expect(edited.ok).toBe(true);
  expect(edited.source).toBe(er + '    ORDER-LINE }o..o{ CUSTOMER : "billed to"\r\n');
  expect(edited.envelope.model.relationships.at(-1)).toEqual({
    id: "ORDER-LINE--CUSTOMER",
    source: "ORDER-LINE",
    target: "CUSTOMER",
    sourceCardinality: "zero-or-more",
    targetCardinality: "zero-or-more",
    identifying: false,
    label: "billed to",
  });
  expect(
    await previewAuthoring(
      { source: er, edit: { kind: "connect", source: "CUSTOMER", target: "ORDER-LINE", label: "again" } },
      true,
    ),
  ).toEqual({ ok: false, source: er, code: "edit_relationship_exists", existingId: "CUSTOMER--ORDER-LINE" });
  expect(await previewAuthoring({ source: er, edit: { kind: "direction", direction: "tb" } }, true)).toEqual({
    ok: false,
    source: er,
    code: "edit_unsupported_for_family",
  });
});
