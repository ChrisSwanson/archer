import { expect, test } from "vitest";
import { bracketErLabel, editEr, ER_CARDINALITIES, quoteErRelationshipLabel } from "../../src/authoring/er-edit.ts";
import { editDiagram, type DiagramEdit } from "../../src/authoring/diagram-edit.ts";
import { compile } from "../../src/mermaid/index.ts";
import type { Cardinality, EntityRelationship, Relationship } from "../../src/model/index.ts";

const base = [
  "%% 🐦 keep",
  "erDiagram",
  "    direction LR",
  '    CUSTOMER["Customer"] {',
  '        string name PK "full name"',
  "        string email UK",
  "    }",
  "    ORDER {",
  "        int id PK",
  "    }",
  "    %% between",
  '    LINE-ITEM["Order line"]',
  "    PRODUCT",
  "    CUSTOMER ||--o{ ORDER : places",
  '    ORDER ||--|{ LINE-ITEM : "is made of"',
  '    LINE-ITEM }o..|| PRODUCT : ""',
].join("\r\n");

async function model(source: string): Promise<EntityRelationship> {
  const result = await compile(source);
  if (result.model?.type !== "entity-relationship") throw new Error(JSON.stringify(result.diagnostics));
  return result.model;
}

const rel = (
  source: string,
  target: string,
  sourceCardinality: Cardinality,
  targetCardinality: Cardinality,
  identifying: boolean,
  label?: string,
): Relationship => ({
  id: `${source}--${target}`,
  source,
  target,
  sourceCardinality,
  targetCardinality,
  identifying,
  ...(label === undefined ? {} : { label }),
});

const cases: {
  name: string;
  edit: DiagramEdit;
  expected: string;
  effect: (m: EntityRelationship) => EntityRelationship;
}[] = [
  {
    name: "add-node with a label",
    edit: { kind: "add-node", id: "INVOICE", label: 'Invoice "draft" #1' },
    expected: base + '\r\n    INVOICE["Invoice #quot;draft#quot; #35;1"]',
    effect: (m) => ({
      ...m,
      entities: [...m.entities, { id: "INVOICE", label: 'Invoice "draft" #1', attributes: [] }],
    }),
  },
  {
    name: "add-node with no label writes the bare name",
    edit: { kind: "add-node", id: "ship-to", label: "" },
    expected: base + "\r\n    ship-to",
    effect: (m) => ({ ...m, entities: [...m.entities, { id: "ship-to", label: "ship-to", attributes: [] }] }),
  },
  {
    name: "add-node whose label is its name writes the bare name",
    edit: { kind: "add-node", id: "A1", label: "A1" },
    expected: base + "\r\n    A1",
    effect: (m) => ({ ...m, entities: [...m.entities, { id: "A1", label: "A1", attributes: [] }] }),
  },
  {
    name: "connect defaults to one-to-many, identifying",
    edit: { kind: "connect", source: "PRODUCT", target: "ORDER", label: "appears in" },
    expected: base + '\r\n    PRODUCT ||--o{ ORDER : "appears in"',
    effect: (m) => ({
      ...m,
      relationships: [...m.relationships, rel("PRODUCT", "ORDER", "exactly-one", "zero-or-more", true, "appears in")],
    }),
  },
  {
    name: "connect one-to-one with the derived id",
    edit: {
      kind: "connect",
      id: "ORDER--CUSTOMER",
      source: "ORDER",
      target: "CUSTOMER",
      label: "billed",
      cardinality: "one-to-one",
    },
    expected: base + '\r\n    ORDER ||--|| CUSTOMER : "billed"',
    effect: (m) => ({
      ...m,
      relationships: [...m.relationships, rel("ORDER", "CUSTOMER", "exactly-one", "exactly-one", true, "billed")],
    }),
  },
  {
    name: "connect many-to-many non-identifying",
    edit: {
      kind: "connect",
      source: "PRODUCT",
      target: "CUSTOMER",
      label: "one to many",
      cardinality: "many-to-many",
      identifying: false,
    },
    expected: base + '\r\n    PRODUCT }o..o{ CUSTOMER : "one to many"',
    effect: (m) => ({
      ...m,
      relationships: [
        ...m.relationships,
        rel("PRODUCT", "CUSTOMER", "zero-or-more", "zero-or-more", false, "one to many"),
      ],
    }),
  },
  {
    name: "connect zero-or-one-to-many with no label, to itself",
    edit: {
      kind: "connect",
      source: "PRODUCT",
      target: "PRODUCT",
      cardinality: "zero-or-one-to-many",
      identifying: true,
    },
    expected: base + '\r\n    PRODUCT |o--o{ PRODUCT : ""',
    effect: (m) => ({
      ...m,
      relationships: [...m.relationships, rel("PRODUCT", "PRODUCT", "zero-or-one", "zero-or-more", true)],
    }),
  },
  {
    name: "relabel-node replaces only the label, keeping the attribute block",
    edit: { kind: "relabel-node", id: "CUSTOMER", label: "Client" },
    expected: base.replace('CUSTOMER["Customer"] {', 'CUSTOMER["Client"] {'),
    effect: (m) => ({ ...m, entities: m.entities.map((e) => (e.id === "CUSTOMER" ? { ...e, label: "Client" } : e)) }),
  },
  {
    name: "relabel-node adds the bracket before an attribute block",
    edit: { kind: "relabel-node", id: "ORDER", label: "Order -- or .. sale" },
    expected: base.replace("    ORDER {", '    ORDER["Order #45;#45; or #46;#46; sale"] {'),
    effect: (m) => ({
      ...m,
      entities: m.entities.map((e) => (e.id === "ORDER" ? { ...e, label: "Order -- or .. sale" } : e)),
    }),
  },
  {
    name: "relabel-node adds the bracket to a bare declaration",
    edit: { kind: "relabel-node", id: "PRODUCT", label: "one to many" },
    expected: base.replace("    PRODUCT\r\n", '    PRODUCT["one #116;o many"]\r\n'),
    effect: (m) => ({
      ...m,
      entities: m.entities.map((e) => (e.id === "PRODUCT" ? { ...e, label: "one to many" } : e)),
    }),
  },
  {
    name: "relabel-node to no label removes the bracket",
    edit: { kind: "relabel-node", id: "LINE-ITEM", label: "" },
    expected: base.replace('LINE-ITEM["Order line"]', "LINE-ITEM"),
    effect: (m) => ({
      ...m,
      entities: m.entities.map((e) => (e.id === "LINE-ITEM" ? { ...e, label: "LINE-ITEM" } : e)),
    }),
  },
  {
    name: "relabel-node to its own name removes the bracket",
    edit: { kind: "relabel-node", id: "CUSTOMER", label: "CUSTOMER" },
    expected: base.replace('CUSTOMER["Customer"] {', "CUSTOMER {"),
    effect: (m) => ({ ...m, entities: m.entities.map((e) => (e.id === "CUSTOMER" ? { ...e, label: "CUSTOMER" } : e)) }),
  },
  {
    name: "relabel-edge replaces an unquoted label",
    edit: { kind: "relabel-edge", id: "CUSTOMER--ORDER", label: "places: many" },
    expected: base.replace("CUSTOMER ||--o{ ORDER : places", 'CUSTOMER ||--o{ ORDER : "places: many"'),
    effect: (m) => ({
      ...m,
      relationships: m.relationships.map((r) => (r.id === "CUSTOMER--ORDER" ? { ...r, label: "places: many" } : r)),
    }),
  },
  {
    name: "relabel-edge labels an empty one",
    edit: { kind: "relabel-edge", id: "LINE-ITEM--PRODUCT", label: "refers" },
    expected: base.replace(': ""', ': "refers"'),
    effect: (m) => ({
      ...m,
      relationships: m.relationships.map((r) => (r.id === "LINE-ITEM--PRODUCT" ? { ...r, label: "refers" } : r)),
    }),
  },
  {
    name: "relabel-edge to no label",
    edit: { kind: "relabel-edge", id: "ORDER--LINE-ITEM", label: "" },
    expected: base.replace('"is made of"', '""'),
    effect: (m) => ({
      ...m,
      relationships: m.relationships.map((r) => {
        if (r.id !== "ORDER--LINE-ITEM") return r;
        const { label: _, ...rest } = r;
        return rest;
      }),
    }),
  },
  {
    name: "delete-edge in the middle",
    edit: { kind: "delete-edge", id: "ORDER--LINE-ITEM" },
    expected: base.replace('    ORDER ||--|{ LINE-ITEM : "is made of"\r\n', ""),
    effect: (m) => ({ ...m, relationships: m.relationships.filter((r) => r.id !== "ORDER--LINE-ITEM") }),
  },
  {
    name: "delete-edge on the last line takes the break before it",
    edit: { kind: "delete-edge", id: "LINE-ITEM--PRODUCT" },
    expected: base.replace('\r\n    LINE-ITEM }o..|| PRODUCT : ""', ""),
    effect: (m) => ({ ...m, relationships: m.relationships.filter((r) => r.id !== "LINE-ITEM--PRODUCT") }),
  },
];
for (const { name, edit, expected, effect } of cases)
  test(`${name}: exact bytes and complete model effect`, async () => {
    const before = await model(base);
    const result = await editDiagram(base, edit);
    expect(result).toEqual({ ok: true, source: expected });
    expect(await model(expected)).toEqual(effect(before));
  });

test("delete-node removes a declaration with its whole attribute block", async () => {
  const source = 'erDiagram\n  A {\n    int id PK\n  }\n  %% keep\n  B["Bee"]\n  C\n';
  const before = await model(source);
  const block = await editEr(source, { kind: "delete-node", id: "A" });
  expect(block).toEqual({ ok: true, source: 'erDiagram\n  %% keep\n  B["Bee"]\n  C\n' });
  expect(await model(block.source)).toEqual({ ...before, entities: before.entities.filter((e) => e.id !== "A") });
  expect(await editEr(source, { kind: "delete-node", id: "B" })).toEqual({
    ok: true,
    source: "erDiagram\n  A {\n    int id PK\n  }\n  %% keep\n  C\n",
  });
  // The last line, with no break of its own, takes the break before it.
  const last = "erDiagram\r\n    A\r\n    B {\r\n        int id\r\n    }";
  expect(await editEr(last, { kind: "delete-node", id: "B" })).toEqual({ ok: true, source: "erDiagram\r\n    A" });
  expect(await editEr("erDiagram\n    A", { kind: "delete-node", id: "A" })).toEqual({ ok: true, source: "erDiagram" });
});

for (const newline of ["\n", "\r\n", "\r"])
  for (const ending of ["", newline])
    test(`append keeps line convention and indentation ${JSON.stringify([newline, ending])}`, async () => {
      const source =
        "﻿erDiagram" +
        newline +
        "\tdirection TB" +
        newline +
        "\tA {" +
        newline +
        "\t\tint id" +
        newline +
        "\t}" +
        ending;
      expect(await editEr(source, { kind: "add-node", id: "B", label: "Bee" })).toEqual({
        ok: true,
        source: source + (ending ? "" : newline) + '\tB["Bee"]' + ending,
      });
      expect(await editEr(source, { kind: "connect", source: "A", target: "A", label: "x" })).toEqual({
        ok: true,
        source: source + (ending ? "" : newline) + '\tA ||--o{ A : "x"' + ending,
      });
    });

test("an empty diagram takes its first entity, with the profile's four spaces", async () => {
  expect(await editEr("erDiagram", { kind: "add-node", id: "A", label: "" })).toEqual({
    ok: true,
    source: "erDiagram\n    A",
  });
  expect(await editEr("erDiagram\n", { kind: "add-node", id: "A", label: "Ay" })).toEqual({
    ok: true,
    source: 'erDiagram\n    A["Ay"]\n',
  });
  expect(await editEr("erDiagram\n    direction LR\n", { kind: "add-node", id: "A", label: "" })).toEqual({
    ok: true,
    source: "erDiagram\n    direction LR\n    A\n",
  });
});

test("no-op relabels return the source byte for byte", async () => {
  for (const edit of [
    { kind: "relabel-node", id: "CUSTOMER", label: "Customer" },
    { kind: "relabel-node", id: "PRODUCT", label: "" },
    { kind: "relabel-node", id: "PRODUCT", label: "PRODUCT" },
    { kind: "relabel-edge", id: "CUSTOMER--ORDER", label: "places" },
    { kind: "relabel-edge", id: "LINE-ITEM--PRODUCT", label: "" },
  ] as const)
    expect(await editDiagram(base, edit)).toEqual({ ok: true, source: base });
});

test("relabel-node writes the label on the declaration that holds it, not on another", async () => {
  const source = 'erDiagram\n    A\n    B\n    A ||--o{ B : x\n    B["Bee"] {\n        int id\n    }';
  expect(await editEr(source, { kind: "relabel-node", id: "B", label: "Bea" })).toEqual({
    ok: true,
    source: source.replace('B["Bee"]', 'B["Bea"]'),
  });
  expect(await editEr(source, { kind: "relabel-node", id: "A", label: "Ay" })).toEqual({
    ok: true,
    source: source.replace("    A\n", '    A["Ay"]\n'),
  });
});

test("codec: every label round-trips exactly through the compiler", async () => {
  const labels = [
    'say "hi"',
    "#quot;",
    "#35;",
    "a#b",
    "#",
    "##;",
    "; , ( ) { } [ ] :",
    "%% not a comment",
    "%%{init: {}}%%",
    "50% off",
    "}%%",
    "\\ $ ` '",
    "R&D &amp; co",
    "a < b > c",
    "emoji 🦉 ünï",
    "ﬂ°",
    "quot¶ß",
    "-- .. -. .- ---",
    "||--o{",
    "one to many",
    "zero or more TO only",
    "u",
    "PK, FK",
    ":::cls",
    "x".repeat(512),
  ];
  for (const label of labels) {
    for (const edit of [
      { kind: "relabel-node", id: "CUSTOMER", label },
      { kind: "relabel-node", id: "PRODUCT", label },
      { kind: "relabel-edge", id: "CUSTOMER--ORDER", label },
      { kind: "add-node", id: "N", label },
      { kind: "connect", source: "PRODUCT", target: "ORDER", label },
    ] as const) {
      const result = await editDiagram(base, edit);
      expect(result.ok, `${edit.kind} ${JSON.stringify(label)}: ${JSON.stringify(result)}`).toBe(true);
      const after = await model(result.source);
      const found =
        edit.kind === "relabel-edge" || edit.kind === "connect"
          ? after.relationships.find((r) => r.id === (edit.kind === "connect" ? "PRODUCT--ORDER" : edit.id))
          : after.entities.find((e) => e.id === edit.id);
      expect(found?.label).toBe(label);
    }
  }
  expect(quoteErRelationshipLabel('a "b" #c %% d % e -- f')).toBe('"a #quot;b#quot; #35;c #37;#37; d % e -- f"');
  expect(bracketErLabel('a "b" #c %% d -- e .. f - g . h % i \\ j')).toBe(
    '["a #quot;b#quot; #35;c #37;#37; d #45;#45; e #46;#46; f - g . h #37; i #92; j"]',
  );
  expect(bracketErLabel("one TO many")).toBe('["one #84;O many"]');
  expect(bracketErLabel("to go")).toBe('["to go"]');
});

test("every offered cardinality and line compiles to its two ends", async () => {
  const ends: Record<string, [Cardinality, Cardinality]> = {
    "one-to-many": ["exactly-one", "zero-or-more"],
    "one-to-one": ["exactly-one", "exactly-one"],
    "many-to-many": ["zero-or-more", "zero-or-more"],
    "zero-or-one-to-many": ["zero-or-one", "zero-or-more"],
  };
  expect(Object.keys(ends)).toEqual([...ER_CARDINALITIES]);
  for (const cardinality of ER_CARDINALITIES)
    for (const identifying of [true, false]) {
      const result = await editEr(base, {
        kind: "connect",
        source: "PRODUCT",
        target: "ORDER",
        label: "x",
        cardinality,
        identifying,
      });
      expect(result.ok).toBe(true);
      const found = (await model(result.source)).relationships.at(-1);
      expect(found).toEqual(rel("PRODUCT", "ORDER", ends[cardinality]![0], ends[cardinality]![1], identifying, "x"));
    }
});

const dashed = "erDiagram\n    A--B\n    C\n    A--B ||--o{ C : x";
const twice = "erDiagram\n    A\n    A {\n        int id\n    }";
for (const [name, source, edit, code] of [
  [
    "change-shape is flowchart-only",
    base,
    { kind: "change-shape", id: "ORDER", shape: "diamond" },
    "edit_unsupported_for_family",
  ],
  ["direction is flowchart-only", base, { kind: "direction", direction: "tb" }, "edit_unsupported_for_family"],
  ["add-node shape", base, { kind: "add-node", id: "N", label: "N", shape: "rounded" }, "edit_unsupported_for_family"],
  [
    "add-node element",
    base,
    { kind: "add-node", id: "N", label: "N", element: "System" },
    "edit_unsupported_for_family",
  ],
  ["add-node external", base, { kind: "add-node", id: "N", label: "N", external: true }, "edit_unsupported_for_family"],
  ["add-node state", base, { kind: "add-node", id: "N", label: "N", state: "choice" }, "edit_unsupported_for_family"],
  [
    "connect line",
    base,
    { kind: "connect", source: "ORDER", target: "PRODUCT", label: "x", line: "dotted" },
    "edit_unsupported_for_family",
  ],
  [
    "connect relation",
    base,
    { kind: "connect", source: "ORDER", target: "PRODUCT", label: "x", relation: "rel" },
    "edit_unsupported_for_family",
  ],
  [
    "invalid ER source",
    "erDiagram\n    A ||--o{ B : x",
    { kind: "relabel-node", id: "A", label: "B" },
    "edit_requires_valid_er",
  ],
  ["add-node digit first", base, { kind: "add-node", id: "9lives", label: "" }, "edit_invalid_id"],
  ["add-node underscore first", base, { kind: "add-node", id: "_a", label: "" }, "edit_invalid_id"],
  ["add-node dotted", base, { kind: "add-node", id: "a.b", label: "" }, "edit_invalid_id"],
  ["add-node overlong", base, { kind: "add-node", id: "x".repeat(129), label: "" }, "edit_invalid_id"],
  ["add-node holding --", base, { kind: "add-node", id: "A--B", label: "" }, "edit_invalid_id"],
  ...[
    "one",
    "MANY",
    "to",
    "to-do",
    "end",
    "end-x",
    "u-x",
    "class",
    "Style",
    "classDef",
    "subgraph",
    "direction",
    "erDiagram",
    "title",
    "titlex",
    "accTitle",
    "accDescr",
  ].map((id) => [`add-node reserved ${id}`, base, { kind: "add-node", id, label: "" }, "edit_id_reserved"]),
  ["add-node name in use", base, { kind: "add-node", id: "ORDER", label: "" }, "edit_id_exists"],
  ["add-node whitespace label", base, { kind: "add-node", id: "N", label: "   " }, "edit_invalid_label"],
  ["add-node padded label", base, { kind: "add-node", id: "N", label: " N" }, "edit_invalid_label"],
  ["add-node HTML label", base, { kind: "add-node", id: "N", label: "<b>N</b>" }, "edit_invalid_label"],
  ["add-node overlong label", base, { kind: "add-node", id: "N", label: "x".repeat(513) }, "edit_invalid_label"],
  ["add-node without a label", base, { kind: "add-node", id: "N" }, "edit_label_required"],
  [
    "connect missing endpoint",
    base,
    { kind: "connect", source: "ORDER", target: "NOBODY", label: "x" },
    "edit_target_missing",
  ],
  [
    "connect endpoint holding --",
    dashed,
    { kind: "connect", source: "C", target: "A--B", label: "x" },
    "edit_relationship_id_ambiguous",
  ],
  [
    "connect id other than the derived one",
    base,
    { kind: "connect", id: "e1", source: "ORDER", target: "PRODUCT", label: "x" },
    "edit_relationship_id_derived",
  ],
  [
    "connect unknown cardinality",
    base,
    { kind: "connect", source: "ORDER", target: "PRODUCT", label: "x", cardinality: "one-or-more" as never },
    "edit_invalid_cardinality",
  ],
  [
    "connect prototype cardinality",
    base,
    { kind: "connect", source: "ORDER", target: "PRODUCT", label: "x", cardinality: "toString" as never },
    "edit_invalid_cardinality",
  ],
  [
    "connect non-boolean identifying",
    base,
    { kind: "connect", source: "ORDER", target: "PRODUCT", label: "x", identifying: "yes" as never },
    "edit_invalid_cardinality",
  ],
  [
    "connect padded label",
    base,
    { kind: "connect", source: "ORDER", target: "PRODUCT", label: "x " },
    "edit_invalid_label",
  ],
  [
    "connect overlong id",
    `erDiagram\n    ${"A".repeat(64)}\n    ${"B".repeat(64)}`,
    { kind: "connect", source: "A".repeat(64), target: "B".repeat(64), label: "x" },
    "edit_invalid_id",
  ],
  ["relabel-node missing", base, { kind: "relabel-node", id: "NOBODY", label: "x" }, "edit_target_missing"],
  ["relabel-node padded", base, { kind: "relabel-node", id: "ORDER", label: "Order " }, "edit_invalid_label"],
  [
    "relabel-node a styled name",
    "erDiagram\n    A:::hot\n    classDef hot fill:#f00",
    { kind: "relabel-node", id: "A", label: "Ay" },
    "edit_invalid_result",
  ],
  ["relabel-edge missing", base, { kind: "relabel-edge", id: "ORDER--CUSTOMER", label: "x" }, "edit_target_missing"],
  ["relabel-edge HTML", base, { kind: "relabel-edge", id: "CUSTOMER--ORDER", label: "<i>x</i>" }, "edit_invalid_label"],
  ["delete-edge missing", base, { kind: "delete-edge", id: "ORDER--CUSTOMER" }, "edit_target_missing"],
  ["delete-node referenced as source", base, { kind: "delete-node", id: "CUSTOMER" }, "edit_delete_referenced_node"],
  ["delete-node referenced as target", base, { kind: "delete-node", id: "PRODUCT" }, "edit_delete_referenced_node"],
  ["delete-node missing", base, { kind: "delete-node", id: "NOBODY" }, "edit_target_missing"],
  [
    "delete-node styled",
    "erDiagram\n    A\n    B\n    style A fill:#f00",
    { kind: "delete-node", id: "A" },
    "edit_delete_styling_dependency",
  ],
  [
    "delete-node classed",
    "erDiagram\n    A\n    B\n    class B,A hot",
    { kind: "delete-node", id: "A" },
    "edit_delete_styling_dependency",
  ],
  ["delete-node declared twice", twice, { kind: "delete-node", id: "A" }, "edit_delete_multiple_declarations"],
] as readonly (readonly [string, string, unknown, string])[])
  test(`named refusal: ${code} (${name})`, async () => {
    expect(await editDiagram(source, edit as DiagramEdit)).toMatchObject({ ok: false, source, code });
  });

test("a styling line that names another entity does not block a delete", async () => {
  const source = "erDiagram\n    A\n    AB\n    style AB fill:#f00";
  expect(await editEr(source, { kind: "delete-node", id: "A" })).toEqual({
    ok: true,
    source: "erDiagram\n    AB\n    style AB fill:#f00",
  });
});

test("connect to an existing ordered pair names the relationship; the reverse pair is distinct", async () => {
  expect(
    await editDiagram(base, {
      kind: "connect",
      source: "CUSTOMER",
      target: "ORDER",
      label: "again",
      cardinality: "one-to-one",
    }),
  ).toEqual({ ok: false, source: base, code: "edit_relationship_exists", existingId: "CUSTOMER--ORDER" });
  expect((await editDiagram(base, { kind: "connect", source: "ORDER", target: "CUSTOMER", label: "billed" })).ok).toBe(
    true,
  );
});

test("cardinality and identifying are refused on the other families", async () => {
  const flow = "flowchart LR\na[A]\nb[B]";
  const c4 = 'C4Context\nPerson(a, "A")\nSystem(b, "B")';
  for (const source of [flow, c4])
    for (const extra of [{ cardinality: "one-to-one" }, { identifying: false }] as const)
      expect(
        await editDiagram(source, { kind: "connect", id: "a--b", source: "a", target: "b", label: "x", ...extra }),
      ).toEqual({ ok: false, source, code: "edit_unsupported_for_family" });
});
