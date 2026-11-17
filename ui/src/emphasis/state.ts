/**
 * What is emphasised on the canvas right now.
 *
 * TWO facts, kept apart on purpose:
 *
 *   - the stored LIST is the agent's. It arrives whole on every change (the
 *     wire carries no deltas within a snapshot), so it is replaced, not merged.
 *   - which member is ACTIVE is partly the user's. They can pick a chip, and
 *     they can dismiss the one that is up.
 *
 * Collapsing the two gives one of two wrong behaviours: either the agent's next
 * publish silently undoes a dismissal, or a dismissal outlives the agent's next
 * statement. The rule that separates them is ARRIVAL: an emphasis id this page
 * has not seen before is the agent saying something new, and that takes the
 * canvas. A republished list the user has already answered does not.
 *
 * Emphasis is per-view. Nothing survives a view change, because an emphasis
 * names ids in the diagram it was published against and those ids mean nothing
 * in another one.
 */
import type { Emphasis, EmphasisSnapshot } from "./contract";

export type EmphasisStoreState = {
  /** The view these emphases belong to; `null` before anything is on screen. */
  readonly viewId: string | null;
  /** The agent's stored list for that view, oldest-first. */
  readonly emphases: readonly Emphasis[];
  readonly activeId: string | null;
};

export type EmphasisAction =
  /**
   * `prefer`: the emphasis the page's address names (`?emphasis=<id>`, on the link `present_diagram` returns).
   * It is shown instead of the newest only when the view's list first arrives and still holds it.
   */
  | { type: "publish"; snapshot: EmphasisSnapshot; prefer?: string }
  | { type: "select"; id: string }
  | { type: "view_change"; viewId: string | null };

export function initialEmphasisState(): EmphasisStoreState {
  return { viewId: null, emphases: [], activeId: null };
}

/** The emphasis the canvas should draw, or `null` for none. */
export function activeEmphasis(state: EmphasisStoreState): Emphasis | null {
  if (state.activeId === null) {
    return null;
  }
  return state.emphases.find((emphasis) => emphasis.id === state.activeId) ?? null;
}

function publish(state: EmphasisStoreState, snapshot: EmphasisSnapshot, prefer?: string): EmphasisStoreState {
  // A snapshot for a view that is not on screen is not this canvas's to draw.
  // The shell fetches the right one when the view changes, so ignoring this is
  // a delay at worst -- where rendering it would emphasise ids belonging to a
  // diagram the user is not looking at.
  if (snapshot.viewId !== state.viewId) {
    return state;
  }

  const known = new Set(state.emphases.map((emphasis) => emphasis.id));
  const arrived = snapshot.emphases.filter((emphasis) => !known.has(emphasis.id));

  // The agent has just pointed at something: show it, newest last. Requiring a
  // click first would make `set_emphasis` a tool that does nothing on its own.
  if (arrived.length > 0) {
    // A link that names one of them opens on it, if this is the view's first list (nothing known before).
    const named =
      prefer !== undefined && known.size === 0 && arrived.some((emphasis) => emphasis.id === prefer)
        ? prefer
        : undefined;
    return {
      viewId: state.viewId,
      emphases: snapshot.emphases,
      activeId: named ?? arrived[arrived.length - 1].id,
    };
  }

  // Nothing new was said, so the user's answer stands -- including a dismissal.
  // The one exception is an active emphasis the agent has stopped storing:
  // there is no longer anything to draw.
  const stillStored = snapshot.emphases.some((emphasis) => emphasis.id === state.activeId);
  return {
    viewId: state.viewId,
    emphases: snapshot.emphases,
    activeId: stillStored ? state.activeId : null,
  };
}

export function emphasisReducer(state: EmphasisStoreState, action: EmphasisAction): EmphasisStoreState {
  switch (action.type) {
    case "publish":
      return publish(state, action.snapshot, action.prefer);

    case "select": {
      // Picking a chip that is not stored would put the canvas in a state no
      // chip could get it out of.
      if (!state.emphases.some((emphasis) => emphasis.id === action.id)) {
        return state;
      }
      // Picking the active one again dismisses it. The chip stays: dismissed is
      // not deleted, and the agent's list is untouched by the user looking away.
      return { ...state, activeId: state.activeId === action.id ? null : action.id };
    }

    case "view_change":
      // Re-asserting the same view is not a change. Returning a fresh object
      // would clear the list on every redraw of the diagram already on screen.
      return action.viewId === state.viewId ? state : { viewId: action.viewId, emphases: [], activeId: null };
  }
}
