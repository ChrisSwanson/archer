/**
 * Fewer needless corners (redesign slice 6; review C.8; owner, 2026-11-12: "the lines when this gets fully expanded
 * seem to have a lot of corners"). A wire is offered the simplest shape its two ends allow, where that shape is
 * clear, after whatever routed it -- ELK for a whole drawing, the nested view's own router for a frame opened in
 * place -- so both take the same care:
 *
 *   - ends that face each other across an overlap: one straight run (0 corners);
 *   - ends on perpendicular sides: an L (1 corner);
 *   - ends facing the same way without an overlap, or opposite ways: a Z or a U (2 corners).
 *
 * The goal is the drawing's total (owner, 2026-11-12), so a shape is taken only when it has fewer corners than the
 * wire has now, and only where nothing else is disturbed: each end stays on its own side of its box (an end may
 * slide along that side, `END_MARGIN_PX` clear of its corners, `PORT_GAP_PX` from other wires' ends), no run
 * enters another box, a wall (a frame's caption, a "−"), another caption or a frame that holds neither end, no
 * run lies along a frame's edge or another wire, the wire crosses no more wires than it did, an arrowhead keeps
 * its straight approach, and the wire's caption finds a clear place on the new line with line showing either side
 * (ADR 0030). ELK's own options could not do this: every alignment or placement setting tried added corners
 * elsewhere on the owner's drawings (measured 2026-11-12).
 *
 * Deterministic: wires are taken in id order, each seeing the ones already simplified.
 */
import { arrowsOf } from "../diagrams/figures";
import { ARROW_APPROACH_PX } from "../diagrams/rounded-route";
import type { LayoutEdge, LayoutNode, LayoutPoint, LayoutResult } from "./elk-layout";
import { CAPTION_AIR_PX } from "./captions";
import { meetOutline, outlineOf } from "./graph-metrics";

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
type Dir = { readonly x: number; readonly y: number };

/** How far inside a box's side a moved end stays: clear of the box's rounded corner. */
const END_MARGIN_PX = 16;
/** The room kept between a moved end and another wire's end on the same side of a box. */
const PORT_GAP_PX = 16;
/** How far inside a box's side a carried-on end may land on a curved or slanted outline. */
const OUTLINE_REACH_PX = 16;
/** Half the width a run is treated as having against boxes, walls and captions. */
const RUN_CLEARANCE_PX = 4;
/** Closer than this, two parallel runs read as one line; a run this near a frame's edge runs along it. */
const PARALLEL_PX = 6;
/** The least run a wire leaves its box with, or reaches a corner after. */
const LEAST_RUN_PX = 12;
/** Line kept showing either side of a caption, along the wire (ADR 0030; `EDGE_LABEL_LEAD_PX`). */
const CAPTION_LEAD_PX = 16;
/** How finely an end slides, or a jog moves, between tries. */
const STEP_PX = 4;
/** The fewest wires leaving one side of a box that are drawn as a tree (`trunkFanOuts`). */
const FAN_OUT_LEAST = 3;
/** The side of a cell of the grid that finds what lies near a run (`Grid`), at the least. */
const CELL_PX = 64;
/** The most cells a grid keeps; a larger drawing takes larger cells. */
const MOST_CELLS = 1 << 16;

/**
 * What lies near a place, without reading the whole drawing: items filed in the cells of a uniform grid over the
 * drawing that their boxes touch. `some` offers every item whose box may meet the one asked about -- each once, and
 * possibly a few that do not, so the caller still makes its own exact test -- so a clear-path check costs what is
 * near the run, not every box and every wire's every run (it runs for every candidate shape of every wire). A box
 * beyond the grid's extent is filed in, and asked of, the cells at its border: the same clamp on both sides keeps
 * every pair that meets in a shared cell, so the extent bears only on speed.
 */
class Grid<T extends { mark: number }> {
  private readonly cells: (T[] | undefined)[];
  private readonly placed = new Map<T, readonly [number, number, number, number]>();
  private readonly cell: number;
  private readonly cols: number;
  private readonly rows: number;
  private visit = 0;

  constructor(private readonly extent: Box) {
    let cell = CELL_PX;
    while (Math.ceil(extent.width / cell + 1) * Math.ceil(extent.height / cell + 1) > MOST_CELLS) cell *= 2;
    this.cell = cell;
    this.cols = Math.ceil(extent.width / cell) + 1;
    this.rows = Math.ceil(extent.height / cell) + 1;
    this.cells = new Array(this.cols * this.rows);
  }

  private at(v: number, origin: number, count: number): number {
    const c = Math.floor((v - origin) / this.cell);
    // NaN files at the first cell: an item or question that cannot be placed meets everything there, and only there.
    return c >= 0 ? (c < count ? c : count - 1) : 0;
  }

  private span(box: Box): readonly [number, number, number, number] {
    const { x, y } = this.extent;
    return [
      this.at(Math.min(box.x, box.x + box.width), x, this.cols),
      this.at(Math.max(box.x, box.x + box.width), x, this.cols),
      this.at(Math.min(box.y, box.y + box.height), y, this.rows),
      this.at(Math.max(box.y, box.y + box.height), y, this.rows),
    ];
  }

  add(item: T, box: Box): void {
    const span = this.span(box);
    for (let cy = span[2]; cy <= span[3]; cy += 1)
      for (let cx = span[0]; cx <= span[1]; cx += 1) {
        const k = cy * this.cols + cx;
        const cell = this.cells[k];
        if (cell === undefined) this.cells[k] = [item];
        else cell.push(item);
      }
    this.placed.set(item, span);
  }

  remove(item: T): void {
    const span = this.placed.get(item);
    if (span === undefined) return;
    this.placed.delete(item);
    for (let cy = span[2]; cy <= span[3]; cy += 1)
      for (let cx = span[0]; cx <= span[1]; cx += 1) {
        const cell = this.cells[cy * this.cols + cx]!;
        cell.splice(cell.indexOf(item), 1);
      }
  }

  /** Whether `test` holds for an item whose box may meet `box`: each such item offered once, until one does. */
  some(box: Box, test: (item: T) => boolean): boolean {
    this.visit += 1;
    const visit = this.visit;
    const span = this.span(box);
    for (let cy = span[2]; cy <= span[3]; cy += 1)
      for (let cx = span[0]; cx <= span[1]; cx += 1) {
        const cell = this.cells[cy * this.cols + cx];
        if (cell === undefined) continue;
        for (const item of cell) {
          if (item.mark === visit) continue;
          item.mark = visit;
          if (test(item)) return true;
        }
      }
    return false;
  }
}

/** Everything a layout draws, as one box: the grid's extent. Speed only; nothing drawn depends on it. */
function extentOf(layout: LayoutResult, walls: readonly Box[]): Box {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  const take = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  };
  for (const box of [...layout.nodes, ...layout.groups, ...walls]) {
    take(box.x, box.y);
    take(box.x + box.width, box.y + box.height);
  }
  for (const edge of layout.edges) for (const p of edge.points) take(p.x, p.y);
  if (x0 > x1 || y0 > y1) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** A run of a wire's drawn route, filed by its wire. */
type Segment = { readonly wire: number; readonly c: LayoutPoint; readonly d: LayoutPoint; mark: number };
/** A wire's caption plate, filed by its wire. */
type Plate = { readonly wire: number; readonly box: Box; mark: number };
/** A node's box. */
type Placed = { readonly id: string; readonly box: Box; mark: number };

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const grown = (r: Box, by: number): Box => ({
  x: r.x - by,
  y: r.y - by,
  width: r.width + 2 * by,
  height: r.height + 2 * by,
});
const runBox = (a: LayoutPoint, b: LayoutPoint, by: number): Box =>
  grown({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }, by);
const dirOf = (a: LayoutPoint, b: LayoutPoint): Dir => ({ x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) });
const len = (a: LayoutPoint, b: LayoutPoint): number => Math.hypot(b.x - a.x, b.y - a.y);

/** The route without repeated points or points in the middle of a straight run. */
export function cornersOf(points: readonly LayoutPoint[]): LayoutPoint[] {
  const kept: LayoutPoint[] = [];
  for (const point of points) {
    const last = kept[kept.length - 1];
    if (last !== undefined && Math.abs(last.x - point.x) < 1e-6 && Math.abs(last.y - point.y) < 1e-6) continue;
    while (kept.length >= 2) {
      const a = kept[kept.length - 2]!;
      const b = kept[kept.length - 1]!;
      const cross = (b.x - a.x) * (point.y - b.y) - (b.y - a.y) * (point.x - b.x);
      const dot = (b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y);
      if (Math.abs(cross) < 1e-6 && dot >= 0) kept.pop();
      else break;
    }
    kept.push(point);
  }
  return kept;
}

/** The target ranks above the source in the flow: its middle lies behind the source, the way the drawing runs. */
function isBackEdge(source: Box, target: Box, flow: NonNullable<LayoutResult["direction"]>): boolean {
  const ty = target.y + target.height / 2;
  const tx = target.x + target.width / 2;
  switch (flow) {
    case "tb":
      return ty < source.y;
    case "bt":
      return ty > source.y + source.height;
    case "lr":
      return tx < source.x;
    case "rl":
      return tx > source.x + source.width;
  }
}

function segmentsCross(a: LayoutPoint, b: LayoutPoint, c: LayoutPoint, d: LayoutPoint): boolean {
  const side = (p: LayoutPoint, q: LayoutPoint, r: LayoutPoint) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return side(c, d, a) * side(c, d, b) < -1e-9 && side(a, b, c) * side(a, b, d) < -1e-9;
}

function crossings(route: readonly LayoutPoint[], others: readonly (readonly LayoutPoint[])[]): number {
  let count = 0;
  for (const other of others)
    for (let i = 1; i < route.length; i += 1)
      for (let j = 1; j < other.length; j += 1)
        if (segmentsCross(route[i - 1]!, route[i]!, other[j - 1]!, other[j]!)) count += 1;
  return count;
}

/**
 * The side of `box` that `point` sits on, as the direction out of it, or undefined when the point is not on the
 * box's border. A point on a corner is taken by the side the wire leaves along (`along`).
 */
function sideOf(box: Box, point: LayoutPoint, along: Dir): Dir | undefined {
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;
  const sides: Dir[] = [];
  if (near(point.y, box.y) && point.x >= box.x - 0.5 && point.x <= box.x + box.width + 0.5) sides.push({ x: 0, y: -1 });
  if (near(point.y, box.y + box.height) && point.x >= box.x - 0.5 && point.x <= box.x + box.width + 0.5)
    sides.push({ x: 0, y: 1 });
  if (near(point.x, box.x) && point.y >= box.y - 0.5 && point.y <= box.y + box.height + 0.5)
    sides.push({ x: -1, y: 0 });
  if (near(point.x, box.x + box.width) && point.y >= box.y - 0.5 && point.y <= box.y + box.height + 0.5)
    sides.push({ x: 1, y: 0 });
  return sides.find((side) => side.x === along.x && side.y === along.y);
}

/** The places along a side of `box` (facing `side`) an end may stand, nearest `prefer` first. */
function slots(box: Box, side: Dir, prefer: LayoutPoint): LayoutPoint[] {
  const horizontalSide = side.y !== 0;
  const lo = (horizontalSide ? box.x : box.y) + END_MARGIN_PX;
  const hi = (horizontalSide ? box.x + box.width : box.y + box.height) - END_MARGIN_PX;
  const fixed = side.y === -1 ? box.y : side.y === 1 ? box.y + box.height : side.x === -1 ? box.x : box.x + box.width;
  const want = horizontalSide ? prefer.x : prefer.y;
  const values = new Set<number>([want]);
  for (let v = lo; v <= hi; v += STEP_PX) values.add(Math.round(v));
  return [...values]
    .sort((a, b) => Math.abs(a - want) - Math.abs(b - want))
    .map((v) => (horizontalSide ? { x: v, y: fixed } : { x: fixed, y: v }));
}

type Wire = {
  readonly edge: LayoutEdge;
  readonly source: Box;
  readonly target: Box;
  readonly arrowStart: boolean;
  readonly arrowEnd: boolean;
  /** Its end may slide along that box's side: the side is flat where it meets the box. */
  readonly sourceSlides: boolean;
  readonly targetSlides: boolean;
  /** A place on the source's (target's) side carried onto the outline that is drawn there, or undefined. */
  readonly onSource: (p: LayoutPoint, side: Dir) => LayoutPoint | undefined;
  readonly onTarget: (p: LayoutPoint, side: Dir) => LayoutPoint | undefined;
};

/**
 * Whether a box's outline is its bounding box along every side, so an end can stand anywhere on a side: a plain,
 * rounded or subroutine box, a C4 element other than a database or a queue, an architecture service, an entity, a
 * state. A cylinder's cap, a diamond, a circle, a hexagon's points, a stadium's ends are not: there an end stays
 * where ELK and the layout carried it onto the outline.
 */
function hasFlatSides(node: LayoutNode): boolean {
  const figure = node.figure;
  if (figure === undefined) {
    const outline = outlineOf(node.shape, node.classes);
    return outline === "rectangle" || outline === "rounded" || outline === "subroutine";
  }
  switch (figure.type) {
    case "c4":
      return figure.shape !== "database" && figure.shape !== "queue";
    case "service":
    case "entity":
      return true;
    case "state":
      return figure.kind === "state";
    default:
      return false;
  }
}

/**
 * What each simplified layout was made from. The nested view grows and closes from this, not from what is drawn:
 * a grow that started from simplified routes would route its new wires from a different picture each step, and the
 * chain could end with more corners than it would have had without simplifying at all (the 150-node flowchart did,
 * 387 -> 409). Grown from the unsimplified chain, every step is that chain's own step, simplified for drawing, and so
 * never worse. Held weakly: a layout that crossed a realm (a worker's message) has none, and is used as it is.
 */
const MADE_FROM = new WeakMap<LayoutResult, LayoutResult>();

/** The layout a simplified layout was made from; a layout that was not simplified here is its own. */
export function unsimplified(layout: LayoutResult): LayoutResult {
  return MADE_FROM.get(layout) ?? layout;
}

export type SimplifyOptions = {
  /** More places no run or caption may go: a frame's "−" in the nested view. */
  readonly walls?: readonly Box[];
};

/** `layout` with every wire that can be drawn with fewer corners redrawn so (see above). */
export function simplifyRoutes(layout: LayoutResult, options: SimplifyOptions = {}): LayoutResult {
  const boxes = new Map<string, Box>(layout.nodes.map((node) => [node.id, node]));
  const flatSided = new Map(layout.nodes.map((node) => [node.id, hasFlatSides(node)]));
  const nodeById = new Map(layout.nodes.map((node) => [node.id, node]));
  // An end may slide along a side that is flat, or onto a plain shape's curve or slant close by (a cylinder's cap, a
  // stadium's end, a hexagon's flat top): carried onto the outline along the way the wire approaches it, as the
  // layout carries ELK's ends (`meetOutline`). A diamond's or a circle's slants, and a figure's, keep ELK's end.
  const slidable = new Map(
    layout.nodes.map((node) => {
      if (hasFlatSides(node)) return [node.id, true] as const;
      if (node.figure?.type === "c4") return [node.id, true] as const; // a database's or a queue's flat run
      const outline = outlineOf(node.shape, node.classes);
      return [node.id, node.figure === undefined && outline !== "diamond" && outline !== "circle"] as const;
    }),
  );
  /** A C4 database is a cylinder standing up; a queue, one lying down: its top and bottom are flat between its ends. */
  const c4Outline = (node: LayoutNode, p: LayoutPoint, side: Dir): LayoutPoint | undefined => {
    if (node.figure?.type !== "c4") return undefined;
    if (node.figure.shape === "queue") {
      const r = node.height / 2;
      if (side.y === 0) return undefined;
      return p.x >= node.x + r && p.x <= node.x + node.width - r ? p : undefined;
    }
    const inward = { x: p.x - side.x * (node.width + node.height), y: p.y - side.y * (node.width + node.height) };
    const q = meetOutline("cylinder", node, p, inward);
    return Math.hypot(q.x - p.x, q.y - p.y) <= OUTLINE_REACH_PX ? q : undefined;
  };
  const onOutlineOf =
    (id: string) =>
    (p: LayoutPoint, side: Dir): LayoutPoint | undefined => {
      const node = nodeById.get(id);
      if (node === undefined) return undefined;
      if (flatSided.get(id) === true) return p;
      if (slidable.get(id) !== true) return undefined;
      if (node.figure?.type === "c4") return c4Outline(node, p, side);
      const inward = { x: p.x - side.x * (node.width + node.height), y: p.y - side.y * (node.width + node.height) };
      const q = meetOutline(outlineOf(node.shape, node.classes), node, p, inward);
      return Math.hypot(q.x - p.x, q.y - p.y) <= OUTLINE_REACH_PX ? q : undefined;
    };
  const noteBoxes = layout.nodes.flatMap((node) => (node.note === undefined ? [] : [node.note]));
  const parentOf = new Map(layout.groups.map((group) => [group.id, group.parentId]));
  const groupOfNode = new Map(layout.nodes.map((node) => [node.id, node.groupId]));
  const inside = (nodeId: string, groupId: string): boolean => {
    let cursor = groupOfNode.get(nodeId);
    for (let hops = 0; cursor !== undefined && hops <= layout.groups.length; hops += 1) {
      if (cursor === groupId) return true;
      cursor = parentOf.get(cursor);
    }
    return false;
  };
  const walls: Box[] = [
    ...(options.walls ?? []),
    // A frame's caption keeps the air its placement gave it (`CAPTION_AIR_PX`); a run is already grown by its own.
    ...layout.groups.flatMap((group) =>
      group.caption === undefined ? [] : [grown(group.caption, CAPTION_AIR_PX - RUN_CLEARANCE_PX)],
    ),
    ...noteBoxes,
  ];
  const edges = [...layout.edges];
  const order = edges
    .map((_, index) => index)
    .sort((a, b) => (edges[a]!.id < edges[b]!.id ? -1 : edges[a]!.id > edges[b]!.id ? 1 : 0));
  // Each wire's corners, its runs and its caption filed where they lie, kept in step with `edges` by `setEdge`.
  const routes = edges.map((edge) => cornersOf(edge.points));
  const runsOf: Segment[][] = [];
  const plateOf: (Plate | undefined)[] = [];
  const extent = extentOf(layout, walls);
  const runGrid = new Grid<Segment>(extent);
  const plateGrid = new Grid<Plate>(extent);
  const nodeGrid = new Grid<Placed>(extent);
  for (const [id, box] of boxes) nodeGrid.add({ id, box, mark: -1 }, box);
  const file = (index: number): void => {
    const route = routes[index]!;
    const runs: Segment[] = [];
    for (let i = 1; i < route.length; i += 1) {
      const run: Segment = { wire: index, c: route[i - 1]!, d: route[i]!, mark: -1 };
      runGrid.add(run, runBox(run.c, run.d, 0));
      runs.push(run);
    }
    runsOf[index] = runs;
    const anchor = edges[index]!.labelAnchor;
    const plate = anchor === undefined ? undefined : { wire: index, box: anchor, mark: -1 };
    if (plate !== undefined) plateGrid.add(plate, plate.box);
    plateOf[index] = plate;
  };
  const setEdge = (index: number, edge: LayoutEdge): void => {
    for (const run of runsOf[index]!) runGrid.remove(run);
    const plate = plateOf[index];
    if (plate !== undefined) plateGrid.remove(plate);
    edges[index] = edge;
    routes[index] = cornersOf(edge.points);
    file(index);
  };
  edges.forEach((_, index) => file(index));
  /** How many times `route` crosses the wires other than `self` (`crossings` against all of them). */
  const crossingsWith = (route: readonly LayoutPoint[], self: number): number => {
    let count = 0;
    for (let i = 1; i < route.length; i += 1) {
      const a = route[i - 1]!;
      const b = route[i]!;
      runGrid.some(runBox(a, b, 0), (run) => {
        if (run.wire !== self && segmentsCross(a, b, run.c, run.d)) count += 1;
        return false;
      });
    }
    return count;
  };
  /** Whether the run a-b lies along a run of a wire other than `self`, closer than PARALLEL_PX, over any length. */
  const alongAnother = (a: LayoutPoint, b: LayoutPoint, self: number): boolean =>
    runGrid.some(runBox(a, b, PARALLEL_PX), ({ wire, c, d }) => {
      if (wire === self) return false;
      const sameX = a.x === b.x && c.x === d.x && Math.abs(a.x - c.x) < PARALLEL_PX;
      const sameY = a.y === b.y && c.y === d.y && Math.abs(a.y - c.y) < PARALLEL_PX;
      const span = (u: number, v: number, w: number, z: number) =>
        Math.min(Math.max(u, v), Math.max(w, z)) - Math.max(Math.min(u, v), Math.min(w, z));
      return (sameX && span(a.y, b.y, c.y, d.y) > 0) || (sameY && span(a.x, b.x, c.x, d.x) > 0);
    });
  /** Whether `box` meets a caption other than `self`'s. */
  const onAnotherCaption = (box: Box, self: number): boolean =>
    plateGrid.some(box, (plate) => plate.wire !== self && overlaps(box, plate.box));
  /** Whether `run` enters a box other than `source`'s and `target`'s. */
  const onAnotherBox = (run: Box, source: string, target: string): boolean =>
    nodeGrid.some(run, (node) => node.id !== source && node.id !== target && overlaps(run, node.box));
  // Each frame's four edges, as lines (`simplest`) and as thin plates a caption keeps off (`placeCaption`).
  const frameLines = new Map(
    layout.groups.map((g) => [
      g,
      [
        { x: g.x, y: g.y, width: g.width, height: 0 },
        { x: g.x, y: g.y + g.height, width: g.width, height: 0 },
        { x: g.x, y: g.y, width: 0, height: g.height },
        { x: g.x + g.width, y: g.y, width: 0, height: g.height },
      ] as const,
    ]),
  );
  const frameEdges = layout.groups.flatMap((g) => [
    { x: g.x, y: g.y - 1.5, width: g.width, height: 3 },
    { x: g.x, y: g.y + g.height - 1.5, width: g.width, height: 3 },
    { x: g.x - 1.5, y: g.y, width: 3, height: g.height },
    { x: g.x + g.width - 1.5, y: g.y, width: 3, height: g.height },
  ]);

  for (const index of order) {
    const edge = edges[index]!;
    // A loop, declared sides, and a nested view's trunk (fanned out from its exit by the grow) stay as routed.
    if (edge.source === edge.target || edge.figure?.type === "ports" || edge.id.startsWith("trunk:")) continue;
    const source = boxes.get(edge.source);
    const target = boxes.get(edge.target);
    if (source === undefined || target === undefined) continue;
    const corners = routes[index]!;
    if (corners.length < 3) continue;
    const arrows = arrowsOf(edge.figure, edge.bidirectional);
    const wire: Wire = {
      edge,
      source,
      target,
      arrowStart: arrows.start,
      arrowEnd: arrows.end,
      sourceSlides: slidable.get(edge.source) === true,
      targetSlides: slidable.get(edge.target) === true,
      onSource: onOutlineOf(edge.source),
      onTarget: onOutlineOf(edge.target),
    };
    const better = simplest(wire, corners, index);
    if (better === undefined) continue;
    setEdge(index, { ...edge, points: better.points, labelAnchor: better.caption ?? edge.labelAnchor });
  }
  const trunked = trunkFanOuts();
  spreadEnds();
  const simplified = { ...layout, edges };
  MADE_FROM.set(simplified, unsimplified(layout));
  return simplified;

  /**
   * A fan-out drawn as a tree (rendered review, 2026-11-13: four lines left the QoS "Service Level?" diamond as
   * near-coincident runs about ten apart, and the coffee URI's three as dotted runs eight apart). Where three or more
   * wires leave one side of a box along the flow, each as a straight drop or a down-across-down Z, they share one
   * trunk: a stem from the middle of that side to a bus across the flow, and from the bus a drop to each target,
   * where each wire's arrowhead and caption already were. Taken only when it is clear, as every shape here is: no run
   * enters a box, a wall or another caption, none lies along another wire, and the fan crosses no more wires than it
   * did. Returns the indices of the wires now drawn so, which keep their shared start.
   */
  function trunkFanOuts(): Set<number> {
    const trunked = new Set<number>();
    const flow = layout.direction ?? "tb";
    // In flow coordinates the flow runs down (+y): a turn of the drawing, undone on the way out.
    const toFlow = (p: LayoutPoint): LayoutPoint =>
      flow === "tb"
        ? p
        : flow === "bt"
          ? { x: p.x, y: -p.y }
          : flow === "lr"
            ? { x: p.y, y: p.x }
            : { x: p.y, y: -p.x };
    const fromFlow = (p: LayoutPoint): LayoutPoint =>
      flow === "tb"
        ? p
        : flow === "bt"
          ? { x: p.x, y: -p.y }
          : flow === "lr"
            ? { x: p.y, y: p.x }
            : { x: -p.y, y: p.x };
    const boxToFlow = (b: Box): Box => {
      const a = toFlow({ x: b.x, y: b.y });
      const c = toFlow({ x: b.x + b.width, y: b.y + b.height });
      return { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), width: Math.abs(a.x - c.x), height: Math.abs(a.y - c.y) };
    };
    const bySource = new Map<string, number[]>();
    for (const [index, edge] of edges.entries()) {
      if (edge.source === edge.target || edge.figure?.type === "ports") continue;
      if (edge.id.startsWith("trunk:") || edge.id.startsWith("bundle:")) continue;
      const list = bySource.get(edge.source) ?? [];
      list.push(index);
      bySource.set(edge.source, list);
    }
    for (const [sourceId, indices] of bySource) {
      if (indices.length < FAN_OUT_LEAST) continue;
      const sourceBox = boxes.get(sourceId);
      if (sourceBox === undefined) continue;
      const source = boxToFlow(sourceBox);
      const bottom = source.y + source.height;
      // Each wire leaving down: its route in flow coordinates, as a drop or a down-across-down Z.
      type Member = { index: number; route: LayoutPoint[]; drop: number; end: LayoutPoint; lastRun: number };
      const members: Member[] = [];
      let shaped = true;
      for (const index of indices) {
        const edge = edges[index]!;
        const route = routes[index]!.map(toFlow);
        if (route.length < 2) continue;
        const [a, b] = [route[0]!, route[1]!];
        const leavesDown = Math.abs(a.x - b.x) < 0.5 && b.y > a.y && a.y >= source.y + source.height / 2 - 0.5;
        if (!leavesDown) continue; // a wire leaving another side is not part of this fan
        const arrows = arrowsOf(edge.figure, edge.bidirectional);
        const z =
          route.length === 4 &&
          Math.abs(route[1]!.y - route[2]!.y) < 0.5 &&
          Math.abs(route[2]!.x - route[3]!.x) < 0.5 &&
          route[3]!.y > route[2]!.y;
        if (arrows.start || !(route.length === 2 || z)) {
          shaped = false;
          break;
        }
        const end = route[route.length - 1]!;
        members.push({
          index,
          route,
          drop: end.x,
          end,
          lastRun: len(route[route.length - 2]!, end),
        });
      }
      if (!shaped || members.length < FAN_OUT_LEAST) continue;
      // A wire already straight keeps its line: on the trunk it would gain two corners (the owner's goal is the
      // drawing's total, 2026-11-12), and a straight drop is not what tangles. The rest share the trunk.
      const stemX = source.x + source.width / 2;
      const straight = new Set(members.filter((m) => m.route.length === 2 && Math.abs(m.drop - stemX) >= 0.5));
      const turning = members.filter((m) => !straight.has(m));
      if (turning.filter((m) => m.route.length === 4).length < 2) continue;
      // The bus: the across run lowest in the channel, where every wire already turned; a fan whose wires all go
      // straight down has no bus to share and is left as it is.
      const runs = turning.filter((m) => m.route.length === 4).map((m) => m.route[1]!.y);
      if (runs.length === 0) continue;
      const bus = Math.max(...runs);
      const stem: LayoutPoint = { x: stemX, y: bottom };
      if (bus - stem.y < LEAST_RUN_PX) continue;
      const proposed = new Map<number, LayoutPoint[]>();
      let fits = true;
      for (const m of turning) {
        const edge = edges[m.index]!;
        const arrows = arrowsOf(edge.figure, edge.bidirectional);
        const needEnd = arrows.end ? Math.min(ARROW_APPROACH_PX, m.lastRun) : Math.min(LEAST_RUN_PX, m.lastRun);
        if (m.end.y - bus < needEnd - 1e-6) {
          fits = false;
          break;
        }
        // Its caption stays on its own drop, below the bus.
        const caption = edge.labelAnchor === undefined ? undefined : boxToFlow(edge.labelAnchor);
        if (caption !== undefined && edge.label) {
          const onDrop = caption.x <= m.drop && caption.x + caption.width >= m.drop;
          if (!onDrop || caption.y < bus + RUN_CLEARANCE_PX) {
            fits = false;
            break;
          }
        }
        const route = cornersOf(
          Math.abs(m.drop - stem.x) < 0.5 ? [stem, m.end] : [stem, { x: stem.x, y: bus }, { x: m.drop, y: bus }, m.end],
        );
        proposed.set(m.index, route);
      }
      if (!fits) continue;
      // Clear of everything but the fan itself.
      const fan = new Set(turning.map((m) => m.index));
      const others: LayoutPoint[][] = [];
      for (const [k, route] of routes.entries()) if (!fan.has(k)) others.push(route.map(toFlow));
      const before = turning.reduce((sum, m) => sum + crossings(m.route, others), 0);
      const after = [...proposed.values()].reduce((sum, route) => sum + crossings(route, others), 0);
      if (after > before) continue;
      const flowWalls = walls.map(boxToFlow);
      const otherCaptions = edges.flatMap((e, k) =>
        fan.has(k) || e.labelAnchor === undefined ? [] : [boxToFlow(e.labelAnchor)],
      );
      const flowBoxes = [...boxes].map(([id, box]) => [id, boxToFlow(box)] as const);
      const clear = [...proposed.entries()].every(([index, route]) => {
        const edge = edges[index]!;
        for (let i = 1; i < route.length; i += 1) {
          const a = route[i - 1]!;
          const b = route[i]!;
          const run = runBox(a, b, RUN_CLEARANCE_PX);
          const bare = runBox(a, b, 0);
          for (const [id, box] of flowBoxes) {
            if (id === edge.source || id === edge.target) {
              // Its own boxes only at its ends: the stem leaves the source, the drop reaches the target.
              const inner = grown(box, -1);
              const trimmed =
                i === 1
                  ? runBox({ x: a.x, y: a.y + 1 }, b, 0)
                  : i === route.length - 1
                    ? runBox(a, { x: b.x, y: b.y - 1 }, 0)
                    : bare;
              if (overlaps(trimmed, inner)) return false;
            } else if (overlaps(run, box)) return false;
          }
          if (flowWalls.some((wall) => overlaps(run, wall))) return false;
          if (otherCaptions.some((caption) => overlaps(run, caption))) return false;
          for (const other of others)
            for (let j = 1; j < other.length; j += 1) {
              const c = other[j - 1]!;
              const d = other[j]!;
              const sameX = a.x === b.x && c.x === d.x && Math.abs(a.x - c.x) < PARALLEL_PX;
              const sameY = a.y === b.y && c.y === d.y && Math.abs(a.y - c.y) < PARALLEL_PX;
              const span = (u: number, v: number, w: number, z: number) =>
                Math.min(Math.max(u, v), Math.max(w, z)) - Math.max(Math.min(u, v), Math.min(w, z));
              if ((sameX && span(a.y, b.y, c.y, d.y) > 0) || (sameY && span(a.x, b.x, c.x, d.x) > 0)) return false;
            }
        }
        return true;
      });
      if (!clear) continue;
      for (const [index, route] of proposed) {
        setEdge(index, { ...edges[index]!, points: route.map(fromFlow) });
        trunked.add(index);
      }
    }
    return trunked;
  }

  /**
   * Ends sharing one side of a box are spread along it (owner, 2026-11-12: the reference spreads arrows along a
   * side, never bunching them at one spot): evenly over the side, END_MARGIN_PX clear of each corner, in the order
   * their wires head off so they do not cross. An end moves with its wire's first run, whose next run takes up the
   * difference; a straight wire, a fixed end or a move that is not clear keeps its place.
   */
  function spreadEnds(): void {
    type End = { index: number; at: "start" | "end"; box: string; side: Dir };
    const groups = new Map<string, End[]>();
    for (const [index, edge] of edges.entries()) {
      if (edge.source === edge.target || edge.figure?.type === "ports" || edge.id.startsWith("trunk:")) continue;
      if (trunked.has(index)) continue; // a tree's members share their start on purpose
      const route = routes[index]!;
      if (route.length < 2) continue;
      for (const at of ["start", "end"] as const) {
        const id = at === "start" ? edge.source : edge.target;
        const box = boxes.get(id);
        if (box === undefined || flatSided.get(id) !== true) continue;
        const p = at === "start" ? route[0]! : route[route.length - 1]!;
        const q = at === "start" ? route[1]! : route[route.length - 2]!;
        const side = sideOf(box, p, dirOf(p, q));
        if (side === undefined) continue;
        const key = `${id}|${side.x},${side.y}`;
        const list = groups.get(key) ?? [];
        list.push({ index, at, box: id, side });
        groups.set(key, list);
      }
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const box = boxes.get(list[0]!.box)!;
      const side = list[0]!.side;
      const alongX = side.y !== 0; // the side runs along x (top or bottom)
      const lo = (alongX ? box.x : box.y) + END_MARGIN_PX;
      const hi = (alongX ? box.x + box.width : box.y + box.height) - END_MARGIN_PX;
      const along = (p: LayoutPoint) => (alongX ? p.x : p.y);
      const endPoint = (end: End) => {
        const route = routes[end.index]!;
        return end.at === "start" ? route[0]! : route[route.length - 1]!;
      };
      // The order that keeps them from crossing: wires that turn back along the side towards its start come first,
      // the one turning nearest the box first; wires turning towards its end come last, the one turning nearest last;
      // a wire that runs straight out keeps the middle.
      const turnKey = (end: End): number => {
        const route = routes[end.index]!;
        if (route.length < 3) return 0;
        const p = end.at === "start" ? route[0]! : route[route.length - 1]!;
        const c = end.at === "start" ? route[1]! : route[route.length - 2]!;
        const n = end.at === "start" ? route[2]! : route[route.length - 3]!;
        const reach = Math.hypot(c.x - p.x, c.y - p.y);
        const turn = Math.sign(along(n) - along(c));
        return turn < 0 ? -1e6 + reach : turn > 0 ? 1e6 - reach : 0;
      };
      const want = Math.min(40, (hi - lo) / list.length / 2);
      const sorted = [...list].sort((a, b) => along(endPoint(a)) - along(endPoint(b)));
      const bunched = sorted.some((end, i) => i > 0 && along(endPoint(end)) - along(endPoint(sorted[i - 1]!)) < want);
      if (!bunched) continue;
      // A wire that cannot move (straight out) would sit among the slots: leave such a side as it is.
      if (list.some((end) => routes[end.index]!.length < 3)) continue;
      const order = [...list].sort((a, b) => turnKey(a) - turnKey(b) || along(endPoint(a)) - along(endPoint(b)));
      order.forEach((end, i) => {
        const slot = Math.round(lo + ((i + 1) * (hi - lo)) / (order.length + 1));
        moveEnd(end, slot, alongX);
      });
    }

    function moveEnd(end: { index: number; at: "start" | "end" }, slot: number, alongX: boolean): void {
      const edge = edges[end.index]!;
      const route = routes[end.index]!;
      if (route.length < 3) return; // a straight wire stays straight
      const i0 = end.at === "start" ? 0 : route.length - 1;
      const i1 = end.at === "start" ? 1 : route.length - 2;
      const delta = slot - (alongX ? route[i0]!.x : route[i0]!.y);
      if (Math.abs(delta) < 0.5) return;
      const shift = (p: LayoutPoint) => (alongX ? { x: p.x + delta, y: p.y } : { x: p.x, y: p.y + delta });
      const moved = route.map((p, i) => (i === i0 || i === i1 ? shift(p) : p));
      // The run after the first must still meet it at a corner, not fold back past the next corner.
      const i2 = end.at === "start" ? 2 : route.length - 3;
      const next = route[i2]!;
      const corner = moved[i1]!;
      if (alongX ? corner.y !== next.y : corner.x !== next.x) return;
      const source = boxes.get(edge.source);
      const target = boxes.get(edge.target);
      for (let i = 1; i < moved.length; i += 1) {
        const a = moved[i - 1]!;
        const b = moved[i]!;
        if (Math.hypot(b.x - a.x, b.y - a.y) < LEAST_RUN_PX) return;
        const run = runBox(a, b, RUN_CLEARANCE_PX);
        const bare = runBox(a, b, 0);
        for (const own of [source, target]) if (own !== undefined && overlaps(bare, grown(own, -1))) return;
        if (onAnotherBox(run, edge.source, edge.target)) return;
        if (walls.some((wall) => overlaps(run, wall)) || onAnotherCaption(run, end.index)) return;
        if (alongAnother(a, b, end.index)) return;
      }
      if (crossingsWith(moved, end.index) > crossingsWith(route, end.index)) return;
      // Its caption stays on its own line, or the move is not made.
      const caption = edge.labelAnchor;
      if (caption !== undefined && edge.label) {
        const touches = moved.slice(1).some((p, i) => overlaps(runBox(moved[i]!, p, 1), caption));
        if (!touches) return;
      }
      setEdge(end.index, { ...edge, points: moved });
    }
  }

  /** The fewest-corner clear shape for this wire, if it has fewer corners than now. */
  function simplest(
    wire: Wire,
    corners: LayoutPoint[],
    self: number,
  ): { points: LayoutPoint[]; caption?: Box } | undefined {
    const first = corners[0]!;
    const last = corners[corners.length - 1]!;
    const out = dirOf(first, corners[1]!);
    const into = dirOf(corners[corners.length - 2]!, last);
    const startSide = sideOf(wire.source, first, out);
    // A wire enters its target moving `into`, so the side it meets faces the other way.
    const endSide = sideOf(wire.target, last, { x: -into.x, y: -into.y });
    if (startSide === undefined || endSide === undefined) return undefined;
    const now = corners.length - 2;
    const before = crossingsWith(corners, self);
    const otherEnds: LayoutPoint[] = [];
    for (const [k, r] of routes.entries()) if (k !== self && r.length > 0) otherEnds.push(r[0]!, r[r.length - 1]!);
    const firstRun = len(corners[0]!, corners[1]!);
    const lastRun = len(corners[corners.length - 2]!, last);
    const needStart = wire.arrowStart ? Math.min(ARROW_APPROACH_PX, firstRun) : Math.min(LEAST_RUN_PX, firstRun);
    const needEnd = wire.arrowEnd ? Math.min(ARROW_APPROACH_PX, lastRun) : Math.min(LEAST_RUN_PX, lastRun);
    const frames = layout.groups.map((group) => ({
      group,
      holdsEnd: inside(wire.edge.source, group.id) || inside(wire.edge.target, group.id),
    }));
    // Its own boxes only at its ends: trimmed off the box it leaves or reaches, by as much as an end carried onto a
    // curved outline may sit inside it.
    const ownSource = grown(wire.source, -1);
    const ownTarget = grown(wire.target, -1);
    const trim = (from: LayoutPoint, to: LayoutPoint, by: number): LayoutPoint => {
      const length = len(from, to) || 1;
      return { x: from.x + ((to.x - from.x) / length) * by, y: from.y + ((to.y - from.y) / length) * by };
    };

    const endClear = (moved: LayoutPoint, original: LayoutPoint): boolean =>
      (Math.abs(moved.x - original.x) < 0.5 && Math.abs(moved.y - original.y) < 0.5) ||
      // An end a whole gap and more away along either axis is clear without measuring.
      !otherEnds.some(
        (p) =>
          Math.abs(p.x - moved.x) <= PORT_GAP_PX + 1 &&
          Math.abs(p.y - moved.y) <= PORT_GAP_PX + 1 &&
          len(p, moved) < PORT_GAP_PX,
      );

    const clear = (route: LayoutPoint[]): boolean => {
      if (len(route[0]!, route[1]!) < needStart - 1e-6) return false;
      if (len(route[route.length - 2]!, route[route.length - 1]!) < needEnd - 1e-6) return false;
      for (let i = 1; i < route.length; i += 1) {
        const a = route[i - 1]!;
        const b = route[i]!;
        const length = len(a, b);
        if (i > 1 && i < route.length - 1 && length < LEAST_RUN_PX) return false;
        const run = runBox(a, b, RUN_CLEARANCE_PX);
        const bare = runBox(
          i === 1 ? trim(a, b, OUTLINE_REACH_PX + 1) : a,
          i === route.length - 1 ? trim(b, a, OUTLINE_REACH_PX + 1) : b,
          0,
        );
        if (overlaps(bare, ownSource) || overlaps(bare, ownTarget)) return false;
        if (onAnotherBox(run, wire.edge.source, wire.edge.target)) return false;
        if (walls.some((wall) => overlaps(run, wall))) return false;
        // Every plate, a bundle's or a trunk's "N connections" too.
        if (onAnotherCaption(run, self)) return false;
        const vertical = a.x === b.x;
        const near = grown(bare, PARALLEL_PX);
        for (const { group, holdsEnd } of frames) {
          if (!holdsEnd) {
            if (overlaps(run, group)) return false;
            continue;
          }
          // Along a frame's edge it reads as the frame's line.
          for (const side of frameLines.get(group)!)
            if ((side.width === 0) === vertical && overlaps(near, side) && length > PARALLEL_PX) {
              const alongOverlap = vertical
                ? Math.min(Math.max(a.y, b.y), side.y + side.height) - Math.max(Math.min(a.y, b.y), side.y)
                : Math.min(Math.max(a.x, b.x), side.x + side.width) - Math.max(Math.min(a.x, b.x), side.x);
              if (alongOverlap > PARALLEL_PX) return false;
            }
        }
        if (alongAnother(a, b, self)) return false;
      }
      return crossingsWith(route, self) <= before;
    };

    /** A clear place for the wire's caption on `route`, or undefined; nothing to place, the old box. */
    const placeCaption = (route: LayoutPoint[]): { ok: boolean; box?: Box } => {
      const anchor = wire.edge.labelAnchor;
      if (anchor === undefined || !wire.edge.label) return { ok: true };
      const total = route.slice(1).reduce((sum, p, i) => sum + len(route[i]!, p), 0);
      const pointAt = (distance: number): { p: LayoutPoint; vertical: boolean } => {
        let walked = 0;
        for (let i = 1; i < route.length; i += 1) {
          const a = route[i - 1]!;
          const b = route[i]!;
          const run = len(a, b);
          if (walked + run >= distance) {
            const t = run === 0 ? 0 : (distance - walked) / run;
            return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, vertical: a.x === b.x };
          }
          walked += run;
        }
        return { p: route[route.length - 1]!, vertical: true };
      };
      for (let offset = 0; offset <= total / 2; offset += 6) {
        for (const at of offset === 0 ? [total / 2] : [total / 2 + offset, total / 2 - offset]) {
          const { p, vertical } = pointAt(at);
          const reach = (vertical ? anchor.height : anchor.width) / 2 + CAPTION_LEAD_PX;
          if (at < reach || total - at < reach) continue;
          const box = {
            x: p.x - anchor.width / 2,
            y: p.y - anchor.height / 2,
            width: anchor.width,
            height: anchor.height,
          };
          // It sits on one straight run, not over a corner of its own line.
          const stays =
            pointAt(at - reach + CAPTION_LEAD_PX).vertical === vertical &&
            pointAt(at + reach - CAPTION_LEAD_PX).vertical === vertical;
          if (!stays) continue;
          if (nodeGrid.some(box, (node) => overlaps(box, node.box))) continue;
          if (walls.some((w) => overlaps(box, w)) || onAnotherCaption(box, self)) continue;
          const onRun = runGrid.some(grown(box, 1), (r) => r.wire !== self && overlaps(box, runBox(r.c, r.d, 1)));
          if (onRun || frameEdges.some((s) => overlaps(box, s))) continue;
          return { ok: true, box };
        }
      }
      return { ok: false };
    };

    const accept = (route: LayoutPoint[]): { points: LayoutPoint[]; caption?: Box } | undefined => {
      if (!clear(route)) return undefined;
      const placed = placeCaption(route);
      return placed.ok ? { points: route, ...(placed.box === undefined ? {} : { caption: placed.box }) } : undefined;
    };

    const parallel = startSide.x === -endSide.x && startSide.y === -endSide.y; // facing each other (same flow way)
    const perpendicular = startSide.x * endSide.x + startSide.y * endSide.y === 0;
    const placed = (points: LayoutPoint[], on: (p: LayoutPoint, side: Dir) => LayoutPoint | undefined, side: Dir) =>
      points.flatMap((p) => {
        const q = on(p, side);
        return q === undefined ? [] : [q];
      });
    const starts = (
      wire.sourceSlides ? placed(slots(wire.source, startSide, first), wire.onSource, startSide) : [first]
    ).filter((p) => endClear(p, first));
    const ends = (
      wire.targetSlides ? placed(slots(wire.target, endSide, last), wire.onTarget, endSide) : [last]
    ).filter((p) => endClear(p, last));
    const vertical = startSide.y !== 0;

    // 0 corners: the two ends on one line.
    if (now > 0 && parallel) {
      for (const s of starts) {
        // On the target's side, carried onto its outline there.
        const sideAt =
          endSide.y < 0
            ? wire.target.y
            : endSide.y > 0
              ? wire.target.y + wire.target.height
              : endSide.x < 0
                ? wire.target.x
                : wire.target.x + wire.target.width;
        const onSide = vertical ? { x: s.x, y: sideAt } : { x: sideAt, y: s.y };
        const e = wire.targetSlides
          ? wire.onTarget(onSide, endSide)
          : vertical
            ? { x: s.x, y: last.y }
            : { x: last.x, y: s.y };
        if (e === undefined) continue;
        const span = vertical
          ? [wire.target.x + END_MARGIN_PX, wire.target.x + wire.target.width - END_MARGIN_PX]
          : [wire.target.y + END_MARGIN_PX, wire.target.y + wire.target.height - END_MARGIN_PX];
        const across = vertical ? e.x : e.y;
        if (!wire.targetSlides && (Math.abs(e.x - last.x) > 0.5 || Math.abs(e.y - last.y) > 0.5)) continue;
        if (wire.targetSlides && (across < span[0]! || across > span[1]!)) continue;
        if (!endClear(e, last)) continue;
        if ((vertical ? (e.y - s.y) * startSide.y : (e.x - s.x) * startSide.x) <= 0) continue;
        const found = accept([s, e]);
        if (found !== undefined) return found;
      }
    }
    // 1 corner: an L.
    if (now > 1 && perpendicular) {
      for (const s of starts.slice(0, 24))
        for (const e of ends.slice(0, 24)) {
          const corner = vertical ? { x: s.x, y: e.y } : { x: e.x, y: s.y };
          if ((corner.x - s.x) * startSide.x + (corner.y - s.y) * startSide.y <= 0) continue;
          if ((corner.x - e.x) * endSide.x + (corner.y - e.y) * endSide.y <= 0) continue;
          const found = accept([s, corner, e]);
          if (found !== undefined) return found;
        }
    }
    // A back-edge -- its target ranks above its source in the flow -- goes out of a side and up a lane beside the
    // flow into the target's same side: two corners, as the owner's reference routes a loop (2026-11-12), where the
    // flow's own sides would need four.
    const flow = layout.direction ?? "tb";
    if (now > 2 && wire.sourceSlides && wire.targetSlides && isBackEdge(wire.source, wire.target, flow)) {
      const acrossFlow = flow === "tb" || flow === "bt"; // the lane runs along y; sides are left and right
      for (const way of [1, -1] as const) {
        const side: Dir = acrossFlow ? { x: way, y: 0 } : { x: 0, y: way };
        const edgeOf = (box: Box) =>
          acrossFlow ? (way > 0 ? box.x + box.width : box.x) : way > 0 ? box.y + box.height : box.y;
        const beyond =
          way > 0
            ? Math.max(edgeOf(wire.source), edgeOf(wire.target))
            : Math.min(edgeOf(wire.source), edgeOf(wire.target));
        const middle = (box: Box): LayoutPoint => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
        const from = placed(slots(wire.source, side, middle(wire.source)), wire.onSource, side)
          .filter((p) => endClear(p, { x: Number.NaN, y: Number.NaN }))
          .slice(0, 5);
        const to = placed(slots(wire.target, side, middle(wire.target)), wire.onTarget, side)
          .filter((p) => endClear(p, { x: Number.NaN, y: Number.NaN }))
          .slice(0, 5);
        for (let d = 24; d <= 240; d += 8) {
          const lane = beyond + way * d;
          for (const s of from)
            for (const e of to) {
              const route = acrossFlow
                ? [s, { x: lane, y: s.y }, { x: lane, y: e.y }, e]
                : [s, { x: s.x, y: lane }, { x: e.x, y: lane }, e];
              const found = accept(route);
              if (found !== undefined) return found;
            }
        }
      }
    }
    // 2 corners: a Z (ends facing each other) or a U (ends facing the same way), its ends where they are.
    if (now > 2 && (parallel || (startSide.x === endSide.x && startSide.y === endSide.y))) {
      const along = (p: LayoutPoint) => (vertical ? p.y : p.x);
      const at = (p: LayoutPoint, m: number): LayoutPoint => (vertical ? { x: p.x, y: m } : { x: m, y: p.y });
      const way = vertical ? startSide.y : startSide.x;
      const tries: number[] = [];
      if (parallel) {
        const lo = Math.min(along(first), along(last));
        const hi = Math.max(along(first), along(last));
        const middle = (lo + hi) / 2;
        for (let d = 0; d <= (hi - lo) / 2; d += STEP_PX) tries.push(middle + d, middle - d);
      } else {
        const beyond = way > 0 ? Math.max(along(first), along(last)) : Math.min(along(first), along(last));
        for (let d = LEAST_RUN_PX * 2; d <= 240; d += STEP_PX) tries.push(beyond + way * d);
      }
      for (const m of tries) {
        const route = [first, at(first, m), at(last, m), last];
        if (parallel && (m - along(first)) * way <= 0) continue;
        const found = accept(route);
        if (found !== undefined) return found;
      }
      // The ends where they are found no clear shape: slide them along their sides, a few places each.
      for (const s of starts.slice(1, 7))
        for (const e of ends.slice(1, 7))
          for (const m of tries.filter((_, k) => k % 2 === 0)) {
            if (parallel && ((m - along(s)) * way <= 0 || (along(e) - m) * way <= 0)) continue;
            const found = accept([s, at(s, m), at(e, m), e]);
            if (found !== undefined) return found;
          }
    }
    return undefined;
  }
}
