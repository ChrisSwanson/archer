import { test, expect } from "vitest";
import { compile } from "../../ts/src/mermaid/index";
import { projectEnvelope } from "../src/diagrams/projection";
import { computeLayout } from "../src/layout/elk-adapter";
import { paintGraph } from "../src/export/svg";
import { roundedRoute } from "../src/diagrams/rounded-route";
import { arrowsOf } from "../src/diagrams/figures";
test("export graph coordinates and caption boxes are the production layout's", async () => {
  const model = (await compile("flowchart LR\n a[Web]\n b[API]\n a calls@-->|request| b\n")).model;
  const projected = projectEnvelope({
    schemaVersion: 2,
    revision: `sha256:${"a".repeat(64)}`,
    view: { id: "test", kind: "freeform", title: "Test" },
    model,
  });
  expect(projected.ok).toBe(true);
  if (!projected.ok || projected.type !== "graph") throw new Error("expected graph");
  const layout = await computeLayout(projected.view),
    painted = paintGraph(layout);
  for (const node of layout.nodes) expect(painted.content).toContain(`transform="translate(${node.x} ${node.y})"`);
  for (const edge of layout.edges) {
    const arrows = arrowsOf(edge.figure);
    expect(painted.content).toContain(
      `d="${roundedRoute(edge.points, { arrowStart: arrows.start, arrowEnd: arrows.end })}"`,
    );
    const box = edge.labelAnchor!;
    expect(painted.content).toContain(`x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}"`);
  }
});
test("two arrowheads share the actual short straight terminal lane", async () => {
  const { arrowMarkerWidth } = await import("../src/diagrams/ArrowMarkers");
  const painted = paintGraph({
    nodes: [],
    groups: [],
    width: 30,
    height: 10,
    edges: [
      {
        id: "two",
        source: "a",
        target: "b",
        label: undefined,
        labelAnchor: undefined,
        points: [
          { x: 0, y: 0 },
          { x: 30, y: 0 },
        ],
        figure: { type: "c4", bidirectional: true },
      },
    ],
  });
  expect(painted.content.match(/markerWidth="([^"]+)"/g)).toEqual([
    `markerWidth="${arrowMarkerWidth(1, 15)}"`,
    `markerWidth="${arrowMarkerWidth(1, 15)}"`,
  ]);
});
