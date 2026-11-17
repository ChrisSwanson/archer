import type { Category } from "../diagrams/palette";
import type { SourceOrder } from "../diagrams/source-order";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import type { EdgeLine, GraphDirection, LineKeyEntry, ProjectedNode, ProjectedView } from "../diagrams/projection";
import {
  EDGE_LABEL_LEAD_PX,
  NODE_HEIGHT,
  NODE_WIDTH,
  edgeLabelBox,
  meetOutline,
  nodeBox,
  outlineOf,
} from "./graph-metrics";
import { DEFAULT_TYPEFACE, estimateTextWidth, type TypefaceId } from "./text-measure";
import type {
  ArchitectureSide,
  EdgeFigure,
  GraphNotation,
  GroupFigure,
  NodeFigure,
  StateNotePosition,
} from "../diagrams/figures";
import { NOTE_GAP_PX, figureBox, type NoteBox } from "./figure-metrics";
import { simplifyRoutes } from "./route-simplify";
import { withOrderSearch } from "./order-search";
import { writtenOrder } from "../diagrams/source-order";
import { frameToggleRect } from "../nesting/toggle-place";
import {
  captionEnds,
  FRAME_CAPTION_BAND_PX,
  captionSize,
  edgeObstacles,
  findCaptionPlace,
  frameMinimumWidth,
  placeCaption,
  widthToClear,
} from "./captions";

export { NODE_HEIGHT, NODE_WIDTH };

/**
 * The room either side of a layer, along the flow.
 *
 * ELK gives a captioned wire a layer of its own for the caption and applies
 * this gap on BOTH sides of it, so a captioned hop costs twice this plus the
 * caption and an uncaptioned one costs it once -- still room for the arrowhead
 * and a visible run of line. With a 10px caption lead (`EDGE_LABEL_LEAD_PX`) a one-line captioned hop is 106px,
 * close to the owner's reference rhythm of about 103px; a much larger gap makes a ten-layer graph too tall to read
 * at any zoom that shows all of it.
 */
export const LAYER_GAP = 32;

export type LayoutNode = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly shape: string | undefined;
  readonly classes: readonly string[];
  readonly groupId: string | undefined;
  /** What the node is drawn as, for the newer diagram types (`figures.ts`). */
  readonly figure?: NodeFigure;
  /** Where a state's note is drawn, in the same coordinates as the node. */
  readonly note?: LayoutNote;
  /** A closed container of the nested view (`nesting/nest-view.ts`), as projected. */
  readonly folded?: ProjectedNode["folded"];
};

/** The row a closed container's "N inside" caption takes under its label, and its type size. */
const NEST_CAPTION_ROW_PX = 16;
export const NEST_CAPTION_FONT_PX = 12;

/** A closed box with a caption is one row taller, and wide enough for the caption. */
function withNestCaption<T extends { width: number; height: number }>(
  sized: T,
  caption: string | undefined,
  typeface: TypefaceId,
): T {
  if (caption === undefined) return sized;
  const width = Math.max(sized.width, estimateTextWidth(caption, NEST_CAPTION_FONT_PX, false, typeface) + 24);
  return { ...sized, width, height: sized.height + NEST_CAPTION_ROW_PX };
}

/** A note beside a state: its sheet, in absolute coordinates, and its rows. */
export type LayoutNote = NoteBox & {
  readonly x: number;
  readonly y: number;
  readonly position: StateNotePosition;
  readonly text: string;
};

export type LayoutPoint = { readonly x: number; readonly y: number };

export type LayoutEdge = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label: string | undefined;
  /** How the line is drawn; absent means solid, as on the wire. */
  readonly line?: EdgeLine;
  /** An arrowhead at each end, as on the wire. */
  readonly bidirectional?: boolean;
  /** ELK's routed polyline. Empty when ELK returned no section for the edge. */
  readonly points: readonly LayoutPoint[];
  /** Where the caption is drawn: a point ON this edge's own polyline, chosen
   *  near the space ELK reserved and slid clear of captions already placed. */
  readonly labelAnchor: { x: number; y: number; width: number; height: number } | undefined;
  /** What the edge's ends look like, for the newer diagram types. */
  readonly figure?: EdgeFigure;
};

export type LayoutGroup = {
  readonly id: string;
  readonly label: string;
  readonly parentId: string | undefined;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The group is a model element, selected as a node (`ProjectedGroup.element`). */
  readonly element?: boolean;
  readonly figure?: GroupFigure;
  /** A subgraph's kind or authored category (`ProjectedGroup.classes`). */
  readonly classes?: readonly string[];
  /**
   * Where the group's caption is drawn, in the same coordinates: inside the
   * frame's top band, clear of every wire, end mark and edge caption
   * (`layout/captions.ts`). Absent on a hand-built layout, which draws it at
   * the band's home on the left.
   */
  readonly caption?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
};

export type LayoutResult = {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
  readonly groups: readonly LayoutGroup[];
  readonly width: number;
  readonly height: number;
  /** The direction the graph flows in. Absent means `tb`, as on the wire, so
   *  a hand-built layout need not state it. */
  readonly direction?: GraphDirection;
  /** The face every box here was sized for. The canvas draws each label in
   *  the rows the layout wrapped it into, so it wraps in the same face.
   *  Absent means the default, so a hand-built layout need not state it. */
  readonly typeface?: TypefaceId;
  /** The notation the graph is drawn in; absent means a flowchart. */
  readonly notation?: GraphNotation;
  /** What the model says it is, drawn over the canvas (`ProjectedView.heading`). */
  readonly heading?: string;
  /** What its line patterns mean, in the author's words (`ProjectedView.lineKey`). */
  readonly lineKey?: readonly LineKeyEntry[];
  /** The authored categories its nodes and groups wear (`ProjectedView.categories`). */
  readonly categories?: readonly Category[];
  /** Where the source writes its nodes, groups and edges (`ProjectedView.sourceOrder`). */
  readonly sourceOrder?: SourceOrder;
};

const ROOT_ID = "__archer_root__";

/** Which axis a caption's lead runs along: the flow's, where its layer is. */
function leadFor(direction: GraphDirection): { x: number; y: number } {
  return direction === "lr" || direction === "rl" ? { x: EDGE_LABEL_LEAD_PX, y: 0 } : { x: 0, y: EDGE_LABEL_LEAD_PX };
}

const ROOT_LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.spacing.nodeNodeBetweenLayers": String(LAYER_GAP),
  "elk.spacing.edgeLabel": "6",
  "elk.spacing.componentComponent": "72",
  "elk.spacing.nodeNode": "56",
  "elk.spacing.edgeNode": "32",
  "elk.spacing.edgeEdge": "20",
};

/** The caption sits in a band across the top of a group whichever way the
 *  graph flows, so the padding does not turn with the direction. */
const GROUP_LAYOUT_OPTIONS = {
  "elk.padding": `[top=${FRAME_CAPTION_BAND_PX},left=20,bottom=20,right=20]`,
};

/**
 * The option that keeps a group at least as wide as its caption.
 *
 * ELK reads a compound node's minimum size in its own frame, which is turned
 * for a graph that flows up or down: there the pair is (height, width).
 * Measured with elkjs 0.11 -- `(600, 20)` on a group in a `DOWN` graph made
 * it 600 TALL -- and pinned by `group-captions.test.ts`.
 */
function minimumWidthOptions(width: number, direction: GraphDirection): Record<string, string> {
  const vertical = direction === "tb" || direction === "bt";
  return {
    "elk.nodeSize.constraints": "[MINIMUM_SIZE]",
    "elk.nodeSize.minimum": vertical ? `(0, ${width})` : `(${width}, 0)`,
  };
}

/** How a flowchart's loops are broken (measured against the alternatives, 2026-11-12; see `cycles`). */
const FLOWCHART_CYCLE_BREAKING = "DEPTH_FIRST";

/** The source's flow direction, in ELK's words. */
const ELK_DIRECTION: Record<GraphDirection, string> = {
  tb: "DOWN",
  bt: "UP",
  lr: "RIGHT",
  rl: "LEFT",
};

function byId<T extends { readonly id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The nested view's drawn ids: a closed container stands where its group is written (`nesting/nest-view.ts`). */
const DRAWN_GROUP_PREFIX = "group:";

/**
 * Comparators putting nodes, groups and edges in the order the source writes them (`writtenOrder`). A drawn id the
 * source does not name (a closed container's `group:` box, a nested view's bundle) takes its group's place, or else
 * follows everything named, by id.
 */
function writtenRanks(view: ProjectedView): {
  nodes: (a: { id: string }, b: { id: string }) => number;
  groups: (a: { id: string }, b: { id: string }) => number;
  edges: (a: { id: string }, b: { id: string }) => number;
} {
  const order = writtenOrder(view);
  const nodeRank = new Map<string, number>();
  const groupRank = new Map<string, number>();
  order.elements.forEach((element, index) => {
    (element.kind === "node" ? nodeRank : groupRank).set(element.id, index);
  });
  const edgeRank = new Map(order.edges.map((id, index) => [id, index]));
  const by =
    (rank: (id: string) => number | undefined) =>
    (a: { id: string }, b: { id: string }): number => {
      const ra = rank(a.id) ?? Number.POSITIVE_INFINITY;
      const rb = rank(b.id) ?? Number.POSITIVE_INFINITY;
      return ra !== rb ? ra - rb : byId(a, b);
    };
  return {
    nodes: by(
      (id) =>
        nodeRank.get(id) ??
        (id.startsWith(DRAWN_GROUP_PREFIX) ? groupRank.get(id.slice(DRAWN_GROUP_PREFIX.length)) : groupRank.get(id)),
    ),
    groups: by((id) => groupRank.get(id)),
    edges: by((id) => edgeRank.get(id)),
  };
}

/**
 * Lays a graph out with ELK, and puts every caption on its own wire and every
 * frame's caption in its band.
 *
 * A frame whose band every wire into it happens to cross has nowhere to put
 * its caption; it is given a minimum width that leaves a run free and the
 * graph is laid out once more (`widthToClear`). Most graphs need one pass.
 */
export interface LayoutEngine {
  layout(graph: ElkNode): Promise<ElkNode>;
}

export async function computeLayout(
  view: ProjectedView,
  typeface: TypefaceId = DEFAULT_TYPEFACE,
  engine: LayoutEngine,
): Promise<LayoutResult> {
  // Written order unless another start is better on every measure (`order-search.ts`).
  return withOrderSearch(view, typeface, async (laid) => {
    const first = await layoutOnce(laid, typeface, new Map(), engine);
    if (first.blocked.size === 0) return first.layout;
    return (await layoutOnce(laid, typeface, first.blocked, engine)).layout;
  });
}

/** The id ELK knows a group by: its own, kept apart from a node that shares it. */
const ELK_GROUP_PREFIX = "__archer_group__";

async function layoutOnce(
  view: ProjectedView,
  typeface: TypefaceId,
  widened: ReadonlyMap<string, number>,
  engine: LayoutEngine,
): Promise<{ layout: LayoutResult; blocked: Map<string, number> }> {
  // ELK reads its input's order as the model's (`considerModelOrder`, and the cycle breaking below): the source's
  // written order, so loops are broken against the way the author wrote the flow (owner, 2026-11-12). The result
  // lists are by id, as before. Without a `sourceOrder` the lists' own order is the written one (`writtenOrder`).
  const written = writtenRanks(view);
  const sortedNodes = [...view.nodes].sort(written.nodes);
  const sortedEdges = [...view.edges].sort(written.edges);
  const sortedGroups = [...view.groups].sort(written.groups);
  const direction: GraphDirection = view.direction ?? "tb";
  // Stated on the root AND on every group: a group is a layout scope of its
  // own, and one that did not carry the direction would flow downwards inside
  // a graph that flows sideways.
  const flow = { "elk.direction": ELK_DIRECTION[direction] };
  // ELK's default 10-unit terminal stub leaves under one unit of shaft behind
  // our painted arrowhead. Reserve a real terminal lane during routing; a
  // renderer cannot lengthen it safely without crossing nodes or captions.
  // System diagrams also use explicit side ports and nested routing scopes.
  // Keep ordinary flow graphs' existing compact inter-layer spacing.
  const arrowLanes: Record<string, string> =
    view.kind === "c4" || view.kind === "architecture"
      ? { "elk.spacing.edgeNode": "40", "elk.layered.spacing.edgeNodeBetweenLayers": "40" }
      : {};

  const groupElkNodes = new Map<string, ElkNode>();
  for (const group of sortedGroups) {
    const minimum = Math.max(frameMinimumWidth(group, typeface), widened.get(group.id) ?? 0);
    groupElkNodes.set(group.id, {
      id: `${ELK_GROUP_PREFIX}${group.id}`,
      children: [],
      layoutOptions: {
        ...GROUP_LAYOUT_OPTIONS,
        ...arrowLanes,
        ...minimumWidthOptions(minimum, direction),
        ...flow,
      },
    });
  }
  const groupOfElkId = new Map(sortedGroups.map((group) => [`${ELK_GROUP_PREFIX}${group.id}`, group.id]));

  // A flowchart's loops are broken against the order its author wrote the flow (`writtenRanks`): a depth-first walk
  // from the first-written source, so "1. Ask" leads and a loop back to "2. Write the plan" goes up the side, as the
  // owner's reference draws it. Other notations keep ELK's default.
  const cycles: Record<string, string> =
    view.notation === undefined || view.notation === "flowchart"
      ? { "elk.layered.cycleBreaking.strategy": FLOWCHART_CYCLE_BREAKING }
      : {};
  const root: ElkNode = {
    id: ROOT_ID,
    layoutOptions: { ...ROOT_LAYOUT_OPTIONS, ...arrowLanes, ...cycles, ...flow },
    children: [],
    edges: [],
  };

  // Attach group nodes to their parent group (or root) to support nesting.
  for (const group of sortedGroups) {
    const elkGroup = groupElkNodes.get(group.id)!;
    const parent = group.parentId ? groupElkNodes.get(group.parentId) : undefined;
    const container = parent ?? root;
    container.children = container.children ?? [];
    container.children.push(elkGroup);
  }

  // A group that holds nothing (a C4 boundary or an architecture group with
  // no members yet) is laid out as a box of its own size, so its frame can
  // be seen and pointed at.
  const filled = new Set([
    ...view.nodes.flatMap((node) => (node.groupId === undefined ? [] : [node.groupId])),
    ...view.groups.flatMap((group) => (group.parentId === undefined ? [] : [group.parentId])),
  ]);
  const groupFor = new Map(sortedGroups.map((group) => [group.id, group]));
  for (const [id, elkGroup] of groupElkNodes) {
    if (!filled.has(id)) {
      // A leaf to ELK, sized outright: a minimum size on a leaf is not turned
      // with the direction as a compound node's is, so it is not given one.
      elkGroup.width = Math.max(
        EMPTY_FRAME.width,
        frameMinimumWidth(groupFor.get(id)!, typeface),
        widened.get(id) ?? 0,
      );
      elkGroup.height = EMPTY_FRAME.height;
      const {
        ["elk.nodeSize.constraints"]: _constraints,
        ["elk.nodeSize.minimum"]: _minimum,
        ...rest
      } = elkGroup.layoutOptions ?? {};
      elkGroup.layoutOptions = rest;
    }
  }

  // Peers share a width (the references' cards in one column are one width): a described card within
  // `PEER_WIDTH_SHARE` of the widest described card in its panel is drawn at that width. Never narrower.
  const peerWidth = peerWidths(sortedNodes, typeface);

  // Attach leaf nodes to their group (or root).
  const notes = new Map<string, { box: NoteBox; position: StateNotePosition; text: string; asNode: boolean }>();
  const leafElkNodes = new Map<string, ElkNode>();
  for (const node of sortedNodes) {
    // Sized from the label, so a two- or three-line label gets a taller box
    // (and a circle or a diamond a wider one) instead of overflowing it.
    const sized = withNestCaption(
      node.figure === undefined
        ? nodeBox(node.label, node.shape, node.classes, typeface, node.folded !== undefined)
        : figureBox(node.figure, node.label, node.shape, direction, typeface, node.folded !== undefined),
      node.folded?.caption,
      typeface,
    );
    const width = Math.max(sized.width, peerWidth.get(node.id) ?? 0);
    const { height } = sized;
    const elkNode: ElkNode = { id: node.id, width, height };
    leafElkNodes.set(node.id, elkNode);
    const container = node.groupId ? groupElkNodes.get(node.groupId) : undefined;
    const target = container ?? root;
    target.children = target.children ?? [];
    target.children.push(elkNode);
    const note = node.figure?.type === "state" ? node.figure.note : undefined;
    if (note !== undefined && "note" in sized && sized.note !== undefined) {
      const asNode = placeNote(elkNode, sized.note, note.position, direction, target);
      notes.set(node.id, { box: sized.note, position: note.position, text: note.text, asNode });
    }
  }

  const groupOfNode = new Map(sortedNodes.map((n) => [n.id, n.groupId]));
  /** Edges whose ends were moved onto a group's frame, by the ends ELK was given. */
  const endsOnFrame = new Map<string, { source: string; target: string }>();
  const parentOfGroup = new Map(sortedGroups.map((g) => [g.id, g.parentId]));
  const ancestry = (nodeId: string): string[] => {
    const chain: string[] = [];
    // An edge may end on a group that is a model element (a composite state):
    // its chain starts at the group it sits in.
    let cursor = parentOfGroup.has(nodeId) ? parentOfGroup.get(nodeId) : groupOfNode.get(nodeId);
    while (cursor) {
      chain.push(cursor);
      cursor = parentOfGroup.get(cursor);
    }
    return chain;
  };
  /*
   * An architecture edge leaves and enters by a declared SIDE, as a port ELK
   * must keep on that side; and an end written `{group}` meets the frame of
   * the group its service is in rather than the service. That substitution is
   * skipped where it would join a group to something inside it, which has no
   * side to leave by.
   */
  const contains = (outer: string, inner: string): boolean => outer === inner || ancestry(inner).includes(outer);
  /** What ELK calls an edge's end: a node, unless the end is a group's frame. */
  const elkEnd = (id: string, onFrame: boolean): string =>
    (onFrame ? groupElkNodes.get(id)?.id : undefined) ??
    (leafElkNodes.has(id) ? id : (groupElkNodes.get(id)?.id ?? id));
  const portOn = (ownerId: string, onFrame: boolean, side: ArchitectureSide): string => {
    const owner = (onFrame ? undefined : leafElkNodes.get(ownerId)) ?? groupElkNodes.get(ownerId);
    if (owner === undefined) return ownerId;
    const id = `${owner.id}${PORT_INFIX}${side}`;
    owner.ports = owner.ports ?? [];
    if (!owner.ports.some((port) => port.id === id)) {
      owner.ports.push({ id, width: 0, height: 0, layoutOptions: { "elk.port.side": ELK_SIDE[side] } });
    }
    owner.layoutOptions = { ...owner.layoutOptions, "elk.portConstraints": "FIXED_SIDE" };
    return id;
  };
  /** The lead each caption was padded with, to take off what ELK placed. */
  const leadById = new Map<string, { x: number; y: number }>();
  for (const edge of sortedEdges) {
    const ports = edge.figure?.type === "ports" ? edge.figure : undefined;
    let from = edge.source;
    let to = edge.target;
    if (ports !== undefined) {
      const sourceGroup = ports.sourceGroup ? groupOfNode.get(edge.source) : undefined;
      if (sourceGroup !== undefined && !contains(sourceGroup, to) && !contains(to, sourceGroup)) from = sourceGroup;
      const targetGroup = ports.targetGroup ? groupOfNode.get(edge.target) : undefined;
      if (targetGroup !== undefined && !contains(targetGroup, from) && !contains(from, targetGroup)) to = targetGroup;
    }
    const targetChain = new Set(ancestry(to));
    const lca = ancestry(from).find((id) => targetChain.has(id));
    const owner = lca ? groupElkNodes.get(lca) : undefined;
    const container = owner ?? root;
    container.edges = container.edges ?? [];
    const fromFrame = from !== edge.source;
    const toFrame = to !== edge.target;
    const elkEdge: ElkExtendedEdge = {
      id: edge.id,
      sources: [ports === undefined ? elkEnd(from, fromFrame) : portOn(from, fromFrame, ports.sourceSide)],
      targets: [ports === undefined ? elkEnd(to, toFrame) : portOn(to, toFrame, ports.targetSide)],
    };
    if (from !== edge.source || to !== edge.target) endsOnFrame.set(edge.id, { source: from, target: to });
    const caption = edge.caption ?? edge.label;
    if (caption) {
      // The box the caption is DRAWN in -- its wrapped rows plus the plate's
      // padding, in the rendered font -- so two captions ELK keeps apart stay
      // apart on screen.
      const { width, height } = edgeLabelBox(caption, typeface);
      // ...plus a lead of visible line before and after it ALONG the edge
      // (ADR 0030: a label never hides its line). An inline label is a dummy
      // node in a layer of its own, so its thickness along the flow becomes
      // line at both ends of the plate; only labelled hops pay for it. Taken
      // off again in `collectRoutes`, so the plate is drawn at its real size.
      // A self-loop's label is not a layer dummy and is placed beside its loop.
      const lead = edge.source === edge.target ? { x: 0, y: 0 } : leadFor(direction);
      // A CENTER edge label becomes a label dummy node during layering, so ELK
      // reserves real space for it and routes around it. That only works if the
      // label carries dimensions. `inline` puts that reservation ON the wire
      // rather than beside it, which is where the caption is drawn: every
      // other wire is then routed clear of the plate, not just of a box next
      // to it.
      leadById.set(edge.id, lead);
      elkEdge.labels = [
        {
          id: `${edge.id}__label`,
          text: caption,
          width: width + 2 * lead.x,
          height: height + 2 * lead.y,
          layoutOptions: { "elk.edgeLabels.inline": "true" },
        },
      ];
    }
    container.edges.push(elkEdge);
  }

  const laidOut = await engine.layout(root);

  const nodeById = new Map(sortedNodes.map((n) => [n.id, n]));
  const groupById = new Map(sortedGroups.map((g) => [g.id, g]));
  const groupRects = new Map<string, { x: number; y: number; width: number; height: number }>();
  const noteRects = new Map<string, { x: number; y: number }>();
  const resultNodes: LayoutNode[] = [];

  function walk(elkNode: ElkNode, offsetX: number, offsetY: number): void {
    const absX = offsetX + (elkNode.x ?? 0);
    const absY = offsetY + (elkNode.y ?? 0);
    const groupId = groupOfElkId.get(elkNode.id);
    if (groupId !== undefined && groupById.has(groupId)) {
      groupRects.set(groupId, {
        x: absX,
        y: absY,
        width: elkNode.width ?? 0,
        height: elkNode.height ?? 0,
      });
    }
    if (elkNode.id.endsWith(NOTE_SUFFIX)) {
      noteRects.set(elkNode.id.slice(0, -NOTE_SUFFIX.length), { x: absX, y: absY });
    }
    const projected = nodeById.get(elkNode.id);
    if (projected) {
      resultNodes.push({
        id: projected.id,
        x: absX,
        y: absY,
        width: elkNode.width ?? NODE_WIDTH,
        height: elkNode.height ?? NODE_HEIGHT,
        label: projected.label,
        shape: projected.shape,
        classes: projected.classes,
        groupId: projected.groupId,
        ...(projected.figure === undefined ? {} : { figure: projected.figure }),
        ...(projected.folded === undefined ? {} : { folded: projected.folded }),
      });
    }
    for (const child of elkNode.children ?? []) {
      walk(child, absX, absY);
    }
  }

  for (const child of laidOut.children ?? []) {
    walk(child, 0, 0);
  }

  resultNodes.sort(byId);
  // Each note where it was put: beside its state in the margin ELK kept for
  // it, or where ELK placed it as a node of its own.
  for (const [index, node] of resultNodes.entries()) {
    const note = notes.get(node.id);
    if (note === undefined) continue;
    const placed = note.asNode ? noteRects.get(node.id) : undefined;
    const x =
      placed?.x ??
      (note.position === "left-of" ? node.x - NOTE_GAP_PX - note.box.width : node.x + node.width + NOTE_GAP_PX);
    const y = placed?.y ?? node.y + node.height / 2 - note.box.height / 2;
    resultNodes[index] = { ...node, note: { ...note.box, x, y, position: note.position, text: note.text } };
  }

  // ELK routed every edge around the nodes and group boxes it just placed.
  // Collect those polylines instead of discarding them: without this the
  // renderer has to invent its own path, which is why edges used to cut
  // straight through boxes.
  const routeById = new Map<string, LayoutPoint[]>();
  const labelBoxById = new Map<string, { x: number; y: number; width: number; height: number }>();
  function collectRoutes(container: ElkNode, offsetX: number, offsetY: number): void {
    for (const elkEdge of (container as { edges?: ElkExtendedEdge[] }).edges ?? []) {
      const section = elkEdge.sections?.[0];
      if (!section) continue;
      const pts: LayoutPoint[] = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((pt) => ({
        x: pt.x + offsetX,
        y: pt.y + offsetY,
      }));
      routeById.set(elkEdge.id, pts);
      const placed = elkEdge.labels?.[0];
      if (placed && (placed.x !== undefined || placed.y !== undefined)) {
        const lead = leadById.get(elkEdge.id) ?? { x: 0, y: 0 };
        labelBoxById.set(elkEdge.id, {
          x: (placed.x ?? 0) + offsetX + lead.x,
          y: (placed.y ?? 0) + offsetY + lead.y,
          width: (placed.width ?? 0) - 2 * lead.x,
          height: (placed.height ?? 0) - 2 * lead.y,
        });
      }
    }
    for (const child of container.children ?? []) {
      collectRoutes(child, offsetX + (child.x ?? 0), offsetY + (child.y ?? 0));
    }
  }
  collectRoutes(laidOut, 0, 0);

  // ELK ends every wire on a node's bounding box. For a diamond, a circle or
  // the cap of a stadium the outline is inside that box, so the wire is
  // carried on along its own direction until it reaches what is drawn.
  const laidOutById = new Map(resultNodes.map((node) => [node.id, node]));
  const reach = (nodeId: string, end: LayoutPoint, neighbour: LayoutPoint): LayoutPoint => {
    const node = laidOutById.get(nodeId);
    const length = Math.hypot(end.x - neighbour.x, end.y - neighbour.y);
    if (!node || length === 0) return end;
    const span = Math.max(node.width, node.height);
    const towards = {
      x: end.x + ((end.x - neighbour.x) / length) * span,
      y: end.y + ((end.y - neighbour.y) / length) * span,
    };
    return meetOutline(outlineOf(node.shape, node.classes), node, end, towards);
  };

  const resultEdges: LayoutEdge[] = [...sortedEdges].sort(byId).map((edge) => {
    const points = [...(routeById.get(edge.id) ?? [])];
    const ends = endsOnFrame.get(edge.id) ?? edge;
    if (points.length >= 2) {
      points[0] = reach(ends.source, points[0], points[1]);
      const last = points.length - 1;
      points[last] = reach(ends.target, points[last], points[last - 1]);
    }
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.caption ?? edge.label,
      ...(edge.line === undefined ? {} : { line: edge.line }),
      ...(edge.bidirectional === true ? { bidirectional: true } : {}),
      points,
      labelAnchor: undefined,
      ...(edge.figure === undefined ? {} : { figure: edge.figure }),
    };
  });

  placeLabelsOnRoutes(resultEdges, labelBoxById, resultNodes);

  // Every caption keeps off what the edges draw, and off the nodes.
  const captionObstacles = [...edgeObstacles(resultEdges), ...resultNodes];
  const ends = captionEnds(view);
  // A frame whose band is taken end to end, and how wide it would have to be.
  const blocked = new Map<string, number>();
  const resultGroups: LayoutGroup[] = [...sortedGroups].sort(byId).map((g) => {
    const rect = groupRects.get(g.id) ?? { x: 0, y: 0, width: 0, height: 0 };
    const size = captionSize(g, typeface);
    const end = ends.get(g.id) ?? "start";
    // Placed from the right, a caption keeps clear of where the nested view draws the frame's "−".
    const obstacles = end === "end" ? [...captionObstacles, frameToggleRect(rect)] : captionObstacles;
    if (findCaptionPlace(rect, size, obstacles, end) === null) {
      blocked.set(g.id, widthToClear(rect, size, obstacles));
    }
    return {
      id: g.id,
      label: g.label,
      parentId: g.parentId,
      ...rect,
      ...(g.element === true ? { element: true } : {}),
      ...(g.figure === undefined ? {} : { figure: g.figure }),
      ...(g.classes === undefined ? {} : { classes: g.classes }),
      caption: placeCaption(rect, size, obstacles, end),
    };
  });

  const layout: LayoutResult = {
    nodes: resultNodes,
    edges: resultEdges,
    groups: resultGroups,
    width: laidOut.width ?? 0,
    height: laidOut.height ?? 0,
    direction,
    typeface,
    ...(view.notation === undefined ? {} : { notation: view.notation }),
    ...(view.lineKey === undefined ? {} : { lineKey: view.lineKey }),
    ...(view.categories === undefined ? {} : { categories: view.categories }),
    ...(view.sourceOrder === undefined ? {} : { sourceOrder: view.sourceOrder }),
    ...(view.heading === undefined ? {} : { heading: view.heading }),
  };
  // Every wire in the simplest shape its ends allow, where that is clear (`route-simplify.ts`).
  return { layout: simplifyRoutes(layout), blocked };
}

/** How near the widest described card in its panel a card must be to be drawn at that width. */
const PEER_WIDTH_SHARE = 0.75;

/**
 * The width each card shares with its peers: the widest described card (a title over a description) in its panel,
 * for every described card at least `PEER_WIDTH_SHARE` of it. A figure, a closed container, a circle or a diamond
 * (whose width is also its height) and a title-only card keep their own.
 */
function peerWidths(nodes: readonly ProjectedNode[], typeface: TypefaceId): Map<string, number> {
  const panels = new Map<string, { id: string; width: number }[]>();
  for (const node of nodes) {
    if (node.figure !== undefined || node.folded !== undefined || !node.label.includes("\n")) continue;
    const shape = outlineOf(node.shape, node.classes);
    if (shape === "circle" || shape === "diamond") continue;
    const panel = node.groupId ?? ROOT_ID;
    const peers = panels.get(panel) ?? [];
    peers.push({ id: node.id, width: nodeBox(node.label, node.shape, node.classes, typeface).width });
    panels.set(panel, peers);
  }
  const shared = new Map<string, number>();
  for (const peers of panels.values()) {
    const widest = Math.max(...peers.map((peer) => peer.width));
    for (const peer of peers) if (peer.width >= PEER_WIDTH_SHARE * widest) shared.set(peer.id, widest);
  }
  return shared;
}

/** The size of a frame with nothing in it. */
const EMPTY_FRAME = { width: 160, height: 64 };

/** A port's id: its owner's, this, and the side it is on. */
const PORT_INFIX = "__archer_port_";

/** A declared side, in ELK's words. */
const ELK_SIDE: Readonly<Record<ArchitectureSide, string>> = {
  left: "WEST",
  right: "EAST",
  top: "NORTH",
  bottom: "SOUTH",
};

/** The id an ELK node placed for a note carries: its state's, and this. */
const NOTE_SUFFIX = "__archer_note";

/**
 * Keep room for a state's note on the side the source names.
 *
 * Across the flow (a note left or right of a state in a graph that runs
 * down) the room is a MARGIN on the state's box: ELK spaces its neighbours
 * clear of it, and wires still end on the state, since they come in at the
 * top and bottom. Along the flow that margin would sit exactly where the
 * wires leave, so the note is laid out as a node of its own in the next or
 * previous layer, tied to its state by an edge ELK routes and nobody draws.
 * Returns whether the note became a node.
 */
function placeNote(
  state: ElkNode,
  note: NoteBox,
  position: StateNotePosition,
  direction: GraphDirection,
  container: ElkNode,
): boolean {
  const along = direction === "lr" || direction === "rl";
  if (!along) {
    const spare = Math.max(0, Math.ceil((note.height - (state.height ?? 0)) / 2));
    const side = NOTE_GAP_PX + note.width;
    state.layoutOptions = {
      ...state.layoutOptions,
      "elk.margins": `[top=${spare},left=${position === "left-of" ? side : 0},bottom=${spare},right=${position === "right-of" ? side : 0}]`,
    };
    return false;
  }
  const id = `${state.id}${NOTE_SUFFIX}`;
  container.children = container.children ?? [];
  container.children.push({ id, width: note.width, height: note.height });
  // In a graph flowing right a successor is to the right; flowing left, to the left.
  const after = (position === "right-of") === (direction === "lr");
  container.edges = container.edges ?? [];
  container.edges.push({ id: `${id}__tie`, sources: [after ? state.id : id], targets: [after ? id : state.id] });
  return true;
}

/** Project `point` onto a polyline, returning the closest point and how far
 *  along the line it sits. */
function closestOnRoute(
  route: readonly LayoutPoint[],
  point: LayoutPoint,
): { x: number; y: number; at: number; total: number } {
  let best = { x: route[0].x, y: route[0].y, at: 0, total: 0 };
  let bestDist = Infinity;
  let travelled = 0;
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1];
    const b = route[i];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const segLen = Math.hypot(vx, vy);
    const lenSq = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * vx + (point.y - a.y) * vy) / lenSq));
    const px = a.x + vx * t;
    const py = a.y + vy * t;
    const dist = Math.hypot(point.x - px, point.y - py);
    if (dist < bestDist) {
      bestDist = dist;
      best = { x: px, y: py, at: travelled + segLen * t, total: 0 };
    }
    travelled += segLen;
  }
  best.total = travelled;
  return best;
}

/** Walk `distance` along a polyline from its start. */
function pointAt(route: readonly LayoutPoint[], distance: number): LayoutPoint {
  let travelled = 0;
  for (let i = 1; i < route.length; i += 1) {
    const a = route[i - 1];
    const b = route[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (travelled + segLen >= distance) {
      const t = segLen === 0 ? 0 : (distance - travelled) / segLen;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    travelled += segLen;
  }
  return route[route.length - 1];
}

/**
 * Put every caption on its own wire, and keep captions off each other.
 *
 * ELK reserves each caption's box inline on its own wire (see the `inline`
 * label option above) and routes every other wire clear of it, so that
 * position is normally used as it stands. What ELK does not guarantee is that
 * the box is centred on the wire once a route is carried on to a non-rectangular
 * outline, or free where a cross-hierarchy wire is split between containers --
 * so the caption is still snapped to the nearest point of its own polyline and,
 * if it lands on another caption or a node, slid along that polyline, the one
 * direction that cannot detach it from its edge, until it is clear.
 *
 * Deterministic: edges arrive sorted by ID, so the same graph always produces
 * the same placement.
 */
function placeLabelsOnRoutes(
  edges: LayoutEdge[],
  reserved: Map<string, { x: number; y: number; width: number; height: number }>,
  nodes: readonly LayoutNode[],
): void {
  // Node boxes are obstacles from the start, so a caption that has to slide
  // never comes to rest on a node.
  const placed: { x: number; y: number; width: number; height: number }[] = nodes.map((node) => ({
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
  }));
  const overlaps = (a: { x: number; y: number; width: number; height: number }) =>
    placed.some((b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y);

  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i];
    const box = reserved.get(edge.id);
    if (!edge.label || !box || edge.points.length < 2) continue;

    // A self-loop's caption goes BESIDE its loop, never on it: on the loop the
    // plate covers the arrowhead, since the whole loop is shorter than a plate
    // with its lead (ADR 0030). Outside the loop's far side, centred on it.
    if (edge.source === edge.target) {
      const xs = edge.points.map((point) => point.x);
      const ys = edge.points.map((point) => point.y);
      const loop = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
      const node = nodes.find((candidate) => candidate.id === edge.source);
      const centreX = node === undefined ? loop.minX : node.x + node.width / 2;
      const centreY = node === undefined ? loop.minY : node.y + node.height / 2;
      const midX = (loop.minX + loop.maxX) / 2;
      const midY = (loop.minY + loop.maxY) / 2;
      // Beyond the loop, on the side it sticks out of the node.
      const sideways = Math.abs(midX - centreX) >= Math.abs(midY - centreY);
      const candidates = [
        sideways
          ? {
              x: midX >= centreX ? loop.maxX + 4 : loop.minX - box.width - 4,
              y: midY - box.height / 2,
              width: box.width,
              height: box.height,
            }
          : {
              x: midX - box.width / 2,
              y: midY >= centreY ? loop.maxY + 4 : loop.minY - box.height - 4,
              width: box.width,
              height: box.height,
            },
      ];
      const chosen = candidates.find((candidate) => !overlaps(candidate)) ?? candidates[0]!;
      placed.push(chosen);
      edges[i] = { ...edge, labelAnchor: chosen };
      continue;
    }

    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const seed = closestOnRoute(edge.points, centre);
    const rectAt = (at: number) => {
      const p = pointAt(edge.points, at);
      return { x: p.x - box.width / 2, y: p.y - box.height / 2, width: box.width, height: box.height };
    };

    let chosen = rectAt(seed.at);
    if (overlaps(chosen)) {
      const step = 12;
      for (let offset = step; offset <= seed.total; offset += step) {
        const forward = seed.at + offset;
        const back = seed.at - offset;
        if (forward <= seed.total && !overlaps(rectAt(forward))) {
          chosen = rectAt(forward);
          break;
        }
        if (back >= 0 && !overlaps(rectAt(back))) {
          chosen = rectAt(back);
          break;
        }
      }
    }
    placed.push(chosen);
    edges[i] = { ...edge, labelAnchor: chosen };
  }
}
