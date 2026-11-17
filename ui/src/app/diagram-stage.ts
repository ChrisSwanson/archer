/**
 * The diagram stage both shells share: what is presented, what the reader has selected, the drawing
 * that is laid out for it and the nested view's state (ADR 0029). The web shell (`App.tsx`) adds the
 * project around it; the MCP shell (`McpApp.tsx`) draws it edge to edge in the host's frame.
 *
 * Three hooks, called where the shell wants their effects to run: `useStage` (state, and turning a
 * presentation into the stage's model), `useStageLayout` (the layout effect) and `useStageGestures`
 * (what a press, a click or a marquee does to the selection, and the nested view's toggles).
 */
import { browserStateKey } from "../runtime/address.ts";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { CameraHandle, CanvasState } from "../diagrams/DiagramCanvas";
import type { CameraView, ElementIds, ModeView, SavedView } from "./diagram-mode";
import {
  elementNodes,
  journeyElements,
  projectEnvelope,
  type ProjectedJourney,
  type ProjectedSequence,
  type ProjectedView,
  type ProjectionResult,
} from "../diagrams/projection";
import type { LayoutResult } from "../layout/elk-adapter";
import { computeBackgroundLayout as computeLayout } from "../layout/elk-worker-transport";
import { isLayoutCancelled, whenPageShown } from "../layout/layout-cancel";
import { computeSequenceLayout } from "../layout/sequence-layout";
import { DEFAULT_TYPEFACE, type TypefaceId } from "../layout/text-measure";
import { canonicalOpen, defaultOpen, nestView, type Nested } from "../nesting/nest-view";
import { drawnIds, modelIds, readNestAddress, type NestMode } from "../nesting/nest-page";
import { cancelNestPrefetch, dropNestPrefetch, nestLayout, prefetchNest, type NestStep } from "../nesting/nest-layout";
import type { CanvasNesting } from "../nesting/NestToggles";
import {
  initialPresentationState,
  presentationReducer,
  type PresentationCommand,
  type PresentationState,
} from "../presentation/controller";
import { selectionReducer } from "../selection/state";
import { sequenceSelectionModel } from "../selection/sequence-selection";
import type { BridgeMessage } from "./host-bridge";
import { onFilesChanged } from "./file-updates";

const EMPTY_STATE: CanvasState = { status: "empty" };

export type PresentMessage = Extract<BridgeMessage, { type: "present" }>;

export function isPresentationCommand(value: unknown): value is PresentationCommand {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.presentationId === "string" && typeof record.viewId === "string";
}

function focusFromState(state: PresentationState): { nodeIds: string[]; edgeIds: string[] } {
  return {
    nodeIds: [...state.focus.nodeIds],
    edgeIds: [...state.focus.edgeIds],
  };
}

function readyState(layout: LayoutResult, state: PresentationState): CanvasState {
  return {
    status: "ready",
    layout,
    focus: focusFromState(state),
    // `generation` advances once per host command, which is exactly when a new
    // framing instruction has arrived and the canvas should act on it.
    viewport: { mode: state.viewport, key: state.generation },
  };
}

type LayoutCache = {
  readonly layoutGeneration: number;
  readonly layout: LayoutResult;
  /** Which view of the model it draws: "full", or the nested view's canonical open set. */
  readonly nestKey: string;
};

/**
 * The nested view's page state for the diagram on screen (ADR 0029): which view, what is open,
 * and the press that got there. Toggles never touch the address or history.
 */
type NestState = {
  readonly viewId: string | null;
  readonly mode: NestMode;
  readonly open: readonly string[];
  /** Counts presses; the canvas animates the layout a new press brings. */
  readonly press: number;
  /** The press still to lay out: grown or closed in place from the open set before it. */
  readonly step?: NestStep;
};

/** What the canvas draws when it draws the nested view: the projection and the press it belongs to. */
export type DrawnNest = { readonly full: ProjectedView; readonly nested: Nested; readonly press: number };

/** The nest state the graph on screen was laid out for, nested or whole: what a camera restore waits for. */
export type DrawnAt = { readonly viewId: string; readonly mode: NestMode; readonly press: number };

const NEST_MODE_KEY = "archer.nest.mode";
function rememberedNestMode(): NestMode | null {
  try {
    const held = window.localStorage.getItem(browserStateKey(NEST_MODE_KEY));
    return held === "nested" || held === "full" ? held : null;
  } catch {
    return null;
  }
}
function rememberNestMode(mode: NestMode): void {
  try {
    window.localStorage.setItem(browserStateKey(NEST_MODE_KEY), mode);
  } catch {
    /* a convenience only */
  }
}

/** The nested view's state when a diagram is opened: the address wins, then the reader's last choice. */
function openingNest(view: ProjectedView): NestState {
  const address = readNestAddress(window.location.search);
  const mode = address.zoom ?? rememberedNestMode() ?? "nested";
  const open = address.open.length > 0 ? canonicalOpen(view, address.open) : defaultOpen(view);
  return { viewId: view.viewId, mode, open, press: 0 };
}

export type ProjectedModel =
  | { type: "graph"; view: ProjectedView }
  | { type: "sequence"; view: ProjectedSequence }
  | { type: "journey"; view: ProjectedJourney };

/** A projection that succeeded, as the model the stage holds. */
export function projectedModel(projection: Extract<ProjectionResult, { ok: true }>): ProjectedModel {
  return projection.type === "sequence"
    ? { type: "sequence", view: projection.view }
    : projection.type === "journey"
      ? { type: "journey", view: projection.view }
      : { type: "graph", view: projection.view };
}

/** What can be selected in the view on screen, with what the host is told of each. */
export function selectionDetails(projected: ProjectedModel): {
  readonly nodeDetails: ReadonlyMap<string, { label: string }>;
  readonly edgeDetails: ReadonlyMap<string, { source: string; target: string; label?: string }>;
} {
  if (projected.type === "sequence") {
    return sequenceSelectionModel(projected.view);
  }
  if (projected.type === "journey") {
    // Sections and tasks; a journey has no links.
    return {
      nodeDetails: new Map(journeyElements(projected.view).map((n) => [n.id, { label: n.label }] as const)),
      edgeDetails: new Map(),
    };
  }
  // Every node, and every group that is a model element (a composite state):
  // `elementNodes` is the one list of what is selected as a node.
  return {
    nodeDetails: new Map(elementNodes(projected.view).map((n) => [n.id, { label: n.label }] as const)),
    edgeDetails: new Map(
      projected.view.edges.map((e) => [e.id, { source: e.source, target: e.target, label: e.label }] as const),
    ),
  };
}

/** The ids of everything selectable, which is also everything a recompile can keep. */
export function selectableIds(projected: ProjectedModel): { nodeIds: string[]; edgeIds: string[] } {
  const { nodeDetails, edgeDetails } = selectionDetails(projected);
  return { nodeIds: [...nodeDetails.keys()], edgeIds: [...edgeDetails.keys()] };
}

/** Whether the canvas has a drawing up, current or the last valid one under an error. */
export function hasDrawing(canvasState: CanvasState): boolean {
  return (
    canvasState.status === "ready" ||
    canvasState.status === "sequence-ready" ||
    canvasState.status === "journey-ready" ||
    (canvasState.status === "error" && canvasState.lastValid !== undefined)
  );
}

type PresentationValue = ReturnType<typeof presentationReducer>;
type SelectionState = ReturnType<typeof selectionReducer>;
type SelectionAction = Parameters<typeof selectionReducer>[1];
type PresentationAction = Parameters<typeof presentationReducer>[1];

export type Stage = {
  readonly presentation: PresentationValue;
  readonly dispatchPresentation: Dispatch<PresentationAction>;
  readonly selection: SelectionState;
  readonly dispatchSelection: Dispatch<SelectionAction>;
  readonly canvasState: CanvasState;
  readonly setCanvasState: Dispatch<SetStateAction<CanvasState>>;
  /** Committed with a ready canvas, never with an incoming projection: a live redraw keeps the previous drawing while its new layout is in flight. */
  readonly drawnKeyModel: ProjectedModel | null;
  readonly setDrawnKeyModel: Dispatch<SetStateAction<ProjectedModel | null>>;
  readonly drawnNest: DrawnNest | null;
  readonly setDrawnNest: Dispatch<SetStateAction<DrawnNest | null>>;
  /** Null while no graph is drawn (a sequence, a journey, nothing). */
  readonly drawnAt: DrawnAt | null;
  readonly setDrawnAt: Dispatch<SetStateAction<DrawnAt | null>>;
  readonly presentationRef: MutableRefObject<PresentationState | null>;
  readonly projectedRef: MutableRefObject<ProjectedModel | null>;
  readonly layoutCacheRef: MutableRefObject<LayoutCache | null>;
  /** The nested view (ADR 0029): page state in a ref, with a counter that re-runs the layout. */
  readonly nestRef: MutableRefObject<NestState>;
  readonly nestVersion: number;
  readonly bumpNest: () => void;
  /**
   * The view the canvas is currently drawing, which is not the same as the
   * view the presentation state names while a new layout is still computing.
   */
  readonly displayedViewIdRef: MutableRefObject<string | null>;
  /** The graph canvas's camera, while one is mounted (`DiagramCanvas`'s `cameraHandle`): what a mode saves and puts back. */
  readonly cameraRef: MutableRefObject<CameraHandle | null>;
  /** Counts the cameras lent: a restore waiting for a camera (the reader's drawing back after editing) runs then. */
  readonly cameraBound: number;
  /** Puts a presentation on the stage: a page turn, a live-reload redraw, or an envelope it cannot draw. */
  readonly present: (msg: PresentMessage) => void;
  /** Nothing is presented: the stage is emptied. */
  readonly reset: () => void;
};

export function useStage(): Stage {
  const [presentation, dispatchPresentation] = useReducer(presentationReducer, initialPresentationState());
  const [selection, dispatchSelection] = useReducer(selectionReducer, null);
  const [canvasState, setCanvasState] = useState<CanvasState>(EMPTY_STATE);
  const [drawnKeyModel, setDrawnKeyModel] = useState<ProjectedModel | null>(null);
  const presentationRef = useRef<PresentationState | null>(presentation);
  const projectedRef = useRef<ProjectedModel | null>(null);
  const layoutCacheRef = useRef<LayoutCache | null>(null);
  const nestRef = useRef<NestState>({ viewId: null, mode: "nested", open: [], press: 0 });
  const [nestVersion, bumpNest] = useReducer((n: number) => n + 1, 0);
  const [drawnNest, setDrawnNest] = useState<DrawnNest | null>(null);
  const [drawnAt, setDrawnAt] = useState<DrawnAt | null>(null);
  const displayedViewIdRef = useRef<string | null>(null);
  // A ref the canvas writes when it lends its camera (once framed) and clears when it unmounts; a new one is counted.
  const [cameraBound, countCamera] = useReducer((n: number) => n + 1, 0);
  const cameraRef = useMemo<MutableRefObject<CameraHandle | null>>(() => {
    let held: CameraHandle | null = null;
    return {
      get current() {
        return held;
      },
      set current(next) {
        held = next;
        if (next !== null) countCamera();
      },
    };
  }, []);

  useEffect(() => {
    presentationRef.current = presentation;
  }, [presentation]);

  const present = useCallback((msg: PresentMessage) => {
    const projection: ProjectionResult = projectEnvelope(msg.envelope);
    if (!projection.ok) {
      const message = projection.errors.map((e) => e.message).join("; ") || "Invalid diagram envelope";
      setCanvasState((prev) => ({
        status: "error",
        message,
        lastValid: prev.status === "ready" ? prev.layout : prev.status === "error" ? prev.lastValid : undefined,
      }));
      return;
    }

    const view = projection.view;
    const command: PresentationCommand = isPresentationCommand(msg.presentation)
      ? (msg.presentation as PresentationCommand)
      : { presentationId: view.viewId, viewId: view.viewId };

    const prevPresentation = presentationRef.current;
    // Landing on a different view (or a different presentation) is a page
    // turn: nothing from the old one carries over.
    const isPageTurn =
      prevPresentation === null ||
      prevPresentation.presentationId !== command.presentationId ||
      prevPresentation.viewId !== command.viewId;
    // The same view at a new revision is a live-reload redraw, not a page
    // turn. The selection the canvas publishes is stamped with the revision it
    // was made against, and the host refuses a stale stamp on both transports
    // (409 over HTTP, `revision_conflict` from `set_selection`), so the redraw
    // has to re-baseline it.
    const isRevisionChange = !isPageTurn && prevPresentation.revision !== view.revision;

    const projected = projectedModel(projection);
    projectedRef.current = projected;

    dispatchPresentation({ type: "present", command, revision: view.revision });

    if (isPageTurn) {
      dispatchSelection({
        type: "page_turn",
        viewId: view.viewId,
        revision: view.revision,
        presentationId: command.presentationId,
      });
      return;
    }

    if (isRevisionChange) {
      // Whatever the recompiled model still contains stays selected.
      dispatchSelection({ type: "revision_change", revision: view.revision, ...selectableIds(projected) });
    }
  }, []);

  const reset = useCallback(() => {
    projectedRef.current = null;
    layoutCacheRef.current = null;
    dispatchPresentation({ type: "reset" });
    dispatchSelection({ type: "clear" });
    setCanvasState(EMPTY_STATE);
  }, []);

  return {
    presentation,
    dispatchPresentation,
    selection,
    dispatchSelection,
    canvasState,
    setCanvasState,
    drawnKeyModel,
    setDrawnKeyModel,
    drawnNest,
    setDrawnNest,
    drawnAt,
    setDrawnAt,
    presentationRef,
    projectedRef,
    layoutCacheRef,
    nestRef,
    nestVersion,
    bumpNest,
    displayedViewIdRef,
    cameraRef,
    cameraBound,
    present,
    reset,
  };
}

/**
 * Compute (or reuse) layout whenever the presentation state changes. `onStage` false (the editor's own route,
 * which draws its own preview) holds a graph's layout back until the stage is shown: no layout worker for a
 * drawing nobody sees.
 */
export function useStageLayout(stage: Stage, typeface: TypefaceId, nestedViewAllowed: boolean, onStage = true): void {
  const {
    presentation,
    nestVersion,
    setCanvasState,
    setDrawnKeyModel,
    setDrawnNest,
    setDrawnAt,
    projectedRef,
    layoutCacheRef,
    nestRef,
    displayedViewIdRef,
  } = stage;
  // A layout the page stopped as it was left is asked again when the page is shown again (bfcache, O23).
  const [shownAgain, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (presentation === null) {
      displayedViewIdRef.current = null;
      setDrawnKeyModel(null);
      setDrawnNest(null);
      setDrawnAt(null);
      setCanvasState(EMPTY_STATE);
      return;
    }

    const projected = projectedRef.current;
    if (projected === null || projected.view.viewId !== presentation.viewId) {
      // No projected view available for the current presentation state yet.
      return;
    }

    // Sequence diagrams use synchronous layout -- no caching needed.
    if (projected.type === "sequence") {
      const sequenceLayout = computeSequenceLayout(projected.view, typeface);
      const focus = {
        participantIds: [...presentation.focus.nodeIds],
        messageIds: [...presentation.focus.edgeIds],
      };
      displayedViewIdRef.current = presentation.viewId;
      setDrawnKeyModel(projected);
      setDrawnNest(null);
      setDrawnAt(null);
      setCanvasState({
        status: "sequence-ready",
        sequenceLayout,
        focus,
        // The same framing instruction the graph canvas receives; see `readyState`.
        viewport: { mode: presentation.viewport, key: presentation.generation },
      });
      return;
    }

    // A journey needs no layout: the browser lays its text out.
    if (projected.type === "journey") {
      displayedViewIdRef.current = presentation.viewId;
      setDrawnKeyModel(projected);
      setDrawnNest(null);
      setDrawnAt(null);
      setCanvasState({
        status: "journey-ready",
        journey: projected.view,
        focus: { nodeIds: [...presentation.focus.nodeIds] },
        viewport: { mode: presentation.viewport, key: presentation.generation },
      });
      return;
    }

    // Graph layout path (async, cached), only once the stage is on screen.
    if (!onStage) return;
    const full = projected.view;
    // The nested view, unless this project turned it off or the diagram has no containers.
    if (nestRef.current.viewId !== full.viewId) nestRef.current = openingNest(full);
    const nest = nestRef.current;
    const nestOn = nestedViewAllowed && full.groups.length > 0 && nest.mode === "nested";
    const nested = nestOn ? nestView(full, nest.open) : null;
    const view = nested?.view ?? full;
    const nestKey = nested === null ? "full" : `nested:${nested.open.join(",")}`;
    const step = nest.step;
    const press = nest.press;
    const drawn: DrawnNest | null = nested === null ? null : { full, nested, press };
    const at: DrawnAt = { viewId: full.viewId, mode: nest.mode, press };
    const drawAt = (): void =>
      setDrawnAt((held) =>
        held !== null && held.viewId === at.viewId && held.mode === at.mode && held.press === at.press ? held : at,
      );

    const cache = layoutCacheRef.current;
    // The generation moves with the revision; the direction is what the layout
    // was computed from, so it is checked too rather than trusted to the hash.
    if (
      cache !== null &&
      cache.layoutGeneration === presentation.layoutGeneration &&
      (cache.layout.direction ?? "tb") === (view.direction ?? "tb") &&
      // ...and the face it was sized for: switching design re-lays the graph
      // out, because the same label is a different width in another face.
      (cache.layout.typeface ?? DEFAULT_TYPEFACE) === typeface &&
      // ...and the same view of the model: full, or the same open set.
      cache.nestKey === nestKey
    ) {
      displayedViewIdRef.current = presentation.viewId;
      setDrawnKeyModel(projected);
      setDrawnNest(drawn);
      drawAt();
      setCanvasState(readyState(cache.layout, presentation));
      return;
    }

    const requestedGeneration = presentation.layoutGeneration;
    /*
     * THE ONE GUARD against a stale layout. Layout is asynchronous, so a
     * result can arrive after a newer presentation -- another view, a new
     * revision, a design in another face -- has taken the page. Every one of
     * those changes a dependency of this effect, and React runs this effect's
     * cleanup before the next run, so `cancelled` is true for exactly the
     * results nobody is waiting for.
     *
     * There used to be a second check beside it, comparing `layoutGeneration`
     * on a ref. It could never be the one that fired -- a generation only
     * moves through `presentation`, which is a dependency here -- so removing
     * it changed nothing and no test could tell (release review 2026-10-01,
     * mutant U1). One guard, pinned by `tests/layout-pipeline.test.tsx`.
     */
    let cancelled = false;
    let forgetShown = (): void => undefined;
    // A live-reload redraw recomputes layout for a view that is already on
    // screen. That drawing is still a truthful picture of the view until the
    // new one is ready, so it stays mounted: dropping to "loading" would
    // unmount React Flow and cost the user a blank frame and their pan and
    // zoom on every save. Only a view with nothing to keep shows the message.
    const keepsCurrentCanvas = displayedViewIdRef.current === presentation.viewId;
    setCanvasState((prev) => (keepsCurrentCanvas && prev.status === "ready" ? prev : { status: "loading" }));

    const show = (layout: LayoutResult): void => {
      displayedViewIdRef.current = presentation.viewId;
      setDrawnKeyModel(projected);
      setDrawnNest(drawn);
      drawAt();
      setCanvasState(readyState(layout, presentation));
    };
    // The nested view: grown or closed in place from the open set before the press, boxes first
    // and routed wires after (`nesting/nest-layout.ts`). The press is consumed once asked for.
    if (nested !== null) nestRef.current = { ...nest, step: undefined };
    const answer =
      nested === null
        ? { first: null, complete: computeLayout(view, typeface) }
        : nestLayout({ full, typeface, revision: full.revision }, nested.open, step);
    answer.first?.then(
      (layout) => {
        if (!cancelled) show(layout);
      },
      () => undefined,
    );
    answer.complete
      .then((layout) => {
        if (cancelled) {
          return;
        }
        layoutCacheRef.current = { layoutGeneration: requestedGeneration, layout, nestKey };
        show(layout);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        // Stopped because the page is going: nothing failed. What is on screen stays until it is shown again.
        if (isLayoutCancelled(error)) {
          forgetShown = whenPageShown(redraw);
          return;
        }
        setCanvasState((prev) => ({
          status: "error",
          message: error instanceof Error ? error.message : "Layout computation failed",
          lastValid: prev.status === "ready" ? prev.layout : cache?.layout,
        }));
      });

    return () => {
      cancelled = true;
      forgetShown();
    };
    // The setters and refs are the stage's own, stable for its life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentation, typeface, nestVersion, nestedViewAllowed, shownAgain, onStage]);
}

export type StageGestureOptions = {
  readonly typeface: TypefaceId;
  /** A press on an element, before it selects (`selects` false for the hand): a walkthrough jumps to the step that names it, or is left (D4). */
  readonly onPress?: (
    ids: { readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] },
    selects: boolean,
  ) => void;
  /** The reader did something to the drawing. */
  readonly onInteract?: () => void;
};

export type StageGestures = {
  readonly handleMarqueeChange: (nodeIds: readonly string[], edgeIds: readonly string[]) => void;
  readonly handleNodeClick: (nodeId: string, additive: boolean) => void;
  readonly handleEdgeClick: (edgeId: string, additive: boolean) => void;
  readonly handleElementPress: (channel: "node" | "edge", id: string) => void;
  readonly handleMarqueeStart: (additive: boolean) => void;
  readonly handleMarqueeEnd: () => void;
  readonly handleClearSelection: () => void;
  readonly handleNestMode: (mode: NestMode) => void;
  /** A walkthrough opens containers for its step: the open set to reach, grown in place when it is one more. Returns its press. */
  readonly openContainers: (open: readonly string[], toggled?: string) => number | null;
  readonly canvasNesting: CanvasNesting | undefined;
};

export function useStageGestures(stage: Stage, options: StageGestureOptions): StageGestures {
  const { dispatchSelection, projectedRef, nestRef, bumpNest, drawnNest } = stage;
  const { typeface } = options;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Whether a marquee drag is in progress. See `handleMarqueeChange`: a
  // report of what a rectangle covers counts only inside the drag it is from.
  const marqueeActiveRef = useRef(false);

  /**
   * What a marquee covers, which is the ONE thing this page takes from the
   * canvas rather than resolving itself: which nodes a rectangle touches is
   * the canvas's geometry to know.
   *
   * Exactly one writer per gesture. A click is resolved below, from the
   * click's own modifier state. React Flow forms its own opinion of that same
   * click and, for an additive one, an OPPOSITE one -- it adds the node its
   * store thinks is unselected while this page removes the node it knows is
   * selected. With both writing, the controlled `nodes` prop and React Flow's
   * store take turns overruling each other through the sync effect, which
   * React ends at fifty nested updates with "Maximum update depth exceeded"
   * from a stack naming nothing here. It surfaced as roughly a one-in-three
   * failure of the whole UI suite, and only under the load of a full run --
   * the same shape, and the same cause, as the loop recorded on
   * `canvasSelection` below.
   *
   * So React Flow's account of the selection (`onSelectionChange`) is not
   * listened to AT ALL. It used to be, during a marquee only; but that account
   * is read from flags this page's own renders overwrite, and a late render
   * made it drop a node the rectangle covered (`useMarqueeContents` has the
   * trace). The canvas now reports the rectangle's contents from the
   * rectangle. The ref still gates it: a report belongs to the drag that
   * `marquee_start` opened, and the reducer merges it into the selection held
   * then.
   */
  // What the canvas reports is DRAWN ids; the page selects model ids (ADR 0029 §3): a closed
  // element box is its group, a bundle its member edges, a closed subgraph nothing.
  const drawnNestRef = useRef<DrawnNest | null>(null);
  drawnNestRef.current = drawnNest;
  const toModel = useCallback(
    (nodeIds: readonly string[], edgeIds: readonly string[]): { nodeIds: string[]; edgeIds: string[] } => {
      const drawn = drawnNestRef.current;
      if (drawn === null) return { nodeIds: [...nodeIds], edgeIds: [...edgeIds] };
      // A frame's part Expand added (`xf~…`, ADR 0036 A10) is not the nested view's: it is selected as drawn.
      const nodes = nodeIds
        .filter((id) => !id.startsWith("group:"))
        .flatMap((id) => (id.startsWith("xf~") ? [id] : modelIds(drawn.nested, "node", id).nodeIds));
      const edges = edgeIds.flatMap((id) => (id.startsWith("xf~") ? [id] : modelIds(drawn.nested, "edge", id).edgeIds));
      return { nodeIds: [...new Set(nodes)], edgeIds: [...new Set(edges)] };
    },
    [],
  );

  const handleMarqueeChange = useCallback(
    (nodeIds: readonly string[], edgeIds: readonly string[]) => {
      if (!marqueeActiveRef.current) {
        return;
      }
      dispatchSelection({ type: "select", ...toModel(nodeIds, edgeIds) });
    },
    [dispatchSelection, toModel],
  );

  /*
   * A click resolves here, and whether it ADDS is part of the click.
   *
   * This used to dispatch the one clicked id unconditionally, which is what
   * made additive selection unreachable: the canvas is redrawn from this
   * value, so a plain replace overwrote anything a modifier had achieved.
   * React Flow cannot own the decision either -- the flow is controlled and
   * passes no `onNodesChange`, so its store drops every selection change it
   * makes (`triggerNodeChanges`) and reports nothing while Shift is held.
   */
  const handleNodeClick = useCallback(
    (nodeId: string, additive: boolean) => {
      const ids = toModel([nodeId], []);
      if (ids.nodeIds.length === 0) return;
      optionsRef.current.onPress?.(ids, true);
      optionsRef.current.onInteract?.();
      dispatchSelection(additive ? { type: "toggle", ...ids } : { type: "select", ...ids });
    },
    [dispatchSelection, toModel],
  );

  // The hand pans and selects nothing, but a walkthrough still follows a press on an element it names.
  const handleElementPress = useCallback(
    (channel: "node" | "edge", id: string) => {
      optionsRef.current.onPress?.(channel === "node" ? toModel([id], []) : toModel([], [id]), false);
    },
    [toModel],
  );

  const handleEdgeClick = useCallback(
    (edgeId: string, additive: boolean) => {
      const ids = toModel([], [edgeId]);
      if (ids.edgeIds.length === 0) return;
      optionsRef.current.onPress?.(ids, true);
      optionsRef.current.onInteract?.();
      dispatchSelection(additive ? { type: "toggle", ...ids } : { type: "select", ...ids });
    },
    [dispatchSelection, toModel],
  );

  /** "+" or "−": the next open set, grown or closed in place from this one. */
  const handleNestToggle = useCallback(
    (groupId: string, open: boolean) => {
      const full = projectedRef.current?.type === "graph" ? projectedRef.current.view : null;
      if (full === null) return;
      const nest = nestRef.current;
      const from = canonicalOpen(full, nest.open);
      // Closing drops what was open inside it: canonicalOpen keeps only what one click at a time reaches.
      const target = canonicalOpen(full, open ? [...from, groupId] : from.filter((id) => id !== groupId));
      if (target.join(",") === from.join(",")) return;
      cancelNestPrefetch();
      nestRef.current = { ...nest, open: target, press: nest.press + 1, step: { from, toggled: groupId } };
      bumpNest();
    },
    [projectedRef, nestRef, bumpNest],
  );

  const openContainers = useCallback(
    (open: readonly string[], toggled?: string): number | null => {
      const full = projectedRef.current?.type === "graph" ? projectedRef.current.view : null;
      if (full === null) return null;
      const nest = nestRef.current;
      const from = canonicalOpen(full, nest.open);
      const target = canonicalOpen(full, open);
      if (target.join(",") === from.join(",")) return null;
      cancelNestPrefetch();
      nestRef.current = {
        ...nest,
        open: target,
        press: nest.press + 1,
        step: toggled === undefined ? undefined : { from, toggled },
      };
      bumpNest();
      return nest.press + 1;
    },
    [projectedRef, nestRef, bumpNest],
  );

  const handleNestMode = useCallback(
    (mode: NestMode) => {
      rememberNestMode(mode);
      cancelNestPrefetch();
      nestRef.current = { ...nestRef.current, mode, step: undefined };
      bumpNest();
    },
    [nestRef, bumpNest],
  );

  const nestPrefetch = useMemo(
    () => ({
      run: (order: readonly string[]) => {
        const drawn = drawnNestRef.current;
        if (drawn === null) return;
        prefetchNest({ full: drawn.full, typeface, revision: drawn.full.revision }, drawn.nested.open, order);
      },
      cancel: cancelNestPrefetch,
    }),
    [typeface],
  );

  const canvasNesting = useMemo<CanvasNesting | undefined>(
    () =>
      drawnNest === null
        ? undefined
        : { onToggle: handleNestToggle, pressKey: drawnNest.press, prefetch: nestPrefetch },
    [drawnNest, handleNestToggle, nestPrefetch],
  );

  // Anything laid out ahead is stale once a file changes.
  useEffect(() => onFilesChanged(dropNestPrefetch), []);

  // A marquee reports the rectangle's CURRENT contents each time they change
  // -- not a delta, and not what was held when the drag began -- so whether
  // this drag adds has to be captured at the start.
  const handleMarqueeStart = useCallback(
    (additive: boolean) => {
      optionsRef.current.onInteract?.();
      marqueeActiveRef.current = true;
      dispatchSelection({ type: "marquee_start", additive });
    },
    [dispatchSelection],
  );

  const handleMarqueeEnd = useCallback(() => {
    marqueeActiveRef.current = false;
    dispatchSelection({ type: "marquee_end" });
  }, [dispatchSelection]);

  // Clicking empty canvas, pressing Esc and pressing the Reset control are one
  // behaviour with three triggers, so they are one handler.
  const handleClearSelection = useCallback(() => {
    optionsRef.current.onInteract?.();
    dispatchSelection({ type: "select", nodeIds: [], edgeIds: [] });
  }, [dispatchSelection]);

  return {
    handleMarqueeChange,
    handleNodeClick,
    handleEdgeClick,
    handleElementPress,
    handleMarqueeStart,
    handleMarqueeEnd,
    handleClearSelection,
    handleNestMode,
    openContainers,
    canvasNesting,
  };
}

/**
 * The view a mode saves and puts back (D1): nested or whole, the open set, and the camera. Restoring the nest
 * state lays it out (an open set seen before is the same layout, at once); the camera goes back once that layout
 * is drawn and a camera is lent, so it frames what it framed. The wait belongs to that diagram and that nest
 * state: another diagram or a later press cancels it. With no camera saved, the restored view is fitted.
 * `leaving`: the reading drawing is on its way out for the editor (it stays up while the editor draws, App.tsx), so
 * a camera restored now is held for its return, as it was when the drawing left at once.
 */
export function useStageView(
  stage: Stage,
  follow: { readonly on: boolean; readonly set: (on: boolean) => void },
  leaving = false,
): ModeView {
  const { projectedRef, nestRef, cameraRef, bumpNest, presentation, drawnAt, cameraBound } = stage;
  const pending = useRef<{
    readonly viewId: string;
    readonly mode: NestMode;
    readonly press: number;
    readonly camera: CameraView | "fit";
  } | null>(null);
  const followRef = useRef(follow);
  followRef.current = follow;
  const leavingRef = useRef(leaving);
  leavingRef.current = leaving;
  const drawnRef = useRef(drawnAt);
  drawnRef.current = drawnAt;
  // A new framing: a presentation that frames itself. A live redraw keeps the viewport and is not one.
  const framingRef = useRef({ generation: 0, framing: 0 });
  if (presentation !== null && presentation.generation !== framingRef.current.generation) {
    framingRef.current = {
      generation: presentation.generation,
      framing: presentation.viewport === "preserve" ? framingRef.current.framing : presentation.generation,
    };
  }
  const framing = framingRef.current.framing;
  const read = useCallback((): SavedView | null => {
    const full = projectedRef.current?.type === "graph" ? projectedRef.current.view : null;
    if (full === null || nestRef.current.viewId !== full.viewId) return null;
    const nest = nestRef.current;
    return {
      viewId: full.viewId,
      nest: nest.mode,
      open: [...nest.open],
      camera: cameraRef.current?.get() ?? null,
      follow: followRef.current.on,
      framing: framingRef.current.framing,
    };
  }, [projectedRef, nestRef, cameraRef]);
  const apply = useCallback((): void => {
    const want = pending.current;
    if (want === null || leavingRef.current) return;
    const nest = nestRef.current;
    if (nest.viewId !== want.viewId || nest.mode !== want.mode || nest.press !== want.press) {
      pending.current = null;
      return;
    }
    const drawn = drawnRef.current;
    const camera = cameraRef.current;
    if (
      camera === null ||
      drawn === null ||
      drawn.viewId !== want.viewId ||
      drawn.mode !== want.mode ||
      drawn.press !== want.press
    )
      return;
    pending.current = null;
    if (want.camera === "fit") camera.fit();
    else camera.set(want.camera);
  }, [nestRef, cameraRef]);
  const restore = useCallback(
    (saved: SavedView, how: { readonly alsoOpen: ElementIds | null; readonly camera: boolean }): void => {
      followRef.current.set(saved.follow);
      pending.current = null;
      const full = projectedRef.current?.type === "graph" ? projectedRef.current.view : null;
      // Another diagram has the stage: the saved view was of the one that left.
      if (full === null || saved.viewId !== full.viewId || nestRef.current.viewId !== full.viewId) return;
      // What a click off the path selected stays drawn: the containers around it stay open.
      const around = how.alsoOpen === null ? [] : containersAround(full, how.alsoOpen);
      const open = canonicalOpen(full, [...saved.open, ...around]);
      const nest = nestRef.current;
      if (nest.mode !== saved.nest || canonicalOpen(full, nest.open).join(",") !== open.join(",")) {
        if (nest.mode !== saved.nest) rememberNestMode(saved.nest);
        cancelNestPrefetch();
        nestRef.current = { ...nest, mode: saved.nest, open, press: nest.press + 1, step: undefined };
        bumpNest();
      }
      if (!how.camera) return;
      const now = nestRef.current;
      pending.current = { viewId: full.viewId, mode: now.mode, press: now.press, camera: saved.camera ?? "fit" };
      apply();
    },
    [projectedRef, nestRef, bumpNest, apply],
  );
  useEffect(apply, [drawnAt, cameraBound, apply, leaving]);
  return useMemo(() => ({ read, restore, framing }), [read, restore, framing]);
}

/** Every container around the given model elements (an edge by its ends). */
function containersAround(view: ProjectedView, ids: ElementIds): string[] {
  const parent = new Map(view.groups.map((g) => [g.id, g.parentId] as const));
  const home = new Map(view.nodes.map((n) => [n.id, n.groupId] as const));
  const ends = view.edges.filter((e) => ids.edgeIds.includes(e.id)).flatMap((e) => [e.source, e.target]);
  const out = new Set<string>();
  for (const id of [...ids.nodeIds, ...ends]) {
    for (let at = home.get(id) ?? parent.get(id); at !== undefined && !out.has(at); at = parent.get(at)) out.add(at);
  }
  return [...out];
}

/**
 * The selection as the canvas draws it. Memoised because React Flow runs controlled, and a controlled
 * React Flow syncs its `nodes`/`edges` props into its own store from an effect. This object reaches
 * that effect through DiagramCanvas, which derives the node and edge arrays from it -- so rebuilding
 * it inline on every render made those arrays a new identity every render too, and the effect saw a
 * change it had caused itself: setNodes -> store update -> re-render -> fresh object -> effect again.
 * React aborts that at fifty nested updates with "Maximum update depth exceeded", from a stack inside
 * @xyflow/react that names nothing here.
 *
 * `selection` itself comes from a reducer and is already stable; only this wrapper was not. It showed
 * up as `UI gates` failing roughly one run in thirty, because the loop only outruns React's bail-out
 * on some interleavings. The nested view draws boxes and bundles for what it hides: the page's model
 * ids, translated.
 */
export function useDrawnSelection(selection: SelectionState, drawnNest: DrawnNest | null) {
  const canvasSelection = useMemo(
    () =>
      selection === null
        ? undefined
        : {
            nodeIds: selection.selectedNodeIds,
            edgeIds: selection.selectedEdgeIds,
          },
    [selection],
  );
  return useMemo(
    () =>
      drawnNest === null || canvasSelection === undefined
        ? canvasSelection
        : drawnIds(drawnNest.nested, drawnNest.full, canvasSelection),
    [drawnNest, canvasSelection],
  );
}

/**
 * Ctrl/⌘ A: everything selectable on the canvas in view -- every node and edge of a graph, every
 * participant and message of a sequence. False when there is nothing on screen to select from yet:
 * `projectedRef` is set the moment a presentation lands, while the canvas only catches up when its
 * layout resolves, and selecting from the newer model would name ids the reader is not looking at.
 */
export function selectEverything(stage: Stage): boolean {
  const projected = stage.projectedRef.current;
  if (projected === null || stage.displayedViewIdRef.current !== projected.view.viewId) return false;
  stage.dispatchSelection({ type: "select", ...selectableIds(projected) });
  return true;
}
