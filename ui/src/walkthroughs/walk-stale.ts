/**
 * What the page says of a walkthrough that no longer matches the diagram (ADR 0034 §3, slice 7b):
 * the words are the approved prototype's, kept here so the panel, the canvas note and the tests share
 * one source. Status in, text out; nothing here reads the page.
 */
import type { Walk, WalkStep } from "./contract";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "12 Aug", with the year when it is not this one; the day in UTC, so every reader reads the same one. Empty if it does not read. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const day = `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
  return at.getUTCFullYear() === now.getUTCFullYear() ? day : `${day} ${at.getUTCFullYear()}`;
}

/** The step body's first line: what it used to point at. Null for a step that still matches. */
export function wasLine(step: WalkStep): string | null {
  if (step.status !== "out-of-date") return null;
  const missing = step.missing ?? [];
  return missing.length === 0
    ? "What this step pointed at is no longer in this diagram."
    : `Was ${missing.join(" and ")}, which is no longer in this diagram.`;
}

export type Notice = { readonly lead: string; readonly rest: string };

/** The panel's notice on a partly out-of-date walkthrough; the date is that of the diagram's last change, when known. */
export function flagNotice(walk: Walk, changedAt: string | undefined, now?: Date): Notice {
  const n = walk.outOfDate.length;
  const left = walk.steps.length - n;
  const day = changedAt === undefined ? "" : dayLabel(changedAt, now);
  return {
    lead: `Archer flagged this to the agent: ${plural(n, "step")} out of date.`,
    rest: `The diagram changed${day === "" ? "" : ` on ${day}`}; the other ${plural(left, "step")} ${left === 1 ? "still matches" : "still match"}.`,
  };
}

/** The note on the canvas while an out-of-date step is the current one. */
export function canvasNote(walk: Walk, step: number): Notice | null {
  const s = walk.steps[step - 1];
  if (walk.status === "archived" || s === undefined || s.status !== "out-of-date") return null;
  return {
    lead: `Step ${step} is out of date.`,
    rest: `${s.edges.length + s.messages.length > 0 ? "Its line" : "What it points at"} is no longer in this diagram.`,
  };
}

/** The archived walkthrough as it plays on the version it was written for: every step matches that, so none is greyed. */
export function playableOld(walk: Walk): Walk {
  return {
    ...walk,
    status: "current",
    outOfDate: [],
    old: true,
    steps: walk.steps.map((s) => ({ ...s, status: "current" as const, missing: [] })),
  };
}

/** The marker on the canvas. */
export const oldMark = (committedAt: string, now?: Date): string => {
  const day = dayLabel(committedAt, now);
  return day === "" ? "Old version" : `Old version · ${day}`;
};
