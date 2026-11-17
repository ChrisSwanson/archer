/**
 * PROTOTYPE engine variants for the layout eval. Each wraps the product pipeline (Archer's ELK graph -> ELK -> corner
 * trimming) and changes one thing, so the eval can tell which change draws the same diagram better. Nothing here edits
 * product code: options are injected through the LayoutEngine seam `computeLayout` already takes.
 */
import type { ElkNode } from "elkjs/lib/elk-api";
import type { LayoutEngine, LayoutResult } from "../../ui/src/layout/elk-adapter";
import type { ProjectedView } from "../../ui/src/diagrams/projection";
import { DEFAULT_TYPEFACE } from "../../ui/src/layout/text-measure";
import { routeOrthogonalJs, type OrthoOptions, type Side } from "../../ui/src/nesting/ortho-router";
import { labelOnRoute, type Rect } from "../../ui/src/nesting/route-geometry";
import { simplifyRoutes, unsimplified } from "../../ui/src/layout/route-simplify";
import { writtenOrder } from "../../ui/src/diagrams/source-order";
import { measure } from "./report.mts";
import { curvedRoutes } from "../../ui/src/diagrams/curved-route";
import { mermaidCurves } from "../../ui/src/diagrams/mermaid-curve";

type Compute = (view: ProjectedView, typeface?: never, engine?: LayoutEngine) => Promise<LayoutResult>;
export type Variant = { readonly note: string; layout(view: ProjectedView, compute: Compute): Promise<LayoutResult> };

let elk: { layout(graph: ElkNode): Promise<ElkNode> } | undefined;
async function kernel() {
  if (!elk) {
    const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
    elk = new ELK();
  }
  return elk;
}

/** An engine that adds `options` to the root and every compound (frame) node before ELK runs. */
function withOptions(options: Record<string, string>): LayoutEngine {
  return {
    async layout(graph: ElkNode) {
      const visit = (node: ElkNode, isRoot: boolean) => {
        if (isRoot || (node.children?.length ?? 0) > 0) node.layoutOptions = { ...node.layoutOptions, ...options };
        for (const child of node.children ?? []) visit(child, false);
      };
      visit(graph, true);
      return (await kernel()).layout(graph);
    },
  };
}

const elkVariant = (note: string, options: Record<string, string>): Variant => ({
  note,
  layout: (view, compute) => compute(view, DEFAULT_TYPEFACE as never, withOptions(options)),
});

/** The frames (with ancestors) a node sits in. */
function framesOf(layout: LayoutResult, nodeId: string): string[] {
  const groups = new Map(layout.groups.map((g) => [g.id, g]));
  const out: string[] = [];
  for (let g = layout.nodes.find((n) => n.id === nodeId)?.groupId; g !== undefined; g = groups.get(g)?.parentId)
    out.push(g);
  return out;
}

const FLOW_SIDES: Record<string, { out: Side; in: Side }> = {
  lr: { out: "right", in: "left" },
  rl: { out: "left", in: "right" },
  tb: { out: "bottom", in: "top" },
  bt: { out: "top", in: "bottom" },
};

/**
 * Keep ELK's placement of boxes and frames; re-route the wires that cross a frame border with the nested view's
 * obstacle router (frames are walls a wire crosses only to reach its own end), the others staying where they are.
 * Captions are re-placed on the new routes; the corner-trimming pass then runs again over the whole drawing.
 */
function rerouted(scope: "cross-frame" | "all", options: Partial<OrthoOptions> = {}, flowSides = false): Variant {
  return {
    note: `ELK placement, ${scope} wires re-routed by the orthogonal router${flowSides ? " (flow sides only)" : ""}`,
    async layout(view, compute) {
      const base = unsimplified(await compute(view));
      const moving = new Set(
        base.edges
          .filter((e) => {
            if (scope === "all") return true;
            const a = framesOf(base, e.source).join("/");
            const b = framesOf(base, e.target).join("/");
            return a !== b;
          })
          .map((e) => e.id),
      );
      if (moving.size === 0) return simplifyRoutes(base);
      const sides = FLOW_SIDES[base.direction ?? "tb"]!;
      const obstacles = [
        ...base.nodes.map((n) => ({ id: n.id, rect: { x: n.x, y: n.y, width: n.width, height: n.height } })),
        // A frame's caption is a wall nothing may cross.
        ...base.groups.flatMap((g) => (g.caption ? [{ id: `caption:${g.id}`, rect: g.caption }] : [])),
      ];
      const routes = routeOrthogonalJs({
        obstacles,
        frames: base.groups.map((g) => ({ id: g.id, rect: { x: g.x, y: g.y, width: g.width, height: g.height } })),
        fixed: base.edges.filter((e) => !moving.has(e.id)).map((e) => e.points),
        connections: base.edges
          .filter((e) => moving.has(e.id))
          .map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            ...(flowSides ? { sourceSides: [sides.out], targetSides: [sides.in] } : {}),
          })),
        direction: base.direction,
        options,
      });
      // Captions: kept ones first, then the moved ones placed clear of boxes, captions and each other.
      const taken: Rect[] = [
        ...obstacles.map((o) => o.rect),
        ...base.edges.filter((e) => !moving.has(e.id) && e.labelAnchor).map((e) => e.labelAnchor!),
      ];
      const edges = base.edges.map((e) => {
        const points = routes.get(e.id);
        if (!moving.has(e.id) || points === undefined || points.length < 2) return e;
        const labelAnchor = e.labelAnchor
          ? labelOnRoute(points, { width: e.labelAnchor.width, height: e.labelAnchor.height }, taken)
          : undefined;
        return { ...e, points, labelAnchor };
      });
      return simplifyRoutes({ ...base, edges });
    },
  };
}

/** An engine that also changes every edge label's options (where ELK puts a caption's layer). */
function withLabelOptions(root: Record<string, string>, label: Record<string, string>): LayoutEngine {
  return {
    async layout(graph: ElkNode) {
      const visit = (node: ElkNode, isRoot: boolean) => {
        if (isRoot || (node.children?.length ?? 0) > 0) node.layoutOptions = { ...node.layoutOptions, ...root };
        for (const edge of node.edges ?? [])
          for (const l of edge.labels ?? []) l.layoutOptions = { ...l.layoutOptions, ...label };
        for (const child of node.children ?? []) visit(child, false);
      };
      visit(graph, true);
      return (await kernel()).layout(graph);
    },
  };
}
const labelVariant = (note: string, root: Record<string, string>, label: Record<string, string> = {}): Variant => ({
  note,
  layout: (view, compute) => compute(view, DEFAULT_TYPEFACE as never, withLabelOptions(root, label)),
});

/**
 * Lay the drawing out several ways, measure each on the target screen, keep the best that adds no crossing and no
 * caption collision over the shipped one. Candidate selection: never worse than baseline by construction.
 */
function bestOf(names: readonly string[]): Variant {
  return {
    note: `best of ${names.join(", ")} (no added crossings, caption collisions, knots or tight runs)`,
    async layout(view, compute) {
      const { measure } = await import("./report.mts");
      const screen = { width: 1200, height: 740 };
      const base = await VARIANTS["baseline"]!.layout(view, compute);
      const b = measure("", base, screen);
      let best = { layout: base, score: b.score };
      for (const n of names) {
        const candidate = await VARIANTS[n]!.layout(view, compute).catch(() => undefined);
        if (!candidate || candidate.groups.length !== base.groups.length) continue;
        const r = measure("", candidate, screen);
        if (!r.valid || r.crossings > b.crossings || r.labelOverlaps.length > b.labelOverlaps.length) continue;
        if (r.throughNode.length > b.throughNode.length) continue;
        if (r.congestion.junctionLoad > b.congestion.junctionLoad || r.congestion.tightRuns > b.congestion.tightRuns)
          continue;
        if (r.score > best.score) best = { layout: candidate, score: r.score };
      }
      return best.layout;
    },
  };
}

/**
 * Untie knots: re-route only the wires the congestion metric names in a junction, every other wire fixed. Each may
 * leave by the flow side or the side facing its target, and arrive by the flow side or the side facing its source
 * (a wire from below a column may come in at the bottom rather than queue for the left face).
 */
function untieKnots(options: Partial<OrthoOptions> = {}): Variant {
  return {
    note: "re-route only junction wires; ends on the flow side or the side facing the other end",
    async layout(view, compute) {
      const { congestionOf } = await import("./report.mts");
      const shipped = await compute(view);
      const jam = congestionOf(shipped);
      const moving = new Set(jam.junctions.flatMap((j) => j.wires));
      if (moving.size === 0) return shipped;
      const base = unsimplified(shipped);
      const flow = FLOW_SIDES[base.direction ?? "tb"]!;
      const box = new Map(base.nodes.map((n) => [n.id, n]));
      const facing = (from: { x: number; y: number; width: number; height: number }, to: typeof from): Side[] => {
        const horizontal = flow.out === "right" || flow.out === "left";
        const fc = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
        if (horizontal) {
          if (fc.y < to.y) return ["top"];
          if (fc.y > to.y + to.height) return ["bottom"];
        } else {
          if (fc.x < to.x) return ["left"];
          if (fc.x > to.x + to.width) return ["right"];
        }
        return [];
      };
      const obstacles = [
        ...base.nodes.map((n) => ({ id: n.id, rect: { x: n.x, y: n.y, width: n.width, height: n.height } })),
        ...base.groups.flatMap((g) => (g.caption ? [{ id: `caption:${g.id}`, rect: g.caption }] : [])),
      ];
      const routes = routeOrthogonalJs({
        obstacles,
        frames: base.groups.map((g) => ({ id: g.id, rect: { x: g.x, y: g.y, width: g.width, height: g.height } })),
        fixed: base.edges.filter((e) => !moving.has(e.id)).map((e) => e.points),
        connections: base.edges
          .filter((e) => moving.has(e.id))
          .map((e) => {
            const s = box.get(e.source)!;
            const t = box.get(e.target)!;
            return {
              id: e.id,
              source: e.source,
              target: e.target,
              sourceSides: [flow.out, ...facing(t, s)],
              targetSides: [flow.in, ...facing(s, t)],
            };
          }),
        direction: base.direction,
        options,
      });
      const taken: Rect[] = [
        ...obstacles.map((o) => o.rect),
        ...base.edges.filter((e) => !moving.has(e.id) && e.labelAnchor).map((e) => e.labelAnchor!),
      ];
      const edges = base.edges.map((e) => {
        const points = routes.get(e.id);
        if (!moving.has(e.id) || points === undefined || points.length < 2) return e;
        const labelAnchor = e.labelAnchor
          ? labelOnRoute(points, { width: e.labelAnchor.width, height: e.labelAnchor.height }, taken)
          : undefined;
        return { ...e, points, labelAnchor };
      });
      return simplifyRoutes({ ...base, edges });
    },
  };
}

// ---------------------------------------------------------------- curves (prototype: the eval samples them)

type P = { x: number; y: number };
function cubic(a: P, b: P, c: P, d: P, steps = 12): P[] {
  const out: P[] = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps,
      u = 1 - t;
    out.push({
      x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
      y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
    });
  }
  return out;
}
/** ELK spline sections list start, then (control, control, end) per cubic; anything else is left as drawn. */
function sampleCubicChain(points: readonly P[]): P[] {
  if (points.length < 4 || (points.length - 1) % 3 !== 0) return [...points];
  const out: P[] = [points[0]!];
  for (let i = 0; i + 3 < points.length; i += 3)
    out.push(...cubic(points[i]!, points[i + 1]!, points[i + 2]!, points[i + 3]!));
  return out;
}
/** d3's curveBasis (Mermaid's default edge curve) through a route's corners, sampled. */
function basisCurve(points: readonly P[]): P[] {
  if (points.length < 3) return [...points];
  const out: P[] = [points[0]!];
  let [x0, y0, x1, y1] = [NaN, NaN, NaN, NaN];
  let state = 0;
  let cursor: P = points[0]!;
  const bezier = (x: number, y: number) => {
    const b = { x: (2 * x0 + x1) / 3, y: (2 * y0 + y1) / 3 };
    const c = { x: (x0 + 2 * x1) / 3, y: (y0 + 2 * y1) / 3 };
    const d = { x: (x0 + 4 * x1 + x) / 6, y: (y0 + 4 * y1 + y) / 6 };
    out.push(...cubic(cursor, b, c, d));
    cursor = d;
  };
  for (const { x, y } of points) {
    if (state === 0) state = 1;
    else if (state === 1) state = 2;
    else {
      if (state === 2) {
        state = 3;
        cursor = { x: (5 * x0 + x1) / 6, y: (5 * y0 + y1) / 6 };
        out.push(cursor);
      }
      bezier(x, y);
    }
    [x0, y0, x1, y1] = [x1, y1, x, y];
  }
  if (state === 3) bezier(x1, y1);
  out.push({ x: x1, y: y1 });
  return out;
}
const curvedEdges = (layout: LayoutResult, curve: (pts: readonly P[]) => P[]): LayoutResult => ({
  ...layout,
  edges: layout.edges.map((e) => ({ ...e, points: curve(e.points) })),
});

/** Per diagram and curve variant: lines drawn with a fallback, captions slid along their curve, and with no clear place (read by `eval.mts`). */
export const CURVE_STATS = new Map<string, { fallbacks: number; corners: number; slid: number; unplaced: number }>();

/** The canvas's Curved lines exactly: the shipped layout, each line drawn by `mermaidCurves`, captions on the curves. */
const mermaidVariant: Variant = {
  note: "the shipped layout, each line drawn as one Mermaid-style basis curve box to box, captions on the curve (the canvas's Curved lines), sampled",
  async layout(view, compute) {
    const layout = await compute(view);
    const drawing = mermaidCurves(layout);
    const kinds = [...drawing.lines.values()].map((l) => l.kind);
    CURVE_STATS.set(`${view.viewId ?? ""}|curves-mermaid`, {
      fallbacks: kinds.filter((k) => k === "square").length,
      corners: kinds.filter((k) => k === "corners").length,
      slid: drawing.slid,
      unplaced: drawing.unplaced.length,
    });
    return {
      ...layout,
      edges: layout.edges.map((e) => {
        const label = drawing.labels.get(e.id);
        return {
          ...e,
          points: drawing.lines.get(e.id)?.samples ?? e.points,
          ...(label === undefined ? {} : { labelAnchor: label }),
        };
      }),
    };
  },
};

// ---------------------------------------------------------------- frames face their partners

/**
 * Written order, unless a line becomes straight (owner, 2026-11-15). Lay out as written; then, frame by frame, sort
 * the frame's own boxes by where the boxes they connect to OUTSIDE the frame sit on the cross axis (a box with no
 * such partner keeps its place), lay out again, and keep the new order only if the drawing is valid, has fewer
 * corners, and has no more crossings, caption collisions or knots. Boxes never leave their frame; a frame whose
 * order straightens nothing stays as written.
 */
function facePartners(opts: { rounds?: number; strict?: boolean } = {}): Variant {
  return {
    note: "written order, but each frame's boxes face the boxes they connect to outside it, kept only where corners drop",
    async layout(view, compute) {
      const scoreOf = (l: LayoutResult) => {
        const r = measure("x", l, { width: 1200, height: 740 });
        return { r, bends: r.bends, crossings: r.crossings, valid: r.valid, knots: r.congestion.junctionLoad };
      };
      const better = (a: ReturnType<typeof scoreOf>, b: ReturnType<typeof scoreOf>) =>
        a.valid && a.crossings <= b.crossings && a.knots <= b.knots + (opts.strict ? 0 : 2) && a.bends < b.bends;
      let current = view;
      let best = await compute(view);
      let bestScore = scoreOf(best);
      const groupOf = new Map(view.nodes.map((n) => [n.id, n.groupId]));
      const frames = view.groups.map((g) => g.id);
      for (let round = 0; round < (opts.rounds ?? 2); round += 1) {
        let improved = false;
        for (const frame of frames) {
          const members = view.nodes.filter((n) => n.groupId === frame).map((n) => n.id);
          if (members.length < 2) continue;
          const axis = (best.direction ?? "tb") === "lr" || best.direction === "rl" ? "y" : "x";
          const at = new Map(best.nodes.map((n) => [n.id, axis === "y" ? n.y + n.height / 2 : n.x + n.width / 2]));
          const key = new Map<string, number>();
          for (const id of members) {
            const partners = view.edges
              .flatMap((e) => (e.source === id ? [e.target] : e.target === id ? [e.source] : []))
              .filter((p) => groupOf.get(p) !== frame && at.has(p));
            key.set(
              id,
              partners.length ? partners.reduce((s, p) => s + at.get(p)!, 0) / partners.length : (at.get(id) ?? 0),
            );
          }
          const order = writtenOrder(current);
          const slots = order.elements.flatMap((e, i) => (e.kind === "node" && members.includes(e.id) ? [i] : []));
          const now = slots.map((i) => order.elements[i]!.id);
          const sorted = [...now].sort((a, b) => key.get(a)! - key.get(b)!);
          if (sorted.join() === now.join()) continue;
          const elements = [...order.elements];
          slots.forEach((slot, k) => (elements[slot] = { id: sorted[k]!, kind: "node" }));
          const candidate = { ...current, sourceOrder: { elements, edges: [...order.edges] } } as ProjectedView;
          const laid = await compute(candidate);
          const score = scoreOf(laid);
          if (process.env.FACE_DEBUG)
            console.error(
              `  ${frame}: ${now.join(",")} -> ${sorted.join(",")}  bends ${bestScore.bends}->${score.bends} cross ${bestScore.crossings}->${score.crossings} knots ${bestScore.knots}->${score.knots} valid ${score.valid}`,
            );
          if (better(score, bestScore)) {
            [current, best, bestScore, improved] = [candidate, laid, score, true];
          }
        }
        if (!improved) break;
      }
      return best;
    },
  };
}

/** Upper bound for reordering inside frames: every order of each frame (up to 6 boxes), greedily frame by frame. */
const permutations = <T,>(xs: readonly T[]): T[][] =>
  xs.length <= 1
    ? [[...xs]]
    : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
const searchFrames: Variant = {
  note: "every order of each frame's boxes (<= 6), greedily per frame, kept where corners drop without more crossings",
  async layout(view, compute) {
    const scoreOf = (l: LayoutResult) => {
      const r = measure("x", l, { width: 1200, height: 740 });
      return { bends: r.bends, crossings: r.crossings, valid: r.valid, knots: r.congestion.junctionLoad };
    };
    let current = view;
    let best = await compute(view);
    let bestScore = scoreOf(best);
    for (const g of view.groups) {
      const members = view.nodes.filter((n) => n.groupId === g.id).map((n) => n.id);
      if (members.length < 2 || members.length > 6) continue;
      const order = writtenOrder(current);
      const slots = order.elements.flatMap((e, i) => (e.kind === "node" && members.includes(e.id) ? [i] : []));
      const now = slots.map((i) => order.elements[i]!.id);
      for (const perm of permutations(now).slice(1)) {
        const elements = [...order.elements];
        slots.forEach((slot, k) => (elements[slot] = { id: perm[k]!, kind: "node" }));
        const candidate = { ...current, sourceOrder: { elements, edges: [...order.edges] } } as ProjectedView;
        const laid = await compute(candidate);
        const score = scoreOf(laid);
        if (
          score.valid &&
          score.crossings <= bestScore.crossings &&
          score.knots <= bestScore.knots + 2 &&
          score.bends < bestScore.bends
        ) {
          if (process.env.FACE_DEBUG)
            console.error(
              `  ${g.id}: ${perm.join(",")} bends ${bestScore.bends}->${score.bends} cross ${bestScore.crossings}->${score.crossings}`,
            );
          [current, best, bestScore] = [candidate, laid, score];
        }
      }
    }
    return best;
  },
};

/**
 * Written order as ELK's starting point, plus a fixed, seeded set of other starting orders; a different start lets
 * ELK's crossing minimisation find a different local optimum. A result replaces the written one only if it DOMINATES
 * it: fewer corners, and no more crossings, knot load, height or width (with 2% slack), and valid. Deterministic: the
 * same diagram always gets the same drawing.
 */
function orderSearch(tries: number, scope: "edges" | "all"): Variant {
  return {
    note: `written order, or the best of ${tries} seeded starting orders (${scope}) that beats it on every measure`,
    async layout(view, compute) {
      const scoreOf = (l: LayoutResult) => {
        const r = measure("x", l, { width: 1200, height: 740 });
        return {
          bends: r.bends,
          crossings: r.crossings,
          valid: r.valid,
          knots: r.congestion.junctionLoad,
          w: r.size.width,
          h: r.size.height,
        };
      };
      const written = await compute(view);
      const w0 = scoreOf(written);
      const dominates = (a: ReturnType<typeof scoreOf>) =>
        a.valid &&
        a.bends < w0.bends &&
        a.crossings <= w0.crossings &&
        a.knots <= w0.knots &&
        a.w <= w0.w * 1.02 &&
        a.h <= w0.h * 1.02;
      const order = writtenOrder(view);
      let seed = 7;
      const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      const shuffle = <T,>(xs: readonly T[]) => {
        const out = [...xs];
        for (let i = out.length - 1; i > 0; i -= 1) {
          const j = Math.floor(rnd() * (i + 1));
          [out[i], out[j]] = [out[j]!, out[i]!];
        }
        return out;
      };
      let best = written,
        bestScore = w0;
      for (let t = 0; t < tries; t += 1) {
        const edges = shuffle(order.edges);
        const elements = scope === "all" ? shuffle(order.elements) : [...order.elements];
        const laid = await compute({ ...view, sourceOrder: { elements, edges } } as ProjectedView);
        const score = scoreOf(laid);
        if (
          dominates(score) &&
          (score.bends < bestScore.bends || (score.bends === bestScore.bends && score.knots < bestScore.knots))
        ) {
          best = laid;
          bestScore = score;
        }
      }
      return best;
    },
  };
}

export const VARIANTS: Record<string, Variant> = {
  "order-search-8": orderSearch(8, "edges"),
  "order-search-24": orderSearch(24, "edges"),
  "order-search-24-all": orderSearch(24, "all"),
  "search-frames": searchFrames,
  "face-partners": facePartners(),
  "face-partners-strict": facePartners({ strict: true }),
  "order-free": elkVariant("written order off everywhere (considerModelOrder NONE), for reference", {
    "elk.layered.considerModelOrder.strategy": "NONE",
  }),
  "curves-basis": {
    note: "the shipped routes drawn as Mermaid-style basis curves (same topology, corners smoothed away)",
    layout: async (view, compute) => curvedEdges(await compute(view), (pts) => basisCurve(pts)),
  },
  "curves-clear": {
    note: "the shipped routes with large, clearance-checked corners and S-curved jogs (v2 of Curved lines, now its fallback), sampled",
    layout: async (view, compute) => {
      const layout = await compute(view);
      const curves = curvedRoutes(layout);
      return { ...layout, edges: layout.edges.map((e) => ({ ...e, points: curves.get(e.id)?.samples ?? e.points })) };
    },
  },
  "curves-mermaid": mermaidVariant,
  "curves-elk-splines": {
    note: "ELK's own spline routing (conservative), sampled",
    layout: async (view, compute) =>
      curvedEdges(
        unsimplified(
          await compute(
            view,
            DEFAULT_TYPEFACE as never,
            withOptions({ "elk.edgeRouting": "SPLINES", "elk.layered.edgeRouting.splines.mode": "CONSERVATIVE" }),
          ),
        ),
        sampleCubicChain,
      ),
  },
  "curves-elk-sloppy": {
    note: "ELK's own spline routing (sloppy: looser, rounder), sampled",
    layout: async (view, compute) =>
      curvedEdges(
        unsimplified(
          await compute(
            view,
            DEFAULT_TYPEFACE as never,
            withOptions({ "elk.edgeRouting": "SPLINES", "elk.layered.edgeRouting.splines.mode": "SLOPPY" }),
          ),
        ),
        sampleCubicChain,
      ),
  },
  "untie-knots": untieKnots(),
  "untie-knots-cross-averse": untieKnots({ crossingPenalty: 600, bendPenalty: 30 }),
  "labels-space-efficient": labelVariant("caption layer chosen to save space", {
    "elk.layered.edgeLabels.centerLabelPlacementStrategy": "SPACE_EFFICIENT_LAYER",
  }),
  "labels-tail-layer": labelVariant("captions in the layer next to their source", {
    "elk.layered.edgeLabels.centerLabelPlacementStrategy": "TAIL_LAYER",
  }),
  "labels-head-placement": labelVariant(
    "captions placed at the head end, not centre",
    {},
    { "elk.edgeLabels.placement": "HEAD" },
  ),
  "best-of": bestOf([
    "reroute-cross-frame",
    "reroute-cross-frame-flow",
    "reroute-all-flow",
    "compact-edge-length",
    "space-tight",
  ]),
  "reroute-cross-frame": rerouted("cross-frame"),
  "reroute-cross-frame-flow": rerouted("cross-frame", {}, true),
  "reroute-all-flow": rerouted("all", {}, true),
  baseline: { note: "the product pipeline as shipped", layout: (view, compute) => compute(view) },
  "place-network-simplex": elkVariant("node placement by network simplex (straighter long edges)", {
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  }),
  "place-bk-balanced": elkVariant("Brandes-Koepf placement, balanced alignment, favour straight edges", {
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
    "elk.layered.nodePlacement.favorStraightEdges": "true",
  }),
  "place-linear-segments": elkVariant("linear-segments placement (long edges kept straight)", {
    "elk.layered.nodePlacement.strategy": "LINEAR_SEGMENTS",
  }),
  "cross-thorough": elkVariant("more crossing-minimisation sweeps, two-sided greedy switch", {
    "elk.layered.thoroughness": "50",
    "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
  }),
  "space-tight": elkVariant("tighter spacing for smaller screens", {
    "elk.spacing.nodeNode": "36",
    "elk.spacing.edgeEdge": "12",
    "elk.spacing.edgeNode": "20",
    "elk.spacing.componentComponent": "40",
  }),
  "compact-edge-length": elkVariant("post-compaction by edge length", {
    "elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
  }),
};
