/**
 * The diagram page's mode (0.6.4, D1): one at a time, Explore, Highlights, Walkthrough or Edit.
 *
 * Entering Walkthrough saves the view it is going to change (nested or whole, the open set, the camera, Follow); every way
 * out (✕, Escape, the mode switcher, a click off the path, editing, the agent presenting without one, the
 * phone sheet's ✕) puts it back, except that a click off the path leaves the camera where it is (D4b). Highlights and Edit change no part of the view the page holds, so they
 * save nothing. Which mode is up is read off the page's own flags, in one precedence (edit, walkthrough,
 * highlights, explore), so no second copy of "is a walkthrough open" can drift from the player.
 *
 * Shared by both shells: the MCP shell passes `walkthrough: null` (no walkthroughs reach a host) and gets
 * Explore and Highlights. Pure parts are exported for tests; the hook connects them.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import type { WalkContext } from "../comments/walk-anchors";
import type { NestMode } from "../nesting/nest-page";

export type DiagramMode = "explore" | "highlights" | "walkthrough" | "edit";

/** React Flow's camera: translate and zoom. */
export type CameraView = { readonly x: number; readonly y: number; readonly zoom: number };

/** The view a mode changes, as it was when the mode was entered. */
export type SavedView = {
  /** The diagram it was saved on; null when nothing was laid out yet (read again when it is). */
  readonly viewId: string | null;
  readonly nest: NestMode;
  readonly open: readonly string[];
  /** Null when there was no camera of the view from before to take (a walkthrough opened with the page): leaving fits the view instead. */
  readonly camera: CameraView | null;
  readonly follow: boolean;
  /** The framing then on screen: a newer presentation that framed itself is not undone. A live redraw (viewport kept) is not one. */
  readonly framing: number;
};

export type ExitReason = "close" | "escape" | "switch" | "off-path" | "edit" | "agent" | "gone";
export type WalkPlace = { readonly walkthrough: string; readonly step: number };
export type ElementIds = { readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] };

/** Where a press on the drawing lands for the walkthrough open: its step (jumped), its path (stays), or off it. */
export type PressPlace = "jump" | "path" | "off";

/** The walkthrough player as the mode sees it; null where there are no walkthroughs (the MCP shell). */
export type ModeWalkthrough = {
  /** The panel is up: on the list (`at` null) or on a walkthrough. */
  readonly open: boolean;
  readonly at: WalkPlace | null;
  /** `at` as a comment names it, the step by its id (it survives steps inserted or moved); null for an archived walkthrough. */
  readonly context: WalkContext | null;
  readonly show: () => void;
  readonly select: (id: string, step?: number) => void;
  readonly close: () => void;
  /** Classifies a press, and jumps to the step when it names one. */
  readonly press: (ids: ElementIds) => PressPlace;
};

/** The agent's emphasis: `activeId` is the one drawn when no walkthrough covers it. */
export type ModeHighlights = {
  readonly activeId: string | null;
  /** What the active one draws (its content, not its id): the agent replacing it under the same id is news too. */
  readonly revision: string | null;
  /** Show the newest the agent stored (nothing up yet). */
  readonly show: () => void;
  readonly hide: () => void;
};

/** The stage's view: read it, and put a saved one back. */
export type ModeView = {
  readonly read: () => SavedView | null;
  /** `alsoOpen`: what a click off the path selected stays drawn. `camera`: false after a click off the path, or when a newer presentation framed itself. */
  readonly restore: (saved: SavedView, how: { readonly alsoOpen: ElementIds | null; readonly camera: boolean }) => void;
  readonly framing: number;
};

export type DiagramModeOptions = {
  readonly walkthrough: ModeWalkthrough | null;
  readonly highlights: ModeHighlights | null;
  readonly edit: { readonly on: boolean; readonly start?: () => void };
  /** A walkthrough was entered, however (the list, the switcher, the address, the agent): the review panel gives way to it. */
  readonly onEnterWalkthrough?: () => void;
  readonly view: ModeView;
  /** What is selected, model ids: a context kept after a click off the path lasts while that click's selection does. */
  readonly selection: ElementIds | null;
};

export type DiagramModes = {
  readonly mode: DiagramMode;
  /** The view saved on entering the walkthrough (read through, so it is current inside layout effects). */
  readonly saved: () => SavedView | null;
  /** Highlights: the agent's emphasis comes back (or the newest is shown). Walkthrough: the list, or `at`. Edit: `edit.start`. */
  readonly enter: (mode: Exclude<DiagramMode, "explore">, at?: { readonly id: string; readonly step?: number }) => void;
  /** Back to Explore, the saved view restored. */
  readonly exit: (reason?: ExitReason) => void;
  /** A press on drawn elements (model ids), before it selects: on the path jumps, off it leaves (D4). `selects` is false for the hand. */
  readonly press: (ids: ElementIds, selects: boolean) => void;
  /** The agent set highlights while a walkthrough is open: offer "Show highlights" rather than switch (D1, agent rules). */
  readonly highlightsOffered: boolean;
  /** Where the walkthrough was when a click off its path left it, and what that click left selected (`idsKey`), while it stays selected (ADR 0034 §9 context). */
  readonly leftFrom: Kept | null;
};

/** The mode on screen, by precedence. */
export function modeOf(flags: {
  readonly edit: boolean;
  readonly walkthrough: boolean;
  readonly highlights: boolean;
}): DiagramMode {
  return flags.edit ? "edit" : flags.walkthrough ? "walkthrough" : flags.highlights ? "highlights" : "explore";
}

/** A context kept after a click off the path: for a comment about exactly `ids` (an `idsKey`). */
export type Kept = { readonly context: WalkContext; readonly ids: string };

export type ModeState = {
  readonly offered: boolean;
  readonly left: Kept | null;
};
export type ModeAction =
  | { readonly type: "entered" }
  | { readonly type: "exited"; readonly left?: Kept }
  | { readonly type: "offer"; readonly on: boolean }
  | { readonly type: "forget" };

export const INITIAL_MODE: ModeState = { offered: false, left: null };

export function modeReducer(state: ModeState, action: ModeAction): ModeState {
  switch (action.type) {
    case "entered":
      return state.left === null && !state.offered ? state : INITIAL_MODE;
    case "exited":
      return { offered: false, left: action.left ?? null };
    case "offer":
      return state.offered === action.on ? state : { ...state, offered: action.on };
    case "forget":
      return state.left === null ? state : { ...state, left: null };
  }
}

/** A selection's identity, order aside. */
export function idsKey(ids: ElementIds | null): string {
  return ids === null ? "" : `${[...ids.nodeIds].sort().join(",")}|${[...ids.edgeIds].sort().join(",")}`;
}

export function useDiagramModes(options: DiagramModeOptions): DiagramModes {
  const { walkthrough, highlights, edit, selection } = options;
  const [state, dispatch] = useReducer(modeReducer, INITIAL_MODE);
  const walkOpen = walkthrough?.open ?? false;
  const mode = modeOf({ edit: edit.on, walkthrough: walkOpen, highlights: (highlights?.activeId ?? null) !== null });

  const latest = useRef(options);
  latest.current = options;
  const savedRef = useRef<SavedView | null>(null);
  /** What the exit under way carries: why, and what a click off the path selected. */
  const exiting = useRef<{
    readonly reason: ExitReason;
    readonly ids?: ElementIds;
    readonly context?: WalkContext | null;
  } | null>(null);

  // Entering and leaving, whoever opened or closed the player (a button, the address, the agent, a view change).
  // A layout effect, declared before the walkthrough's own: the view is saved before a step changes it.
  useLayoutEffect(() => {
    const { view: stage } = latest.current;
    if (walkOpen && savedRef.current === null) {
      savedRef.current = stage.read() ?? {
        viewId: null,
        nest: "nested",
        open: [],
        camera: null,
        follow: true,
        framing: stage.framing,
      };
      exiting.current = null;
      dispatch({ type: "entered" });
      latest.current.onEnterWalkthrough?.();
      return;
    }
    if (!walkOpen && savedRef.current !== null) {
      const saved = savedRef.current;
      const how = exiting.current ?? { reason: "gone" as const };
      savedRef.current = null;
      exiting.current = null;
      // A click off the path keeps the camera where the person is looking (D4b); every other way out puts it back.
      const camera = how.reason !== "agent" && how.reason !== "off-path" && stage.framing === saved.framing;
      stage.restore(saved, { alsoOpen: how.ids ?? null, camera });
      // The context goes with what the click left selected, which an additive click makes more than what it pressed.
      const context = how.context ?? null;
      dispatch({
        type: "exited",
        ...(context === null ? {} : { left: { context, ids: idsKey(latest.current.selection) } }),
      });
    }
  }, [walkOpen]);

  const saved = useCallback((): SavedView | null => {
    // Saved before anything was laid out: the open set on screen now is still the one from before (a step waits for the
    // layout). Not its camera: the walkthrough may have framed itself already, so leaving fits the view instead.
    if (savedRef.current !== null && savedRef.current.viewId === null) {
      const now = latest.current.view.read();
      if (now !== null) savedRef.current = { ...now, camera: null };
    }
    return savedRef.current;
  }, []);

  // The agent's highlights arriving or changing while a walkthrough covers them: offered, not switched to. Keyed on
  // what they draw, so the same snapshot heard again (a reconnect, a reconcile) offers nothing.
  const revision = highlights === null || highlights.activeId === null ? null : highlights.revision;
  const lastRevision = useRef(revision);
  useEffect(() => {
    const was = lastRevision.current;
    lastRevision.current = revision;
    if (revision === null) dispatch({ type: "offer", on: false });
    else if (walkOpen && revision !== was) dispatch({ type: "offer", on: true });
  }, [revision, walkOpen]);

  // A context kept after a click off the path lasts while what that click selected stays selected.
  const selected = idsKey(selection);
  useEffect(() => {
    if (state.left !== null && state.left.ids !== selected) dispatch({ type: "forget" });
  }, [selected, state.left]);

  const exit = useCallback((reason: ExitReason = "close"): void => {
    const { walkthrough: walk, highlights: lit } = latest.current;
    if (walk?.open === true) {
      exiting.current ??= { reason };
      walk.close();
      return;
    }
    if (lit !== null && lit.activeId !== null && !latest.current.edit.on) lit.hide();
  }, []);

  const enter = useCallback(
    (to: Exclude<DiagramMode, "explore">, at?: { readonly id: string; readonly step?: number }): void => {
      const { walkthrough: walk, highlights: lit, edit: editing } = latest.current;
      if (to === "edit") {
        // Left first, so the view goes back; the camera comes back when the reader's drawing is mounted again.
        if (walk?.open === true) {
          exiting.current ??= { reason: "edit" };
          walk.close();
        }
        editing.start?.();
        return;
      }
      if (to === "highlights") {
        if (walk?.open === true) {
          exiting.current ??= { reason: "switch" };
          walk.close();
        }
        if (lit !== null && lit.activeId === null) lit.show();
        return;
      }
      if (walk === null) return;
      if (at === undefined) walk.show();
      else walk.select(at.id, at.step);
    },
    [],
  );

  const press = useCallback((ids: ElementIds, selects: boolean): void => {
    const walk = latest.current.walkthrough;
    if (walk === null || !walk.open || walk.at === null) return;
    const place = walk.press(ids);
    if (place !== "off" || !selects) return;
    exiting.current = { reason: "off-path", ids, context: walk.context };
    walk.close();
  }, []);

  const leftFrom = state.left;
  return useMemo(
    () => ({ mode, saved, enter, exit, press, highlightsOffered: walkOpen && state.offered, leftFrom }),
    [mode, saved, enter, exit, press, walkOpen, state.offered, leftFrom],
  );
}
