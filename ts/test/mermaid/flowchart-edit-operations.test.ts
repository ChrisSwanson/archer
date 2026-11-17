import { expect, test } from "vitest";
import { editFlowchart, type FlowchartEdit } from "../../src/authoring/flowchart-edit.ts";
import { compile } from "../../src/mermaid/index.ts";
const base = "\uFEFF%% 🐦 keep\r\nflowchart LR\r\n  a[A]:::person\r\n  b(B)\r\n  a e1@-.->|calls| b\r\n  %% tail";
async function model(source: string) {
  const result = await compile(source);
  expect(result.model?.type).toBe("freeform-graph");
  if (result.model?.type !== "freeform-graph") throw new Error(JSON.stringify(result.diagnostics));
  return result.model;
}
const cases: { edit: FlowchartEdit; expected: string; effect: (m: Awaited<ReturnType<typeof model>>) => unknown }[] = [
  {
    edit: { kind: "add-node", id: "c", label: "C" },
    expected: base + '\r\n  c["C"]',
    effect: (m) => ({ ...m, nodes: [...m.nodes, { id: "c", label: "C", shape: "rectangle" }] }),
  },
  {
    edit: { kind: "connect", id: "e2", source: "b", target: "a", label: "returns" },
    expected: base + '\r\n  b e2@-->|"returns"| a',
    effect: (m) => ({ ...m, edges: [...m.edges, { id: "e2", source: "b", target: "a", label: "returns" }] }),
  },
  {
    edit: { kind: "relabel-edge", id: "e1", label: "new | 🦉" },
    expected: base.replace("|calls|", '|"new #124; 🦉"|'),
    effect: (m) => ({ ...m, edges: m.edges.map((e) => ({ ...e, label: "new | 🦉" })) }),
  },
  {
    edit: { kind: "change-shape", id: "b", shape: "diamond" },
    expected: base.replace("b(B)", "b{B}"),
    effect: (m) => ({ ...m, nodes: m.nodes.map((n) => (n.id === "b" ? { ...n, shape: "diamond" } : n)) }),
  },
  {
    edit: { kind: "direction", direction: "bt" },
    expected: base.replace("flowchart LR", "flowchart BT"),
    effect: (m) => ({ ...m, direction: "bt" }),
  },
  {
    edit: { kind: "delete-edge", id: "e1" },
    expected: base.replace("  a e1@-.->|calls| b\r\n", ""),
    effect: (m) => ({ ...m, edges: [] }),
  },
];
for (const { edit, expected, effect } of cases)
  test(`${edit.kind}: exact splice and complete model effect`, async () => {
    const before = await model(base);
    const result = await editFlowchart(base, edit);
    expect(result).toEqual({ ok: true, source: expected });
    expect(await model(result.source)).toEqual(effect(before));
  });
for (const [line, arrow] of [
  ["solid", "-->"],
  ["dotted", "-.->"],
  ["thick", "==>"],
] as const)
  for (const label of [undefined, "via"])
    test(`connect line ${line} label ${label ?? "none"}: exact append and model line`, async () => {
      const before = await model(base);
      const result = await editFlowchart(base, {
        kind: "connect",
        id: "e2",
        source: "b",
        target: "a",
        line,
        ...(label === undefined ? {} : { label }),
      });
      expect(result).toEqual({
        ok: true,
        source: `${base}\r\n  b e2@${arrow}${label === undefined ? "" : `|"${label}"|`} a`,
      });
      // Solid is the compiler's default and is recorded as an absent `line`.
      const edge = {
        id: "e2",
        source: "b",
        target: "a",
        ...(label === undefined ? {} : { label }),
        ...(line === "solid" ? {} : { line }),
      };
      expect(await model(result.source)).toEqual({ ...before, edges: [...before.edges, edge] });
    });
test("connect refuses an unknown line by name", async () => {
  const source = "flowchart LR\na[A]\nb[B]";
  expect(
    await editFlowchart(source, { kind: "connect", id: "e1", source: "a", target: "b", line: "dashed" as never }),
  ).toEqual({ ok: false, source, code: "edit_invalid_line" });
});
test("delete isolated node preserves comment and unaffected model", async () => {
  const source = "flowchart LR\ra[A]\rb[B]\r%% keep";
  expect(await editFlowchart(source, { kind: "delete-node", id: "a" })).toEqual({
    ok: true,
    source: "flowchart LR\rb[B]\r%% keep",
  });
  expect(await model("flowchart LR\rb[B]\r%% keep")).toEqual({
    ...(await model(source)),
    nodes: [{ id: "b", label: "B", shape: "rectangle" }],
  });
});
for (const newline of ["\n", "\r\n", "\r"])
  for (const ending of ["", newline])
    test(`no-op exact bytes ${JSON.stringify([newline, ending])}`, async () => {
      const source = "\uFEFF%% 🐦" + newline + "graph TD" + newline + 'a["A"]' + ending;
      for (const edit of [
        { kind: "relabel-node", id: "a", label: "A" },
        { kind: "change-shape", id: "a", shape: "rectangle" },
        { kind: "direction", direction: "tb" },
      ] as const)
        expect(await editFlowchart(source, edit)).toEqual({ ok: true, source });
    });
for (const [source, edit, code] of [
  ["flowchart LR\na[A]\nb[B]\na e1@--> b", { kind: "delete-node", id: "a" }, "edit_delete_referenced_node"],
  [
    "flowchart LR\na[A]\nb[B]\na e1@--> b\nlinkStyle 0 stroke:red",
    { kind: "delete-edge", id: "e1" },
    "edit_delete_styling_dependency",
  ],
  ["flowchart LR\na[A]\nstyle a fill:red", { kind: "delete-node", id: "a" }, "edit_delete_styling_dependency"],
  ["flowchart LR\na[A]\na[A]", { kind: "relabel-node", id: "a", label: "X" }, "edit_requires_valid_flowchart"],
  ["flowchart LR\na[A]", { kind: "add-node", id: "a", label: "X" }, "edit_id_exists"],
  ["flowchart LR\na[A]", { kind: "connect", id: "x", source: "a", target: "missing" }, "edit_target_missing"],
] as const)
  test(`named refusal: ${code} ${edit.kind}`, async () => {
    expect(await editFlowchart(source, edit)).toMatchObject({ ok: false, source, code });
  });
test("inline relabel/shape retains group, class, repeated bare references and edge", async () => {
  const source = 'flowchart LR\nsubgraph g[G]\na["A 🐦"]:::person e1@--> b[B]\na\nend\nstyle a fill:red';
  const result = await editFlowchart(source, { kind: "relabel-node", id: "a", label: "New" });
  expect(result).toEqual({ ok: true, source: source.replace('"A 🐦"', '"New"') });
  const before = await model(source);
  expect(await model(result.source)).toEqual({
    ...before,
    nodes: before.nodes.map((n) => (n.id === "a" ? { ...n, label: "New" } : n)),
  });
});
for (const shape of [
  "rectangle",
  "rounded",
  "stadium",
  "circle",
  "diamond",
  "cylinder",
  "hexagon",
  "subroutine",
] as const)
  test(`shape ${shape} preserves quoted delimiters`, async () => {
    const source = 'flowchart LR\na["(🦉) [x]"]:::person\n%% keep';
    const before = await model(source);
    const result = await editFlowchart(source, { kind: "change-shape", id: "a", shape });
    expect(result.ok).toBe(true);
    expect(await model(result.source)).toEqual({ ...before, nodes: before.nodes.map((n) => ({ ...n, shape })) });
    expect(result.source.endsWith(":::person\n%% keep")).toBe(true);
  });
for (const newline of ["\n", "\r\n", "\r"])
  for (const ending of ["", newline])
    test(`append preserves line convention and a flush indent ${JSON.stringify([newline, ending])}`, async () => {
      const source = "\uFEFFflowchart LR" + newline + "a[A]" + ending;
      const result = await editFlowchart(source, { kind: "add-node", id: "b", label: "B" });
      expect(result).toEqual({ ok: true, source: source + (ending ? "" : newline) + 'b["B"]' + ending });
    });
test("relabel unlabeled edge inserts only pipes and repeated request is byte identical", async () => {
  const source = "flowchart LR\na[A] e1@---> b[B]";
  const result = await editFlowchart(source, { kind: "relabel-edge", id: "e1", label: "Call" });
  expect(result).toEqual({ ok: true, source: source.replace("--->", '--->|"Call"|') });
  const before = await model(source);
  expect(await model(result.source)).toEqual({ ...before, edges: before.edges.map((e) => ({ ...e, label: "Call" })) });
  expect(await editFlowchart(result.source, { kind: "relabel-edge", id: "e1", label: "Call" })).toEqual(result);
});
test("unsafe add ID and invalid label are named no-mutation refusals", async () => {
  const source = "flowchart LR\na[A]";
  expect(await editFlowchart(source, { kind: "add-node", id: "b\nc[C]", label: "B" })).toEqual({
    ok: false,
    source,
    code: "edit_invalid_result",
  });
  expect(await editFlowchart(source, { kind: "relabel-node", id: "a", label: "\n" })).toEqual({
    ok: false,
    source,
    code: "edit_invalid_label",
  });
});
test("keyword-shaped node IDs are declarations, preserving distinct group namespace", async () => {
  const source = "flowchart LR\nsubgraph click[Group]\nclick[Click]\nend";
  const result = await editFlowchart(source, { kind: "relabel-node", id: "click", label: "New" });
  expect(result).toEqual({ ok: true, source: source.replace("click[Click]", 'click["New"]') });
  const before = await model(source);
  expect(await model(result.source)).toEqual({ ...before, nodes: before.nodes.map((n) => ({ ...n, label: "New" })) });
});
// Styling refuses a delete only when it names the deleted element (or, for linkStyle, an
// ordinal the delete would shift); unrelated styling stays byte-identical.
for (const [name, source, edit, expected] of [
  [
    "style on another node",
    "flowchart LR\na[A]\nb[B]\nstyle b fill:red",
    { kind: "delete-node", id: "a" },
    "flowchart LR\nb[B]\nstyle b fill:red",
  ],
  [
    "class list without the node",
    "flowchart LR\na[A]\nb[B]\nclassDef hot fill:#f00\nclass b hot",
    { kind: "delete-node", id: "a" },
    "flowchart LR\nb[B]\nclassDef hot fill:#f00\nclass b hot",
  ],
  [
    "click on another node",
    'flowchart LR\na[A]\nb[B]\nclick b href "https://example.com"',
    { kind: "delete-node", id: "a" },
    'flowchart LR\nb[B]\nclick b href "https://example.com"',
  ],
  [
    "edge with style on a node",
    "flowchart LR\na[A]\nb[B]\na e1@--> b\nstyle a fill:red",
    { kind: "delete-edge", id: "e1" },
    "flowchart LR\na[A]\nb[B]\nstyle a fill:red",
  ],
  [
    "linkStyle on an earlier edge",
    "flowchart LR\na[A]\nb[B]\na e1@--> b\nb e2@--> a\nlinkStyle 0 stroke:red",
    { kind: "delete-edge", id: "e2" },
    "flowchart LR\na[A]\nb[B]\na e1@--> b\nlinkStyle 0 stroke:red",
  ],
  [
    "linkStyle default",
    "flowchart LR\na[A]\nb[B]\na e1@--> b\nlinkStyle default stroke:red",
    { kind: "delete-edge", id: "e1" },
    "flowchart LR\na[A]\nb[B]\nlinkStyle default stroke:red",
  ],
] as const)
  test(`delete beside unrelated styling: ${name}`, async () => {
    const result = await editFlowchart(source, edit);
    expect(result).toEqual({ ok: true, source: expected });
    await model(expected);
  });
for (const [name, source, edit] of [
  ["style names the node", "flowchart LR\na[A]\nb[B]\nstyle a fill:red", { kind: "delete-node", id: "a" }],
  [
    "class list names the node",
    "flowchart LR\na[A]\nb[B]\nclassDef hot fill:#f00\nclass b,a hot",
    { kind: "delete-node", id: "a" },
  ],
  [
    "click names the node",
    'flowchart LR\na[A]\nb[B]\nclick a href "https://example.com"',
    { kind: "delete-node", id: "a" },
  ],
  [
    "linkStyle names the edge",
    "flowchart LR\na[A]\nb[B]\na e1@--> b\nb e2@--> a\nlinkStyle 0 stroke:red",
    { kind: "delete-edge", id: "e1" },
  ],
  [
    "linkStyle on a later edge would shift",
    "flowchart LR\na[A]\nb[B]\na e1@--> b\nb e2@--> a\nlinkStyle 1 stroke:red",
    { kind: "delete-edge", id: "e1" },
  ],
  [
    "linkStyle list reaches the edge",
    "flowchart LR\na[A]\nb[B]\na e1@--> b\nb e2@--> a\nlinkStyle 0,1 stroke:red",
    { kind: "delete-edge", id: "e2" },
  ],
] as const)
  test(`delete refused by styling that depends on it: ${name}`, async () => {
    expect(await editFlowchart(source, edit)).toMatchObject({
      ok: false,
      source,
      code: "edit_delete_styling_dependency",
    });
  });
for (const newline of ["\n", "\r\n", "\r"])
  test(`deleting the unterminated last line leaves no trailing break ${JSON.stringify(newline)}`, async () => {
    const source = ["flowchart LR", "a[A]", "b[B]", "a e1@--> b"].join(newline);
    expect(await editFlowchart(source, { kind: "delete-edge", id: "e1" })).toEqual({
      ok: true,
      source: ["flowchart LR", "a[A]", "b[B]"].join(newline),
    });
  });
// smoke-a#12:a: an appended line takes the indent of the file's last top-level statement.
for (const [indent, label] of [
  ["    ", "four spaces"],
  ["\t", "a tab"],
  ["", "none"],
] as const)
  test(`append matches the file's indent: ${label}`, async () => {
    const source = `flowchart LR\n${indent}a[A]\n${indent}subgraph g[G]\n${indent}${indent}b[B]\n${indent}end\n`;
    expect(await editFlowchart(source, { kind: "add-node", id: "c", label: "C" })).toEqual({
      ok: true,
      source: `${source}${indent}c["C"]\n`,
    });
    expect(await editFlowchart(source, { kind: "connect", id: "e1", source: "a", target: "b" })).toEqual({
      ok: true,
      source: `${source}${indent}a e1@--> b\n`,
    });
  });
test("append on a header alone keeps the two-space default", async () => {
  expect(await editFlowchart("flowchart LR\n", { kind: "add-node", id: "c", label: "C" })).toEqual({
    ok: true,
    source: 'flowchart LR\n  c["C"]\n',
  });
});
// stress:inline-decl. Deleting (or moving an end of) an edge whose line declares a node keeps that
// declaration on a line of its own, at the edge line's indent.
for (const [name, source, edit, expected] of [
  [
    "delete keeps both inline declarations",
    "flowchart LR\n  a[A] e1@--> b[B]",
    { kind: "delete-edge", id: "e1" },
    "flowchart LR\n  a[A]\n  b[B]",
  ],
  [
    "delete keeps a classed source only",
    "flowchart LR\n  b[B]\n  a[A]:::person e1@-.->|calls| b\n",
    { kind: "delete-edge", id: "e1" },
    "flowchart LR\n  b[B]\n  a[A]:::person\n",
  ],
  [
    "delete keeps the target in its subgraph",
    'flowchart LR\r\n  subgraph g[G]\r\n    a[A]\r\n    a e1@--> b("B")\r\n  end',
    { kind: "delete-edge", id: "e1" },
    'flowchart LR\r\n  subgraph g[G]\r\n    a[A]\r\n    b("B")\r\n  end',
  ],
  [
    "retarget the target keeps its class",
    "flowchart LR\n  a[A]\n  b[B]\n  c[C]\n  a e1@--> b:::hot",
    { kind: "retarget-edge", id: "e1", target: "c" },
    "flowchart LR\n  a[A]\n  b[B]\n  c[C]\n  a e1@--> c\n  b:::hot",
  ],
  [
    "retarget the source keeps its declaration",
    "flowchart LR\n  c[C]\n  a[A] e1@--> b[B]",
    { kind: "retarget-edge", id: "e1", source: "c" },
    "flowchart LR\n  c[C]\n  a[A]\n  c e1@--> b[B]",
  ],
  [
    "retarget the target keeps its declaration",
    "flowchart LR\n  c[C]\n  a[A] e1@--> b[B]",
    { kind: "retarget-edge", id: "e1", target: "c" },
    "flowchart LR\n  c[C]\n  a[A] e1@--> c\n  b[B]",
  ],
] as const)
  test(`inline declaration split: ${name}`, async () => {
    const before = await model(source);
    const result = await editFlowchart(source, edit);
    expect(result).toEqual({ ok: true, source: expected });
    const after = await model(expected);
    expect(after.nodes).toEqual(before.nodes);
  });
