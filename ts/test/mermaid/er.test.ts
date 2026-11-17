// The ER profile: what it reads, and each construct it refuses, at the place
// it is written, with what to write instead.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { located } from "./support/compile-helpers.ts";
import { refusals } from "./support/refusals.ts";

const E = (body: string) => `erDiagram\n  A\n  B\n${body}\n`;

describe("refused", () => {
  refusals([
    {
      name: "an entity that is never declared",
      source: "erDiagram\n  A\n  A ||--o{ B : has\n",
      errors: ["undeclared_entity@3:12"],
      says: "`B`",
    },
    {
      name: "an unquoted label of several words, which Mermaid reads as another entity",
      source: E("  A ||--o{ B : places order"),
      errors: ["unquoted_label@4:16"],
      hint: '  A ||--o{ B : "places order"',
      fixedByHints: true,
    },
    {
      name: "an unquoted label Mermaid reads as a keyword",
      source: E("  A ||--o{ B : one"),
      errors: ["unquoted_label@4:16"],
      hint: '  A ||--o{ B : "one"',
      fixedByHints: true,
    },
    { name: "a relationship with no label", source: E("  A ||--o{ B"), errors: ["unsupported_construct@4:3"] },
    { name: "an empty label after `:`", source: E("  A ||--o{ B :"), errors: ["expected_label@4:14"] },
    {
      name: "cardinalities in words",
      source: E("  A one or more to zero or one B : x"),
      errors: ["unsupported_construct@4:3"],
      says: "in words",
    },
    {
      name: "an attribute with no name",
      source: "erDiagram\n  A {\n    string\n  }\n",
      errors: ["unsupported_construct@3:5"],
    },
    {
      name: "an attribute block never closed",
      source: "erDiagram\n  A {\n    string x\n",
      errors: ["unclosed_block@2:3"],
    },
    {
      name: "a quoted entity name",
      source: 'erDiagram\n  "My entity"\n',
      errors: ["invalid_id@2:3"],
      says: 'NAME["My entity"]',
    },
    { name: "an entity name outside ASCII", source: "erDiagram\n  Größe\n", errors: ["invalid_id@2:3"] },
    {
      name: "HTML in a label",
      source: E('  A ||--o{ B : "<i>x</i>"'),
      errors: ["unsupported_construct@4:16"],
      says: "HTML",
    },
    {
      name: "a second label for one entity",
      source: 'erDiagram\n  A["x"]\n  A["y"]\n',
      errors: ["duplicate_declaration@3:6"],
    },
    {
      name: "a comment after a statement",
      source: E("  A ||--o{ B : x %% why"),
      errors: ["unsupported_construct@4:18"],
      hint: "  %% why\n  A ||--o{ B : x",
    },
    {
      name: "direction TD, which Mermaid's ER grammar does not have",
      source: E("  direction TD"),
      errors: ["unsupported_construct@4:3"],
    },
    { name: "a title", source: E("  title Shop"), errors: ["unsupported_construct@4:3"] },
  ]);
});

describe("read", () => {
  test("a self-relationship", async () => {
    const result = await compile(E("  A |o..o{ A : parent"));
    expect(result.diagnostics).toEqual([]);
    expect(result.model).toMatchObject({
      relationships: [
        {
          id: "A--A",
          source: "A",
          target: "A",
          sourceCardinality: "zero-or-one",
          targetCardinality: "zero-or-more",
          identifying: false,
        },
      ],
    });
  });

  test('`""` is a relationship with no label', async () => {
    const result = await compile(E('  A ||--|| B : ""'));
    expect(result.model).toMatchObject({ relationships: [{ id: "A--B" }] });
    expect(result.model?.type === "entity-relationship" && result.model.relationships[0]?.label).toBeUndefined();
  });

  test("styling is accepted, left out of the model and noted once", async () => {
    const result = await compile(E("  A:::hot\n  classDef hot fill:#f00\n  class A hot"));
    expect(result.model).not.toBeNull();
    expect(located(result.diagnostics)).toEqual(["ignored_styling@4:3"]);
  });

  test("an entity's attribute blocks are read together", async () => {
    const result = await compile("erDiagram\n  A {\n    int x\n  }\n  A {\n    int y\n  }\n");
    expect(result.model).toMatchObject({ entities: [{ id: "A", attributes: [{ name: "x" }, { name: "y" }] }] });
  });
});
