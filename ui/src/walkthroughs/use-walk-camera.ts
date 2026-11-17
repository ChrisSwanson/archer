/**
 * Following a walkthrough (ADR 0034 §6): the "Follow steps" switch, the camera's request for each
 * step, and the nested view's part in it (`walk-nest.ts`). Pure rules live in `walk-camera.ts` and
 * `walk-nest.ts`; this connects them to the player and to the page's nest state.
 *
 * Following is on when a walkthrough is chosen and goes off when the person pans, zooms or scrolls the
 * canvas. With it on, a step first moves to its own open set, then the camera glides to its parts once
 * the layout for that open set has arrived (`press`), never sooner. The open set is a pure function of
 * the step (D2, `stepOpen`): the start set plus what steps 1…N need, so Previous, a jump, a replay and a
 * reopen give the same picture. The person's own +/− during a step holds until the step changes.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ProjectedView } from "../diagrams/projection";
import { drawnIds } from "../nesting/nest-page";
import { canonicalOpen, type Nested } from "../nesting/nest-view";
import type { Walkthroughs } from "./use-walkthroughs";
import type { WalkCamera } from "./walk-camera";
import { closedNote, neededOpen, startOpen, stepOpen } from "./walk-nest";
import { members } from "./walk-render";

/** The nested view as the page holds it. `set` returns the press it asked for (null: nothing changed). */
export type WalkNest = {
  readonly drawn: { readonly full: ProjectedView; readonly nested: Nested; readonly press: number } | null;
  readonly current: () => readonly string[];
  readonly set: (open: readonly string[], toggled?: string) => number | null;
  /** The open set saved on entering the walkthrough (D1), the start when it records none; null: what is open now. */
  readonly saved: () => readonly string[] | null;
};

export type WalkFollow = {
  readonly follow: boolean;
  readonly setFollow: (on: boolean) => void;
  /** For the canvas; absent while no walkthrough is on screen. */
  readonly camera: WalkCamera | undefined;
  /** The current step's detail is inside a container that is closed. */
  readonly note: { readonly id: string; readonly label: string; readonly open: () => void } | null;
};

export function useWalkFollow(options: {
  readonly walkthroughs: Walkthroughs;
  readonly full: ProjectedView | null;
  readonly nest: WalkNest;
}): WalkFollow {
  const { walkthroughs, full, nest } = options;
  const { state, walk, model } = walkthroughs;
  // Not while the old version covers the live canvas: it keeps its pan, zoom and open set, and Back returns to exactly it.
  const active = state.open && walk !== null && walk.status !== "archived" && walk.old !== true && full !== null;
  const [follow, setFollowState] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const [waitPress, setWaitPress] = useState<number | null>(null);
  /** The request key the layout effect has handled (its open asked for): the camera never sees a key sooner. */
  const [asked, setAsked] = useState<string | null>(null);

  const step = walk?.steps[state.step - 1];
  const needed = useMemo(
    () => (active && step !== undefined && full !== null ? neededOpen(full, members([step], model)) : []),
    [active, step, full, model],
  );

  // What each step needs, in order: step N's open set is the start set plus the first N of these.
  const through = useMemo(
    () =>
      active && walk !== null && full !== null ? walk.steps.map((s) => neededOpen(full, members([s], model))) : [],
    [active, walk, full, model],
  );

  const latest = useRef({ active, nest, needed, through, full, walkId: walk?.id ?? null, start: walk?.open ?? [] });
  latest.current = { active, nest, needed, through, full, walkId: walk?.id ?? null, start: walk?.open ?? [] };

  const setFollow = useCallback((on: boolean): void => {
    setFollowState(on);
    if (on) setEpoch((n) => n + 1);
  }, []);
  const onPersonMoved = useCallback((): void => {
    if (latest.current.active) setFollowState(false);
  }, []);

  // A step, a switch to Follow, a newly chosen walkthrough: open what the step needs (following only).
  // Before paint, so the "Open …" note never shows for the instant before the open is asked for.
  const lastWalk = useRef<string | null>(null);
  const walkId = walk?.id ?? null;
  useLayoutEffect(() => {
    const now = latest.current;
    setAsked(`${walkId}#${state.step}#${epoch}`);
    // A walkthrough chosen before the nested layout exists is still "chosen" when it arrives.
    if (!now.active || now.full === null || now.nest.drawn === null) {
      // Only a closed panel forgets the walkthrough: Back from the old version must not look like choosing it again.
      if (!state.open || walkId === null || walk?.old !== true) lastWalk.current = null;
      setWaitPress(null);
      return;
    }
    const chosen = walkId !== lastWalk.current;
    lastWalk.current = walkId;
    const following = chosen || follow;
    if (chosen) {
      setFollowState(true);
      setEpoch((n) => n + 1);
    }
    // Not following: the person has the view; nothing opens by itself.
    if (!following) {
      setWaitPress(null);
      return;
    }
    const start = startOpen(now.full, now.start, now.nest.saved() ?? now.nest.current());
    const target = stepOpen(now.full, start, now.through, state.step);
    const from = canonicalOpen(now.full, now.nest.current());
    const added = target.filter((id) => !from.includes(id));
    const toggled = added.length === 1 && from.every((id) => target.includes(id)) ? added[0] : undefined;
    // Nothing new to ask (the open was asked a run ago): a layout still on its way is still waited for.
    const press = now.nest.set(target, toggled);
    if (press !== null) setWaitPress(press);
  }, [walkId, state.open, state.step, follow, epoch, active, nest.drawn === null]);

  const drawn = nest.drawn;
  const waiting = waitPress !== null && drawn !== null && drawn.press < waitPress;

  const request = useMemo(() => {
    if (!active || !follow || waiting || walk === null || full === null) return null;
    const parts = members(walk.steps.slice(Math.max(0, state.step - 2), state.step), model);
    const drawnOf = (p: { nodes: readonly string[]; edges: readonly string[] }) =>
      drawn === null
        ? { nodeIds: [...p.nodes], edgeIds: [...p.edges] }
        : drawnIds(drawn.nested, drawn.full, { nodeIds: [...p.nodes], edgeIds: [...p.edges] });
    const ids = drawnOf(parts);
    if (ids.nodeIds.length + ids.edgeIds.length === 0) return null;
    // The current step's own parts: a phone frames those alone (walk-camera.ts `followParts`, O95).
    const now = walk.steps[state.step - 1];
    const current = now === undefined ? undefined : drawnOf(members([now], model));
    const key = `${walk.id}#${state.step}#${epoch}`;
    return asked === key ? { key, ...ids, ...(current === undefined ? {} : { current }) } : null;
  }, [active, follow, waiting, walk, full, state.step, epoch, model, drawn, asked]);
  const camera = useMemo<WalkCamera | undefined>(
    () => (active ? { request, onPersonMoved } : undefined),
    [active, request, onPersonMoved],
  );

  const closed =
    active && !waiting && full !== null && drawn !== null ? closedNote(full, needed, drawn.nested.open) : null;
  const open = useCallback((): void => {
    const now = latest.current;
    if (now.full === null) return;
    setWaitPress(now.nest.set(canonicalOpen(now.full, [...now.nest.current(), ...now.needed])));
    setEpoch((n) => n + 1);
  }, []);
  const note = useMemo(() => (closed === null ? null : { ...closed, open }), [closed, open]);

  return { follow, setFollow, camera, note };
}
