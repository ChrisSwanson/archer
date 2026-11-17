/**
 * The page's walkthroughs (ADR 0034 §6), for the diagram on screen: reads them (`GET
 * api/walkthroughs?viewId=`, again on the `walkthroughs` event and on reconnect, as the stream
 * replays nothing), runs the player, and hands `App` what to draw: an emphasis and a focus built from
 * the step, in model ids, which `App` passes on to the canvas as it does the agent's emphasis.
 *
 * Nothing here opens by itself: with no walkthroughs the hook holds nothing and the page is as before.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { browserFetch } from "../app/browser-resource";
import type { ReviewEvents } from "../comments/events";
import type { ProjectedView } from "../diagrams/projection";
import type { Walk, WalkthroughsRead } from "./contract";
import { parseWalkthroughs } from "./parse";
import { useOldVersion, type OldVersion } from "./use-old-version";
import { playableOld } from "./walk-stale";
import { INITIAL_WALK, walkReducer, type WalkAction, type WalkState } from "./walk-player";
import { members, stepFor, walkRender, type ModelIds, type WalkRender } from "./walk-render";

/** Play advances this often (the prototype's pace). */
export const PLAY_MS = 1500;

async function read(viewId: string): Promise<WalkthroughsRead | undefined> {
  try {
    const answer = await browserFetch(`api/walkthroughs?viewId=${encodeURIComponent(viewId)}`, { cache: "no-store" });
    return answer.ok ? parseWalkthroughs(await answer.json()) : undefined;
  } catch {
    // Walkthroughs are an addition to the diagram, not a precondition for it.
    return undefined;
  }
}

export type WalkModel = ModelIds & { readonly labels: ReadonlyMap<string, string> };

export type Walkthroughs = {
  /** What the diagram has; empty until read, and for a view that cannot host any. */
  readonly walks: readonly Walk[];
  /** The walkthroughs of the diagram on screen have been read (an empty list is an answer). */
  readonly ready: boolean;
  readonly state: WalkState;
  readonly walk: Walk | null;
  /** What to draw while the panel is open; null when nothing is chosen (the plain diagram), and while the old version is shown. */
  readonly render: WalkRender | null;
  /** The old version of the chosen archived walkthrough (slice 7b): asked for by `openOld`, and drawn by `OldVersionStage` with `oldRender`. */
  readonly old: OldVersion;
  readonly oldView: ProjectedView | null;
  readonly oldRender: WalkRender | null;
  readonly openOld: () => void;
  readonly backToCurrent: () => void;
  readonly labelOf: (id: string) => string;
  /** The ids drawn (nodes and containers, lines) and their labels, of the model on screen. */
  readonly model: WalkModel;
  readonly dispatch: (action: WalkAction) => void;
  /** Open the panel on the picker. */
  readonly show: () => void;
  /** Choose one and start at `step` (default 1). */
  readonly select: (id: string, step?: number) => void;
  readonly togglePlay: () => void;
  /** A graph element was pressed: jump to the step that names it. True when it did. */
  readonly jump: (ids: { readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] }) => boolean;
  /** A press, for the mode (D4): "jump" moved to the step naming it; "path" is the path's own (a container holding it, or nothing to step); "off" is off it. */
  readonly press: (ids: {
    readonly nodeIds: readonly string[];
    readonly edgeIds: readonly string[];
  }) => "jump" | "path" | "off";
};

export function useWalkthroughs(options: {
  readonly viewId: string | null;
  readonly enabled: boolean;
  readonly events: ReviewEvents;
  readonly view: ProjectedView | null;
}): Walkthroughs {
  const { viewId, enabled, events, view } = options;
  const [held, setHeld] = useState<WalkthroughsRead | null>(null);
  const [state, dispatch] = useReducer(walkReducer, INITIAL_WALK);
  const asked = useRef(0);
  /** The diagram last asked about, so a view that comes back after a blink is not asked about again. */
  const heldFor = useRef<string | null>(null);

  const load = useCallback(async (id: string): Promise<void> => {
    const ask = ++asked.current;
    heldFor.current = id;
    const answer = await read(id);
    // A newer ask, or another view, has overtaken this one.
    if (ask === asked.current && answer !== undefined && answer.viewId === id) setHeld(answer);
  }, []);

  // The diagram last held: another diagram closes the panel and starts afresh; the same one coming back after
  // a moment of none (a view loading) keeps what it had and reads nothing again.
  const lastView = useRef<string | null>(null);
  // Editing in place (not enabled) closes the panel but forgets nothing: the same diagram coming back reads
  // nothing again, unless the stream said it changed meanwhile.
  const dirty = useRef(false);
  useEffect(() => {
    if (!enabled) dispatch({ type: "close" });
  }, [enabled]);
  useEffect(() => {
    if (!enabled || viewId === null) return;
    const same = lastView.current === viewId;
    if (!same) {
      asked.current++;
      heldFor.current = null;
      setHeld(null);
      dispatch({ type: "close" });
    }
    lastView.current = viewId;
    if (!same || heldFor.current !== viewId || dirty.current) {
      dirty.current = false;
      void load(viewId);
    }
  }, [viewId, enabled, load]);
  // Heard for the last diagram held, through a blink with no view and through editing.
  useEffect(
    () =>
      events.subscribe((event) => {
        const id = lastView.current;
        if (id === null || !((event.type === "walkthroughs" && event.viewId === id) || event.type === "reconnect"))
          return;
        if (enabled) void load(id);
        else dirty.current = true;
      }),
    [enabled, events, load],
  );

  // While no view is on screen (a blink, the contents page) what was read stays, and the player is left alone.
  const fresh = held !== null && (viewId === null || held.viewId === viewId) ? held.walks : NONE;
  useEffect(() => {
    if (viewId === null) return;
    dispatch({ type: "revision", counts: new Map(fresh.map((w) => [w.id, w.steps.length])) });
  }, [fresh, viewId]);
  // Playing on the old version: the chosen archived walkthrough, every step matching what is drawn.
  const { old, open: openOld, back: backToCurrent } = useOldVersion(viewId, state.id);
  const oldView = old.status === "found" ? old.view : null;
  const walks = useMemo(
    () => (old.status === "found" ? fresh.map((w) => (w.id === old.id ? playableOld(w) : w)) : fresh),
    [fresh, old],
  );

  useEffect(() => {
    if (!state.playing) return;
    const timer = setInterval(() => dispatch({ type: "tick" }), PLAY_MS);
    return () => clearInterval(timer);
  }, [state.playing]);

  const walk = state.id === null ? null : (walks.find((w) => w.id === state.id) ?? null);
  const model = useMemo(() => {
    const shown = oldView ?? view;
    const labels = new Map<string, string>();
    const nodes = new Set<string>();
    for (const node of shown?.nodes ?? []) {
      nodes.add(node.id);
      labels.set(node.id, node.label);
    }
    for (const group of shown?.groups ?? []) {
      nodes.add(group.id);
      labels.set(group.id, group.label);
    }
    return { labels, nodes, edges: new Set((shown?.edges ?? []).map((edge) => edge.id)) };
  }, [view, oldView]);
  const drawn = useMemo(
    () => (state.open && walk !== null ? walkRender(walk, state.step, model) : null),
    [state.open, state.step, walk, model],
  );
  // The old model is drawn by its own stage; the diagram beneath is left plain, not told ids it may not have.
  const render = oldView === null ? drawn : null;
  const oldRender = oldView === null ? null : drawn;
  const labelOf = useCallback(
    (id: string) => model.labels.get(id) ?? walk?.steps.flatMap((s) => s.nodes).find((n) => n.id === id)?.label ?? id,
    [model, walk],
  );

  const latest = useRef({ walks: fresh, walk, state, model });
  latest.current = { walks: fresh, walk, state, model };
  const show = useCallback(() => dispatch({ type: "show" }), []);
  const select = useCallback((id: string, step?: number) => {
    const target = latest.current.walks.find((w) => w.id === id);
    if (target !== undefined)
      dispatch({ type: "open", id, count: target.steps.length, ...(step === undefined ? {} : { step }) });
  }, []);
  const togglePlay = useCallback(() => dispatch({ type: latest.current.state.playing ? "pause" : "play" }), []);
  const jump = useCallback(
    (ids: { readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] }): boolean => {
      const { walk: now, state: at } = latest.current;
      if (now === null || !at.open || now.status === "archived" || now.old === true) return false;
      for (const [channel, list] of [
        ["node", ids.nodeIds],
        ["edge", ids.edgeIds],
      ] as const) {
        for (const id of list) {
          const to = stepFor(now, channel, id, at.step);
          if (to !== null) {
            dispatch({ type: "go", to });
            return true;
          }
        }
      }
      return false;
    },
    [],
  );

  const viewRef = useRef(view);
  viewRef.current = view;
  const press = useCallback(
    (ids: { readonly nodeIds: readonly string[]; readonly edgeIds: readonly string[] }): "jump" | "path" | "off" => {
      const { walk: now, state: at } = latest.current;
      if (now === null || !at.open || now.status === "archived" || now.old === true) return "path";
      if (jump(ids)) return "jump";
      if (ids.nodeIds.length + ids.edgeIds.length === 0) return "path";
      // A container round part of the path is the path's frame: pressing it neither steps nor leaves.
      const shown = viewRef.current;
      const path = members(now.steps, latest.current.model).nodes;
      return shown !== null && ids.nodeIds.some((id) => holds(shown, id, path)) ? "path" : "off";
    },
    [jump],
  );

  const ready = viewId !== null && held !== null && held.viewId === viewId;
  return {
    walks,
    ready,
    state,
    walk,
    render,
    old,
    oldView,
    oldRender,
    openOld,
    backToCurrent,
    labelOf,
    model,
    dispatch,
    show,
    select,
    togglePlay,
    jump,
    press,
  };
}

const NONE: readonly Walk[] = [];

/** `groupId` is a container with one of `nodes` somewhere inside it. */
function holds(view: ProjectedView, groupId: string, nodes: readonly string[]): boolean {
  if (!view.groups.some((g) => g.id === groupId)) return false;
  const parent = new Map(view.groups.map((g) => [g.id, g.parentId] as const));
  const home = new Map(view.nodes.map((n) => [n.id, n.groupId] as const));
  return nodes.some((id) => {
    const seen = new Set<string>();
    for (let at = home.get(id) ?? parent.get(id); at !== undefined && !seen.has(at); at = parent.get(at)) {
      if (at === groupId) return true;
      seen.add(at);
    }
    return false;
  });
}
