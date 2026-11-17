/**
 * Expand on the person's page (ADR 0036 §11–§13, A8–A10, A12, A13): the Comment /
 * element actions, the page's own additions, and the grown canvas. Page content (App Shell guide): it lives in
 * the diagram workspace; the shell knows nothing of it.
 *
 * - Right-click, the context-menu key, Shift+F10 and long press open Actions for the element. Comment
 *   comes first, then title rows navigate. Details and Additions uses the mode panel/phone dock, with
 *   Inside first and explicit Preview/Add/Open controls. One service read (GET api/expand-menu) carries
 *   all pieces; neither Preview nor Add costs a request.
 * - An addition brings only the piece, in a frame beside the element (A12), laid out in the layout worker.
 *   One frame per source (O7); an element is drawn once (O6); 5 sources and 60 added boxes at most (A13).
 * - The additions are this page's: nothing is written, nothing reaches other pages (O1). The page reports them to the
 *   agent (POST api/reader-exploration), like a selection. The agent's presented exploration (ADR 0036 §14, A11) and an
 *   `?expand=` link (O10) replace them, each with one read (GET api/exploration); whichever changed last is drawn.
 *
 * The menu's code is loaded on the first menu (`lazy.ts`); this hook is what the page keeps.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import type { ProjectedView } from "../diagrams/projection";
import type { LayoutResult } from "../layout/elk-layout";
import type { TypefaceId } from "../layout/text-measure";
import { browserFetch } from "../app/browser-resource";
import {
  EXPLORATION_LIMITS,
  encodeExpansions,
  expansionOf,
  shareableExpansions,
  frameIdOf,
  framePartOf,
  withExpandParam,
  type Expansion,
  type ExplorationStamp,
  type FrameSelection,
  type ReaderExplorationReport,
} from "../../../shared/explorations.mts";
import { combinedView, framesKey, type Frame, type FramePiece } from "./frame-view";
import type { FrameStep } from "./frame-engine";
import { layoutFrames } from "./frames-layout";
import {
  projectPiece,
  readExpandMenu,
  readExploration,
  type Adds,
  type DiagramEntry,
  type ExpandMenu,
  type Exploration,
  type FramePin,
  type NeighbourEntry,
} from "./pieces";
import type { SourceMetadata, TypePiece } from "./source-metadata";
import { loadExpandUi, useExpandUi } from "./lazy";

/** One addition the person made, in order (§14's (element, source) pair, with what it brought). */
export type Addition = {
  readonly element: string;
  readonly source: string;
  /** A neighbour entry's one neighbour (P41): the list then replays as the piece the person chose. */
  readonly neighbour?: string;
  readonly title: string;
  readonly proposed: boolean;
  readonly revision: string;
  readonly piece: FramePiece;
  readonly truncated: boolean;
};

/** What the menu was opened on: a part of the base view, or a part of a frame (named by its source, A10). */
export type MenuTarget = {
  /** The canvas id: a node id, `group:<id>` for a frame of the view, or a frame part's `xf~…~/…`. */
  readonly canvasId: string;
  readonly kind: "node" | "group" | "edge";
  readonly label: string;
  /** Where the menu opens, in client coordinates. */
  readonly x: number;
  readonly y: number;
};

export type MenuEntry =
  | { readonly kind: "inside"; readonly key: string; readonly count: number }
  | { readonly kind: "diagram"; readonly key: string; readonly entry: DiagramEntry; readonly reading: string | null }
  | { readonly kind: "neighbour"; readonly key: string; readonly entry: NeighbourEntry };

export type MenuState = {
  readonly target: MenuTarget;
  /** The model element the menu is about (a frame part's local id), or null for an edge. */
  readonly element: string | null;
  readonly canComment: boolean;
  /** Expand is offered here (O8 modes, a graph box). */
  readonly expand: boolean;
  readonly inside: { readonly count: number } | null;
  readonly answer:
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly menu: ExpandMenu }
    | { readonly status: "failed"; readonly message: string }
    | { readonly status: "none" };
  /** Focus goes back here when the menu closes. */
  readonly from: Element | null;
};

/** The agent's presentation as the page heard it: its stamp when it presented with `expand` (A8). */
export type PresentedExploration = {
  readonly presentationId: string;
  readonly viewId: string;
  readonly stamp: ExplorationStamp | null;
};

/** The exploration stamp in a presentation as the service sends it, or null when there is no presentation. */
export function presentedOf(presentation: unknown): PresentedExploration | null {
  const p = presentation as { presentationId?: unknown; viewId?: unknown; exploration?: unknown } | null;
  if (typeof p !== "object" || p === null || typeof p.presentationId !== "string" || typeof p.viewId !== "string")
    return null;
  const x = p.exploration as Partial<ExplorationStamp> | undefined;
  const stamp =
    typeof x === "object" &&
    x !== null &&
    Number.isSafeInteger(x.generation) &&
    Number.isSafeInteger(x.sources) &&
    Number.isSafeInteger(x.parts)
      ? { generation: x.generation!, sources: x.sources!, parts: x.parts! }
      : null;
  return { presentationId: p.presentationId, viewId: p.viewId, stamp };
}

/** Where the additions on the canvas came from: the person's own, the agent's presentation, or a link (O1, O10). */
export type ExplorationOrigin = "own" | "presented" | "link";

/** What Copy link did: the list's link, the view's own (the list is more than a link holds), or nothing. */
export type CopiedLink = "copied" | "bare" | "failed";

/** How long the page waits after a change before it tells the agent (a burst of adds is one report). */
export const REPORT_SETTLE_MS = 250;

export type ExpandInputs = {
  /** The view on the canvas; null when no graph is drawn. */
  readonly viewId: string | null;
  /** What the canvas draws (the nested view when it is on) and its layout. */
  readonly base: ProjectedView | null;
  readonly baseLayout: LayoutResult | null;
  readonly typeface: TypefaceId;
  /** O8: Expand in Explore and Highlights; Walkthrough and Edit show Comment only and draw the base view. */
  readonly mode: "explore" | "highlights" | "walkthrough" | "edit";
  /** Leaves Highlights for Explore: choosing an addition moves there (O8). */
  readonly toExplore: () => void;
  /** Whether the reader may comment at all. */
  readonly comments: boolean;
  /** Comment on a part of the base view, as right-click did before (the page's composer). */
  readonly commentOnBase: (target: MenuTarget) => void;
  /** Comment on a frame's part: anchored to its source view (§14, A10). */
  readonly commentOnSource: (
    source: string,
    part: { readonly kind: "node" | "edge"; readonly id: string; readonly label: string; readonly canvasId: string },
  ) => void;
  /** The nested view's Inside for a closed box, else null. */
  readonly insideOf: (canvasId: string) => { readonly count: number; readonly open: () => void } | null;
  readonly openView: (viewId: string) => void;
  /** Give the mode panel to element details (the page closes Project Review). */
  readonly onDetails?: () => void;
  /** Inventory titles, for frames' captions. */
  readonly titleOf: (viewId: string) => string;
  /** Existing inventory metadata; never a per-row read. */
  readonly metadataOf?: (viewId: string, piece?: TypePiece) => SourceMetadata;
  /** Brings a frame just added into view, once its layout is drawn. */
  readonly follow?: (layout: LayoutResult, frameGroupIds: string | readonly string[]) => void;
  /** Moves when the inventory's revisions move: a held menu answer is then revalidated. */
  readonly inventoryKey: string;
  /** Each view's current model revision: an exploration is read again when one of its sources moves. */
  readonly revisionOf?: (viewId: string) => string | undefined;
  /** The base view's revision, which a report names. */
  readonly revision?: string | null;
  /** The agent's presentation (null when nothing is presented). */
  readonly presented?: PresentedExploration | null;
  /** The `?expand=` the address named when this view was opened, read once (O10); null for none. */
  readonly link?: { readonly viewId: string; readonly expand: string } | null;
  /** Comment events, by target: a frame's pins are read again when its source's comments change. */
  readonly onComments?: (listener: (target: string) => void) => () => void;
  /** The frame parts the reader has selected (A10): reported to the agent with the exploration. */
  readonly frameSelection?: readonly FrameSelection[];
};

export type ExpandHost = {
  /** The layout to draw: the grown canvas, a preview over it, or null for the base. */
  readonly layout: LayoutResult | null;
  /** Opens the menu on `target`; false when there is nothing to offer (the page then does as before). */
  readonly open: (target: MenuTarget, from: Element | null) => boolean;
  /** Whether the menu would offer more than Comment on a target of this kind. */
  readonly offers: (kind: MenuTarget["kind"]) => boolean;
  /** A canvas id of a frame's part → its source and local id. */
  readonly partOf: (
    canvasId: string,
  ) => { readonly source: string; readonly id: string; readonly kind: "node" | "edge"; readonly label: string } | null;
  readonly remove: (source: string) => void;
  /** A different panel takes this content slot; drop its menu/details and preview without refocusing. */
  readonly dismiss: () => void;
  readonly frames: readonly Frame[];
  /** The (element, source) pairs on the canvas, in order. */
  readonly expansions: readonly Expansion[];
  readonly origin: ExplorationOrigin;
  /** Open threads on frames' parts, by the part's canvas id (counts from the exploration read). */
  readonly pins: ReadonlyMap<string, FramePin>;
  /** Lines the page should say about the exploration: what a link or the agent's refresh dropped. */
  readonly notices: readonly string[];
  /** The menu, when open. */
  readonly menu: JSX.Element | null;
  /** "Added to This View", for the side panel, when anything is added. */
  readonly panel: JSX.Element | null;
  readonly details: {
    readonly content: JSX.Element;
    readonly onClose: () => void;
    readonly onDismiss: () => void;
  } | null;
};

/** Each base layout object gets a key of its own: the worker reuses canvases grown from that exact picture. */
const baseKeys = new WeakMap<LayoutResult, string>();
let nextBase = 1;
const baseKeyOf = (viewId: string, layout: LayoutResult): string => {
  let key = baseKeys.get(layout);
  if (key === undefined) baseKeys.set(layout, (key = `${viewId}#${nextBase++}`));
  return key;
};

/** Frames from additions: one per source, in order of each source's first addition (O7). */
export function framesOf(additions: readonly Addition[]): Frame[] {
  const by = new Map<string, { title: string; proposed: boolean; revision: string; pieces: FramePiece[] }>();
  for (const a of additions) {
    const at = by.get(a.source);
    if (at === undefined)
      by.set(a.source, { title: a.title, proposed: a.proposed, revision: a.revision, pieces: [a.piece] });
    else at.pieces.push(a.piece);
  }
  return [...by].map(([source, f]) => ({ source, ...f }));
}

/**
 * The additions that still hold on `base` once `source` is gone: each in order, kept only while its
 * element is still drawn. An addition made from inside a removed frame goes with it.
 */
export function withoutSource(base: ProjectedView, additions: readonly Addition[], source: string): Addition[] {
  const kept: Addition[] = [];
  for (const a of additions) {
    if (a.source === source) continue;
    const drawn = combinedView(base, framesOf(kept)).drawn;
    if (drawn.has(a.element)) kept.push(a);
  }
  return kept;
}

/** The additions as the wire names them: what the agent is told, the link carries and a menu read replays. */
export const expansionsOf = (additions: readonly Addition[]): Expansion[] =>
  additions.map((a) => expansionOf(a.element, a.source, a.neighbour));

/**
 * Why adding `adds` from `source` (as `next`) would pass a limit on this page, or null: the service's canvas limits
 * (A13), then whether the list could still be reported and linked (P42, the decoder's own limits).
 */
export function additionLimit(
  additions: readonly Addition[],
  added: Adds,
  source: string,
  adds: Adds,
  next: Expansion | null,
  limits = EXPLORATION_LIMITS,
): string | null {
  const sources = new Set(additions.map((a) => a.source));
  if (!sources.has(source) && sources.size >= limits.maxAddedSources)
    return `${limits.maxAddedSources} diagrams added already`;
  if (added.boxes + adds.boxes > limits.maxAddedBoxes) return `over ${limits.maxAddedBoxes} added boxes`;
  if (added.wires + adds.wires > limits.maxAddedWires) return `over ${limits.maxAddedWires} added wires`;
  if (next === null) return null;
  const fit = shareableExpansions([...expansionsOf(additions), next], limits);
  return fit.ok
    ? null
    : fit.reason === "too_many"
      ? `${limits.maxExpansions} additions already`
      : "too long to share as a link";
}

/** What a menu entry adds on `element`: its piece projected; a neighbour entry names its neighbour (P41). */
export function additionOf(
  element: string,
  entry: DiagramEntry | NeighbourEntry,
  titleOf: (viewId: string) => string,
): Addition | null {
  if (entry.piece === null) return null;
  const source = "via" in entry ? entry.via : entry.source;
  const title = "via" in entry ? entry.viaTitle : entry.title;
  const piece = projectPiece(entry.piece, title);
  if (piece === null) return null;
  return {
    element,
    source,
    ...("via" in entry ? { neighbour: entry.element } : {}),
    title: titleOf(source) || title,
    proposed: entry.proposed === true,
    revision: entry.piece.revision,
    piece,
    truncated: entry.piece.truncated,
  };
}
const NO_SELECTION: readonly FrameSelection[] = [];

/** Menu answers held by URL: a repeat right-click on the same canvas costs nothing until the inventory moves. */
type Held = { readonly etag: string | null; readonly menu: ExpandMenu; readonly inventory: string };
const MENU_ANSWERS_KEPT = 32;

export function useExpand(inputs: ExpandInputs): ExpandHost {
  const { viewId, base, baseLayout, typeface, mode } = inputs;
  const latest = useRef(inputs);
  latest.current = inputs;
  const [additions, setAdditionsState] = useState<readonly Addition[]>([]);
  const [origin, setOrigin] = useState<ExplorationOrigin>("own");
  const [notices, setNotices] = useState<readonly string[]>([]);
  const [framePins, setFramePins] = useState<ReadonlyMap<string, readonly FramePin[]>>(new Map());
  /** The person's own change: what the agent is told of (O1). */
  const setAdditions = useCallback(
    (next: readonly Addition[] | ((now: readonly Addition[]) => readonly Addition[])) => {
      setAdditionsState(next);
      setOrigin("own");
    },
    [],
  );
  const [grown, setGrown] = useState<{ readonly key: string; readonly layout: LayoutResult } | null>(null);
  const [preview, setPreview] = useState<{
    readonly entry: string;
    readonly key: string;
    readonly layout: LayoutResult | null;
    readonly fresh: readonly string[];
  } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [details, setDetails] = useState(false);
  const [steps, setSteps] = useState<readonly FrameStep[]>([]);
  const [busy, setBusy] = useState(false);
  const held = useRef(new Map<string, Held>());
  /** The presentation (id and generation) whose exploration is on this canvas, or was cleared for. */
  const applied = useRef<string | null>(null);
  const linkUsed = useRef<string | null>(null);
  /** The first frame of an exploration just adopted: brought into view once its layout is drawn. */
  const pendingFollow = useRef<readonly string[] | null>(null);
  /** The list last adopted from a read, so a refetch of the same list does not move the camera. */
  const adoptedList = useRef("");
  const explorationTags = useRef(new Map<string, { readonly etag: string | null; readonly answer: Exploration }>());
  // What a preview's placement took: an add of the same frames is then a cached answer with no steps of its own,
  // and its steps (a fallback above all) must still be counted (A12).
  const previewSteps = useRef(new Map<string, readonly FrameStep[]>());
  const ui = useExpandUi();

  // Another view starts with nothing added; a new revision of this one keeps its additions (they replay).
  useEffect(() => {
    setAdditionsState([]);
    setOrigin("own");
    setNotices([]);
    setFramePins(new Map());
    setGrown(null);
    setPreview(null);
    setMenu(null);
    setDetails(false);
    setSteps([]);
    applied.current = null;
    adoptedList.current = "";
    pendingFollow.current = null;
  }, [viewId]);

  const frames = useMemo(() => framesOf(additions), [additions]);
  const shownFrames = mode === "walkthrough" || mode === "edit" ? [] : frames;
  const key = framesKey(shownFrames);
  const baseRef = useMemo(
    () =>
      viewId === null || base === null || baseLayout === null
        ? null
        : { key: baseKeyOf(viewId, baseLayout), view: base, layout: baseLayout, typeface },
    [viewId, base, baseLayout, typeface],
  );
  const growKey = baseRef === null ? null : `${baseRef.key}\u0002${key}`;

  // The grown canvas follows the additions and the base: a new base (a recompile, a nested-view press) replays them.
  useEffect(() => {
    if (baseRef === null || shownFrames.length === 0 || growKey === null) return;
    let live = true;
    layoutFrames(baseRef, shownFrames).then(
      (answer) => {
        if (!live) return;
        setGrown({ key: growKey, layout: answer.layout });
        // Frames the agent or a link put here come into view once drawn, as a frame the person adds does (A12):
        // the grown canvas moves the base, so the camera the base view opened with may show none of it.
        const pending = pendingFollow.current;
        const follow = latest.current.follow;
        if (
          pending !== null &&
          follow !== undefined &&
          pending.every((id) => answer.layout.groups.some((g) => g.id === id))
        ) {
          pendingFollow.current = null;
          requestAnimationFrame(() => requestAnimationFrame(() => follow(answer.layout, pending)));
        }
        if (answer.steps.length > 0) setSteps((old) => [...old, ...answer.steps].slice(-200));
      },
      (error: unknown) => {
        if (live) console.warn("[archer] placing the added frames failed", error);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` names `shownFrames`
  }, [baseRef, growKey]);

  const current = shownFrames.length === 0 ? null : grown?.key === growKey ? grown.layout : null;

  const combined = useMemo(() => (base === null ? null : combinedView(base, frames)), [base, frames]);
  const partOf = useCallback(
    (canvasId: string) => {
      if (framePartOf(canvasId) === null || combined === null) return null;
      const part = combined.parts.get(canvasId);
      if (part === undefined) return null;
      const drawnAs =
        part.kind === "node"
          ? combined.view.nodes.find((n) => n.id === canvasId)?.label
          : combined.view.edges.find((e) => e.id === canvasId)?.label;
      return { ...part, label: drawnAs ?? part.id };
    },
    [combined],
  );

  const readMenu = useCallback(async (element: string, additionsNow: readonly Addition[]): Promise<ExpandMenu> => {
    const { viewId: shown, inventoryKey } = latest.current;
    if (shown === null) throw new Error("no view is shown");
    const expand = additionsNow.length === 0 ? "" : `&expand=${encodeExpansions(expansionsOf(additionsNow))}`;
    const url = `api/expand-menu?viewId=${encodeURIComponent(shown)}&element=${encodeURIComponent(element)}${expand}`;
    const kept = held.current.get(url);
    if (kept !== undefined && kept.inventory === inventoryKey) return kept.menu;
    const response = await browserFetch(url, {
      cache: "no-store",
      ...(kept?.etag == null ? {} : { headers: { "if-none-match": kept.etag } }),
    });
    if (response.status === 304 && kept !== undefined) {
      held.current.set(url, { ...kept, inventory: inventoryKey });
      return kept.menu;
    }
    if (!response.ok)
      throw new Error(
        response.status === 404 ? "This diagram is no longer in the project." : `Archer answered ${response.status}.`,
      );
    const answer = readExpandMenu(await response.json());
    if (answer === null) throw new Error("This Archer answered in a form this page cannot read. Reload the page.");
    held.current.delete(url);
    held.current.set(url, { etag: response.headers.get("etag"), menu: answer, inventory: inventoryKey });
    while (held.current.size > MENU_ANSWERS_KEPT) held.current.delete(held.current.keys().next().value!);
    return answer;
  }, []);

  const expandHere = mode === "explore" || mode === "highlights";
  const offers = useCallback(
    (kind: MenuTarget["kind"]) => kind !== "edge" && expandHere && base !== null,
    [expandHere, base],
  );

  const open = useCallback(
    (target: MenuTarget, from: Element | null): boolean => {
      const { comments, insideOf } = latest.current;
      const part = framePartOf(target.canvasId);
      const element =
        target.kind === "edge"
          ? null
          : (part?.id ?? (target.kind === "group" ? target.canvasId.replace(/^group:/, "") : target.canvasId));
      const expand = target.kind !== "edge" && expandHere && base !== null;
      const inside = expand && part === null ? insideOf(target.canvasId) : null;
      // Only Comment to offer (an edge; Walkthrough or Edit; an Archer without Expand's reads and no Inside here,
      // A8): the page comments as it always has, with no menu in between.
      if (!expand) return false;
      void loadExpandUi();
      // A list no request can name (an agent's, past what one link holds: P42) has no room for more; asking would be refused.
      const full = element !== null && !shareableExpansions(expansionsOf(additions)).ok;
      const asks = element !== null && !full;
      setPreview(null);
      setDetails(false);
      setMenu({
        target,
        element,
        canComment: comments,
        expand,
        inside: inside === null ? null : { count: inside.count },
        answer: full
          ? {
              status: "failed",
              message: "Nothing more can be added here: this view holds as many additions as one link can carry.",
            }
          : asks
            ? { status: "loading" }
            : { status: "none" },
        from,
      });
      if (asks) {
        readMenu(element, additions).then(
          (answer) => setMenu((m) => (m?.target === target ? { ...m, answer: { status: "ready", menu: answer } } : m)),
          (error: unknown) =>
            setMenu((m) =>
              m?.target === target
                ? {
                    ...m,
                    answer: {
                      status: "failed",
                      message: error instanceof Error ? error.message : "The menu could not be read.",
                    },
                  }
                : m,
            ),
        );
      }
      return true;
    },
    [expandHere, base, readMenu, additions],
  );

  const close = useCallback((restore: boolean) => {
    setDetails(false);
    setMenu((m) => {
      if (restore && m?.from instanceof HTMLElement && m.from.isConnected) m.from.focus({ preventScroll: true });
      return null;
    });
    setPreview(null);
  }, []);

  const priorMode = useRef(mode);
  useEffect(() => {
    if (priorMode.current === mode) return;
    priorMode.current = mode;
    close(false);
  }, [mode, close]);

  /** The additions an entry would make: its piece projected, appended (a second piece from a source grows its frame). */
  const additionFor = useCallback(
    (menuNow: MenuState, entry: DiagramEntry | NeighbourEntry): Addition | null =>
      menuNow.element === null ? null : additionOf(menuNow.element, entry, latest.current.titleOf),
    [],
  );

  /** Why adding `entry` would pass a limit on this page, or null (A13, P42: the same rules as the service's). */
  const overLimit = useCallback(
    (entry: DiagramEntry | NeighbourEntry): string | null => {
      const added = base === null ? { boxes: 0, wires: 0 } : combinedView(base, frames).added;
      const source = "via" in entry ? entry.via : entry.source;
      const next =
        menu?.element == null ? null : expansionOf(menu.element, source, "via" in entry ? entry.element : undefined);
      return additionLimit(additions, added, source, entry.adds, next);
    },
    [additions, base, frames, menu],
  );

  const previewEntry = useCallback(
    (entryKey: string, entry: DiagramEntry | NeighbourEntry) => {
      if (menu === null || baseRef === null) return;
      const addition = additionFor(menu, entry);
      if (addition === null) return;
      const next = framesOf([...additions, addition]);
      const nextKey = `${baseRef.key}\u0002${framesKey(next)}`;
      const before = new Set(combinedView(baseRef.view, frames).view.nodes.map((n) => n.id));
      const after = combinedView(baseRef.view, next);
      const fresh = [
        ...after.view.nodes.map((n) => n.id).filter((id) => !before.has(id)),
        ...after.view.edges.map((e) => e.id).filter((id) => framePartOf(id) !== null),
      ];
      setPreview({
        entry: entryKey,
        key: nextKey,
        layout: null,
        fresh: [...fresh, `group:${frameIdOf(addition.source)}`],
      });
      layoutFrames(baseRef, next).then(
        (answer) => {
          if (answer.steps.length > 0) {
            previewSteps.current.set(nextKey, answer.steps);
            while (previewSteps.current.size > 16)
              previewSteps.current.delete(previewSteps.current.keys().next().value!);
          }
          setPreview((p) => (p?.entry === entryKey && p.key === nextKey ? { ...p, layout: answer.layout } : p));
        },
        () => setPreview((p) => (p?.entry === entryKey ? null : p)),
      );
    },
    [menu, baseRef, additionFor, additions, frames],
  );

  const add = useCallback(
    async (entry: DiagramEntry | NeighbourEntry) => {
      if (menu === null || baseRef === null) return;
      const addition = additionFor(menu, entry);
      if (addition === null) return;
      const next = [...additions, addition];
      setPreview(null);
      setBusy(true);
      try {
        const answer = await layoutFrames(baseRef, framesOf(next));
        const nextKey = `${baseRef.key}\u0002${framesKey(framesOf(next))}`;
        setGrown({ key: nextKey, layout: answer.layout });
        const taken = answer.steps.length > 0 ? answer.steps : (previewSteps.current.get(nextKey) ?? []);
        previewSteps.current.delete(nextKey);
        if (taken.length > 0) setSteps((old) => [...old, ...taken].slice(-200));
        setAdditions(next);
        if (latest.current.mode === "highlights") latest.current.toExplore();
        close(true);
        const follow = latest.current.follow;
        if (follow !== undefined)
          requestAnimationFrame(() => requestAnimationFrame(() => follow(answer.layout, frameIdOf(addition.source))));
      } catch (error) {
        setMenu((m) =>
          m === null
            ? m
            : {
                ...m,
                answer: {
                  status: "failed",
                  message: error instanceof Error ? error.message : "It could not be placed.",
                },
              },
        );
      } finally {
        setBusy(false);
      }
    },
    [menu, baseRef, additionFor, additions, close],
  );

  const remove = useCallback(
    (source: string) => {
      if (base === null) return;
      setPreview(null);
      setAdditions((now) => withoutSource(base, now, source));
    },
    [base],
  );

  /** One exploration read (routes 2 and 3), revalidated by its ETag; null when there is nothing to draw from it. */
  const readExplorationAt = useCallback(async (shown: string, query: string): Promise<Exploration | null> => {
    const url = `api/exploration?viewId=${encodeURIComponent(shown)}&${query}`;
    const kept = explorationTags.current.get(url);
    const response = await browserFetch(url, {
      cache: "no-store",
      ...(kept?.etag == null ? {} : { headers: { "if-none-match": kept.etag } }),
    });
    if (response.status === 304 && kept !== undefined) return kept.answer;
    if (!response.ok) return null;
    const answer = readExploration(await response.json());
    if (answer === null) return null;
    explorationTags.current.delete(url);
    explorationTags.current.set(url, { etag: response.headers.get("etag"), answer });
    while (explorationTags.current.size > 8)
      explorationTags.current.delete(explorationTags.current.keys().next().value!);
    return answer;
  }, []);

  /** An exploration's added entries as this page's additions (the same pieces a menu add would take), and its pins. */
  const adopt = useCallback((answer: Exploration, from: ExplorationOrigin, lines: readonly string[] = []) => {
    const next: Addition[] = [];
    for (const item of answer.expansions.items) {
      if (item.status !== "added") continue;
      const frame = answer.frames[item.frame];
      const title = latest.current.titleOf(item.source) || frame?.title || item.source;
      const piece = projectPiece(item.piece, title);
      if (piece === null) continue;
      next.push({
        element: item.element,
        source: item.source,
        ...(item.neighbour === undefined ? {} : { neighbour: item.neighbour }),
        title,
        proposed: frame?.proposed === true,
        revision: item.piece.revision,
        piece,
        truncated: item.piece.truncated,
      });
    }
    const dropped =
      answer.expansions.items.filter((i) => i.status === "dropped").length +
      Math.max(0, answer.expansions.total - answer.expansions.items.length);
    // A refetch of the same frames (a recompile, a comment) leaves the camera where the person put it.
    const listed = JSON.stringify(expansionsOf(next));
    if (next.length > 0 && listed !== adoptedList.current)
      pendingFollow.current = [...new Set(next.map((a) => frameIdOf(a.source)))];
    adoptedList.current = listed;
    setAdditionsState(next);
    setOrigin(from);
    setFramePins(new Map(answer.frames.map((f) => [f.source, f.pins])));
    setNotices(
      [
        ...lines,
        ...(answer.notices ?? []),
        ...(dropped === 0
          ? []
          : [
              `${dropped} ${dropped === 1 ? "addition" : "additions"} could not be made: ${dropped === 1 ? "its diagram has" : "their diagrams have"} changed or ${dropped === 1 ? "is" : "are"} gone.`,
            ]),
      ].slice(0, 8),
    );
    if (next.length > 0) void loadExpandUi();
  }, []);

  // The agent's exploration reaches every page (O1): a new presentation or a new generation of it is read once
  // and replaces what the page added. A presentation without one presents the bare view (A11).
  const presented = inputs.presented ?? null;
  const presentedKey =
    presented === null || viewId === null || presented.viewId !== viewId
      ? null
      : `${presented.presentationId}\u0001${presented.stamp?.generation ?? "-"}`;
  const linkHere =
    inputs.link !== undefined && inputs.link !== null && inputs.link.viewId === viewId && inputs.link.expand !== ""
      ? inputs.link.expand
      : null;
  useEffect(() => {
    if (presentedKey === null || presented === null || viewId === null || applied.current === presentedKey) return;
    const first = applied.current === null;
    // A link the address names wins over the presentation standing when the page opened.
    if (first && linkHere !== null && linkUsed.current !== `${viewId}\u0001${linkHere}`) return;
    applied.current = presentedKey;
    if (presented.stamp === null) {
      if (!first) {
        setAdditionsState([]);
        setOrigin("presented");
        setNotices([]);
        setFramePins(new Map());
      }
      return;
    }
    let live = true;
    readExplorationAt(viewId, `presentationId=${encodeURIComponent(presented.presentationId)}`).then(
      (answer) => {
        if (live && answer !== null && answer.viewId === viewId) adopt(answer, "presented");
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key names the presentation
  }, [presentedKey, viewId, readExplorationAt, adopt]);

  // An `?expand=` link (O10): read when the view it names opens, once; the graph never writes the address.
  useEffect(() => {
    if (linkHere === null || viewId === null || base === null) return;
    const key = `${viewId}\u0001${linkHere}`;
    if (linkUsed.current === key) return;
    linkUsed.current = key;
    let live = true;
    readExplorationAt(viewId, `expand=${linkHere}`).then(
      (answer) => {
        if (!live) return;
        if (answer === null) {
          setNotices(["This link's additions could not be read; the diagram is shown on its own."]);
          return;
        }
        adopt(answer, "link");
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [linkHere, viewId, base === null, readExplorationAt, adopt]);

  // A source that recompiles, or whose comments change, is read again: one read for the whole exploration (route 2,
  // or route 3 for the agent's, whose generation already moves on a recompile), never one per source.
  const [commentsTick, setCommentsTick] = useState(0);
  const usedSources = useMemo(() => [...new Set(additions.map((a) => a.source))], [additions]);
  const usedRef = useRef(usedSources);
  usedRef.current = usedSources;
  const onComments = inputs.onComments;
  useEffect(
    () =>
      onComments?.((target) => {
        if (usedRef.current.some((s) => `view:${s}` === target)) setCommentsTick((n) => n + 1);
      }),
    [onComments],
  );
  const revisionOf = inputs.revisionOf;
  // Stale: a source's model has moved past the revision its piece was cut from.
  const staleKey = additions
    .filter((a) => {
      const now = revisionOf?.(a.source);
      return now !== undefined && now !== "" && now !== a.revision;
    })
    .map((a) => `${a.source}@${revisionOf?.(a.source)}`)
    .join("\n");
  const readTick = useRef(0);
  useEffect(() => {
    if (viewId === null || additions.length === 0) return;
    const commented = commentsTick !== readTick.current;
    readTick.current = commentsTick;
    // The agent's exploration is refreshed by its generation when a source recompiles (A11); comments are the page's to follow.
    if (!commented && (staleKey === "" || origin === "presented")) return;
    let live = true;
    const query =
      origin === "presented" && presented !== null && presented.stamp !== null
        ? `presentationId=${encodeURIComponent(presented.presentationId)}`
        : `expand=${encodeExpansions(expansionsOf(additions))}`;
    const was = origin;
    readExplorationAt(viewId, query).then(
      (answer) => {
        if (live && answer !== null && answer.viewId === viewId) adopt(answer, was);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read when what it reads moves
  }, [viewId, staleKey, commentsTick]);

  // The page's own exploration, and its frame selection, reach the agent like a selection (O1, A10): one settled
  // report per change. An exploration the agent presented is not reported back to it unless the reader selects in it.
  const frameSelection = inputs.frameSelection ?? NO_SELECTION;
  const selectionKey = frameSelection.map((p) => `${p.source}\u0000${p.kind}\u0000${p.id}`).join("\n");
  const reported = useRef<{ readonly viewId: string; readonly key: string } | null>(null);
  const reportRevision = inputs.revision ?? null;
  useEffect(() => {
    if (viewId === null || reportRevision === null) return;
    const expand = expansionsOf(additions);
    const key = `${JSON.stringify(expand)}\n${selectionKey}`;
    const last = reported.current;
    if (last !== null && last.viewId === viewId && last.key === key) return;
    // Adopting the agent's exploration tells the agent nothing it does not know.
    if (origin === "presented" && selectionKey === "") return;
    if (last === null && expand.length === 0 && selectionKey === "") return;
    const timer = setTimeout(() => {
      reported.current = { viewId, key };
      const body: ReaderExplorationReport = {
        viewId,
        revision: reportRevision,
        expand,
        ...(frameSelection.length === 0 ? {} : { selection: frameSelection }),
      };
      void browserFetch("api/reader-exploration", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => undefined);
    }, REPORT_SETTLE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key names what is reported
  }, [viewId, reportRevision, additions, origin, selectionKey]);

  // A list no link can carry (an agent's long one) copies the view's own link and says so: never a link the reader refuses (P42).
  const copyLink = useCallback(async (): Promise<CopiedLink> => {
    const link = withExpandParam(window.location.href, expansionsOf(additions));
    try {
      await navigator.clipboard.writeText(link.href);
    } catch {
      return "failed";
    }
    return link.shared ? "copied" : "bare";
  }, [additions]);

  const pins = useMemo(() => {
    const out = new Map<string, FramePin>();
    if (combined === null) return out;
    for (const [canvasId, part] of combined.parts) {
      const pin = framePins
        .get(part.source)
        ?.find(
          (p) =>
            p.id === part.id && (p.kind === part.kind || (p.kind === "group" && part.kind === "node")) && p.open > 0,
        );
      if (pin !== undefined) out.set(canvasId, pin);
    }
    return out;
  }, [combined, framePins]);

  const fallbacks = steps.filter((s) => s.how === "fallback").length;
  const limitOf = (entry: DiagramEntry | NeighbourEntry): string | null => {
    // The service's word (it counts the same canvas), said in this page's terms; the one limit only it counts is
    // the size of what one answer can carry (P43).
    if (entry.omitted === "limit") return overLimit(entry) ?? "too much to draw in one view";
    return entry.piece === null ? null : overLimit(entry);
  };

  const metadataOf = (source: string, piece?: TypePiece): SourceMetadata =>
    inputs.metadataOf?.(source, piece) ?? { type: "Diagram" };
  const openSource = (source: string): void => {
    close(false);
    latest.current.openView(source);
  };
  const openInside = (): void => {
    if (menu === null) return;
    const target = menu.target;
    close(true);
    latest.current.insideOf(target.canvasId)?.open();
  };
  const detailsPanel =
    menu === null || ui === null || !details
      ? null
      : {
          onClose: () => close(true),
          onDismiss: () => close(false),
          content: (
            <ui.DetailsAndAdditions
              menu={menu}
              busy={busy}
              previewing={preview?.entry ?? null}
              metadataOf={metadataOf}
              limitOf={limitOf}
              onInside={openInside}
              onPreview={previewEntry}
              onAdd={(entry) => void add(entry)}
              onOpen={openSource}
              onClose={close}
            />
          ),
        };
  const menuElement =
    menu === null || ui === null || details ? null : (
      <ui.ExpandMenu
        menu={menu}
        busy={busy}
        metadataOf={metadataOf}
        onDetails={() => {
          latest.current.onDetails?.();
          setDetails(true);
        }}
        onComment={() => {
          const target = menu.target;
          close(false);
          const part = framePartOf(target.canvasId);
          const known = part === null ? null : partOf(target.canvasId);
          if (known !== null)
            latest.current.commentOnSource(known.source, {
              kind: known.kind,
              id: known.id,
              label: known.label,
              canvasId: target.canvasId,
            });
          else latest.current.commentOnBase(target);
        }}
        onOpen={openSource}
        onClose={close}
      />
    );

  const panel =
    (frames.length === 0 && notices.length === 0) || ui === null || base === null ? null : (
      <ui.AddedToView
        frames={frames}
        additions={additions}
        added={combinedView(base, frames).added}
        limits={EXPLORATION_LIMITS}
        fallbacks={fallbacks}
        steps={steps.length}
        stepMs={steps
          .slice(-12)
          .map((st) => `${st.how}:${Math.round(st.ms)}`)
          .join(" ")}
        hidden={mode === "walkthrough" || mode === "edit"}
        origin={origin}
        notices={notices}
        onOpen={(source) => latest.current.openView(source)}
        onRemove={remove}
        onCopyLink={copyLink}
      />
    );
  // Frames on the canvas without the panel's code yet (a reload never keeps them, but a fast first add might).
  useEffect(() => {
    if (frames.length > 0 || notices.length > 0) void loadExpandUi();
  }, [frames.length, notices.length]);

  const expansions = useMemo(() => expansionsOf(additions), [additions]);
  const layout = preview?.layout ?? current;
  const style = preview === null || ui === null ? null : <ui.PreviewStyle ids={preview.fresh} />;
  return {
    layout,
    open,
    offers,
    partOf,
    remove,
    dismiss: () => close(false),
    frames,
    expansions,
    origin,
    pins,
    notices,
    menu:
      menuElement === null && style === null ? null : (
        <>
          {style}
          {menuElement}
        </>
      ),
    panel,
    details: detailsPanel,
  };
}
