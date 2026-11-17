import { test, expect } from "vitest";
import { paintNode } from "../src/export/svg";
test("state final mark retains the UI fourteen-pixel inner dot and distinct canvas fill", () => {
  const node = {
    id: "end",
    label: "",
    x: 0,
    y: 0,
    width: 30,
    height: 30,
    shape: "circle",
    classes: [],
    groupId: undefined,
    figure: { type: "state" as const, kind: "final" as const },
  };
  const svg = paintNode(node, { nodes: [node], edges: [], groups: [], width: 30, height: 30, direction: "tb" });
  expect(svg).toContain('r="7"');
  expect(svg).toContain('fill="var(--bg)"');
  expect(svg).toContain('font-size="11"');
});
test("a left state note attaches to the same near side used by FigureNode", () => {
  const node = {
    id: "state",
    label: "State",
    x: 200,
    y: 0,
    width: 180,
    height: 60,
    shape: "rounded",
    classes: [],
    groupId: undefined,
    figure: { type: "state" as const, kind: "state" as const },
    note: { x: 50, y: 12, width: 100, height: 36, lines: ["note"], text: "note", position: "left-of" as const },
  };
  const svg = paintNode(node, { nodes: [node], edges: [], groups: [], width: 380, height: 60 });
  expect(svg).toContain('x1="0" y1="30" x2="-50" y2="30"');
});
test("flowchart semantic kind keeps GraphNode’s actual pictogram", () => {
  const node = {
    id: "reader",
    label: "Reader",
    x: 0,
    y: 0,
    width: 180,
    height: 60,
    shape: "rectangle",
    classes: ["person"],
    groupId: undefined,
  };
  const svg = paintNode(node, { nodes: [node], edges: [], groups: [], width: 180, height: 60 });
  expect(svg).toContain('<circle cx="6" cy="3.4" r="2">');
});
test("C4 boundary caption retains the shared FrameNode kind word", async () => {
  const { paintGraph } = await import("../src/export/svg");
  const svg = paintGraph({
    nodes: [],
    edges: [],
    width: 240,
    height: 100,
    groups: [
      {
        id: "shop",
        label: "Shop",
        parentId: undefined,
        x: 0,
        y: 0,
        width: 240,
        height: 100,
        figure: { type: "boundary", kind: "system" },
      },
    ],
  });
  expect(svg.content).toContain("[System]");
  expect(svg.content).toContain('font-size="14"');
});
test("entity keys retain PK/FK/UK chip shapes, not only their words", () => {
  const node = {
    id: "entity",
    label: "Entity",
    x: 0,
    y: 0,
    width: 220,
    height: 100,
    shape: "rectangle",
    classes: [],
    groupId: undefined,
    figure: {
      type: "entity" as const,
      attributes: [
        { type: "int", name: "id", keys: ["PK" as const, "FK" as const, "UK" as const], comment: undefined },
      ],
    },
  };
  const svg = paintNode(node, { nodes: [node], edges: [], groups: [], width: 220, height: 100 });
  for (const key of ["PK", "FK", "UK"]) expect(svg).toContain(`data-attribute-key="${key}"`);
  expect(svg).toContain('stroke-dasharray="3 2"');
});
// A C4 relationship's technology and description are drawn on the plate under its label, as the canvas draws
// them (decided 2026-10-31): the technology at the C4 type line's 11px, every row inside the reserved plate.
test("an exported caption draws a relationship's technology and description under its label, inside its plate", async () => {
  const { paintGraph } = await import("../src/export/svg");
  const { captionWithDetail, edgeLabelBox } = await import("../src/layout/graph-metrics");
  const caption = captionWithDetail("Buys from", "HTTPS", "Every page of the shop")!,
    box = edgeLabelBox(caption);
  const edge = (id: string, label: string) => ({
    id,
    source: "a",
    target: "b",
    label,
    points: [
      { x: 0, y: 0 },
      { x: 0, y: 200 },
    ],
    labelAnchor: { x: -box.width / 2, y: 90, width: box.width, height: box.height },
  });
  const svg = paintGraph({
    nodes: [],
    groups: [],
    width: 200,
    height: 200,
    edges: [edge("described", caption), edge("alone", captionWithDetail(undefined, "SQL", undefined)!)],
  } as never);
  expect(svg.content).not.toContain("ⓘ");
  expect(svg.content).not.toContain("\u001f");
  const described = svg.content.split('<g data-element-id="described"')[1]!.split("</g>")[0]!;
  const rows = [...described.matchAll(/<tspan x="[^"]+" y="([^"]+)">([^<]+)<\/tspan>/g)];
  expect(rows.map((row) => row[2])).toEqual([...box.lines, "[HTTPS]", ...box.description]);
  for (const row of rows) expect(Number(row[1])).toBeLessThan(90 + box.height);
  expect(described).toMatch(/font-size="11"[^>]*><tspan[^>]*>\[HTTPS\]/);
  expect(svg.content.split('<g data-element-id="alone"')[1]!).toContain(">[SQL]<");
});
