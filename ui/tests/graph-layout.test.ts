// What the graph layout owes the renderer, asserted on the two diagrams the
// defects were seen on (`graph-samples.ts`): boxes that hold their labels,
// captions that collide with nothing, and wires that reach the shape drawn
// rather than the rectangle around it.
import { beforeAll, describe, expect, it } from "vitest";
import { computeLayout, type LayoutResult } from "../src/layout/elk-adapter";
import {
  EDGE_LABEL_LEAD_PX,
  EDGE_LABEL_LINE_PX,
  NODE_SHAPES,
  edgeLabelBox,
  insideShape,
  nodeBox,
  outlineOf,
} from "../src/layout/graph-metrics";
import { LAYER_GAP } from "../src/layout/elk-layout";
import type { ProjectedView } from "../src/diagrams/projection";
import { containersView, systemContextView } from "./graph-samples";

type Rect = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Whether the segment a-b passes through the open interior of `r`. */
function segmentCrosses(a: Point, b: Point, r: Rect): boolean {
  // Liang-Barsky clip of the segment against the rectangle.
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q > 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return (
    clip(-dx, a.x - r.x) &&
    clip(dx, r.x + r.width - a.x) &&
    clip(-dy, a.y - r.y) &&
    clip(dy, r.y + r.height - a.y) &&
    t1 - t0 > 1e-9
  );
}

/**
 * Three wires into each non-rectangular shape and three out of it, so ELK has
 * to spread them along the box's sides -- away from the one point where the
 * outline and the box coincide.
 */
function fanView(): ProjectedView {
  // Every shape there is, so a new one is fanned into without being asked.
  const hubs = [...NODE_SHAPES.filter((shape) => shape !== "rectangle"), "database"];
  const leaves = ["a", "b", "c"];
  const plain = (id: string, label: string) => ({
    id,
    label,
    shape: "rectangle",
    classes: [],
    groupId: undefined,
  });
  return {
    viewId: "fan",
    kind: "freeform",
    title: "fan",
    revision: "1",
    modelType: "freeform-graph",
    groups: [],
    nodes: [
      ...leaves.map((id) => plain(id, id)),
      // `database` is a class, not a shape: on a rectangle it draws a cylinder.
      ...hubs.map((shape) =>
        shape === "database" ? { ...plain(shape, shape), classes: ["database"] } : { ...plain(shape, shape), shape },
      ),
      ...leaves.map((id) => plain(`${id}2`, id)),
    ],
    edges: hubs.flatMap((hub) => [
      ...leaves.map((leaf) => ({ id: `${leaf}-${hub}`, source: leaf, target: hub, label: undefined })),
      ...leaves.map((leaf) => ({ id: `${hub}-${leaf}2`, source: hub, target: `${leaf}2`, label: undefined })),
    ]),
  };
}

let context: LayoutResult;
let containers: LayoutResult;
let fan: LayoutResult;

beforeAll(async () => {
  context = await computeLayout(systemContextView());
  containers = await computeLayout(containersView());
  fan = await computeLayout(fanView());
});

const SAMPLES = [
  ["system context", () => context],
  ["containers", () => containers],
] as const;

describe("node boxes hold their labels", () => {
  it.each(SAMPLES)("gives every node of the %s the box its label needs", (_name, layout) => {
    for (const node of layout().nodes) {
      const box = nodeBox(node.label, node.shape, node.classes);
      expect({ id: node.id, width: node.width, height: node.height }).toEqual({
        id: node.id,
        width: box.width,
        height: box.height,
      });
    }
  });

  it("grows a node whose label needs three lines", () => {
    const repo = context.nodes.find((node) => node.id === "repo")!;
    const browser = context.nodes.find((node) => node.id === "browser")!;
    expect(repo.height).toBeGreaterThan(browser.height);
  });
});

describe("edge captions collide with nothing", () => {
  it.each(SAMPLES)("reserves, for every caption of the %s, the box it is drawn in", (_name, layout) => {
    for (const edge of layout().edges) {
      const drawn = edgeLabelBox(edge.label!);
      expect(edge.labelAnchor, edge.id).toBeDefined();
      expect({ id: edge.id, width: edge.labelAnchor!.width, height: edge.labelAnchor!.height }).toEqual({
        id: edge.id,
        width: drawn.width,
        height: drawn.height,
      });
    }
  });

  it.each(SAMPLES)("places no caption of the %s over another", (_name, layout) => {
    const placed = layout().edges.map((edge) => ({ id: edge.id, rect: edge.labelAnchor! }));
    const collisions: string[] = [];
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        if (overlaps(placed[i].rect, placed[j].rect)) {
          collisions.push(`${placed[i].id} x ${placed[j].id}`);
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it.each(SAMPLES)("places no caption of the %s over a node", (_name, layout) => {
    const collisions: string[] = [];
    for (const edge of layout().edges) {
      for (const node of layout().nodes) {
        if (overlaps(edge.labelAnchor!, node)) collisions.push(`${edge.id} x ${node.id}`);
      }
    }
    expect(collisions).toEqual([]);
  });

  // The plate is opaque. Sitting on a wire it does not describe, it cuts that
  // wire in two and reads as that wire's caption.
  it.each(SAMPLES)("places no caption of the %s over a wire it does not describe", (_name, layout) => {
    const collisions: string[] = [];
    for (const labelled of layout().edges) {
      for (const other of layout().edges) {
        if (other.id === labelled.id) continue;
        for (let i = 1; i < other.points.length; i += 1) {
          if (segmentCrosses(other.points[i - 1], other.points[i], labelled.labelAnchor!)) {
            collisions.push(`caption of ${labelled.id} on wire ${other.id}`);
            break;
          }
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  it.each(SAMPLES)("keeps every caption of the %s on its own wire", (_name, layout) => {
    for (const edge of layout().edges) {
      const anchor = edge.labelAnchor!;
      const crossesOwn = edge.points.some((point, i) => i > 0 && segmentCrosses(edge.points[i - 1], point, anchor));
      expect(crossesOwn, edge.id).toBe(true);
    }
  });
});

describe("wires meet the shape that is drawn", () => {
  it.each([...SAMPLES, ["fan", () => fan] as const])(
    "ends every wire of the %s on its node's outline",
    (_name, layout) => {
      const byId = new Map(layout().nodes.map((node) => [node.id, node]));
      const misses: string[] = [];
      for (const edge of layout().edges) {
        const ends = [
          { node: byId.get(edge.source)!, end: edge.points[0], next: edge.points[1] },
          {
            node: byId.get(edge.target)!,
            end: edge.points[edge.points.length - 1],
            next: edge.points[edge.points.length - 2],
          },
        ];
        for (const { node, end, next } of ends) {
          // One pixel further along the wire's own direction is inside the
          // shape; one pixel back is outside it. That is "on the outline".
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
    },
  );
});

describe("the layout stays compact enough to read", () => {
  // Each caption used to cost its layer gap twice over (238px between two
  // 60px nodes), which is what pushed a ten-layer graph past any readable fit.
  it("spends no more than a caption and its clearance between two layers", () => {
    const dev = context.nodes.find((node) => node.id === "dev")!;
    const agent = context.nodes.find((node) => node.id === "agent")!;
    // Two layer gaps, a caption of at most two lines, and the lead of line
    // kept on each side of it (ADR 0030): 40 + (36 + 2 x 16) + 40.
    expect(agent.y - (dev.y + dev.height)).toBeLessThanOrEqual(
      2 * LAYER_GAP + 2 * EDGE_LABEL_LINE_PX + 4 + 2 * EDGE_LABEL_LEAD_PX,
    );
  });
});

describe("a caption never hides its line (ADR 0030)", () => {
  /** Route length outside the plate before it and after it, less an arrowhead at each arrowed end. */
  function visibleLead(edge: LayoutResult["edges"][number]): { before: number; after: number } | null {
    const box = edge.labelAnchor;
    if (box === undefined || edge.points.length < 2 || edge.source === edge.target) return null;
    const inside = (x: number, y: number) => x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height;
    let travelled = 0,
      first = -1,
      last = -1;
    for (let i = 1; i < edge.points.length; i += 1) {
      const a = edge.points[i - 1]!,
        b = edge.points[i]!;
      const span = Math.hypot(b.x - a.x, b.y - a.y);
      for (let d = 0; d <= span; d += 0.5) {
        const t = span === 0 ? 0 : d / span;
        if (inside(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) {
          if (first < 0) first = travelled + d;
          last = travelled + d;
        }
      }
      travelled += span;
    }
    if (first < 0) return null;
    const head = 9;
    return { before: first - (edge.bidirectional ? head : 0), after: travelled - last - head };
  }

  for (const [name, view] of [
    ["system context", systemContextView],
    ["containers", containersView],
  ] as const) {
    it(`keeps at least 12px of line on both sides of every caption: ${name}`, async () => {
      const laid = await computeLayout(view());
      const short = laid.edges.flatMap((edge) => {
        const lead = visibleLead(edge);
        return lead === null || (lead.before >= 12 && lead.after >= 12)
          ? []
          : [`${edge.id}: ${lead.before.toFixed(1)} / ${lead.after.toFixed(1)}`];
      });
      expect(short).toEqual([]);
    });
  }

  it("puts a self-loop's caption beside its loop, off the line", async () => {
    const view: ProjectedView = {
      viewId: "loop",
      kind: "freeform",
      title: "Loop",
      revision: "1",
      modelType: "freeform-graph",
      direction: "lr",
      nodes: [{ id: "a", label: "Current", shape: undefined, classes: [], groupId: undefined }],
      edges: [{ id: "again", source: "a", target: "a", label: "Retries" }],
      groups: [],
    };
    const laid = await computeLayout(view);
    const edge = laid.edges.find((entry) => entry.id === "again")!;
    const box = edge.labelAnchor!;
    const onLine = edge.points.some(
      (point) => point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height,
    );
    expect(onLine).toBe(false);
  });
});
