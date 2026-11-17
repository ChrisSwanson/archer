/**
 * Which of an emphasis's groups the reader has on, and whether they are
 * looking at one at a time or all of them (ADR 0030, "One / All").
 *
 * The reader's, never the agent's: nothing here is published. Kept per named
 * emphasis (`viewId` + emphasis id), so turning to another emphasis and back
 * starts that one afresh, and a republish of the same one keeps what the reader
 * chose for every group that still exists.
 *
 *   - All is offered only when no two groups share a part. Then the view
 *     opens on All, every row on: an overview first.
 *   - Groups that share a part open one at a time, group 1 on, All disabled,
 *     because no colour-only drawing says "both" honestly.
 *   - A republish that makes the groups overlap drops the reader to One,
 *     keeping the first group they had on. Mode and membership are settled in
 *     the one step, so no state shows two overlapping groups at once.
 */
import type { Emphasis } from "./contract";

export type LegendMode = "one" | "all";

export type LegendState = {
  /** `viewId\0emphasisId`: the emphasis this state belongs to. */
  readonly key: string;
  readonly mode: LegendMode;
  /** Group ids the reader has on, in the emphasis's order. */
  readonly on: readonly string[];
};

export function legendKey(emphasis: Emphasis | null): string {
  return emphasis === null ? "" : `${emphasis.viewId}\0${emphasis.id}`;
}

/** Where a fresh emphasis opens: All when the groups are disjoint, else group 1 alone. */
export function openingState(emphasis: Emphasis | null, overlapping: boolean): LegendState {
  const ids = emphasis?.groups.map((group) => group.id) ?? [];
  if (!overlapping && ids.length > 1) return { key: legendKey(emphasis), mode: "all", on: ids };
  return { key: legendKey(emphasis), mode: "one", on: ids.slice(0, 1) };
}

/**
 * The state for `emphasis` given what the reader had: fresh for a new
 * emphasis, reconciled for a republish of the same one.
 */
export function reconcile(previous: LegendState | null, emphasis: Emphasis | null, overlapping: boolean): LegendState {
  const key = legendKey(emphasis);
  if (previous === null || previous.key !== key) return openingState(emphasis, overlapping);
  const ids = emphasis?.groups.map((group) => group.id) ?? [];
  const kept = ids.filter((id) => previous.on.includes(id));
  if (previous.mode === "all" && (overlapping || ids.length < 2)) return { key, mode: "one", on: kept.slice(0, 1) };
  if (previous.mode === "one") return { key, mode: "one", on: kept.slice(0, 1) };
  return { key, mode: "all", on: kept };
}

/** A tap on a row: in One it switches to that group, or off if it was on; in All it toggles it. */
export function toggleRow(state: LegendState, emphasis: Emphasis | null, id: string): LegendState {
  const ids = emphasis?.groups.map((group) => group.id) ?? [];
  if (!ids.includes(id)) return state;
  const on = state.on.includes(id);
  if (state.mode === "one") return { ...state, on: on ? [] : [id] };
  const next = on ? state.on.filter((each) => each !== id) : [...state.on, id];
  return { ...state, on: ids.filter((each) => next.includes(each)) };
}

/** The One / All control. All is refused while groups overlap. */
export function setMode(
  state: LegendState,
  emphasis: Emphasis | null,
  mode: LegendMode,
  overlapping: boolean,
): LegendState {
  const ids = emphasis?.groups.map((group) => group.id) ?? [];
  if (mode === "all") return overlapping ? state : { ...state, mode: "all", on: ids };
  return { ...state, mode: "one", on: state.on.slice(0, 1).length > 0 ? state.on.slice(0, 1) : ids.slice(0, 1) };
}
