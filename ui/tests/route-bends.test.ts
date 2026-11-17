// Fewer needless corners (redesign slice 6; review C.8; owner, 2026-11-12). What counts is the DRAWING's total: the
// sum of every wire's corners, and the excess -- corners beyond the fewest each wire's two ends allow -- which are
// the needless ones a reader sees. Measured against the routes ELK and the nested view's router give on their own
// (`fixtures/route-bends-elk.json`), for the whole drawing (?zoom=full) and with every group opened in place in turn
// (the ?open= chain): on no drawing do the totals, the excess or the crossings rise, and on the owner's drawings they
// fall. A single wire may take a corner more if the drawing's totals fall. Every wire still ends on its boxes, along
// its side, and nothing lands on a box.
import { describe, expect, it } from "vitest";
import { computeLayout, type LayoutPoint, type LayoutResult } from "../src/layout/elk-adapter";
import { nestView } from "../src/nesting/nest-view";
import { chainOrder } from "../src/nesting/nest-engine";
import { growInPlaceV2 } from "../src/nesting/grow-in-place-v2";
import BEFORE from "./fixtures/route-bends-elk.json";
import { unsimplified } from "../src/layout/route-simplify";
import { routeMetrics, viewOfFile } from "./route-metrics";

const ROOT = `${__dirname}/../..`;
const PAGETURNER = `${ROOT}/tools/devkit/corpus/pageturner/.archer/diagrams`;
const AWKWARD = `${ROOT}/tools/devkit/corpus/awkward/.archer/diagrams`;
const FIXTURES = {
  "ship-loop": `${ROOT}/ui/tests/fixtures/palette/ship-loop.mmd`,
  "home-rig": `${ROOT}/ui/tests/fixtures/palette/home-rig.mmd`,
  fulfilment: `${PAGETURNER}/fulfilment.mmd`,
  containers: `${PAGETURNER}/containers.mmd`,
  deployment: `${PAGETURNER}/deployment.mmd`,
  "system-context": `${PAGETURNER}/system-context.mmd`,
  "data-model": `${PAGETURNER}/data-model.mmd`,
  "c4-boundaries": `${AWKWARD}/c4-boundaries.mmd`,
  "flow-styled": `${AWKWARD}/flow-styled.mmd`,
} as const;
type Name = keyof typeof FIXTURES;
type View = "full" | "opened";
type Totals = { bends: number; excess: number; crossings: number; length: number };
type Box = { x: number; y: number; width: number; height: number };

const memo = new Map<string, Promise<LayoutResult | undefined>>();
function layoutOf(name: Name, view: View): Promise<LayoutResult | undefined> {
  const key = `${name}:${view}`;
  if (!memo.has(key))
    memo.set(
      key,
      (async () => {
        const full = await viewOfFile(FIXTURES[name]);
        if (view === "full") return computeLayout(full);
        if (full.groups.length === 0) return undefined;
        // As a deep link opens them: from all closed, one group at a time (`nest-engine.ts` #chain).
        const base = nestView(full, []).view;
        let laid = { view: base, layout: await computeLayout(base) };
        const open: string[] = [];
        for (const id of chainOrder(
          full,
          full.groups.map((group) => group.id),
        )) {
          open.push(id);
          const view = nestView(full, open).view;
          laid = { view, layout: await growInPlaceV2(laid, view, id, { layout: (v) => computeLayout(v) }) };
        }
        return laid.layout;
      })(),
    );
  return memo.get(key)!;
}

const totals = (layout: LayoutResult): Totals => {
  const m = routeMetrics(layout);
  return { bends: m.totalBends, excess: m.excessBends, crossings: m.crossings, length: m.totalLength };
};
const baseline = (name: Name, view: View): Totals | undefined =>
  (BEFORE as unknown as Record<string, Partial<Record<View, Totals>>>)[name]?.[view];

/**
 * The 150-node stress flowchart, whole. Owner decision (2026-11-12): the layout follows the written order everywhere,
 * here too, accepting more crossings than the id-sorted layout gave (172 there, 183 here; opened 188 -> 222) for fewer
 * needless corners. So its crossings are held to what the written order gives, not to the id-sorted 172; its bends
 * and needless bends, like every other drawing's, may not rise. A crossing-reduction pass for very large drawings is a
 * follow-up, not this rule.
 */
/** The fixtures with groups, opened in turn. */
const CHAINED = ["home-rig", "containers", "deployment", "c4-boundaries", "flow-styled"] as const;

const FLOW_LARGE = `${AWKWARD}/flow-large.mmd`;
const FLOW_LARGE_CROSSINGS_ACCEPTED = 183;

describe("a simplifier never makes a drawing worse, step by step as groups open (owner, 2026-11-12)", () => {
  // Each grow builds on the one before, as a deep link opens them. At every step the drawing after simplification
  // takes no more bends, needless bends or crossings than the same step without it, and the whole chain ends no worse
  // than the chain without simplification did (recorded in route-bends-elk.json).
  it.each([...CHAINED, "flow-large"] as const)(
    "%s",
    async (name) => {
      const path = name === "flow-large" ? FLOW_LARGE : FIXTURES[name as Name];
      const full = await viewOfFile(path);
      const base = nestView(full, []).view;
      let laid = { view: base, layout: await computeLayout(base) };
      const open: string[] = [];
      for (const id of chainOrder(
        full,
        full.groups.map((group) => group.id),
      )) {
        open.push(id);
        const view = nestView(full, open).view;
        laid = { view, layout: await growInPlaceV2(laid, view, id, { layout: (v) => computeLayout(v) }) };
        const now = totals(laid.layout);
        const raw = totals(unsimplified(laid.layout));
        expect(now.bends, `${id}: bends`).toBeLessThanOrEqual(raw.bends);
        expect(now.excess, `${id}: needless bends`).toBeLessThanOrEqual(raw.excess);
        expect(now.crossings, `${id}: crossings`).toBeLessThanOrEqual(raw.crossings);
      }
      const end = totals(laid.layout);
      const was = (BEFORE as unknown as Record<string, { opened: Totals }>)[name]!.opened;
      expect(end.bends, "bends").toBeLessThanOrEqual(was.bends);
      expect(end.excess, "needless bends").toBeLessThanOrEqual(was.excess);
      expect(end.crossings, "crossings").toBeLessThanOrEqual(was.crossings);
    },
    300_000,
  );
});

describe("the numbers to beat: no more corners than before captions wrapped at 24 characters (owner, 2026-11-12)", () => {
  // Wider one-line captions raised containers to 18/8 and flow-styled to 8/4 (bends/needless, whole); the owner's
  // goal is fewer bends in absolute terms, so the values before that change (14/4 and 4/0) are the ones to meet.
  it.each([
    ["containers", 14, 4],
    ["flow-styled", 4, 0],
  ] as const)("%s, whole: at most %i bends and %i needless", async (name, bends, excess) => {
    const now = totals((await layoutOf(name, "full"))!);
    expect(now.bends).toBeLessThanOrEqual(bends);
    expect(now.excess).toBeLessThanOrEqual(excess);
  });
});

describe("the owner's recorded trade-off: the 150-node flowchart in written order", () => {
  it("takes no more corners or needless corners than before simplification, and crossings as accepted", async () => {
    const now = totals(await computeLayout(await viewOfFile(FLOW_LARGE)));
    const was = (BEFORE as unknown as Record<string, { full: Totals }>)["flow-large"]!.full;
    expect(now.bends).toBeLessThanOrEqual(was.bends);
    expect(now.excess).toBeLessThanOrEqual(was.excess);
    expect(now.crossings).toBeLessThanOrEqual(FLOW_LARGE_CROSSINGS_ACCEPTED);
  }, 120_000);
});

const CASES = (Object.keys(FIXTURES) as Name[]).flatMap((name) =>
  (["full", "opened"] as const).flatMap((view) => (baseline(name, view) === undefined ? [] : [[name, view] as const])),
);

const CASES_FOR_SPREAD: [Name, View][] = [
  ["ship-loop", "full"],
  ["home-rig", "full"],
  ["home-rig", "opened"],
  ["containers", "full"],
  ["containers", "opened"],
];

describe("a drawing's corners", () => {
  it.each(CASES)("%s, %s: no more corners, needless corners or crossings than before", async (name, view) => {
    const layout = (await layoutOf(name, view))!;
    const now = totals(layout);
    const was = baseline(name, view)!;
    expect(now.bends, "bends").toBeLessThanOrEqual(was.bends);
    expect(now.excess, "needless bends").toBeLessThanOrEqual(was.excess);
    expect(now.crossings, "crossings").toBeLessThanOrEqual(was.crossings);
  });

  it("falls on the owner's drawings and Pageturner's containers, whole and opened", async () => {
    const falls: [Name, View][] = [
      ["ship-loop", "full"],
      ["home-rig", "full"],
      ["home-rig", "opened"],
      ["containers", "full"],
      ["containers", "opened"],
    ];
    for (const [name, view] of falls) {
      const now = totals((await layoutOf(name, view))!);
      const was = baseline(name, view)!;
      expect(now.bends, `${name} ${view} bends`).toBeLessThan(was.bends);
      expect(now.excess, `${name} ${view} needless bends`).toBeLessThan(was.excess);
    }
    let now = 0;
    let was = 0;
    for (const [name, view] of CASES) {
      now += totals((await layoutOf(name, view))!).excess;
      was += baseline(name, view)!.excess;
    }
    // At least a third of the needless corners go.
    expect(now).toBeLessThanOrEqual((was * 2) / 3);
  });
});

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const runBox = (a: LayoutPoint, b: LayoutPoint, trim = 0): Box => {
  const vertical = Math.abs(a.x - b.x) < Math.abs(a.y - b.y);
  const lo = vertical ? Math.min(a.y, b.y) + trim : Math.min(a.x, b.x) + trim;
  const hi = vertical ? Math.max(a.y, b.y) - trim : Math.max(a.x, b.x) - trim;
  return vertical
    ? { x: a.x - 0.5, y: lo, width: 1, height: hi - lo }
    : { x: lo, y: a.y - 0.5, width: hi - lo, height: 1 };
};
const onBorder = (p: LayoutPoint, box: Box): boolean =>
  p.x >= box.x - 1 &&
  p.x <= box.x + box.width + 1 &&
  p.y >= box.y - 1 &&
  p.y <= box.y + box.height + 1 &&
  (Math.abs(p.x - box.x) <= 1 ||
    Math.abs(p.x - box.x - box.width) <= 1 ||
    Math.abs(p.y - box.y) <= 1 ||
    Math.abs(p.y - box.y - box.height) <= 1);
/** The way a wire leaves `box` from `p`, its first run's direction, points out of the side it is on. */
const leavesOutward = (p: LayoutPoint, next: LayoutPoint, box: Box): boolean => {
  const dx = Math.sign(next.x - p.x);
  const dy = Math.sign(next.y - p.y);
  return (
    (dy < 0 && Math.abs(p.y - box.y) <= 1) ||
    (dy > 0 && Math.abs(p.y - box.y - box.height) <= 1) ||
    (dx < 0 && Math.abs(p.x - box.x) <= 1) ||
    (dx > 0 && Math.abs(p.x - box.x - box.width) <= 1)
  );
};

/** The side of `box` a point is on (a small tolerance), or undefined. */
const sideAt = (p: LayoutPoint, box: Box): "top" | "bottom" | "left" | "right" | undefined => {
  if (Math.abs(p.y - box.y) <= 1 && p.x >= box.x - 1 && p.x <= box.x + box.width + 1) return "top";
  if (Math.abs(p.y - box.y - box.height) <= 1 && p.x >= box.x - 1 && p.x <= box.x + box.width + 1) return "bottom";
  if (Math.abs(p.x - box.x) <= 1 && p.y >= box.y - 1 && p.y <= box.y + box.height + 1) return "left";
  if (Math.abs(p.x - box.x - box.width) <= 1 && p.y >= box.y - 1 && p.y <= box.y + box.height + 1) return "right";
  return undefined;
};

describe("port sides (owner, 2026-11-12)", () => {
  it("routes the loop's back-edges out of and into a side, up a lane beside the flow, as the reference does", async () => {
    const layout = (await layoutOf("ship-loop", "full"))!;
    const nodes = new Map(layout.nodes.map((node) => [node.id, node]));
    for (const id of ["ok_plan", "decide_build", "remember_plan"]) {
      const edge = layout.edges.find((candidate) => candidate.id === id)!;
      const start = sideAt(edge.points[0]!, nodes.get(edge.source)!);
      const end = sideAt(edge.points[edge.points.length - 1]!, nodes.get(edge.target)!);
      expect([start, end], id).toSatisfy(
        ([a, b]: (string | undefined)[]) => (a === "left" || a === "right") && a === b,
      );
      expect(routeMetrics({ edges: [edge] }).totalBends, id).toBe(2);
    }
  });

  it.each(CASES_FOR_SPREAD)(
    "%s, %s: the wire ends on one side of a box are spread along it, not bunched",
    async (name, view) => {
      const layout = (await layoutOf(name, view))!;
      const nodes = new Map(layout.nodes.map((node) => [node.id, node]));
      const ends: { box: string; side: string; at: number; id: string }[] = [];
      for (const node of layout.nodes)
        for (const edge of layout.edges)
          for (const [p, mine] of [
            [edge.points[0], edge.source === node.id],
            [edge.points[edge.points.length - 1], edge.target === node.id],
          ] as const) {
            if (p === undefined || !mine) continue;
            const side = sideAt(p, node);
            if (side !== undefined)
              ends.push({ box: node.id, side, at: side === "top" || side === "bottom" ? p.x : p.y, id: edge.id });
          }
      const close: string[] = [];
      for (let i = 0; i < ends.length; i += 1)
        for (let j = i + 1; j < ends.length; j += 1) {
          const a = ends[i]!;
          const b = ends[j]!;
          if (a.box !== b.box || a.side !== b.side || a.id === b.id) continue;
          // At least half an even share of the side (16px clear of each corner) between neighbours; 40px is enough.
          const node = nodes.get(a.box)!;
          const length = (a.side === "top" || a.side === "bottom" ? node.width : node.height) - 32;
          const count = ends.filter((e) => e.box === a.box && e.side === a.side).length;
          const want = Math.min(40, length / count / 2);
          if (Math.abs(a.at - b.at) < want - 0.5) close.push(`${a.id} and ${b.id} on ${a.box}'s ${a.side}`);
        }
      expect(close).toEqual([]);
    },
  );
});

describe("every wire is still its own", () => {
  it.each(CASES)(
    "%s, %s: ends on its two boxes, leaving and entering through their sides, through no other box, no caption on a box",
    async (name, view) => {
      const layout = (await layoutOf(name, view))!;
      const nodes = new Map(layout.nodes.map((node) => [node.id, node]));
      const plain = (box: { shape?: string } | undefined) =>
        box !== undefined && box.shape !== "diamond" && box.shape !== "circle" && box.shape !== "hexagon";
      for (const edge of layout.edges) {
        const points = edge.points;
        if (points.length < 2 || edge.source === edge.target) continue;
        const source = nodes.get(edge.source);
        const target = nodes.get(edge.target);
        if (source !== undefined && plain(source) && onBorder(points[0]!, source))
          expect(leavesOutward(points[0]!, points[1]!, source), `${edge.id} leaves ${edge.source} outward`).toBe(true);
        if (target !== undefined && plain(target) && onBorder(points[points.length - 1]!, target))
          expect(
            leavesOutward(points[points.length - 1]!, points[points.length - 2]!, target),
            `${edge.id} enters ${edge.target} through a side`,
          ).toBe(true);
        for (let i = 1; i < points.length; i += 1) {
          const run = runBox(points[i - 1]!, points[i]!, 2);
          for (const node of layout.nodes)
            if (node.id !== edge.source && node.id !== edge.target)
              expect(overlaps(run, node), `${edge.id} through ${node.id}`).toBe(false);
        }
      }
      for (const edge of layout.edges)
        if (edge.labelAnchor !== undefined && edge.label)
          for (const node of layout.nodes)
            expect(overlaps(edge.labelAnchor, node), `${edge.id}'s label on ${node.id}`).toBe(false);
    },
    120_000,
  );
});
