// A graph is laid out in the direction its source declared.
//
// The flowchart header's direction was parsed and then dropped for a long
// time, so `flowchart LR` drew top to bottom. Wire contract version 2 carries
// it (ADR 0009); these tests pin everything that used to assume "down": the
// flow axis itself (inside nested groups too), the captions, the wire ends,
// the first-layer rule the camera uses, and the arrow keys.
//
// Every block enumerates all four directions, so a fifth with no handling
// fails here rather than silently drawing top to bottom.
import { describe, expect, it } from "vitest";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import { GRAPH_DIRECTIONS, insideShape, outlineOf } from "../src/layout/graph-metrics";
import { nextInDirection, type ArrowDirection } from "../src/diagrams/keyboard-nav";
import { entryBox, frameViewport, layoutBounds, readingZoom } from "../src/diagrams/viewport-fit";
import type { GraphDirection, ProjectedView } from "../src/diagrams/projection";
import { containersView } from "./graph-samples";

type Rect = { x: number; y: number; width: number; height: number };

/** How far along the flow a box's centre sits: larger is further downstream. */
const ALONG: Record<GraphDirection, (box: Rect) => number> = {
  tb: (box) => box.y + box.height / 2,
  bt: (box) => -(box.y + box.height / 2),
  lr: (box) => box.x + box.width / 2,
  rl: (box) => -(box.x + box.width / 2),
};

/** The arrow key that means "downstream" in each direction. */
const DOWNSTREAM_KEY: Record<GraphDirection, ArrowDirection> = {
  tb: "down",
  bt: "up",
  lr: "right",
  rl: "left",
};

/** A chain that enters a group, then a group nested inside that one. */
function chain(direction: GraphDirection | undefined): ProjectedView {
  const node = (id: string, groupId?: string) => ({
    id,
    label: id.toUpperCase(),
    shape: "rectangle",
    classes: [],
    groupId,
  });
  return {
    viewId: "chain",
    kind: "freeform",
    title: "chain",
    revision: "1",
    modelType: "freeform-graph",
    direction,
    groups: [
      { id: "outer", label: "Outer", parentId: undefined },
      { id: "inner", label: "Inner", parentId: "outer" },
    ],
    nodes: [node("a"), node("b", "outer"), node("c", "outer"), node("d", "inner"), node("e", "inner")],
    edges: [
      { id: "ab", source: "a", target: "b", label: "enters" },
      { id: "bc", source: "b", target: "c", label: undefined },
      { id: "cd", source: "c", target: "d", label: "descends" },
      { id: "de", source: "d", target: "e", label: undefined },
    ],
  };
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

function distanceToRoute(point: { x: number; y: number }, route: readonly { x: number; y: number }[]): number {
  let best = Infinity;
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1];
    const b = route[i];
    const lengthSq = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / lengthSq));
    best = Math.min(best, Math.hypot(point.x - (a.x + (b.x - a.x) * t), point.y - (a.y + (b.y - a.y) * t)));
  }
  return best;
}

describe("the flow axis follows the declared direction", () => {
  it.each(GRAPH_DIRECTIONS)("%s: every edge runs downstream, inside nested groups too", async (direction) => {
    const layout = await computeLayout(chain(direction));
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const along = ALONG[direction];

    for (const edge of layout.edges) {
      const source = byId.get(edge.source)!;
      const target = byId.get(edge.target)!;
      expect(along(target), `${edge.id} runs against ${direction}`).toBeGreaterThan(along(source));
    }
  });

  it("lays out an undeclared direction top to bottom", async () => {
    expect(await computeLayout(chain(undefined))).toEqual(await computeLayout(chain("tb")));
  });

  it.each(GRAPH_DIRECTIONS)("%s: says which direction it was laid out in", async (direction) => {
    expect((await computeLayout(chain(direction))).direction).toBe(direction);
  });

  it.each(GRAPH_DIRECTIONS)("%s: lays the same view out identically every time", async (direction) => {
    const view = { ...containersView(), direction };
    expect(await computeLayout(view)).toEqual(await computeLayout(view));
  });

  it.each(GRAPH_DIRECTIONS)("%s: still frames every group around what it holds", async (direction) => {
    const layout = await computeLayout(chain(direction));
    const groups = new Map(layout.groups.map((group) => [group.id, group]));
    const holds = (outer: Rect, inner: Rect): boolean =>
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width &&
      inner.y + inner.height <= outer.y + outer.height;

    expect(holds(groups.get("outer")!, groups.get("inner")!)).toBe(true);
    for (const node of layout.nodes) {
      if (node.groupId) expect(holds(groups.get(node.groupId)!, node), node.id).toBe(true);
    }
  });
});

describe("captions and wire ends hold in every direction", () => {
  const laidOut = new Map<GraphDirection, Promise<LayoutResult>>(
    GRAPH_DIRECTIONS.map((direction) => [direction, computeLayout({ ...containersView(), direction })]),
  );

  it.each(GRAPH_DIRECTIONS)("%s: keeps every caption off every node and off every other caption", async (direction) => {
    const layout = await laidOut.get(direction)!;
    const captions = layout.edges.filter((edge) => edge.labelAnchor !== undefined);
    expect(captions.length).toBe(layout.edges.filter((edge) => edge.label).length);

    const clashes: string[] = [];
    for (const edge of captions) {
      for (const node of layout.nodes) {
        if (overlaps(edge.labelAnchor!, node)) clashes.push(`${edge.id} on node ${node.id}`);
      }
      for (const other of captions) {
        if (other.id > edge.id && overlaps(edge.labelAnchor!, other.labelAnchor!)) {
          clashes.push(`${edge.id} on caption ${other.id}`);
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it.each(GRAPH_DIRECTIONS)("%s: puts each caption on the wire it describes", async (direction) => {
    const layout = await laidOut.get(direction)!;
    for (const edge of layout.edges) {
      const box = edge.labelAnchor;
      if (!box) continue;
      const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      expect(distanceToRoute(centre, edge.points), edge.id).toBeLessThan(1);
    }
  });

  it.each(GRAPH_DIRECTIONS)("%s: ends every wire on the outline that is drawn", async (direction) => {
    const layout = await laidOut.get(direction)!;
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const misses: string[] = [];
    for (const edge of layout.edges) {
      const last = edge.points.length - 1;
      for (const [nodeId, end, next] of [
        [edge.source, edge.points[0], edge.points[1]],
        [edge.target, edge.points[last], edge.points[last - 1]],
      ] as const) {
        const node = byId.get(nodeId)!;
        const length = Math.hypot(end.x - next.x, end.y - next.y) || 1;
        const ux = (end.x - next.x) / length;
        const uy = (end.y - next.y) / length;
        const shape = outlineOf(node.shape, node.classes);
        const inside = (px: number, py: number): boolean =>
          insideShape(shape, node.width, node.height, px - node.x, py - node.y);
        if (!inside(end.x + ux * 1.5, end.y + uy * 1.5) || inside(end.x - ux * 1.5, end.y - uy * 1.5)) {
          misses.push(`${edge.id} at ${node.id} (${shape})`);
        }
      }
    }
    expect(misses).toEqual([]);
  });
});

describe("the camera keeps the first layer in view, wherever that is", () => {
  it.each(GRAPH_DIRECTIONS)("%s: names the upstream end as where reading starts", async (direction) => {
    const layout = await computeLayout(chain(direction));
    const entry = entryBox(layout)!;
    const a = layout.nodes.find((node) => node.id === "a")!;

    // `a` is the only node with nothing upstream of it.
    expect(entry).toEqual({ x: a.x, y: a.y, width: a.width, height: a.height });
  });

  it.each(GRAPH_DIRECTIONS)(
    "%s: shows the first layer when the graph overflows at the readable floor",
    async (direction) => {
      const layout = await computeLayout({ ...containersView(), direction });
      const canvas = { width: 420, height: 320 };
      const padding = { top: 24, right: 24, bottom: 24, left: 24 };
      const frame = frameViewport(layoutBounds(layout)!, canvas, padding, readingZoom("flowchart"), entryBox(layout));
      expect(frame.zoom).toBe(readingZoom("flowchart").min);

      // The first layer's own edge -- top for tb, bottom for bt, left for lr,
      // right for rl -- is on screen, inside the gutter.
      const entry = entryBox(layout)!;
      const edgeOnScreen = {
        tb: entry.y * frame.zoom + frame.y,
        bt: (entry.y + entry.height) * frame.zoom + frame.y,
        lr: entry.x * frame.zoom + frame.x,
        rl: (entry.x + entry.width) * frame.zoom + frame.x,
      }[direction];
      const extent = direction === "tb" || direction === "bt" ? canvas.height : canvas.width;
      expect(edgeOnScreen).toBeGreaterThanOrEqual(24 - 1e-6);
      expect(edgeOnScreen).toBeLessThanOrEqual(extent - 24 + 1e-6);
    },
  );
});

describe("arrow keys follow what is drawn, not the direction it was authored in", () => {
  it.each(GRAPH_DIRECTIONS)("%s: the downstream arrow walks the chain in flow order", async (direction) => {
    const layout = await computeLayout(chain(direction));
    const key = DOWNSTREAM_KEY[direction];

    const walked = ["a"];
    for (let step = 0; step < 4; step += 1) {
      walked.push(nextInDirection(layout.nodes, walked[walked.length - 1], key)!);
    }
    expect(walked).toEqual(["a", "b", "c", "d", "e"]);
  });
});
