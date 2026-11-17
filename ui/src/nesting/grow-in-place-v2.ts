/**
 * Grow in place, second version (zoom layout lab; docs/proposals/zoom-layout-lab.md). Opens and
 * closes one box of the nested view without laying the rest out again, with no copyleft code.
 *
 * Prior art, for the rules only: yFiles' fold/expand guidelines (the rest keeps its place; closing
 * gives back the space), and Misue, Eades, Lai and Sugiyama, "Layout adjustment and the mental map"
 * (1995): keep orthogonal order, proximity and topology.
 *
 * OPEN
 * (a) ELK lays out only the opened box's inside (as the spike did); the frame's size follows.
 * (b) Where the frame grows: per axis it may take free space on either side of the old box, and
 *     what it cannot take is made by moving that side's boxes away. Each axis is ONE strictly
 *     increasing piecewise-linear map, x' = M(x): a translation by −dLo before the old box, by
 *     +dHi after it, linear across it. Applied to every box's centre (boxes keep their size),
 *     every frame edge and every wire bend:
 *       - a strictly increasing map keeps every pair of BOXES in their left/right and above/below
 *         order, and every gap only grows, so nothing comes to overlap and every box stays in its
 *         frame. Frames are not in that guarantee (as in the spike): their edges keep their order,
 *         but a frame that straddles the old box grows, so its centre can pass a box's;
 *       - an orthogonal wire stays orthogonal (a horizontal segment's points share y, so they
 *         share M(y)), and two segments cross after iff they crossed before: the existing wires
 *         keep their shape and their crossings, so they need no routing.
 *     The split (how much of the growth goes to each side, how much is taken from free space) is
 *     chosen by cost: the total distance boxes move, plus growth against the diagram's flow, plus
 *     the wires the frame would land on. So a box grows along the flow and toward the emptier
 *     side, and the side with fewer boxes is the one pushed.
 * (c) Only the wires that must change are routed (`ortho-router.ts`): those to and from the
 *     opened box's inside, and any existing wire the frame now lands on.
 *
 * CLOSE (compaction)
 * The inverse: the frame becomes the closed box, and each axis is compressed by the same kind of
 * map (negative dLo, dHi) as far as it can go without two boxes coming closer than they may, and
 * never by more than the frame frees. Order is kept for the same reason. So a close removes the
 * freed space and moves nothing else, and needs no cached "before" (a deep link can close).
 */
import { simplifyRoutes, unsimplified } from "../layout/route-simplify";
import type { GraphDirection, ProjectedView } from "../diagrams/projection";
import type { LayoutEdge, LayoutGroup, LayoutNode, LayoutPoint, LayoutResult } from "../layout/elk-layout";
import { arrowsOf } from "../diagrams/figures";
import { writtenOrder } from "../diagrams/source-order";
import {
  type CaptionEnd,
  captionEnds,
  captionSize,
  edgeObstacles,
  findCaptionPlace,
  FRAME_CAPTION_BAND_PX,
  FRAME_CAPTION_INSET,
  frameMinimumWidth,
  placeCaption,
} from "../layout/captions";
import { edgeLabelBox } from "../layout/graph-metrics";
import { routeOrthogonalJs, simplify, type OrthoRequest, type Side } from "./ortho-router";
import { count, span, spanAsync, type NestProfile } from "./profile";
import { frameToggleRect } from "./toggle-place";
import {
  boxAt,
  clearPlaceOnRoute,
  countCrossings,
  intersects,
  labelOnRoute,
  lengthOf,
  routeCrosses,
  type Rect,
} from "./route-geometry";

export type Laid = { readonly view: ProjectedView; readonly layout: LayoutResult };

export type GrowV2Dependencies = {
  /** Lays a view out: the production `computeLayout`. */
  layout(view: ProjectedView): Promise<LayoutResult>;
  /** Routes wires; `routeOrthogonalJs` unless a caller times or replaces it. */
  route?(request: OrthoRequest): Map<string, LayoutPoint[]>;
  /** Where to record per-phase spans and work counters (`profile.ts`); optional. */
  profile?: NestProfile;
  /**
   * What else `layout` depends on (typeface, mode, layout generation): part of the inside cache's
   * key, so a stable `layout` callback whose settings change does not reuse stale sizes.
   */
  layoutKey?: string;
  /**
   * Bundled lines (the `grow2b` strategy): wires from inside an open frame to a closed box outside
   * it are drawn as one trunk per (frame, box), "N connections", routed once outside the frame,
   * and fan out inside it from a shared exit on its edge. Wires between open frames stay single.
   */
  bundle?: boolean;
};

/** The router, with the profile passed along and its whole call timed as span `route`. */
function profiledRoute(deps: GrowV2Dependencies): (request: OrthoRequest) => Map<string, LayoutPoint[]> {
  const route = deps.route ?? routeOrthogonalJs;
  const profile = deps.profile;
  if (profile === undefined) return route;
  return (request) => span(profile, "route", () => route({ ...request, profile }));
}

/** The frame's padding, as ELK pads a group (`elk-layout.ts` GROUP_LAYOUT_OPTIONS). */
const PAD = 20;
/** The clearance a grown frame keeps from a box beside it, room for a few wires (ELK's in-layer spacing is 56, between layers 40). */
const GAP = 48;
/** The closest compaction without a record brings two boxes (or a box and a frame). */
const CLOSE_GAP = 48;

/**
 * How far one open pushed each side, per axis, and where the closed box sat in the space its
 * frame took (`offset` from the low end). A close with the record gives back exactly that much;
 * without one (a deep link) it compacts as far as the gaps allow.
 */
export type GrowthRecord = { readonly x: AxisRecord; readonly y: AxisRecord };
type AxisRecord = { readonly lo: number; readonly hi: number; readonly offset: number };
type Recorded = GrowthRecord & { readonly sequence: number };
const records = new WeakMap<LayoutResult, ReadonlyMap<string, Recorded>>();
let sequence = 0;

/** The growth records a layout carries: one per box opened in place on the way to it. */
export function growthRecords(layout: LayoutResult): ReadonlyMap<string, Recorded> {
  return records.get(layout) ?? new Map();
}

/** One axis of the adjustment: translation by −dLo before a0, by +dHi after a1, linear between. */
type AxisMap = { readonly a0: number; readonly a1: number; readonly dLo: number; readonly dHi: number };
const IDENTITY: AxisMap = { a0: 0, a1: 1, dLo: 0, dHi: 0 };

function mapAxis(m: AxisMap, v: number): number {
  if (v <= m.a0) return v - m.dLo;
  if (v >= m.a1) return v + m.dHi;
  const lo = m.a0 - m.dLo;
  const hi = m.a1 + m.dHi;
  return lo + ((v - m.a0) / (m.a1 - m.a0)) * (hi - lo);
}

type Maps = { readonly x: AxisMap; readonly y: AxisMap };

/** A box keeps its size; its centre moves. */
function moveBox<T extends Rect>(rect: T, maps: Maps): T {
  const cx = mapAxis(maps.x, rect.x + rect.width / 2);
  const cy = mapAxis(maps.y, rect.y + rect.height / 2);
  return { ...rect, x: cx - rect.width / 2, y: cy - rect.height / 2 };
}

/** A frame's edges move. */
function moveFrame<T extends Rect>(rect: T, maps: Maps): T {
  const x0 = mapAxis(maps.x, rect.x);
  const y0 = mapAxis(maps.y, rect.y);
  return {
    ...rect,
    x: x0,
    y: y0,
    width: mapAxis(maps.x, rect.x + rect.width) - x0,
    height: mapAxis(maps.y, rect.y + rect.height) - y0,
  };
}

function drawnGroupId(view: ProjectedView, groupId: string): string {
  return view.groups.find((group) => group.id === groupId)?.element === true ? groupId : `group:${groupId}`;
}

const centreOf = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

function drawnRects(node: LayoutNode): Rect[] {
  return node.note === undefined ? [node] : [node, node.note];
}

function moveNode(node: LayoutNode, maps: Maps): LayoutNode {
  const moved = moveBox(node, maps);
  if (node.note === undefined) return moved;
  const dx = moved.x - node.x;
  const dy = moved.y - node.y;
  return { ...moved, note: { ...node.note, x: node.note.x + dx, y: node.note.y + dy } };
}

function moveGroup(group: LayoutGroup, maps: Maps): LayoutGroup {
  const moved = moveFrame(group, maps);
  if (group.caption === undefined) return moved;
  return {
    ...moved,
    caption: { ...group.caption, x: group.caption.x + (moved.x - group.x), y: group.caption.y + (moved.y - group.y) },
  };
}

/** Which side of `rect` a wire end lies on. */
function sideOf(point: LayoutPoint, rect: Rect): Side {
  const d = [
    ["left", Math.abs(point.x - rect.x)],
    ["right", Math.abs(point.x - rect.x - rect.width)],
    ["top", Math.abs(point.y - rect.y)],
    ["bottom", Math.abs(point.y - rect.y - rect.height)],
  ] as const;
  return [...d].sort((a, b) => a[1] - b[1])[0]![0];
}

/**
 * An existing wire, moved by the maps, with its two ends put back on their boxes (a box keeps its
 * size, so an end on its side can drift off it). Undefined when that cannot be done orthogonally.
 */
function stretchWire(
  points: readonly LayoutPoint[],
  maps: Maps,
  was: { source: Rect; target: Rect },
  now: { source: Rect; target: Rect },
): LayoutPoint[] | undefined {
  if (points.length < 2) return undefined;
  const out = points.map((p) => ({ x: mapAxis(maps.x, p.x), y: mapAxis(maps.y, p.y) }));
  const orthogonal = points.every(
    (p, i) => i === 0 || Math.abs(p.x - points[i - 1]!.x) < 0.01 || Math.abs(p.y - points[i - 1]!.y) < 0.01,
  );
  if (!orthogonal) return undefined;
  const fit = (index: number, neighbour: number, before: Rect, after: Rect): boolean => {
    const side = sideOf(points[index]!, before);
    const p = out[index]!;
    const q = out[neighbour]!;
    const vertical = Math.abs(points[index]!.x - points[neighbour]!.x) < 0.01;
    if (side === "top" || side === "bottom") {
      p.y = side === "top" ? after.y : after.y + after.height;
      const x = Math.min(Math.max(p.x, after.x + 2), after.x + after.width - 2);
      if (vertical) q.x = x;
      p.x = x;
    } else {
      p.x = side === "left" ? after.x : after.x + after.width;
      const y = Math.min(Math.max(p.y, after.y + 2), after.y + after.height - 2);
      if (!vertical) q.y = y;
      p.y = y;
    }
    return true;
  };
  fit(0, 1, was.source, now.source);
  fit(out.length - 1, out.length - 2, was.target, now.target);
  const stillOrthogonal = out.every(
    (p, i) => i === 0 || Math.abs(p.x - out[i - 1]!.x) < 0.01 || Math.abs(p.y - out[i - 1]!.y) < 0.01,
  );
  if (!stillOrthogonal) return undefined;
  // Both ends still on their boxes (a two-point wire's ends must agree).
  const on = (p: LayoutPoint, r: Rect) =>
    p.x >= r.x - 0.5 && p.x <= r.x + r.width + 0.5 && p.y >= r.y - 0.5 && p.y <= r.y + r.height + 0.5;
  if (!on(out[0]!, now.source) || !on(out[out.length - 1]!, now.target)) return undefined;
  return simplify(out);
}

/** The sides an architecture edge declared. */
function declaredSides(edge: { figure?: LayoutEdge["figure"] }): { sourceSides?: Side[]; targetSides?: Side[] } {
  const figure = edge.figure;
  if (figure?.type !== "ports") return {};
  return { sourceSides: [figure.sourceSide], targetSides: [figure.targetSide] };
}

type Item = { readonly id: string; readonly rect: Rect; readonly kind: "node" | "frame" };

/** Whether two rects overlap by more than half a pixel. */
function overlapsStrictly(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width - 0.5 && a.x + a.width > b.x + 0.5 && a.y < b.y + b.height - 0.5 && a.y + a.height > b.y + 0.5
  );
}

/** The gap between two rects along the axis they are apart on (the larger of the two), or 0 when they overlap. */
function separation(a: Rect, b: Rect): number {
  const gx = Math.max(b.x - a.x - a.width, a.x - b.x - b.width);
  const gy = Math.max(b.y - a.y - a.height, a.y - b.y - b.height);
  return Math.max(0, gx, gy);
}

function ancestorsOf(groups: ReadonlyMap<string, LayoutGroup>, groupId: string | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let g = groupId; g !== undefined && groups.has(g) && !seen.has(g); g = groups.get(g)!.parentId) {
    seen.add(g);
    out.push(g);
  }
  return out;
}

const flowAxis = (direction: GraphDirection | undefined): "x" | "y" =>
  direction === "lr" || direction === "rl" ? "x" : "y";
/** Whether the flow runs toward smaller coordinates on its axis. */
const flowReversed = (direction: GraphDirection | undefined) => direction === "bt" || direction === "rl";

type Growth = { uLo: number; uHi: number; dLo: number; dHi: number };

/**
 * The layout of `after` (the nested view with `opened` now open), grown from `before` (where it was
 * a closed box). Throws when `before` has no box for it.
 */
export async function growInPlaceV2(
  before: Laid,
  after: ProjectedView,
  opened: string,
  deps: GrowV2Dependencies,
): Promise<LayoutResult> {
  return (await growPlan(before, after, opened, deps))(true);
}

/**
 * Grow in place in two stages: `first` has every box in its final place, every existing wire
 * stretched, and an orthogonal elbow for each wire still to route; `complete()` routes those
 * wires (the slow part on a large diagram; it can run later, or in a worker). The page shows
 * `first` as the entry animation starts and swaps in `complete()` when it arrives; new wires fade
 * in late in that animation anyway, so the elbows are seldom seen.
 */
export async function growInPlaceV2Staged(
  before: Laid,
  after: ProjectedView,
  opened: string,
  deps: GrowV2Dependencies,
): Promise<{ first: LayoutResult; complete(): LayoutResult }> {
  const build = await growPlan(before, after, opened, deps);
  return { first: build(false), complete: () => build(true) };
}

/** How wires found running under a "−" are routed again round it (`finish`). */
const REPAIR_OPTIONS = { passes: 1, refineRounds: 0, secondOrderLimit: 0 } as const;

/** Clear space round a frame's caption that a wire found through it must keep when routed again. */
const RESERVE_CLEAR = 2;
/**
 * Clear space round a wire's plate that other wires keep: the plate is drawn from the text the
 * browser lays out (`.archer-edge-label`), a little off the estimate the layout sizes it by.
 */
const PLATE_CLEAR = 4;
const grown = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  width: r.width + 2 * by,
  height: r.height + 2 * by,
});
/** A wire's segments as thin rects, for a plate to keep off. */
const segmentRects = (points: readonly LayoutPoint[], by: number): Rect[] =>
  points.slice(1).map((b, i) => {
    const a = points[i]!;
    return grown(
      { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) },
      by,
    );
  });

/** What a line to the outside that is not level costs per pixel off, and the most it costs (`growPlan`'s split). */
const ALIGN_WEIGHT = 1;
const ALIGN_CAP = 160;

/** A router that routes nothing: every wire it is asked for falls back to an elbow. */
const NO_ROUTE = (): Map<string, LayoutPoint[]> => new Map();

/**
 * The inside of a box, laid out on its own: it does not depend on anything outside the box, so it
 * is cached (per layout function, by the inside's content).
 */
const insideCache = new WeakMap<object, Map<string, Promise<LayoutResult>>>();
const INSIDE_CACHE_SIZE = 32;

function insideView(after: ProjectedView, opened: string): ProjectedView {
  const children = after.nodes.filter((node) => node.groupId === opened);
  const childIds = new Set(children.map((node) => node.id));
  const innerEdges = after.edges.filter((edge) => childIds.has(edge.source) && childIds.has(edge.target));
  return { ...after, nodes: children.map((node) => ({ ...node, groupId: undefined })), edges: innerEdges, groups: [] };
}

/**
 * The opened box's boxes in the order that faces what they connect to outside it (owner, 2026-11-15). The inside is
 * laid out on its own, so ELK cannot see that Provider Registry sits above Trace Library next door and would keep the
 * written order, crossing three lines a reader can see should run straight. So, before the inside is laid out, every
 * box with a line to something outside is ordered by where that something is drawn now, along the axis across the flow;
 * a box with no outside line keeps its place, and so do ties. Written order stays the starting point: only the boxes
 * the outside pulls on change places.
 */
export function facePartners(
  inside: ProjectedView,
  after: ProjectedView,
  childIds: ReadonlySet<string>,
  drawn: LayoutResult,
  direction: GraphDirection | undefined,
): ProjectedView {
  const across = direction === "lr" || direction === "rl" ? "y" : "x";
  const at = new Map(
    drawn.nodes.map((node) => [node.id, across === "y" ? node.y + node.height / 2 : node.x + node.width / 2]),
  );
  const pull = new Map<string, number>();
  for (const id of childIds) {
    const partners = after.edges
      .flatMap((edge) => (edge.source === id ? [edge.target] : edge.target === id ? [edge.source] : []))
      .filter((other) => !childIds.has(other) && at.has(other));
    if (partners.length > 0) pull.set(id, partners.reduce((sum, other) => sum + at.get(other)!, 0) / partners.length);
  }
  if (pull.size < 2) return inside;
  const order = writtenOrder(inside);
  const slots = order.elements.flatMap((element, index) =>
    element.kind === "node" && pull.has(element.id) ? [index] : [],
  );
  const now = slots.map((index) => order.elements[index]!.id);
  const faced = [...now].sort((a, b) => pull.get(a)! - pull.get(b)! || now.indexOf(a) - now.indexOf(b));
  if (faced.every((id, k) => id === now[k])) return inside;
  const elements = [...order.elements];
  slots.forEach((slot, k) => (elements[slot] = { id: faced[k]!, kind: "node" }));
  return { ...inside, sourceOrder: { elements, edges: [...order.edges] } };
}

function layOutInside(view: ProjectedView, deps: GrowV2Dependencies): Promise<LayoutResult> {
  let cache = insideCache.get(deps.layout);
  if (cache === undefined) {
    cache = new Map();
    insideCache.set(deps.layout, cache);
  }
  // The written order is part of the key: the same inside faced another way is another layout (`facePartners`).
  const ids = new Set(view.nodes.map((node) => node.id));
  const order = writtenOrder(view)
    .elements.filter((element) => ids.has(element.id))
    .map((element) => element.id);
  const key = JSON.stringify([
    deps.layoutKey ?? "",
    view.direction,
    view.kind,
    view.modelType,
    view.nodes,
    view.edges,
    order,
  ]);
  const hit = cache.get(key);
  if (hit !== undefined) {
    count(deps.profile, "inner.cacheHits");
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const laid = deps.layout(view);
  cache.set(key, laid);
  laid.catch(() => cache.delete(key));
  while (cache.size > INSIDE_CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return laid;
}

async function growPlan(
  drawn: Laid,
  after: ProjectedView,
  opened: string,
  deps: GrowV2Dependencies,
): Promise<(routed: boolean) => LayoutResult> {
  // Grown from the routes as they were before simplifying (`unsimplified`), so the chain never ends worse.
  const before: Laid = { ...drawn, layout: unsimplified(drawn.layout) };
  const route = profiledRoute(deps);
  const profile = deps.profile;
  const boxId = drawnGroupId(after, opened);
  const box = before.layout.nodes.find((node) => node.id === boxId);
  if (box === undefined) throw new Error(`no closed box '${boxId}' in the layout it would grow from`);
  const group = after.groups.find((candidate) => candidate.id === opened);
  if (group === undefined) throw new Error(`'${opened}' is not open in the view to grow into`);
  const direction = before.layout.direction ?? after.direction;

  // (a) The inside, laid out on its own.
  const children = after.nodes.filter((node) => node.groupId === opened);
  const childIds = new Set(children.map((node) => node.id));
  // Bundled lines: each trunk of this box gets an invisible exit node in the inside's layout, and
  // its members' edges go to it, so ELK places the exit at the inside's edge and draws the fans
  // with its own crossing minimisation. The exit node is never drawn.
  const exits = deps.bundle === true ? exitPlan(after, childIds) : new Map<string, ExitGroup>();
  const insideBase = facePartners(insideView(after, opened), after, childIds, before.layout, direction);
  // `~` is in no model id (`nest-view.ts`), so an exit node's id cannot collide with a real one.
  const exitId = (target: string) => `exit~${target}`;
  const insideWithExits: ProjectedView =
    exits.size === 0
      ? insideBase
      : {
          ...insideBase,
          nodes: [
            ...insideBase.nodes,
            ...[...exits.keys()].map((target) => ({
              id: exitId(target),
              label: "",
              shape: undefined,
              classes: [],
              groupId: undefined,
            })),
          ],
          edges: [
            ...insideBase.edges,
            ...[...exits].flatMap(([target, g]) =>
              g.members.map((m) =>
                m.edge.source === m.inside
                  ? { id: m.edge.id, source: m.inside, target: exitId(target), label: undefined }
                  : { id: m.edge.id, source: exitId(target), target: m.inside, label: undefined },
              ),
            ),
          ],
        };
  const inner = await spanAsync(profile, "inner", () => layOutInside(insideWithExits, deps));
  const innerRects: Rect[] = [
    ...inner.nodes.flatMap(drawnRects),
    ...inner.edges.flatMap((edge) => [
      ...edge.points.map((p) => ({ x: p.x, y: p.y, width: 0, height: 0 })),
      ...(edge.labelAnchor === undefined ? [] : [edge.labelAnchor]),
    ]),
  ];
  const minX = Math.min(...innerRects.map((r) => r.x));
  const minY = Math.min(...innerRects.map((r) => r.y));
  const maxX = Math.max(...innerRects.map((r) => r.x + r.width));
  const maxY = Math.max(...innerRects.map((r) => r.y + r.height));
  const typeface = before.layout.typeface;
  const width = Math.max(
    maxX - minX + 2 * PAD,
    frameMinimumWidth(
      { label: group.label, ...(group.figure === undefined ? {} : { figure: group.figure }) },
      typeface,
    ),
    box.width,
  );
  const height = Math.max(maxY - minY + FRAME_CAPTION_BAND_PX + PAD, box.height);

  // (b) Where it grows.
  const placementStart = performance.now();
  const groupsById = new Map(before.layout.groups.map((g) => [g.id, g]));
  const ancestors = new Set(ancestorsOf(groupsById, box.groupId));
  const items: Item[] = [
    ...before.layout.nodes
      .filter((n) => n.id !== boxId)
      .flatMap((n) =>
        drawnRects(n).map((rect, k) => ({ id: k === 0 ? n.id : `${n.id}__note`, rect, kind: "node" as const })),
      ),
    ...before.layout.groups
      .filter((g) => !ancestors.has(g.id))
      .map((g) => ({ id: g.id, rect: g as Rect, kind: "frame" as const })),
  ];
  const ancestorFrames = [...ancestors].map((id) => groupsById.get(id)!);
  // A labelled wire from the opened box to a box (or into a frame) beside it crosses the gap
  // between them: the gap must hold its label plate, or the plate lands on a frame edge.
  const labelRoom = new Map<string, { x: number; y: number }>();
  const nodeGroupBefore = new Map(before.layout.nodes.map((n) => [n.id, n.groupId]));
  // Room for each wire's plate as drawn now, and for the plate the same neighbour's wire had while
  // the box was closed (often an "N connections" bundle, wider than any member, and the close
  // draws it again; compaction never pushes boxes apart): the larger of the two, per axis.
  const reserve = (other: string, text: string | undefined) => {
    if (!text) return;
    const plate = edgeLabelBox(text, typeface);
    for (const id of [other, ...ancestorsOf(groupsById, nodeGroupBefore.get(other))]) {
      const was = labelRoom.get(id) ?? { x: 0, y: 0 };
      labelRoom.set(id, { x: Math.max(was.x, plate.width + 24), y: Math.max(was.y, plate.height + 24) });
    }
  };
  for (const edge of after.edges) {
    const other = childIds.has(edge.source) ? edge.target : childIds.has(edge.target) ? edge.source : undefined;
    if (other !== undefined && !childIds.has(other)) reserve(other, edge.caption ?? edge.label);
  }
  for (const edge of before.view.edges) {
    const other = edge.source === boxId ? edge.target : edge.target === boxId ? edge.source : undefined;
    if (other !== undefined && other !== boxId) reserve(other, edge.caption ?? edge.label);
  }
  /** The clearance an item keeps from the grown frame along an axis: at least GAP, room for a label, never more than it had. */
  const gapFor = (item: Item, axis: "x" | "y") =>
    Math.min(Math.max(GAP, labelRoom.get(item.id)?.[axis] ?? 0), separation(item.rect, box));
  const ex = width - box.width;
  const ey = height - box.height;
  const flow = flowAxis(direction);
  const reversed = flowReversed(direction);

  const frameFor = (gx: Growth, gy: Growth): Rect => ({ x: box.x - gx.uLo, y: box.y - gy.uLo, width, height });
  const mapsFor = (gx: Growth, gy: Growth): Maps => ({
    x: { a0: box.x, a1: box.x + box.width, dLo: gx.dLo, dHi: gx.dHi },
    y: { a0: box.y, a1: box.y + box.height, dLo: gy.dLo, dHi: gy.dHi },
  });
  /** Pushes each side as far as needed for the frame to fit (never further than its own growth). */
  const resolve = (gx: Growth, gy: Growth): void => {
    for (let round = 0; round < 12; round++) {
      const maps = mapsFor(gx, gy);
      const frame = frameFor(gx, gy);
      const need = { xLo: 0, xHi: 0, yLo: 0, yHi: 0 };
      for (const item of items) {
        const r = item.kind === "node" ? moveBox(item.rect, maps) : moveFrame(item.rect, maps);
        const sepX = Math.max(item.rect.x - box.x - box.width, box.x - item.rect.x - item.rect.width);
        const gap = gapFor(item, sepX >= 0 ? "x" : "y");
        const overlaps =
          r.x < frame.x + frame.width + gap &&
          r.x + r.width > frame.x - gap &&
          r.y < frame.y + frame.height + gap &&
          r.y + r.height > frame.y - gap;
        if (!overlaps) continue;
        const o = item.rect;
        const options: [keyof typeof need, number][] = [];
        if (o.x >= box.x + box.width - 0.5) options.push(["xHi", frame.x + frame.width + gap - r.x]);
        if (o.x + o.width <= box.x + 0.5) options.push(["xLo", r.x + r.width + gap - frame.x]);
        if (o.y >= box.y + box.height - 0.5) options.push(["yHi", frame.y + frame.height + gap - r.y]);
        if (o.y + o.height <= box.y + 0.5) options.push(["yLo", r.y + r.height + gap - frame.y]);
        // A side already pushed as far as its growth cannot help.
        const open = options.filter(([key]) =>
          key === "xLo"
            ? gx.dLo < gx.uLo
            : key === "xHi"
              ? gx.dHi < gx.uHi
              : key === "yLo"
                ? gy.dLo < gy.uLo
                : gy.dHi < gy.uHi,
        );
        if (open.length === 0) continue;
        open.sort((p, q) => p[1] - q[1]);
        const [key, amount] = open[0]!;
        need[key] = Math.max(need[key], amount);
      }
      for (const a of ancestorFrames) {
        const r = moveFrame(a, maps);
        need.xLo = Math.max(need.xLo, r.x + PAD - frame.x);
        need.xHi = Math.max(need.xHi, frame.x + frame.width + PAD - r.x - r.width);
        need.yLo = Math.max(need.yLo, r.y + FRAME_CAPTION_BAND_PX - frame.y);
        need.yHi = Math.max(need.yHi, frame.y + frame.height + PAD - r.y - r.height);
      }
      const total = gx.dLo + gx.dHi + gy.dLo + gy.dHi;
      gx.dLo = Math.min(gx.uLo, gx.dLo + Math.max(0, need.xLo));
      gx.dHi = Math.min(gx.uHi, gx.dHi + Math.max(0, need.xHi));
      gy.dLo = Math.min(gy.uLo, gy.dLo + Math.max(0, need.yLo));
      gy.dHi = Math.min(gy.uHi, gy.dHi + Math.max(0, need.yHi));
      if (gx.dLo + gx.dHi + gy.dLo + gy.dHi - total < 0.5) return;
    }
  };
  // Free room beside the box on each side, along each axis (a hint for the candidates).
  const freeRoom = (axis: "x" | "y", hi: boolean): number => {
    let room = Infinity;
    for (const item of items) {
      const r = item.rect;
      const across =
        axis === "x"
          ? r.y < box.y + height && r.y + r.height > box.y - (height - box.height)
          : r.x < box.x + width && r.x + r.width > box.x - (width - box.width);
      if (!across) continue;
      const gap =
        axis === "x"
          ? hi
            ? r.x - box.x - box.width
            : box.x - r.x - r.width
          : hi
            ? r.y - box.y - box.height
            : box.y - r.y - r.height;
      if (gap >= -0.5) room = Math.min(room, gap - Math.max(GAP, labelRoom.get(item.id)?.[axis] ?? 0));
    }
    for (const a of ancestorFrames) {
      const gap =
        axis === "x"
          ? hi
            ? a.x + a.width - box.x - box.width - PAD
            : box.x - a.x - PAD
          : hi
            ? a.y + a.height - box.y - box.height - PAD
            : box.y - a.y - FRAME_CAPTION_BAND_PX;
      room = Math.min(room, gap);
    }
    return Math.max(0, room);
  };
  // Lines to the outside, across the flow: where each inside box's line meets it, and where its partner is drawn. A
  // frame that opens level with what its boxes connect to lets those lines run straight (owner, 2026-11-15: three
  // Data Sources lines dropped down one shared run because the frame opened 200 px below their partners).
  const across: "x" | "y" = flow === "x" ? "y" : "x";
  const lead = across === "y" ? FRAME_CAPTION_BAND_PX - minY : PAD - minX;
  const outsideIds = new Map(before.layout.nodes.map((node) => [node.id, node]));
  const pairs = inner.nodes.flatMap((node) =>
    childIds.has(node.id)
      ? after.edges.flatMap((edge) => {
          const other = edge.source === node.id ? edge.target : edge.target === node.id ? edge.source : undefined;
          const partner = other === undefined || childIds.has(other) ? undefined : outsideIds.get(other);
          return partner === undefined ? [] : [{ inside: centreOf(node)[across], partner: centreOf(partner)[across] }];
        })
      : [],
  );
  /** The growth before the box, across the flow, that puts the inside level with its partners on average. */
  const aligning =
    pairs.length === 0
      ? undefined
      : pairs.reduce((sum, pair) => sum + pair.inside + box[across] + lead - pair.partner, 0) / pairs.length;
  const splits = (axis: "x" | "y", extra: number): number[] => {
    const lo = Math.min(extra, freeRoom(axis, false));
    const hi = Math.min(extra, freeRoom(axis, true));
    const level = axis === across && aligning !== undefined ? [aligning] : [];
    // Along the flow, the box grows downstream; it takes room upstream only when that room is free.
    if (axis === flow) return [...new Set(reversed ? [extra, extra - hi] : [0, lo])];
    return [...new Set([0, extra / 2, extra, lo, extra - hi, ...level].map((v) => Math.min(extra, Math.max(0, v))))];
  };
  const beforeEdges = new Map(before.layout.edges.map((edge) => [edge.id, edge]));
  const keptCandidates = after.edges.filter((edge) => {
    const was = beforeEdges.get(edge.id);
    return (
      was !== undefined &&
      was.source === edge.source &&
      was.target === edge.target &&
      !childIds.has(edge.source) &&
      !childIds.has(edge.target)
    );
  });
  let best: { gx: Growth; gy: Growth; cost: number } | undefined;
  for (const ux of splits("x", ex)) {
    for (const uy of splits("y", ey)) {
      const gx: Growth = { uLo: ux, uHi: ex - ux, dLo: 0, dHi: 0 };
      const gy: Growth = { uLo: uy, uHi: ey - uy, dLo: 0, dHi: 0 };
      resolve(gx, gy);
      const maps = mapsFor(gx, gy);
      const frame = frameFor(gx, gy);
      let cost = 0;
      for (const node of before.layout.nodes) {
        if (node.id === boxId) continue;
        const c = centreOf(node);
        cost += Math.abs(mapAxis(maps.x, c.x) - c.x) + Math.abs(mapAxis(maps.y, c.y) - c.y);
      }
      // Against the flow costs more than with it.
      const upstream = flow === "x" ? (reversed ? gx.uHi : gx.uLo) : reversed ? gy.uHi : gy.uLo;
      cost += 2 * upstream;
      for (const edge of keptCandidates) {
        const was = beforeEdges.get(edge.id)!;
        const points = was.points.map((p) => ({ x: mapAxis(maps.x, p.x), y: mapAxis(maps.y, p.y) }));
        if (routeCrosses(points, frame, 1) || runsAlong(points, frame)) cost += 120;
      }
      // Lines that do not meet their partners level cost what they are off by (up to a box's height or so): a straight
      // line is worth moving other boxes a little for, but not a long way.
      for (const pair of pairs) {
        const off = Math.abs(pair.inside + frame[across] + lead - mapAxis(maps[across], pair.partner));
        cost += ALIGN_WEIGHT * Math.min(off, ALIGN_CAP);
      }
      if (best === undefined || cost < best.cost - 0.5) best = { gx, gy, cost };
    }
  }
  const { gx, gy } = best!;
  if (profile !== undefined)
    profile.spans.placement = (profile.spans.placement ?? 0) + performance.now() - placementStart;
  const maps = mapsFor(gx, gy);
  const frame = frameFor(gx, gy);
  const offset = { x: frame.x + PAD - minX, y: frame.y + FRAME_CAPTION_BAND_PX - minY };

  const nodes: LayoutNode[] = [];
  const movedRects = new Map<string, Rect>();
  for (const node of before.layout.nodes) {
    if (node.id === boxId) continue;
    const moved = moveNode(node, maps);
    nodes.push(moved);
    movedRects.set(node.id, moved);
  }
  const placedChildren = new Map(children.map((node) => [node.id, node]));
  for (const node of inner.nodes) {
    const projected = placedChildren.get(node.id);
    if (projected === undefined) continue; // an exit node
    nodes.push({
      ...node,
      x: node.x + offset.x,
      y: node.y + offset.y,
      groupId: opened,
      ...(node.note === undefined
        ? {}
        : { note: { ...node.note, x: node.note.x + offset.x, y: node.note.y + offset.y } }),
      ...(projected.figure === undefined ? {} : { figure: projected.figure }),
    });
  }
  const groups: LayoutGroup[] = before.layout.groups.map((g) => moveGroup(g, maps));
  const caption = captionSize(
    { label: group.label, ...(group.figure === undefined ? {} : { figure: group.figure }) },
    typeface,
  );
  groups.push({
    id: group.id,
    label: group.label,
    parentId: group.parentId,
    ...frame,
    ...(group.element === true ? { element: true } : {}),
    ...(group.figure === undefined ? {} : { figure: group.figure }),
    ...(group.classes === undefined ? {} : { classes: group.classes }),
    caption: { x: frame.x + FRAME_CAPTION_INSET.x, y: frame.y + FRAME_CAPTION_INSET.y, ...caption },
  });
  const beforeRects = new Map<string, Rect>([
    ...before.layout.nodes.map((n) => [n.id, n as Rect] as const),
    ...before.layout.groups.map((g) => [drawnGroupId(before.view, g.id), g as Rect] as const),
  ]);

  // (c) Wires.
  // Each exit becomes a point on the frame's edge, on the side ELK put it, and each member's fan
  // runs from its inner box through the exit's centre to that point.
  const presets = new Map<string, Preset>();
  const real = inner.nodes.filter((n) => placedChildren.has(n.id));
  const memberIds = new Set([...exits.values()].flatMap((g) => g.members.map((m) => m.edge.id)));
  if (real.length > 0) {
    const rx0 = Math.min(...real.map((n) => n.x));
    const rx1 = Math.max(...real.map((n) => n.x + n.width));
    const ry0 = Math.min(...real.map((n) => n.y));
    const ry1 = Math.max(...real.map((n) => n.y + n.height));
    for (const [target, g] of exits) {
      const d = inner.nodes.find((n) => n.id === exitId(target));
      if (d === undefined) continue;
      const c = { x: d.x + d.width / 2 + offset.x, y: d.y + d.height / 2 + offset.y };
      const cx = d.x + d.width / 2;
      const cy = d.y + d.height / 2;
      const side = cx >= rx1 ? "right" : cx <= rx0 ? "left" : cy >= ry1 ? "bottom" : cy <= ry0 ? "top" : undefined;
      if (side === undefined) continue;
      // Never at a corner (the side would be ambiguous): at least 12 px in from each end.
      const along = (v: number, lo: number, length: number) => Math.min(Math.max(v, lo + 12), lo + length - 12);
      const exit =
        side === "right"
          ? { x: frame.x + frame.width, y: along(c.y, frame.y, frame.height) }
          : side === "left"
            ? { x: frame.x, y: along(c.y, frame.y, frame.height) }
            : side === "bottom"
              ? { x: along(c.x, frame.x, frame.width), y: frame.y + frame.height }
              : { x: along(c.x, frame.x, frame.width), y: frame.y };
      const fans = new Map<string, LayoutPoint[]>();
      for (const m of g.members) {
        const laid = inner.edges.find((e) => e.id === m.edge.id);
        if (laid === undefined || laid.points.length < 2) continue;
        const moved = laid.points.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y }));
        const out = laid.source === m.inside ? moved : [...moved].reverse();
        const p = out[out.length - 1]!;
        const join = side === "right" || side === "left" ? { x: c.x, y: exit.y } : { x: exit.x, y: c.y };
        const via =
          side === "right" || side === "left" ? [{ x: c.x, y: p.y }, join, exit] : [{ x: p.x, y: c.y }, join, exit];
        fans.set(m.edge.id, simplify([...out, ...via]));
      }
      if (fans.size === g.members.length) presets.set(`trunk:${boxId}~${target}`, { exit, fans });
    }
  }
  const innerRoutes = new Map(
    inner.edges
      .filter((edge) => !memberIds.has(edge.id))
      .map((edge) => [
        edge.id,
        {
          ...edge,
          points: edge.points.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })),
          labelAnchor:
            edge.labelAnchor === undefined
              ? undefined
              : { ...edge.labelAnchor, x: edge.labelAnchor.x + offset.x, y: edge.labelAnchor.y + offset.y },
        },
      ]),
  );
  const carried = new Map(growthRecords(before.layout));
  carried.set(opened, {
    x: { lo: gx.dLo, hi: gx.dHi, offset: gx.uLo - gx.dLo },
    y: { lo: gy.dLo, hi: gy.dHi, offset: gy.uLo - gy.dLo },
    sequence: ++sequence,
  });
  return (routed) => {
    const finished = finish(
      before,
      after,
      [...nodes],
      groups,
      innerRoutes,
      beforeRects,
      maps,
      routed ? route : NO_ROUTE,
      direction,
      typeface,
      profile,
      deps.bundle === true,
      presets,
    );
    if (!routed) {
      records.set(finished, carried);
      return finished;
    }
    // Each caption with air round it now its wires are routed; then fewer needless corners, as a whole drawing gets
    // (`route-simplify.ts`). The staged first picture keeps its elbows and its captions.
    const aired = withCaptionAir(finished, captionEnds(after));
    const result = simplifyRoutes(aired, { walls: aired.groups.map(frameToggleRect) });
    records.set(result, carried);
    records.set(aired, carried);
    records.set(finished, carried);
    return result;
  };
}

/**
 * Wires and labels of an adjusted layout: inner wires as given, every other wire stretched by the
 * maps when it still clears every box and the frames it may not cross, the rest routed.
 */
function finish(
  before: Laid,
  after: ProjectedView,
  nodes: LayoutNode[],
  groups: LayoutGroup[],
  inner: ReadonlyMap<string, LayoutEdge>,
  beforeRects: ReadonlyMap<string, Rect>,
  maps: Maps,
  route: (request: OrthoRequest) => Map<string, LayoutPoint[]>,
  direction: GraphDirection | undefined,
  typeface: LayoutResult["typeface"],
  profile?: NestProfile,
  bundle = false,
  presets: ReadonlyMap<string, Preset> = new Map(),
): LayoutResult {
  const stretchStart = performance.now();
  const nodeRects = new Map(nodes.map((node) => [node.id, node as Rect]));
  const frameRects = new Map(groups.map((g) => [g.element === true ? g.id : `group:${g.id}`, g as Rect]));
  const rectOf = (id: string) => nodeRects.get(id) ?? frameRects.get(id);
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  /** The frames (drawn ids) an end is inside. */
  const framesOf = (id: string): Set<string> => {
    const node = nodes.find((n) => n.id === id);
    const start =
      node !== undefined
        ? node.groupId
        : groups.find((g) => (g.element === true ? g.id : `group:${g.id}`) === id)?.parentId;
    return new Set(ancestorsOf(groupsById, start).map((g) => (groupsById.get(g)!.element === true ? g : `group:${g}`)));
  };
  const beforeEdges = new Map(before.layout.edges.map((edge) => [edge.id, edge]));
  const edges: LayoutEdge[] = [];
  const toRoute: LayoutEdge[] = [];
  const projectedById = new Map(after.edges.map((edge) => [edge.id, edge]));
  const trunks = bundle ? trunksOf(after, nodes, groupsById, inner) : [];
  const bundled = new Set(trunks.flatMap((t) => t.members.map((m) => m.edge.id)));
  // The outermost neutral frame names itself at the top right, as the whole drawing does (`captionEnds`): from the
  // band's right end, clear of its "−" and of the boxes in it, before any wire is routed past it.
  const ends = captionEnds(after);
  for (const [index, g] of groups.entries()) {
    if (ends.get(g.id) !== "end" || g.caption === undefined) continue;
    const size = { width: g.caption.width, height: g.caption.height };
    groups[index] = { ...g, caption: placeCaption(g, size, [frameToggleRect(g), ...nodes], "end") };
  }
  // Where each frame's "−" is drawn at any zoom, and each frame's caption: a wire kept through
  // either is routed again instead (a caption is text: a wire through it strikes it out).
  const toggles = groups.map(frameToggleRect);
  const captions = groups.flatMap((g) =>
    g.caption === undefined ? [] : [{ id: `${g.id}__caption`, rect: g.caption as Rect }],
  );
  const reserved = [...toggles, ...captions.map((c) => grown(c.rect, RESERVE_CLEAR))];
  const clearOfReserved = (points: readonly LayoutPoint[]) => reserved.every((r) => !routeCrosses(points, r, 0));
  for (const edge of after.edges) {
    if (bundled.has(edge.id)) continue;
    const own = inner.get(edge.id);
    if (own !== undefined && clearOfReserved(own.points)) {
      edges.push(own);
      continue;
    }
    const was = beforeEdges.get(edge.id);
    const source = rectOf(edge.source);
    const target = rectOf(edge.target);
    const ws = beforeRects.get(edge.source);
    const wt = beforeRects.get(edge.target);
    if (
      was !== undefined &&
      was.source === edge.source &&
      was.target === edge.target &&
      source !== undefined &&
      target !== undefined &&
      ws !== undefined &&
      wt !== undefined
    ) {
      const points = stretchWire(was.points, maps, { source: ws, target: wt }, { source, target });
      if (points !== undefined) {
        // Kept only if it still clears every box but its own ends, and every frame it may not cross.
        const inS = framesOf(edge.source);
        const inT = framesOf(edge.target);
        count(profile, "checks.stretch", nodes.length + frameRects.size);
        const clearBoxes = nodes.every(
          (node) =>
            node.id === edge.source ||
            node.id === edge.target ||
            drawnRects(node).every((r) => !routeCrosses(points, r, 1)),
        );
        const clearFrames = [...frameRects].every(
          ([id, r]) =>
            id === edge.source ||
            id === edge.target ||
            ((inS.has(id) !== inT.has(id) || crossingsOfFrame(points, r) === 0) && !runsAlong(points, r)),
        );
        if (clearBoxes && clearFrames && clearOfReserved(points)) {
          const dx =
            was.labelAnchor === undefined
              ? 0
              : mapAxis(maps.x, was.labelAnchor.x + was.labelAnchor.width / 2) -
                (was.labelAnchor.x + was.labelAnchor.width / 2);
          const dy =
            was.labelAnchor === undefined
              ? 0
              : mapAxis(maps.y, was.labelAnchor.y + was.labelAnchor.height / 2) -
                (was.labelAnchor.y + was.labelAnchor.height / 2);
          edges.push({
            ...was,
            points,
            labelAnchor:
              was.labelAnchor === undefined
                ? undefined
                : { ...was.labelAnchor, x: was.labelAnchor.x + dx, y: was.labelAnchor.y + dy },
          });
          continue;
        }
      }
    }
    toRoute.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      // What the production layout draws (`elk-layout.ts`): a C4 relationship's caption carries its [technology].
      label: edge.caption ?? edge.label,
      ...(edge.line === undefined ? {} : { line: edge.line }),
      ...(edge.bidirectional === true ? { bidirectional: true } : {}),
      ...(edge.figure === undefined ? {} : { figure: edge.figure }),
      points: [],
      labelAnchor: was?.labelAnchor,
    });
  }
  if (profile !== undefined) profile.spans.stretch = (profile.spans.stretch ?? 0) + performance.now() - stretchStart;
  count(profile, "wires.kept", edges.length);
  // What a label plate must keep off: every box and note, every frame's caption, every frame's
  // edge (a plate on the edge hides the frame's line there) and its "−" (drawn over the canvas).
  const taken: Rect[] = [
    ...nodes.flatMap(drawnRects),
    ...groups.flatMap((g) => (g.caption === undefined ? [] : [g.caption])),
    ...groups.flatMap(frameEdges),
    ...toggles,
  ];
  // Each trunk is routed like a wire from its closed box to its frame (whose edge it ends on).
  for (const trunk of trunks) {
    toRoute.push({
      id: trunk.id,
      source: trunk.target,
      target: trunk.frame,
      label: `${trunk.members.length} connections`,
      ...(trunk.dotted ? { line: "dotted" as const } : {}),
      points: [],
      labelAnchor: undefined,
    });
  }
  const boxes = [
    ...nodes.map((node) => ({ id: node.id, rect: node as Rect })),
    ...nodes.flatMap((node) => (node.note === undefined ? [] : [{ id: `${node.id}__note`, rect: node.note as Rect }])),
  ];
  // A frame's "−" is drawn over the canvas: a wire under it is hidden there; and a wire through a
  // frame's caption strikes the words out. The wires are routed round the boxes first, and only
  // those that then run under a "−" or through a caption are routed again round them too (below):
  // the "−" as an obstacle in every search doubled the dearest presses (flow-large, 2026-10-31).
  const obstacles = [
    ...boxes,
    ...groups.map((group, index) => ({ id: `${group.id}__toggle`, rect: toggles[index]! })),
    ...captions,
  ];
  const framesList = [...frameRects].map(([id, rect]) => ({ id, rect }));
  const connectionOf = (edge: LayoutEdge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...declaredSides(edge),
    ...(presets.has(edge.id) ? { targetAt: presets.get(edge.id)!.exit } : {}),
  });
  if (toRoute.length > 0) {
    const ask = (fixed: readonly LayoutEdge[], wires: readonly LayoutEdge[]) =>
      route({
        obstacles: boxes,
        frames: framesList,
        fixed: fixed.map((edge) => edge.points),
        connections: wires.map(connectionOf),
        direction,
      });
    const routes = ask(edges, toRoute);
    // A kept wire that the new wires cross twice or more is routed again with them, and the result
    // is taken only if it crosses less overall (a kept wire can wall a box in).
    const fresh = [...routes.values()];
    const promoted = edges.filter(
      (edge) => !inner.has(edge.id) && fresh.reduce((sum, points) => sum + countCrossings(edge.points, points), 0) >= 2,
    );
    if (promoted.length > 0) {
      // Only the promoted wires and the new wires that cross them are routed again; the rest of
      // the first result stays as it is (as fixed wires), so this round costs a fraction of the first.
      const stay = edges.filter((edge) => !promoted.includes(edge));
      const involved = toRoute.filter((edge) => {
        const points = routes.get(edge.id);
        return points === undefined || promoted.some((kept) => countCrossings(kept.points, points) > 0);
      });
      const settled = toRoute.filter((edge) => !involved.includes(edge) && routes.has(edge.id));
      const wires = [...involved, ...promoted];
      const settledLines = settled.map((edge) => ({ ...edge, points: routes.get(edge.id)! }));
      const again = ask([...stay, ...settledLines], wires);
      const total = (lines: readonly (readonly LayoutPoint[])[]) => {
        let sum = 0;
        for (let i = 0; i < lines.length; i++)
          for (let j = i + 1; j < lines.length; j++) sum += countCrossings(lines[i]!, lines[j]!);
        return sum;
      };
      const after = [...stay.map((e) => e.points), ...settledLines.map((e) => e.points), ...again.values()];
      if (
        wires.every((edge) => again.has(edge.id)) &&
        total(after) < total([...edges.map((e) => e.points), ...fresh])
      ) {
        edges.length = 0;
        edges.push(...stay);
        toRoute.push(...promoted);
        for (const [id, points] of again) routes.set(id, points);
      }
    }
    // A wire the router could not route with its declared sides is tried with any side.
    const missing = toRoute.filter((edge) => !routes.has(edge.id));
    if (missing.length > 0) {
      const retry = route({
        obstacles: boxes,
        frames: framesList,
        fixed: edges.map((edge) => edge.points),
        connections: missing.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          ...(presets.has(edge.id) ? { targetAt: presets.get(edge.id)!.exit } : {}),
        })),
        direction,
      });
      for (const [id, points] of retry) routes.set(id, points);
    }
    // The wires that run under a "−" or through a caption are routed again round them (with any
    // side if their own will not do), the rest staying as they are. Should one still find no way,
    // every wire is routed round every "−" and caption at once, as a last resort.
    const under = toRoute.filter((edge) => {
      const points = routes.get(edge.id);
      return points !== undefined && !clearOfReserved(points);
    });
    if (under.length > 0) {
      const ids = new Set(under.map((edge) => edge.id));
      const fixed = [
        ...edges.map((edge) => edge.points),
        ...toRoute.flatMap((edge) => (ids.has(edge.id) || !routes.has(edge.id) ? [] : [routes.get(edge.id)!])),
      ];
      // One pass in one order: these few wires detour round a corner past wires that stay; the
      // extra passes, refinement and second order tripled this call's search work (flow-large).
      const again = route({
        obstacles,
        frames: framesList,
        fixed,
        connections: under.map(connectionOf),
        direction,
        options: REPAIR_OPTIONS,
      });
      const left = under.filter((edge) => !again.has(edge.id));
      if (left.length > 0) {
        const anySide = route({
          obstacles,
          frames: framesList,
          fixed: [...fixed, ...again.values()],
          connections: left.map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            ...(presets.has(edge.id) ? { targetAt: presets.get(edge.id)!.exit } : {}),
          })),
          direction,
        });
        for (const [id, points] of anySide) again.set(id, points);
      }
      if (under.every((edge) => again.has(edge.id))) for (const [id, points] of again) routes.set(id, points);
      else {
        const all = route({
          obstacles,
          frames: framesList,
          fixed: edges.map((edge) => edge.points),
          connections: toRoute.map(connectionOf),
          direction,
        });
        if (toRoute.every((edge) => all.has(edge.id) || !routes.has(edge.id)))
          for (const [id, points] of all) routes.set(id, points);
      }
    }
    // Each trunk's members fan out inside its frame from the trunk's exit on the frame's edge.
    const trunkById = new Map(trunks.map((t) => [t.id, t]));
    const fanned = new Map<string, LayoutPoint[]>();
    for (const [, preset] of presets) for (const [id, points] of preset.fans) fanned.set(id, points);
    const fans = trunks.flatMap((trunk) => {
      if (presets.has(trunk.id)) return [];
      const line = routes.get(trunk.id);
      if (line === undefined || line.length < 2) return [];
      const exit = line[line.length - 1]!;
      return trunk.members.map((m) => ({ id: m.edge.id, source: m.inside, target: trunk.frame, targetAt: exit }));
    });
    if (fans.length > 0) {
      const fixed = [...edges.map((e) => e.points), ...[...routes.values()]];
      const fanRoutes = route({ obstacles, frames: framesList, fixed, connections: fans, direction });
      for (const [id, points] of fanRoutes) fanned.set(id, points);
    }
    /** Where a trunk meets its frame: its pinned exit, or the end of its routed line. */
    const exitOf = (trunk: Trunk): LayoutPoint | undefined =>
      presets.get(trunk.id)?.exit ?? routes.get(trunk.id)?.at(-1);
    const pointRect = (p: LayoutPoint): Rect => ({ x: p.x, y: p.y, width: 0, height: 0 });
    for (const trunk of trunks) {
      const exit = exitOf(trunk);
      for (const m of trunk.members) {
        const fan = fanned.get(m.edge.id);
        // A member whose fan could not be routed still ends at the trunk's exit (an elbow); with no
        // exit at all it is drawn on its own.
        const own =
          fan ??
          (exit === undefined
            ? elbow(rectOf(m.edge.source), rectOf(m.edge.target))
            : elbow(rectOf(m.inside), pointRect(exit)));
        // Drawn from where the member starts: out of the frame to the box, or in from the exit.
        const points = m.edge.source === m.inside ? own : [...own].reverse();
        edges.push({
          id: m.edge.id,
          source: m.edge.source,
          target: m.edge.target,
          label: m.edge.caption ?? m.edge.label,
          ...(m.edge.line === undefined ? {} : { line: m.edge.line }),
          ...(m.edge.bidirectional === true ? { bidirectional: true } : {}),
          ...(m.edge.figure === undefined ? {} : { figure: m.edge.figure }),
          points,
          // A member's own words are listed on the trunk (hover or tap), not drawn on its fan.
          labelAnchor: undefined,
        });
      }
    }
    for (const edge of toRoute) {
      const trunk = trunkById.get(edge.id);
      if (trunk !== undefined) {
        // Pointing at the box when any member does; otherwise from the box to the frame, with no
        // arrowhead at the frame (the fans carry the members' heads inside it).
        const pinned = presets.get(trunk.id)?.exit;
        const line =
          routes.get(edge.id) ??
          elbow(rectOf(trunk.target), pinned === undefined ? rectOf(trunk.frame) : pointRect(pinned));
        // An arrowhead at the box when any member has one there (declared arrows, figures included).
        const outward = trunk.members.some((m) => {
          const arrows = arrowsOf(m.edge.figure, m.edge.bidirectional === true);
          return m.edge.source === m.inside ? arrows.end : arrows.start;
        });
        const points = outward ? [...line].reverse() : line;
        const size = edgeLabelBox(edge.label!, typeface);
        edges.push({
          ...edge,
          source: outward ? trunk.frame : trunk.target,
          target: outward ? trunk.target : trunk.frame,
          points,
          labelAnchor: points.length < 2 ? undefined : boxAt(points, size, lengthOf(points) / 2),
        });
        continue;
      }
      const points = routes.get(edge.id) ?? elbow(rectOf(edge.source), rectOf(edge.target));
      const text = projectedById.get(edge.id)?.caption ?? edge.label;
      const size = edge.labelAnchor ?? (text ? edgeLabelBox(text, typeface) : undefined);
      edges.push({
        ...edge,
        points,
        labelAnchor: size === undefined || points.length < 2 ? undefined : boxAt(points, size, lengthOf(points) / 2),
      });
    }
  }
  edges.sort((x, y) => x.id.localeCompare(y.id));
  nodes.sort((x, y) => x.id.localeCompare(y.id));
  const labelStart = performance.now();
  // Plates the reader already saw (kept and inner wires) are placed first; new wires' plates
  // then find room around them.
  const fresh = new Set(toRoute.map((edge) => edge.id));
  const order = edges
    .map((_, index) => index)
    .sort((p, q) => Number(fresh.has(edges[p]!.id)) - Number(fresh.has(edges[q]!.id)));
  for (const index of order) {
    const edge = edges[index]!;
    const anchor = edge.labelAnchor;
    if (anchor === undefined || edge.points.length < 2) continue;
    // Kept as it is only while clear and still on its own wire (a stretched plate can drift off a
    // wire that stayed put).
    if (routeCrosses(edge.points, anchor, 0) && !taken.some((other) => intersects(anchor, other))) {
      taken.push(anchor);
      continue;
    }
    const placed = labelOnRoute(edge.points, anchor, taken);
    // A trunk's "N connections" plate with no free place anywhere on it is left off: its
    // thickness still says it is a bundle, and its members are listed on hover or tap.
    const blocked =
      (edge.id.startsWith("trunk:") || edge.id.startsWith("bundle:")) &&
      taken.slice(0, -1).some((other) => intersects(placed, other));
    if (blocked) taken.pop();
    edges[index] = { ...edge, labelAnchor: blocked ? undefined : placed };
  }
  clearPlates(edges, taken, {
    obstacles,
    frames: framesList,
    connectionOf,
    route,
    direction,
    rerouteable: (edge) =>
      !bundled.has(edge.id) &&
      !edge.id.startsWith("trunk:") &&
      rectOf(edge.source) !== undefined &&
      rectOf(edge.target) !== undefined,
    clearOfReserved,
    profile,
  });
  if (profile !== undefined) profile.spans.labels = (profile.spans.labels ?? 0) + performance.now() - labelStart;
  // The drawing moves as a whole (one vector, nothing changes order) to keep the margin the layout
  // had. The vector is worked out from BOXES and frames only: wires and their plates are routed in
  // the second stage, so a vector that counted them would move every box of `complete` against the
  // staged `first` the page already shows. A wire routed past the edge may sit at a negative
  // coordinate; the canvas draws it there.
  const rects: Rect[] = [
    ...nodes.flatMap(drawnRects),
    ...groups,
    ...edges.flatMap((e) => (e.labelAnchor === undefined ? [] : [e.labelAnchor])),
  ];
  const points = edges.flatMap((e) => e.points);
  const boxRects: Rect[] = [...nodes.flatMap(drawnRects), ...groups];
  const was = before.layout;
  const wasBoxes: Rect[] = [...was.nodes.flatMap(drawnRects), ...was.groups];
  const wasLeft = Math.max(0, Math.min(...wasBoxes.map((r) => r.x)));
  const wasTop = Math.max(0, Math.min(...wasBoxes.map((r) => r.y)));
  const left = Math.min(...boxRects.map((r) => r.x)) - wasLeft;
  const top = Math.min(...boxRects.map((r) => r.y)) - wasTop;
  const wasRight = Math.max(0, ...was.nodes.map((n) => n.x + n.width), ...was.groups.map((g) => g.x + g.width));
  const wasBottom = Math.max(0, ...was.nodes.map((n) => n.y + n.height), ...was.groups.map((g) => g.y + g.height));
  const marginX = Math.max(0, was.width - wasRight);
  const marginY = Math.max(0, was.height - wasBottom);
  const move = <T extends { x: number; y: number }>(item: T): T => ({ ...item, x: item.x - left, y: item.y - top });
  const placedNodes = nodes.map((n) => ({ ...move(n), ...(n.note === undefined ? {} : { note: move(n.note) }) }));
  const placedGroups = groups.map((g) => ({
    ...move(g),
    ...(g.caption === undefined ? {} : { caption: move(g.caption) }),
  }));
  const placedEdges = edges.map((e) => ({
    ...e,
    points: e.points.map(move),
    labelAnchor: e.labelAnchor === undefined ? undefined : move(e.labelAnchor),
  }));
  const right = Math.max(...rects.map((r) => r.x + r.width - left), ...points.map((p) => p.x - left)) + marginX;
  const bottom = Math.max(...rects.map((r) => r.y + r.height - top), ...points.map((p) => p.y - top)) + marginY;
  return {
    ...before.layout,
    nodes: placedNodes,
    edges: placedEdges,
    groups: placedGroups,
    width: right,
    height: bottom,
  };
}

type PlateRepair = {
  /** Boxes, "−"s and captions. */
  readonly obstacles: OrthoRequest["obstacles"];
  readonly frames: OrthoRequest["frames"];
  readonly connectionOf: (edge: LayoutEdge) => OrthoRequest["connections"][number];
  readonly route: (request: OrthoRequest) => Map<string, LayoutPoint[]>;
  readonly direction: GraphDirection | undefined;
  readonly rerouteable: (edge: LayoutEdge) => boolean;
  readonly clearOfReserved: (points: readonly LayoutPoint[]) => boolean;
  readonly profile?: NestProfile;
};

/**
 * No wire runs under another wire's plate (Pageturner containers opened: api to payments ran under
 * the right edge of api to db's "Reads and writes [SQL]"). Plates are placed after the wires, so the
 * few found over another wire are first slid along their own wire to a stretch clear of every other
 * wire; a wire still under a plate that could not move is routed again round every plate (one pass,
 * like the "−" repair), and its own plate placed again on its new route. Only those few searches
 * are added: plates as obstacles in every search would route every wire twice. Edits `edges` and
 * `taken` (the plates' places) in place.
 */
function clearPlates(edges: LayoutEdge[], taken: Rect[], repair: PlateRepair): void {
  const plateOf = (edge: LayoutEdge) =>
    edge.labelAnchor === undefined ? undefined : grown(edge.labelAnchor, PLATE_CLEAR);
  const boundsOf = (points: readonly LayoutPoint[]): Rect => {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  };
  // Grown by a hair: a straight wire's bounds have no width, and `intersects` is strict.
  const bounds = edges.map((edge) => grown(boundsOf(edge.points), 1));
  const underOther = (
    index: number,
    points: readonly LayoutPoint[] = edges[index]!.points,
    box = bounds[index]!,
  ): number[] => {
    const out: number[] = [];
    for (let k = 0; k < edges.length; k++) {
      const plate = k === index ? undefined : plateOf(edges[k]!);
      if (plate !== undefined && intersects(box, plate) && routeCrosses(points, plate, 0)) out.push(k);
    }
    return out;
  };
  count(repair.profile, "checks.plates", edges.length);
  const pairs: [wire: number, plate: number][] = edges.flatMap((_, index) =>
    underOther(index).map((k) => [index, k] as [number, number]),
  );
  if (pairs.length === 0) return;
  /** A clear place for plate `index` on its own wire (off every box, plate and other wire), or undefined. */
  const placeClear = (index: number): Rect | undefined => {
    const edge = edges[index]!;
    const anchor = edge.labelAnchor!;
    // Only what a plate anywhere on this wire could touch.
    const reach = grown(bounds[index]!, Math.max(anchor.width, anchor.height) + PLATE_CLEAR);
    const walls = [
      ...taken.filter((r) => r !== anchor && intersects(r, reach)),
      ...edges.flatMap((other, k) =>
        k === index || !intersects(bounds[k]!, reach)
          ? []
          : segmentRects(other.points, PLATE_CLEAR).filter((r) => intersects(r, reach)),
      ),
    ];
    return clearPlaceOnRoute(edge.points, anchor, walls);
  };
  const replace = (index: number, anchor: Rect): void => {
    const old = edges[index]!.labelAnchor!;
    const at = taken.indexOf(old);
    if (at >= 0) taken.splice(at, 1, anchor);
    else taken.push(anchor);
    edges[index] = { ...edges[index]!, labelAnchor: anchor };
  };
  // The plates first: sliding one along its own wire moves nothing else.
  const stuck = new Set<number>();
  for (const plate of new Set(pairs.map(([, k]) => k))) {
    const moved = placeClear(plate);
    if (moved !== undefined) {
      replace(plate, moved);
      count(repair.profile, "plates.moved");
    } else stuck.add(plate);
  }
  // A trunk's or a bundle's "N connections" plate with no clear place is left off, as at placement: the line's
  // weight still says it is a bundle, and its members are listed on hover or tap.
  for (const plate of [...stuck]) {
    const id = edges[plate]!.id;
    if (!id.startsWith("trunk:") && !id.startsWith("bundle:")) continue;
    const old = edges[plate]!.labelAnchor;
    const at = old === undefined ? -1 : taken.indexOf(old);
    if (at >= 0) taken.splice(at, 1);
    edges[plate] = { ...edges[plate]!, labelAnchor: undefined };
    stuck.delete(plate);
    count(repair.profile, "plates.dropped");
  }
  // The wire under a stuck plate is routed again; where that wire may not be (a trunk), the plate's own wire is, so
  // its plate is placed again on a new route.
  const wires = [
    ...new Set(
      pairs
        .filter(([, k]) => stuck.has(k))
        .flatMap(([w, k]) =>
          repair.rerouteable(edges[w]!)
            ? underOther(w).length > 0
              ? [w]
              : []
            : repair.rerouteable(edges[k]!)
              ? [k]
              : [],
        ),
    ),
  ];
  if (wires.length === 0) return;
  const ids = new Set(wires.map((w) => edges[w]!.id));
  const fixed = edges.filter((edge) => !ids.has(edge.id)).map((edge) => edge.points);
  // One search for them all, round every other wire's plate near them (their own plates are placed
  // again on their new routes): plates far off only add grid lines, and a route that strays onto
  // one is refused below.
  const near = wires.map((w) => grown(bounds[w]!, 200));
  const plates = edges.flatMap((other) => {
    const plate = plateOf(other);
    return ids.has(other.id) || plate === undefined || !near.some((r) => intersects(plate, r))
      ? []
      : [{ id: `${other.id}__plate`, rect: plate }];
  });
  const request = {
    obstacles: [...repair.obstacles, ...plates],
    frames: repair.frames,
    fixed,
    direction: repair.direction,
    options: REPAIR_OPTIONS,
  };
  const again = repair.route({ ...request, connections: wires.map((w) => repair.connectionOf(edges[w]!)) });
  const left = wires.filter((w) => !again.has(edges[w]!.id));
  if (left.length > 0)
    for (const [id, points] of repair.route({
      ...request,
      connections: left.map((w) => ({ id: edges[w]!.id, source: edges[w]!.source, target: edges[w]!.target })),
    }))
      again.set(id, points);
  const moved: number[] = [];
  const accept = (routed: ReadonlyMap<string, LayoutPoint[]>, candidates: readonly number[]): number[] => {
    const refused: number[] = [];
    for (const w of candidates) {
      const points = routed.get(edges[w]!.id);
      if (
        points === undefined ||
        !repair.clearOfReserved(points) ||
        underOther(w, points, grown(boundsOf(points), 1)).length > 0
      ) {
        refused.push(w);
        continue;
      }
      count(repair.profile, "plates.rerouted");
      edges[w] = { ...edges[w]!, points };
      bounds[w] = grown(boundsOf(points), 1);
      moved.push(w);
    }
    return refused;
  };
  const strayed = accept(again, wires).filter((w) => again.has(edges[w]!.id));
  // A route that strayed past the plates near its old one, onto one further off (application-components,
  // compiler open, +doors: m_app's way round core's "2 connections" ran under shell's plate): once more, round
  // every plate. Only these few wires pay for the larger grid.
  if (strayed.length > 0) {
    const others = strayed.map((w) => edges[w]!.id);
    const every = edges.flatMap((other) => {
      const plate = plateOf(other);
      return others.includes(other.id) || plate === undefined ? [] : [{ id: `${other.id}__plate`, rect: plate }];
    });
    count(repair.profile, "plates.wide");
    accept(
      repair.route({
        ...request,
        obstacles: [...repair.obstacles, ...every],
        fixed: edges.filter((edge) => !others.includes(edge.id)).map((edge) => edge.points),
        connections: strayed.map((w) => repair.connectionOf(edges[w]!)),
      }),
      strayed,
    );
  }
  for (const w of moved) {
    const anchor = edges[w]!.labelAnchor;
    if (anchor !== undefined)
      replace(
        w,
        placeClear(w) ??
          labelOnRoute(
            edges[w]!.points,
            anchor,
            taken.filter((r) => r !== anchor),
          ),
      );
  }
}

/** A trunk of the box being opened: the closed box it goes to and its members. */
type ExitGroup = {
  readonly members: readonly { readonly edge: ProjectedView["edges"][number]; readonly inside: string }[];
};
/** A trunk whose exit and fans the inside's layout drew: the exit on the frame's edge, each member's fan from its box to it. */
type Preset = { readonly exit: LayoutPoint; readonly fans: ReadonlyMap<string, LayoutPoint[]> };

/** The trunks the box being opened will have: wires from its children to one closed box outside, two or more. */
function exitPlan(after: ProjectedView, childIds: ReadonlySet<string>): Map<string, ExitGroup> {
  const closed = new Set(after.nodes.filter((n) => n.folded !== undefined).map((n) => n.id));
  const groups = new Map<string, { members: { edge: ProjectedView["edges"][number]; inside: string }[] }>();
  for (const edge of after.edges) {
    if (edge.figure?.type === "ports") continue; // declared sides: kept single
    for (const [inside, box] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ] as const) {
      if (!childIds.has(inside) || !closed.has(box) || childIds.has(box)) continue;
      const entry = groups.get(box) ?? { members: [] };
      entry.members.push({ edge, inside });
      groups.set(box, entry);
      break;
    }
  }
  return new Map([...groups].filter(([, g]) => g.members.length >= 2));
}

type Trunk = {
  readonly id: string;
  /** The open frame (drawn id) the members leave. */
  readonly frame: string;
  /** The closed box (drawn id) they all go to. */
  readonly target: string;
  readonly members: readonly { readonly edge: ProjectedView["edges"][number]; readonly inside: string }[];
  readonly dotted: boolean;
};

/**
 * The trunks of a nested view: wires from inside an open frame to a closed box outside it,
 * grouped by (outermost open frame around the inside end that does not hold the box, box). Only
 * groups of two or more become a trunk.
 */
function trunksOf(
  after: ProjectedView,
  nodes: readonly LayoutNode[],
  groupsById: ReadonlyMap<string, LayoutGroup>,
  inner: ReadonlyMap<string, LayoutEdge>,
): Trunk[] {
  const drawn = (g: string) => (groupsById.get(g)!.element === true ? g : `group:${g}`);
  const closed = new Set(after.nodes.filter((n) => n.folded !== undefined).map((n) => n.id));
  const nodeGroup = new Map(nodes.map((n) => [n.id, n.groupId]));
  const chain = (id: string) => ancestorsOf(groupsById, nodeGroup.get(id));
  const groupsOfTrunk = new Map<
    string,
    { frame: string; target: string; members: { edge: ProjectedView["edges"][number]; inside: string }[] }
  >();
  for (const edge of after.edges) {
    // An architecture edge's declared sides cannot be kept in a bundle: it stays single.
    if (inner.has(edge.id) || edge.source === edge.target || edge.figure?.type === "ports") continue;
    for (const [inside, box] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ] as const) {
      if (!closed.has(box) || !nodeGroup.has(inside)) continue;
      const aroundBox = new Set(chain(box));
      const around = chain(inside).filter((g) => !aroundBox.has(g));
      if (around.length === 0) continue;
      // The innermost open frame around the inside end that does not hold the box: fans stay local.
      const frame = drawn(around[0]!);
      const key = `trunk:${frame}~${box}`;
      const entry = groupsOfTrunk.get(key) ?? { frame, target: box, members: [] };
      entry.members.push({ edge, inside });
      groupsOfTrunk.set(key, entry);
      break;
    }
  }
  return [...groupsOfTrunk]
    .filter(([, t]) => t.members.length >= 2)
    .map(([id, t]) => ({ id, ...t, dotted: t.members.every((m) => m.edge.line === "dotted") }));
}

/** A frame's four edges as thin strips, for keeping label plates off them. */
export function frameEdges(r: Rect): Rect[] {
  const t = 1.5;
  return [
    { x: r.x, y: r.y - t, width: r.width, height: 2 * t },
    { x: r.x, y: r.y + r.height - t, width: r.width, height: 2 * t },
    { x: r.x - t, y: r.y, width: 2 * t, height: r.height },
    { x: r.x + r.width - t, y: r.y, width: 2 * t, height: r.height },
  ];
}

/** Whether a polyline runs along one of a rect's edges (within `tolerance`, for more than 10 px). */
function runsAlong(points: readonly LayoutPoint[], r: Rect, tolerance = 4): boolean {
  const overlap = (lo: number, hi: number, a: number, b: number) =>
    Math.min(hi, Math.max(a, b)) - Math.max(lo, Math.min(a, b));
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1]!;
    const b = points[k]!;
    if (
      Math.abs(a.y - b.y) < 0.01 &&
      (Math.abs(a.y - r.y) < tolerance || Math.abs(a.y - r.y - r.height) < tolerance) &&
      overlap(r.x, r.x + r.width, a.x, b.x) > 10
    )
      return true;
    if (
      Math.abs(a.x - b.x) < 0.01 &&
      (Math.abs(a.x - r.x) < tolerance || Math.abs(a.x - r.x - r.width) < tolerance) &&
      overlap(r.y, r.y + r.height, a.y, b.y) > 10
    )
      return true;
  }
  return false;
}

/** How many times a polyline passes through a rect's boundary (orthogonal segments; touching does not count). */
export function crossingsOfFrame(points: readonly LayoutPoint[], r: Rect): number {
  const inside = (p: LayoutPoint) =>
    p.x > r.x + 0.5 && p.x < r.x + r.width - 0.5 && p.y > r.y + 0.5 && p.y < r.y + r.height - 0.5;
  let count = 0;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1]!;
    const b = points[k]!;
    if (inside(a) !== inside(b)) count++;
    else if (!inside(a) && !inside(b) && routeCrosses([a, b], r, 0.5)) count += 2;
  }
  return count;
}

/**
 * The layout of `after` (the nested view with `closing` closed), compacted from `open` (where it
 * was an open frame). Throws when `open` has no frame for it.
 */
export async function closeInPlace(
  drawn: Laid,
  after: ProjectedView,
  closing: string,
  deps: GrowV2Dependencies,
): Promise<LayoutResult> {
  // Closed from the routes as they were before simplifying, as a grow is (`growPlan`).
  const open: Laid = { ...drawn, layout: unsimplified(drawn.layout) };
  const route = profiledRoute(deps);
  const profile = deps.profile;
  const frame = open.layout.groups.find((g) => g.id === closing);
  if (frame === undefined) throw new Error(`no open frame '${closing}' in the layout to close`);
  const projectedBox = after.nodes.find((node) => node.folded?.groupId === closing);
  if (projectedBox === undefined) throw new Error(`'${closing}' is not closed in the view to close into`);
  const boxId = projectedBox.id;
  const direction = open.layout.direction ?? after.direction;
  // The closed box's size, as the pipeline sizes it.
  const sized = await spanAsync(profile, "inner", () =>
    deps.layout({ ...after, nodes: [{ ...projectedBox, groupId: undefined }], edges: [], groups: [] }),
  );
  const sizedBox = sized.nodes.find((n) => n.id === boxId);
  if (sizedBox === undefined) throw new Error(`the pipeline drew no box for '${boxId}'`);
  const boxSize = { width: sizedBox.width, height: sizedBox.height };

  const groupsById = new Map(open.layout.groups.map((g) => [g.id, g]));
  const gone = new Set(
    open.layout.groups.filter((g) => ancestorsOf(groupsById, g.id).includes(closing)).map((g) => g.id),
  );
  const keptNodes = open.layout.nodes.filter((n) => n.groupId === undefined || !gone.has(n.groupId));
  const keptGroups = open.layout.groups.filter((g) => !gone.has(g.id));
  const ancestors = new Set(ancestorsOf(groupsById, frame.parentId));
  const flow = flowAxis(direction);
  const reversed = flowReversed(direction);

  /** Rects that must stay apart: kept boxes and notes, frames that are not around the frame closing. */
  const items: Item[] = [
    ...keptNodes.flatMap((n) =>
      drawnRects(n).map((rect, k) => ({ id: k === 0 ? n.id : `${n.id}__note`, rect, kind: "node" as const })),
    ),
    ...keptGroups
      .filter((g) => !ancestors.has(g.id))
      .map((g) => ({ id: g.id, rect: g as Rect, kind: "frame" as const })),
  ];
  const nodeGroup = new Map(keptNodes.map((n) => [n.id, n.groupId]));
  const contains = (frameId: string, item: Item): boolean => {
    if (item.kind === "node")
      return ancestorsOf(groupsById, nodeGroup.get(item.id.replace(/__note$/, ""))).includes(frameId);
    return ancestorsOf(groupsById, groupsById.get(item.id)?.parentId).includes(frameId);
  };
  // What the opens being undone pushed (this box's and every box open inside it), when recorded.
  const known = growthRecords(open.layout);
  const undone = [...known].filter(([id]) => id === closing || gone.has(id)).map(([, r]) => r);
  const own = known.get(closing);
  // A recorded close gives back only what was taken, so it only has to keep boxes apart.
  const floor = own === undefined ? CLOSE_GAP : 12;
  // A labelled wire between two items (or their contents) needs room for its plate between them.
  const keptGroupOf = new Map(keptNodes.map((n) => [n.id, n.groupId]));
  const holders = (id: string): Set<string> =>
    new Set([
      id,
      ...ancestorsOf(groupsById, keptGroupOf.get(id) ?? groupsById.get(id.replace(/^group:/, ""))?.parentId),
    ]);
  const labelled = after.edges.flatMap((edge) => {
    const text = edge.caption ?? edge.label;
    if (!text) return [];
    const plate = edgeLabelBox(text, open.layout.typeface);
    return [{ a: holders(edge.source), z: holders(edge.target), need: { x: plate.width + 24, y: plate.height + 24 } }];
  });
  /** Room for the plates of labelled wires between two items, along the axis they are apart on. */
  const labelGap = (a: Item, z: Item): number => {
    const gx = Math.max(z.rect.x - a.rect.x - a.rect.width, a.rect.x - z.rect.x - z.rect.width);
    const gy = Math.max(z.rect.y - a.rect.y - a.rect.height, a.rect.y - z.rect.y - z.rect.height);
    const axis = gx >= gy ? "x" : "y";
    let need = 0;
    for (const l of labelled)
      if ((l.a.has(a.id) && l.z.has(z.id)) || (l.a.has(z.id) && l.z.has(a.id))) need = Math.max(need, l.need[axis]);
    return need;
  };
  /** The closed box, as an item, for the label room between it and its neighbours. */
  const boxItem: Item = { id: boxId, rect: frame, kind: "node" };
  const pairs: [Item, Item, number][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const z = items[j]!;
      if (a.kind === "frame" && contains(a.id, z)) continue;
      if (z.kind === "frame" && contains(z.id, a)) continue;
      if (a.id === `${z.id}__note` || z.id === `${a.id}__note`) continue;
      const apart = separation(a.rect, z.rect);
      pairs.push([a, z, Math.min(Math.max(floor, labelGap(a, z)), apart)]);
    }
  }
  const cap = (axis: "x" | "y", side: "lo" | "hi") =>
    own === undefined ? Infinity : undone.reduce((sum, r) => sum + r[axis][side], 0);
  // Every kept box and frame stays inside its kept parent frame, by at least as much as it was
  // (up to 8 px): a box in the compressed band keeps its size while its frame shrinks.
  const nesting: [Item, LayoutGroup, number][] = [];
  for (const item of items) {
    const parentId =
      item.kind === "node" ? nodeGroup.get(item.id.replace(/__note$/, "")) : groupsById.get(item.id)?.parentId;
    const parent = parentId === undefined ? undefined : groupsById.get(parentId);
    if (parent === undefined || gone.has(parent.id)) continue;
    const r = item.rect;
    const inset = Math.min(
      r.x - parent.x,
      r.y - parent.y,
      parent.x + parent.width - r.x - r.width,
      parent.y + parent.height - r.y - r.height,
    );
    nesting.push([item, parent, Math.min(8, inset)]);
  }
  const place = (maps: Maps): Rect => {
    // The box sits in the image of the frame: where it was when the open is recorded, otherwise at
    // the image's upstream end along the flow and centred across.
    const x0 = mapAxis(maps.x, frame.x);
    const x1 = mapAxis(maps.x, frame.x + frame.width);
    const y0 = mapAxis(maps.y, frame.y);
    const y1 = mapAxis(maps.y, frame.y + frame.height);
    const along = (lo: number, hi: number, size: number, isFlow: boolean, axis: "x" | "y") => {
      if (own !== undefined) return Math.min(Math.max(lo, lo + own[axis].offset), hi - size);
      return isFlow ? (reversed ? hi - size : lo) : (lo + hi) / 2 - size / 2;
    };
    return {
      x: along(x0, x1, boxSize.width, flow === "x", "x"),
      y: along(y0, y1, boxSize.height, flow === "y", "y"),
      width: boxSize.width,
      height: boxSize.height,
    };
  };
  const at = (item: Item, maps: Maps) => (item.kind === "node" ? moveBox(item.rect, maps) : moveFrame(item.rect, maps));
  const feasible = (maps: Maps, axis: "x" | "y"): boolean => {
    count(profile, "compaction.tests");
    const m = maps[axis];
    const changed = (r: Rect) => {
      const lo = axis === "x" ? r.x : r.y;
      const hi = lo + (axis === "x" ? r.width : r.height);
      return hi > m.a0 && lo < m.a1;
    };
    const side = (r: Rect) => {
      const c = axis === "x" ? r.x + r.width / 2 : r.y + r.height / 2;
      return c <= m.a0 ? -1 : c >= m.a1 ? 1 : 0;
    };
    for (const [child, parent, inset] of nesting) {
      const c = at(child, maps);
      const p = moveFrame(parent, maps);
      const least = Math.min(c.x - p.x, c.y - p.y, p.x + p.width - c.x - c.width, p.y + p.height - c.y - c.height);
      if (least < inset - 0.5) return false;
    }
    for (const [a, z, gap] of pairs) {
      // Two rects on the same side of the frame move together.
      const sa = side(a.rect);
      if (sa !== 0 && sa === side(z.rect) && !changed(a.rect) && !changed(z.rect)) continue;
      const p = at(a, maps);
      const q = at(z, maps);
      // A pair may come no closer than the gap (or than it already was), and never overlap.
      if (separation(p, q) < gap - 0.5 || overlapsStrictly(p, q)) return false;
    }
    const placed = place(maps);
    for (const item of items) {
      const r = at(item, maps);
      if (item.kind === "frame" && contains(item.id, { id: boxId, rect: placed, kind: "node" })) continue;
      const before = Math.min(Math.max(floor, labelGap(item, boxItem)), separation(item.rect, frame));
      if (separation(r, placed) < before - 0.5) return false;
    }
    return true;
  };
  const freedOf = (axis: "x" | "y") => (axis === "x" ? frame.width - boxSize.width : frame.height - boxSize.height);
  /** The largest c in [0, max] with test(c), by bisection (test(0) is assumed). */
  const largest = (max: number, test: (c: number) => boolean): number => {
    if (max <= 0.5) return 0;
    if (test(max)) return max;
    let lo = 0;
    let hi = max;
    for (let k = 0; k < 8; k++) {
      const mid = (lo + hi) / 2;
      if (test(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  // With this open's record alone, the map is its exact inverse: the band compressed is the old
  // box's image, not the whole frame, so boxes beside the band come back exactly too.
  const band = (axis: "x" | "y"): AxisMap => {
    const lo = axis === "x" ? frame.x : frame.y;
    const size = axis === "x" ? frame.width : frame.height;
    const boxLength = axis === "x" ? boxSize.width : boxSize.height;
    // Exact only when this open is the latest one still recorded: the maps of opens and closes do
    // not commute, so after a later open was closed out of order the band no longer lines up.
    const latest = own !== undefined && [...known.values()].every((r) => r.sequence <= own.sequence);
    if (own !== undefined && undone.length === 1 && latest) {
      const a0 = lo + own[axis].offset;
      const a1 = a0 + boxLength + own[axis].lo + own[axis].hi;
      if (a0 >= lo - 0.5 && a1 <= lo + size + 0.5 && a1 - a0 > own[axis].lo + own[axis].hi)
        return { ...IDENTITY, a0, a1 };
    }
    return { ...IDENTITY, a0: lo, a1: lo + size };
  };
  let maps: Maps = { x: band("x"), y: band("y") };
  const compactionStart = performance.now();
  for (const axis of ["x", "y"] as const) {
    const freed = freedOf(axis);
    const base = maps[axis];
    const capLo = cap(axis, "lo");
    const capHi = cap(axis, "hi");
    // Never more than the recorded opens pushed on that side.
    const withAxis = (cLo: number, cHi: number): Maps => ({
      ...maps,
      [axis]: { ...base, dLo: -Math.min(cLo, capLo), dHi: -Math.min(cHi, capHi) },
    });
    let cLo = 0;
    let cHi = 0;
    const room = () => freed - cLo - cHi;
    if (axis === flow) {
      // Downstream comes back first; upstream only with what is left.
      if (reversed) {
        cLo = largest(Math.min(freed, capLo), (c) => feasible(withAxis(c, 0), axis));
        cHi = largest(Math.min(room(), capHi), (c) => feasible(withAxis(cLo, c), axis));
      } else {
        cHi = largest(Math.min(freed, capHi), (c) => feasible(withAxis(0, c), axis));
        cLo = largest(Math.min(room(), capLo), (c) => feasible(withAxis(c, cHi), axis));
      }
    } else {
      const half = Math.min(freed / 2, capLo, capHi);
      const both = largest(2 * half, (c) => feasible(withAxis(c / 2, c / 2), axis));
      cLo = both / 2;
      cHi = both / 2;
      cHi += largest(Math.min(room(), capHi - cHi), (c) => feasible(withAxis(cLo, cHi + c), axis));
      cLo += largest(Math.min(room(), capLo - cLo), (c) => feasible(withAxis(cLo + c, cHi), axis));
    }
    maps = withAxis(cLo, cHi);
  }
  const left = new Map([...known].filter(([id]) => id !== closing && !gone.has(id)));
  if (profile !== undefined)
    profile.spans.compaction = (profile.spans.compaction ?? 0) + performance.now() - compactionStart;
  const placed = place(maps);
  const nodes: LayoutNode[] = keptNodes.map((n) => moveNode(n, maps));
  nodes.push({ ...sizedBox, x: placed.x, y: placed.y, groupId: projectedBox.groupId });
  const groups = keptGroups.filter((g) => g.id !== closing).map((g) => moveGroup(g, maps));
  const beforeRects = new Map<string, Rect>([
    ...open.layout.nodes.map((n) => [n.id, n as Rect] as const),
    ...open.layout.groups.map((g) => [drawnGroupId(open.view, g.id), g as Rect] as const),
  ]);
  const finished = finish(
    open,
    after,
    nodes,
    groups,
    new Map(),
    beforeRects,
    maps,
    route,
    direction,
    open.layout.typeface,
    profile,
    deps.bundle === true,
  );
  const aired = withCaptionAir(finished, captionEnds(after));
  const result = simplifyRoutes(aired, { walls: aired.groups.map(frameToggleRect) });
  records.set(result, left);
  records.set(aired, left);
  records.set(finished, left);
  return result;
}

/**
 * Each frame's caption slid along its band to a place with air round it (`CAPTION_AIR_PX`), as the whole drawing
 * places it (`elk-layout.ts`). Here a caption is placed before the wires are routed, and the router keeps wires only
 * just off it, so one could end a few units from a line: at a fit zoom, touching it (rendered review, 2026-11-13). A
 * caption that already has its air stays put, so a press does not move it; one with no such place keeps its own.
 */
function withCaptionAir(layout: LayoutResult, ends: ReadonlyMap<string, CaptionEnd>): LayoutResult {
  const around = [
    ...edgeObstacles(layout.edges),
    ...layout.nodes.flatMap((node) => (node.note === undefined ? [node as Rect] : [node as Rect, node.note as Rect])),
  ];
  let moved = false;
  const groups = layout.groups.map((group) => {
    const caption = group.caption;
    if (caption === undefined) return group;
    const obstacles = [...around, frameToggleRect(group)];
    if (!obstacles.some((box) => intersects(box, caption))) return group;
    const size = { width: caption.width, height: caption.height };
    const place = findCaptionPlace(group, size, obstacles, ends.get(group.id) ?? "start");
    if (place === null) return group;
    moved = true;
    return { ...group, caption: place };
  });
  return moved ? { ...layout, groups } : layout;
}

/**
 * A last resort when the router has no route: an orthogonal elbow from side to side (it may pass
 * a box; the router found no clear way).
 */
function elbow(a: Rect | undefined, b: Rect | undefined): LayoutPoint[] {
  if (a === undefined || b === undefined) return [];
  const ca = centreOf(a);
  const cb = centreOf(b);
  if (cb.x > a.x + a.width || cb.x < a.x) {
    const start = { x: cb.x > ca.x ? a.x + a.width : a.x, y: ca.y };
    if (ca.y >= b.y && ca.y <= b.y + b.height) return [start, { x: cb.x > ca.x ? b.x : b.x + b.width, y: ca.y }];
    return [start, { x: cb.x, y: ca.y }, { x: cb.x, y: cb.y > ca.y ? b.y : b.y + b.height }];
  }
  const start = { x: ca.x, y: cb.y > ca.y ? a.y + a.height : a.y };
  if (ca.x >= b.x && ca.x <= b.x + b.width) return [start, { x: ca.x, y: cb.y > ca.y ? b.y : b.y + b.height }];
  return [start, { x: ca.x, y: cb.y }, { x: cb.x > ca.x ? b.x : b.x + b.width, y: cb.y }];
}
