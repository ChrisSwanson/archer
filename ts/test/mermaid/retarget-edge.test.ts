import { expect, test } from "vitest";
import { editDiagram, type DiagramEdit } from "../../src/authoring/diagram-edit.ts";
import { compile } from "../../src/mermaid/index.ts";
import type { DiagramModel } from "../../src/model/index.ts";

/** retarget-edge for flowchart, C4, ER and state: only the end names change, every other byte stays. */

async function model(source: string): Promise<DiagramModel> {
  const result = await compile(source);
  if (result.model === undefined || result.model === null) throw new Error(JSON.stringify(result.diagnostics));
  return result.model;
}
/** States compare in ID order: Mermaid's first-mention order moves with the transitions. */
const normal = (m: DiagramModel): DiagramModel =>
  m.type === "state-machine"
    ? { ...m, states: [...m.states].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) }
    : m;
type Effect = (m: any) => DiagramModel;
const edgesOf = (m: DiagramModel) =>
  m.type === "freeform-graph" ? "edges" : m.type === "state-machine" ? "transitions" : "relationships";
/** The model with connection `id` replaced by `changes`. */
const moved =
  (id: string, changes: Record<string, unknown>): Effect =>
  (m) => {
    const key = edgesOf(m);
    return { ...m, [key]: m[key].map((e: { id: string }) => (e.id === id ? { ...e, ...changes } : e)) };
  };

const flowchart = [
  "%% 🐦 keep",
  "flowchart LR",
  "  a[A]:::person",
  "  b(B)",
  "  c[C]",
  "  a e1@-.->|calls| b",
  "  %% tail",
].join("\r\n");
const c4 = [
  "%% 🐦 keep",
  "C4Container",
  '    Person(customer, "Customer", "Buys things")',
  '    System_Boundary(shop, "Web shop") {',
  '        Container(web, "Web app", "TypeScript", "Serves pages")',
  '        ContainerDb(orders,"Orders","PostgreSQL")',
  "    }",
  '    System_Ext(pay, "Payments")',
  '    Rel_D(customer, web, "Orders from", "HTTPS")',
  '    BiRel(web, pay, "Pays")',
  '    Rel(web,orders, "Reads", "SQL", "desc")',
].join("\r\n");
const er = [
  "%% 🐦 keep",
  "erDiagram",
  '    CUSTOMER["Customer"] {',
  "        string name PK",
  "    }",
  "    ORDER",
  '    LINE-ITEM["Order line"]',
  "    PRODUCT",
  "    CUSTOMER ||--o{ ORDER : places",
  '    ORDER ||--|{ LINE-ITEM : "is made of"',
  '    LINE-ITEM }o..|| PRODUCT : ""',
].join("\r\n");
const state = [
  "%% 🐦 keep",
  "stateDiagram-v2",
  '    state "Waiting for work" as Idle',
  "    Checking : Checking the queue",
  "    state Route <<choice>>",
  "    state Working {",
  "        state Fetch",
  "        state Run",
  "        [*] --> Fetch",
  "        Fetch --> Run : fetched",
  "        Run --> [*]",
  "    }",
  "    state Done",
  "    [*] --> Idle",
  "    Idle --> Checking : poll",
  "    Checking --> Route",
  "    Route --> Idle : empty",
  "    Route --> Working : job found",
  "    Working --> Done",
].join("\r\n");

const cases: { name: string; source: string; edit: DiagramEdit; expected: string; effect: Effect }[] = [
  {
    name: "flowchart target",
    source: flowchart,
    edit: { kind: "retarget-edge", id: "e1", target: "c" },
    expected: flowchart.replace("|calls| b", "|calls| c"),
    effect: moved("e1", { target: "c" }),
  },
  {
    name: "flowchart source",
    source: flowchart,
    edit: { kind: "retarget-edge", id: "e1", source: "c" },
    expected: flowchart.replace("  a e1@", "  c e1@"),
    effect: moved("e1", { source: "c" }),
  },
  {
    name: "flowchart reversed",
    source: flowchart,
    edit: { kind: "retarget-edge", id: "e1", source: "b", target: "a" },
    expected: flowchart.replace("a e1@-.->|calls| b", "b e1@-.->|calls| a"),
    effect: moved("e1", { source: "b", target: "a" }),
  },
  {
    name: "flowchart target beside an inline source declaration",
    source: "flowchart LR\n  a[A] e1@==> b\n  b[B]\n  c[C]",
    edit: { kind: "retarget-edge", id: "e1", target: "c" },
    expected: "flowchart LR\n  a[A] e1@==> c\n  b[B]\n  c[C]",
    // c is now first written on the edge's line, before b: the model records it (`sourceOrder`).
    effect: (m) => ({
      ...moved("e1", { target: "c" })(m),
      sourceOrder: {
        elements: ["a", "c", "b"].map((id) => ({ id, kind: "node" })),
        edges: ["e1"],
      },
    }),
  },
  {
    name: "C4 target keeps the direction hint and technology",
    source: c4,
    edit: { kind: "retarget-edge", id: "customer--web", target: "orders" },
    expected: c4.replace("Rel_D(customer, web,", "Rel_D(customer, orders,"),
    effect: moved("customer--web", { id: "customer--orders", target: "orders" }),
  },
  {
    name: "C4 BiRel source",
    source: c4,
    edit: { kind: "retarget-edge", id: "web--pay", source: "customer" },
    expected: c4.replace("BiRel(web, pay", "BiRel(customer, pay"),
    effect: moved("web--pay", { id: "customer--pay", source: "customer" }),
  },
  {
    name: "C4 both ends, unspaced arguments",
    source: c4,
    edit: { kind: "retarget-edge", id: "web--orders", source: "orders", target: "web" },
    expected: c4.replace("Rel(web,orders,", "Rel(orders,web,"),
    effect: moved("web--orders", { id: "orders--web", source: "orders", target: "web" }),
  },
  {
    name: "ER target: markers stay on their sides",
    source: er,
    edit: { kind: "retarget-edge", id: "CUSTOMER--ORDER", target: "PRODUCT" },
    expected: er.replace("CUSTOMER ||--o{ ORDER", "CUSTOMER ||--o{ PRODUCT"),
    effect: moved("CUSTOMER--ORDER", { id: "CUSTOMER--PRODUCT", target: "PRODUCT" }),
  },
  {
    name: "ER source: the left marker goes with the new source",
    source: er,
    edit: { kind: "retarget-edge", id: "LINE-ITEM--PRODUCT", source: "CUSTOMER" },
    expected: er.replace("LINE-ITEM }o..|| PRODUCT", "CUSTOMER }o..|| PRODUCT"),
    effect: moved("LINE-ITEM--PRODUCT", { id: "CUSTOMER--PRODUCT", source: "CUSTOMER" }),
  },
  {
    name: "ER reversed",
    source: er,
    edit: { kind: "retarget-edge", id: "ORDER--LINE-ITEM", source: "LINE-ITEM", target: "ORDER" },
    expected: er.replace("ORDER ||--|{ LINE-ITEM", "LINE-ITEM ||--|{ ORDER"),
    effect: moved("ORDER--LINE-ITEM", { id: "LINE-ITEM--ORDER", source: "LINE-ITEM", target: "ORDER" }),
  },
  {
    name: "state target",
    source: state,
    edit: { kind: "retarget-edge", id: "Idle--Checking", target: "Route" },
    expected: state.replace("Idle --> Checking : poll", "Idle --> Route : poll"),
    effect: moved("Idle--Checking", { id: "Idle--Route", target: "Route" }),
  },
  {
    name: "state target to the end adds root_end",
    source: state,
    edit: { kind: "retarget-edge", id: "Checking--Route", target: "[*]" },
    expected: state.replace("Checking --> Route", "Checking --> [*]"),
    effect: (m) =>
      ({
        ...moved("Checking--Route", { id: "Checking--root_end", target: "root_end" })(m),
        states: [...m.states, { id: "root_end", label: "end", kind: "final" }],
      }) as DiagramModel,
  },
  {
    name: "state source away from the start drops root_start",
    source: state,
    edit: { kind: "retarget-edge", id: "root_start--Idle", source: "Checking" },
    expected: state.replace("    [*] --> Idle", "    Checking --> Idle"),
    effect: (m) =>
      ({
        ...moved("root_start--Idle", { id: "Checking--Idle", source: "Checking" })(m),
        states: m.states.filter((s: { id: string }) => s.id !== "root_start"),
      }) as DiagramModel,
  },
  {
    name: "state [*] inside a composite is that scope's end",
    source: state,
    edit: { kind: "retarget-edge", id: "Fetch--Run", target: "[*]" },
    expected: state.replace("Fetch --> Run : fetched", "Fetch --> [*] : fetched"),
    effect: moved("Fetch--Run", { id: "Fetch--Working_end", target: "Working_end" }),
  },
  {
    name: "state end chosen by its ID is written [*]",
    source: state,
    edit: { kind: "retarget-edge", id: "Fetch--Run", target: "Working_end" },
    expected: state.replace("Fetch --> Run : fetched", "Fetch --> [*] : fetched"),
    effect: moved("Fetch--Run", { id: "Fetch--Working_end", target: "Working_end" }),
  },
];
for (const { name, source, edit, expected, effect } of cases)
  test(`retarget-edge ${name}: exact splice and complete model effect`, async () => {
    const before = await model(source);
    const result = await editDiagram(source, edit);
    expect(result).toEqual({ ok: true, source: expected });
    expect(normal(await model(result.source))).toEqual(normal(effect(before)));
  });

test("retarget-edge to the same ends is a byte-identical no-op", async () => {
  for (const [source, edit] of [
    [flowchart, { kind: "retarget-edge", id: "e1", source: "a", target: "b" }],
    [c4, { kind: "retarget-edge", id: "web--pay", target: "pay" }],
    [er, { kind: "retarget-edge", id: "CUSTOMER--ORDER", source: "CUSTOMER" }],
    [state, { kind: "retarget-edge", id: "root_start--Idle", source: "[*]" }],
    [state, { kind: "retarget-edge", id: "Run--Working_end", target: "Working_end" }],
  ] as [string, DiagramEdit][])
    expect(await editDiagram(source, edit), JSON.stringify(edit)).toEqual({ ok: true, source });
});

test("retarget-edge keeps LF and CR line endings and a missing final break", async () => {
  for (const newline of ["\n", "\r"])
    for (const ending of ["", newline]) {
      const source =
        ["stateDiagram-v2", "    state A", "    state B", "    state C", "    A --> B", "    B --> C"].join(newline) +
        ending;
      const result = await editDiagram(source, { kind: "retarget-edge", id: "B--C", source: "A" });
      expect(result).toEqual({ ok: true, source: source.replace(`B --> C`, "A --> C") });
    }
});

const C4_STYLED = `${c4}\r\n    UpdateRelStyle(web, pay, $textColor="red")`;
const ER_CLASSED =
  er.replace("CUSTOMER ||--o{ ORDER", "CUSTOMER:::vip ||--o{ ORDER") + "\r\n    classDef vip fill:#f00";
const STATE_CLASSED = `${state}\r\n    Idle --> Done:::hot\r\n    classDef hot fill:#f00`;
for (const [name, source, edit, code, existingId] of [
  ["no ends", flowchart, { kind: "retarget-edge", id: "e1" }, "edit_endpoint_required"],
  [
    "message is sequence-only",
    flowchart,
    { kind: "retarget-edge", id: "e1", target: "c", message: "sync" },
    "edit_unsupported_for_family",
  ],
  ["flowchart unknown edge", flowchart, { kind: "retarget-edge", id: "e9", target: "c" }, "edit_target_missing"],
  ["flowchart unknown node", flowchart, { kind: "retarget-edge", id: "e1", target: "z" }, "edit_target_missing"],
  [
    "flowchart group is not a node",
    "flowchart LR\n  subgraph g[G]\n    c[C]\n  end\n  a[A]\n  b[B]\n  a e1@--> b",
    { kind: "retarget-edge", id: "e1", target: "g" },
    "edit_target_missing",
  ],
  [
    "flowchart chained statement",
    "flowchart LR\n  a[A]\n  b[B]\n  c[C]\n  a e1@--> b e2@--> c",
    { kind: "retarget-edge", id: "e1", target: "c" },
    "edit_requires_valid_flowchart",
  ],
  ["C4 unknown relationship", c4, { kind: "retarget-edge", id: "pay--web", target: "orders" }, "edit_target_missing"],
  ["C4 unknown element", c4, { kind: "retarget-edge", id: "web--pay", target: "bank" }, "edit_target_missing"],
  ["C4 boundary end", c4, { kind: "retarget-edge", id: "web--pay", target: "shop" }, "edit_endpoint_boundary"],
  [
    "C4 pair exists",
    c4,
    { kind: "retarget-edge", id: "web--pay", target: "orders" },
    "edit_relationship_exists",
    "web--orders",
  ],
  [
    "C4 UpdateRelStyle names the pair",
    C4_STYLED,
    { kind: "retarget-edge", id: "web--pay", source: "customer" },
    "edit_retarget_styling_dependency",
  ],
  ["ER unknown entity", er, { kind: "retarget-edge", id: "CUSTOMER--ORDER", target: "INVOICE" }, "edit_target_missing"],
  [
    "ER pair exists",
    er,
    { kind: "retarget-edge", id: "ORDER--LINE-ITEM", source: "CUSTOMER", target: "ORDER" },
    "edit_relationship_exists",
    "CUSTOMER--ORDER",
  ],
  [
    "ER name holding --",
    `${er}\r\n    A--B`,
    { kind: "retarget-edge", id: "CUSTOMER--ORDER", target: "A--B" },
    "edit_relationship_id_ambiguous",
  ],
  [
    "ER classed end",
    ER_CLASSED,
    { kind: "retarget-edge", id: "CUSTOMER--ORDER", source: "PRODUCT" },
    "edit_retarget_inline_declaration",
  ],
  [
    "state unknown transition",
    state,
    { kind: "retarget-edge", id: "Done--Idle", target: "Route" },
    "edit_target_missing",
  ],
  [
    "state unknown state",
    state,
    { kind: "retarget-edge", id: "Idle--Checking", target: "Nope" },
    "edit_target_missing",
  ],
  [
    "state across scopes",
    state,
    { kind: "retarget-edge", id: "Idle--Checking", target: "Fetch" },
    "edit_scope_mismatch",
  ],
  [
    "state another scope's end",
    state,
    { kind: "retarget-edge", id: "Idle--Checking", target: "Working_end" },
    "edit_start_end_scope",
  ],
  [
    "state start as a target",
    state,
    { kind: "retarget-edge", id: "Idle--Checking", target: "root_start" },
    "edit_invalid_endpoint",
  ],
  [
    "state marker to marker",
    state,
    { kind: "retarget-edge", id: "root_start--Idle", target: "[*]" },
    "edit_invalid_endpoint",
  ],
  [
    "state pair exists",
    state,
    { kind: "retarget-edge", id: "Route--Idle", source: "[*]" },
    "edit_relationship_exists",
    "root_start--Idle",
  ],
  [
    "state leaves a bare state undrawn",
    state,
    { kind: "retarget-edge", id: "Working--Done", target: "[*]" },
    "edit_retarget_leaves_undrawn_state",
  ],
  [
    "state classed end",
    STATE_CLASSED,
    { kind: "retarget-edge", id: "Idle--Done", target: "Route" },
    "edit_retarget_inline_declaration",
  ],
] as [string, string, DiagramEdit, string, string?][])
  test(`retarget-edge refusal: ${name} → ${code}`, async () => {
    expect(await editDiagram(source, edit)).toMatchObject(
      existingId === undefined ? { ok: false, source, code } : { ok: false, source, code, existingId },
    );
  });
