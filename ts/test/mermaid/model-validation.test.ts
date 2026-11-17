// A model is validated on its way out of the compiler, not trusted because
// Mermaid produced it: every ID, enumeration, label and reference.

import { expect, test } from "vitest";
import type { DiagramModel, FreeformGraph, SequenceTrace } from "../../src/model/index.ts";
import { compile } from "../../src/mermaid/index.ts";
import { adaptFlowchart } from "../../src/mermaid/flowchart/adapt.ts";
import type { FlowData } from "../../src/mermaid/flowchart/db.ts";
import { scanFlowchart } from "../../src/mermaid/flowchart/scan.ts";
import { readPreamble } from "../../src/mermaid/preamble.ts";
import { adaptSequence } from "../../src/mermaid/sequence/adapt.ts";
import type { SequenceData } from "../../src/mermaid/sequence/db.ts";
import { scanSequence } from "../../src/mermaid/sequence/scan.ts";
import { validateModel } from "../../src/mermaid/validate.ts";
import { errorsOf, located } from "./support/compile-helpers.ts";
import { loadFixtures } from "./support/fixtures.ts";

const graph = (patch: Partial<FreeformGraph>): FreeformGraph => ({
  type: "freeform-graph",
  direction: "lr",
  nodes: [
    { id: "a", label: "A", shape: "rectangle" },
    { id: "b", label: "B", shape: "rectangle", groupId: "g" },
  ],
  edges: [{ id: "e1", source: "a", target: "b" }],
  groups: [{ id: "g", label: "G" }],
  ...patch,
});

const trace = (patch: Partial<SequenceTrace>): SequenceTrace => ({
  type: "sequence-trace",
  participants: [{ id: "a", label: "A" }],
  events: [{ type: "message", id: "msg-0", from: "a", to: "a", label: "x", kind: "sync" }],
  ...patch,
});

test.each(loadFixtures())("the golden model of $name is sound", ({ expected }) => {
  expect(validateModel(expected as DiagramModel)).toEqual([]);
});

test.each([
  ["a node ID outside the grammar", graph({ nodes: [{ id: "a.b", label: "A" }], edges: [] })],
  ["an edge from a node that does not exist", graph({ edges: [{ id: "e1", source: "z", target: "b" }] })],
  ["an edge to a node that does not exist", graph({ edges: [{ id: "e1", source: "a", target: "z" }] })],
  ["a node in a group that does not exist", graph({ nodes: [{ id: "a", label: "A", groupId: "nope" }], edges: [] })],
  ["a group under a parent that does not exist", graph({ groups: [{ id: "g", label: "G", parentId: "nope" }] })],
  [
    "groups that nest in a cycle",
    graph({
      groups: [
        { id: "g", label: "G", parentId: "h" },
        { id: "h", label: "H", parentId: "g" },
      ],
    }),
  ],
  [
    "two nodes with one ID",
    graph({
      nodes: [
        { id: "a", label: "A" },
        { id: "a", label: "B" },
      ],
      edges: [],
    }),
  ],
  [
    "a shape outside the enumeration",
    graph({ nodes: [{ id: "a", label: "A", shape: "trapezoid" as "rectangle" }], edges: [] }),
  ],
  [
    "a line outside the enumeration",
    graph({ edges: [{ id: "e1", source: "a", target: "b", line: "wavy" as "solid" }] }),
  ],
  ["HTML in a node label", graph({ nodes: [{ id: "a", label: "<img src=x onerror=1>" }], edges: [] })],
  ["a C1 control in an edge label", graph({ edges: [{ id: "e1", source: "a", target: "b", label: "x\u009by" }] })],
  ["a bidi override in a group label", graph({ groups: [{ id: "g", label: "abc‮def" }] })],
  ["an over-long label", graph({ groups: [{ id: "g", label: "w".repeat(513) }] })],
  [
    "a message to a participant that is not declared",
    trace({ events: [{ type: "message", id: "msg-0", from: "a", to: "z", kind: "sync" }] }),
  ],
  [
    "a note beside a participant that is not declared",
    trace({ events: [{ type: "note", id: "note-0", position: "over", participants: ["z"], text: "t" }] }),
  ],
  ["an activation of a participant that is not declared", trace({ events: [{ type: "activate", participant: "z" }] })],
  [
    "two participants with one ID",
    trace({
      participants: [
        { id: "a", label: "A" },
        { id: "a", label: "B" },
      ],
    }),
  ],
  [
    "a message kind outside the enumeration",
    trace({ events: [{ type: "message", id: "msg-0", from: "a", to: "a", kind: "lost" as "sync" }] }),
  ],
  ["an isolate in a participant label", trace({ participants: [{ id: "a", label: "⁦x⁩" }] })],
  [
    "a message hidden in a fragment, to nobody",
    trace({
      events: [
        {
          type: "fragment",
          id: "frag-0",
          kind: "loop",
          label: "l",
          sections: [{ label: "l", events: [{ type: "message", id: "msg-0", from: "a", to: "z", kind: "sync" }] }],
        },
      ],
    }),
  ],
] as const)("refuses %s", (_name, model) => {
  expect(validateModel(model)).not.toEqual([]);
});

test.each([
  ["a node label", 'flowchart LR\n  a["abc‮def"]\n', "2:3"],
  ["an edge label", "flowchart LR\n  a[A]\n  b[B]\n  a e1@-->|x⁧y| b\n", "4:5"],
  ["a message", "sequenceDiagram\n  participant a as A\n  a->>a: ‏x\n", "3:10"],
])("a bidirectional-formatting character in %s is refused", async (_name, source, at) => {
  const result = await compile(source);
  expect(result.model).toBeNull();
  expect(located(errorsOf(result.diagnostics))).toEqual([`control_character@${at}`]);
});

/** The scan of `source`, for driving an adapter with a database Mermaid did not produce. */
function scanned(source: string) {
  const preamble = readPreamble(source);
  if (!preamble.header) throw new Error("no header");
  return { preamble, header: preamble.header };
}

test("a participant Mermaid knows and the source never declares is refused, not dropped", () => {
  const { preamble, header } = scanned("sequenceDiagram\n  participant a as A\n  a->>a: x\n");
  const scan = scanSequence(header, preamble.statements);
  const data: SequenceData = {
    actors: [
      { name: "a", description: "A", type: "participant" },
      { name: "z", description: "z", type: "participant" },
    ],
    records: [
      { type: 0, from: "a", to: "a", text: "x", placement: undefined, bareAutonumber: false },
      { type: 0, from: "a", to: "z", text: "y", placement: undefined, bareAutonumber: false },
    ],
  };
  const adapted = adaptSequence(data, scan, header.statementSpan(), false);
  expect(adapted.model).toBeUndefined();
  expect(adapted.diagnostics.map((diagnostic) => diagnostic.code)).toContain("parser_disagreement");
});

test("a node or edge Mermaid knows and the scan never saw is refused, not trusted", () => {
  const { preamble, header } = scanned("flowchart LR\n  a[A]\n");
  const scan = scanFlowchart(header, preamble.statements);
  const data: FlowData = {
    direction: "LR",
    vertices: [
      { id: "a", text: "A", type: "square", labelType: "text", classes: [] },
      { id: "ghost", text: "G", type: "square", labelType: "text", classes: [] },
    ],
    edges: [
      {
        id: "e9",
        userDefinedId: true,
        start: "a",
        end: "ghost",
        type: "arrow_point",
        stroke: "normal",
        text: "",
        labelType: "text",
      },
    ],
    subgraphs: [],
  };
  const adapted = adaptFlowchart(data, scan, header.statementSpan(), new Set());
  expect(adapted.model).toBeUndefined();
  expect(adapted.diagnostics.filter((diagnostic) => diagnostic.code === "parser_disagreement")).toHaveLength(2);
});
