import { describe, expect, it } from "vitest";
import { computeLayout } from "../src/layout/elk-adapter";
import type { LayoutEdge, LayoutResult } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";

/**
 * Legibility is measurable, so it is asserted rather than eyeballed.
 *
 * Every check here failed on a real diagram before this suite existed: wires
 * ran straight through boxes they had nothing to do with, captions sat on top
 * of node labels, and container frames excluded their own nested subgroups.
 * The numbers below are the ones a human was reading off screenshots.
 */

type Rect = { x: number; y: number; width: number; height: number };

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Exact segment/rectangle intersection — sampling can step over a thin box. */
function segmentHitsRect(a: { x: number; y: number }, b: { x: number; y: number }, r: Rect): boolean {
  const inside = (p: { x: number; y: number }) => p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height;
  if (inside(a) || inside(b)) return true;
  const side = (
    p1: { x: number; y: number },
    p2: { x: number; y: number },
    p3: { x: number; y: number },
    p4: { x: number; y: number },
  ) => {
    const d = (q: { x: number; y: number }, p: { x: number; y: number }, z: { x: number; y: number }) =>
      (q.x - p.x) * (z.y - p.y) - (q.y - p.y) * (z.x - p.x);
    const d1 = d(p3, p4, p1);
    const d2 = d(p3, p4, p2);
    const d3 = d(p1, p2, p3);
    const d4 = d(p1, p2, p4);
    return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
  };
  const c = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ];
  return side(a, b, c[0], c[1]) || side(a, b, c[1], c[2]) || side(a, b, c[2], c[3]) || side(a, b, c[3], c[0]);
}

function edgesThroughUnrelatedNodes(layout: LayoutResult): string[] {
  const offenders: string[] = [];
  for (const edge of layout.edges) {
    if (edge.points.length < 2) continue;
    for (const node of layout.nodes) {
      if (node.id === edge.source || node.id === edge.target) continue;
      const rect = { x: node.x, y: node.y, width: node.width, height: node.height };
      for (let i = 1; i < edge.points.length; i += 1) {
        if (segmentHitsRect(edge.points[i - 1], edge.points[i], rect)) {
          offenders.push(`${edge.id} through ${node.id}`);
          break;
        }
      }
    }
  }
  return offenders;
}

const anchorRect = (edge: LayoutEdge): Rect | undefined => edge.labelAnchor;

/**
 * The real `archer-registry` component view, which is where every one of these
 * defects was first seen. Kept at full size on purpose: a smaller fixture does
 * not reproduce them. Verified — with edges declared at the graph root instead
 * of at their lowest common ancestor, 7 of these 18 edges are routed straight
 * through a node they do not connect.
 */
function nestedView(): ProjectedView {
  const groups = [
    { id: "reg", label: "archer-registry", parentId: undefined },
    { id: "state", label: "Registry state", parentId: "reg" },
    { id: "load", label: "Construction", parentId: "reg" },
    { id: "mutate", label: "Runtime registration", parentId: "reg" },
    { id: "lookup", label: "Lookup", parentId: "reg" },
  ];
  const members: [string, string | undefined][] = [
    ["runtime", undefined],
    ["server", undefined],
    ["toml", undefined],
    ["mmd", undefined],
    ["identity", "reg"],
    ["boundary", "reg"],
    ["views", "state"],
    ["sources", "state"],
    ["root", "state"],
    ["manifest_fn", "load"],
    ["empty_fn", "load"],
    ["register", "mutate"],
    ["remove", "mutate"],
    ["promote", "mutate"],
    ["by_id", "lookup"],
    ["by_path", "lookup"],
  ];
  const wires: [string, string, string, string][] = [
    ["calls_lookup", "runtime", "by_path", "which view owns this path"],
    ["calls_load", "runtime", "manifest_fn", "load at startup"],
    ["calls_reg", "runtime", "register", "register_diagram tool"],
    ["calls_pin", "runtime", "promote", "pin_diagram tool"],
    ["matches", "server", "identity", "match a watcher event"],
    ["parses", "manifest_fn", "toml", "version, id, kind, title, source"],
    ["seeds", "manifest_fn", "views", "durable entries"],
    ["adds", "register", "views", "ephemeral entry"],
    ["checks_file", "register", "mmd", "must be an existing .mmd"],
    ["resolve_load", "manifest_fn", "identity", "resolve each source"],
    ["resolve_lookup", "by_path", "identity", "resolve the query"],
    ["guards", "identity", "boundary", "feeds"],
    ["refuses", "boundary", "runtime", "PathOutsideWorkspace"],
    ["keys", "identity", "sources", "one spelling per file"],
    ["dedupes", "sources", "register", "rejects a second view on one file"],
    ["anchors", "root", "boundary", "the containment test"],
    ["answers", "sources", "by_path", "view ID"],
    ["reads_views", "by_id", "views", "entry: id, kind, title, source, registration"],
  ];
  return {
    viewId: "registry",
    kind: "c4-component",
    title: "archer-registry internals",
    revision: "1",
    modelType: "architecture-graph",
    groups,
    nodes: members.map(([id, groupId]) => ({
      id,
      label: id,
      shape: "rectangle",
      classes: [],
      groupId,
    })),
    edges: wires.map(([id, source, target, label]) => ({ id, source, target, label })),
  } as ProjectedView;
}

describe("layout legibility", () => {
  it("routes no edge through a node it does not connect", async () => {
    const layout = await computeLayout(nestedView());
    expect(edgesThroughUnrelatedNodes(layout)).toEqual([]);
  });

  it("gives every edge the route ELK computed rather than a straight line", async () => {
    const layout = await computeLayout(nestedView());
    expect(layout.edges).toHaveLength(18);
    for (const edge of layout.edges) {
      expect(edge.points.length).toBeGreaterThanOrEqual(2);
    }
    // A layered graph with cross-group traffic cannot be drawn with straight
    // segments alone; if nothing bends, the routes were not ELK's.
    expect(layout.edges.some((e) => e.points.length > 2)).toBe(true);
  });

  it("sizes each group around everything it holds, including nested subgroups", async () => {
    const layout = await computeLayout(nestedView());
    const byId = new Map(layout.groups.map((g) => [g.id, g]));
    const outer = byId.get("reg");
    const left = byId.get("state");
    const right = byId.get("lookup");
    expect(outer).toBeDefined();
    expect(outer!.width).toBeGreaterThan(0);

    for (const child of [left!, right!]) {
      expect(child.x).toBeGreaterThanOrEqual(outer!.x);
      expect(child.y).toBeGreaterThanOrEqual(outer!.y);
      expect(child.x + child.width).toBeLessThanOrEqual(outer!.x + outer!.width);
      expect(child.y + child.height).toBeLessThanOrEqual(outer!.y + outer!.height);
    }
    for (const node of layout.nodes) {
      if (!node.groupId) continue;
      const g = byId.get(node.groupId)!;
      expect(node.x).toBeGreaterThanOrEqual(g.x);
      expect(node.x + node.width).toBeLessThanOrEqual(g.x + g.width);
    }
  });

  it("places every caption clear of every node box", async () => {
    const layout = await computeLayout(nestedView());
    const placed = layout.edges.map(anchorRect).filter((r): r is Rect => r !== undefined);
    expect(placed).toHaveLength(18);
    for (const label of placed) {
      for (const node of layout.nodes) {
        expect(overlaps(label, { x: node.x, y: node.y, width: node.width, height: node.height })).toBe(false);
      }
    }
  });

  it("places no caption on top of another caption", async () => {
    const layout = await computeLayout(nestedView());
    const placed = layout.edges.map(anchorRect).filter((r): r is Rect => r !== undefined);
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        expect(overlaps(placed[i], placed[j])).toBe(false);
      }
    }
  });

  it("puts each caption on the wire it describes", async () => {
    const layout = await computeLayout(nestedView());
    for (const edge of layout.edges) {
      const anchor = anchorRect(edge);
      if (!anchor) continue;
      const centre = { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 };
      let nearest = Infinity;
      for (let i = 1; i < edge.points.length; i += 1) {
        const a = edge.points[i - 1];
        const b = edge.points[i];
        const vx = b.x - a.x;
        const vy = b.y - a.y;
        const lenSq = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((centre.x - a.x) * vx + (centre.y - a.y) * vy) / lenSq));
        nearest = Math.min(nearest, Math.hypot(centre.x - (a.x + vx * t), centre.y - (a.y + vy * t)));
      }
      // On the line, not merely near it: the plate occludes the stroke.
      expect(nearest).toBeLessThan(1);
    }
  });

  // ELK has no font metrics: an unsized label reserves no space, so the layout
  // routes wires straight through where the caption will be drawn. A zero-sized
  // rectangle also silently satisfies every overlap check above, which is how a
  // mutation that dropped label sizing survived this suite once.
  it("reserves space proportional to the caption it will draw", async () => {
    const layout = await computeLayout(nestedView());
    const byId = new Map(layout.edges.map((e) => [e.id, e]));

    for (const edge of layout.edges) {
      const anchor = anchorRect(edge);
      expect(anchor, `edge ${edge.id} reserved no label box`).toBeDefined();
      expect(anchor!.width).toBeGreaterThan(0);
      expect(anchor!.height).toBeGreaterThan(0);
    }

    // "feeds" is the shortest caption in the fixture and the registration one
    // the longest; the reservation has to track the text, not be a constant.
    const shortest = anchorRect(byId.get("guards")!)!;
    const longest = anchorRect(byId.get("reads_views")!)!;
    expect(longest.width).toBeGreaterThan(shortest.width * 2);
  });

  it("lays the same view out identically every time", async () => {
    const [first, second] = await Promise.all([computeLayout(nestedView()), computeLayout(nestedView())]);
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
  });
});
