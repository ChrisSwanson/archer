import { expect, test } from "vitest";
import { editC4, quoteC4 } from "../../src/authoring/c4-edit.ts";
import { editDiagram, type DiagramEdit } from "../../src/authoring/diagram-edit.ts";
import { compile } from "../../src/mermaid/index.ts";
import type { C4Model } from "../../src/model/index.ts";

const base = [
  "%% 🐦 keep",
  "C4Container",
  "    title Shop",
  '    Person(customer, "Customer", "Buys things")',
  '    System_Boundary(shop, "Web shop") {',
  '        Container(web, "Web app", "TypeScript", "Serves pages")',
  '        ContainerDb(orders,"Orders","PostgreSQL")',
  "    }",
  "    %% between",
  '    System_Ext(pay, "Payments")',
  '    Rel_D(customer, web, "Orders from", "HTTPS")',
  '    BiRel(web, pay, "Pays")',
  '    Rel(web, orders, "Reads", "SQL", "desc")',
].join("\r\n");

async function model(source: string): Promise<C4Model> {
  const result = await compile(source);
  if (result.model?.type !== "c4-model") throw new Error(JSON.stringify(result.diagnostics));
  return result.model;
}

const cases: { name: string; edit: DiagramEdit; expected: string; effect: (m: C4Model) => C4Model }[] = [
  {
    name: "add-node Person",
    edit: { kind: "add-node", id: "admin", label: "Admin", element: "Person" },
    expected: base + '\r\n    Person(admin, "Admin")',
    effect: (m) => ({ ...m, elements: [...m.elements, { id: "admin", kind: "person", label: "Admin" }] }),
  },
  {
    name: "add-node ContainerQueue external",
    edit: { kind: "add-node", id: "q_1", label: 'Jobs "fast" #1', element: "ContainerQueue", external: true },
    expected: base + '\r\n    ContainerQueue_Ext(q_1, "Jobs #quot;fast#quot; #35;1")',
    effect: (m) => ({
      ...m,
      elements: [
        ...m.elements,
        { id: "q_1", kind: "container", label: 'Jobs "fast" #1', external: true, shape: "queue" },
      ],
    }),
  },
  {
    name: "add-node external false writes no suffix",
    edit: { kind: "add-node", id: "db", label: "DB", element: "SystemDb", external: false },
    expected: base + '\r\n    SystemDb(db, "DB")',
    effect: (m) => ({ ...m, elements: [...m.elements, { id: "db", kind: "system", label: "DB", shape: "database" }] }),
  },
  {
    name: "connect rel",
    edit: { kind: "connect", source: "pay", target: "customer", label: "Bills" },
    expected: base + '\r\n    Rel(pay, customer, "Bills")',
    effect: (m) => ({
      ...m,
      relationships: [...m.relationships, { id: "pay--customer", source: "pay", target: "customer", label: "Bills" }],
    }),
  },
  {
    name: "connect birel with matching derived id",
    edit: { kind: "connect", id: "orders--pay", source: "orders", target: "pay", label: "Syncs", relation: "birel" },
    expected: base + '\r\n    BiRel(orders, pay, "Syncs")',
    effect: (m) => ({
      ...m,
      relationships: [
        ...m.relationships,
        { id: "orders--pay", source: "orders", target: "pay", label: "Syncs", bidirectional: true },
      ],
    }),
  },
  {
    name: "connect self-relationship (the profile allows it)",
    edit: { kind: "connect", source: "web", target: "web", label: "Retries" },
    expected: base + '\r\n    Rel(web, web, "Retries")',
    effect: (m) => ({
      ...m,
      relationships: [...m.relationships, { id: "web--web", source: "web", target: "web", label: "Retries" }],
    }),
  },
  {
    name: "relabel-node keeps technology and description",
    edit: { kind: "relabel-node", id: "web", label: "SPA" },
    expected: base.replace('Container(web, "Web app", "TypeScript"', 'Container(web, "SPA", "TypeScript"'),
    effect: (m) => ({ ...m, elements: m.elements.map((e) => (e.id === "web" ? { ...e, label: "SPA" } : e)) }),
  },
  {
    name: "relabel-node with no spaces between arguments",
    edit: { kind: "relabel-node", id: "orders", label: "Orders & co" },
    expected: base.replace(
      'ContainerDb(orders,"Orders","PostgreSQL")',
      'ContainerDb(orders,"Orders & co","PostgreSQL")',
    ),
    effect: (m) => ({
      ...m,
      elements: m.elements.map((e) => (e.id === "orders" ? { ...e, label: "Orders & co" } : e)),
    }),
  },
  {
    name: "relabel-node _Ext",
    edit: { kind: "relabel-node", id: "pay", label: "Stripe" },
    expected: base.replace('System_Ext(pay, "Payments")', 'System_Ext(pay, "Stripe")'),
    effect: (m) => ({ ...m, elements: m.elements.map((e) => (e.id === "pay" ? { ...e, label: "Stripe" } : e)) }),
  },
  {
    name: "relabel-node boundary",
    edit: { kind: "relabel-node", id: "shop", label: "Shop (core)" },
    expected: base.replace('System_Boundary(shop, "Web shop") {', 'System_Boundary(shop, "Shop (core)") {'),
    effect: (m) => ({
      ...m,
      boundaries: m.boundaries.map((b) => (b.id === "shop" ? { ...b, label: "Shop (core)" } : b)),
    }),
  },
  {
    name: "relabel-edge Rel_D keeps technology",
    edit: { kind: "relabel-edge", id: "customer--web", label: "Buys, via" },
    expected: base.replace(
      'Rel_D(customer, web, "Orders from", "HTTPS")',
      'Rel_D(customer, web, "Buys, via", "HTTPS")',
    ),
    effect: (m) => ({
      ...m,
      relationships: m.relationships.map((r) => (r.id === "customer--web" ? { ...r, label: "Buys, via" } : r)),
    }),
  },
  {
    name: "relabel-edge Rel keeps technology and description",
    edit: { kind: "relabel-edge", id: "web--orders", label: "Writes" },
    expected: base.replace('"Reads", "SQL", "desc"', '"Writes", "SQL", "desc"'),
    effect: (m) => ({
      ...m,
      relationships: m.relationships.map((r) => (r.id === "web--orders" ? { ...r, label: "Writes" } : r)),
    }),
  },
  {
    name: "delete-edge in the middle",
    edit: { kind: "delete-edge", id: "web--pay" },
    expected: base.replace('    BiRel(web, pay, "Pays")\r\n', ""),
    effect: (m) => ({ ...m, relationships: m.relationships.filter((r) => r.id !== "web--pay") }),
  },
  {
    name: "delete-edge on the last line takes the break before it",
    edit: { kind: "delete-edge", id: "web--orders" },
    expected: base.replace('\r\n    Rel(web, orders, "Reads", "SQL", "desc")', ""),
    effect: (m) => ({ ...m, relationships: m.relationships.filter((r) => r.id !== "web--orders") }),
  },
];
for (const { name, edit, expected, effect } of cases)
  test(`${name}: exact bytes and complete model effect`, async () => {
    const before = await model(base);
    const result = await editDiagram(base, edit);
    expect(result).toEqual({ ok: true, source: expected });
    expect(await model(expected)).toEqual(effect(before));
  });

test("delete-node removes an unreferenced element line, inside a boundary too", async () => {
  const source =
    'C4Context\n  Person(a, "A")\n  Boundary(b, "B") {\n\tSystem(x, "X")\n\tSystem(y, "Y")\n  }\n  %% keep\n';
  const before = await model(source);
  const top = await editC4(source, { kind: "delete-node", id: "a" });
  expect(top).toEqual({
    ok: true,
    source: 'C4Context\n  Boundary(b, "B") {\n\tSystem(x, "X")\n\tSystem(y, "Y")\n  }\n  %% keep\n',
  });
  const inner = await editC4(source, { kind: "delete-node", id: "x" });
  expect(inner).toEqual({
    ok: true,
    source: 'C4Context\n  Person(a, "A")\n  Boundary(b, "B") {\n\tSystem(y, "Y")\n  }\n  %% keep\n',
  });
  expect(await model(inner.source)).toEqual({ ...before, elements: before.elements.filter((e) => e.id !== "x") });
});

test("delete-node may empty a boundary of elements when it still holds a boundary", async () => {
  const source = 'C4Context\nBoundary(b, "B") {\nSystem(x, "X")\nBoundary(c, "C") {\nSystem(y, "Y")\n}\n}';
  expect(await editC4(source, { kind: "delete-node", id: "x" })).toEqual({
    ok: true,
    source: 'C4Context\nBoundary(b, "B") {\nBoundary(c, "C") {\nSystem(y, "Y")\n}\n}',
  });
});

for (const newline of ["\n", "\r\n", "\r"])
  for (const ending of ["", newline])
    test(`append keeps line convention and indentation ${JSON.stringify([newline, ending])}`, async () => {
      const source =
        "﻿C4Context" +
        newline +
        '\tPerson(a, "A")' +
        newline +
        '\tBoundary(b, "B") {' +
        newline +
        '\t\tSystem(x, "X")' +
        newline +
        "\t}" +
        ending;
      const result = await editC4(source, { kind: "add-node", id: "c", label: "C", element: "Component" });
      expect(result).toEqual({ ok: true, source: source + (ending ? "" : newline) + '\tComponent(c, "C")' + ending });
    });

test("append takes the indent of the last top-level statement, not of a boundary's contents", async () => {
  const source = 'C4Context\n  Boundary(b, "B") {\n      System(x, "X")\n  }';
  expect(await editC4(source, { kind: "connect", source: "x", target: "x", label: "Loops" })).toEqual({
    ok: true,
    source: source + '\n  Rel(x, x, "Loops")',
  });
});

test("no-op relabels return the source byte for byte", async () => {
  for (const edit of [
    { kind: "relabel-node", id: "web", label: "Web app" },
    { kind: "relabel-node", id: "shop", label: "Web shop" },
    { kind: "relabel-edge", id: "web--pay", label: "Pays" },
  ] as const)
    expect(await editDiagram(base, edit)).toEqual({ ok: true, source: base });
});

test("codec: every label round-trips exactly through the compiler", async () => {
  const labels = [
    'say "hi"',
    "#quot;",
    "#35;",
    "a#b",
    "#",
    "##;",
    "; , ( ) { }",
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
    "x".repeat(512),
  ];
  for (const label of labels) {
    for (const edit of [
      { kind: "relabel-node", id: "web", label },
      { kind: "relabel-edge", id: "web--pay", label },
      { kind: "add-node", id: "n", label, element: "System" },
    ] as const) {
      const result = await editDiagram(base, edit);
      expect(result.ok, `${edit.kind} ${JSON.stringify(label)}`).toBe(true);
      const after = await model(result.source);
      const found =
        edit.kind === "relabel-edge"
          ? after.relationships.find((r) => r.id === edit.id)
          : after.elements.find((e) => e.id === edit.id);
      expect(found?.label).toBe(label);
    }
  }
  expect(quoteC4('a "b" #c %% d % e')).toBe('"a #quot;b#quot; #35;c #37;#37; d % e"');
});

for (const [name, source, edit, code] of [
  [
    "change-shape is flowchart-only",
    base,
    { kind: "change-shape", id: "web", shape: "diamond" },
    "edit_unsupported_for_family",
  ],
  ["direction is flowchart-only", base, { kind: "direction", direction: "tb" }, "edit_unsupported_for_family"],
  [
    "add-node shape is flowchart-only",
    base,
    { kind: "add-node", id: "n", label: "N", element: "System", shape: "rounded" },
    "edit_unsupported_for_family",
  ],
  [
    "connect line is flowchart-only",
    base,
    { kind: "connect", source: "web", target: "customer", label: "x", line: "dotted" },
    "edit_unsupported_for_family",
  ],
  [
    "invalid C4 source",
    "C4Context\nSystem(a, A)",
    { kind: "relabel-node", id: "a", label: "B" },
    "edit_requires_valid_c4",
  ],
  ["add-node needs an element", base, { kind: "add-node", id: "n", label: "N" }, "edit_element_required"],
  [
    "add-node unknown element",
    base,
    { kind: "add-node", id: "n", label: "N", element: "Person_Ext" as never },
    "edit_invalid_element",
  ],
  [
    "add-node hyphenated alias",
    base,
    { kind: "add-node", id: "a-b", label: "N", element: "System" },
    "edit_invalid_id",
  ],
  [
    "add-node leading underscore alias",
    base,
    { kind: "add-node", id: "_a", label: "N", element: "System" },
    "edit_invalid_id",
  ],
  [
    "add-node overlong alias",
    base,
    { kind: "add-node", id: "x".repeat(129), label: "N", element: "System" },
    "edit_invalid_id",
  ],
  [
    "add-node reserved alias",
    base,
    { kind: "add-node", id: "global", label: "N", element: "System" },
    "edit_id_reserved",
  ],
  [
    "add-node element alias in use",
    base,
    { kind: "add-node", id: "web", label: "N", element: "System" },
    "edit_id_exists",
  ],
  [
    "add-node boundary alias in use",
    base,
    { kind: "add-node", id: "shop", label: "N", element: "System" },
    "edit_id_exists",
  ],
  [
    "add-node whitespace label",
    base,
    { kind: "add-node", id: "n", label: "   ", element: "System" },
    "edit_invalid_label",
  ],
  ["add-node padded label", base, { kind: "add-node", id: "n", label: " N", element: "System" }, "edit_invalid_label"],
  [
    "add-node HTML label",
    base,
    { kind: "add-node", id: "n", label: "<b>N</b>", element: "System" },
    "edit_invalid_label",
  ],
  [
    "add-node overlong label",
    base,
    { kind: "add-node", id: "n", label: "x".repeat(513), element: "System" },
    "edit_invalid_label",
  ],
  ["connect without label", base, { kind: "connect", source: "pay", target: "customer" }, "edit_label_required"],
  [
    "connect empty label",
    base,
    { kind: "connect", source: "pay", target: "customer", label: "" },
    "edit_label_required",
  ],
  [
    "connect missing endpoint",
    base,
    { kind: "connect", source: "pay", target: "nobody", label: "x" },
    "edit_target_missing",
  ],
  [
    "connect boundary endpoint",
    base,
    { kind: "connect", source: "customer", target: "shop", label: "x" },
    "edit_endpoint_boundary",
  ],
  [
    "connect id other than the derived one",
    base,
    { kind: "connect", id: "e1", source: "pay", target: "customer", label: "x" },
    "edit_relationship_id_derived",
  ],
  [
    "connect unknown relation",
    base,
    { kind: "connect", source: "pay", target: "customer", label: "x", relation: "rel_d" as never },
    "edit_invalid_relation",
  ],
  ["relabel-node missing", base, { kind: "relabel-node", id: "nobody", label: "x" }, "edit_target_missing"],
  ["relabel-node padded", base, { kind: "relabel-node", id: "web", label: "Web " }, "edit_invalid_label"],
  ["relabel-edge whitespace", base, { kind: "relabel-edge", id: "web--pay", label: " " }, "edit_label_required"],
  [
    "add-node to a header after a directive",
    "%%{init: {}}%%\nC4Context\n",
    { kind: "add-node", id: "a", label: "A", element: "Person" },
    "edit_requires_valid_c4",
  ],
  ["relabel on a header alone", "C4Context\n", { kind: "relabel-node", id: "a", label: "A" }, "edit_requires_valid_c4"],
  ["relabel-edge missing", base, { kind: "relabel-edge", id: "pay--web", label: "x" }, "edit_target_missing"],
  ["relabel-edge empty", base, { kind: "relabel-edge", id: "web--pay", label: "" }, "edit_label_required"],
  ["delete-edge missing", base, { kind: "delete-edge", id: "pay--web" }, "edit_target_missing"],
  ["delete-node referenced", base, { kind: "delete-node", id: "pay" }, "edit_delete_referenced_node"],
  ["delete-node missing", base, { kind: "delete-node", id: "nobody" }, "edit_target_missing"],
  ["delete-node boundary", base, { kind: "delete-node", id: "shop" }, "edit_delete_boundary_unsupported"],
  [
    "delete-node last in boundary",
    'C4Context\nPerson(a, "A")\nBoundary(b, "B") {\nSystem(x, "X")\n}',
    { kind: "delete-node", id: "x" },
    "edit_delete_last_in_boundary",
  ],
  [
    "delete-node styled",
    'C4Context\nPerson(a, "A")\nUpdateElementStyle(a, $fontColor="red")',
    { kind: "delete-node", id: "a" },
    "edit_delete_styling_dependency",
  ],
  [
    "delete-edge styled",
    'C4Context\nPerson(a, "A")\nSystem(b, "B")\nRel(a, b, "x")\nUpdateRelStyle(a, b, $textColor="red")',
    { kind: "delete-edge", id: "a--b" },
    "edit_delete_styling_dependency",
  ],
] as const)
  test(`named refusal: ${code} (${name})`, async () => {
    expect(await editDiagram(source, edit as DiagramEdit)).toMatchObject({ ok: false, source, code });
  });

test("connect to an existing ordered pair names the relationship", async () => {
  expect(
    await editDiagram(base, { kind: "connect", source: "customer", target: "web", label: "Again", relation: "birel" }),
  ).toEqual({ ok: false, source: base, code: "edit_relationship_exists", existingId: "customer--web" });
  // The reverse pair is a different relationship.
  expect((await editDiagram(base, { kind: "connect", source: "web", target: "customer", label: "Replies" })).ok).toBe(
    true,
  );
});

test("dispatch: flowchart ops keep their shape; families without an editor are refused", async () => {
  const flow = "flowchart LR\na[A]\nb[B]";
  expect(await editDiagram(flow, { kind: "connect", id: "e1", source: "a", target: "b" })).toEqual({
    ok: true,
    source: flow + "\na e1@--> b",
  });
  expect(await editDiagram(flow, { kind: "connect", source: "a", target: "b" })).toEqual({
    ok: false,
    source: flow,
    code: "edit_id_required",
  });
  expect(await editDiagram(flow, { kind: "connect", id: "e1", source: "a", target: "b", relation: "rel" })).toEqual({
    ok: false,
    source: flow,
    code: "edit_unsupported_for_family",
  });
  expect(await editDiagram(flow, { kind: "add-node", id: "c", label: "C", element: "System" })).toEqual({
    ok: false,
    source: flow,
    code: "edit_unsupported_for_family",
  });
  expect(await editDiagram("flowchart LR\na[A]\na[A]", { kind: "relabel-node", id: "a", label: "X" })).toMatchObject({
    ok: false,
    source: "flowchart LR\na[A]\na[A]",
    code: "edit_requires_valid_flowchart",
  });
  // Sequence has its own editor now: an undeclared participant keeps its family's code.
  const sequence = "sequenceDiagram\nA->>B: hi";
  expect(await editDiagram(sequence, { kind: "relabel-node", id: "A", label: "X" })).toMatchObject({
    ok: false,
    source: sequence,
    code: "edit_requires_valid_sequence",
  });
  const journey = "journey\n  title T\n  section S\n    Task: 5: Me";
  expect(await editDiagram(journey, { kind: "relabel-node", id: "A", label: "X" })).toEqual({
    ok: false,
    source: journey,
    code: "edit_unsupported_family",
  });
});

test("append uses four spaces under a header alone", async () => {
  expect(await editC4("C4Context\n", { kind: "add-node", id: "a", label: "A", element: "Person" })).toEqual({
    ok: true,
    source: 'C4Context\n    Person(a, "A")\n',
  });
});

test("an element can be drawn blank, labelled, and cleared again, like a flowchart shape", async () => {
  const added = await editC4("C4Context\n", { kind: "add-node", id: "node_a", label: "", element: "System" });
  expect(added).toEqual({ ok: true, source: 'C4Context\n    System(node_a, "")\n' });
  expect((await model(added.source)).elements).toEqual([{ id: "node_a", kind: "system", label: "" }]);
  const labeled = await editC4(added.source, { kind: "relabel-node", id: "node_a", label: "API" });
  expect(labeled).toEqual({ ok: true, source: 'C4Context\n    System(node_a, "API")\n' });
  expect(await editC4(labeled.source, { kind: "relabel-node", id: "node_a", label: "" })).toEqual(added);
  expect(await editC4(added.source, { kind: "relabel-node", id: "node_a", label: "" })).toEqual(added);
});
// smoke-a#12:d. The page shows a relationship as `text [technology]`, but relabel-edge sets the label only:
// the technology argument is never parsed out of, or removed by, the label. Removing the bracket on the page
// therefore keeps the technology; typing one writes it literally into the label.
test("relabel-edge never reads or removes the technology through the label", async () => {
  const plain = await editDiagram(base, { kind: "relabel-edge", id: "customer--web", label: "Orders" });
  expect(plain).toEqual({ ok: true, source: base.replace('"Orders from", "HTTPS"', '"Orders", "HTTPS"') });
  expect((await model(plain.source)).relationships.find((r) => r.id === "customer--web")).toMatchObject({
    label: "Orders",
    technology: "HTTPS",
  });
  const bracketed = await editDiagram(base, { kind: "relabel-edge", id: "customer--web", label: "Orders [HTTPS]" });
  expect(bracketed).toEqual({ ok: true, source: base.replace('"Orders from", "HTTPS"', '"Orders [HTTPS]", "HTTPS"') });
  expect((await model(bracketed.source)).relationships.find((r) => r.id === "customer--web")).toMatchObject({
    label: "Orders [HTTPS]",
    technology: "HTTPS",
  });
});
