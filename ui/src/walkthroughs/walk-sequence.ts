/**
 * The Sequence tab's model (ADR 0034 §6): a walkthrough's messages as compact rows for the panel
 * (`layoutWalkSequence`), and the emphasis that lights the current step's messages. Built on the page,
 * never stored or sent. Participants are the messages' ends in order of first appearance, labelled from
 * the host diagram; message ids are `msg-<step>-<n>` (both 1-based, the step as the person counts it),
 * so an id maps back to its step. A step without messages has no row; an out-of-date step's messages
 * are drawn but light nothing.
 */
import type { Emphasis } from "../emphasis/contract";
import type { Walk } from "./contract";
import { walkGroups } from "./walk-render";

export const hasMessages = (walk: Walk): boolean => walk.steps.some((step) => step.messages.length > 0);

/** The current step's messages and their ends, flowing; every earlier step's, quiet. */
export function sequenceEmphasis(walk: Walk, step: number): Emphasis | null {
  if (walk.status === "archived" || step < 1 || step > walk.steps.length) return null;
  const members = (from: number, to: number) => {
    const nodes = new Set<string>();
    const edges: string[] = [];
    for (let s = from; s < to; s += 1) {
      const one = walk.steps[s]!;
      if (one.status === "out-of-date") continue;
      one.messages.forEach((m, i) => {
        edges.push(`msg-${s + 1}-${i + 1}`);
        nodes.add(m.from);
        nodes.add(m.to);
      });
    }
    return { nodes: [...nodes], edges };
  };
  const groups = walkGroups(step, members(step - 1, step), members(0, step - 1));
  return groups.length === 0
    ? null
    : { id: `walkthrough:${walk.id}`, viewId: "", title: walk.title, groups, legend: false };
}

export const COLUMN = 76;
export const ROW = 38;
const LEFT = 58;
const TOP = 54;
export const SELF = 20;

export type WalkSeqRow = {
  readonly id: string;
  readonly step: number;
  readonly first: boolean;
  readonly from: string;
  readonly to: string;
  readonly fromX: number;
  readonly toX: number;
  readonly y: number;
  readonly label: string;
};
export type WalkSeqLayout = {
  readonly width: number;
  readonly height: number;
  readonly participants: readonly {
    readonly id: string;
    readonly label: string;
    readonly lines: readonly string[];
    readonly x: number;
  }[];
  readonly rows: readonly WalkSeqRow[];
};

/** A name in at most two lines of about ten characters, cut with an ellipsis. */
function wrap(text: string): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/)) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.length + 1 + word.length <= 10) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  const cut = (line: string): string => (line.length > 10 ? `${line.slice(0, 9)}…` : line);
  return lines.length <= 2 ? lines.map(cut) : [cut(lines[0]!), cut(lines.slice(1).join(" "))];
}

/**
 * Compact rows, small enough to sit whole in a side panel (the approved prototype's): a column of 76
 * for each participant and 38 for each message. `computeSequenceLayout` spaces for a full-width
 * canvas (200 between lifelines), which scrolls a panel; this has no notes, fragments or bars to place.
 */
export function layoutWalkSequence(walk: Walk, labelOf: (id: string) => string): WalkSeqLayout {
  const hops = walk.steps.flatMap((step, s) => step.messages.map((m, i) => ({ m, s, i })));
  const ends = [...new Set(hops.flatMap(({ m }) => [m.from, m.to]))];
  const participants = ends.map((id, i) => ({
    id,
    label: labelOf(id),
    lines: wrap(labelOf(id)),
    x: LEFT + i * COLUMN,
  }));
  const x = new Map(participants.map((p) => [p.id, p.x]));
  const rows = hops.map(
    ({ m, s, i }, k): WalkSeqRow => ({
      id: `msg-${s + 1}-${i + 1}`,
      step: s + 1,
      first: i === 0,
      from: m.from,
      to: m.to,
      fromX: x.get(m.from)!,
      toX: x.get(m.to)!,
      y: TOP + k * ROW + 24,
      label: m.label,
    }),
  );
  // A self-message's loop and label reach right of its lifeline: the drawing is wide enough for them.
  const base = LEFT + (participants.length - 1) * COLUMN + 40;
  const width = Math.max(
    base,
    ...rows.filter((r) => r.from === r.to).map((r) => r.fromX + SELF + 6 + r.label.length * 6.9 + 8),
  );
  return { width, height: TOP + rows.length * ROW + 14, participants, rows };
}
