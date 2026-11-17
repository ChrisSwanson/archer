// The nested view's layout strategies and route measures, shared by the stability measurement
// (`nest-stability.test.ts`) and the side-by-side renderer (`nest-compare.test.ts`).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ELK from "elkjs/lib/elk.bundled.js";
import { compile } from "../../../ts/src/mermaid/index";
import { computeLayout } from "../../src/layout/elk-adapter";
import type { LayoutEdge, LayoutEngine, LayoutResult } from "../../src/layout/elk-layout";
import type { ProjectedView } from "../../src/diagrams/projection";
import { nestView } from "../../src/nesting/nest-view";
import { routeCrosses } from "../../src/nesting/route-geometry";
import { closeInPlace, crossingsOfFrame, growInPlaceV2, growInPlaceV2Staged } from "../../src/nesting/grow-in-place-v2";
import { newProfile, type NestProfile } from "../../src/nesting/profile";
import { projectEnvelope } from "../../src/diagrams/projection";
import { envelopeFor } from "../fixtures";
import { boxes, seededEngine as productionSeeded, type Box, type SeedStrategy } from "../../src/nesting/seeded-layout";

export async function viewOf(path: string): Promise<ProjectedView> {
  const result = await compile(readFileSync(resolve(process.cwd(), "..", path), "utf8"));
  if (result.model == null) throw new Error(`${path}: ${result.diagnostics.map((d) => d.message).join("; ")}`);
  // Projected directly (not through draw-envelope's React helpers), so plain node can load this
  // module: `scripts/profile-nest.mjs` runs presses outside vitest.
  const projection = projectEnvelope(
    envelopeFor(result.model as unknown as { type: string } & Record<string, unknown>, "stability"),
  );
  if (!projection.ok || projection.type !== "graph") throw new Error(`${path}: not a graph view`);
  return projection.view;
}

export type { Box } from "../../src/nesting/seeded-layout";
export { boxes } from "../../src/nesting/seeded-layout";
export const centre = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

/**
 * `grow2` is grow in place v2 (`grow-in-place-v2.ts`, its own router), the page's layout; the
 * others relay the whole view out with ELK, seeded by the production fallback (`seeded-layout.ts`).
 */
/** `grow2b` is grow2 with bundled lines: one trunk per (open frame, closed box), fanning out inside (lab only, not adopted). */
export type Strategy = SeedStrategy | "grow2" | "grow2b";
export const STRATEGIES: readonly Strategy[] = ["plain", "semi", "semi-free", "interactive", "grow2", "grow2b"];

export function seededEngine(
  strategy: Strategy,
  prior: Map<string, Box> | undefined,
  view: ProjectedView,
): LayoutEngine {
  return productionSeeded(strategy === "grow2" || strategy === "grow2b" ? "plain" : strategy, prior, view, new ELK());
}

export type Laid = {
  view: ProjectedView;
  layout: LayoutResult;
  ms: number;
  parts?: { inner: number; route: number };
  profile?: NestProfile;
};

/** The layout of `open` by `strategy`, from the layout it is reached from (and the box opened). */
export async function layOut(
  full: ProjectedView,
  open: readonly string[],
  strategy: Strategy,
  from?: Laid,
  opened?: string,
): Promise<Laid> {
  const view = nestView(full, open).view;
  const start = performance.now();
  const parts = { inner: 0, route: 0 };
  const timed = async <T>(part: "inner" | "route", work: () => Promise<T>): Promise<T> => {
    const t = performance.now();
    try {
      return await work();
    } finally {
      parts[part] += performance.now() - t;
    }
  };
  const grow = (strategy === "grow2" || strategy === "grow2b") && from !== undefined && opened !== undefined;
  const profile = strategy === "grow2" || strategy === "grow2b" ? newProfile() : undefined;
  const layout = grow
    ? await growInPlaceV2(from, view, opened, {
        layout: (v) => computeLayout(v),
        profile,
        bundle: strategy === "grow2b",
      })
    : await computeLayout(
        view,
        undefined,
        seededEngine(strategy, from === undefined ? undefined : boxes(from.layout, from.view), view),
      );
  const ms = performance.now() - start;
  if (profile !== undefined)
    return { view, layout, ms, parts: { inner: profile.spans.inner ?? 0, route: profile.spans.route ?? 0 }, profile };
  return { view, layout, ms, ...(grow ? { parts } : {}) };
}

/** Milliseconds until grow2's staged result has its first picture (boxes placed, elbows for new wires), cold. */
export async function stagedFirstMs(
  full: ProjectedView,
  open: readonly string[],
  from: Laid,
  opened: string,
  bundle = false,
): Promise<number> {
  const view = nestView(full, open).view;
  const start = performance.now();
  await growInPlaceV2Staged(from, view, opened, { layout: (v) => computeLayout(v), bundle });
  return performance.now() - start;
}

/** Closing `closing` from an open layout by compaction (`closeInPlace`), timed like `layOut`. */
export async function closeOut(
  full: ProjectedView,
  open: readonly string[],
  from: Laid,
  closing: string,
  forget = false,
  bundle = false,
): Promise<Laid> {
  const view = nestView(full, open).view;
  const start = performance.now();
  const profile = newProfile();
  // `forget`: a copy of the open layout carries no growth record (as after a deep link).
  const layout = await closeInPlace(forget ? { ...from, layout: { ...from.layout } } : from, view, closing, {
    layout: (v) => computeLayout(v),
    profile,
    bundle,
  });
  return {
    view,
    layout,
    ms: performance.now() - start,
    parts: { inner: profile.spans.inner ?? 0, route: profile.spans.route ?? 0 },
    profile,
  };
}

export type Quality = {
  edges: number;
  crossings: number;
  bends: number;
  throughBoxes: number;
  missing: number;
  nonOrthogonal: number;
  length: number;
  /** Pairs of segments of different wires that lie on one line (within 2 px) over more than 4 px. */
  overlaps: number;
  /** Frame-edge passes that differ from the one a wire needs (one when exactly one end is inside, else none), plus runs within 3 px along a frame edge. */
  frameFaults: number;
  /** Label plates lying on a frame edge, on a box or note, or on another plate (each pair once). */
  plateFaults: number;
  /** Open frames missing, or not enclosing every box and frame inside them with 4 px to spare. */
  enclosureFaults: number;
};

/** A route without repeated points or points in the middle of a straight run. */
function normalised(points: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const p of points) {
    if (out.length > 0 && out[out.length - 1]!.x === p.x && out[out.length - 1]!.y === p.y) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2]!;
      const b = out[out.length - 1]!;
      if ((b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x) === 0) out.pop();
    }
    out.push(p);
  }
  return out;
}

/**
 * How the wires are drawn: proper crossings between wires (a crossing exactly at a bend is not
 * counted), bends after removing collinear points, wires through a box not their own, wires with
 * no route at all, and wires with a segment that is not horizontal or vertical (a fallback).
 */
export function quality(layout: LayoutResult, view?: ProjectedView): Quality {
  const routes = layout.edges.map((edge) => normalised(edge.points));
  // Bundled lines (grow2b): a trunk `trunk:<frame>~<box>` and its members, which end at the
  // trunk's exit on the frame's edge. A member and its trunk are one wire for the frame rules,
  // and members meeting at their shared exit is the bundle, not overlap.
  const trunks = layout.edges.filter((e) => e.id.startsWith("trunk:") && e.points.length >= 2);
  const exitOf = (t: LayoutEdge) => {
    const frame = t.id.slice("trunk:".length, t.id.lastIndexOf("~"));
    return t.source === frame ? t.points[0]! : t.points[t.points.length - 1]!;
  };
  const same = (p: { x: number; y: number }, q: { x: number; y: number }) =>
    Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5;
  /** The trunk a member joins, and the exit point, when it is one. */
  const trunkOf = (edge: LayoutEdge) => {
    if (edge.id.startsWith("trunk:") || edge.points.length < 2) return undefined;
    for (const t of trunks) {
      const box = t.id.slice(t.id.lastIndexOf("~") + 1);
      if (box !== edge.source && box !== edge.target) continue;
      const exit = exitOf(t);
      if (same(edge.points[0]!, exit) || same(edge.points[edge.points.length - 1]!, exit)) return { trunk: t, exit };
    }
    return undefined;
  };
  const memberOf = layout.edges.map(trunkOf);
  const segments = routes.map((points) => points.slice(1).map((p, i) => [points[i]!, p] as const));
  let crossings = 0;
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      for (const [a, b] of segments[i]!) {
        for (const [c, d] of segments[j]!) {
          const d1 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x);
          const d2 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x);
          const d3 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
          const d4 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
          if (d1 * d2 < 0 && d3 * d4 < 0) crossings++;
        }
      }
    }
  }
  let bends = 0;
  let throughBoxes = 0;
  let missing = 0;
  let nonOrthogonal = 0;
  let length = 0;
  layout.edges.forEach((edge, index) => {
    const points = routes[index]!;
    if (points.length < 2) {
      missing++;
      return;
    }
    bends += points.length - 2;
    if (points.some((p, i) => i > 0 && p.x !== points[i - 1]!.x && p.y !== points[i - 1]!.y)) nonOrthogonal++;
    for (let i = 1; i < points.length; i++)
      length += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    for (const node of layout.nodes)
      if (node.id !== edge.source && node.id !== edge.target && routeCrosses(points, node, 2)) throughBoxes++;
  });
  let overlaps = 0;
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const mi = memberOf[i];
      const mj = memberOf[j];
      // Members of one trunk merge on purpose in their last two segments before the exit (the
      // collector and the stub); only those are exempt.
      const mergeOf = (index: number, m: typeof mi) => {
        const segs = segments[index]!;
        if (m === undefined) return new Set<number>();
        const towardExit = same(segs.at(-1)?.[1] ?? { x: NaN, y: NaN }, m.exit);
        return new Set(towardExit ? [segs.length - 1, segs.length - 2] : [0, 1]);
      };
      const sameTrunk = mi !== undefined && mj !== undefined && mi.trunk === mj.trunk;
      const mergeI = sameTrunk ? mergeOf(i, mi) : new Set<number>();
      const mergeJ = sameTrunk ? mergeOf(j, mj) : new Set<number>();
      for (const [si, [a, b]] of segments[i]!.entries()) {
        for (const [sj, [c, d]] of segments[j]!.entries()) {
          if (mergeI.has(si) && mergeJ.has(sj)) continue;
          const ha = Math.abs(a.y - b.y) < 0.01;
          const hc = Math.abs(c.y - d.y) < 0.01;
          const va = Math.abs(a.x - b.x) < 0.01;
          const vc = Math.abs(c.x - d.x) < 0.01;
          if (ha && hc && Math.abs(a.y - c.y) <= 2) {
            if (Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) > 4)
              overlaps++;
          } else if (va && vc && Math.abs(a.x - c.x) <= 2) {
            if (Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) > 4)
              overlaps++;
          }
        }
      }
    }
  }
  // Frames: a wire may pass a frame's edge once when exactly one of its ends is inside, never otherwise.
  const groups = new Map(layout.groups.map((g) => [g.id, g]));
  const chain = (groupId: string | undefined) => {
    const out = new Set<string>();
    for (let g = groupId; g !== undefined && groups.has(g) && !out.has(g); g = groups.get(g)!.parentId) out.add(g);
    return out;
  };
  const nodeGroup = new Map(layout.nodes.map((n) => [n.id, n.groupId]));
  const framesOf = (id: string) => {
    if (nodeGroup.has(id)) return chain(nodeGroup.get(id));
    const gid = id.startsWith("group:") ? id.slice(6) : id;
    const own = groups.get(gid);
    return own === undefined ? new Set<string>() : chain(own.parentId);
  };
  let frameFaults = 0;
  layout.edges.forEach((edge, index) => {
    let points = routes[index]!;
    if (points.length < 2) return;
    // A member is checked as its fan and its trunk together, end to end.
    const member = memberOf[index];
    if (member !== undefined) {
      const toExit = same(points[points.length - 1]!, member.exit) ? points : [...points].reverse();
      const trunkPoints = normalised(member.trunk.points);
      const fromExit = same(trunkPoints[0]!, member.exit) ? trunkPoints : [...trunkPoints].reverse();
      points = normalised([...toExit, ...fromExit.slice(1)]);
    }
    if (member !== undefined) {
      // The fan alone stays inside the trunk's frame: no pass through its edge.
      const frameId = member.trunk.id.slice("trunk:".length, member.trunk.id.lastIndexOf("~"));
      const own = layout.groups.find((g) => g.id === frameId || `group:${g.id}` === frameId);
      const outside = (p: { x: number; y: number }) =>
        p.x < own!.x - 0.5 || p.x > own!.x + own!.width + 0.5 || p.y < own!.y - 0.5 || p.y > own!.y + own!.height + 0.5;
      if (own !== undefined && routes[index]!.some(outside)) frameFaults++;
    }
    if (edge.id.startsWith("trunk:")) {
      // A trunk stays outside its own frame (it only touches its edge at the exit).
      const frameId = edge.id.slice("trunk:".length, edge.id.lastIndexOf("~"));
      const own = layout.groups.find((g) => g.id === frameId || `group:${g.id}` === frameId);
      if (own !== undefined && routeCrosses(points, own, 0.5)) frameFaults++;
    }
    const inS = framesOf(edge.source);
    const inT = framesOf(edge.target);
    for (const g of layout.groups) {
      const drawn =
        edge.source === g.id ||
        edge.target === g.id ||
        edge.source === `group:${g.id}` ||
        edge.target === `group:${g.id}`;
      if (drawn) continue;
      const allowed = inS.has(g.id) !== inT.has(g.id) ? 1 : 0;
      // Too many passes (through, or out and back) and too few (a wire that stops short inside) both count.
      frameFaults += Math.abs(crossingsOfFrame(points, g) - allowed);
      for (let k = 1; k < points.length; k++) {
        const a = points[k - 1]!;
        const b = points[k]!;
        const run = (lo: number, hi: number, from: number, to: number) =>
          Math.min(hi, Math.max(from, to)) - Math.max(lo, Math.min(from, to));
        if (
          Math.abs(a.y - b.y) < 0.01 &&
          (Math.abs(a.y - g.y) < 3 || Math.abs(a.y - g.y - g.height) < 3) &&
          run(g.x, g.x + g.width, a.x, b.x) > 10
        )
          frameFaults++;
        if (
          Math.abs(a.x - b.x) < 0.01 &&
          (Math.abs(a.x - g.x) < 3 || Math.abs(a.x - g.x - g.width) < 3) &&
          run(g.y, g.y + g.height, a.y, b.y) > 10
        )
          frameFaults++;
      }
    }
  });
  const plates = layout.edges.flatMap((e) => (e.labelAnchor === undefined || !e.label ? [] : [e.labelAnchor]));
  const boxesAndNotes = layout.nodes.flatMap((n) => (n.note === undefined ? [n] : [n, n.note]));
  const edgesOfFrames = layout.groups.flatMap(frameEdges);
  let plateFaults = 0;
  plates.forEach((plate, i) => {
    if (edgesOfFrames.some((strip) => intersects(plate, strip))) plateFaults++;
    if (boxesAndNotes.some((box) => intersects(plate, box))) plateFaults++;
    for (let j = i + 1; j < plates.length; j++) if (intersects(plate, plates[j]!)) plateFaults++;
  });
  return {
    edges: layout.edges.length,
    crossings,
    bends,
    throughBoxes,
    missing,
    nonOrthogonal,
    length,
    overlaps,
    frameFaults,
    plateFaults,
    enclosureFaults: enclosureFaults(layout, view),
  };
}

const intersects = (a: Box, b: Box) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** A frame's four edges as 3 px strips: a label plate on one hides the frame's line there. */
export function frameEdges(r: Box): Box[] {
  return [
    { x: r.x, y: r.y - 1.5, width: r.width, height: 3 },
    { x: r.x, y: r.y + r.height - 1.5, width: r.width, height: 3 },
    { x: r.x - 1.5, y: r.y, width: 3, height: r.height },
    { x: r.x + r.width - 1.5, y: r.y, width: 3, height: r.height },
  ];
}

/** Every frame encloses every box and nested frame whose parent chain reaches it, 4 px clear. */
export function enclosureFaults(layout: LayoutResult, open?: ProjectedView): number {
  const groups = new Map(layout.groups.map((g) => [g.id, g]));
  let faults = open === undefined ? 0 : open.groups.filter((g) => !groups.has(g.id)).length;
  const within = (inner: Box, outer: Box, pad: number) =>
    inner.x >= outer.x + pad - 0.5 &&
    inner.y >= outer.y + pad - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width - pad + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height - pad + 0.5;
  const ancestors = (groupId: string | undefined) => {
    const out: string[] = [];
    for (let g = groupId; g !== undefined && groups.has(g) && !out.includes(g); g = groups.get(g)!.parentId)
      out.push(g);
    return out;
  };
  for (const node of layout.nodes)
    for (const g of ancestors(node.groupId))
      for (const r of node.note === undefined ? [node] : [node, node.note]) if (!within(r, groups.get(g)!, 4)) faults++;
  for (const frame of layout.groups)
    for (const g of ancestors(frame.parentId)) if (!within(frame, groups.get(g)!, 4)) faults++;
  return faults;
}
