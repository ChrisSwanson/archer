import { expect, test } from "vitest";
import { editState, encodeStateLabel, STATE_NODE_KINDS } from "../../src/authoring/state-edit.ts";
import { editDiagram, type DiagramEdit } from "../../src/authoring/diagram-edit.ts";
import { parseAuthoringPreview } from "../../src/authoring/preview.ts";
import { AuthoringInputError } from "../../../shared/authoring-contract.mts";
import { compile } from "../../src/mermaid/index.ts";
import type { StateMachine } from "../../src/model/index.ts";

const base = [
  "%% 🐦 keep",
  "stateDiagram-v2",
  "    direction LR",
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
  "    %% between",
  "    [*] --> Idle",
  "    Idle --> Checking : poll",
  "    Checking --> Route",
  "    Route --> Idle : empty",
  "    Route --> Working : job found",
  "    Working --> Done",
  "    note right of Idle : waits",
].join("\r\n");

async function model(source: string): Promise<StateMachine> {
  const result = await compile(source);
  if (result.model?.type !== "state-machine") throw new Error(JSON.stringify(result.diagnostics));
  return result.model;
}
const byId = (m: StateMachine): StateMachine => ({
  ...m,
  states: [...m.states].sort((a, b) => a.id.localeCompare(b.id)),
});
const relabel = (m: StateMachine, id: string, label: string) => ({
  ...m,
  states: m.states.map((s) => (s.id === id ? { ...s, label } : s)),
});
const relabelEdge = (m: StateMachine, id: string, label?: string) => ({
  ...m,
  transitions: m.transitions.map((t) => {
    if (t.id !== id) return t;
    const { label: _old, ...rest } = t;
    return label === undefined ? rest : { ...rest, label };
  }),
});

const cases: { name: string; edit: DiagramEdit; expected: string; effect: (m: StateMachine) => StateMachine }[] = [
  {
    name: "add-node state",
    edit: { kind: "add-node", id: "Failed", label: "Gave up" },
    expected: base + '\r\n    state "Gave up" as Failed',
    effect: (m) => ({ ...m, states: [...m.states, { id: "Failed", label: "Gave up" }] }),
  },
  {
    name: "add-node state with an empty label takes its ID as the label",
    edit: { kind: "add-node", id: "Failed", label: "" },
    expected: base + '\r\n    state "Failed" as Failed',
    effect: (m) => ({ ...m, states: [...m.states, { id: "Failed", label: "Failed" }] }),
  },
  ...(["choice", "fork", "join"] as const).map((kind) => ({
    name: `add-node ${kind}`,
    edit: { kind: "add-node", id: "P1", label: "", state: kind } as DiagramEdit,
    expected: base + `\r\n    state P1 <<${kind}>>`,
    effect: (m: StateMachine) => ({ ...m, states: [...m.states, { id: "P1", label: "P1", kind }] }),
  })),
  {
    name: "connect top level with a coded label",
    edit: { kind: "connect", source: "Done", target: "Idle", label: "reset; again" },
    expected: base + "\r\n    Done --> Idle : reset#59; again",
    effect: (m) => ({
      ...m,
      transitions: [...m.transitions, { id: "Done--Idle", source: "Done", target: "Idle", label: "reset; again" }],
    }),
  },
  {
    name: "connect to [*] adds the top-level end",
    edit: { kind: "connect", source: "Done", target: "[*]" },
    expected: base + "\r\n    Done --> [*]",
    effect: (m) => ({
      ...m,
      states: [...m.states, { id: "root_end", label: "end", kind: "final" }],
      transitions: [...m.transitions, { id: "Done--root_end", source: "Done", target: "root_end" }],
    }),
  },
  {
    name: "connect from an existing start by its ID",
    edit: { kind: "connect", id: "root_start--Checking", source: "root_start", target: "Checking" },
    expected: base + "\r\n    [*] --> Checking",
    effect: (m) => ({
      ...m,
      transitions: [...m.transitions, { id: "root_start--Checking", source: "root_start", target: "Checking" }],
    }),
  },
  {
    name: "connect inside a composite goes before its }",
    edit: { kind: "connect", source: "Run", target: "Fetch", label: "retry" },
    expected: base.replace("        Run --> [*]\r\n", "        Run --> [*]\r\n        Run --> Fetch : retry\r\n"),
    effect: (m) => ({
      ...m,
      transitions: [
        ...m.transitions.slice(0, 3),
        { id: "Run--Fetch", source: "Run", target: "Fetch", label: "retry" },
        ...m.transitions.slice(3),
      ],
    }),
  },
  {
    name: "connect to a composite's end by its ID",
    edit: { kind: "connect", source: "Fetch", target: "Working_end" },
    expected: base.replace("        Run --> [*]\r\n", "        Run --> [*]\r\n        Fetch --> [*]\r\n"),
    effect: (m) => ({
      ...m,
      transitions: [
        ...m.transitions.slice(0, 3),
        { id: "Fetch--Working_end", source: "Fetch", target: "Working_end" },
        ...m.transitions.slice(3),
      ],
    }),
  },
  {
    name: "connect a state to itself",
    edit: { kind: "connect", source: "Idle", target: "Idle", label: "tick" },
    expected: base + "\r\n    Idle --> Idle : tick",
    effect: (m) => ({
      ...m,
      transitions: [...m.transitions, { id: "Idle--Idle", source: "Idle", target: "Idle", label: "tick" }],
    }),
  },
  {
    name: "relabel-node quoted form",
    edit: { kind: "relabel-node", id: "Idle", label: 'Say "hi"' },
    expected: base.replace('state "Waiting for work" as Idle', 'state "Say #quot;hi#quot;" as Idle'),
    effect: (m) => relabel(m, "Idle", 'Say "hi"'),
  },
  {
    name: "relabel-node described form",
    edit: { kind: "relabel-node", id: "Checking", label: "Polling: A --> B" },
    expected: base.replace("Checking : Checking the queue", "Checking : Polling: A --#62; B"),
    effect: (m) => relabel(m, "Checking", "Polling: A --> B"),
  },
  {
    name: "relabel-node upgrades a bare state",
    edit: { kind: "relabel-node", id: "Done", label: "Finished" },
    expected: base.replace("    state Done\r\n", '    state "Finished" as Done\r\n'),
    effect: (m) => relabel(m, "Done", "Finished"),
  },
  {
    name: "relabel-node a composite keeps its block",
    edit: { kind: "relabel-node", id: "Working", label: "Working hard" },
    expected: base.replace("    state Working {", '    state "Working hard" as Working {'),
    effect: (m) => relabel(m, "Working", "Working hard"),
  },
  {
    name: "relabel-node inside a composite",
    edit: { kind: "relabel-node", id: "Run", label: "Running" },
    expected: base.replace("        state Run\r\n", '        state "Running" as Run\r\n'),
    effect: (m) => relabel(m, "Run", "Running"),
  },
  {
    name: "relabel-edge replaces a label",
    edit: { kind: "relabel-edge", id: "Idle--Checking", label: "poll {fast}" },
    expected: base.replace("Idle --> Checking : poll", "Idle --> Checking : poll #123;fast#125;"),
    effect: (m) => relabelEdge(m, "Idle--Checking", "poll {fast}"),
  },
  {
    name: "relabel-edge sets a label",
    edit: { kind: "relabel-edge", id: "Checking--Route", label: "checked" },
    expected: base.replace("    Checking --> Route\r\n", "    Checking --> Route : checked\r\n"),
    effect: (m) => relabelEdge(m, "Checking--Route", "checked"),
  },
  {
    name: "relabel-edge sets a label on a [*] transition",
    edit: { kind: "relabel-edge", id: "Run--Working_end", label: "ran" },
    expected: base.replace("Run --> [*]", "Run --> [*] : ran"),
    effect: (m) => relabelEdge(m, "Run--Working_end", "ran"),
  },
  {
    name: "relabel-edge removes a label",
    edit: { kind: "relabel-edge", id: "Route--Working", label: "" },
    expected: base.replace("Route --> Working : job found", "Route --> Working"),
    effect: (m) => relabelEdge(m, "Route--Working", undefined),
  },
  {
    name: "delete-edge in the middle",
    edit: { kind: "delete-edge", id: "Route--Idle" },
    expected: base.replace("    Route --> Idle : empty\r\n", ""),
    effect: (m) => ({ ...m, transitions: m.transitions.filter((t) => t.id !== "Route--Idle") }),
  },
  {
    name: "delete-edge takes the last [*] with it",
    edit: { kind: "delete-edge", id: "root_start--Idle" },
    expected: base.replace("    [*] --> Idle\r\n", ""),
    effect: (m) => ({
      ...m,
      states: m.states.filter((s) => s.id !== "root_start"),
      transitions: m.transitions.filter((t) => t.id !== "root_start--Idle"),
    }),
  },
  {
    name: "delete-node an unconnected labelled state",
    edit: { kind: "delete-node", id: "Lone" },
    expected: base,
    effect: (m) => m,
  },
];

const withLone = base + "\r\n    Lone : alone";
for (const { name, edit, expected, effect } of cases)
  test(`${name}: exact bytes and complete model effect`, async () => {
    const source = edit.kind === "delete-node" ? withLone : base;
    const before = await model(source);
    const result = await editDiagram(source, edit);
    expect(result).toEqual({ ok: true, source: expected });
    const after = await model(expected);
    const wanted =
      edit.kind === "delete-node"
        ? { ...before, states: before.states.filter((s) => s.id !== edit.id) }
        : effect(before);
    expect(byId(after)).toEqual(byId(wanted));
    expect(after.transitions).toEqual(wanted.transitions);
  });

test("delete-edge on the last line takes the break before it; delete-node removes a pseudo-state", async () => {
  const source = "stateDiagram-v2\n  state A\n  state B\n  state R <<fork>>\n  A --> B\n  B --> A";
  expect(await editState(source, { kind: "delete-edge", id: "B--A" })).toEqual({
    ok: true,
    source: "stateDiagram-v2\n  state A\n  state B\n  state R <<fork>>\n  A --> B",
  });
  expect(await editState(source, { kind: "delete-node", id: "R" })).toEqual({
    ok: true,
    source: "stateDiagram-v2\n  state A\n  state B\n  A --> B\n  B --> A",
  });
});

test("add-node on a header alone, and a whole diagram built from it", async () => {
  let source = "stateDiagram-v2\n";
  for (const edit of [
    { kind: "add-node", id: "A", label: "" },
    { kind: "relabel-node", id: "A", label: "Alpha" },
    { kind: "add-node", id: "B", label: "Beta" },
    { kind: "connect", source: "[*]", target: "A" },
    { kind: "connect", source: "A", target: "B", label: "go" },
    { kind: "connect", source: "B", target: "[*]" },
  ] as DiagramEdit[]) {
    const result = await editDiagram(source, edit);
    expect(result.ok, JSON.stringify(edit)).toBe(true);
    source = result.source;
  }
  expect(source).toBe(
    'stateDiagram-v2\n    state "Alpha" as A\n    state "Beta" as B\n    [*] --> A\n    A --> B : go\n    B --> [*]\n',
  );
  // Marker to marker is refused (see the named refusals).
  expect(await editDiagram(source, { kind: "connect", source: "[*]", target: "[*]" })).toMatchObject({
    ok: false,
    source,
    code: "edit_invalid_endpoint",
  });
});

for (const newline of ["\n", "\r\n", "\r"])
  for (const ending of ["", newline])
    test(`append keeps line convention and indentation ${JSON.stringify([newline, ending])}`, async () => {
      const source =
        "﻿stateDiagram-v2" +
        newline +
        "\tstate W {" +
        newline +
        "\t\t\tstate X" +
        newline +
        "\t\t\t[*] --> X" +
        newline +
        "\t}" +
        newline +
        "\tstate A" +
        newline +
        "\tA --> W" +
        ending;
      expect(await editState(source, { kind: "add-node", id: "C", label: "C" })).toEqual({
        ok: true,
        source: source + (ending ? "" : newline) + '\tstate "C" as C' + ending,
      });
      // Inside a composite: the indent of its last statement, the source's line break.
      expect(await editState(source, { kind: "connect", source: "X", target: "X" })).toEqual({
        ok: true,
        source: source.replace(`[*] --> X${newline}`, `[*] --> X${newline}\t\t\tX --> X${newline}`),
      });
    });

test("connect inside an empty-bodied composite indents one step past its }", async () => {
  const source = "stateDiagram-v2\n  state W {\n    state Y {\n    }\n    state X\n    X --> Y\n  }\n  [*] --> W";
  expect(await editState(source, { kind: "connect", source: "Y", target: "X" })).toEqual({
    ok: true,
    source: source.replace("    X --> Y\n", "    X --> Y\n    Y --> X\n"),
  });
});

test("no-op relabels return the source byte for byte", async () => {
  for (const edit of [
    { kind: "relabel-node", id: "Idle", label: "Waiting for work" },
    { kind: "relabel-node", id: "Done", label: "Done" },
    { kind: "relabel-edge", id: "Idle--Checking", label: "poll" },
    { kind: "relabel-edge", id: "Checking--Route", label: "" },
  ] as const)
    expect(await editDiagram(base, edit)).toEqual({ ok: true, source: base });
});

const codecLabels = [
  'say "hi"',
  "#quot;",
  "#35;",
  "#59;",
  "a#b",
  "#",
  "##;",
  "a; b",
  "; , ( ) { }",
  "{x}",
  "%% not a comment",
  "%%{init: {}}%%",
  "50% off",
  "}%%",
  "a : b",
  "a ::: b",
  "x:::y",
  "::",
  "A --> B",
  "-->",
  "--",
  "[*]",
  "a << b >> c",
  "note left of X",
  "state X",
  "as",
  "\\ $ ` '",
  "R&D &amp; co",
  "a < b > c",
  "emoji 🦉 ünï",
  "ﬂ°",
  "quot¶ß",
  "x".repeat(512),
];
const codecBase =
  'stateDiagram-v2\n  state W {\n    state X\n    [*] --> X\n  }\n  state "Q" as Q\n  D : d\n  state B\n  Q --> D : e\n  D --> B\n  B --> W';
for (const label of codecLabels)
  test(`codec: ${JSON.stringify(label.slice(0, 40))} round-trips exactly in every label form`, async () => {
    for (const edit of [
      { kind: "relabel-node", id: "Q", label },
      { kind: "relabel-node", id: "D", label },
      { kind: "relabel-node", id: "B", label },
      { kind: "relabel-node", id: "W", label },
      { kind: "relabel-edge", id: "Q--D", label },
      { kind: "relabel-edge", id: "D--B", label },
      { kind: "add-node", id: "N", label },
      { kind: "connect", source: "B", target: "Q", label },
    ] as const) {
      const result = await editDiagram(codecBase, edit);
      expect(result.ok, `${edit.kind} ${JSON.stringify(result)}`).toBe(true);
      const after = await model(result.source);
      const found =
        edit.kind === "relabel-edge"
          ? after.transitions.find((t) => t.id === edit.id)
          : edit.kind === "connect"
            ? after.transitions.find((t) => t.id === "B--Q")
            : after.states.find((s) => s.id === edit.id);
      expect(found?.label).toBe(label);
    }
  });

test("codec: the written form", () => {
  expect(encodeStateLabel('a; "b" {c} %% d % e :: f : g --> h -> i #j')).toBe(
    "a#59; #quot;b#quot; #123;c#125; #37;#37; d % e #58;#58; f : g --#62; h -> i #j",
  );
});

const nested =
  "stateDiagram-v2\n  state W {\n    state X\n    [*] --> X\n  }\n  state A\n  A --> W\n  note left of A : n\n  class A hot\n  state B\n  B --> A";
for (const [name, source, edit, code] of [
  [
    "change-shape is flowchart-only",
    base,
    { kind: "change-shape", id: "Idle", shape: "diamond" },
    "edit_unsupported_for_family",
  ],
  [
    "direction is flowchart-only (for now)",
    base,
    { kind: "direction", direction: "tb" },
    "edit_unsupported_for_family",
  ],
  ["add-node shape", base, { kind: "add-node", id: "N", label: "N", shape: "rounded" }, "edit_unsupported_for_family"],
  [
    "add-node element",
    base,
    { kind: "add-node", id: "N", label: "N", element: "System" },
    "edit_unsupported_for_family",
  ],
  ["add-node external", base, { kind: "add-node", id: "N", label: "N", external: true }, "edit_unsupported_for_family"],
  [
    "connect line",
    base,
    { kind: "connect", source: "Done", target: "Idle", line: "dotted" },
    "edit_unsupported_for_family",
  ],
  [
    "connect relation",
    base,
    { kind: "connect", source: "Done", target: "Idle", relation: "rel" },
    "edit_unsupported_for_family",
  ],
  [
    "invalid state source",
    "stateDiagram-v2\n  A --> B",
    { kind: "relabel-node", id: "A", label: "x" },
    "edit_requires_valid_state",
  ],
  [
    "undrawn state source",
    "stateDiagram-v2\n  state A",
    { kind: "add-node", id: "B", label: "B" },
    "edit_requires_valid_state",
  ],
  [
    "add-node unknown kind",
    base,
    { kind: "add-node", id: "N", label: "", state: "history" as never },
    "edit_invalid_state_kind",
  ],
  ["add-node hyphenated id", base, { kind: "add-node", id: "a-b", label: "N" }, "edit_invalid_id"],
  ["add-node leading underscore", base, { kind: "add-node", id: "_a", label: "N" }, "edit_invalid_id"],
  ["add-node overlong id", base, { kind: "add-node", id: "x".repeat(129), label: "N" }, "edit_invalid_id"],
  ["add-node root_start", base, { kind: "add-node", id: "root_start", label: "N" }, "edit_id_reserved"],
  ["add-node root_end", base, { kind: "add-node", id: "root_end", label: "N" }, "edit_id_reserved"],
  ["add-node a composite's start", base, { kind: "add-node", id: "Working_start", label: "N" }, "edit_id_reserved"],
  ["add-node id in use", base, { kind: "add-node", id: "Fetch", label: "N" }, "edit_id_exists"],
  ["add-node whitespace label", base, { kind: "add-node", id: "N", label: "   " }, "edit_label_required"],
  ["add-node padded label", base, { kind: "add-node", id: "N", label: " N" }, "edit_invalid_label"],
  ["add-node HTML label", base, { kind: "add-node", id: "N", label: "<b>N</b>" }, "edit_invalid_label"],
  ["add-node overlong label", base, { kind: "add-node", id: "N", label: "x".repeat(513) }, "edit_invalid_label"],
  [
    "add-node labelled choice",
    base,
    { kind: "add-node", id: "N", label: "Which?", state: "choice" },
    "edit_label_unsupported",
  ],
  ["connect missing endpoint", base, { kind: "connect", source: "Done", target: "Nobody" }, "edit_target_missing"],
  ["connect from an end", base, { kind: "connect", source: "Working_end", target: "Run" }, "edit_invalid_endpoint"],
  ["connect to a start", base, { kind: "connect", source: "Done", target: "root_start" }, "edit_invalid_endpoint"],
  // A transition between markers draws nothing useful; Mermaid accepts it, Archer does not write it (smoke-b#8).
  [
    "connect start marker to end marker",
    base,
    { kind: "connect", source: "[*]", target: "[*]" },
    "edit_invalid_endpoint",
  ],
  [
    "connect a start to an end by id",
    base,
    { kind: "connect", source: "Working_start", target: "Working_end" },
    "edit_invalid_endpoint",
  ],
  [
    "connect [*] to a state in a composite",
    base,
    { kind: "connect", source: "[*]", target: "Run" },
    "edit_start_end_scope",
  ],
  [
    "connect a state in a composite to [*]",
    base,
    { kind: "connect", source: "Fetch", target: "[*]" },
    "edit_start_end_scope",
  ],
  [
    "connect a composite's start to the top level",
    base,
    { kind: "connect", source: "Working_start", target: "Done" },
    "edit_start_end_scope",
  ],
  ["connect across scopes", base, { kind: "connect", source: "Idle", target: "Fetch" }, "edit_scope_mismatch"],
  [
    "connect a composite to its own child",
    base,
    { kind: "connect", source: "Working", target: "Run" },
    "edit_scope_mismatch",
  ],
  [
    "connect id other than the derived one",
    base,
    { kind: "connect", id: "e1", source: "Done", target: "Idle" },
    "edit_relationship_id_derived",
  ],
  [
    "connect padded label",
    base,
    { kind: "connect", source: "Done", target: "Idle", label: "x " },
    "edit_invalid_label",
  ],
  [
    "connect overlong id",
    `stateDiagram-v2\n  state ${"a".repeat(100)}\n  state b\n  ${"a".repeat(100)} --> b`,
    { kind: "connect", source: "a".repeat(100), target: "a".repeat(100) },
    "edit_invalid_id",
  ],
  ["relabel-node missing", base, { kind: "relabel-node", id: "Nobody", label: "x" }, "edit_target_missing"],
  ["relabel-node choice", base, { kind: "relabel-node", id: "Route", label: "x" }, "edit_relabel_unsupported"],
  ["relabel-node start", base, { kind: "relabel-node", id: "root_start", label: "x" }, "edit_relabel_unsupported"],
  ["relabel-node empty", base, { kind: "relabel-node", id: "Idle", label: "" }, "edit_label_required"],
  ["relabel-node padded", base, { kind: "relabel-node", id: "Idle", label: "x " }, "edit_invalid_label"],
  ["relabel-edge missing", base, { kind: "relabel-edge", id: "Idle--Done", label: "x" }, "edit_target_missing"],
  ["relabel-edge whitespace", base, { kind: "relabel-edge", id: "Idle--Checking", label: " " }, "edit_label_required"],
  ["delete-edge missing", base, { kind: "delete-edge", id: "Idle--Done" }, "edit_target_missing"],
  [
    "delete-edge leaves a bare state undrawn",
    base,
    { kind: "delete-edge", id: "Working--Done" },
    "edit_delete_leaves_undrawn_state",
  ],
  ["delete-node missing", base, { kind: "delete-node", id: "Nobody" }, "edit_target_missing"],
  ["delete-node referenced", base, { kind: "delete-node", id: "Checking" }, "edit_delete_referenced_node"],
  ["delete-node start", base, { kind: "delete-node", id: "root_start" }, "edit_delete_referenced_node"],
  [
    "delete-node composite",
    'stateDiagram-v2\n  state W {\n    state "X" as X\n  }',
    { kind: "delete-node", id: "W" },
    "edit_delete_composite_unsupported",
  ],
  [
    "delete-node with a note",
    "stateDiagram-v2\n  A : a\n  note left of A : n",
    { kind: "delete-node", id: "A" },
    "edit_delete_note_dependency",
  ],
  [
    "delete-node styled",
    "stateDiagram-v2\n  A : a\n  class A hot",
    { kind: "delete-node", id: "A" },
    "edit_delete_styling_dependency",
  ],
  [
    "delete-node declared twice",
    "stateDiagram-v2\n  state A\n  A : a",
    { kind: "delete-node", id: "A" },
    "edit_delete_nonisolated_declaration",
  ],
  [
    "delete-node in the nested sample stays referenced",
    nested,
    { kind: "delete-node", id: "B" },
    "edit_delete_referenced_node",
  ],
] as const)
  test(`named refusal: ${code} (${name})`, async () => {
    expect(await editDiagram(source, edit as DiagramEdit)).toMatchObject({ ok: false, source, code });
  });

test("connect to an existing ordered pair names the transition, [*] pairs included", async () => {
  expect(await editDiagram(base, { kind: "connect", source: "Idle", target: "Checking", label: "again" })).toEqual({
    ok: false,
    source: base,
    code: "edit_relationship_exists",
    existingId: "Idle--Checking",
  });
  expect(await editDiagram(base, { kind: "connect", source: "[*]", target: "Idle" })).toEqual({
    ok: false,
    source: base,
    code: "edit_relationship_exists",
    existingId: "root_start--Idle",
  });
  expect(await editDiagram(base, { kind: "connect", source: "Run", target: "Working_end" })).toEqual({
    ok: false,
    source: base,
    code: "edit_relationship_exists",
    existingId: "Run--Working_end",
  });
  // The reverse pair is a different transition.
  expect((await editDiagram(base, { kind: "connect", source: "Checking", target: "Idle" })).ok).toBe(true);
});

test("notes, styling and :::class survive edits on their state", async () => {
  const source =
    "stateDiagram-v2\n  classDef hot fill:red\n  state A:::hot\n  state B\n  A --> B\n  note left of A : n\n  class B hot";
  // Mermaid misreads `state "Alpha" as A:::hot`, so a styled bare declaration is not upgraded.
  expect(await editState(source, { kind: "relabel-node", id: "A", label: "Alpha" })).toEqual({
    ok: false,
    source,
    code: "edit_relabel_styled_declaration",
  });
  expect(await editState(source, { kind: "relabel-node", id: "B", label: "Beta" })).toEqual({
    ok: true,
    source: source.replace("state B", 'state "Beta" as B'),
  });
  expect(await editState(source, { kind: "relabel-edge", id: "A--B", label: "go" })).toEqual({
    ok: true,
    source: source.replace("A --> B", "A --> B : go"),
  });
});

test("the state parameter is state-only on other families", async () => {
  const flowchart = "flowchart LR\n  a[A]";
  expect(await editDiagram(flowchart, { kind: "add-node", id: "b", label: "B", state: "choice" })).toEqual({
    ok: false,
    source: flowchart,
    code: "edit_unsupported_for_family",
  });
  const c4 = 'C4Context\n  Person(a, "A")';
  expect(await editDiagram(c4, { kind: "add-node", id: "b", label: "B", element: "System", state: "fork" })).toEqual({
    ok: false,
    source: c4,
    code: "edit_unsupported_for_family",
  });
});

test("preview input accepts state parameters and [*] endpoints, and nothing looser", () => {
  for (const state of STATE_NODE_KINDS) {
    const edit = { kind: "add-node", id: "N", label: "", state };
    expect(parseAuthoringPreview({ source: base, edit }, true).edit).toEqual(edit);
  }
  for (const edit of [
    { kind: "connect", source: "[*]", target: "Idle" },
    { kind: "connect", source: "Done", target: "[*]", label: "stop" },
    { kind: "connect", id: "root_start--Idle", source: "root_start", target: "Idle" },
  ])
    expect(parseAuthoringPreview({ source: base, edit }, true).edit).toEqual(edit);
  for (const edit of [
    { kind: "add-node", id: "N", label: "", state: "history" },
    { kind: "add-node", id: "N", label: "", state: "initial" },
    { kind: "add-node", id: "N", label: "", state: "__proto__" },
    { kind: "add-node", id: "N", label: "", state: 1 },
    { kind: "relabel-node", id: "N", label: "x", state: "choice" },
    { kind: "connect", source: "A", target: "B", state: "choice" },
    { kind: "add-node", id: "[*]", label: "" },
    { kind: "delete-node", id: "[*]" },
    { kind: "relabel-edge", id: "[*]", label: "x" },
    { kind: "connect", id: "[*]", source: "A", target: "B" },
    { kind: "connect", source: "[ * ]", target: "B" },
    { kind: "connect", source: "[*]x", target: "B" },
  ])
    expect(() => parseAuthoringPreview({ source: base, edit }, true), JSON.stringify(edit)).toThrow(
      AuthoringInputError,
    );
});
