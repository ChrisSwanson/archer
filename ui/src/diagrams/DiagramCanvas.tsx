import { DEFAULT_POINTER_MODE, PanSelectControl, type PointerMode } from "./PanSelectControl";
import { authoredLineKey } from "./key-entries";
import { CanvasTools } from "./CanvasTools";
import { SourceToolButton } from "./SourceTool";
import { usePointerHandCheck } from "../telemetry/dev-hooks";
import {
  useCallback,
  useContext,
  useId,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FocusEvent,
  type JSX,
  type KeyboardEvent,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ControlButton,
  Controls,
  EdgeLabelRenderer,
  ReactFlow,
  SelectionMode,
  type Edge,
  type Node,
  type ReactFlowProps,
  type ReactFlowInstance,
  type Viewport,
  useReactFlow,
  useStore,
  useStoreApi,
  useUpdateNodeInternals,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { FitGlyph, HelpGlyph, ZoomInGlyph, ZoomOutGlyph } from "./ControlGlyphs";
import type { LayoutResult } from "../layout/elk-adapter";
import type { SequenceLayoutResult } from "../layout/sequence-layout";
import {
  FRAME_NODE_TYPE,
  GRAPH_NODE_TYPE,
  NO_KEYBOARD_NAV,
  toXFlowEdges,
  toXFlowNodes,
  withLabelField,
  type DiagramFocus,
  type DiagramSelection,
  type EmphasisEdgeData,
  type EmphasisRender,
  type KeyboardNav,
  type CommentedElements,
  type CanvasPin,
} from "./xflow-adapter";
import { useStableItems, useStableValue } from "./stable-items";
import { PinBadge, PinRow } from "./CommentPins";
import { directionForKey, edgeAnchors, nextInDirection, rovingStopId, type NavNode } from "./keyboard-nav";
import { SequenceCanvas, type SequenceFocus } from "./SequenceCanvas";
import { JourneyCanvas, type JourneyFocus } from "./JourneyCanvas";
import type { ProjectedJourney } from "./projection";
import { GraphNode } from "./GraphNode";
import { AuthoringHandles } from "./authoring-handles";
import { InlineLabelInput } from "./InlineLabelInput";
import "./AuthoringCanvas.css";
import { FrameNode, captionStyle } from "./FrameNode";
import { EdgeEnds } from "./EdgeEnds";
import { roundedRoute } from "./rounded-route";
import { CURVE_ARROW_SHAFT_PX, type CurvedRoute } from "./curved-route";
import { mermaidCurves } from "./mermaid-curve";
import { useCurvedLines } from "../app/curved-lines";
import { CANVAS_GROUND, type GroundPiece, type LabelGround } from "./label-ground";
import { ArrowMarkers, routeArrowWidths } from "./ArrowMarkers";
import type { EdgeFigure } from "./figures";
import { captionParts, edgeLabelBox } from "../layout/graph-metrics";
import type { TypefaceId } from "../layout/text-measure";
import { useResolvedTheme } from "../theme/theme";
import { NO_EMPHASIS, type Emphasis } from "../emphasis/contract";
import { EmphasisChevrons, parkedAt } from "../emphasis/EmphasisChevrons";
import { EmphasisMarker } from "../emphasis/EmphasisMarker";
import type { MemberChannel } from "../emphasis/EmphasisLegend";
import { useEmphasisSurface } from "../emphasis/surface";
import { usesFamilyColours } from "./palette";
import { useHelp } from "../app/HelpOverlay";
import { useCanvasShortcuts } from "./canvas-shortcuts";
import { OffscreenCue } from "./OffscreenCue";
import { edgesAmong } from "../selection/marquee";
import {
  withHeading,
  drawnOn,
  frameClearOfChrome,
  leftmostUnder,
  measureFloating,
  graphObstacles,
  hitsAny,
  measureChrome,
  measureNotice,
} from "./chrome-clearance";
import { useCompileNoticeUp } from "./notice-context";
import { NestToggles, type CanvasNesting, type NestAnchor } from "../nesting/NestToggles";
import { FrameChrome } from "../expand/frame-chrome";
import { cameraAfterPress, showOpened } from "../nesting/toggle-place";
import { dimmedClass } from "./focus-style";
import { clearOfChrome, FOLLOW_GLIDE_MS, followFrame, followParts, type WalkCamera } from "../walkthroughs/walk-camera";
import { useBrowserReducedMotion } from "../emphasis/reduced-motion";
import {
  CANVAS_MAX_ZOOM,
  CANVAS_MIN_ZOOM,
  NO_OVERFLOW,
  entryBox,
  fitPadding,
  frameViewport,
  handZoomFloor,
  readingZoom,
  readableFloorZoom,
  showAllZoom,
  showsEverything,
  tooSmallToRead,
  layoutBounds,
  overflowOf,
  sameOverflow,
  revealShift,
  uncoveredArea,
  type Box,
  type CoveredAt,
  type Frame,
  type Overflow,
  type ZoomRange,
} from "./viewport-fit";

/** Opt-in presentation gestures. The workspace owns semantic edits and stable IDs. */
export interface CanvasAuthoring {
  readonly enabled?: boolean;
  readonly disabled?: boolean;
  /** Absolute graph-local coordinates, only for top-level leaf nodes. */
  readonly positions?: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly onNodeMove?: (id: string, position: { x: number; y: number }) => void;
  readonly onConnect?: (sourceId: string, targetId: string) => void;
  readonly onNodeLabelEdit?: (id: string) => void;
  readonly onEdgeLabelEdit?: (id: string) => void;
  /** Present only during placement; click is the new node's graph-local top-left. */
  readonly onPanePlace?: (position: { x: number; y: number }) => void;
  readonly onRefused?: (reason: string) => void;
  /** Filled with the canvas's screen-to-graph conversion once it is ready (where to put a new node). */
  readonly flowPosition?: { current: ((screen: { x: number; y: number }) => { x: number; y: number }) | null };
  /** The node whose label is typed in place, and what to do with the text. */
  readonly editingNodeId?: string | null;
  readonly onNodeLabelCommit?: (id: string, label: string) => void;
  readonly onNodeLabelClose?: () => void;
  readonly editingEdgeId?: string | null;
  /** Sequence diagrams: a participant dragged to stand before another (null: last). */
  readonly onNodeReorder?: (id: string, before: string | null) => void;
  /** Sequence diagrams: a message drawn between two lifelines, below `after` (null: first). */
  readonly onMessageDraw?: (from: string, to: string, after: string | null) => void;
  /** Sequence diagrams: a message's end reattached, or the message moved to stand before another (null: last). */
  readonly onEdgeRetarget?: (id: string, end: "source" | "target", participant: string) => void;
  readonly onEdgeMove?: (id: string, before: string | null) => void;
  /** Renaming only, for a type without structured editing (C4, state): double-click a node to type its name. */
  readonly relabel?: boolean;
  readonly onEdgeLabelCommit?: (id: string, label: string) => void;
  readonly onEdgeLabelClose?: () => void;
  /** Sequence diagrams: a note or block picked (`edit` on a double-click), and the one picked now. */
  readonly onPartClick?: (kind: "note" | "fragment", id: string, edit: boolean) => void;
  readonly selectedPart?: string | null;
  /** Filled by the canvas: switches it from Hand to Select. The editor calls it when a part is picked from the parts bar. */
  readonly selectMode?: { current: (() => void) | null };
}
/** The page lab's "interactive" point (`archer:interactive`): the canvas has its layout and its handlers, once painted. */
function markInteractive(): void {
  if (typeof requestAnimationFrame !== "function" || typeof performance?.mark !== "function") return;
  requestAnimationFrame(() => performance.mark("archer:interactive"));
}

const STRUCTURED_NOTATIONS: ReadonlySet<string> = new Set(["flowchart", "c4", "er", "state"]);
function authoringEnabled(authoring: CanvasAuthoring | undefined, layout: LayoutResult): boolean {
  // The notations with structured editing: connect, rename and delete work the same in each.
  return (
    authoring !== undefined &&
    authoring.enabled !== false &&
    authoring.disabled !== true &&
    STRUCTURED_NOTATIONS.has(layout.notation ?? "flowchart")
  );
}
/**
 * Why a node has no name to rename, or `null` when it has one: state markers, forks, joins and choices
 * are drawn without a name in Mermaid. Said rather than ignored (smoke-b#13:c: a double-click on one did nothing).
 */
export function unnamedReason(figure: unknown): string | null {
  if (typeof figure !== "object" || figure === null || (figure as { type?: unknown }).type !== "state") return null;
  const kind = (figure as { kind?: unknown }).kind;
  const what =
    kind === "initial"
      ? "A start marker"
      : kind === "final"
        ? "An end marker"
        : kind === "fork" || kind === "join" || kind === "choice"
          ? `A ${kind}`
          : null;
  return what === null ? null : `${what} has no name to edit. Double-click a state or a transition to rename it.`;
}

/** Whether focus on `element` is keyboard focus; `true` where the browser cannot say (old engines, jsdom). */
function focusVisible(element: EventTarget): boolean {
  if (!(element instanceof Element)) return true;
  try {
    return element.matches(":focus-visible");
  } catch {
    return true;
  }
}

/** Opens the label editor on a node, or says why it has none (`unnamedReason`). */
function editNodeLabel(authoring: CanvasAuthoring | undefined, id: string, figure: unknown): void {
  const reason = unnamedReason(figure);
  if (reason === null) authoring?.onNodeLabelEdit?.(id);
  else authoring?.onRefused?.(reason);
}

function ownPosition(positions: CanvasAuthoring["positions"], id: string) {
  return positions && Object.hasOwn(positions, id) ? positions[id] : undefined;
}

/** The zooms a graph opens at: its notation's reading band, in its design's face. */
export function readingOf(layout: LayoutResult): ZoomRange {
  return readingZoom(layout.notation ?? "flowchart", layout.typeface);
}

/**
 * Which of the two keyboard rings something belongs to.
 *
 * Spelled the way the emphasis assignments are keyed (`"nodes"` / `"edges"`),
 * so one word means one thing across the canvas.
 */
type Channel = "nodes" | "edges";

/** The camera, read and put back by the page's modes (0.6.4, D1); filled while a graph canvas is mounted. */
export type CameraHandle = {
  readonly get: () => { x: number; y: number; zoom: number };
  readonly set: (view: { x: number; y: number; zoom: number }) => void;
  /** Frame the drawing as it is framed when it opens. */
  readonly fit: () => void;
};

/** The framing the host asked for, from the `viewport` presentation parameter. */
export type ViewportMode = "fit-all" | "fit-focus" | "preserve";

export type ViewportRequest = {
  readonly mode: ViewportMode;
  /**
   * Identifies the host command this request came from. The mode alone cannot
   * distinguish "the same instruction, still applied" from "the host asked
   * again", and re-framing on every React render would fight the user's pan.
   */
  readonly key: number;
};

export type CanvasState =
  | { status: "loading" }
  | { status: "empty" }
  | { status: "error"; message: string; lastValid?: LayoutResult }
  | {
      status: "ready";
      layout: LayoutResult;
      focus?: DiagramFocus;
      viewport?: ViewportRequest;
    }
  | {
      status: "sequence-ready";
      sequenceLayout: SequenceLayoutResult;
      focus?: SequenceFocus;
      viewport?: ViewportRequest;
    }
  | {
      /** A user journey: a canvas of its own, with no graph layout. */
      status: "journey-ready";
      journey: ProjectedJourney;
      focus?: JourneyFocus;
      viewport?: ViewportRequest;
    };

const CANVAS_ARIA_LABEL = "Diagram canvas";

/** The middle mouse button, in React Flow's `panOnDrag` button numbering. */
const MIDDLE_MOUSE_BUTTON = 1;

/**
 * How the canvas is navigated and how a drag is claimed.
 *
 * A plain left-drag can only belong to one gesture. Passing `panOnDrag={true}`
 * alongside `selectionOnDrag` does not share it -- React Flow resolves the
 * clash with `selectionOnDrag && panOnDrag !== true`, so pan won outright and
 * marquee selection was reachable only via Shift+drag.
 *
 * Dragging the canvas therefore always marquees, and panning moves to gestures
 * that do not compete for it:
 *   - two-finger scroll        (`panOnScroll`)
 *   - Space+drag               (React Flow's default `panActivationKeyCode`)
 *   - middle-drag              (`panOnDrag` restricted to button 1)
 * `zoomOnScroll` is off because it only applies to the plain wheel, which now
 * pans; zooming is Cmd/Ctrl+scroll (`zoomActivationKeyCode`) or pinch.
 *
 * Shift is deliberately absent from all of the above: it is never a navigation
 * modifier, which leaves it free to mean additive selection -- which is what
 * `multiSelectionKeyCode` binds it to here. React Flow defaults that to
 * Meta/Ctrl, but Ctrl+click is the right-click gesture on macOS and Cmd+scroll
 * is already zoom, so Shift is both free and the conventional choice.
 */
const CANVAS_NAVIGATION: Pick<
  ComponentProps<typeof ReactFlow>,
  | "panOnDrag"
  | "selectionOnDrag"
  | "panOnScroll"
  | "zoomOnScroll"
  | "zoomOnPinch"
  | "multiSelectionKeyCode"
  | "selectionKeyCode"
> = {
  panOnDrag: [MIDDLE_MOUSE_BUTTON],
  selectionOnDrag: true,
  panOnScroll: true,
  zoomOnScroll: false,
  zoomOnPinch: true,
  multiSelectionKeyCode: "Shift",
  // Shift must not ALSO force a marquee. `selectionKeyCode` puts the pane into
  // selection mode, and that pane sits above the nodes -- so with Shift held,
  // a click aimed at a node landed on the pane instead and cleared the
  // selection, which is the opposite of adding to it. A plain drag already
  // marquees (`selectionOnDrag`), so nothing is lost by giving the key up.
  selectionKeyCode: null,
};

/** Mount framing when no host command has been applied yet: show the whole graph. */
const INITIAL_VIEWPORT: ViewportRequest = { mode: "fit-all", key: 0 };

/** Stable empty array, so the fit effect is not re-run by a fresh literal. */
const EMPTY_IDS: readonly string[] = [];

/** Stable "nothing is drawn where the cue could be", for the same reason. */
const NOTHING_DRAWN: readonly Box[] = [];

/** Stable "nothing is emphasised", for the same reason. */
const EMPTY_EMPHASIS: EmphasisRender = { assignments: NO_EMPHASIS, isolated: null };

/**
 * What a screen reader is told a node can be operated with.
 *
 * React Flow's own strings describe React Flow's bindings -- "use the arrow
 * keys to move the node around", "press delete to remove it" -- and neither is
 * true here: nodes are not draggable, `deleteKeyCode` is null, and traversal
 * is this app's own. Both variants are overridden because which one is
 * rendered depends on `disableKeyboardA11y`, and a description that is only
 * honest on one branch is a promise waiting to break.
 */
const NODE_KEYBOARD_DESCRIPTION =
  "Use the arrow keys to move between nodes. Press Enter or Space to select the " +
  "focused node, or hold Shift to add it to the selection or take it out.";

/**
 * The same, for edges.
 *
 * React Flow's own text -- "press enter or space to select an edge. You can
 * then press delete to remove it or escape to cancel" -- describes its own
 * bindings, and none of them are true here: `deleteKeyCode` is null, and the
 * Enter binding writes into a store this controlled flow drops changes from.
 *
 * Overridden rather than left unreferenced. The edges no longer point at this
 * description (`focusable: false` drops the `aria-describedby`), but React
 * Flow renders the div holding it either way, so the false sentence would
 * still be in the page for anything reading it. Pinned by
 * `tests/edge-keyboard.test.tsx`.
 */
const EDGE_KEYBOARD_DESCRIPTION =
  "Use the arrow keys to move between edges. Press Enter or Space to select the " +
  "focused edge, or hold Shift to add it to the selection or take it out.";

const ARIA_LABEL_CONFIG = {
  // Sentence case, as every other control on the page and the sequence canvas's zoom buttons (ux:A11Y-5).
  "controls.ariaLabel": "Canvas controls",
  "controls.zoomIn.ariaLabel": "Zoom in",
  "controls.zoomOut.ariaLabel": "Zoom out",
  "controls.fitView.ariaLabel": "Fit view",
  "node.a11yDescription.default": NODE_KEYBOARD_DESCRIPTION,
  "node.a11yDescription.keyboardDisabled": NODE_KEYBOARD_DESCRIPTION,
  "edge.a11yDescription.default": EDGE_KEYBOARD_DESCRIPTION,
};

function CenteredMessage(props: { children: string; busy?: boolean }): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        height: "100%",
      }}
    >
      {/* Loading says so to assistive technology and to tools: a status that is busy (round 1, L-ui). */}
      {props.busy === true ? (
        <p role="status" aria-busy="true">
          {props.children}
        </p>
      ) : (
        <p>{props.children}</p>
      )}
    </div>
  );
}

/** PROTOTYPE: the built-in \ node draws a bare rectangle and ignores
 *  \, so every boundary box was an unlabelled container. */
function GroupNode(props: {
  data: { label?: string; captionAt?: { x: number; y: number }; pins?: readonly CanvasPin[]; frameSource?: string };
}): JSX.Element {
  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {props.data?.frameSource === undefined ? null : (
        <FrameChrome source={props.data.frameSource} label={props.data.label ?? props.data.frameSource} />
      )}
      {/* In the band ELK keeps across the top of the frame, where the layout
          placed it clear of every wire (`layout/captions.ts`): a subgraph's
          name is a frame caption like any other. */}
      <span className="archer-frame-caption archer-subgraph-caption" style={captionStyle(props.data?.captionAt)}>
        {props.data?.label ?? ""}
      </span>
      <PinRow pins={props.data?.pins} inside />
    </div>
  );
}

const PROTO_NODE_TYPES = { group: GroupNode, [GRAPH_NODE_TYPE]: GraphNode, [FRAME_NODE_TYPE]: FrameNode };

/**
 * Everything the keyboard stands on as a NODE: the nodes, and the groups that
 * are model elements (a composite state, a C4 boundary). A flowchart
 * subgraph is a frame and is not among them.
 */
export function navigableNodes(layout: LayoutResult): readonly NavNode[] {
  const frames = layout.groups.filter((group) => group.element === true);
  return frames.length === 0 ? layout.nodes : [...layout.nodes, ...frames];
}

type Pt = { x: number; y: number };

/** PROTOTYPE A: draw the polyline ELK already routed, with rounded corners.
 *  Falls back to a straight segment when ELK returned no section. */
function ElkEdge(props: {
  id: string;
  /** React Flow's own: the reader has this edge selected. */
  selected?: boolean;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  markerEnd?: string;
  markerStart?: string;
  style?: React.CSSProperties;
  label?: unknown;
  labelStyle?: React.CSSProperties;
  data?: {
    points?: readonly Pt[];
    labelAnchor?: { x: number; y: number; width: number; height: number };
    /** What the caption is drawn on, and its ink there (treatment A, `label-ground.ts`). */
    ground?: LabelGround;
    emphasis?: EmphasisEdgeData;
    typeface?: TypefaceId;
    figure?: EdgeFigure;
    pins?: readonly CanvasPin[];
    panWithHand?: boolean;
    /** Outside the focus: its caption plate wears `archer-dimmed`, so the plate's second lines fade once (`styles.css`). */
    dimmed?: boolean;
    /** The viewer chose "Curved lines": this line drawn as a gentle curve from box to box (`mermaid-curve.ts`). */
    curve?: CurvedRoute;
  };
}): JSX.Element {
  const authoring = useContext(AuthoringHandles);
  const editingLabel = authoring.editingEdgeId === props.id;
  const interactionRef = useRef<SVGPathElement>(null);
  // XYFlow puts `nopan` on every edge wrapper, including nonselectable edges.
  // Hand owns that route's pointer gesture. Restore the normal exclusion in
  // Select, and reapply after every wrapper render (selection changes its class).
  useLayoutEffect(() => {
    interactionRef.current?.closest(".react-flow__edge")?.classList.toggle("nopan", !props.data?.panWithHand);
  });
  const pts = props.data?.points ?? [];
  const route: Pt[] =
    pts.length >= 2
      ? [...pts]
      : [
          { x: props.sourceX, y: props.sourceY },
          { x: props.targetX, y: props.targetY },
        ];

  const ends = { arrowStart: props.markerStart !== undefined, arrowEnd: props.markerEnd !== undefined };
  // One path for the line, its focus mark and its pointer band, so the click corridor follows the curve.
  const curve = pts.length >= 2 ? props.data?.curve : undefined;
  const d = curve?.d ?? roundedRoute(route, ends);
  // The line as drawn: the curve, where there is one, so ends, packets and numbers ride what the reader sees.
  const drawn: readonly Pt[] = curve?.samples ?? route;
  const markerId = useId();
  const zoom = useStore((state) => state.transform[2]);
  const { start, end } = routeArrowWidths(
    drawn,
    ends,
    zoom,
    curve === undefined ? undefined : { straight: curve.straight, shaft: CURVE_ARROW_SHAFT_PX },
  );
  const last = route[route.length - 1];

  // Placement is decided in the layout pass, which can see every caption at
  // once; an edge component only sees itself and cannot avoid its neighbours.
  const placed = props.data?.labelAnchor;
  const best = placed
    ? { x: placed.x + placed.width / 2, y: placed.y + placed.height / 2 }
    : { x: (route[0].x + last.x) / 2, y: (route[0].y + last.y) / 2 };

  const emphasis = props.data?.emphasis;
  // The edge's pins stand off its label's top-right corner (or above its
  // middle, when it has no label), in the label layer over the wires.
  const pins = props.data?.pins;
  const pinAt =
    props.label && placed ? { x: placed.x + placed.width - 4, y: placed.y - 14 } : { x: best.x - 10, y: best.y - 26 };

  return (
    <>
      <ArrowMarkers id={markerId} start={start} end={end} />
      <path
        id={props.id}
        className="react-flow__edge-path"
        d={d}
        markerStart={start === undefined || start <= 0 ? undefined : `url('#${markerId}-start')`}
        markerEnd={end === undefined || end <= 0 ? undefined : `url('#${markerId}-end')`}
        style={props.style}
      />
      {/* Where keyboard focus may be drawn ON the route (the retired Line map
          design drew sleepers across it). An element of its own, and one no
          pointer can hit: the mark used to be a restyle of the interaction path
          below, which shrank the hit corridor between a press and its release
          and cost the edge its click (`tests/hit-corridor-guard.test.ts`).
          Unpainted: the edge's own focus halo says where the keyboard is. */}
      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a decorative SVG part with no tabindex, never focusable; biome misreads SVG elements as focusable. */}
      <path d={d} className="archer-edge-focus-mark" aria-hidden="true" />
      {/* What the ends look like where an arrowhead is not the whole story:
          an entity relationship's crow's feet. */}
      {props.data?.figure === undefined ? null : <EdgeEnds figure={props.data.figure} route={drawn} />}
      {/* The pointer target. Its shape is stated here and never restyled. */}
      <path
        ref={interactionRef}
        d={d}
        fill="none"
        strokeOpacity={0}
        strokeWidth={24}
        className="react-flow__edge-interaction"
      />
      {/* The packet rides the polyline this component just routed, which is why
          it is drawn here rather than in a layer of its own: nowhere else has
          the route in hand. `highlight` groups never get one -- they are
          pointing at a set, not tracing a direction. */}
      {emphasis?.style === "flow" && emphasis.speed !== null ? (
        <EmphasisChevrons
          edgeId={props.id}
          twoWay={ends.arrowStart && ends.arrowEnd}
          speed={emphasis.speed}
          hop={emphasis.hop}
          hops={emphasis.hops}
          route={drawn}
          avoid={props.label ? placed : undefined}
          {...(emphasis.stretch === undefined ? {} : { stretch: emphasis.stretch })}
        />
      ) : null}
      {/* The group's number, on the line's middle and clear of its caption,
          when the reader asked for numbers (ADR 0030, "Group numbers"). */}
      {emphasis?.numbered === true && drawn.length > 1
        ? (() => {
            const at = parkedAt(drawn, 0.5, props.label ? placed : undefined);
            return <EmphasisMarker slot={emphasis.slot} x={at.x} y={at.y} />;
          })()
        : null}
      {props.label || editingLabel ? (
        <EdgeLabelRenderer>
          {/* The caption's geometry and type are `.archer-edge-label` in the
              stylesheet, at the sizes the layout reserved its box with. No
              plate (treatment A): inline, where it sits, the gap in the colour
              of what is behind it and the words' ink there, and the focus
              styles the adapter passes as `labelStyle`. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: double-click is a pointer shortcut to the edge's label editor, which selecting the edge (from the keyboard too) opens. */}
          <div
            data-edge-id={props.id}
            className={dimmedClass(
              authoring.enabled ? "archer-edge-label nopan nodrag" : "archer-edge-label",
              props.data?.dimmed === true,
            )}
            onDoubleClick={
              authoring.enabled
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    authoring.onEdgeLabelEdit?.(props.id);
                  }
                : undefined
            }
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${best.x}px, ${best.y}px)`,
              pointerEvents: authoring.enabled ? "auto" : "none",
              // Across a panel's edge the gap is painted in parts (`GroundPieces`), and the frame's line shows.
              background:
                props.data?.ground?.pieces === undefined ? (props.data?.ground ?? CANVAS_GROUND).fill : "none",
              // Its ink is the stylesheet's (`.archer-edge-label`), from the ground's: the softer slate, or a family
              // panel's ink; fading sets its own through `labelStyle`.
              ["--edge-label-ink" as string]: (props.data?.ground ?? CANVAS_GROUND).ink,
              ...props.labelStyle,
            }}
          >
            {props.data?.ground?.pieces === undefined || placed === undefined ? null : (
              <GroundPieces pieces={props.data.ground.pieces} box={placed} />
            )}
            {/* The rows the layout wrapped the caption into, so the plate is
                the box ELK routed every other wire around. */}
            {editingLabel ? (
              <InlineLabelInput
                label={`${props.id} connection label`}
                value={captionParts(String(props.label ?? "")).label}
                onCommit={(text) => authoring.onEdgeLabelCommit?.(props.id, text)}
                onClose={() => authoring.onEdgeLabelClose?.()}
              />
            ) : (
              <CaptionRows box={edgeLabelBox(String(props.label), props.data?.typeface)} />
            )}
          </div>
        </EdgeLabelRenderer>
      ) : null}
      {pins === undefined || pins.length === 0 ? null : (
        <EdgeLabelRenderer>
          <div
            className="archer-edge-pins"
            style={{ transform: `translate(${pinAt.x}px, ${pinAt.y}px)` }}
            data-edge-pins={props.id}
          >
            {pins.map((pin) => (
              <PinBadge key={pin.threadId} pin={pin} control />
            ))}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/**
 * A label's gap in parts, where a panel's edge runs through it (`label-ground.ts`): each part in the colour behind
 * it, behind the words (the label's transform makes it a stacking context, so `z-index: -1` stays inside it).
 */
function GroundPieces(props: {
  readonly pieces: readonly GroundPiece[];
  readonly box: { readonly width: number; readonly height: number };
}): JSX.Element {
  const share = (v: number, of: number): string => `${(v / of) * 100}%`;
  return (
    <>
      {props.pieces.map((p) => (
        <span
          key={`${p.x},${p.y}`}
          aria-hidden="true"
          className="archer-edge-label-ground"
          style={{
            left: share(p.x, props.box.width),
            top: share(p.y, props.box.height),
            width: share(p.width, props.box.width),
            height: share(p.height, props.box.height),
            background: p.fill,
          }}
        />
      ))}
    </>
  );
}

/**
 * A caption's rows: the label, then a C4 relationship's technology and description in the C4 card's
 * secondary lines (ADR 0030, amended 2026-10-31). All inside the plate, at the rows the layout reserved;
 * the edge's accessible name says the same detail.
 */
function CaptionRows(props: { box: ReturnType<typeof edgeLabelBox> }): JSX.Element {
  const { lines, technology, description } = props.box;
  return (
    <>
      {lines.map((line, index) => (
        <span
          className="archer-edge-label-row"
          // biome-ignore lint/suspicious/noArrayIndexKey: the wrapped lines of one label, re-derived together; a line has no identity or state beyond its position.
          key={index}
        >
          {line}
        </span>
      ))}
      {technology.map((line) => (
        <span className="archer-edge-label-technology" key="technology">
          {line}
        </span>
      ))}
      {description.length === 0 ? null : (
        <span className="archer-edge-label-description">
          {description.map((line, index) => (
            <span
              className="archer-edge-label-row"
              // biome-ignore lint/suspicious/noArrayIndexKey: the wrapped lines of one label, re-derived together; a line has no identity or state beyond its position.
              key={index}
            >
              {line}
            </span>
          ))}
        </span>
      )}
    </>
  );
}

const PROTO_EDGE_TYPES = { elk: ElkEdge };

function ErrorBanner(props: { message: string }): JSX.Element {
  return (
    <div
      role="alert"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 10,
        padding: "8px 16px",
        background: "var(--banner-danger-bg)",
        color: "var(--banner-danger-text)",
      }}
    >
      {props.message}
    </div>
  );
}

/**
 * What the camera is following: the framing a fit last applied, kept so that a
 * change in the canvas box can re-apply the same one. `null` once the user has
 * panned or zoomed -- from then on the camera is theirs, and nothing but an
 * explicit instruction (their own, or the host's) moves it again.
 */
type Following = { readonly target: "all" | "focus"; readonly zooms: ZoomRange } | null;

export { HEADING_BAND_PX } from "./chrome-clearance";

/**
 * Frames the graph, and keeps it framed for as long as the camera is still the
 * canvas's own.
 *
 * Not React Flow's `fitView`: that clamps to the flow's minimum zoom and then
 * centres, which is how a graph too tall to fit used to load with its first
 * and last layers both off screen (see `viewport-fit.ts`). The camera is
 * computed there and applied here with `setViewport`.
 *
 * Three things frame the canvas:
 *   - mounting, and every later host instruction other than `preserve`
 *     (identified by `request.key`; the mode alone cannot tell "still applied"
 *     from "asked again");
 *   - the canvas box changing size while the camera is still following -- the
 *     tab strip and the dataflow bar arrive after first paint and take their
 *     height out of the stage, and the window can be resized;
 *   - the user asking, through the returned callback.
 *
 * Every framing also reports what it left outside the canvas (`onFramed`), so
 * the canvas can say so: an automatic fit stops at the readable floor, and a
 * graph that does not fit there opens with part of itself off screen. A fit
 * on the host's focus reports nothing -- the rest of the graph is off screen
 * there because the host asked for a closer look, not for want of room. The
 * zoom it chose is reported too: an explicit fit may go below the hand-zoom
 * minimum, and the flow's own limit has to follow it down (`handZoomFloor`).
 * So is whether the framing was an explicit fit of everything, because that
 * one makes a promise the canvas has to answer for: all of it is in view,
 * and if that is too small to read the canvas says so.
 *
 * Returns two callbacks: fit the whole graph, however small that makes it;
 * and frame it as it opens, at a size that reads.
 */
function useFraming(options: {
  layout: LayoutResult;
  request: ViewportRequest;
  focusNodeIds: readonly string[];
  reserveLegend: boolean;
  following: RefObject<Following>;
  onFramed: (overflow: readonly Overflow[], frame: Frame, showsAll: boolean) => void;
}): { fitAll: () => void; fitReadable: () => void; fitOpening: () => void; framed: boolean } {
  const { setViewport } = useReactFlow();
  // Whether the drawing has been framed once: until then a Fit key is queued (V7), since the opening framing would undo it.
  const [framed, setFramed] = useState(false);
  const store = useStoreApi();
  // Subscribed to, not just read: these are what re-run the effect below.
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  // `setViewport` is a no-op until React Flow's pan/zoom instance exists.
  const ready = useStore((state) => state.panZoom !== null);

  // Read through a ref so that a new layout or focus set does not, by itself,
  // re-run the effect and re-frame: only the three triggers above may.
  const latest = useRef(options);
  latest.current = options;
  const { request, reserveLegend, following } = options;
  // The compile notice arriving or going changes the room as the legend does.
  const noticeUp = useCompileNoticeUp();

  const frame = useCallback(
    (next: NonNullable<Following>): void => {
      const current = latest.current;
      const canvas = { width: store.getState().width, height: store.getState().height };
      if (canvas.width === 0 || canvas.height === 0) {
        return;
      }
      // `fit-focus` with nothing focused has no smaller box to frame, so it
      // degrades to the whole graph rather than doing nothing.
      const focused = next.target === "focus" ? layoutBounds(current.layout, current.focusNodeIds) : null;
      const bounds = focused ?? layoutBounds(current.layout);
      if (bounds === null) {
        return;
      }
      current.following.current = next;
      // A whole-graph fit that cannot show the whole graph shows where it
      // starts; a focused one has no start, only the focus.
      const entry = focused === null ? entryBox(current.layout) : null;
      // What must not end up under the chrome: everything drawn, or -- for a
      // closer look the host asked for -- the nodes it asked to look at.
      const drawn =
        focused === null
          ? graphObstacles(current.layout)
          : current.layout.nodes.filter((node) => current.focusNodeIds.includes(node.id));
      // The reader's own fit of everything, which has no floor under it.
      const showsAll = focused === null && showsEverything(next.zooms);
      const { frame: viewport, overflow } = frameClearOfChrome<Frame>({
        base: withHeading(fitPadding(canvas, current.reserveLegend), current.layout.heading),
        controls: measureChrome(
          store.getState().domNode,
          store.getState().domNode?.querySelector(".react-flow__controls") ?? null,
        ),
        floating: measureFloating(store.getState().domNode),
        canvas,
        notice: measureNotice(store.getState().domNode ?? null),
        frameWith: (padding) => frameViewport(bounds, canvas, padding, next.zooms, entry),
        // Counted in nodes, both ways: they are what a graph has more of. A
        // fit on the host's focus leaves the rest off screen on purpose.
        overflowOf: (frame) =>
          focused === null
            ? overflowOf(bounds, { across: current.layout.nodes, down: current.layout.nodes }, frame, canvas)
            : NO_OVERFLOW,
        hits: (frame, rect) => hitsAny(drawnOn(drawn, frame), rect),
        leftmostUnder: (frame, rect) => leftmostUnder(drawnOn(drawn, frame), rect),
        // The band is kept for the overview cue too, or the pill that says
        // "all of it, too small to read" sits on the drawing it describes.
        cueFor: (frame) => showsAll && tooSmallToRead(frame.zoom),
      });
      void setViewport(viewport);
      current.onFramed(overflow, viewport, showsAll);
      setFramed(true);
    },
    [setViewport, store],
  );

  const appliedKey = useRef<number | null>(null);
  const { key, mode } = request;

  useEffect(() => {
    if (!ready || width === 0 || height === 0) {
      return;
    }
    if (appliedKey.current !== key) {
      const mounting = appliedKey.current === null;
      appliedKey.current = key;
      // A canvas always starts framed, whatever the mode: `preserve` means
      // "keep the camera", and a canvas that has just mounted has none.
      if (mounting || mode !== "preserve") {
        frame({ target: mode === "fit-focus" ? "focus" : "all", zooms: readingOf(latest.current.layout) });
      }
      return;
    }
    // Nothing was asked: the canvas box (or the legend's corner) changed. Only
    // a camera nobody has moved follows it.
    if (following.current !== null) {
      frame(following.current);
    }
  }, [ready, width, height, key, mode, reserveLegend, noticeUp, frame, following]);

  const fitAll = useCallback(() => {
    // Always the whole graph, and all of it: `fit-focus` answers a host
    // instruction about what to frame, and the reading floor protects fits
    // nobody asked for. A user asking to fit is asking for the overview, so
    // there is no floor under it at all: every floor it has had left some
    // long chain in some narrow window part off screen (`NO_ZOOM_FLOOR`).
    // It keeps the ceiling: everything, never larger than it reads.
    frame({ target: "all", zooms: showAllZoom(readingOf(latest.current.layout)) });
  }, [frame]);
  // The way back from an overview too small to read: the framing the graph
  // opens on, readable and from where reading it starts.
  const fitReadable = useCallback(() => {
    frame({ target: "all", zooms: readingOf(latest.current.layout) });
  }, [frame]);
  // The framing a canvas mounts with (see the effect above), asked for again: a mode putting back a view it had no camera of.
  const fitOpening = useCallback(() => {
    frame({
      target: latest.current.request.mode === "fit-focus" ? "focus" : "all",
      zooms: readingOf(latest.current.layout),
    });
  }, [frame]);
  return { fitAll, fitReadable, fitOpening, framed };
}

/** What a marquee's rectangle covers, as model ids. */
export type MarqueeChange = (nodeIds: readonly string[], edgeIds: readonly string[]) => void;

/**
 * Reports what a marquee covers, each time that changes while it is dragged.
 *
 * READ FROM THE RECTANGLE, NOT FROM REACT FLOW'S `selected` FLAGS. The page
 * used to listen to `onSelectionChange` during a drag, which reports whichever
 * nodes carry `selected` in React Flow's store -- and in a controlled flow
 * those flags have two writers. The pane sets them in place as the rectangle
 * moves, and only when the SET of covered nodes changes; every `nodes` prop
 * this page renders overwrites them with the page's own selection. Traced in a
 * real browser (11 of 200 Shift-drags): the rectangle reached a second node
 * and the pane flagged it; a sync rendered from the PREVIOUS selection landed
 * a moment later and cleared the flag; the report said the node was not
 * covered; and the pane, whose set did not change again, never re-flagged it.
 * The node stayed unselected under a rectangle visibly covering it. It showed
 * on additive drags because there the store reported base + rectangle straight
 * back, the page re-rendered for that echo, and the extra sync was the late one.
 *
 * The rectangle, the camera and the node boxes have one writer each, so this
 * reads those: the same rectangle React Flow draws, converted to graph
 * coordinates the way its pane converts it, against the same node boxes, by
 * the same "any overlap" rule (`SelectionMode.Partial`). It is still React
 * Flow's geometry; it is no longer React Flow's opinion of the selection.
 *
 * ONE WRITER PER GESTURE holds: this is the marquee's only writer, and the
 * page no longer listens to `onSelectionChange` at all.
 */
function useMarqueeContents(onChange: MarqueeChange | undefined): void {
  const store = useStoreApi();
  const { getIntersectingNodes } = useReactFlow();
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    // What was last reported in THIS drag. Reset when the drag ends, so each
    // marquee reports afresh -- the pane's own memory of the last rectangle
    // outlives the drag, and an identical second marquee changed nothing.
    let reported: string | null = null;
    return store.subscribe((state, previous) => {
      const rect = state.userSelectionRect;
      if (rect === previous.userSelectionRect) {
        return;
      }
      // The press alone places a rectangle of no size; the drag starts when
      // the pane first commits one, which is when it sets this flag.
      if (rect === null || !state.userSelectionActive) {
        reported = null;
        return;
      }
      const [x, y, zoom] = state.transform;
      const area = {
        x: (rect.x - x) / zoom,
        y: (rect.y - y) / zoom,
        width: rect.width / zoom,
        height: rect.height / zoom,
      };
      // A rectangle with no area touches nothing. (`getIntersectingNodes`
      // would call every node "at least as covered as the rectangle is big".)
      // A frame that is an element (a composite state) is only taken when
      // the rectangle holds all of it: a marquee drawn round two states
      // inside one would otherwise always take the frame as well.
      const whole =
        area.width > 0 && area.height > 0
          ? new Set(getIntersectingNodes(area, false).map((node) => node.id))
          : new Set<string>();
      const nodeIds =
        area.width > 0 && area.height > 0
          ? getIntersectingNodes(area, true)
              .filter((node) => node.selectable !== false && node.hidden !== true)
              .filter((node) => node.type !== FRAME_NODE_TYPE || whole.has(node.id))
              .map((node) => node.id)
          : [];
      const key = JSON.stringify(nodeIds);
      if (key === reported) {
        return;
      }
      reported = key;
      latest.current?.(
        nodeIds,
        edgesAmong(
          nodeIds,
          state.edges.filter((edge) => edge.selectable !== false),
        ),
      );
    });
  }, [store, getIntersectingNodes]);
}

/**
 * Zoom in and out, drawn here rather than by React Flow, so their glyphs are the cluster's outlines
 * (`ControlGlyphs`) and not its filled defaults. The behaviour is React Flow's own `Controls`: the
 * camera's `zoomIn`/`zoomOut`, then the handler. At its zoom limit each says so with `aria-disabled` and does
 * nothing, but keeps focus: a native `disabled` dropped the focus of a reader pressing it to the page
 * (round 1, F46 / R3-04).
 */
function ZoomButtons(props: { onUserZoom: () => void }): JSX.Element {
  const { zoomIn, zoomOut } = useReactFlow();
  const atMax = useStore((state) => state.transform[2] >= state.maxZoom);
  const atMin = useStore((state) => state.transform[2] <= state.minZoom);
  return (
    <>
      <ControlButton
        className="react-flow__controls-zoomin"
        onClick={() => {
          if (atMax) return;
          void zoomIn();
          props.onUserZoom();
        }}
        title={ARIA_LABEL_CONFIG["controls.zoomIn.ariaLabel"]}
        aria-label={ARIA_LABEL_CONFIG["controls.zoomIn.ariaLabel"]}
        aria-disabled={atMax}
      >
        <ZoomInGlyph />
      </ControlButton>
      <ControlButton
        className="react-flow__controls-zoomout"
        onClick={() => {
          if (atMin) return;
          void zoomOut();
          props.onUserZoom();
        }}
        title={ARIA_LABEL_CONFIG["controls.zoomOut.ariaLabel"]}
        aria-label={ARIA_LABEL_CONFIG["controls.zoomOut.ariaLabel"]}
        aria-disabled={atMin}
      >
        <ZoomOutGlyph />
      </ControlButton>
    </>
  );
}

function Flow(props: {
  primaryShell?: boolean;
  layout: LayoutResult;
  viewport?: ViewportRequest;
  focus?: DiagramFocus;
  selection?: DiagramSelection;
  emphasis?: EmphasisRender;
  /**
   * Where the keyboard is. Omitted by the read-only last-valid canvas an error
   * banner sits over: nothing there is selectable, so a tab stop on it would
   * offer a gesture with no effect.
   */
  keyboard?: KeyboardNav;
  /** Where the keyboard is among the EDGES -- a second, independent stop. */
  edgeKeyboard?: KeyboardNav;
  /** Whether a legend is up, and therefore whether the fit must dodge it. */
  reserveLegend?: boolean;
  /** What comment threads are about; memoised by the caller, like `selection`. */
  commented?: CommentedElements;
  /** Whether the clear-selection control has anything to clear. */
  hasSelection?: boolean;
  authoring?: CanvasAuthoring;
  onNodeClick?: (nodeId: string, additive: boolean) => void;
  onEdgeClick?: (edgeId: string, additive: boolean) => void;
  /** A press on a node or line while the hand is the pointer (it pans and selects nothing): for a host that follows presses, as a walkthrough does. */
  onElementPress?: (channel: "node" | "edge", id: string) => void;
  onPaneClick?: () => void;
  onClearSelection?: () => void;
  /** A marquee drag began; `additive` is whether it merges into the selection. */
  onMarqueeStart?: (additive: boolean) => void;
  onMarqueeEnd?: () => void;
  /** What the marquee covers, each time that changes during the drag. */
  onMarqueeChange?: MarqueeChange;
  tools?: ReactNode;
  /** Extra buttons in the canvas control cluster (the editor's undo, redo, delete). */
  controls?: ReactNode;
  /** The nested view's controls and motion (ADR 0029); absent in the full view. */
  nesting?: CanvasNesting;
  /** A member the legend asked to see: the camera brings it on screen if it is not. */
  reveal?: RevealRequest | null;
  /** A walkthrough's follow camera (ADR 0034 §6); absent when none is open. */
  walkCamera?: WalkCamera;
  cameraHandle?: MutableRefObject<CameraHandle | null>;
}): JSX.Element {
  const editing = authoringEnabled(props.authoring, props.layout);
  const relabeling = !editing && props.authoring?.relabel === true && props.authoring.disabled !== true;
  const lastNodeClick = useRef<{ id: string; at: number } | null>(null);
  const [pointerMode, setPointerMode] = useState<PointerMode>(() =>
    editing || relabeling ? "select" : DEFAULT_POINTER_MODE,
  );
  const [dragPositions, setDragPositions] = useState<Record<string, { x: number; y: number }>>({});
  const instance = useRef<Pick<ReactFlowInstance, "screenToFlowPosition"> | null>(null);
  const refusedGroupedDrag = useRef<string | null>(null);
  // While a connection (or an arrow's end) is being dragged: the node under the pointer is the drop target, shown with an outline.
  const connecting = useRef(false);
  const dropTarget = useRef<HTMLElement | null>(null);
  const markDropTarget = (element: HTMLElement | null): void => {
    if (dropTarget.current === element) return;
    // Styled by `.archer-connect-target` (authoring.css).
    dropTarget.current?.classList.remove("archer-connect-target");
    dropTarget.current = element;
    element?.classList.add("archer-connect-target");
  };
  const nodeAt = (event: globalThis.MouseEvent | globalThis.TouchEvent): HTMLElement | null => {
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    if (!point) return null;
    const found = document.elementFromPoint(point.clientX, point.clientY);
    return found instanceof Element ? found.closest<HTMLElement>(".react-flow__node[data-id]") : null;
  };
  /**
   * The shape a connection end was dropped on, by its body. A flowchart subgraph's frame (`group:<id>`) is no
   * shape: Mermaid has no edge to a subgraph, so a drop there is refused in plain words instead of being sent.
   */
  const dropTargetAt = (event: globalThis.MouseEvent | globalThis.TouchEvent): string | null => {
    const id = nodeAt(event)?.dataset.id;
    if (!id) return null;
    if (id.startsWith("group:")) {
      props.authoring?.onRefused?.("A connection can’t end on a subgraph; drop it on a shape inside.");
      return null;
    }
    return id;
  };
  useEffect(() => () => markDropTarget(null), []);
  const trackDrop = (event: globalThis.PointerEvent): void => {
    if (!connecting.current) return;
    const under = nodeAt(event);
    // A subgraph's frame is no connection end: never lit as one.
    markDropTarget(under?.dataset.id?.startsWith("group:") === true ? null : under);
  };
  // Mirrors `connecting` for the stylesheet: every node shows its handles during the drag.
  const [connectDrag, setConnectDrag] = useState(false);
  const startConnecting = (fromId: string | null | undefined): void => {
    connecting.current = true;
    setConnectDrag(true);
    const move = (event: globalThis.PointerEvent) => {
      const at = nodeAt(event);
      trackDrop(event);
      if (at?.dataset.id === fromId) markDropTarget(null);
    };
    const stop = () => {
      setConnectDrag(false);
      document.removeEventListener("pointermove", move, true);
      document.removeEventListener("pointerup", stop, true);
      document.removeEventListener("keydown", cancel, true);
    };
    // Escape cancels the gesture: React Flow ends it on pointer up, so the drop is ignored.
    const cancel = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        connectCancelled.current = true;
        markDropTarget(null);
      }
    };
    connectCancelled.current = false;
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerup", stop, true);
    document.addEventListener("keydown", cancel, true);
  };
  const connectCancelled = useRef(false);
  useEffect(() => {
    if (editing || relabeling) setPointerMode("select");
  }, [editing, relabeling]);
  const placing = editing && props.authoring?.onPanePlace !== undefined;
  useEffect(() => {
    if (placing) setPointerMode("select");
  }, [placing]);
  useEffect(() => {
    const slot = props.authoring?.selectMode;
    if (!slot) return;
    slot.current = () => setPointerMode("select");
    return () => {
      slot.current = null;
    };
  }, [props.authoring?.selectMode]);
  useEffect(() => {
    setDragPositions({});
  }, [props.layout, editing]);
  const [isPanning, setIsPanning] = useState(false);
  const hand = pointerMode === "hand";
  // Dev builds: an editable canvas must not be left in hand mode (`ui.edit.pointer-hand`).
  // biome-ignore lint/correctness/useHookAtTopLevel: __ARCHER_DEBUG__ is a build-time constant (vite define), so the hook order never changes within a build.
  if (__ARCHER_DEBUG__) usePointerHandCheck("graph canvas", editing || relabeling, pointerMode);
  const mounted = useRef(false);
  const mousePan = useRef(false);
  const cancelledMousePan = useRef(false);
  /** Where a gesture began, until it has moved the camera (`movedFrom`). */
  const moveFrom = useRef<Viewport | null>(null);
  /**
   * The flow's element, which says whether the camera is moving (`data-camera`): from a pan or zoom's start to its
   * end, the framing's own glides included. Written to the element, not kept in state, so a glide costs no render;
   * what waits on the drawing coming to rest (the browser tests) reads it instead of a clock.
   */
  const flow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    const cancel = () => {
      cancelledMousePan.current = cancelledMousePan.current || mousePan.current;
      mousePan.current = false;
      setIsPanning(false);
    };
    const release = () => {
      cancelledMousePan.current = false;
      mousePan.current = false;
      refusedGroupedDrag.current = null;
    };
    // D3 keeps window-level mousemove listeners until mouseup. After lost
    // focus, intercept only that cancelled gesture; its real mouseup still
    // reaches D3 and cleans up normally. A new press starts a fresh gesture.
    const stopCancelledMove = (event: globalThis.MouseEvent) => {
      if (cancelledMousePan.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("mousedown", release, true);
    window.addEventListener("mouseup", release, true);
    window.addEventListener("mousemove", stopCancelledMove, true);
    return () => {
      mounted.current = false;
      window.removeEventListener("blur", cancel);
      window.removeEventListener("mousedown", release, true);
      window.removeEventListener("mouseup", release, true);
      window.removeEventListener("mousemove", stopCancelledMove, true);
    };
  }, []);
  const emphasis = props.emphasis ?? EMPTY_EMPHASIS;
  const reserveLegend = props.reserveLegend ?? false;
  const nestMotion = useNestMotion(props.layout, props.nesting?.pressKey);
  const nestAnchor = useRef<NestAnchor | null>(null);
  const emphasisedNodes = useMemo(() => new Set(emphasis.assignments.nodes.keys()), [emphasis]);
  // Memoised because React Flow is driven in controlled mode, and a controlled
  // React Flow synchronises `nodes`/`edges` into its own store from an effect.
  // Rebuilt on every render, these arrays are a new identity every time, so
  // that effect sees a change it caused itself: setNodes -> store update ->
  // re-render -> fresh array -> effect again. React stops that at fifty nested
  // updates with "Maximum update depth exceeded", and the stack lands inside
  // @xyflow/react rather than here, which is what made it hard to place.
  //
  // It surfaced as an intermittent `UI gates` failure -- about one run in
  // thirty -- because the loop only outruns React's bail-out when a render is
  // interleaved with the effect in a particular way, which timing decides. It
  // was misfiled as an out-of-memory kill for some time; the runner's cgroup
  // later showed no memory limit and no OOM kills at all.
  const keyboard = props.keyboard ?? NO_KEYBOARD_NAV;
  // Fit frames what is drawn: top-level shapes at the positions the person gave them, not where auto layout put them.
  const framingLayout = useMemo(() => {
    const own = props.authoring?.positions;
    if (!own || Object.keys(own).length === 0) return props.layout;
    return {
      ...props.layout,
      nodes: props.layout.nodes.map((node) => {
        const at = node.groupId === undefined ? ownPosition(own, node.id) : undefined;
        return at !== undefined && Number.isFinite(at.x) && Number.isFinite(at.y)
          ? { ...node, x: at.x, y: at.y }
          : node;
      }),
    };
  }, [props.layout, props.authoring?.positions]);
  // Unchanged nodes and edges keep their objects, so React Flow updates only what changed (`stable-items.ts`).
  // A node whose INTERNAL copy React Flow re-selected on a click or marquee is handed over anew, or the
  // reused copy keeps the selection React Flow wrote and not the one the page made.
  const flowStore = useRef<FlowStore | null>(null);
  // The editor passes its selection as a fresh object every render; equal ones keep the memos below.
  const selection = useStableValue(props.selection);
  const selectionInSync = useCallback((old: { readonly id: string; readonly selected?: boolean }) => {
    const internal = flowStore.current?.getState().nodeLookup.get(old.id);
    return internal === undefined || (internal.selected === true) === (old.selected === true);
  }, []);
  const nodes = useStableItems(
    useMemo(
      () =>
        toXFlowNodes(props.layout, props.focus, selection, emphasis, keyboard, props.commented)
          .map((node) => withEntering(node, nestMotion.entering))
          .map((node) => {
            const leaf = node.type === GRAPH_NODE_TYPE && !("figure" in node.data);
            const movable = leaf && node.parentId === undefined;
            const position = movable
              ? (ownPosition(dragPositions, node.id) ?? ownPosition(props.authoring?.positions, node.id))
              : undefined;
            const validPosition = position !== undefined && Number.isFinite(position.x) && Number.isFinite(position.y);
            return withLabelField(
              {
                ...node,
                selectable: hand ? false : node.selectable,
                draggable: editing && !hand && movable,
                ...(props.authoring && validPosition ? { position } : {}),
                ...(editing && leaf && !movable
                  ? {
                      domAttributes: {
                        ...node.domAttributes,
                        title: "Grouped node positions are fixed; move a top-level node instead.",
                      },
                    }
                  : {}),
              },
              editing || relabeling ? props.authoring?.editingNodeId : null,
            );
          }),
      [
        props.layout,
        props.focus,
        selection,
        emphasis,
        keyboard,
        props.commented,
        hand,
        editing,
        props.authoring,
        dragPositions,
        nestMotion.entering,
      ],
    ),
    selectionInSync,
  );
  const edgeKeyboard = props.edgeKeyboard ?? NO_KEYBOARD_NAV;
  // The node under the pointer: its connections, and the selected nodes', stand out (`ATTACHED_EDGE_CLASS`).
  // Changes only on entering or leaving a node, never on pointer movement.
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const attached = useMemo(
    () => new Set([...(selection?.nodeIds ?? []), ...(hoveredNodeId === null ? [] : [hoveredNodeId])]),
    [selection, hoveredNodeId],
  );
  // The viewer's "Curved lines": every line drawn as a curve once per layout, captions on it (`mermaid-curve.ts`).
  const curvedLines = useCurvedLines();
  const curves = useMemo(() => (curvedLines ? mermaidCurves(props.layout) : undefined), [curvedLines, props.layout]);
  const edges = useStableItems(
    useMemo(() => {
      const layoutNodes = new Map(props.layout.nodes.map((node) => [node.id, node]));
      return toXFlowEdges(props.layout, props.focus, selection, emphasis, edgeKeyboard, props.commented, attached).map(
        (edge) => {
          const moved = [edge.source, edge.target].some((id) => {
            const original = layoutNodes.get(id);
            const overlay = ownPosition(dragPositions, id) ?? ownPosition(props.authoring?.positions, id);
            return (
              original?.groupId === undefined &&
              original !== undefined &&
              overlay !== undefined &&
              Number.isFinite(overlay.x) &&
              Number.isFinite(overlay.y) &&
              (original.x !== overlay.x || original.y !== overlay.y)
            );
          });
          // Only the selected arrow carries reattach handles: on short or parallel arrows another arrow's end
          // circles would otherwise sit over the line being clicked.
          return {
            ...edge,
            selectable: hand ? false : edge.selectable,
            reconnectable: selection?.edgeIds?.includes(edge.id) === true,
            data: {
              ...edge.data,
              panWithHand: hand,
              ...(curves?.lines.has(edge.id) === true && !(props.authoring && moved)
                ? {
                    curve: curves.lines.get(edge.id),
                    ...(curves.labels.has(edge.id) ? { labelAnchor: curves.labels.get(edge.id) } : {}),
                  }
                : {}),
              ...(props.authoring && moved ? { points: undefined, labelAnchor: undefined } : {}),
            },
          };
        },
      );
    }, [
      curves,
      props.layout,
      props.focus,
      selection,
      emphasis,
      edgeKeyboard,
      props.commented,
      attached,
      hand,
      props.authoring,
      dragPositions,
    ]),
  );
  const request = props.viewport ?? INITIAL_VIEWPORT;
  const focusNodeIds = props.focus?.nodeIds ?? EMPTY_IDS;
  // Owned here rather than inside the framing hook because two parties write
  // it: the hook when it frames, and React Flow's move events when the user
  // takes the camera.
  const following = useRef<Following>(null);
  // What the framing in force left off screen. Held here for the same reason:
  // the framing hook sets it, and the user taking the camera clears it -- from
  // then on the view is theirs, and a cue that chased every pan would be a
  // counter rather than a cue. Kept referentially stable while it says the
  // same thing, so a re-frame that changes nothing re-renders nothing.
  const [overflow, setOverflow] = useState<readonly Overflow[]>(NO_OVERFLOW);
  const reportOverflow = useCallback((next: readonly Overflow[]): void => {
    setOverflow((previous) => (sameOverflow(previous, next) ? previous : next));
  }, []);
  // How far out the reader may zoom by hand. Ordinarily the canvas minimum;
  // after an explicit fit that had to go lower, wherever that fit landed.
  const [zoomFloor, setZoomFloor] = useState(CANVAS_MIN_ZOOM);
  // The camera the framing in force applied, kept for one reader: the cue has
  // to know where the drawing is on the canvas to stay off it.
  const [framed, setFramed] = useState<Frame | null>(null);
  // Whether the framing in force shows ALL of the graph at a size too small
  // to read: an explicit fit kept its promise, and this is the rest of the
  // truth about it. Cleared, like the overflow, when the reader takes the
  // camera or anything else frames the canvas.
  const [overview, setOverview] = useState(false);
  /**
   * The framing last applied, kept after the camera is taken: the page putting the camera back exactly there
   * (leaving a walkthrough, D3) puts back what that framing said too, its cue included (J4-F1).
   */
  const lastFraming = useRef<{
    overflow: readonly Overflow[];
    frame: Frame;
    showsAll: boolean;
    following: Following;
  } | null>(null);
  const reportFraming = useCallback(
    (next: readonly Overflow[], frame: Frame, showsAll: boolean): void => {
      lastFraming.current = { overflow: next, frame, showsAll, following: following.current };
      reportOverflow(next);
      setOverview(showsAll && next.length === 0 && tooSmallToRead(frame.zoom));
      setZoomFloor(handZoomFloor(frame.zoom));
      setFramed((held) =>
        held !== null && held.x === frame.x && held.y === frame.y && held.zoom === frame.zoom ? held : frame,
      );
    },
    [reportOverflow],
  );
  // Only worked out while there is a cue to place: with everything in view
  // at a size that reads there is no bar, and the list would be thrown away.
  const blocked = useMemo<readonly Box[]>(
    () =>
      (overflow.length === 0 && !overview) || framed === null
        ? NOTHING_DRAWN
        : drawnOn(graphObstacles(props.layout), framed),
    [overflow, overview, framed, props.layout],
  );
  const releaseCamera = useCallback((): void => {
    following.current = null;
    reportOverflow(NO_OVERFLOW);
    setOverview(false);
  }, [reportOverflow]);
  /** The page moved the camera: to the framing last applied, that framing is in force again; anywhere else, it is the page's. */
  const cameraPut = useCallback(
    (view?: { x: number; y: number; zoom: number }): void => {
      const held = lastFraming.current;
      const same =
        held !== null &&
        view !== undefined &&
        Math.abs(held.frame.x - view.x) < 0.5 &&
        Math.abs(held.frame.y - view.y) < 0.5 &&
        Math.abs(held.frame.zoom - view.zoom) < 1e-4;
      if (!same) {
        releaseCamera();
        return;
      }
      following.current = held.following;
      reportFraming(held.overflow, held.frame, held.showsAll);
    },
    [releaseCamera, reportFraming],
  );
  const personMoved = props.walkCamera?.onPersonMoved;
  const userZoomed = useCallback((): void => {
    releaseCamera();
    personMoved?.();
  }, [releaseCamera, personMoved]);
  const personTookCamera = (): void => {
    moveFrom.current = null;
    userZoomed();
  };
  // React Flow styles its own chrome (controls, minimap, background) from
  // this, so it has to follow the applied theme rather than assume one.
  const colorMode = useResolvedTheme();
  const authoringHandles = useMemo(
    () => ({
      enabled: editing && !hand,
      direction: props.authoring ? (props.layout.direction ?? "tb") : "tb",
      onEdgeLabelEdit: props.authoring?.onEdgeLabelEdit,
      editingNodeId: editing || relabeling ? (props.authoring?.editingNodeId ?? null) : null,
      onNodeLabelCommit: props.authoring?.onNodeLabelCommit,
      onNodeLabelClose: props.authoring?.onNodeLabelClose,
      editingEdgeId: editing ? (props.authoring?.editingEdgeId ?? null) : null,
      onEdgeLabelCommit: props.authoring?.onEdgeLabelCommit,
      onEdgeLabelClose: props.authoring?.onEdgeLabelClose,
    }),
    [editing, relabeling, hand, props.layout.direction, props.authoring],
  );

  /*
   * React Flow copies every handler prop into its store from an effect, one store write per prop whose
   * identity changed, and each write runs every node's and edge's store selectors; inline handlers made that
   * about eight writes x 350 subscribers per canvas render on the 150-node flowchart (r2-K profile). Stable
   * wrappers that call this render's handlers keep the store quiet.
   */
  const stable = useLatestHandlers({
    onInit: (flow) => {
      instance.current = flow;
      if (props.authoring?.flowPosition)
        props.authoring.flowPosition.current = (point) => flow.screenToFlowPosition(point);
      markInteractive();
    },
    onMouseDownCapture: (event) => {
      const target = event.target;
      if (
        (event.button === 1 || (hand && event.button === 0)) &&
        target instanceof Element &&
        !target.closest(".nopan")
      ) {
        mousePan.current = true;
      }
    },
    onReconnectStart: () => startConnecting(null),
    onReconnectEnd: (event, edge, handleType, state) => {
      connecting.current = false;
      const cancelled = connectCancelled.current;
      markDropTarget(null);
      if (!editing || hand || cancelled || state.isValid === true) return;
      // Dropped on a shape's body rather than its small handle: reattach to that shape.
      const id = dropTargetAt(event);
      if (!id) return;
      if (handleType === "source" && id !== edge.source) props.authoring?.onEdgeRetarget?.(edge.id, "source", id);
      else if (handleType === "target" && id !== edge.target) props.authoring?.onEdgeRetarget?.(edge.id, "target", id);
    },
    onReconnect: (oldEdge, connection) => {
      if (!editing || hand || connectCancelled.current) return;
      if (connection.source && connection.source !== oldEdge.source)
        props.authoring?.onEdgeRetarget?.(oldEdge.id, "source", connection.source);
      else if (connection.target && connection.target !== oldEdge.target)
        props.authoring?.onEdgeRetarget?.(oldEdge.id, "target", connection.target);
    },
    onNodesChange: (changes) => {
      if (!editing || hand) return;
      const eligible = new Set(nodes.filter((node) => node.draggable).map((node) => node.id));
      const positions = changes.filter(
        (change) => change.type === "position" && change.position && eligible.has(change.id),
      );
      if (positions.length)
        setDragPositions((previous) => {
          const next = { ...previous };
          for (const change of positions)
            if (
              change.type === "position" &&
              change.position &&
              Number.isFinite(change.position.x) &&
              Number.isFinite(change.position.y)
            )
              next[change.id] = change.position;
          return next;
        });
    },
    onNodeDragStart: () => {
      if (editing && !hand) releaseCamera();
    },
    onNodeDragStop: (_event, node) => {
      if (!editing || hand || node.parentId !== undefined || node.type !== GRAPH_NODE_TYPE || "figure" in node.data)
        return;
      props.authoring?.onNodeMove?.(node.id, { x: node.position.x, y: node.position.y });
      setDragPositions({});
    },
    onConnectStart: (_event, params) => {
      if (editing && !hand) startConnecting(params.nodeId);
    },
    onConnect: (connection) => {
      if (editing && !hand && !connectCancelled.current && connection.source && connection.target)
        props.authoring?.onConnect?.(connection.source, connection.target);
    },
    onConnectEnd: (event, state) => {
      connecting.current = false;
      const cancelled = connectCancelled.current;
      markDropTarget(null);
      if (!editing || hand || cancelled || state.isValid === true || !state.fromNode) return;
      // Dropped anywhere on another shape, not only on its handle: connect to it.
      const id = dropTargetAt(event);
      if (!id || id === state.fromNode.id) return;
      if (state.fromHandle?.type === "target") props.authoring?.onConnect?.(id, state.fromNode.id);
      else props.authoring?.onConnect?.(state.fromNode.id, id);
    },
    onNodeDoubleClick: (_event, node) => {
      if ((editing || relabeling) && !hand && node.type === GRAPH_NODE_TYPE)
        editNodeLabel(props.authoring, node.id, node.data.figure);
    },
    onNodeMouseEnter: (_event, node) => {
      if (node.type === GRAPH_NODE_TYPE) setHoveredNodeId(node.id);
    },
    onNodeMouseLeave: (_event, node) => {
      setHoveredNodeId((current) => (current === node.id ? null : current));
    },
    onNodeMouseMove: (event, node) => {
      if (
        editing &&
        !hand &&
        !connecting.current &&
        event.buttons === 1 &&
        node.parentId !== undefined &&
        refusedGroupedDrag.current !== node.id
      ) {
        refusedGroupedDrag.current = node.id;
        props.authoring?.onRefused?.("Grouped node positions are fixed; move a top-level node instead.");
      }
    },
    onEdgeDoubleClick: (_event, edge) => {
      if (editing && !hand) props.authoring?.onEdgeLabelEdit?.(edge.id);
    },
    onNodeClick: (event, node) => {
      if (hand) {
        props.onElementPress?.("node", node.id);
        return;
      }
      // A flowchart subgraph's frame is no element (not selectable): no edit applies to it, so while editing a
      // press on it is a press on the canvas, never a selection the panels would act on.
      if (editing && node.selectable === false) {
        props.onPaneClick?.();
        return;
      }
      props.onNodeClick?.(node.id, event.shiftKey);
      // A second click on the same node soon after is a double-click, even when the first
      // click's selection redrew the node (which loses the browser's own dblclick).
      const now = event.timeStamp,
        last = lastNodeClick.current;
      lastNodeClick.current = { id: node.id, at: now };
      if (
        (editing || relabeling) &&
        last !== null &&
        last.id === node.id &&
        now - last.at < 450 &&
        node.type === GRAPH_NODE_TYPE
      ) {
        lastNodeClick.current = null;
        editNodeLabel(props.authoring, node.id, node.data.figure);
      }
    },
    onEdgeClick: (event, edge) => {
      if (hand) props.onElementPress?.("edge", edge.id);
      else props.onEdgeClick?.(edge.id, event.shiftKey);
    },
    onSelectionStart: (event) => props.onMarqueeStart?.(event.shiftKey),
    onSelectionEnd: () => props.onMarqueeEnd?.(),
    onPaneClick: (event) => {
      if (editing && props.authoring?.onPanePlace && instance.current)
        props.authoring.onPanePlace(instance.current.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      else props.onPaneClick?.();
    },
    // The person takes the camera once it has really moved. A wheel has (React Flow's scroll-pan reports its first
    // notch only as the start, already moved); a press waits for displacement, so a tap (a touchstart that moves
    // nothing, the press that folds a phone's sheet) keeps Follow on.
    onMoveStart: (event, viewport) => {
      flow.current?.setAttribute("data-camera", "moving");
      if (mounted.current && event) {
        if (event.type === "wheel") personTookCamera();
        else moveFrom.current = viewport;
        if (event instanceof globalThis.MouseEvent && event.buttons !== 0) mousePan.current = true;
        setIsPanning(true);
      }
    },
    onMove: (event, viewport) => {
      const from = moveFrom.current;
      if (!mounted.current || !event || from === null || !movedFrom(from, viewport)) return;
      personTookCamera();
    },
    onMoveEnd: () => {
      flow.current?.setAttribute("data-camera", "idle");
      moveFrom.current = null;
      // XYFlow may deliver its delayed wheel-end after this flow unmounts.
      if (mounted.current) setIsPanning(false);
    },
  } satisfies FlowHandlers<(typeof nodes)[number], (typeof edges)[number]>);

  return (
    <AuthoringHandles.Provider value={authoringHandles}>
      <ReactFlow
        ref={flow}
        // Set once at mount; the move handlers keep it after (React leaves an unchanged prop's attribute alone).
        data-camera="idle"
        onInit={stable.onInit}
        nodeTypes={PROTO_NODE_TYPES}
        edgeTypes={PROTO_EDGE_TYPES}
        proOptions={PRO_OPTIONS}
        nodes={nodes}
        edges={edges}
        {...CANVAS_NAVIGATION}
        className={
          [
            hand
              ? `archer-pan-hand${isPanning ? " archer-pan-dragging" : ""}`
              : editing
                ? `archer-authoring-canvas${connectDrag ? " archer-connecting" : ""}`
                : "",
            props.nesting === undefined ? "" : "archer-nested",
            nestMotion.moving ? "archer-nest-moving" : "",
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
        panOnDrag={hand ? true : CANVAS_NAVIGATION.panOnDrag}
        selectionOnDrag={!hand}
        onMouseDownCapture={stable.onMouseDownCapture}
        selectionMode={SelectionMode.Partial}
        nodesConnectable={editing && !hand}
        // Auto-pan while connecting slid targets near the edge out from under the pointer.
        autoPanOnConnect={!editing}
        // Double-click renames while editing; it must not also zoom.
        zoomOnDoubleClick={!(editing || relabeling)}
        // An arrow's end can be dragged onto another element to reattach it.
        edgesReconnectable={editing && !hand && props.authoring?.onEdgeRetarget !== undefined}
        onReconnectStart={stable.onReconnectStart}
        onReconnectEnd={stable.onReconnectEnd}
        onReconnect={stable.onReconnect}
        nodesDraggable={editing && !hand}
        onNodesChange={stable.onNodesChange}
        onNodeDragStart={stable.onNodeDragStart}
        onNodeDragStop={stable.onNodeDragStop}
        onConnectStart={stable.onConnectStart}
        onConnect={stable.onConnect}
        onConnectEnd={stable.onConnectEnd}
        connectOnClick={false}
        onNodeDoubleClick={stable.onNodeDoubleClick}
        onNodeMouseEnter={stable.onNodeMouseEnter}
        onNodeMouseLeave={stable.onNodeMouseLeave}
        onNodeMouseMove={stable.onNodeMouseMove}
        onEdgeDoubleClick={stable.onEdgeDoubleClick}
        elementsSelectable={!hand}
        deleteKeyCode={null}
        /*
         * ONE WRITER PER GESTURE, applied to the keyboard.
         *
         * React Flow's node focusability brings its own Enter/Space binding, and
         * that binding writes into the store this controlled flow drops changes
         * from (`triggerNodeChanges`) -- so it announces a selection gesture
         * that does not select, and where it does land it puts React Flow's
         * store and the `nodes` prop into the sync ping-pong recorded on
         * `App.handleMarqueeChange`. Traversal and activation are therefore
         * ours end to end: the tab stop, the roles and the labels are set per
         * node by `toXFlowNodes`, and the keys are handled on the surface below.
         */
        nodesFocusable={false}
        /*
         * ...and the same for edges, which had the identical problem: React
         * Flow's `focusable` edge is a tab stop PER EDGE announced as a "group",
         * with an Enter binding into the store whose changes are dropped here.
         * `toXFlowEdges` sets `focusable: false` per edge, so this only states
         * the default; the tab stop, role, name and keys are ours.
         */
        edgesFocusable={false}
        ariaLabelConfig={ARIA_LABEL_CONFIG}
        /*
         * xyflow attaches the node keyboard description to EVERY node whenever
         * this is false -- `aria-describedby` is gated on this flag, not on
         * focusability -- so a canvas with no keyboard channel would tell a
         * screen reader to arrow between nodes and press Enter, on a drawing
         * where nothing listens. Disabling it there removes the pointer; the
         * live canvas keeps the description it can honour.
         */
        disableKeyboardA11y={keyboard.stopId === null && edgeKeyboard.stopId === null}
        /*
         * Clicks carry their own modifier state, so additive selection is
         * resolved HERE rather than left to React Flow.
         *
         * React Flow cannot do it in this canvas: the flow is controlled (a
         * `nodes` prop, no `onNodesChange`), and `triggerNodeChanges` drops every
         * change in that configuration -- so with Shift held its store reports
         * nothing at all. `event.shiftKey` on the click is the reliable signal,
         * and it needs no keydown to have been observed first.
         */
        onNodeClick={stable.onNodeClick}
        onEdgeClick={stable.onEdgeClick}
        onSelectionStart={stable.onSelectionStart}
        onSelectionEnd={stable.onSelectionEnd}
        onPaneClick={hand ? undefined : stable.onPaneClick}
        /*
         * A move with an event behind it is the user's -- a scroll, a drag, a
         * pinch. `setViewport` reports none, so the canvas framing itself never
         * counts as the user taking the camera.
         */
        onMoveStart={stable.onMoveStart}
        onMove={stable.onMove}
        onMoveEnd={stable.onMoveEnd}
        /*
         * Wider than React Flow's 0.5 default, which was the clamp that stopped
         * a fit from fitting. The floor for fits nobody asked for is applied by
         * `useFraming`, not here, so the user can still zoom out past it. An
         * explicit fit sets the camera directly and may land BELOW the canvas
         * minimum; the limit then follows it down, or the next zoom-out would
         * clamp up to the minimum and magnify.
         */
        minZoom={zoomFloor}
        maxZoom={CANVAS_MAX_ZOOM}
        colorMode={colorMode}
        aria-label={CANVAS_ARIA_LABEL}
      >
        <StoreHandle into={flowStore} />
        <ZoomVar />
        {props.nesting === undefined ? null : (
          <>
            <NestToggles
              layout={props.layout}
              nesting={props.nesting}
              anchor={nestAnchor}
              emphasised={emphasisedNodes}
            />
            <NestCamera
              layout={props.layout}
              anchor={nestAnchor}
              animate={nestMotion.animate}
              onMoved={releaseCamera}
            />
            <NestToggleReveal onMoved={releaseCamera} />
          </>
        )}
        <RevealCamera layout={props.layout} request={props.reveal ?? null} onMoved={releaseCamera} />
        <RemeasureHandles enabled={authoringHandles.enabled} direction={authoringHandles.direction} />
        <CanvasChrome
          primaryShell={props.primaryShell}
          pointerMode={pointerMode}
          onPointerModeChange={setPointerMode}
          layout={framingLayout}
          request={request}
          focusNodeIds={focusNodeIds}
          reserveLegend={reserveLegend}
          following={following}
          overflow={overflow}
          overview={overview ? `${props.layout.nodes.length} nodes` : null}
          blocked={blocked}
          onFramed={reportFraming}
          onUserZoom={userZoomed}
          cameraHandle={props.cameraHandle}
          onCameraMoved={cameraPut}
          hasSelection={props.hasSelection ?? false}
          onClearSelection={props.onClearSelection}
          onMarqueeChange={props.onMarqueeChange}
          tools={props.tools}
          controls={props.controls}
        />
        {/* After the chrome: a request present as the canvas mounts must win over the mount framing. */}
        {props.walkCamera === undefined ? null : (
          <FollowCamera layout={props.layout} walkCamera={props.walkCamera} onMoved={releaseCamera} />
        )}
      </ReactFlow>
    </AuthoringHandles.Provider>
  );
}

const PRO_OPTIONS = { hideAttribution: true } as const;

/** How long a press's motion runs (`nesting/nesting.css`), and the stagger between entering children. */
const NEST_MOTION_MS = 560;
const NEST_STAGGER_MS = 70;
const NO_ENTERING: ReadonlyMap<string, number> = new Map();

/**
 * The motion of one press in the nested view: from the layout that arrives after a press (a new
 * `pressKey`), for about half a second, boxes glide and the nodes that were not drawn before fade
 * in, staggered. A second layout for the same press (routed wires replacing the first picture's)
 * keeps the motion running and adds no entrance. Reduced motion: none of it.
 */
function useNestMotion(
  layout: LayoutResult,
  pressKey: number | undefined,
): { moving: boolean; entering: ReadonlyMap<string, number>; animate: boolean } {
  const reduced = useBrowserReducedMotion();
  const previous = useRef<{ layout: LayoutResult; key: number | undefined } | null>(null);
  const [state, setState] = useState<{ moving: boolean; entering: ReadonlyMap<string, number> }>({
    moving: false,
    entering: NO_ENTERING,
  });
  // Outlives the press's later layouts (the routed wires arriving mid-motion): only a new press,
  // reduced motion or leaving the nested view stops it early.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stop = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setState((held) => (held.moving ? { moving: false, entering: NO_ENTERING } : held));
  }, []);
  useEffect(() => {
    const before = previous.current;
    previous.current = { layout, key: pressKey };
    if (pressKey === undefined || reduced) {
      stop();
      return;
    }
    if (before === null || before.key === pressKey) return;
    const drawn = new Set([
      ...before.layout.nodes.map((node) => node.id),
      ...before.layout.groups.map((group) => group.id),
    ]);
    const fresh = layout.nodes.filter((node) => !drawn.has(node.id)).sort((a, b) => a.y - b.y || a.x - b.x);
    clearTimeout(timer.current);
    setState({
      moving: true,
      entering: new Map(fresh.map((node, index) => [node.id, Math.min(index, 8) * NEST_STAGGER_MS])),
    });
    timer.current = setTimeout(stop, NEST_MOTION_MS);
  }, [layout, pressKey, reduced, stop]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { ...state, animate: !reduced };
}

function withEntering<N extends Node>(node: N, entering: ReadonlyMap<string, number>): N {
  const delay = entering.get(node.id);
  if (delay === undefined) return node;
  return {
    ...node,
    className: `${node.className ?? ""} archer-nest-entering`,
    style: { ...node.style, "--nest-delay": `${delay}ms` } as N["style"],
  };
}

/** A legend member the reader asked to be taken to; `seq` makes a second ask for the same one a new request. */
export type RevealRequest = { readonly channel: MemberChannel; readonly id: string; readonly seq: number };

/** Where a node, element frame or edge is drawn, in flow coordinates; `null` when it is not drawn. */
export function revealBox(
  layout: LayoutResult,
  channel: MemberChannel,
  id: string,
): { x: number; y: number; width: number; height: number } | null {
  if (channel === "nodes") {
    const box =
      layout.nodes.find((node) => node.id === id) ??
      layout.groups.find((group) => group.element === true && group.id === id);
    return box === undefined ? null : { x: box.x, y: box.y, width: box.width, height: box.height };
  }
  const points = layout.edges.find((edge) => edge.id === id)?.points ?? [];
  if (points.length === 0) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/**
 * Whether something the page draws over the canvas -- the diagram panel laid over it below 1500 px, the
 * tools, the off-screen cue, the chat button -- lies at a screen point, or the point is off the canvas.
 * Only the drawing itself (React Flow's renderer: the pane, nodes, edges and their labels) is clear.
 */
function coveredOver(canvas: HTMLElement): CoveredAt {
  const rect = canvas.getBoundingClientRect();
  const drawing = canvas.querySelector(".react-flow__renderer");
  return (x, y) => {
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return true;
    const hit = document.elementFromPoint(x, y);
    return hit === null || drawing === null || !drawing.contains(hit);
  };
}

/**
 * A cover that makes what it lies over inert: the review sheet a phone lays over the page, the phone's Chat
 * sheet, and the fixed Export, accuracy and Compare panels (`COVERS` and `useCoveredInert` in
 * `WebShell.tsx` marks what is under it on its next frame).
 */
const INERTING_COVER =
  ".primary-review-inbox, .archer-artifact-wrapper, .archer-comparison-panel, .archer-chat[data-mode='sheet']";

/** Whether any point of `box` (screen px) lies under an inerting cover. */
function underInertingCover(box: Box): boolean {
  for (let i = 0; i <= 4; i++)
    for (let j = 0; j <= 4; j++) {
      const hit = document.elementFromPoint(box.x + (box.width * i) / 4, box.y + (box.height * j) / 4);
      if (hit?.closest(INERTING_COVER)) return true;
    }
  return false;
}

/**
 * An edge's drawn line on screen, from its rendered path: the geometry the reader sees and its ring is drawn
 * on (R1-codex-19). `null` for a node, or an edge not drawn.
 */
function renderedEdge(domNode: HTMLElement, request: RevealRequest): Box | null {
  if (request.channel !== "edges") return null;
  const path = [...domNode.querySelectorAll<SVGPathElement>(".react-flow__edge path.react-flow__edge-path")].find(
    (element) => element.closest<SVGElement>(".react-flow__edge")?.dataset.id === request.id,
  );
  if (path === undefined) return null;
  const drawn = path.getBoundingClientRect();
  if (drawn.width === 0 && drawn.height === 0) return null;
  return { x: drawn.left, y: drawn.top, width: drawn.width, height: drawn.height };
}

/**
 * Whether keyboard focus just landed on something covered or off the canvas: only then is a reveal
 * asked for, so focus that is already in the clear costs no render.
 */
function coveredFocus(target: EventTarget, surface: HTMLElement | null): boolean {
  if (!(target instanceof Element) || typeof document.elementFromPoint !== "function") return false;
  const canvas = surface?.querySelector<HTMLElement>(".react-flow");
  if (canvas === null || canvas === undefined) return false;
  // Tab focus scrolls the clipped canvas to show what it focuses -- an edge out past the canvas's side, behind
  // the key panel, came into view by 427 px for the moment of this event -- and the scroll is undone after it.
  // Measured scrolled, the edge looked clear and was left behind the panel (R1-codex-19, pass 3): undo it first.
  for (let at: Element | null = target.parentElement; at !== null && canvas.contains(at); at = at.parentElement) {
    if (at.scrollLeft !== 0) at.scrollLeft = 0;
    if (at.scrollTop !== 0) at.scrollTop = 0;
  }
  const rect = canvas.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  const covered = coveredOver(canvas);
  return (
    revealShift(
      { x: box.left, y: box.top, width: box.width, height: box.height },
      uncoveredArea({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, covered),
      covered,
    ) !== null
  );
}

/**
 * Brings a nest toggle ("Open …", "Close …") out from under the panel, the phone's sheet or a control over the
 * canvas when the keyboard focuses it, as `RevealCamera` brings a node (round 1, R4-claude-08). The toggles are
 * screen-space buttons over the flow, so the toggle itself is clear and everything else is judged as for a node.
 */
function NestToggleReveal(props: { onMoved: () => void }): null {
  const { setViewport } = useReactFlow();
  const store = useStoreApi();
  const reduced = useBrowserReducedMotion();
  const latest = useRef({ reduced, onMoved: props.onMoved });
  latest.current = { reduced, onMoved: props.onMoved };
  const domNode = useStore((state) => state.domNode);
  useEffect(() => {
    if (!(domNode instanceof HTMLElement)) return;
    const onFocus = (event: globalThis.FocusEvent): void => {
      const toggle = event.target;
      if (!(toggle instanceof HTMLElement) || !toggle.matches(".archer-nest-toggle") || !focusVisible(toggle)) return;
      if (typeof document.elementFromPoint !== "function") return;
      // Focus scrolls the clipped toggle layer to show a toggle past its edge, and the scroll is not undone: undo it.
      for (let at: Element | null = toggle.parentElement; at !== null && domNode.contains(at); at = at.parentElement) {
        if (at.scrollLeft !== 0) at.scrollLeft = 0;
        if (at.scrollTop !== 0) at.scrollTop = 0;
      }
      const rect = domNode.getBoundingClientRect();
      const over = coveredOver(domNode);
      const covered: CoveredAt = (x, y) => {
        if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return true;
        const hit = document.elementFromPoint(x, y);
        return hit !== null && toggle.contains(hit) ? false : over(x, y);
      };
      const drawn = toggle.getBoundingClientRect();
      const box = { x: drawn.left, y: drawn.top, width: drawn.width, height: drawn.height };
      const shift = revealShift(
        box,
        uncoveredArea({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, covered),
        covered,
      );
      if (shift === null) return;
      const [tx, ty, zoom] = store.getState().transform;
      const jump = latest.current.reduced || underInertingCover(box);
      void setViewport({ x: tx + shift.dx, y: ty + shift.dy, zoom }, jump ? undefined : { duration: 200 });
      latest.current.onMoved();
    };
    domNode.addEventListener("focusin", onFocus);
    return () => domNode.removeEventListener("focusin", onFocus);
  }, [domNode, store, setViewport]);
  return null;
}

/** How many frames a reveal waits for a closing cover to leave room for the member. */
const REVEAL_WAIT_FRAMES = 10;

/**
 * Brings a member on screen when the legend names it or the keyboard focuses it: pans, at the zoom the
 * reader chose, only when some of it -- with its focus ring -- is off the canvas or under the panel or a
 * control over the canvas, and then into the part they leave (R1-codex-19). Instant under reduced motion.
 */
function RevealCamera(props: { layout: LayoutResult; request: RevealRequest | null; onMoved: () => void }): null {
  const { setCenter, setViewport } = useReactFlow();
  const store = useStoreApi();
  const reduced = useBrowserReducedMotion();
  const { layout, request, onMoved } = props;
  useEffect(() => {
    if (request === null) return;
    const box = revealBox(layout, request.channel, request.id);
    if (box === null) return;
    let frame = 0;
    let waited = 0;
    let lastFree: Box | null = null;
    const reveal = (): void => {
      const { transform, domNode } = store.getState();
      const [tx, ty, zoom] = transform;
      if (!(domNode instanceof HTMLElement)) return;
      const rect = domNode.getBoundingClientRect();
      const canvas = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      const onScreen = renderedEdge(domNode, request) ?? {
        x: rect.left + box.x * zoom + tx,
        y: rect.top + box.y * zoom + ty,
        width: box.width * zoom,
        height: box.height * zoom,
      };
      const covered = coveredOver(domNode);
      const free = uncoveredArea(canvas, covered);
      // A cover still closing -- the phone's Highlights sheet a member was tapped in -- leaves a sliver too small to
      // hold the member: measure again once it has gone (a few frames), rather than park the member in the sliver.
      // Only while the clear area is still changing: a cover that stays (the review sheet on a phone) leaves the
      // sliver it leaves, and waiting on it only kept the member under the sheet (round1-f9).
      const growing =
        lastFree === null ||
        free.x !== lastFree.x ||
        free.y !== lastFree.y ||
        free.width !== lastFree.width ||
        free.height !== lastFree.height;
      lastFree = free;
      if ((free.width < onScreen.width || free.height < onScreen.height) && growing && waited < REVEAL_WAIT_FRAMES) {
        waited += 1;
        frame = requestAnimationFrame(reveal);
        return;
      }
      const shift = revealShift(onScreen, free, covered);
      if (shift === null) return;
      // Under the review sheet a glide is too slow: the shell makes what the sheet covers inert on its next frame,
      // and a focused element made inert drops focus to the page (RS2-01). So out from under it at once.
      const jump = reduced || underInertingCover(onScreen);
      void setViewport({ x: tx + shift.dx, y: ty + shift.dy, zoom }, jump ? undefined : { duration: 200 });
      onMoved();
    };
    const { width, height, transform, domNode } = store.getState();
    const [tx, ty, zoom] = transform;
    if (domNode instanceof HTMLElement && typeof document.elementFromPoint === "function") {
      reveal();
      return () => cancelAnimationFrame(frame);
    }
    const inside =
      box.x * zoom + tx >= 0 &&
      box.y * zoom + ty >= 0 &&
      (box.x + box.width) * zoom + tx <= width &&
      (box.y + box.height) * zoom + ty <= height;
    if (inside) return;
    void setCenter(box.x + box.width / 2, box.y + box.height / 2, reduced ? { zoom } : { zoom, duration: 200 });
    onMoved();
  }, [request, layout, store, setCenter, setViewport, reduced, onMoved]);
  return null;
}

/** Chrome floating over the canvas that a walkthrough step is framed clear of. */
const FOLLOW_CHROME = ".react-flow__controls, .archer-chat-fab";
/**
 * A walkthrough's follow camera (ADR 0034 §6): on each new request, one animated `setViewport` to the
 * frame of the step's parts (`walk-camera.ts`); a jump under reduced motion. A request whose parts are
 * not drawn yet (the layout for the opened containers is still on its way) waits for the next layout.
 */
function FollowCamera(props: { layout: LayoutResult; walkCamera: WalkCamera; onMoved: () => void }): null {
  const { setViewport } = useReactFlow();
  const store = useStoreApi();
  const reduced = useBrowserReducedMotion();
  const ready = useStore((state) => state.panZoom !== null);
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const applied = useRef<string | null>(null);
  const { layout, onMoved } = props;
  const { request } = props.walkCamera;
  useEffect(() => {
    // Keyed on the canvas size too: the panel beside it lands after the first frame (it loads when shown), and a
    // step framed for the wider canvas would not be the frame the same step gets on the next visit (D2).
    const at = `${request?.key}@${width}x${height}`;
    if (request === null || !ready || width === 0 || height === 0 || applied.current === at) return;
    const canvas = { width, height };
    // A phone frames the current step alone, closer, with a narrow gutter (`followParts`, O95).
    const parts = followParts(request, canvas);
    const base = fitPadding(canvas, false);
    const padding = withHeading(
      parts.gutter === null ? base : { ...base, left: parts.gutter, right: parts.gutter },
      layout.heading,
    );
    // On a phone the walkthrough's sheet lies over the bottom of the canvas, and the toolbar rides as a row just
    // above it (stage-dock.css): frame in what the two leave.
    const dom = store.getState().domNode;
    const own = dom?.getBoundingClientRect();
    const sheet = dom?.ownerDocument.querySelector(".archer-dock-sheet")?.getBoundingClientRect();
    const bar = dom?.querySelector(".react-flow__controls")?.getBoundingClientRect();
    const lifted = sheet !== undefined && bar !== undefined && bar.width > bar.height && bar.bottom <= sheet.top + 1;
    const coverTop = sheet === undefined ? undefined : lifted ? Math.min(sheet.top, bar.top - 8) : sheet.top;
    const covered =
      own === undefined || coverTop === undefined ? 0 : Math.max(0, own.bottom - Math.max(coverTop, own.top));
    const frame = followFrame({
      layout,
      nodeIds: parts.nodeIds,
      edgeIds: parts.edgeIds,
      margin: parts.margin,
      canvas,
      padding: clearOfChrome(
        { ...padding, bottom: padding.bottom + Math.min(covered, height * 0.7) },
        own ?? { left: 0, top: 0, right: width, bottom: height },
        // The tool rail and the chat button float over the canvas: walked parts framed under them were hidden.
        [...(dom?.ownerDocument.querySelectorAll(FOLLOW_CHROME) ?? [])].map((piece) => piece.getBoundingClientRect()),
      ),
      readable: readingOf(layout).min,
      min: store.getState().minZoom,
    });
    if (frame === null) return;
    applied.current = at;
    void setViewport(frame, reduced ? undefined : { duration: FOLLOW_GLIDE_MS });
    onMoved();
  }, [request, layout, ready, width, height, reduced, store, setViewport, onMoved]);
  return null;
}

/**
 * Lends the camera to the page (`CameraHandle`) for as long as this flow is mounted, from once it has been framed:
 * called after `useFraming`, so in the commit the canvas first has a size its opening framing has already run, and
 * a camera the page puts back is not framed over.
 */
function useLentCamera(
  handle: MutableRefObject<CameraHandle | null> | undefined,
  fit: () => void,
  onMoved: (view: { x: number; y: number; zoom: number }) => void,
): void {
  const { getViewport, setViewport } = useReactFlow();
  const framed = useStore((state) => state.panZoom !== null && state.width > 0 && state.height > 0);
  useEffect(() => {
    if (handle === undefined || !framed) return;
    const own: CameraHandle = {
      get: () => getViewport(),
      set: (view) => {
        void setViewport(view);
        onMoved(view);
      },
      fit,
    };
    handle.current = own;
    return () => {
      if (handle.current === own) handle.current = null;
    };
  }, [handle, framed, getViewport, setViewport, onMoved, fit]);
}

/**
 * Keeps the toggled box where it was on screen: the "+" or "−" stays under the finger, and the
 * camera glides with the boxes rather than jumping (instant under reduced motion). Frames that
 * grow past the edge (a phone) are brought back far enough that their "−" shows
 * (`cameraAfterPress`). An opened frame is then shown whole where it can be: panned the least, and zoomed out
 * only as far as it needs (`showOpened`; second rendered review, 2026-11-13).
 */
function NestCamera(props: {
  layout: LayoutResult;
  anchor: { current: NestAnchor | null };
  animate: boolean;
  onMoved: () => void;
}): null {
  const { setViewport } = useReactFlow();
  const store = useStoreApi();
  useEffect(() => {
    const anchor = props.anchor.current;
    if (anchor === null) return;
    const known =
      props.layout.groups.some((group) => group.id === anchor.groupId) ||
      props.layout.nodes.some((node) => node.folded?.groupId === anchor.groupId);
    if (!known) return;
    props.anchor.current = null;
    const { width, height, transform, domNode } = store.getState();
    const pressed = {
      ...cameraAfterPress({
        layout: props.layout,
        groupId: anchor.groupId,
        screen: anchor.screen,
        zoom: transform[2],
        width,
        height,
      }),
      zoom: transform[2],
    };
    // An opened frame is then brought into view, clear of the rail and the chat button (`showOpened`).
    const opened = props.layout.groups.find((group) => group.id === anchor.groupId);
    const view =
      opened === undefined
        ? pressed
        : frameClearOfChrome({
            base: withHeading(NEST_VIEW_MARGIN, props.layout.heading),
            controls: measureChrome(domNode ?? null, domNode?.querySelector(".react-flow__controls") ?? null),
            floating: measureFloating(domNode ?? null),
            canvas: { width, height },
            frameWith: (padding) =>
              showOpened({
                layout: props.layout,
                groupId: anchor.groupId,
                camera: pressed,
                width,
                height,
                padding,
                floor: readableFloorZoom(),
              }),
            overflowOf: () => NO_OVERFLOW,
            hits: (frame, rect) => hitsAny(drawnOn(insideOf(opened, graphObstacles(props.layout)), frame), rect),
          }).frame;
    void setViewport(view, props.animate ? { duration: NEST_MOTION_MS - 40 } : undefined);
    // The press moved the camera: what the first framing said was off screen no longer holds.
    props.onMoved();
  }, [props.layout, props.anchor, props.animate, props.onMoved, setViewport, store]);
  return null;
}

/** The clear space an opened frame is shown inside, in screen px. */
const NEST_VIEW_MARGIN = { top: 12, right: 12, bottom: 12, left: 12 } as const;

/** What is drawn inside `frame`: what an opened frame must not have under the chrome. */
function insideOf(frame: Box, boxes: readonly Box[]): Box[] {
  return boxes.filter(
    (box) =>
      box.x + box.width / 2 >= frame.x &&
      box.x + box.width / 2 <= frame.x + frame.width &&
      box.y + box.height / 2 >= frame.y &&
      box.y + box.height / 2 <= frame.y + frame.height,
  );
}

/** The React Flow handler props `Flow` sets; typed here so the handlers keep their parameter types. */
type FlowHandlers<N extends Node, E extends Edge> = Pick<
  ReactFlowProps<N, E>,
  | "onInit"
  | "onMouseDownCapture"
  | "onReconnectStart"
  | "onReconnectEnd"
  | "onReconnect"
  | "onNodesChange"
  | "onNodeDragStart"
  | "onNodeDragStop"
  | "onConnectStart"
  | "onConnect"
  | "onConnectEnd"
  | "onNodeDoubleClick"
  | "onNodeMouseEnter"
  | "onNodeMouseLeave"
  | "onNodeMouseMove"
  | "onEdgeDoubleClick"
  | "onNodeClick"
  | "onEdgeClick"
  | "onSelectionStart"
  | "onSelectionEnd"
  | "onPaneClick"
  | "onMoveStart"
  | "onMove"
  | "onMoveEnd"
>;

/** Whether a gesture has moved the camera: more than a couple of pixels, or any zoom. */
export function movedFrom(from: Viewport, to: Viewport): boolean {
  return Math.abs(to.x - from.x) > 2 || Math.abs(to.y - from.y) > 2 || Math.abs(to.zoom - from.zoom) > 1e-3;
}

/**
 * `handlers` with identities that never change: each wrapper calls the handler of the latest render.
 * Assigned during render, not in an effect: React Flow's children report measurements from their own
 * layout effects, which run before a parent's, and must not reach the previous render's closures.
 */
function useLatestHandlers<T extends object>(handlers: T): Required<T> {
  const latest = useRef(handlers);
  latest.current = handlers;
  const [stable] = useState(
    () =>
      Object.fromEntries(
        Object.keys(handlers).map((key) => [
          key,
          (...args: unknown[]) =>
            (latest.current as Record<string, ((...a: unknown[]) => unknown) | undefined>)[key]?.(...args),
        ]),
      ) as Required<T>,
  );
  return stable;
}

type FlowStore = ReturnType<typeof useStoreApi>;

/**
 * Re-measures every node's handles when editing turns on or off or the direction changes: handles are
 * measured once, and their size and side change with both. One batched update for the whole canvas;
 * per-node effects made 150 separate store writes, each running every node's selectors, whenever the
 * editor briefly disabled the canvas (r2-K profile: 0.5 s for one move on flow-large).
 */
function RemeasureHandles(props: { enabled: boolean; direction: string }): null {
  const store = useStoreApi();
  const updateInternals = useUpdateNodeInternals();
  const first = useRef(true);
  useEffect(() => {
    // On mount React Flow measures the nodes itself, with the handles as they are; only a change needs this.
    if (first.current) {
      first.current = false;
      if (!props.enabled) return;
    }
    updateInternals([...store.getState().nodeLookup.keys()]);
  }, [props.enabled, props.direction, store, updateInternals]);
  return null;
}

/** Hands `Flow` (which renders the provider, so cannot call its hooks) React Flow's store. */
function StoreHandle(props: { into: { current: FlowStore | null } }): null {
  props.into.current = useStoreApi();
  return null;
}

/**
 * The camera's zoom as `--archer-canvas-zoom` on the flow, for a touch target drawn inside the drawing: the
 * edge More's hit area divides by it, so it stays 44 screen px however far the drawing is zoomed out (round 1,
 * R5-03). Written from a store subscription, so a pan or zoom re-renders nothing.
 */
function ZoomVar(): null {
  const store = useStoreApi();
  useLayoutEffect(() => {
    let zoom = Number.NaN;
    let node: HTMLElement | null = null;
    const write = (): void => {
      const state = store.getState();
      if (state.transform[2] === zoom && state.domNode === node) return;
      zoom = state.transform[2];
      node = state.domNode;
      node?.style.setProperty("--archer-canvas-zoom", String(zoom));
    };
    write();
    return store.subscribe(write);
  }, [store]);
  return null;
}

/**
 * Everything inside the flow that needs its provider: the framing, the
 * keyboard bindings that drive it, and the control cluster.
 *
 * A child of `ReactFlow` because that is where the provider lives -- the
 * hooks below cannot run in `Flow` itself, which renders it.
 */
function CanvasChrome(props: {
  primaryShell?: boolean;
  pointerMode: PointerMode;
  onPointerModeChange: (mode: PointerMode) => void;
  layout: LayoutResult;
  request: ViewportRequest;
  focusNodeIds: readonly string[];
  reserveLegend: boolean;
  following: RefObject<Following>;
  /** What the framing in force left off screen, and how the hook reports it. */
  overflow: readonly Overflow[];
  /** What is all in view and too small to read ("200 nodes"), or `null`. */
  overview: string | null;
  /** The drawing as that framing draws it, which the cue stays off. */
  blocked: readonly Box[];
  onFramed: (overflow: readonly Overflow[], frame: Frame, showsAll: boolean) => void;
  /** The zoom buttons moved the camera: it is the user's now. */
  onUserZoom: () => void;
  hasSelection: boolean;
  onClearSelection?: () => void;
  onMarqueeChange?: MarqueeChange;
  tools?: ReactNode;
  /** Extra buttons in the canvas control cluster (the editor's undo, redo, delete). */
  controls?: ReactNode;
  /** Where the camera is lent to the page, once framed (`useLentCamera`). */
  cameraHandle?: MutableRefObject<CameraHandle | null> | undefined;
  /** The page moved the camera (to `view`): it is the page's now, unless that is where the framing in force put it. */
  onCameraMoved: (view: { x: number; y: number; zoom: number }) => void;
}): JSX.Element {
  const help = useHelp();
  useMarqueeContents(props.onMarqueeChange);
  const { fitAll, fitReadable, fitOpening, framed } = useFraming({
    layout: props.layout,
    request: props.request,
    focusNodeIds: props.focusNodeIds,
    reserveLegend: props.reserveLegend,
    following: props.following,
    onFramed: props.onFramed,
  });
  useLentCamera(props.cameraHandle, fitOpening, props.onCameraMoved);
  // Whether the opening framing has been made, on the flow's element beside `data-camera`: together they say the
  // drawing is laid out, framed and at rest.
  const flowStore = useStoreApi();
  useLayoutEffect(() => {
    flowStore.getState().domNode?.setAttribute("data-framed", String(framed));
  }, [framed, flowStore]);

  // Fit view and `1` show all of it, as the cue's Show all does (AM-R1-02).
  useCanvasShortcuts({ onFitView: fitAll, enabled: !(help?.open ?? false), ready: framed });
  // On a phone with a sheet open the cluster folds to Fit, Follow steps and this toggle, one row above the sheet
  // (stage-dock.css): unfolded it took two rows of the drawing's strip at 320 px (flows-r1 claude-06, O95).
  const [unfolded, setUnfolded] = useState(false);

  return (
    <>
      {/* No dot grid: the canvas is a plain ground, as the sequence canvas is
          (calmer surfaces, phase 3b). */}
      {/* Zoom is React Flow's behaviour in our buttons (`ZoomButtons`), so its
          glyphs are the cluster's outlines. Fit is ours: React Flow's button
          calls its own `fitView` -- the one that clamps and centres -- before
          any handler it is given, so it is switched off and redrawn here in
          the same place. */}
      <Controls
        showInteractive={false}
        showZoom={false}
        showFitView={false}
        className={unfolded ? "archer-controls-unfolded" : undefined}
      >
        <ZoomButtons onUserZoom={props.onUserZoom} />
        <ControlButton
          className="react-flow__controls-fitview"
          onClick={fitAll}
          title="Fit view (1)"
          aria-label="Fit view"
        >
          <FitGlyph />
        </ControlButton>
        <PanSelectControl mode={props.pointerMode} onChange={props.onPointerModeChange} />
        {props.controls}
        <SourceToolButton />
        <CanvasTools>{props.tools}</CanvasTools>
        {help === null || props.primaryShell ? null : (
          <ControlButton onClick={help.toggle} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
            <HelpGlyph />
          </ControlButton>
        )}
        <ControlButton
          className="archer-controls-fold"
          onClick={() => setUnfolded((shown) => !shown)}
          title={unfolded ? "Fewer canvas controls" : "More canvas controls"}
          aria-label="More canvas controls"
          aria-expanded={unfolded}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
            <circle cx="6" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="18" cy="12" r="1.6" />
          </svg>
        </ControlButton>
      </Controls>
      {/* After the controls in the document, so Tab reaches it after them. */}
      <OffscreenCue
        overflow={props.overflow}
        onShowAll={fitAll}
        blocked={props.blocked}
        overview={props.overview}
        onZoomToRead={fitReadable}
      />
    </>
  );
}

/**
 * The graph canvas with the emphasis channel wrapped around it.
 *
 * A layer of its own because emphasis has two pieces of state the flow itself
 * must not own: which group a legend row is isolating (transient, and the
 * user's), and whether motion is allowed (the viewer's, and it can change
 * mid-session). Both come from `useEmphasisSurface`, which the sequence canvas
 * uses too; they are hooks, so they live above the early returns in
 * `DiagramCanvas` rather than inside them.
 */
function EmphasisSurface(props: {
  /**
   * Keep the legend's corner free whenever the view has emphasis sets, not
   * only while one is drawn: turning a dataflow on or off then never moves
   * the drawing under the reader.
   */
  reserveLegendRoom?: boolean;
  primaryShell?: boolean;
  layout: LayoutResult;
  viewport?: ViewportRequest;
  focus?: DiagramFocus;
  selection?: DiagramSelection;
  emphasis?: Emphasis | null;
  commented?: CommentedElements;
  hasSelection?: boolean;
  authoring?: CanvasAuthoring;
  onNodeClick?: (nodeId: string, additive: boolean) => void;
  onEdgeClick?: (edgeId: string, additive: boolean) => void;
  /** A press on a node or line while the hand is the pointer (it pans and selects nothing): for a host that follows presses, as a walkthrough does. */
  onElementPress?: (channel: "node" | "edge", id: string) => void;
  onPaneClick?: () => void;
  onClearSelection?: () => void;
  onMarqueeStart?: (additive: boolean) => void;
  onMarqueeEnd?: () => void;
  /** What the marquee covers, each time that changes during the drag. */
  onMarqueeChange?: MarqueeChange;
  tools?: ReactNode;
  /** Extra buttons in the canvas control cluster (the editor's undo, redo, delete). */
  controls?: ReactNode;
  nesting?: CanvasNesting;
  walkCamera?: WalkCamera;
  cameraHandle?: MutableRefObject<CameraHandle | null>;
}): JSX.Element {
  // Isolation, reduced motion and the legend are the emphasis channel's own,
  // shared with the sequence canvas (`emphasis/surface.tsx`).
  const nameOf = useMemo(() => {
    // A blank label is no name: the id stands in for it, as it does in the element's own accessible name.
    const nodes = new Map<string, string>(
      [...props.layout.nodes, ...props.layout.groups].map((node) => [
        node.id,
        node.label.replace(/\s+/g, " ").trim() || node.id,
      ]),
    );
    // An edge by its own words where it has them, so two edges between one pair are told apart.
    const edges = new Map(
      props.layout.edges.map((edge) => {
        const ends = `${nodes.get(edge.source) ?? edge.source} → ${nodes.get(edge.target) ?? edge.target}`;
        return [edge.id, edge.label ? `“${edge.label.replace(/ ⓘ$/, "")}” (${ends})` : ends];
      }),
    );
    return (id: string, channel: "nodes" | "edges") => (channel === "nodes" ? nodes : edges).get(id) ?? id;
  }, [props.layout]);
  // The line patterns drawn here and what their author says they mean: the
  // legend's Key while it is up (the Diagram key then leaves them out).
  const keyRows = useMemo(
    () => authoredLineKey(props.layout.edges, props.layout.lineKey, props.layout.notation),
    [props.layout],
  );

  /*
   * KEYBOARD TRAVERSAL, resolved on the surface rather than per element.
   *
   * Delegated: one `keydown` listener on the element that wraps the flow,
   * reading the model id off the element the event started on. The alternative
   * -- a handler per node and per edge, threaded through the adapter -- would
   * put a fresh function identity on every object on every render, and the
   * `nodes`/`edges` memos in `Flow` exist precisely to stop that (see their
   * comment).
   *
   * TWO RINGS, TWO STOPS. Nodes rove among nodes and edges among edges, so a
   * graph of N nodes and M edges has exactly two tab stops however large it
   * gets -- never one per element, which is what React Flow's own `focusable`
   * gave the edges. One merged ring was the alternative and is worse here:
   * an edge is drawn BETWEEN the nodes it joins, so merging would put an edge
   * in the way of every node-to-node arrow press, lengthening the common
   * journey to shorten a rarer one. Two homogeneous rings cost one extra Tab
   * and keep each set's geometry coherent.
   *
   * `focusedNodeId`/`focusedEdgeId` outlive the canvas losing focus so each
   * stop stays where the user left it; `focusedChannel` is what the visible
   * ring follows, and is null whenever focus is outside the surface -- a ring
   * painted then would point at something no key can act on. It also holds the
   * ring to ONE element: standing on an edge must not leave a node ringed.
   */
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [focusedEdgeId, setFocusedEdgeId] = useState<string | null>(null);
  const [focusedChannel, setFocusedChannel] = useState<Channel | null>(null);
  const layoutNodes = useMemo(() => navigableNodes(props.layout), [props.layout]);
  const layoutEdges = props.layout.edges;

  // An edge reduced to the box traversal reads: a point on its routed
  // polyline. That is what lets `rovingStopId` and `nextInDirection` serve
  // both channels rather than each getting its own implementation.
  const edgeNav = useMemo(() => edgeAnchors(layoutEdges, layoutNodes), [layoutEdges, layoutNodes]);

  const keyboard = useMemo<KeyboardNav>(() => {
    const stopId = rovingStopId(layoutNodes, focusedNodeId);
    return { stopId, ringId: focusedChannel === "nodes" ? stopId : null };
  }, [layoutNodes, focusedNodeId, focusedChannel]);

  const edgeKeyboard = useMemo<KeyboardNav>(() => {
    const stopId = rovingStopId(edgeNav, focusedEdgeId);
    return { stopId, ringId: focusedChannel === "edges" ? stopId : null };
  }, [edgeNav, focusedEdgeId, focusedChannel]);

  /**
   * Which channel this event came from, and the model id within it -- or null
   * if it came from anything else: a group frame, a control button, the pane.
   */
  const targetOf = useCallback(
    (target: EventTarget | null): { channel: Channel; id: string } | null => {
      if (!(target instanceof Element)) {
        return null;
      }
      const node = target.closest<HTMLElement>(".react-flow__node")?.dataset.id;
      if (node !== undefined && layoutNodes.some((entry) => entry.id === node)) {
        return { channel: "nodes", id: node };
      }
      // `dataset` is on `SVGElement` too, and React Flow puts `data-id` on the
      // edge's own `<g>`, so this is the same lookup one level out.
      const edge = target.closest(".react-flow__edge");
      const edgeId = edge instanceof SVGElement || edge instanceof HTMLElement ? edge.dataset.id : undefined;
      if (edgeId !== undefined && edgeNav.some((entry) => entry.id === edgeId)) {
        return { channel: "edges", id: edgeId };
      }
      return null;
    },
    [layoutNodes, edgeNav],
  );

  const focusElement = useCallback((channel: Channel, id: string): void => {
    const selector = channel === "nodes" ? ".react-flow__node" : ".react-flow__edge";
    const elements = surfaceRef.current?.querySelectorAll<SVGElement | HTMLElement>(selector);
    for (const element of elements ?? []) {
      // Matched in JS rather than with an attribute selector: a stable id is
      // author-supplied and can hold quotes, which would break the selector.
      if (element.dataset.id === id) {
        element.focus();
        return;
      }
    }
  }, []);

  // The legend's member list takes the reader to a member: its channel's tab
  // stop moves onto it, focus follows, and the camera brings it on screen.
  const [reveal, setReveal] = useState<RevealRequest | null>(null);
  const onReveal = useCallback(
    (id: string, channel: MemberChannel): void => {
      if (channel === "nodes") setFocusedNodeId(id);
      else setFocusedEdgeId(id);
      setReveal((was) => ({ channel, id, seq: (was?.seq ?? 0) + 1 }));
      focusElement(channel, id);
    },
    [focusElement],
  );
  // A drawing in family colours numbers its emphasis groups by default (ADR 0030, amended 2026-11-11).
  const familyColours = useMemo(() => usesFamilyColours(props.layout), [props.layout]);
  const surface = useEmphasisSurface(props.emphasis, "graph", { nameOf, keyRows, onReveal, familyColours });

  const { onNodeClick, onEdgeClick } = props;
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      const from = targetOf(event.target);
      if (from === null) {
        return;
      }
      // A modified arrow belongs to the browser or the OS (word jumps, history,
      // desktop switching); claiming it takes a gesture the user relies on
      // everywhere else.
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      const ring = from.channel === "nodes" ? layoutNodes : edgeNav;

      const direction = directionForKey(event.key);
      if (direction !== null) {
        // Prevented whether or not there is somewhere to go, so the page never
        // scrolls out from under a canvas the user is arrowing across.
        event.preventDefault();
        const next = nextInDirection(ring, from.id, direction);
        if (next !== null) {
          if (from.channel === "nodes") {
            setFocusedNodeId(next);
          } else {
            setFocusedEdgeId(next);
          }
          focusElement(from.channel, next);
        }
        return;
      }

      if (event.key === "Enter" || event.key === " ") {
        // Space is also React Flow's pan-activation key and the page's scroll
        // key; neither should fire when it is being used to select.
        event.preventDefault();
        // The SAME handler a click uses, so a keyboard selection goes through
        // the app's selection reducer and out to the host by exactly the route
        // a pointer selection takes. Shift means what it means for a click.
        if (event.key === "Enter" && authoringEnabled(props.authoring, props.layout)) {
          if (from.channel === "nodes")
            editNodeLabel(props.authoring, from.id, props.layout.nodes.find((node) => node.id === from.id)?.figure);
          else props.authoring?.onEdgeLabelEdit?.(from.id);
        } else if (from.channel === "nodes") {
          onNodeClick?.(from.id, event.shiftKey);
        } else {
          onEdgeClick?.(from.id, event.shiftKey);
        }
      }
    },
    [targetOf, layoutNodes, edgeNav, focusElement, onNodeClick, onEdgeClick, props.authoring, props.layout],
  );

  const handleFocus = useCallback(
    (event: FocusEvent<HTMLDivElement>): void => {
      const from = targetOf(event.target);
      if (from === null) {
        return;
      }
      // Covers the pointer too: clicking an element moves its channel's tab
      // stop onto it, so a user who switches to the keyboard carries on from
      // what they clicked.
      if (from.channel === "nodes") {
        setFocusedNodeId(from.id);
      } else {
        setFocusedEdgeId(from.id);
      }
      // The keyboard ring is for keyboard focus only: a click already shows the accent selection, and
      // the ring beside it read as a second "selected" look (ux:F19). Keyboard focus is also brought
      // out from under the panel and the controls over the canvas (R1-codex-19); a click is where the
      // pointer already is.
      if (focusVisible(event.target)) {
        setFocusedChannel(from.channel);
        if (coveredFocus(event.target, surfaceRef.current))
          setReveal((was) => ({ channel: from.channel, id: from.id, seq: (was?.seq ?? 0) + 1 }));
      }
    },
    [targetOf],
  );

  const handleBlur = useCallback((event: FocusEvent<HTMLDivElement>): void => {
    // A move between two elements reports the incoming one as `relatedTarget`
    // and must not take the ring off; only focus leaving the surface does.
    if (event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setFocusedChannel(null);
  }, []);

  /*
   * PUT DOM FOCUS BACK ON THE EDGE, because React Flow does not keep the
   * element.
   *
   * A node is a `<div>` that survives every render, so `.focus()` on it holds.
   * An edge is not: `EdgeWrapper` returns `null` whenever it reads a position
   * it cannot resolve, so React unmounts the `<svg>` and mounts a fresh one on
   * the next commit -- MEASURED here, with a MutationObserver, on any change to
   * the `nodes` or the `edges` prop. And REMOVING A FOCUSED ELEMENT FIRES NO
   * BLUR: focus lands on `<body>` silently while this component still believes
   * the keyboard is on the edge. Without this the first Enter on an edge would
   * be the last -- the ring and the stop would stay put and no further key
   * would reach anything.
   *
   * The common trigger is gone: `toXFlowNodes` now states each node's size as
   * `measured`, so a new `nodes` array no longer costs the edges their
   * elements (that replacement also swallowed every mouse click on an edge;
   * see `measuredAs`). This stays as the guard for the replacements that
   * remain -- a new layout, an edge whose endpoint is new.
   *
   * A MutationObserver rather than an effect, because the replacement does not
   * happen on this component's commit. React Flow synchronises the controlled
   * `nodes`/`edges` into its own store from an effect of its own and re-renders
   * its subtree afterwards, so every effect here has already run by the time
   * the element goes. What the DOM does is the only reliable signal.
   *
   * The ONLY signal that focus was lost this way is that it has fallen to the
   * document body: removing a focused element fires no blur, and the browser
   * has nowhere else to put it. Anything else holding focus -- another edge,
   * the zoom or help buttons in the control cluster, a legend row, the tab
   * strip outside the canvas -- is somewhere the user or the app put it
   * deliberately, and pulling it back from there is a focus steal.
   *
   * That distinction is load-bearing. The controls and the legend live INSIDE
   * this surface, so "did focus leave the surface" does not separate the two
   * cases: clicking an edge and then the help button leaves `focusedChannel`
   * as "edges", and a restore keyed on anything looser than `body` drags focus
   * off the button the user just pressed -- and, because `HelpOverlay` records
   * the active element after this runs, makes Esc hand focus back to the edge
   * instead of the opener.
   *
   * Focusing re-fires `handleFocus` with the values it already holds, which
   * React bails out of, so this settles rather than looping.
   */
  const edgeFocusTarget = useRef<string | null>(null);

  const restoreEdgeFocus = useCallback((): void => {
    const stopId = edgeFocusTarget.current;
    if (stopId === null) {
      return;
    }
    const active = document.activeElement;
    if (active !== null && active !== document.body) {
      return;
    }
    focusElement("edges", stopId);
  }, [focusElement]);

  // No dependency array: the element can be replaced on a commit where none of
  // these values changed, so the question is not "did anything change" but "is
  // focus still where this component says it is".
  useEffect(() => {
    edgeFocusTarget.current = focusedChannel === "edges" ? edgeKeyboard.stopId : null;
    restoreEdgeFocus();
  });

  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) {
      return;
    }
    const observer = new MutationObserver(restoreEdgeFocus);
    observer.observe(surface, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [restoreEdgeFocus]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the canvas surface handles pointer and key events for the composite drawing inside it, whose parts are focusable (UI_UX.md: every drag has a keyboard path).
    <div
      className={surface.className}
      // What the canvas draws, which the stylesheet weighs its lines by.
      data-notation={props.layout.notation ?? "flowchart"}
      ref={surfaceRef}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <Flow
        primaryShell={props.primaryShell}
        layout={props.layout}
        viewport={props.viewport}
        focus={props.focus}
        selection={props.selection}
        emphasis={surface.render}
        keyboard={keyboard}
        edgeKeyboard={edgeKeyboard}
        reserveLegend={!surface.docked && (surface.hasLegend || (props.reserveLegendRoom ?? false))}
        commented={props.commented}
        hasSelection={props.hasSelection}
        authoring={props.authoring}
        onNodeClick={props.onNodeClick}
        onEdgeClick={props.onEdgeClick}
        onElementPress={props.onElementPress}
        onPaneClick={props.onPaneClick}
        onClearSelection={props.onClearSelection}
        onMarqueeStart={props.onMarqueeStart}
        onMarqueeEnd={props.onMarqueeEnd}
        onMarqueeChange={props.onMarqueeChange}
        tools={props.tools}
        controls={props.controls}
        reveal={reveal}
        {...(props.nesting === undefined ? {} : { nesting: props.nesting })}
        {...(props.walkCamera === undefined ? {} : { walkCamera: props.walkCamera })}
        {...(props.cameraHandle === undefined ? {} : { cameraHandle: props.cameraHandle })}
      />
      {/* What the model says it is (a C4 diagram's title and level, an
          architecture's title): words over the drawing, not part of it. */}
      {props.layout.heading === undefined ? null : <p className="archer-canvas-heading">{props.layout.heading}</p>}
      {surface.legend}
    </div>
  );
}

export function DiagramCanvas(props: {
  primaryShell?: boolean;
  state: CanvasState;
  selection?: DiagramSelection;
  /** The agent's emphasis for the view on screen, or `null` for none. */
  emphasis?: Emphasis | null;
  /**
   * Keep the legend's corner free whenever the view has emphasis sets, not
   * only while one is drawn: turning a dataflow on or off then never moves
   * the drawing under the reader.
   */
  reserveLegendRoom?: boolean;
  /** What comment threads are about, marked on the graph (`comments/state.ts`). */
  commented?: CommentedElements;
  /** Whole sequence-block comment gestures; separate from node/edge selection. */
  blockComments?: boolean;
  onBlockComment?: (fragmentId: string) => void;
  onNoteComment?: (noteId: string) => void;
  hasSelection?: boolean;
  authoring?: CanvasAuthoring;
  onNodeClick?: (nodeId: string, additive: boolean) => void;
  onEdgeClick?: (edgeId: string, additive: boolean) => void;
  /** A press on a node or line while the hand is the pointer (it pans and selects nothing): for a host that follows presses, as a walkthrough does. */
  onElementPress?: (channel: "node" | "edge", id: string) => void;
  onPaneClick?: () => void;
  onClearSelection?: () => void;
  onMarqueeStart?: (additive: boolean) => void;
  onMarqueeEnd?: () => void;
  /** What the marquee covers, each time that changes during the drag. */
  onMarqueeChange?: MarqueeChange;
  tools?: ReactNode;
  /** Extra buttons in the canvas control cluster (the editor's undo, redo, delete). */
  controls?: ReactNode;
  /** The nested view's "+"/"−" and motion (ADR 0029); omitted for the full view. */
  nesting?: CanvasNesting;
  /** A walkthrough's follow camera (ADR 0034 §6); omitted when none is open. */
  walkCamera?: WalkCamera;
  cameraHandle?: MutableRefObject<CameraHandle | null>;
}): JSX.Element {
  const { state } = props;

  if (state.status === "loading") {
    return <CenteredMessage busy>Loading...</CenteredMessage>;
  }

  if (state.status === "empty") {
    return <CenteredMessage>No diagram selected</CenteredMessage>;
  }

  if (state.status === "error") {
    if (state.lastValid) {
      // Drawn, but handed no click handlers, on purpose. This is the page
      // failing to read what it was SENT: the server has moved to a revision
      // this drawing is not, so a selection made here would be stamped with a
      // revision the server no longer serves and be refused as stale. A file
      // that merely fails to COMPILE is the opposite case -- the server still
      // serves this revision -- and that drawing stays interactive under
      // `CompileNotice`, which `App` renders (ADR 0010).
      return (
        <div style={{ position: "relative", width: "100%", height: "100%" }}>
          <ErrorBanner message={state.message} />
          <Flow
            primaryShell={props.primaryShell}
            layout={state.lastValid}
            tools={props.tools}
            controls={props.controls}
          />
        </div>
      );
    }
    return <CenteredMessage>{state.message}</CenteredMessage>;
  }

  if (state.status === "sequence-ready") {
    return (
      // The same selection and the same three handlers the graph canvas gets:
      // participants are selected as nodes and messages as edges, so nothing
      // between here and the reducer knows which canvas the click came from.
      <SequenceCanvas
        primaryShell={props.primaryShell}
        layout={state.sequenceLayout}
        focus={state.focus}
        viewport={state.viewport}
        selection={props.selection}
        emphasis={props.emphasis}
        reserveLegendRoom={props.reserveLegendRoom}
        commented={props.commented}
        blockComments={props.blockComments}
        onBlockComment={props.onBlockComment}
        onNoteComment={props.onNoteComment}
        onNodeClick={props.onNodeClick}
        onEdgeClick={props.onEdgeClick}
        onPaneClick={props.onPaneClick}
        tools={props.tools}
        controls={props.controls}
        {...(props.authoring?.onNodeReorder && props.authoring.disabled !== true
          ? { onParticipantMove: props.authoring.onNodeReorder }
          : {})}
        {...(props.authoring && props.authoring.disabled !== true && props.authoring.onMessageDraw
          ? {
              onMessageDraw: props.authoring.onMessageDraw,
              ...(props.authoring.onEdgeRetarget ? { onMessageRetarget: props.authoring.onEdgeRetarget } : {}),
              ...(props.authoring.onEdgeMove ? { onMessageMove: props.authoring.onEdgeMove } : {}),
              onLabelEdit: (channel: "participants" | "messages", id: string) =>
                channel === "participants"
                  ? props.authoring?.onNodeLabelEdit?.(id)
                  : props.authoring?.onEdgeLabelEdit?.(id),
              editingLabel: props.authoring.editingNodeId
                ? { channel: "participants" as const, id: props.authoring.editingNodeId }
                : props.authoring.editingEdgeId
                  ? { channel: "messages" as const, id: props.authoring.editingEdgeId }
                  : null,
              onLabelCommit: (channel: "participants" | "messages", id: string, text: string) =>
                channel === "participants"
                  ? props.authoring?.onNodeLabelCommit?.(id, text)
                  : props.authoring?.onEdgeLabelCommit?.(id, text),
              onLabelClose: () => {
                props.authoring?.onNodeLabelClose?.();
                props.authoring?.onEdgeLabelClose?.();
              },
              ...(props.authoring.onPartClick
                ? { onPartClick: props.authoring.onPartClick, selectedPart: props.authoring.selectedPart ?? null }
                : {}),
              ...(props.authoring.selectMode ? { selectMode: props.authoring.selectMode } : {}),
            }
          : {})}
      />
    );
  }

  if (state.status === "journey-ready") {
    // Sections and tasks are selected as nodes, through the same handlers.
    return (
      <JourneyCanvas
        journey={state.journey}
        focus={state.focus}
        selection={props.selection}
        emphasis={props.emphasis}
        commented={props.commented}
        onNodeClick={props.onNodeClick}
        onPaneClick={props.onPaneClick}
        tools={props.tools}
        controls={props.controls}
      />
    );
  }

  return (
    <EmphasisSurface
      primaryShell={props.primaryShell}
      layout={state.layout}
      viewport={state.viewport}
      focus={state.focus}
      selection={props.selection}
      emphasis={props.emphasis}
      reserveLegendRoom={props.reserveLegendRoom}
      commented={props.commented}
      hasSelection={props.hasSelection}
      authoring={props.authoring}
      onNodeClick={props.onNodeClick}
      onEdgeClick={props.onEdgeClick}
      onElementPress={props.onElementPress}
      onPaneClick={props.onPaneClick}
      onClearSelection={props.onClearSelection}
      onMarqueeStart={props.onMarqueeStart}
      onMarqueeEnd={props.onMarqueeEnd}
      onMarqueeChange={props.onMarqueeChange}
      tools={props.tools}
      controls={props.controls}
      {...(props.nesting === undefined ? {} : { nesting: props.nesting })}
      {...(props.walkCamera === undefined ? {} : { walkCamera: props.walkCamera })}
      {...(props.cameraHandle === undefined ? {} : { cameraHandle: props.cameraHandle })}
    />
  );
}
