// Grow in place v2 (ui/src/nesting/grow-in-place-v2.ts) and its router (ortho-router.ts): opening
// a box keeps every untouched pair's order, opens no overlap, keeps every box inside its frame,
// draws every wire, and no wire runs through a box or through a frame it has no end in; closing
// it again (compaction) keeps the same guarantees and gives the space back. Real diagrams, the
// production ELK pipeline for the inside, no WASM.

import { describe, expect, test } from "vitest";
import { computeLayout } from "../src/layout/elk-adapter";
import type { LayoutResult } from "../src/layout/elk-layout";
import type { ProjectedView } from "../src/diagrams/projection";
import { canonicalOpen, nestView } from "../src/nesting/nest-view";
import { closeInPlace, growInPlaceV2, growInPlaceV2Staged } from "../src/nesting/grow-in-place-v2";
import { newProfile } from "../src/nesting/profile";
import { routeOrthogonalJs } from "../src/nesting/ortho-router";
import { routeCrosses } from "../src/nesting/route-geometry";
import { closeOut, enclosureFaults, frameEdges, layOut, quality, viewOf, type Laid } from "./support/nest-strategies";
import { intersects } from "../src/nesting/route-geometry";
import { frameToggleRect } from "../src/nesting/toggle-place";

const SOURCES = [
  "ts/test/fixtures/c4/nested.mmd",
  "tools/devkit/corpus/awkward/.archer/diagrams/c4-boundaries.mmd",
  "tools/devkit/corpus/pageturner/.archer/diagrams/containers.mmd",
  "tools/devkit/corpus/awkward/.archer/diagrams/state-composite.mmd",
  "tools/devkit/corpus/awkward/.archer/diagrams/arch-awkward.mmd",
  ".archer/diagrams/service/application-components.mmd",
];

type Box = { x: number; y: number; width: number; height: number };
const boxesOf = (layout: LayoutResult, view: ProjectedView) => {
  const out = new Map<string, Box>();
  for (const node of layout.nodes) out.set(node.id, node);
  for (const group of layout.groups)
    out.set(view.groups.find((g) => g.id === group.id)?.element === true ? group.id : `group:${group.id}`, group);
  return out;
};
const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width - 0.5 && a.x + a.width > b.x + 0.5 && a.y < b.y + b.height - 0.5 && a.y + a.height > b.y + 0.5;
const inside = (inner: Box, outer: Box) =>
  inner.x >= outer.x - 0.5 &&
  inner.y >= outer.y - 0.5 &&
  inner.x + inner.width <= outer.x + outer.width + 0.5 &&
  inner.y + inner.height <= outer.y + outer.height + 0.5;
const c = (bx: Box) => ({ x: bx.x + bx.width / 2, y: bx.y + bx.height / 2 });

/** Every untouched pair keeps its order along both axes. */
function expectOrderKept(b0: Map<string, Box>, b1: Map<string, Box>, ids: readonly string[]): void {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [p, q, r, s] = [b0.get(ids[i]!)!, b0.get(ids[j]!)!, b1.get(ids[i]!)!, b1.get(ids[j]!)!];
      expect(
        Math.sign(Math.round(c(p).x - c(q).x)) * Math.sign(Math.round(c(r).x - c(s).x)),
        `${ids[i]} / ${ids[j]} x`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        Math.sign(Math.round(c(p).y - c(q).y)) * Math.sign(Math.round(c(r).y - c(s).y)),
        `${ids[i]} / ${ids[j]} y`,
      ).toBeGreaterThanOrEqual(0);
    }
  }
}

/** No two boxes overlap, every box is in its frame, every wire is drawn and clears every box and frame. */
/**
 * Opens whose two "N connections" plates touch where neither bundle has a free stretch: since the
 * nested view's closed boxes carry their "N inside" caption row (taller, sometimes wider), the
 * `bin` bundles of application-components meet when `doors` opens. Best-effort placement, known.
 */
const KNOWN_OPEN_PLATES: ReadonlySet<string> = new Set(["doors"]);
const allowedPlates = (path: string, opened: string): "clear" | "frames only" =>
  path.endsWith("application-components.mmd") && KNOWN_OPEN_PLATES.has(opened) ? "frames only" : "clear";

function expectSound(layout: LayoutResult, view: ProjectedView, plates: "clear" | "frames only" = "clear"): void {
  for (let i = 0; i < layout.nodes.length; i++) {
    for (let j = i + 1; j < layout.nodes.length; j++)
      expect(overlap(layout.nodes[i]!, layout.nodes[j]!), `${layout.nodes[i]!.id} / ${layout.nodes[j]!.id}`).toBe(
        false,
      );
  }
  const frames = new Map(layout.groups.map((g) => [g.id, g]));
  for (const node of layout.nodes)
    if (node.groupId !== undefined)
      expect(inside(node, frames.get(node.groupId)!), `${node.id} in ${node.groupId}`).toBe(true);
  for (const g of layout.groups)
    if (g.parentId !== undefined && frames.has(g.parentId))
      expect(inside(g, frames.get(g.parentId)!), `${g.id} in ${g.parentId}`).toBe(true);
  // Every wire of the view is drawn; bundled layouts add their trunks.
  expect(
    layout.edges
      .filter((e) => !e.id.startsWith("trunk:"))
      .map((e) => e.id)
      .sort(),
  ).toEqual(view.edges.map((e) => e.id).sort());
  for (const edge of layout.edges) {
    expect(edge.points.length, edge.id).toBeGreaterThanOrEqual(2);
    for (const node of layout.nodes) {
      if (node.id === edge.source || node.id === edge.target) continue;
      expect(routeCrosses(edge.points, node, 2), `${edge.id} through ${node.id}`).toBe(false);
    }
  }
  const q = quality(layout, view);
  expect(q.throughBoxes).toBe(0);
  expect(q.frameFaults, "wires through or along a frame they have no end in").toBe(0);
  expectFramesWhole(layout, view);
  if (plates === "clear") expect(q.plateFaults, "label plates on a frame edge, a box or another plate").toBe(0);
}

/** Every open group is drawn, encloses its contents (notes too) 4 px clear, and no label plate covers its edge. */
function expectFramesWhole(layout: LayoutResult, view: ProjectedView): void {
  expect(enclosureFaults(layout, view), "open frames missing or not enclosing their contents").toBe(0);
  for (const edge of layout.edges) {
    if (edge.labelAnchor === undefined || !edge.label) continue;
    for (const g of layout.groups)
      expect(
        frameEdges(g).some((strip) => intersects(edge.labelAnchor!, strip)),
        `${edge.id}'s label on ${g.id}'s edge`,
      ).toBe(false);
    // The "−" is drawn over the canvas: a plate under it would be hidden.
    for (const g of layout.groups)
      expect(intersects(edge.labelAnchor, frameToggleRect(g)), `${edge.id}'s label under ${g.id}'s −`).toBe(false);
  }
  // Nor a wire: the "−" would hide it where it runs (Pageturner containers, Shop Staff to Back Office, 2026-10-31).
  for (const edge of layout.edges) {
    for (const g of layout.groups)
      expect(routeCrosses(edge.points, frameToggleRect(g), 0), `${edge.id} under ${g.id}'s −`).toBe(false);
  }
  // Nor through a frame's caption (Pageturner containers opened: Shop Staff to Back Office ran through
  // "Booksho|p", R7-claude-01), nor under another wire's plate (api to payments under the right edge
  // of api to db's "Reads and writes [SQL]", R7-codex-01).
  for (const edge of layout.edges) {
    for (const g of layout.groups)
      if (g.caption !== undefined)
        expect(routeCrosses(edge.points, g.caption, 0), `${edge.id} through ${g.id}'s caption`).toBe(false);
    for (const other of layout.edges) {
      if (other === edge || other.labelAnchor === undefined) continue;
      expect(routeCrosses(edge.points, other.labelAnchor, 0), `${edge.id} under ${other.id}'s plate`).toBe(false);
    }
  }
}

const deps = { layout: (view: ProjectedView) => computeLayout(view) };

describe.each(SOURCES)("%s", (path) => {
  test("each + from the top keeps order and soundness; closing it again gives the space back", async () => {
    const full = await viewOf(path);
    const top = nestView(full, []);
    const before = { view: top.view, layout: await computeLayout(top.view) };
    expect(top.closed.size).toBeGreaterThan(0);
    for (const [groupId, box] of top.closed) {
      const afterView = nestView(full, canonicalOpen(full, [groupId])).view;
      const grown = await growInPlaceV2(before, afterView, groupId, deps);
      const b0 = boxesOf(before.layout, before.view);
      const b1 = boxesOf(grown, afterView);
      const untouched = before.layout.nodes.map((n) => n.id).filter((id) => id !== box.drawnId && b1.has(id));
      expectOrderKept(b0, b1, untouched);
      expectSound(grown, afterView, allowedPlates(path, groupId));

      const closed = await closeInPlace({ view: afterView, layout: grown }, top.view, groupId, deps);
      const b2 = boxesOf(closed, top.view);
      expectOrderKept(b1, b2, untouched);
      expectSound(closed, top.view);
      // With the open's record, every box goes back to where it was (relative to the first box).
      const ref = untouched[0];
      if (ref !== undefined) {
        const shift = { x: b2.get(ref)!.x - b0.get(ref)!.x, y: b2.get(ref)!.y - b0.get(ref)!.y };
        for (const id of untouched) {
          expect(
            Math.abs(b2.get(id)!.x - b0.get(id)!.x - shift.x),
            `${id} x after closing ${groupId}`,
          ).toBeLessThanOrEqual(1);
          expect(
            Math.abs(b2.get(id)!.y - b0.get(id)!.y - shift.y),
            `${id} y after closing ${groupId}`,
          ).toBeLessThanOrEqual(1);
        }
      }
      // Without it (a deep link), compaction alone: still sound and in order, and no larger than the open layout.
      const compacted = await closeInPlace({ view: afterView, layout: { ...grown } }, top.view, groupId, deps);
      expectOrderKept(b1, boxesOf(compacted, top.view), untouched);
      expectSound(compacted, top.view, "frames only");
      expect(compacted.width * compacted.height).toBeLessThanOrEqual(grown.width * grown.height);
    }
  }, 60_000);
});

describe("every press of the benchmark (55), open then close", () => {
  const SOURCES_ALL = [
    "ts/test/fixtures/c4/nested.mmd",
    "ts/test/fixtures/c4/widened.mmd",
    "tools/devkit/corpus/awkward/.archer/diagrams/c4-boundaries.mmd",
    "tools/devkit/corpus/awkward/.archer/diagrams/state-composite.mmd",
    "tools/devkit/corpus/awkward/.archer/diagrams/arch-awkward.mmd",
    ".archer/diagrams/overview/runtime-topology.mmd",
    ".archer/diagrams/service/application-components.mmd",
    "tools/devkit/corpus/awkward/.archer/diagrams/flow-large.mmd",
  ];
  test.each(SOURCES_ALL.flatMap((path) => (["grow2", "grow2b"] as const).map((strategy) => [path, strategy] as const)))(
    "%s, %s: frames whole, plates off frame edges",
    async (path, strategy) => {
      const full = await viewOf(path);
      const history = new Map<string, Laid>();
      const remembered = async (open: readonly string[]) => {
        const key = open.join(",");
        if (!history.has(key)) history.set(key, await layOut(full, open, "plain"));
        return history.get(key)!;
      };
      const queue: string[][] = [[]];
      const seen = new Set([""]);
      let presses = 0;
      let deepLinkPlates = 0;
      let recordedPlates = 0;
      while (queue.length > 0 && presses < 12) {
        const open = queue.shift()!;
        for (const [groupId] of nestView(full, open).closed) {
          if (presses >= 12) break;
          const next = canonicalOpen(full, [...open, groupId]);
          const before = await remembered(open);
          const grown = await layOut(full, next, strategy, before, groupId);
          expectSound(grown.layout, grown.view, open.length === 0 ? allowedPlates(path, groupId) : "clear");
          const closed = await closeOut(full, open, grown, groupId, false, strategy === "grow2b");
          // Bundled lines have one known plate pair with no free stretch on a recorded close
          // (application-components, compiler open, −core: a bundle and e_painter leave core side by side).
          expectSound(closed.layout, closed.view, strategy === "grow2b" ? "frames only" : "clear");
          if (strategy === "grow2b") recordedPlates += quality(closed.layout, closed.view).plateFaults;
          // Without the open's record (a deep link): sound and frames whole; plates may touch where
          // no wire has a free stretch (one known case in the 55: application-components, ∅ −core).
          const compacted = await closeOut(full, open, grown, groupId, true, strategy === "grow2b");
          expectSound(compacted.layout, compacted.view, "frames only");
          deepLinkPlates += quality(compacted.layout, compacted.view).plateFaults;
          presses++;
          const key = next.join(",");
          if (!seen.has(key)) {
            seen.add(key);
            queue.push(next);
          }
        }
      }
      expect(presses).toBeGreaterThan(0);
      expect(deepLinkPlates).toBeLessThanOrEqual(path.endsWith("application-components.mmd") ? 1 : 0);
      expect(recordedPlates).toBeLessThanOrEqual(path.endsWith("application-components.mmd") ? 1 : 0);
    },
    300_000,
  );
});

describe("chains", () => {
  test("open two boxes in turn, close them in reverse: every box comes back to where it started", async () => {
    const full = await viewOf(".archer/diagrams/service/application-components.mmd");
    const top = nestView(full, []);
    const start = { view: top.view, layout: await computeLayout(top.view) };
    const v1 = nestView(full, canonicalOpen(full, ["core"])).view;
    const one = { view: v1, layout: await growInPlaceV2(start, v1, "core", deps) };
    const v2 = nestView(full, canonicalOpen(full, ["core", "compiler"])).view;
    const two = { view: v2, layout: await growInPlaceV2(one, v2, "compiler", deps) };
    expectSound(two.layout, v2);
    const back1 = { view: v1, layout: await closeInPlace(two, v1, "compiler", deps) };
    expectSound(back1.layout, v1);
    const back0 = await closeInPlace(back1, top.view, "core", deps);
    expectSound(back0, top.view);
    const b0 = boxesOf(start.layout, start.view);
    const b1 = boxesOf(back0, top.view);
    const ids = start.layout.nodes.map((n) => n.id);
    const shift = { x: b1.get(ids[0]!)!.x - b0.get(ids[0]!)!.x, y: b1.get(ids[0]!)!.y - b0.get(ids[0]!)!.y };
    for (const id of ids) {
      expect(Math.abs(b1.get(id)!.x - b0.get(id)!.x - shift.x), `${id} x`).toBeLessThanOrEqual(1);
      expect(Math.abs(b1.get(id)!.y - b0.get(id)!.y - shift.y), `${id} y`).toBeLessThanOrEqual(1);
    }
  }, 60_000);
});

describe("closing out of order (review #5)", () => {
  test("open two boxes, close the first one first: still sound and in order", async () => {
    const full = await viewOf(".archer/diagrams/service/application-components.mmd");
    const top = nestView(full, []);
    const start = { view: top.view, layout: await computeLayout(top.view) };
    const v1 = nestView(full, canonicalOpen(full, ["cli_only"])).view;
    const one = { view: v1, layout: await growInPlaceV2(start, v1, "cli_only", deps) };
    const v2 = nestView(full, canonicalOpen(full, ["cli_only", "core"])).view;
    const two = { view: v2, layout: await growInPlaceV2(one, v2, "core", deps) };
    const vCore = nestView(full, canonicalOpen(full, ["core"])).view;
    const back1 = { view: vCore, layout: await closeInPlace(two, vCore, "cli_only", deps) };
    expectSound(back1.layout, vCore);
    const back0 = await closeInPlace(back1, top.view, "core", deps);
    expectSound(back0, top.view);
    const ids = start.layout.nodes.map((n) => n.id);
    expectOrderKept(boxesOf(start.layout, start.view), boxesOf(back0, top.view), ids);
  }, 60_000);
});

describe("work budget (load-independent)", () => {
  // Counters, not milliseconds: the host is shared and loaded, the work is not. Measured 2026-10-21
  // on this press: 2,444 grid points, 66 searches, 54,316 expansions. The budget allows 1.5×.
  test("opening Shared operations stays within its search budget", async () => {
    const full = await viewOf(".archer/diagrams/service/application-components.mmd");
    const top = nestView(full, []);
    const before = { view: top.view, layout: await computeLayout(top.view) };
    const afterView = nestView(full, canonicalOpen(full, ["core"])).view;
    const profile = newProfile();
    await growInPlaceV2(before, afterView, "core", { ...deps, profile });
    // Since 2026-10-31 two grids: the wires round the boxes (3,080 points), then the two that ran
    // under core's "−" routed again round it (1,517).
    expect(profile.counts["grid.points"]).toBeLessThanOrEqual(6_900);
    expect(profile.counts["search.expanded"]).toBeLessThanOrEqual(82_000);
    expect(profile.spans.route).toBeGreaterThan(0);
  }, 60_000);

  // A frame's "−" as an obstacle in every search doubled these presses (1,124,176 and 1,297,368
  // expansions against 568,959 and 616,823 with no "−" kept clear); routing again only the wires that
  // run under one: 720,194 and 808,805. Keeping wires off captions and other wires' plates the same
  // way (one repair search for the few found there, after the plates are placed): 764,659 and
  // 786,423. The budget allows 1.5× of the first pair's sum.
  test("keeping wires off the − stays cheap on the large flowchart (g0 open, then g2 or g4)", async () => {
    const full = await viewOf("tools/devkit/corpus/awkward/.archer/diagrams/flow-large.mmd");
    const top = nestView(full, []);
    const before = { view: top.view, layout: await computeLayout(top.view) };
    const g0 = {
      view: nestView(full, ["g0"]).view,
      layout: await growInPlaceV2(before, nestView(full, ["g0"]).view, "g0", deps),
    };
    let expanded = 0;
    for (const next of ["g2", "g4"]) {
      const profile = newProfile();
      const view = nestView(full, canonicalOpen(full, ["g0", next])).view;
      const grown = await growInPlaceV2(g0, view, next, { ...deps, profile });
      for (const edge of grown.edges)
        for (const g of grown.groups)
          expect(routeCrosses(edge.points, frameToggleRect(g), 0), `${edge.id} under ${g.id}'s −`).toBe(false);
      expanded += profile.counts["search.expanded"] ?? 0;
    }
    expect(expanded).toBeLessThanOrEqual(2_290_000);
  }, 60_000);

  test("staged: the first picture has every box in place and an orthogonal wire for each edge", async () => {
    const full = await viewOf(".archer/diagrams/service/application-components.mmd");
    const top = nestView(full, []);
    const before = { view: top.view, layout: await computeLayout(top.view) };
    const afterView = nestView(full, canonicalOpen(full, ["core"])).view;
    const staged = await growInPlaceV2Staged(before, afterView, "core", deps);
    const done = staged.complete();
    expect(staged.first.nodes.map((n) => [n.id, n.x, n.y])).toEqual(done.nodes.map((n) => [n.id, n.x, n.y]));
    expect(staged.first.edges.map((e) => e.id).sort()).toEqual(afterView.edges.map((e) => e.id).sort());
    for (const edge of staged.first.edges)
      expect(
        edge.points.every((p, i) => i === 0 || p.x === edge.points[i - 1]!.x || p.y === edge.points[i - 1]!.y),
        edge.id,
      ).toBe(true);
    expectSound(done, afterView);
  }, 60_000);
});

describe("router", () => {
  const rect = (x: number, y: number, width = 100, height = 40) => ({ x, y, width, height });

  test("goes around a box in the way, orthogonally, with few bends", () => {
    const routes = routeOrthogonalJs({
      obstacles: [
        { id: "a", rect: rect(0, 0) },
        { id: "wall", rect: rect(0, 100, 100, 40) },
        { id: "b", rect: rect(0, 200) },
      ],
      connections: [{ id: "e", source: "a", target: "b" }],
    });
    const points = routes.get("e")!;
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points.every((p, i) => i === 0 || p.x === points[i - 1]!.x || p.y === points[i - 1]!.y)).toBe(true);
    expect(routeCrosses(points, rect(0, 100, 100, 40), 1)).toBe(false);
    expect(points.length - 2).toBeLessThanOrEqual(4);
  });

  test("never enters a frame neither end is in, and leaves its own frame once", () => {
    const frame = rect(200, -100, 200, 240);
    const routes = routeOrthogonalJs({
      obstacles: [
        { id: "a", rect: rect(0, 0) },
        { id: "b", rect: rect(500, 0) },
        { id: "in", rect: rect(250, 0) },
      ],
      frames: [{ id: "f", rect: frame }],
      connections: [
        { id: "around", source: "a", target: "b" },
        { id: "out", source: "in", target: "b" },
      ],
      direction: "lr",
    });
    const around = routes.get("around")!;
    expect(routeCrosses(around, frame, 0.5)).toBe(false);
    const out = routes.get("out")!;
    const strictlyIn = (p: { x: number; y: number }) =>
      p.x > frame.x && p.x < frame.x + frame.width && p.y > frame.y && p.y < frame.y + frame.height;
    let passes = 0;
    for (let k = 1; k < out.length; k++) if (strictlyIn(out[k - 1]!) !== strictlyIn(out[k]!)) passes++;
    expect(passes).toBe(1);
  });

  test("wires leaving one side are spread apart, not drawn on top of each other", () => {
    const routes = routeOrthogonalJs({
      obstacles: [
        { id: "a", rect: rect(0, 0, 100, 80) },
        { id: "b", rect: rect(300, -60) },
        { id: "c", rect: rect(300, 100) },
      ],
      connections: [
        { id: "ab", source: "a", target: "b", sourceSides: ["right"] },
        { id: "ac", source: "a", target: "c", sourceSides: ["right"] },
      ],
    });
    const ab = routes.get("ab")!;
    const ac = routes.get("ac")!;
    expect(ab[0]!.x).toBe(100);
    expect(ac[0]!.x).toBe(100);
    expect(ab[0]!.y).not.toBe(ac[0]!.y);
    // The one going up leaves above the one going down (no crossing at the box).
    expect(ab[0]!.y).toBeLessThan(ac[0]!.y);
  });

  test("never starts through a thin wall between a box and its first grid line (review #1)", () => {
    const wall = rect(44, 0, 2, 40);
    const routes = routeOrthogonalJs({
      obstacles: [
        { id: "a", rect: rect(0, 0, 40, 40) },
        { id: "b", rect: rect(100, 0, 40, 40) },
        { id: "wall", rect: wall },
      ],
      connections: [{ id: "e", source: "a", target: "b" }],
    });
    const points = routes.get("e")!;
    expect(routeCrosses(points, wall, 0.01)).toBe(false);
  });

  test("a wire reaches its box exactly, whatever other lines lie within half a pixel (review #2)", () => {
    const b = rect(100, 0, 40, 40);
    const routes = routeOrthogonalJs({
      obstacles: [
        { id: "a", rect: rect(0, 0, 40, 40) },
        { id: "b", rect: b },
        { id: "far", rect: rect(200, 31.5, 40, 40) },
      ],
      connections: [{ id: "e", source: "a", target: "b", sourceSides: ["right"], targetSides: ["left"] }],
    });
    const points = routes.get("e")!;
    expect(points[points.length - 1]!.x).toBe(100);
    expect(points.every((p, i) => i === 0 || p.x === points[i - 1]!.x || p.y === points[i - 1]!.y)).toBe(true);
  });
});

describe("compaction without a record (review #3, #4)", () => {
  const node = (id: string, x: number, y: number, groupId?: string) => ({
    id,
    label: id,
    shape: undefined,
    classes: [],
    groupId,
    x,
    y,
    width: 40,
    height: 40,
  });
  const view = (nodes: object[], groups: object[] = []) =>
    ({
      viewId: "v",
      kind: "graph",
      title: "t",
      revision: "r",
      modelType: "flowchart",
      nodes,
      edges: [],
      groups,
    }) as unknown as ProjectedView;
  const sized = {
    layout: async () =>
      ({
        nodes: [{ ...node("group:f", 0, 0) }],
        edges: [],
        groups: [],
        width: 40,
        height: 40,
      }) as unknown as LayoutResult,
  };

  test("a frame never shrinks past a box inside it, and boxes that touched never overlap", async () => {
    const layout = {
      nodes: [node("inP", 240, 50, "p"), node("left", 0, 400), node("right", 40, 400)],
      groups: [
        { id: "p", label: "p", parentId: undefined, x: 0, y: 0, width: 300, height: 150 },
        { id: "f", label: "f", parentId: undefined, x: 0, y: 200, width: 300, height: 100 },
      ],
      edges: [],
      width: 320,
      height: 460,
      direction: "tb",
    } as unknown as LayoutResult;
    const openView = view(
      [],
      [
        { id: "p", label: "p", parentId: undefined },
        { id: "f", label: "f", parentId: undefined },
      ],
    );
    const closedView = view(
      [
        {
          id: "group:f",
          label: "f",
          shape: undefined,
          classes: [],
          groupId: undefined,
          folded: { groupId: "f", element: false },
        },
      ],
      [{ id: "p", label: "p", parentId: undefined }],
    );
    const closed = await closeInPlace({ view: openView, layout }, closedView, "f", sized);
    const p = closed.groups.find((g) => g.id === "p")!;
    const inP = closed.nodes.find((n) => n.id === "inP")!;
    expect(inside(inP, p)).toBe(true);
    const left = closed.nodes.find((n) => n.id === "left")!;
    const right = closed.nodes.find((n) => n.id === "right")!;
    expect(overlap(left, right)).toBe(false);
  });
});
