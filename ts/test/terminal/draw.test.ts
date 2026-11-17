// What a person sees from `archer draw`: every node and group named, every
// edge accounted for, nothing past the width asked for, routes that meet nodes
// clear of their corners, and no control character from a label ever written.
import { describe, expect, test } from "vitest";
import { drawGraph } from "../../src/terminal/draw.ts";
import type { GraphInput } from "../../src/terminal/input.ts";
import { fit, flowOrder, layout, wrap } from "../../src/terminal/layout.ts";
import { render, straighten } from "../../src/terminal/render.ts";
import { MODEL_FILES, loadModel, modelNamed } from "./models.ts";

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const widest = (text: string): number => Math.max(...text.split("\n").map((l) => [...l].length));
const heads = (text: string): number => [...text].filter((c) => "▲▼◀▶".includes(c)).length;

describe.each(MODEL_FILES)("%s", (_name, path) => {
  const graph = loadModel(path);

  test.each([80, 120])("at %i columns stays inside the width and names everything", async (width) => {
    const text = await drawGraph(graph, { width, color: false });
    expect(widest(text)).toBeLessThanOrEqual(width);
    // Labels may wrap, so look for each word of each label.
    for (const n of graph.nodes)
      for (const word of wrap(n.label, 10).flatMap((l) => l.split(" ")))
        expect(text, `${n.id}: ${word}`).toContain(word);
    // A group's title is shown whole, though it may wrap inside the frame.
    for (const g of graph.groups) for (const word of g.label.split(" ")) expect(text, `group ${g.id}`).toContain(word);
    for (const e of graph.edges)
      if (e.label) expect(text.includes(e.label) || /^Edges:/m.test(text), `edge ${e.id}`).toBe(true);
  });

  // An arrow that arrives on a node's top or bottom border row from the side
  // points at a corner and can be read as aiming at whatever else is there.
  test.each([80, 120])("at %i columns every route meets its nodes on a side, clear of the corners", async (width) => {
    const drawn = await fit(graph, width);
    const nodes = drawn.boxes.filter((b) => !b.group);
    for (const route of drawn.routes) {
      const pts = straighten(route.points);
      const ends = [
        [pts[0], pts[1]],
        [pts.at(-1), pts.at(-2)],
      ] as const;
      for (const [end, next] of ends) {
        if (!end || !next) throw new Error(`${route.id} has fewer than two points`);
        const horizontal = end.y === next.y;
        for (const b of nodes) {
          const besideX = end.x === b.x - 1 || end.x === b.x || end.x === b.x + b.width - 1 || end.x === b.x + b.width;
          const besideY =
            end.y === b.y - 1 || end.y === b.y || end.y === b.y + b.height - 1 || end.y === b.y + b.height;
          if (horizontal && besideX && end.y >= b.y && end.y < b.y + b.height)
            expect(end.y > b.y && end.y < b.y + b.height - 1, `${route.id} meets ${b.id} at a corner row`).toBe(true);
          if (!horizontal && besideY && end.x >= b.x && end.x < b.x + b.width)
            expect(end.x > b.x && end.x < b.x + b.width - 1, `${route.id} meets ${b.id} at a corner column`).toBe(true);
        }
      }
    }
  });
});

test("a drawing holds one arrowhead per edge", async () => {
  const graph = modelNamed("docs/diagrams/compile-pipeline");
  expect(heads(await drawGraph(graph, { width: 200, color: false }))).toBe(graph.edges.length);
});

test("a narrow width numbers the edge labels and lists them under the drawing", async () => {
  const graph = modelNamed("docs/diagrams/compile-pipeline");
  const text = await drawGraph(graph, { width: 60, color: false });
  expect(text).toMatch(/^Edges:$/m);
  expect(text).toMatch(/^ {2}1 {2}Mermaid source \(\.mmd\) → Lexer: source text$/m);
  expect(text).not.toContain("validated model ");
});

test("a wide width writes edge labels on their routes, with no edge legend", async () => {
  const text = await drawGraph(modelNamed("docs/diagrams/compile-pipeline"), { width: 200, color: false });
  expect(text).not.toMatch(/^Edges:/m);
  expect(text).toContain("token stream");
});

test("a title goes on the first line, ahead of the drawing", async () => {
  const text = await drawGraph(modelNamed("fixtures/flowchart/minimal"), {
    width: 80,
    color: false,
    title: "minimal.json",
  });
  expect(text.split("\n")[0]).toBe("minimal.json");
});

test("kinds are captioned inside the node and carried by the border", async () => {
  const text = await drawGraph(modelNamed("docs/diagrams/system-context"), { width: 120, color: false });
  for (const caption of ["Person", "System", "External"]) expect(text).toContain(caption);
  // A system rectangle is double-bordered, an external one dashed.
  expect(text).toContain("╔");
  expect(text).toContain("╌");
  expect(text).toContain("╎");
});

test("shapes are drawn as their outlines and listed with the line styles", async () => {
  const text = await drawGraph(modelNamed("fixtures/flowchart/shapes"), { width: 160, color: false });
  expect(text).toContain("╭"); // rounded, stadium, circle, cylinder
  expect(text).toMatch(/││ *Subroutine *││/);
  expect(text).toContain("<"); // diamond side
  expect(text).toContain("╱"); // hexagon corner
  expect(text).toMatch(/^Legend:/m);
  for (const shape of ["rounded", "stadium", "circle", "diamond", "cylinder", "hexagon", "subroutine"])
    expect(text).toContain(` ${shape}`);
  expect(text).toContain("┄┄▶ dotted");
  expect(text).toContain("━━▶ thick");
  expect(text).toMatch(/[┆┄]/);
  expect(text).toMatch(/[┃━]/);
});

test("a diagram of plain rectangles and solid lines needs no legend", async () => {
  const text = await drawGraph(modelNamed("docs/diagrams/selection-round-trip"), { width: 120, color: false });
  expect(text).not.toMatch(/^Legend:/m);
});

test("a database rectangle is drawn as a cylinder", async () => {
  const graph: GraphInput = {
    type: "freeform-graph",
    nodes: [{ id: "db", label: "Orders", shape: "rectangle", classes: ["database"] }],
    edges: [],
    groups: [],
  };
  const drawn = await layout(graph);
  expect(drawn.boxes[0]?.outline).toBe("cylinder");
  expect(drawn.boxes[0]?.caption).toBe("Database");
});

test("the first class that names a kind decides it", async () => {
  const graph: GraphInput = {
    type: "freeform-graph",
    nodes: [{ id: "a", label: "A", classes: ["hot", "person"] }],
    edges: [],
    groups: [],
  };
  expect((await layout(graph)).boxes[0]?.caption).toBe("Person");
});

test("a group sharing its id with a node takes none of the node's kind", async () => {
  const graph: GraphInput = {
    type: "freeform-graph",
    nodes: [{ id: "api", label: "API", classes: ["external"], groupId: "api" }],
    edges: [],
    groups: [{ id: "api", label: "API group" }],
  };
  const group = (await layout(graph)).boxes.find((b) => b.group);
  expect(group?.kind).toBeUndefined();
});

test("colour is written only when asked for", async () => {
  const graph = modelNamed("docs/diagrams/system-context");
  expect(await drawGraph(graph, { width: 120, color: true })).toContain("\u001b[");
  expect(await drawGraph(graph, { width: 120, color: false })).not.toContain("\u001b");
});

test("a direction missing from the model means top to bottom", async () => {
  const graph = modelNamed("fixtures/flowchart/minimal");
  const lr = await layout({ ...graph, direction: "lr" });
  const tb = await layout({ ...graph, direction: undefined });
  expect(tb.height).toBeGreaterThan(lr.height);
});

// A label is text. The wire model's validator is meant to refuse control
// characters, but the painter must not pass one through even if it gets by.
test("the painter never writes a control character from a label or title", async () => {
  const graph: GraphInput = {
    type: "freeform-graph",
    nodes: [
      { id: "a", label: "ok \u001b]0;pwned\u0007 now" },
      { id: "b", label: "B" },
    ],
    edges: [{ id: "e", source: "a", target: "b", label: "edge \u001b[31m red" }],
    groups: [{ id: "g", label: "group \u0007 bell" }],
  };
  // Numbered labels put the edge text in the legend below the drawing too.
  const numbered = render(await layout(graph, { wrap: 10, numbered: true, gap: 1 }), { width: 80 });
  expect(numbered, JSON.stringify(numbered.slice(0, 200))).not.toMatch(CONTROL);
  const drawn = await drawGraph(graph, { width: 80, color: false, title: "t\u001b[2Jitle" });
  expect(drawn).not.toMatch(CONTROL);
});

test("edges are numbered in the order the flow reaches them, and a cycle ends", () => {
  const graph: GraphInput = {
    type: "freeform-graph",
    nodes: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ],
    edges: [
      { id: "back", source: "c", target: "b" },
      { id: "first", source: "a", target: "b" },
      { id: "second", source: "b", target: "c" },
    ],
    groups: [],
  };
  expect(flowOrder(graph).map((e) => e.id)).toEqual(["first", "second", "back"]);
});

// C1 controls (0x9B is a one-byte CSI on some terminals) and bidi overrides,
// which reorder what the reader sees, are as unwelcome as C0 ones.
test("the painter replaces C1 controls and bidi overrides too", async () => {
  const { drawGraph } = await import("../../src/terminal/draw.ts");
  const model = {
    type: "freeform-graph" as const,
    direction: "tb" as const,
    nodes: [{ id: "a", label: "red \u009b31m and \u202eesrever", shape: "rectangle" as const }],
    edges: [],
    groups: [],
  };
  const out = await drawGraph(model, { width: 80, color: false, title: "t\u009bx" });
  expect(out).not.toMatch(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
});

test("a two-way edge has a head at each end, and a label's line break is a space", async () => {
  const graph: GraphInput = {
    direction: "lr",
    nodes: [
      { id: "a", label: "Web\napp" },
      { id: "b", label: "API" },
    ],
    edges: [{ id: "e1", source: "a", target: "b", label: "both\nways", bidirectional: true }],
    groups: [],
  } as GraphInput;
  const text = await drawGraph(graph, { width: 80, color: false });
  expect(heads(text)).toBe(2);
  expect(text).toContain("both ways");
  expect(text).not.toMatch(CONTROL);
});
