import type { Edge, Node } from "@xyflow/react";
import type { LayoutGroup, LayoutNote, LayoutResult } from "../layout/elk-adapter";
import type { GraphDirection } from "./projection";
import {
  arrowsOf,
  figureDescription,
  groupDescription,
  type EdgeFigure,
  type GroupFigure,
  type NodeFigure,
} from "./figures";
import { MarkerType } from "@xyflow/react";
import { ownStretch, routeLength } from "../emphasis/EmphasisChevrons";
import { DIMMED_CAPTION, dimmedClass, focusOpacity } from "./focus-style";
import { labelGrounds } from "./label-ground";
import { captionParts, kindOf, outlineOf } from "../layout/graph-metrics";
import type { TypefaceId } from "../layout/text-measure";
import { frameSourceOf } from "../../../shared/explorations.mts";
import { type GroupPanels, groupPanelsOf, indexCategories, nodePalette, paletteClasses } from "./palette";
import { membershipOf, paletteKeyRows } from "./palette-key";
import {
  EMPHASIS_MEMBER_CLASS,
  NO_EMPHASIS,
  type EmphasisAssignment,
  type EmphasisAssignments,
  type EmphasisSpeed,
  type EmphasisStyle,
  emphasisMembership,
} from "../emphasis/contract";

export type DiagramNodeData = {
  label: string;
  shape: string | undefined;
  classes: readonly string[];
  /** The face the layout sized this node for; the node wraps its label in it. */
  typeface: TypefaceId | undefined;
  focused: boolean;
  dimmed: boolean;
  /** Some comment thread is about this node. */
  commented?: boolean;
  /** Its threads' pins, drawn off its top-right corner (`CommentPins.tsx`). */
  pins?: readonly CanvasPin[];
  /** What the node is drawn as, for the newer diagram types (`figures.ts`). */
  figure?: NodeFigure;
  /** A state's note, relative to the node's own top-left corner. */
  note?: LayoutNote;
  /** Which way the graph flows: a fork or join bar stands across it. */
  direction?: GraphDirection;
  /** A closed container of the nested view: what is inside, under its label ("3 nodes inside"). */
  inside?: string;
  /** A closed container of the nested view: it carries the "+", and its label is wrapped clear of it. */
  closed?: true;
};

/** A closed container of the nested view: it can be opened (`nesting/NestToggles.tsx`). */
export const NEST_CLOSED_CLASS = "archer-nest-closed";

/**
 * A nested view's bundle (`nesting/nest-view.ts`, drawn id `bundle:…`, "N connections"): heavier
 * by its member count, computed when drawn and never authored (ADR 0029 §11).
 */
function bundleClasses(edge: { readonly id: string; readonly label: string | undefined }): string {
  if (!edge.id.startsWith("bundle:")) return "";
  const count = Number(/^(\d+) connections$/.exec(edge.label ?? "")?.[1] ?? 2);
  return ` archer-edge-bundle ${count >= 3 ? "archer-bundle-many" : "archer-bundle-two"}`;
}

export type DiagramGroupData = {
  label: string;
  /** A source's frame added by Expand (ADR 0036 A12): the source view it shows a piece of. */
  frameSource?: string;
  /** What frame a group that is a model element is drawn as. */
  figure?: GroupFigure;
  commented?: boolean;
  pins?: readonly CanvasPin[];
  /** An element frame the focus has faded (a plain group never is): its pins are lifted out of it. */
  dimmed?: boolean;
  /** Where the caption is drawn, from the frame's top-left corner (`LayoutGroup.caption`). */
  captionAt?: { readonly x: number; readonly y: number };
};

/** The caption's place inside its frame, as the frame's node draws it. */
function captionAt(group: LayoutGroup): { captionAt?: { x: number; y: number } } {
  return group.caption === undefined
    ? {}
    : { captionAt: { x: group.caption.x - group.x, y: group.caption.y - group.y } };
}

export type DiagramFocus = {
  nodeIds?: string[];
  edgeIds?: string[];
};

export type DiagramSelection = {
  nodeIds?: readonly string[];
  edgeIds?: readonly string[];
};

/**
 * Where the keyboard is, as the canvas needs to draw it.
 *
 * Two ids rather than one, because the two questions have different answers.
 * `stopId` is the ONE node in the page tab order and survives the canvas
 * losing focus, so Tabbing away and back returns the user to where they were.
 * `ringId` is the node currently wearing the visible focus ring, and is null
 * whenever focus is somewhere else -- a ring painted while the keyboard is
 * elsewhere points at a node no key can act on.
 */
export type KeyboardNav = {
  readonly stopId: string | null;
  readonly ringId: string | null;
};

/**
 * What a focused edge is called.
 *
 * Its own caption when it has one, and otherwise the two ends it joins, by
 * their LABELS rather than their ids -- "Web → Database", not "web → db".
 * React Flow's own fallback is `Edge from ${source} to ${target}`, which spells
 * the stable ids; those are authored for Mermaid, not for reading aloud.
 */
/** A label as a name is read: a line break (`<br/>` in the source) is a space. */
const aloud = (text: string): string => text.replace(/\s*\n\s*/g, " ");

export function edgeAccessibleName(label: string | undefined, sourceLabel: string, targetLabel: string): string {
  // `||`, not `??`: an empty caption is not a name. With `??` an empty string
  // survives, and xyflow then treats it as falsy and substitutes "Edge from
  // <id> to <id>" -- the stable ids this function exists to keep out of a
  // screen reader.
  // The ends first, then the caption: a caption alone ("calls") does not say what calls what, and two
  // edges with one caption would share a name (ux:A11Y-5). A line break in a caption is read as a space.
  const ends = `${aloud(sourceLabel)} → ${aloud(targetLabel)}`;
  return label ? `${ends}: ${aloud(label)}` : ends;
}

/** An ER cardinality as the key names it, in a sentence: `zero-or-more` is "zero or more". */
const multiplicity = (cardinality: string): string => cardinality.replaceAll("-", " ");

/**
 * What an ER relationship's ends say, in words (C-02): the drawing's crow's feet and bars, and whether the line is
 * identifying, are otherwise only in the picture and the key. Each end's multiplicity is the model's
 * (`sourceCardinality`/`targetCardinality`); a dotted line is the model's non-identifying relationship
 * (`projectEntityRelationship`). Any other edge adds nothing.
 */
function relationshipFacts(
  figure: EdgeFigure | undefined,
  line: string | undefined,
  sourceLabel: string,
  targetLabel: string,
): string {
  if (figure?.type !== "cardinality") return "";
  const ends = `${multiplicity(figure.source)} ${aloud(sourceLabel)} to ${multiplicity(figure.target)} ${aloud(targetLabel)}`;
  return `, ${ends}, ${line === "dotted" ? "non-identifying" : "identifying"}`;
}

/**
 * Which open container an element is drawn in (Cl-10c), from the model's own nesting (`groupId`, `parentId`): an
 * expanded composite state, a C4 boundary or an architecture group is otherwise only a frame around the boxes, and a
 * screen reader hears them as a flat list.
 */
function containedIn(groupId: string | undefined, groupById: ReadonlyMap<string, LayoutGroup>): string {
  const owner = groupId === undefined ? undefined : groupById.get(groupId);
  return owner === undefined ? "" : `, in ${aloud(owner.label) || owner.id}`;
}

/** No node is focused and nothing is tabbable: the state before a layout. */
export const NO_KEYBOARD_NAV: KeyboardNav = { stopId: null, ringId: null };

/**
 * Archer-owned canvas classes.
 *
 * The canvas stylesheet hangs its base, hover and selected rules off these,
 * never off React Flow's `react-flow__node-<type>` class -- that one is derived
 * from `node.type`, so keying appearance to it means any new node type loses
 * its styling silently. See the ownership note in `src/styles.css`.
 *
 * These are identity classes and are always present. Channel state lives in
 * separate, prefixed namespaces (`archer-focus-*` for presentation focus,
 * `archer-emph-*` reserved for agent emphasis) so that neither channel's
 * selectors can ever match the other's classes.
 */
export const NODE_CLASS = "archer-node";
/**
 * What the node IS, as two more identity classes: the outline it is drawn
 * with (always one of `NODE_SHAPES`) and its semantic kind (when it has one). Identity, not state, so
 * they sit with `archer-node` and are present for the node's whole life; the
 * stylesheet draws the outline from the first and the kind's cue from the
 * second. See the node-shape block in `src/styles.css`.
 */
export const NODE_SHAPE_CLASS_PREFIX = "archer-shape-";
export const NODE_KIND_CLASS_PREFIX = "archer-kind-";
/**
 * The React Flow node type every diagram node is given, registered against
 * `GraphNode` by the canvas. Named here rather than imported from the
 * component so this module stays free of React.
 */
export const GRAPH_NODE_TYPE = "archer";
/**
 * The React Flow node type of a group that is a model ELEMENT (a composite
 * state, a C4 boundary, an architecture group): a frame like a flowchart
 * subgraph's, which is also selectable, focusable and an end for edges.
 */
export const FRAME_NODE_TYPE = "archer-frame";
/** Marks a group that is a model element, selected as a node. */
export const ELEMENT_GROUP_CLASS = "archer-element-group";
/**
 * The node the keyboard is standing on.
 *
 * Its own namespace (`archer-kbd-*`), because keyboard focus is a third state
 * alongside presentation focus and agent emphasis and must not be matched by
 * either one's selectors. It is also NOT `.selected`: the focused node and the
 * selected node are different nodes as often as not.
 */
export const KEYBOARD_FOCUS_CLASS = "archer-kbd-focus";
/**
 * An edge with an end on the hovered or a selected node: the reader's node's own connections, drawn in the accent
 * above the rest so they can be followed through a crowd of lines (layout eval, 2026-11-15; Ware & Bobrow 2004, 2005).
 */
export const ATTACHED_EDGE_CLASS = "archer-edge-attached";
export const GROUP_CLASS = "archer-group";

/**
 * An element a comment thread is about (`comments/state.ts`, `commentPins`).
 * Its own namespace: a mark of the person's conversation, never read as
 * selection, focus or emphasis.
 */
export const COMMENTED_CLASS = "archer-commented";

/** How far a pin's thread has got: outlined, filled, or with the agent's mark. */
export type CanvasPinState = "draft" | "sent" | "answered" | "resolved";

/** A pin on an element: its thread, the number the panel shows, and its state (`CommentPins.tsx`). */
export type CanvasPin = { readonly threadId: string; readonly number: number; readonly state: CanvasPinState };

export const STATE_WORD: Readonly<Record<CanvasPinState, string>> = {
  draft: "draft",
  sent: "sent",
  answered: "answered",
  resolved: "resolved by the agent",
};

export type CommentedElements = {
  readonly nodeIds: ReadonlySet<string>;
  readonly edgeIds: ReadonlySet<string>;
  readonly groupIds: ReadonlySet<string>;
  /** The pins on each element, when the caller numbers its threads (`comments/state.ts`, `commentPins`). */
  readonly nodePins?: ReadonlyMap<string, readonly CanvasPin[]>;
  readonly edgePins?: ReadonlyMap<string, readonly CanvasPin[]>;
  readonly groupPins?: ReadonlyMap<string, readonly CanvasPin[]>;
};

/** What a screen reader hears after a commented element's name. */
const COMMENTED_SUFFIX = ", has comments";

/** An element's pins, as a data field present only when there are some. */
function pinsOf(
  map: ReadonlyMap<string, readonly CanvasPin[]> | undefined,
  id: string,
): { pins?: readonly CanvasPin[] } {
  const pins = map?.get(id);
  return pins === undefined || pins.length === 0 ? {} : { pins };
}

function withCommented(className: string, marked: boolean): string {
  return marked ? `${className} ${COMMENTED_CLASS}` : className;
}
export const EDGE_CLASS = "archer-edge";
/**
 * How the edge's line is drawn, as one more identity class: always exactly
 * one of `EDGE_LINES`, with an edge that states no line saying `solid`. The
 * stylesheet draws the dash pattern and the weight from it.
 */
export const EDGE_LINE_CLASS_PREFIX = "archer-line-";

/**
 * The agent's emphasis, ready to draw.
 *
 * `isolated` is the group a legend row is currently hovered over, and is the
 * ONE place dimming outside presentation focus is right: transient,
 * user-driven, and it never touches published state. It is passed as ids
 * rather than as a group id so this module never has to reach back into the
 * emphasis to resolve one.
 */
export type EmphasisRender = {
  readonly assignments: EmphasisAssignments;
  readonly isolated: { readonly nodes: ReadonlySet<string>; readonly edges: ReadonlySet<string> } | null;
  /** Whether emphasised elements carry their group's number (the reader's Group numbers). */
  readonly numbered?: boolean;
};

/** What the edge component needs in order to draw a packet. */
export type EmphasisEdgeData = {
  readonly style: EmphasisStyle;
  readonly speed: EmphasisSpeed | null;
  readonly hop: number;
  readonly hops: number;
  /** The group's number, drawn on the line when `numbered`. */
  readonly slot: number;
  readonly numbered: boolean;
  /** The stretch of its route a `flow` line's chevrons travel, when another lit line draws the rest (`ownStretch`). */
  readonly stretch?: { readonly from: number; readonly to: number };
};

function groupNodeId(groupId: string): string {
  return `group:${groupId}`;
}

/**
 * The React Flow id of a group: `group:<id>` for a flowchart subgraph, which
 * is a frame and nothing else, and the model id itself for a group that is an
 * element -- that is the id selection, emphasis, comments and the keyboard
 * look it up by, as they do a node's.
 */
function frameIdOf(group: LayoutGroup): string {
  return group.element === true ? group.id : groupNodeId(group.id);
}

/**
 * The identity classes a figure adds to its node: what it is (`archer-state-
 * choice`, `archer-c4-person`, ...), which the stylesheet draws from.
 */
function figureClasses(figure: NodeFigure | undefined): string[] {
  if (figure === undefined) return [];
  switch (figure.type) {
    case "state":
      return ["archer-figure-state", `archer-state-${figure.kind}`];
    case "entity":
      return ["archer-figure-entity"];
    case "c4":
      return [
        "archer-figure-c4",
        `archer-c4-${figure.kind}`,
        ...(figure.external ? ["archer-c4-external"] : []),
        ...(figure.shape === undefined ? [] : [`archer-c4-shape-${figure.shape}`]),
      ];
    case "service":
      return ["archer-figure-service", ...(figure.icon === undefined ? [] : [`archer-service-icon-${figure.icon}`])];
    case "junction":
      return ["archer-figure-junction"];
  }
}

/** The classes a frame's figure adds: what kind of group it is. */
function frameClasses(figure: GroupFigure | undefined): string[] {
  if (figure === undefined) return [];
  switch (figure.type) {
    case "composite":
      return ["archer-frame-composite"];
    case "boundary":
      return ["archer-frame-boundary", `archer-boundary-${figure.kind}`];
    case "zone":
      return ["archer-frame-zone"];
  }
}

/** A neutral panel inside another panel: pale slate with a quieter outline (the outermost is clear). */
export const GROUP_NESTED_CLASS = "archer-group-nested";

/** Each group's panel classes: its family, and the nested neutral step where `groupPanelsOf` says so. */
function groupPanels(groups: readonly LayoutGroup[], panels: GroupPanels): ReadonlyMap<string, readonly string[]> {
  return new Map(
    groups.map((group) => {
      const panel = panels.get(group.id);
      return [
        group.id,
        [...paletteClasses(panel?.palette ?? {}), ...(panel?.nested === true ? [GROUP_NESTED_CLASS] : [])],
      ];
    }),
  );
}

/** A label, then whatever a figure says about what the element is. */
function spoken(label: string, id: string, description: string | undefined): string {
  const name = aloud(label) || id;
  return description === undefined ? name : `${name}, ${description}`;
}

/**
 * Identity class, plus whatever channels currently apply.
 *
 * Emphasis classes are appended, never substituted: the element keeps saying
 * what it is (`archer-node`) and what React Flow makes of it (`selected`)
 * while it says who pointed at it. That is what keeps the user's voice and the
 * agent's separable rather than one overwriting the other.
 */
function classNameFor(base: string, id: string, emphasis: EmphasisRender, channel: "nodes" | "edges"): string {
  const assignment = emphasis.assignments[channel].get(id);
  if (assignment === undefined) {
    return base;
  }
  const isolated = emphasis.isolated;
  const member = isolated?.[channel].has(id);
  return [base, ...assignment.classes, ...(member ? [EMPHASIS_MEMBER_CLASS] : [])].join(" ");
}

function edgeEmphasis(
  assignment: EmphasisAssignment | undefined,
  numbered: boolean,
  stretch?: { readonly from: number; readonly to: number },
): EmphasisEdgeData | undefined {
  if (assignment === undefined) {
    return undefined;
  }
  return {
    style: assignment.style,
    speed: assignment.speed,
    hop: assignment.hop,
    hops: assignment.hops,
    slot: assignment.slot,
    numbered,
    ...(stretch === undefined ? {} : { stretch }),
  };
}

/**
 * Each moving line's own stretch, where lines of one group share part of their routes (a fan-out's trunk,
 * `route-simplify.ts`): the longest keeps its whole route, and each other leaves out what one before it draws.
 */
function chevronStretches(
  edges: readonly { readonly id: string; readonly points: readonly { x: number; y: number }[] }[],
  assignments: ReadonlyMap<string, EmphasisAssignment>,
): Map<string, { from: number; to: number }> {
  const bySlot = new Map<number, { id: string; route: readonly { x: number; y: number }[]; length: number }[]>();
  for (const edge of edges) {
    const assignment = assignments.get(edge.id);
    if (assignment?.style !== "flow" || assignment.speed === null || edge.points.length < 2) continue;
    const list = bySlot.get(assignment.slot) ?? [];
    list.push({ id: edge.id, route: edge.points, length: routeLength(edge.points) });
    bySlot.set(assignment.slot, list);
  }
  const stretches = new Map<string, { from: number; to: number }>();
  for (const lines of bySlot.values()) {
    if (lines.length < 2) continue;
    lines.sort((p, q) => q.length - p.length || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
    lines.forEach((line, index) => {
      if (index === 0) return;
      const own = ownStretch(
        line.route,
        lines.slice(0, index).map((earlier) => earlier.route),
      );
      if (own.from > 0.5 || own.to < line.length - 0.5) stretches.set(line.id, own);
    });
  }
  return stretches;
}

/**
 * Where the focus channel and the emphasis channel meet.
 *
 * ADR-0005 requires this intersection to be DEFINED rather than incidental, and
 * the rule is: an emphasised element is never dimmed by focus.
 *
 * The two channels are separate voices -- focus is the host's published
 * framing, emphasis is the agent pointing -- and each is honoured in its own
 * namespace. But opacity is one property and only one of them can have it. The
 * emphasis has to win, because dimming it to `DIMMED_OPACITY` does not
 * subordinate the agent's claim, it ERASES it: the ring, the hue and the packet
 * all go to 25% and the user sees nothing where the agent says to look. Focus
 * dimming loses nothing by the exemption -- everything the agent did not point
 * at still dims, so the framing still reads.
 *
 * Chosen over the alternatives deliberately. Refusing to emphasise outside a
 * focus set would make `set_emphasis` succeed and draw nothing, the dishonesty
 * ADR-0005 exists to prevent. An intermediate opacity would leave the ring
 * legible in neither state.
 *
 * Pinned by `tests/xflow-adapter.test.ts` ("does not dim an emphasised
 * node/edge that lies outside the focus set").
 */
function dimmedBy(
  focusActive: boolean,
  focused: boolean,
  id: string,
  emphasis: EmphasisRender,
  channel: "nodes" | "edges",
  /** A frame holding a member of the shown highlight (or a line between two members): kept at full strength. */
  holdsMember = false,
): boolean {
  // While a highlight is shown, a node or frame it does not name steps back (owner, 2026-11-12): a highlight in a
  // family's hue reads over boxes in that hue only when they are quiet. Members keep their colour and the emphasis.
  if (channel === "nodes" && !holdsMember && emphasisShown(emphasis) && !emphasis.assignments.nodes.has(id))
    return true;
  // And so does a connection that is not on the path: one it names, or one between two of its members.
  if (channel === "edges" && !holdsMember && emphasisShown(emphasis) && !emphasis.assignments.edges.has(id))
    return true;
  if (!focusActive || focused) {
    return false;
  }
  return !emphasis.assignments[channel].has(id);
}

/** Whether a highlight is shown: it names some node or line. */
function emphasisShown(emphasis: EmphasisRender): boolean {
  return emphasis.assignments.nodes.size > 0 || emphasis.assignments.edges.size > 0;
}

/** A plain group's frame a shown highlight does not name: its panel steps back as a node's shapes do. */
export const EMPHASIS_QUIET_CLASS = "archer-emph-quiet";

function hasFocus(focus: DiagramFocus | undefined): boolean {
  if (!focus) return false;
  const nodeCount = focus.nodeIds?.length ?? 0;
  const edgeCount = focus.edgeIds?.length ?? 0;
  return nodeCount > 0 || edgeCount > 0;
}

/**
 * The size a node is drawn at, stated as ALREADY MEASURED.
 *
 * Without it, every new `nodes` array costs every edge its DOM element. The
 * flow is controlled with no `onNodesChange`, so the size React Flow measures
 * never comes back into these objects; when the array changes, `adoptUserNodes`
 * sees a node with no `measured`, treats it as never measured and DROPS ITS
 * HANDLE BOUNDS (`parseHandles`). Until the next measurement `getEdgePosition`
 * has no endpoints, `EdgeWrapper` returns null, and React unmounts each edge's
 * `<svg>` and mounts a new one.
 *
 * That made an edge unclickable with a real mouse. The press focuses the
 * edge, the focus moves the keyboard ring, the ring is a change to this
 * array, and the element under the pointer is gone before the button comes
 * up -- so the browser dispatches no `click`. It is not specific to focus:
 * anything that changes the array mid-press did the same.
 *
 * The size is ours to state. ELK laid the box out and `style` pins the
 * element to it, so this is what a measurement would report. React Flow still
 * measures on mount (a node with no handle bounds is always observed), which
 * is where the handle positions come from.
 */
function measuredAs(box: { width: number; height: number }): { width: number; height: number } {
  return { width: box.width, height: box.height };
}

/**
 * The groups with every parent before its children: by nesting depth, then by
 * id, so the order is the same however the layout happens to list them.
 *
 * REACT FLOW REQUIRES IT, and only says so in a console warning. Its
 * `adoptUserNodes` walks the array once, filling a map as it goes, and places
 * each child from its parent's entry in that map; a child that comes first
 * finds no parent and is left at its RELATIVE position as if that were
 * absolute. Sorting by id alone did that to any group whose id sorts before
 * its parent's (`data` inside `platform`).
 *
 * It went unseen because the first draw repairs itself: nothing is measured
 * yet, so React Flow measures every node and then recomputes every absolute
 * position from the finished map (`updateNodeInternals` ->
 * `updateAbsolutePositions`). Every LATER array -- a focus, a selection, an
 * emphasis, the keyboard ring -- states its sizes as `measured` (see
 * `measuredAs`), is therefore not re-measured, and is not repaired: the group
 * jumped up and left by its parent's offset, its nodes went with it, and the
 * edges, routed by ELK in absolute coordinates, stayed where they were.
 *
 * A depth is counted along `parentId`, bounded by the number of groups so a
 * cycle (which no layout produces) ends rather than hangs. A parent the layout
 * does not hold counts as no parent, which is how the group is drawn.
 */
function parentsFirst(groups: readonly LayoutGroup[], groupById: ReadonlyMap<string, LayoutGroup>): LayoutGroup[] {
  const depthOf = (group: LayoutGroup): number => {
    let depth = 0;
    let parent = group.parentId === undefined ? undefined : groupById.get(group.parentId);
    while (parent !== undefined && depth < groups.length) {
      depth += 1;
      parent = parent.parentId === undefined ? undefined : groupById.get(parent.parentId);
    }
    return depth;
  };
  const depth = new Map(groups.map((group) => [group.id, depthOf(group)]));
  return [...groups].sort((a, b) => {
    const byDepth = (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0);
    return byDepth !== 0 ? byDepth : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function toXFlowNodes(
  layout: LayoutResult,
  focus?: DiagramFocus,
  selection?: DiagramSelection,
  emphasis: EmphasisRender = { assignments: NO_EMPHASIS, isolated: null },
  keyboard: KeyboardNav = NO_KEYBOARD_NAV,
  commented?: CommentedElements,
): Node<DiagramNodeData | DiagramGroupData>[] {
  const focusActive = hasFocus(focus);
  const focusedNodeIds = new Set(focus?.nodeIds ?? []);
  const selectedNodeIds = new Set(selection?.nodeIds ?? []);

  // Group rectangles come from ELK, which already sized every container around
  // everything it holds -- including nested subgroups. Re-deriving them from
  // member-node extents plus a constant produced boxes that excluded their own
  // subgroups and a fixed 24px header that ignored `elk.padding` entirely.
  const groupById = new Map(layout.groups.map((g) => [g.id, g]));
  // The frames that hold a member of a shown highlight, at any depth: its context, kept at full strength.
  const holdingMembers = new Set<string>();
  {
    const nodeGroup = new Map(layout.nodes.map((node) => [node.id, node.groupId]));
    for (const id of emphasis.assignments.nodes.keys()) {
      let cursor = nodeGroup.get(id) ?? groupById.get(id)?.parentId;
      for (let hops = 0; cursor !== undefined && hops <= layout.groups.length; hops += 1) {
        holdingMembers.add(cursor);
        cursor = groupById.get(cursor)?.parentId;
      }
    }
  }
  const categories = indexCategories(layout.categories);
  const groupColours = groupPanelsOf(layout.groups, categories);
  const panels = groupPanels(layout.groups, groupColours);
  // The Key row each element belongs to, said in its accessible name (DESIGN.md, "The Key").
  const membership = membershipOf(paletteKeyRows(layout, categories, groupColours), layout);
  const memberOf = (channel: "node" | "group", id: string): string => {
    const phrase = membership.get(`${channel}:${id}`);
    return phrase === undefined ? "" : `, ${phrase}`;
  };

  const groupNodes: Node<DiagramGroupData>[] = parentsFirst(layout.groups, groupById).map((group) => {
    const parent = group.parentId ? groupById.get(group.parentId) : undefined;
    if (group.element === true) {
      return elementFrame(group, parent, {
        focusActive,
        focused: focusedNodeIds.has(group.id),
        selected: selectedNodeIds.has(group.id),
        emphasis,
        keyboard,
        commented: commented?.nodeIds.has(group.id) === true,
        pins: commented?.nodePins?.get(group.id),
        panel: panels.get(group.id) ?? [],
        membership: memberOf("group", group.id),
        holdsMember: holdingMembers.has(group.id),
      });
    }
    const frameSource = frameSourceOf(group.id);
    return {
      id: groupNodeId(group.id),
      type: "group",
      className: withCommented(
        [
          GROUP_CLASS,
          ...(frameSource === null ? [] : ["archer-source-frame"]),
          ...(panels.get(group.id) ?? []),
          ...(emphasisShown(emphasis) && !emphasis.assignments.nodes.has(group.id) && !holdingMembers.has(group.id)
            ? [EMPHASIS_QUIET_CLASS]
            : []),
        ].join(" "),
        commented?.groupIds.has(group.id) === true,
      ),
      zIndex: -1,
      parentId: parent ? frameIdOf(parent) : undefined,
      position: parent ? { x: group.x - parent.x, y: group.y - parent.y } : { x: group.x, y: group.y },
      // See `measuredAs`: a group is re-adopted with the rest of the array.
      measured: measuredAs(group),
      // The panel -- fill, border, corner, caption ink -- is the stylesheet's (`.archer-group`), from the
      // classes above, so a family or a nesting step is one class and every state rule still applies.
      style: {
        width: group.width,
        height: group.height,
        boxSizing: "border-box",
      },
      data: {
        label: group.label,
        ...captionAt(group),
        ...pinsOf(commented?.groupPins, group.id),
        ...(frameSource === null ? {} : { frameSource }),
      },
      selectable: false,
      draggable: false,
    };
  });

  const memberNodes: Node<DiagramNodeData>[] = [...layout.nodes]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((node) => {
      const owner = node.groupId ? groupById.get(node.groupId) : undefined;
      const position = owner ? { x: node.x - owner.x, y: node.y - owner.y } : { x: node.x, y: node.y };
      const focused = focusedNodeIds.has(node.id);
      const dimmed = dimmedBy(focusActive, focused, node.id, emphasis, "nodes");
      const selected = selectedNodeIds.has(node.id);
      const kind = kindOf(node.classes);
      const identity = [
        NODE_CLASS,
        // The outline it is drawn with, which is what the stylesheet draws
        // from: a database rectangle is a cylinder here, as it is to the
        // layout (`outlineOf`).
        `${NODE_SHAPE_CLASS_PREFIX}${outlineOf(node.shape, node.classes)}`,
        ...(kind === undefined ? [] : [`${NODE_KIND_CLASS_PREFIX}${kind}`]),
        ...paletteClasses(nodePalette(node, categories, groupColours)),
        ...figureClasses(node.figure),
        ...(node.folded === undefined ? [] : [NEST_CLOSED_CLASS]),
      ].join(" ");
      const classes = dimmedClass(
        withCommented(classNameFor(identity, node.id, emphasis, "nodes"), commented?.nodeIds.has(node.id) === true),
        dimmed,
      );
      return {
        id: node.id,
        type: GRAPH_NODE_TYPE,
        className: node.id === keyboard.ringId ? `${classes} ${KEYBOARD_FOCUS_CLASS}` : classes,
        selected,
        /*
         * THE KEYBOARD CONTRACT, stated on the element.
         *
         * React Flow's own version of this is switched off at the canvas
         * (`nodesFocusable={false}` in `DiagramCanvas`), because its Enter
         * binding writes into a store whose changes this controlled flow
         * drops -- so it announces a selection gesture that does nothing.
         * What it leaves behind is `role="group"` on every node and a
         * `tabindex="0"` on all of them, which is why both are restated here.
         *
         * `button` rather than `option`: this IS an activatable control that
         * Enter and Space operate, which is the button contract exactly.
         * `option` would promise listbox semantics, and the element that would
         * have to carry `role="listbox"` is React Flow's, not ours -- an
         * option with no listbox is a role that lies about its container.
         * `aria-pressed` states the fact the button role cannot: whether this
         * node is currently in the selection.
         */
        // An unlabelled node would otherwise be a `button` with no accessible
        // name at all; its id is the only other thing that identifies it.
        ariaLabel:
          spoken(node.label, node.id, figureDescription(node.figure) ?? node.folded?.caption) +
          containedIn(node.groupId, groupById) +
          memberOf("node", node.id) +
          emphasisMembership(emphasis.assignments.nodes.get(node.id)) +
          (commented?.nodeIds.has(node.id) === true ? COMMENTED_SUFFIX : ""),
        /*
         * `button` and `aria-pressed` are claims about a keyboard channel that
         * exists. A canvas rendered WITHOUT one -- the last-valid drawing under
         * an error banner is the live case, and it sits outside the surface
         * that carries the keydown handler -- must not make either claim, or it
         * announces an activation the user can never perform. `img` is what
         * xyflow falls back to, and it is the truth there: a picture of a node.
         */
        ...(keyboard.stopId === null
          ? {}
          : {
              ariaRole: "button" as const,
              domAttributes: {
                // Exactly one node carries the stop; see `rovingStopId`.
                tabIndex: node.id === keyboard.stopId ? 0 : -1,
                "aria-pressed": selected,
              },
            }),
        position,
        parentId: owner ? frameIdOf(owner) : undefined,
        extent: node.groupId ? ("parent" as const) : undefined,
        width: node.width,
        height: node.height,
        measured: measuredAs(node),
        // The focus flags below are the semantic state; this style is the
        // rendering of it. React Flow puts `style` on the node's wrapper, so
        // without it focus would have no visible effect at all.
        style: { width: node.width, height: node.height, opacity: focusOpacity(dimmed) },
        data: {
          label: node.label,
          shape: node.shape,
          classes: node.classes,
          typeface: layout.typeface,
          focused,
          dimmed,
          ...(commented?.nodeIds.has(node.id) === true ? { commented: true } : {}),
          ...pinsOf(commented?.nodePins, node.id),
          ...(node.figure === undefined ? {} : { figure: node.figure, direction: layout.direction }),
          ...(node.note === undefined
            ? {}
            : { note: { ...node.note, x: node.note.x - node.x, y: node.note.y - node.y } }),
          ...(node.folded?.caption === undefined ? {} : { inside: node.folded.caption }),
          ...(node.folded === undefined ? {} : { closed: true as const }),
        },
      };
    });

  return [...groupNodes, ...memberNodes];
}

/**
 * A group that is a model element, as React Flow draws it: the frame a
 * flowchart subgraph gets, plus everything a node carries -- its selection,
 * the agent's emphasis, its comment mark, the keyboard's stop and ring, and a
 * name a screen reader can read.
 */
function elementFrame(
  group: LayoutGroup,
  parent: LayoutGroup | undefined,
  state: {
    readonly focusActive: boolean;
    readonly focused: boolean;
    readonly selected: boolean;
    readonly emphasis: EmphasisRender;
    readonly keyboard: KeyboardNav;
    readonly commented: boolean;
    readonly pins: readonly CanvasPin[] | undefined;
    /** Its panel's family and nesting step (`groupPanels`). */
    readonly panel: readonly string[];
    /** Its Key row, as its accessible name says it (`membershipOf`). */
    readonly membership: string;
    /** It holds a member of the shown highlight, so it stays at full strength. */
    readonly holdsMember: boolean;
  },
): Node<DiagramGroupData> {
  const identity = [GROUP_CLASS, ELEMENT_GROUP_CLASS, ...frameClasses(group.figure), ...state.panel].join(" ");
  const dimmed = dimmedBy(state.focusActive, state.focused, group.id, state.emphasis, "nodes", state.holdsMember);
  const classes = dimmedClass(
    withCommented(classNameFor(identity, group.id, state.emphasis, "nodes"), state.commented),
    dimmed,
  );
  return {
    id: group.id,
    type: FRAME_NODE_TYPE,
    className: group.id === state.keyboard.ringId ? `${classes} ${KEYBOARD_FOCUS_CLASS}` : classes,
    zIndex: -1,
    parentId: parent ? frameIdOf(parent) : undefined,
    position: parent ? { x: group.x - parent.x, y: group.y - parent.y } : { x: group.x, y: group.y },
    measured: measuredAs(group),
    width: group.width,
    height: group.height,
    style: { width: group.width, height: group.height, boxSizing: "border-box", opacity: focusOpacity(dimmed) },
    selected: state.selected,
    selectable: true,
    draggable: false,
    ariaLabel:
      spoken(group.label, group.id, groupDescription(group.figure)) +
      (parent === undefined ? "" : `, in ${aloud(parent.label) || parent.id}`) +
      state.membership +
      emphasisMembership(state.emphasis.assignments.nodes.get(group.id)) +
      (state.commented ? COMMENTED_SUFFIX : ""),
    ...(state.keyboard.stopId === null
      ? {}
      : {
          ariaRole: "button" as const,
          domAttributes: { tabIndex: group.id === state.keyboard.stopId ? 0 : -1, "aria-pressed": state.selected },
        }),
    data: {
      label: group.label,
      ...(group.figure === undefined ? {} : { figure: group.figure }),
      ...(state.commented ? { commented: true } : {}),
      ...(state.pins === undefined || state.pins.length === 0 ? {} : { pins: state.pins }),
      ...(dimmed ? { dimmed: true } : {}),
      ...captionAt(group),
    },
  };
}

/**
 * A node whose label is being typed in place holds a text field, and a `button` may not contain another control
 * (axe `nested-interactive`): while its field is open the node is a named `group` around the field, and it makes no
 * pressed claim. Every other node, and this one once the field closes, keeps the button contract above.
 */
export function withLabelField<T extends Pick<Node, "id" | "ariaRole" | "domAttributes">>(
  node: T,
  editingId: string | null | undefined,
): T {
  if (editingId === null || editingId === undefined || node.id !== editingId || node.ariaRole !== "button") return node;
  const { "aria-pressed": _pressed, ...attributes } = node.domAttributes ?? {};
  return { ...node, ariaRole: "group", domAttributes: attributes };
}

export function toXFlowEdges(
  layout: LayoutResult,
  focus?: DiagramFocus,
  selection?: DiagramSelection,
  emphasis: EmphasisRender = { assignments: NO_EMPHASIS, isolated: null },
  keyboard: KeyboardNav = NO_KEYBOARD_NAV,
  commented?: CommentedElements,
  /** The nodes whose connections stand out: the hovered one and the selected ones. */
  attached?: ReadonlySet<string>,
): Edge[] {
  const focusActive = hasFocus(focus);
  // What each caption is drawn on: the canvas or the panel behind it (treatment A, `label-ground.ts`).
  const grounds = labelGrounds(layout);
  const focusedEdgeIds = new Set(focus?.edgeIds ?? []);
  const selectedEdgeIds = new Set(selection?.edgeIds ?? []);
  const labelOf = new Map([
    ...layout.nodes.map((node) => [node.id, node.label] as const),
    ...layout.groups.filter((group) => group.element === true).map((group) => [group.id, group.label] as const),
  ]);
  const stretches = chevronStretches(layout.edges, emphasis.assignments.edges);

  return [...layout.edges]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((edge) => {
      const focused = focusedEdgeIds.has(edge.id);
      const betweenMembers = emphasis.assignments.nodes.has(edge.source) && emphasis.assignments.nodes.has(edge.target);
      const dimmed = dimmedBy(focusActive, focused, edge.id, emphasis, "edges", betweenMembers);
      const opacity = focusOpacity(dimmed);
      const selected = selectedEdgeIds.has(edge.id);
      const identity = `${EDGE_CLASS} ${EDGE_LINE_CLASS_PREFIX}${edge.line ?? "solid"}${bundleClasses(edge)}`;
      const marked = commented?.edgeIds.has(edge.id) === true;
      const isAttached = attached !== undefined && (attached.has(edge.source) || attached.has(edge.target));
      const classes =
        dimmedClass(withCommented(classNameFor(identity, edge.id, emphasis, "edges"), marked), dimmed) +
        (isAttached ? ` ${ATTACHED_EDGE_CLASS}` : "");
      const arrows = arrowsOf(edge.figure, edge.bidirectional);
      const arrowhead = {
        type: MarkerType.ArrowClosed,
        markerUnits: "userSpaceOnUse",
        width: 34,
        height: 34,
        // React Flow renders the marker symbol with this as an inline
        // `style`, not as an SVG attribute, so a custom property resolves.
        color: "var(--edge-arrow)",
      };
      return {
        id: edge.id,
        className: edge.id === keyboard.ringId ? `${classes} ${KEYBOARD_FOCUS_CLASS}` : classes,
        selected,
        source: edge.source,
        target: edge.target,
        label: edge.label,
        // PROTOTYPE: direction + orthogonal-looking routing
        type: "elk",
        ...(arrows.end ? { markerEnd: arrowhead } : {}),
        ...(arrows.start ? { markerStart: arrowhead } : {}),
        /*
         * THE KEYBOARD CONTRACT, stated on the element -- exactly as
         * `toXFlowNodes` states it, and for the same reason.
         *
         * `focusable: false` is NOT "unreachable by keyboard". It switches off
         * React Flow's version of reachability, which in v12.11.2 means
         * `tabIndex: 0` on EVERY edge, `role="group"`, an `aria-describedby`
         * pointing at "press enter or space to select an edge", and an
         * `onKeyDown` that calls `addSelectedEdges`. That last one lands in
         * `triggerEdgeChanges`, and this flow is controlled -- an `edges` prop
         * with no `onEdgesChange` -- so the change is dropped and the gesture
         * the description promised does nothing at all. The tab stop, the
         * role, the name and the keys are therefore ours, set below and
         * handled on the canvas surface.
         *
         * `button` rather than `group`, matching the nodes: this is a control
         * Enter and Space operate. `aria-roledescription="edge"` is React
         * Flow's and stays, so the reader is still told which kind of thing
         * the button is.
         */
        focusable: false,
        ariaLabel:
          edgeAccessibleName(
            edge.label === undefined ? undefined : captionParts(edge.label).label || undefined,
            labelOf.get(edge.source) ?? edge.source,
            labelOf.get(edge.target) ?? edge.target,
          ) +
          (edge.figure?.type === "c4" && edge.figure.technology !== undefined ? `, ${edge.figure.technology}` : "") +
          (edge.figure?.type === "c4" && edge.figure.description !== undefined ? `, ${edge.figure.description}` : "") +
          relationshipFacts(
            edge.figure,
            edge.line,
            labelOf.get(edge.source) ?? edge.source,
            labelOf.get(edge.target) ?? edge.target,
          ) +
          emphasisMembership(emphasis.assignments.edges.get(edge.id)) +
          (marked ? COMMENTED_SUFFIX : ""),
        // Same rule as the nodes above: no keyboard channel, no button claim.
        ...(keyboard.stopId === null
          ? {}
          : {
              ariaRole: "button" as const,
              domAttributes: {
                // Exactly one edge carries the stop; see `rovingStopId`.
                tabIndex: edge.id === keyboard.stopId ? 0 : -1,
                "aria-pressed": selected,
              },
            }),
        // Edges are click-selectable targets, not decoration: `App` wires
        // `onEdgeClick` into the selection reducer, and the
        // `.react-flow__edge.selectable` hover/selected rules in styles.css
        // only match once React Flow sees this flag. A wide interaction band
        // keeps a 1.5px stroke clickable.
        selectable: true,
        interactionWidth: 24,
        style: { opacity },
        // The caption's words never fade by opacity (C-07): a dimmed caption's plate steps back and its words take
        // `--text-faded`, which keeps 4.5:1 on it. `DIMMED_CLASS` in `focus-style.ts`.
        labelStyle: dimmed ? DIMMED_CAPTION : { opacity },
        // Attached lines are drawn over the others, so where lines cross the reader's own stays whole.
        zIndex: isAttached ? 1 : 0,
        data: {
          focused,
          dimmed,
          points: edge.points,
          labelAnchor: edge.labelAnchor,
          ...(grounds.has(edge.id) ? { ground: grounds.get(edge.id) } : {}),
          // The caption is drawn in the rows the layout wrapped it into.
          typeface: layout.typeface,
          // Only `flow` needs this: the packet is drawn by the edge component,
          // which is the only place the routed polyline is in hand.
          emphasis: edgeEmphasis(
            emphasis.assignments.edges.get(edge.id),
            emphasis.numbered === true,
            stretches.get(edge.id),
          ),
          // What the ends look like, beyond the arrowheads above.
          ...(edge.figure === undefined ? {} : { figure: edge.figure }),
          // The pins of its threads, beside its label (`CommentPins.tsx`).
          ...pinsOf(commented?.edgePins, edge.id),
        },
      };
    });
}
