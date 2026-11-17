// A fan-out is drawn as a tree: one stem from the middle of the side the wires leave, a bus across the flow, a drop
// to each target. Rendered review, 2026-11-13: the QoS "Service Level?" diamond's four lines left as near-coincident
// runs about ten units apart, and the coffee URI's three as dotted runs eight apart -- a tangle at any zoom.
import { describe, expect, test } from "vitest";
import { computeLayout } from "../src/layout/elk-adapter";
import type { LayoutEdge, LayoutResult } from "../src/layout/elk-layout";
import { cornersOf } from "../src/layout/route-simplify";
import type { GraphDirection, ProjectedView } from "../src/diagrams/projection";
import { viewOf } from "./support/nest-strategies";

/** Runs across the flow closer than this, but not on one line, read as one tangled line. */
const DISTINCT_PX = 12;

function fanOf(layout: LayoutResult, source: string): LayoutEdge[] {
  return layout.edges.filter((edge) => edge.source === source);
}

/** Every pair of parallel runs from the fan that sit 0 < d < DISTINCT_PX apart and overlap along their length. */
function nearRuns(edges: readonly LayoutEdge[]): string[] {
  const runs = edges.flatMap((edge) => {
    const c = cornersOf(edge.points);
    return c.slice(1).map((b, i) => ({ id: edge.id, a: c[i]!, b }));
  });
  const found: string[] = [];
  for (let i = 0; i < runs.length; i += 1)
    for (let j = i + 1; j < runs.length; j += 1) {
      const p = runs[i]!;
      const q = runs[j]!;
      if (p.id === q.id) continue;
      const ph = Math.abs(p.a.y - p.b.y) < 0.5;
      const qh = Math.abs(q.a.y - q.b.y) < 0.5;
      const pv = Math.abs(p.a.x - p.b.x) < 0.5;
      const qv = Math.abs(q.a.x - q.b.x) < 0.5;
      const span = (u: number, v: number, w: number, z: number) =>
        Math.min(Math.max(u, v), Math.max(w, z)) - Math.max(Math.min(u, v), Math.min(w, z));
      if (ph && qh) {
        const d = Math.abs(p.a.y - q.a.y);
        if (d > 0.5 && d < DISTINCT_PX && span(p.a.x, p.b.x, q.a.x, q.b.x) > 0) found.push(`${p.id}/${q.id} ${d}`);
      }
      if (pv && qv) {
        const d = Math.abs(p.a.x - q.a.x);
        if (d > 0.5 && d < DISTINCT_PX && span(p.a.y, p.b.y, q.a.y, q.b.y) > 0) found.push(`${p.id}/${q.id} ${d}`);
      }
    }
  return found;
}

function expectTree(layout: LayoutResult, source: string, count: number): void {
  const fan = fanOf(layout, source);
  expect(fan).toHaveLength(count);
  // Every wire that turns leaves from one stem; a wire that runs straight down to its target keeps its own line.
  const turning = fan.filter((edge) => cornersOf(edge.points).length > 2);
  expect(turning.length).toBeGreaterThanOrEqual(2);
  const starts = turning.map((edge) => edge.points[0]!);
  for (const start of starts) {
    expect(start.x, "one stem").toBeCloseTo(starts[0]!.x, 3);
    expect(start.y, "one stem").toBeCloseTo(starts[0]!.y, 3);
  }
  expect(nearRuns(fan)).toEqual([]);
  // Each caption on its own wire.
  for (const edge of fan) {
    if (edge.labelAnchor === undefined) continue;
    const c = edge.labelAnchor;
    const centre = { x: c.x + c.width / 2, y: c.y + c.height / 2 };
    const on = cornersOf(edge.points)
      .slice(1)
      .some((b, i, all) => {
        const a = i === 0 ? edge.points[0]! : all[i - 1]!;
        return (
          centre.x >= Math.min(a.x, b.x) - 1 &&
          centre.x <= Math.max(a.x, b.x) + 1 &&
          centre.y >= Math.min(a.y, b.y) - 1 &&
          centre.y <= Math.max(a.y, b.y) + 1
        );
      });
    expect(on, `${edge.id}'s caption on its wire`).toBe(true);
  }
}

function slotsView(direction: GraphDirection): ProjectedView {
  const node = (id: string, label: string) => ({ id, label, shape: "rectangle", classes: [], groupId: undefined });
  return {
    viewId: "slots",
    kind: "freeform",
    title: "slots",
    revision: "1",
    modelType: "freeform-graph",
    direction,
    nodes: [
      node("scheme", "Scheme and Colon"),
      node("host", "Optional Host"),
      node("pot", "Optional Pot Designator"),
      node("additions", "Optional Additions List"),
    ],
    edges: [
      { id: "e1", source: "scheme", target: "host", label: "optional", line: "dotted" },
      { id: "e2", source: "scheme", target: "pot", label: "optional", line: "dotted" },
      { id: "e3", source: "scheme", target: "additions", label: "optional", line: "dotted" },
    ],
    groups: [],
  };
}

describe("a fan-out is drawn as a tree", () => {
  test("the QoS diamond's four classes share one stem, with no near-coincident runs", async () => {
    const layout = await computeLayout(await viewOf("examples/rfc-1149-ipoac/.archer/diagrams/qos-queues.mmd"));
    expectTree(layout, "level", 4);
  });

  test.each(["tb", "bt", "lr", "rl"] as const)("three optional slots from one box, flowing %s", async (direction) => {
    const layout = await computeLayout(slotsView(direction));
    expectTree(layout, "scheme", 3);
  });
});
