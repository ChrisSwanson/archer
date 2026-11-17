// ELK layout in character cells. Every size and spacing handed to ELK is a
// whole number of cells (one column wide, one row tall), so what comes back
// needs rounding rather than scaling.
import ElkModule from "elkjs/lib/elk.bundled.js";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import type { Direction, EdgeLine, GraphEdge, GraphInput, GraphNode, NodeShape } from "./input.ts";
import { straighten, type Point } from "./geometry.ts";

export interface Box {
  readonly id: string;
  readonly lines: readonly string[];
  readonly kind?: string | undefined;
  // Nodes: the outline drawn (a database rectangle is a cylinder, as in
  // Archer's browser) and the kind's caption ("Person"). Groups: whether the
  // title sits inside the frame because it is wider than the frame's top edge.
  readonly outline?: NodeShape | undefined;
  readonly caption?: string | undefined;
  readonly titleInside?: boolean | undefined;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly group: boolean;
}

export interface Route {
  readonly id: string;
  readonly line: EdgeLine;
  /** A head at the first point too. */
  readonly bidirectional?: boolean;
  readonly points: readonly Point[];
  readonly label?: { readonly text: string; readonly x: number; readonly y: number } | undefined;
}

export interface Layout {
  readonly width: number;
  readonly height: number;
  readonly boxes: readonly Box[];
  readonly routes: readonly Route[];
  // Present when edge labels were replaced by numbers to save width.
  readonly edgeLegend?: readonly { readonly key: string; readonly text: string }[] | undefined;
}

export interface Density {
  readonly wrap: number;
  // Replace each edge label with a number and list the text under the drawing.
  readonly numbered: boolean;
  readonly gap: number;
}

// Tried in order by `fit`; each step gives up some readability for width.
export const DENSITIES: readonly [Density, ...Density[]] = [
  { wrap: 22, numbered: false, gap: 4 },
  { wrap: 16, numbered: false, gap: 2 },
  { wrap: 18, numbered: true, gap: 3 },
  { wrap: 14, numbered: true, gap: 2 },
  { wrap: 10, numbered: true, gap: 1 },
];

const ELK_DIRECTION = { tb: "DOWN", bt: "UP", lr: "RIGHT", rl: "LEFT" } as const;
const OUT_SIDE = { tb: "SOUTH", bt: "NORTH", lr: "EAST", rl: "WEST" } as const;
const IN_SIDE = { tb: "NORTH", bt: "SOUTH", lr: "WEST", rl: "EAST" } as const;

// elkjs is CommonJS: the module is the constructor itself (and also its own
// `default`), while its typings describe an ES module whose default export is.
const ELK = ElkModule as unknown as typeof ElkModule.default;

const odd = (n: number): number => (n % 2 ? n : n + 1);

/** Greedy word wrap; a node grows taller rather than wider. */
export function wrap(label: string, max: number): string[] {
  const lines: string[] = [];
  for (const word of label.split(/\s+/)) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= max) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

/**
 * The first density that fits `maxWidth` with every edge label touching its
 * own route. A label ELK left floating away from its line cannot be read as
 * belonging to it, so numbered labels with a legend beat it. If nothing does
 * both, the first that fits; if nothing fits, the tightest.
 */
export async function fit(graph: GraphInput, maxWidth: number): Promise<Layout> {
  let fitting: Layout | undefined;
  let last: Layout | undefined;
  for (const density of DENSITIES) {
    last = await layout(graph, density);
    if (last.width > maxWidth) continue;
    // A number is checked against the legend, not read off its line.
    if (density.numbered || labelsAttached(last)) return last;
    fitting ??= last;
  }
  // DENSITIES is not empty, so the loop ran at least once.
  return fitting ?? (last as Layout);
}

/** Every cell a route's straightened polyline passes through, as "x,y". */
export function routeCells(points: readonly Point[]): Set<string> {
  const cells = new Set<string>();
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point,
      b = points[i + 1] as Point;
    const dx = Math.sign(b.x - a.x),
      dy = Math.sign(b.y - a.y);
    for (let x = a.x, y = a.y; ; x += dx, y += dy) {
      cells.add(`${x},${y}`);
      if (x === b.x && y === b.y) break;
    }
  }
  return cells;
}

/** Whether every label has a cell of its own route within a space of it. */
export function labelsAttached(drawn: Layout): boolean {
  return drawn.routes.every((route) => {
    if (!route.label) return true;
    const cells = routeCells(straighten(route.points));
    const { x, y, text } = route.label;
    for (let cx = x - 2; cx <= x + text.length + 3; cx++)
      for (let cy = y - 1; cy <= y + 1; cy++) if (cells.has(`${cx},${cy}`)) return true;
    return false;
  });
}

// Archer's browser captions a node with its kind; the same words here.
const CAPTIONS: Readonly<Record<string, string>> = {
  person: "Person",
  system: "System",
  container: "Container",
  component: "Component",
  database: "Database",
  external: "External",
};

/**
 * A node's kind: the first of its classes that names one. Other classes
 * (custom categories) neither caption nor colour the node in the terminal.
 */
export const kindOf = (node: GraphNode): string | undefined => node.classes?.find((c) => Object.hasOwn(CAPTIONS, c));
export const captionOf = (kind: string | undefined): string | undefined => (kind ? CAPTIONS[kind] : undefined);
/** As Archer's browser draws it: a database that is a plain rectangle is a cylinder. */
export const outlineOf = (shape: NodeShape, kind: string | undefined): NodeShape =>
  shape === "rectangle" && kind === "database" ? "cylinder" : shape;

/**
 * Edges in the order a reader follows them: by how far their source is from
 * a node nothing points at, then as the model lists them. The wire model sorts
 * edges by id, so numbering in model order would scatter the numbers across
 * the drawing. A cycle stops deepening after one pass per node.
 */
export function flowOrder(graph: GraphInput): GraphEdge[] {
  const depth = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let changed = false;
    for (const e of graph.edges) {
      const next = (depth.get(e.source) ?? 0) + 1;
      if (e.source !== e.target && next > (depth.get(e.target) ?? 0)) {
        depth.set(e.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return graph.edges
    .map((e, i) => ({ e, i, d: depth.get(e.source) ?? 0 }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map(({ e }) => e);
}

/**
 * ELK sizes a group to its members, not its title. A title that does not fit
 * on the frame's top edge is laid out again with rows reserved inside the
 * frame, so it is shown whole instead of cut.
 */
export async function layout(graph: GraphInput, density: Density = DENSITIES[0]): Promise<Layout> {
  const first = await layoutOnce(graph, density, new Map());
  const titleRows = new Map<string, number>();
  for (const b of first.boxes) {
    const title = b.lines[0] ?? "";
    if (b.group && title.length > b.width - 6) titleRows.set(b.id, wrap(title, Math.max(8, b.width - 4)).length);
  }
  return titleRows.size ? layoutOnce(graph, density, titleRows) : first;
}

interface Prepared {
  readonly node: GraphNode;
  readonly lines: string[];
  readonly kind: string | undefined;
  readonly outline: NodeShape;
  readonly caption: string | undefined;
}

async function layoutOnce(
  graph: GraphInput,
  density: Density,
  titleRows: ReadonlyMap<string, number>,
): Promise<Layout> {
  const direction: Direction = graph.direction ?? "tb";
  const vertical = direction === "tb" || direction === "bt";
  // ELK does not inherit spacing into a nested group, so every level gets it.
  const spacing: Record<string, string> = {
    "elk.algorithm": "layered",
    "elk.direction": ELK_DIRECTION[direction],
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    // Rows are about twice as tall as columns are wide, so the gap across a
    // layer is counted in columns and the gap between layers in rows.
    "elk.spacing.nodeNode": vertical ? String(density.gap) : "1",
    "elk.layered.spacing.nodeNodeBetweenLayers": vertical ? "2" : "4",
    "elk.spacing.edgeNode": vertical ? "2" : "1",
    "elk.spacing.edgeEdge": vertical ? "2" : "1",
    // Two cells between a node and the nearest bend: one for the arrowhead and
    // one for the corner, so a head never has to share a cell with a turn.
    "elk.layered.spacing.edgeNodeBetweenLayers": "2",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "1",
    "elk.spacing.edgeLabel": "0",
  };

  const prepared = new Map<string, Prepared>(
    graph.nodes.map((node) => {
      const kind = kindOf(node);
      return [
        node.id,
        {
          node,
          lines: wrap(node.label, density.wrap),
          kind,
          outline: outlineOf(node.shape ?? "rectangle", kind),
          caption: captionOf(kind),
        },
      ];
    }),
  );
  const ins = new Map<string, number>(),
    outs = new Map<string, number>();
  for (const e of graph.edges) {
    outs.set(e.source, (outs.get(e.source) ?? 0) + 1);
    ins.set(e.target, (ins.get(e.target) ?? 0) + 1);
  }
  const room = (id: string): number => 2 * Math.max(ins.get(id) ?? 0, outs.get(id) ?? 0) + 3;

  const nodeElement = (p: Prepared): ElkNode => {
    const { node, lines, caption, outline } = p;
    const inner = Math.max(...lines.map((l) => l.length), caption?.length ?? 0);
    return {
      id: node.id,
      // Odd sizes put a side's middle on a whole cell, so a port there and
      // the straight route ELK lines up with it round to the same row.
      // A side needs a cell per port, a cell between ports and one clear
      // of each corner, or ELK pushes ports onto the corners.
      width: odd(
        Math.max(inner + (outline === "circle" ? 8 : outline === "subroutine" ? 6 : 4), vertical ? room(node.id) : 0),
      ),
      height: odd(
        Math.max(
          lines.length + 2 + (caption ? 1 : 0) + (outline === "cylinder" ? 1 : 0) + (outline === "circle" ? 2 : 0),
          vertical ? 0 : room(node.id),
        ),
      ),
      // Every edge end is a port on the side facing the flow, spread along
      // that side, so no route arrives at a corner.
      layoutOptions: {
        "elk.portConstraints": "FIXED_SIDE",
        "elk.portAlignment.default": "DISTRIBUTED",
        "elk.spacing.portsSurrounding": "[top=1,left=1,bottom=1,right=1]",
        "elk.spacing.portPort": "2",
      },
      ports: graph.edges.flatMap((e) => [
        ...(e.source === node.id
          ? [{ id: `${e.id}:out`, width: 0, height: 0, layoutOptions: { "elk.port.side": OUT_SIDE[direction] } }]
          : []),
        ...(e.target === node.id
          ? [{ id: `${e.id}:in`, width: 0, height: 0, layoutOptions: { "elk.port.side": IN_SIDE[direction] } }]
          : []),
      ]),
    };
  };
  const children = (parent: string | undefined): ElkNode[] => [
    ...graph.groups
      .filter((g) => (g.parentId ?? undefined) === parent)
      .map((g) => ({
        // Archer lets a subgraph and a node share an id; ELK does not.
        id: `group:${g.id}`,
        layoutOptions: {
          ...spacing,
          "elk.padding": `[top=${(titleRows.get(g.id) ?? 0) + 2},left=2,bottom=1,right=2]`,
        },
        children: children(g.id),
      })),
    ...[...prepared.values()].filter((p) => (p.node.groupId ?? undefined) === parent).map(nodeElement),
  ];

  const labelled = flowOrder(graph).filter((e) => e.label);
  // A label's line break is drawn as a space: an edge label is one row.
  const shown = new Map(
    labelled.map((e, i) => [e.id, density.numbered ? String(i + 1) : (e.label as string).replace(/\n/g, " ")]),
  );

  const root: ElkNode = {
    id: "root",
    layoutOptions: { ...spacing, "elk.padding": "[top=0,left=0,bottom=0,right=0]" },
    children: children(undefined),
    edges: graph.edges.map((e) => {
      const text = shown.get(e.id);
      return {
        id: e.id,
        sources: [`${e.id}:out`],
        targets: [`${e.id}:in`],
        labels: text ? [{ text, width: text.length + 2, height: 1 }] : [],
      };
    }),
  };

  const done = await new ELK().layout(root);

  // ELK reports a node relative to its parent and an edge relative to the
  // container it names, so absolute origins are collected on the way down.
  const origin = new Map<string, Point>([["root", { x: 0, y: 0 }]]);
  const groups = new Map(graph.groups.map((g) => [g.id, g]));
  const boxes: Box[] = [];
  const walk = (node: ElkNode, ox: number, oy: number): void => {
    for (const child of node.children ?? []) {
      const x = ox + (child.x ?? 0);
      const y = oy + (child.y ?? 0);
      origin.set(child.id, { x, y });
      const width = Math.round(child.width ?? 0);
      const at = { x: Math.round(x), y: Math.round(y), width, height: Math.round(child.height ?? 0) };
      const group = child.id.startsWith("group:") ? groups.get(child.id.slice(6)) : undefined;
      if (group) {
        const inside = titleRows.has(group.id);
        boxes.push({
          id: group.id,
          lines: inside ? wrap(group.label, Math.max(8, width - 4)) : [group.label],
          titleInside: inside,
          group: true,
          ...at,
        });
      } else {
        const p = prepared.get(child.id);
        if (!p) throw new Error(`ELK returned unknown node ${child.id}`);
        boxes.push({
          id: child.id,
          lines: p.lines,
          kind: p.kind,
          outline: p.outline,
          caption: p.caption,
          group: false,
          ...at,
        });
      }
      walk(child, x, y);
    }
  };
  walk(done, 0, 0);

  const lineOf = new Map(graph.edges.map((e) => [e.id, e.line ?? "solid"]));
  const twoWay = new Set(graph.edges.filter((e) => e.bidirectional === true).map((e) => e.id));
  const routes: Route[] = [];
  const collect = (node: ElkNode): void => {
    for (const edge of (node.edges ?? []) as (ElkExtendedEdge & { container?: string })[]) {
      const o = origin.get(edge.container ?? node.id) ?? { x: 0, y: 0 };
      const section = edge.sections?.[0];
      if (!section) continue;
      // Cell i covers [i, i + 1): a point in the middle of a side (x.5) is
      // in that side's middle cell, so points are floored, not rounded.
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((p) => ({
        x: Math.floor(o.x + p.x),
        y: Math.floor(o.y + p.y),
      }));
      const l = edge.labels?.[0];
      routes.push({
        id: edge.id,
        line: lineOf.get(edge.id) ?? "solid",
        ...(twoWay.has(edge.id) ? { bidirectional: true } : {}),
        points,
        label: l?.text ? { text: l.text, x: Math.round(o.x + (l.x ?? 0)), y: Math.round(o.y + (l.y ?? 0)) } : undefined,
      });
    }
    (node.children ?? []).forEach(collect);
  };
  collect(done);

  const name = (id: string): string => prepared.get(id)?.node.label ?? id;
  return {
    width: Math.ceil(done.width ?? 0) + 1,
    height: Math.ceil(done.height ?? 0) + 1,
    boxes,
    routes,
    edgeLegend: density.numbered
      ? labelled.map((e, i) => ({
          key: String(i + 1),
          text: `${name(e.source)} ${e.bidirectional === true ? "↔" : "→"} ${name(e.target)}: ${e.label ?? ""}`.replace(
            /\n/g,
            " ",
          ),
        }))
      : undefined,
  };
}
