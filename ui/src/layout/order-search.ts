/**
 * Written order, unless another start draws the same diagram better on every measure (owner, 2026-11-15).
 *
 * ELK keeps a frame's boxes in the order the source writes them (`considerModelOrder`, ADR 0009). When that order is
 * the reverse of the boxes next door, one-to-one lines cross and bend: a Data Sources frame drew three lines that a
 * reader could see should run straight. The order the source writes its boxes and lines is also where ELK's crossing
 * minimisation starts, and on the same diagram the start alone moved a drawing between 64 and 82 corners.
 *
 * So a framed diagram whose written-order drawing has a crossing, or a pair line with a corner, is laid out again from
 * a fixed set of seeded starting orders, and a result replaces the written one only if it DOMINATES it: fewer
 * corners, and no more crossings, caption collisions, width or height (2% slack). Otherwise the written order is drawn
 * exactly as before. The seeds are fixed, so a diagram always gets the same drawing; the winning seed is remembered
 * per content, so laying the same diagram out again costs one pass.
 *
 * Measured in `tools/layout-eval` (`order-search-24-all`): over 11 diagrams nothing got worse; the six-box Data
 * Sources case went 4 → 0 corners and 3 → 0 crossings; a four-frame library-pricing 78 → 64 corners, 14 → 12
 * crossings, knot load 49 → 17.
 */
import type { ProjectedView } from "../diagrams/projection";
import { writtenOrder, type SourceOrder } from "../diagrams/source-order";
import { countCrossings } from "../nesting/route-geometry";
import type { LayoutResult } from "./elk-layout";

/** How many seeded starting orders a framed diagram with something to fix is tried with. */
const ORDER_SEARCH_TRIES = 24;
/** How much wider or taller a better drawing may be. */
const SIZE_SLACK = 1.02;

export type LayoutQuality = {
  readonly corners: number;
  readonly crossings: number;
  /** Lines that are their source's only outgoing line and their target's only incoming one, yet turn. */
  readonly bentPairs: number;
  readonly collisions: number;
  readonly width: number;
  readonly height: number;
};

const cornersOf = (points: readonly { x: number; y: number }[]): number => {
  let corners = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const [a, b, c] = [points[i - 1]!, points[i]!, points[i + 1]!];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 0.5) corners += 1;
  }
  return corners;
};

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

export function layoutQuality(layout: LayoutResult): LayoutQuality {
  const outs = new Map<string, number>();
  const ins = new Map<string, number>();
  for (const edge of layout.edges) {
    outs.set(edge.source, (outs.get(edge.source) ?? 0) + 1);
    ins.set(edge.target, (ins.get(edge.target) ?? 0) + 1);
  }
  let corners = 0;
  let bentPairs = 0;
  for (const edge of layout.edges) {
    const c = cornersOf(edge.points);
    corners += c;
    if (c > 0 && edge.source !== edge.target && outs.get(edge.source) === 1 && ins.get(edge.target) === 1)
      bentPairs += 1;
  }
  let crossings = 0;
  for (let i = 0; i < layout.edges.length; i += 1)
    for (let j = i + 1; j < layout.edges.length; j += 1)
      crossings += countCrossings(layout.edges[i]!.points, layout.edges[j]!.points);
  const labels = layout.edges.flatMap((edge) => (edge.labelAnchor ? [edge.labelAnchor] : []));
  let collisions = 0;
  for (let i = 0; i < labels.length; i += 1) {
    for (const node of layout.nodes) if (overlap(labels[i]!, node)) collisions += 1;
    for (let j = i + 1; j < labels.length; j += 1) if (overlap(labels[i]!, labels[j]!)) collisions += 1;
  }
  return { corners, crossings, bentPairs, collisions, width: layout.width, height: layout.height };
}

/** Whether a drawing has anything a different start could fix. */
const worthSearching = (q: LayoutQuality): boolean => q.crossings > 0 || q.bentPairs > 0;

/** Better on every measure: fewer corners, and nothing else worse. */
export const dominates = (a: LayoutQuality, b: LayoutQuality): boolean =>
  a.corners < b.corners &&
  a.crossings <= b.crossings &&
  a.collisions <= b.collisions &&
  a.width <= b.width * SIZE_SLACK &&
  a.height <= b.height * SIZE_SLACK;

/** The `seed`th starting order: boxes, frames and lines shuffled by a fixed generator. */
export function seededOrder(order: SourceOrder, seed: number): SourceOrder {
  let state = (7 + seed * 7919) % 2 ** 31;
  const next = () => (state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  const edges = shuffle(order.edges);
  return { elements: shuffle(order.elements), edges };
}

/** The winning seed per content (0: the written order), most recent last. */
const chosen = new Map<string, number>();
const CHOSEN_KEPT = 256;
const keyOf = (view: ProjectedView, salt: string) =>
  JSON.stringify([salt, view.direction, view.kind, view.nodes, view.edges, view.groups, writtenOrder(view)]);

/**
 * Lays `view` out with `lay` in written order, and, for a framed drawing worth it, from the seeded starts too; returns
 * the written drawing unless one of them dominates it. `salt` is whatever else the drawing depends on (typeface).
 */
export async function withOrderSearch(
  view: ProjectedView,
  salt: string,
  lay: (view: ProjectedView) => Promise<LayoutResult>,
): Promise<LayoutResult> {
  const written = await lay(view);
  if (view.groups.length === 0) return written;
  const writtenQuality = layoutQuality(written);
  if (!worthSearching(writtenQuality)) return written;
  const order = writtenOrder(view);
  const reorder = (seed: number): ProjectedView => ({ ...view, sourceOrder: seededOrder(order, seed) });
  const key = keyOf(view, salt);
  const known = chosen.get(key);
  if (known !== undefined) {
    if (known === 0) return written;
    const again = await lay(reorder(known));
    return dominates(layoutQuality(again), writtenQuality) ? again : written;
  }
  let best = written;
  let bestQuality = writtenQuality;
  let bestSeed = 0;
  for (let seed = 1; seed <= ORDER_SEARCH_TRIES; seed += 1) {
    const laid = await lay(reorder(seed));
    const quality = layoutQuality(laid);
    // Dominating the written drawing already means fewer corners than it, so the first such seed always wins.
    if (
      dominates(quality, writtenQuality) &&
      (quality.corners < bestQuality.corners ||
        (quality.corners === bestQuality.corners && quality.crossings < bestQuality.crossings))
    ) {
      best = laid;
      bestQuality = quality;
      bestSeed = seed;
    }
  }
  chosen.delete(key);
  chosen.set(key, bestSeed);
  while (chosen.size > CHOSEN_KEPT) chosen.delete(chosen.keys().next().value!);
  return best;
}
