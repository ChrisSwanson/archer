/**
 * The walkthrough player (ADR 0034 §6): which walkthrough is open, at which step, playing or not.
 *
 * Pure. Steps are 1-based, as in the address (`?step=3`) and the spoken "Step 3 of 8". The page
 * hook owns the timers and the listeners; this owns what each action means, so the rules are
 * enumerated in tests and the agent-steering and camera slices add actions here, not elsewhere.
 */
export type WalkState = {
  /** The panel is up: on the picker (`id` null) or on a walkthrough. */
  readonly open: boolean;
  readonly id: string | null;
  /** 1..count. */
  readonly step: number;
  readonly count: number;
  readonly playing: boolean;
};

export type WalkAction =
  | { readonly type: "show" }
  | { readonly type: "open"; readonly id: string; readonly count: number; readonly step?: number }
  | { readonly type: "go"; readonly to: "first" | "last" | "next" | "prev" | number }
  | { readonly type: "play" }
  | { readonly type: "tick" }
  | { readonly type: "pause" }
  | { readonly type: "close" }
  /** The walkthroughs were read again: their step counts by id. */
  | { readonly type: "revision"; readonly counts: ReadonlyMap<string, number> };

export const INITIAL_WALK: WalkState = { open: false, id: null, step: 1, count: 0, playing: false };

const clamp = (step: number, count: number): number => Math.max(1, Math.min(Math.max(1, count), Math.trunc(step) || 1));

export function walkReducer(state: WalkState, action: WalkAction): WalkState {
  switch (action.type) {
    case "show":
      return { ...INITIAL_WALK, open: true };
    case "open":
      return {
        open: true,
        id: action.id,
        count: action.count,
        step: clamp(action.step ?? 1, action.count),
        playing: false,
      };
    case "go": {
      if (state.id === null) return state;
      const to =
        action.to === "first"
          ? 1
          : action.to === "last"
            ? state.count
            : action.to === "next"
              ? state.step + 1
              : action.to === "prev"
                ? state.step - 1
                : action.to;
      // A person moving the step takes over from Play.
      return { ...state, step: clamp(to, state.count), playing: false };
    }
    case "play":
      return state.id === null ? state : { ...state, step: state.step >= state.count ? 1 : state.step, playing: true };
    case "tick": {
      if (!state.playing) return state;
      const step = Math.min(state.count, state.step + 1);
      return { ...state, step, playing: step < state.count };
    }
    case "pause":
      return state.playing ? { ...state, playing: false } : state;
    case "close":
      return INITIAL_WALK;
    case "revision": {
      if (!state.open || state.id === null) return state;
      const count = action.counts.get(state.id);
      if (count === undefined) return { ...INITIAL_WALK, open: true };
      if (count === state.count) return state;
      const step = clamp(state.step, count);
      return { ...state, count, step, playing: state.playing && step < count };
    }
  }
}

export type StepState = "done" | "active" | "future";

/** Every step's state at `step`: earlier ones are done, this one is active. */
export function stepStates(step: number, count: number): StepState[] {
  return Array.from({ length: count }, (_, i) => (i + 1 < step ? "done" : i + 1 === step ? "active" : "future"));
}

/**
 * Wheel over the panel: one step per notch, then a rest, so a trackpad fling is one step. The numbers
 * are the approved prototype's: a pause of 160 ms starts a new gesture, a step needs 30 px of
 * accumulated delta, and a gesture that keeps going waits 420 ms between steps.
 */
export const WHEEL_QUIET_MS = 160;
export const WHEEL_REST_MS = 420;
export const WHEEL_THRESHOLD = 30;
export type WheelState = { readonly acc: number; readonly lastWheel: number; readonly lastStep: number };
export const INITIAL_WHEEL: WheelState = { acc: 0, lastWheel: 0, lastStep: 0 };

export function wheelStep(
  state: WheelState,
  input: { readonly dy: number; readonly now: number },
): { readonly state: WheelState; readonly delta: -1 | 0 | 1 } {
  const { dy, now } = input;
  const quiet = now - state.lastWheel > WHEEL_QUIET_MS;
  const acc = quiet ? 0 : state.acc;
  if (!quiet && now - state.lastStep < WHEEL_REST_MS) return { state: { ...state, acc, lastWheel: now }, delta: 0 };
  const next = acc + dy;
  if (Math.abs(next) >= WHEEL_THRESHOLD)
    return { state: { acc: 0, lastWheel: now, lastStep: now }, delta: next > 0 ? 1 : -1 };
  return { state: { ...state, acc: next, lastWheel: now }, delta: 0 };
}
