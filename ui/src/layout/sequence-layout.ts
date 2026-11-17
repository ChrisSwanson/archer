import type {
  NotePosition,
  ParticipantKind,
  ProjectedNoteEvent,
  ProjectedSequence,
  ProjectedSequenceEvent,
} from "../diagrams/projection";
import { DEFAULT_TYPEFACE, estimateTextWidth, truncateToWidth, wrapText, type TypefaceId } from "./text-measure";

/** The narrowest a participant box gets; a long name widens its own box. */
export const PARTICIPANT_WIDTH = 120;
export const PARTICIPANT_HEIGHT = 40;
/** The closest two lifelines sit; a long label between them pushes them apart. */
export const PARTICIPANT_GAP = 200;
/** The pitch of two consecutive single-line messages. */
export const ROW_HEIGHT = 44;

const PARTICIPANT_MAX_WIDTH = 220;
const PARTICIPANT_PADDING_X = 16;
const PARTICIPANT_TALL_HEIGHT = 54;
export const PARTICIPANT_FONT = 13;
const PARTICIPANT_CLEARANCE = 48;

/** The figure an actor's box carries beside its name, and the gap after it. */
export const ACTOR_GLYPH_WIDTH = 14;
export const ACTOR_GLYPH_HEIGHT = 17;
export const ACTOR_GLYPH_GAP = 7;

export const MESSAGE_FONT = 12;
export const MESSAGE_LINE_HEIGHT = 14;
const MESSAGE_LABEL_MAX_WIDTH = 340;
const MESSAGE_LABEL_MAX_LINES = 3;
const MESSAGE_LABEL_CLEARANCE = 36;
const MESSAGE_LABEL_GAP = 6;
const MESSAGE_AFTER = ROW_HEIGHT - MESSAGE_LINE_HEIGHT - MESSAGE_LABEL_GAP;
const UNLABELLED_LEAD = 8;

export const SELF_LOOP_WIDTH = 32;
export const SELF_LOOP_HEIGHT = 18;
export const SELF_LABEL_GAP = 8;
const SELF_LABEL_MAX_WIDTH = 260;

export const FRAGMENT_FONT = 11;
export const FRAGMENT_HEADER_HEIGHT = 24;
const FRAGMENT_PADDING_X = 14;
const FRAGMENT_NEST_INSET = 10;
const FRAGMENT_LEAD = 4;
const FRAGMENT_TRAIL = 12;
const FRAGMENT_LABEL_MAX_WIDTH = 420;
const SECTION_LABEL_BAND = 18;
const SECTION_BARE_BAND = 6;
const EMPTY_SECTION_HEIGHT = 14;

export const ACTIVATION_WIDTH = 10;
export const ACTIVATION_NEST_OFFSET = 4;

export const NOTE_FONT = 12;
export const NOTE_LINE_HEIGHT = 15;
const NOTE_PADDING_X = 10;
export const NOTE_PADDING_Y = 7;
/** The corner turned down on a note's sheet. */
export const NOTE_FOLD = 8;
const NOTE_TEXT_MAX_WIDTH = 180;
const NOTE_MAX_LINES = 8;
const NOTE_MIN_WIDTH = 56;
/** From a lifeline to the note beside it: clear of two nested activation bars. */
const NOTE_SIDE_GAP = 14;
/** From a note to the NEXT lifeline, which it must not touch. */
const NOTE_CLEARANCE = 16;
/** How far `over a,b` reaches past the two lifelines it spans. */
const NOTE_OVERHANG = 18;
const NOTE_LEAD = 6;
const NOTE_TRAIL = 10;

/** A message number: at the notation's smallest reading size (`FRAGMENT_FONT`), so Fit's floor holds for it too. */
export const BADGE_FONT = 11;
export const BADGE_HEIGHT = 14;
const BADGE_PADDING_X = 5;

const FIRST_ROW_LEAD = 16;
const LIFELINE_TAIL = 8;

export type LayoutParticipant = {
  readonly id: string;
  /** The full name, for the accessible name and the tooltip. */
  readonly label: string;
  /** The name as drawn: wrapped to the box, cut with an ellipsis if need be. */
  readonly lines: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** `actor` draws a figure beside the name; absent means `participant`. */
  readonly kind?: ParticipantKind;
};

export type LayoutMessage = {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** Where the arrow leaves and lands: the lifeline, or the edge of a bar on it. */
  readonly fromX: number;
  readonly toX: number;
  readonly y: number;
  readonly label: string | undefined;
  readonly lines: readonly string[];
  readonly labelWidth: number;
  readonly kind: "sync" | "reply" | "async";
  /** An arrowhead at each end, at `fromX` as well as `toX`. */
  readonly bidirectional?: boolean;
  /** Its place in the conversation, 1-based, when the trace is autonumbered. */
  readonly number?: number;
  /** The width of the number badge centred on `fromX`; set with `number`. */
  readonly badgeWidth?: number;
};

/**
 * A `Note`: an annotation, laid out and drawn but never a target. It has no
 * place in `messages` or `participants`, which are the two keyboard rings and
 * the two halves of a selection, and that absence is what keeps it out of
 * both (ADR 0009: a note id is not focusable and not emphasisable).
 */
export type LayoutNote = {
  readonly id: string;
  readonly position: NotePosition;
  readonly participants: readonly string[];
  /** The full text, for the accessible name and the tooltip. */
  readonly text: string;
  readonly lines: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type LayoutFragmentSection = {
  readonly label: string | undefined;
  /** For every section after the first, the y of the divider above it. */
  readonly y: number;
};

export type LayoutFragment = {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  /** The header text as drawn, cut to the frame if the label is very long. */
  readonly headerLabel: string;
  readonly chipWidth: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly sections: readonly LayoutFragmentSection[];
};

export type LayoutActivation = {
  readonly participantId: string;
  readonly startY: number;
  readonly endY: number;
  /** How many bars were already open on this lifeline; nested bars step right. */
  readonly depth: number;
};

/**
 * `originX`/`originY` plus `width`/`height` are the box the drawing actually
 * occupies. The origin is NOT assumed to be zero: a fragment frame reaches past
 * the first participant box, and a canvas that framed `0..width` clipped it.
 */
export type SequenceLayoutResult = {
  readonly participants: readonly LayoutParticipant[];
  readonly messages: readonly LayoutMessage[];
  /** Enclosing frames come before the frames they contain, so they paint underneath. */
  readonly fragments: readonly LayoutFragment[];
  readonly activations: readonly LayoutActivation[];
  /** In source order. */
  readonly notes: readonly LayoutNote[];
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
  readonly lifelineEndY: number;
  /**
   * The face every width here was estimated for. The canvas sizes a selected
   * label's plate and centres an actor's figure from the same estimate, so it
   * has to ask in the same face. Absent on a layout built by hand: the default.
   */
  readonly typeface?: TypefaceId;
};

type MutableActivation = {
  participantId: string;
  startY: number;
  endY: number;
  depth: number;
};

type PreparedLabel = { lines: string[]; width: number; number?: number; badgeWidth: number };

type PreparedNote = { lines: string[]; width: number; height: number };

type Column = { center: number; left: number; right: number };

type LayoutContext = {
  /** The face every width in this layout is estimated for. */
  typeface: TypefaceId;
  columns: Map<string, Column>;
  allLeft: number;
  allRight: number;
  labels: Map<string, PreparedLabel>;
  preparedNotes: Map<string, PreparedNote>;
  notes: LayoutNote[];
  messages: LayoutMessage[];
  fragments: LayoutFragment[];
  activationStack: Map<string, MutableActivation[]>;
  completedActivations: LayoutActivation[];
  /** The y of the most recent message, which `activate`/`deactivate` attach to. */
  lastMessageY: number | undefined;
  minX: number;
  maxX: number;
};

/** What a fragment tells its parent: how deep it nests and how far it reaches. */
type FragmentExtent = { depth: number; left: number; right: number };

function isSelf(event: { from: string; to: string }): boolean {
  return event.from === event.to;
}

/**
 * AUTONUMBER IS A BADGE AT THE START OF THE ARROW, not a prefix on the label.
 *
 * The number is the message's place in the conversation, not part of what was
 * said. As a prefix it would wrap with the text, sit at a different x on every
 * row, change the label the selection publishes, and leave an unlabelled
 * message with nowhere to put it. As a badge on the sender's lifeline it lines
 * up down the lifelines, so the order can be read with a finger, it says which
 * end the message leaves from, and the label stays exactly the author's text.
 * The cost is width: the label is centred on its arrow, so the badge at one
 * end is reserved at both (`layoutColumns`).
 */
function badgeWidthFor(number: number, typeface: TypefaceId): number {
  return Math.max(BADGE_HEIGHT, estimateTextWidth(String(number), BADGE_FONT, true, typeface) + BADGE_PADDING_X * 2);
}

function prepareLabel(
  event: { from: string; to: string; label: string | undefined },
  number: number | undefined,
  typeface: TypefaceId,
): PreparedLabel {
  const badge = { number, badgeWidth: number === undefined ? 0 : badgeWidthFor(number, typeface) };
  if (event.label === undefined || event.label === "") {
    return { lines: [], width: 0, ...badge };
  }
  // A self-message's label sits beside its loop on one line; any other label
  // sits above its arrow and may wrap.
  const lines = isSelf(event)
    ? [truncateToWidth(event.label, SELF_LABEL_MAX_WIDTH, MESSAGE_FONT, false, typeface)]
    : wrapText(event.label, MESSAGE_LABEL_MAX_WIDTH, MESSAGE_FONT, MESSAGE_LABEL_MAX_LINES, false, typeface);
  const width = Math.max(...lines.map((line) => estimateTextWidth(line, MESSAGE_FONT, false, typeface)));
  return { lines, width, ...badge };
}

/**
 * A note's sheet, sized to its text wrapped at `maxTextWidth`.
 *
 * The padding is generous on purpose: the estimate is tuned to the UI face and
 * runs a few percent narrow in a wide fallback, and the slack has to come out
 * of the padding rather than out of the sheet's edge.
 */
function prepareNote(text: string, maxTextWidth: number, typeface: TypefaceId): PreparedNote {
  const lines = wrapText(text, maxTextWidth, NOTE_FONT, NOTE_MAX_LINES, false, typeface);
  const textWidth = Math.max(0, ...lines.map((line) => estimateTextWidth(line, NOTE_FONT, false, typeface)));
  return {
    lines,
    width: Math.max(NOTE_MIN_WIDTH, textWidth + NOTE_PADDING_X * 2),
    height: lines.length * NOTE_LINE_HEIGHT + NOTE_PADDING_Y * 2,
  };
}

/** `over a,b`, as opposed to `over a` (or the degenerate `over a,a`). */
function spansTwo(note: Pick<ProjectedNoteEvent, "position" | "participants">): boolean {
  return note.position === "over" && note.participants.length > 1 && note.participants[0] !== note.participants[1];
}

function walkNotes(events: readonly ProjectedSequenceEvent[], visit: (note: ProjectedNoteEvent) => void): void {
  for (const event of events) {
    if (event.type === "note") {
      visit(event);
    } else if (event.type === "fragment") {
      for (const section of event.sections) {
        walkNotes(section.events, visit);
      }
    }
  }
}

function walkMessages(
  events: readonly ProjectedSequenceEvent[],
  visit: (message: Extract<ProjectedSequenceEvent, { type: "message" }>) => void,
): void {
  for (const event of events) {
    if (event.type === "message") {
      visit(event);
    } else if (event.type === "fragment") {
      for (const section of event.sections) {
        walkMessages(section.events, visit);
      }
    }
  }
}

/**
 * Horizontal pass: how wide each participant box is and where each lifeline
 * stands. Lifelines start at the minimum pitch and are pushed apart only as far
 * as the labels that have to fit between them require.
 */
function layoutColumns(
  sequence: ProjectedSequence,
  labels: Map<string, PreparedLabel>,
  notes: Map<string, PreparedNote>,
  typeface: TypefaceId,
): { participants: LayoutParticipant[]; columns: Map<string, Column> } {
  const boxes = sequence.participants.map((p) => {
    const kind: ParticipantKind = p.kind ?? "participant";
    // An actor's figure shares the box with the name, so it is paid for in
    // width: the name gets the same room it would have had without it.
    const inner = PARTICIPANT_PADDING_X * 2 + (kind === "actor" ? ACTOR_GLYPH_WIDTH + ACTOR_GLYPH_GAP : 0);
    const natural = estimateTextWidth(p.label, PARTICIPANT_FONT, true, typeface) + inner;
    const width = Math.min(Math.max(natural, PARTICIPANT_WIDTH), PARTICIPANT_MAX_WIDTH);
    const lines = wrapText(p.label, width - inner, PARTICIPANT_FONT, 2, true, typeface);
    return { id: p.id, label: p.label, width, lines, kind };
  });
  const height = boxes.some((box) => box.lines.length > 1) ? PARTICIPANT_TALL_HEIGHT : PARTICIPANT_HEIGHT;

  const index = new Map(boxes.map((box, i) => [box.id, i]));
  const pitch: number[] = [];
  for (let i = 0; i + 1 < boxes.length; i++) {
    pitch.push(Math.max(PARTICIPANT_GAP, (boxes[i].width + boxes[i + 1].width) / 2 + PARTICIPANT_CLEARANCE));
  }

  walkMessages(sequence.events, (message) => {
    const from = index.get(message.from);
    const to = index.get(message.to);
    const label = labels.get(message.id);
    if (from === undefined || to === undefined || label === undefined || label.width === 0) {
      return;
    }
    if (from === to) {
      // Keep the label beside the loop from running into the next lifeline.
      if (from < pitch.length) {
        const need = SELF_LOOP_WIDTH + SELF_LABEL_GAP + label.width + MESSAGE_LABEL_CLEARANCE / 2;
        pitch[from] = Math.max(pitch[from], need);
      }
      return;
    }
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    // The label is centred on the arrow, so the badge at its start costs
    // half its width at each end.
    const need = label.width + MESSAGE_LABEL_CLEARANCE + label.badgeWidth;
    let span = 0;
    for (let i = lo; i < hi; i++) span += pitch[i];
    if (span < need) {
      const extra = Math.ceil((need - span) / (hi - lo));
      for (let i = lo; i < hi; i++) pitch[i] += extra;
    }
  });

  // A note beside a lifeline pushes the lifeline on that side away, so it
  // never lies across it. At either end of the diagram there is no neighbour
  // to push; there the note widens the extent instead (`layoutEvents`).
  walkNotes(sequence.events, (note) => {
    const at = index.get(note.participants[0]);
    const prepared = notes.get(note.id);
    if (at === undefined || prepared === undefined || note.position === "over") {
      return;
    }
    const gap = note.position === "right-of" ? at : at - 1;
    if (gap >= 0 && gap < pitch.length) {
      pitch[gap] = Math.max(pitch[gap], NOTE_SIDE_GAP + prepared.width + NOTE_CLEARANCE);
    }
  });

  const participants: LayoutParticipant[] = [];
  const columns = new Map<string, Column>();
  let center = boxes.length > 0 ? boxes[0].width / 2 : 0;
  boxes.forEach((box, i) => {
    const x = center - box.width / 2;
    participants.push({
      id: box.id,
      label: box.label,
      lines: box.lines,
      x,
      y: 0,
      width: box.width,
      height,
      kind: box.kind,
    });
    columns.set(box.id, { center, left: x, right: x + box.width });
    center += pitch[i] ?? 0;
  });
  return { participants, columns };
}

function activeDepth(ctx: LayoutContext, participantId: string): number {
  return ctx.activationStack.get(participantId)?.length ?? 0;
}

/** The x an arrow meets a lifeline at: the bar's edge if one is open, else the line. */
function attachX(ctx: LayoutContext, participantId: string, towards: number): number {
  const column = ctx.columns.get(participantId);
  if (column === undefined) return 0;
  const depth = activeDepth(ctx, participantId);
  if (depth === 0) return column.center;
  const barCenter = column.center + (depth - 1) * ACTIVATION_NEST_OFFSET;
  return towards >= column.center ? barCenter + ACTIVATION_WIDTH / 2 : barCenter - ACTIVATION_WIDTH / 2;
}

/** Where a note's sheet goes, or `undefined` if it names no drawn lifeline. */
function placeNote(event: ProjectedNoteEvent, y: number, ctx: LayoutContext): LayoutNote | undefined {
  const first = ctx.columns.get(event.participants[0]);
  if (first === undefined) {
    return undefined;
  }
  const base = { id: event.id, position: event.position, participants: event.participants, text: event.text, y };

  const second = spansTwo(event) ? ctx.columns.get(event.participants[1]) : undefined;
  if (second !== undefined) {
    // Sized here rather than up front: its width is the span between two
    // lifelines, which is only known once the columns are placed.
    const x = Math.min(first.center, second.center) - NOTE_OVERHANG;
    const width = Math.abs(second.center - first.center) + NOTE_OVERHANG * 2;
    const prepared = prepareNote(event.text, width - NOTE_PADDING_X * 2, ctx.typeface);
    return { ...base, lines: prepared.lines, x, width, height: prepared.height };
  }

  const prepared = ctx.preparedNotes.get(event.id) ?? prepareNote(event.text, NOTE_TEXT_MAX_WIDTH, ctx.typeface);
  const x =
    event.position === "left-of"
      ? first.center - NOTE_SIDE_GAP - prepared.width
      : event.position === "right-of"
        ? first.center + NOTE_SIDE_GAP
        : first.center - prepared.width / 2;
  return { ...base, lines: prepared.lines, x, width: prepared.width, height: prepared.height };
}

function layoutEvents(
  events: readonly ProjectedSequenceEvent[],
  startY: number,
  ctx: LayoutContext,
  extent: FragmentExtent,
): number {
  let cursor = startY;

  for (const event of events) {
    switch (event.type) {
      case "message": {
        const label: PreparedLabel = ctx.labels.get(event.id) ?? { lines: [], width: 0, badgeWidth: 0 };
        const from = ctx.columns.get(event.from);
        const to = ctx.columns.get(event.to);
        const self = isSelf(event);
        const lead =
          self || label.lines.length === 0
            ? UNLABELLED_LEAD
            : label.lines.length * MESSAGE_LINE_HEIGHT + MESSAGE_LABEL_GAP;
        const y = cursor + lead;

        const fromX = attachX(ctx, event.from, self ? Infinity : (to?.center ?? 0));
        const toX = self ? fromX : attachX(ctx, event.to, from?.center ?? 0);
        ctx.messages.push({
          id: event.id,
          from: event.from,
          to: event.to,
          fromX,
          toX,
          y,
          label: event.label,
          lines: label.lines,
          labelWidth: label.width,
          kind: event.kind,
          ...(event.bidirectional === true ? { bidirectional: true } : {}),
          ...(label.number === undefined ? {} : { number: label.number, badgeWidth: label.badgeWidth }),
        });

        if (from !== undefined) extent.left = Math.min(extent.left, from.left);
        if (to !== undefined) extent.left = Math.min(extent.left, to.left);
        if (from !== undefined) extent.right = Math.max(extent.right, from.right);
        if (to !== undefined) extent.right = Math.max(extent.right, to.right);
        if (self) {
          const reach = fromX + SELF_LOOP_WIDTH + SELF_LABEL_GAP + label.width;
          extent.right = Math.max(extent.right, reach);
          ctx.maxX = Math.max(ctx.maxX, reach);
        }

        // An open bar on either end runs at least as far as this message.
        for (const pid of [event.from, event.to]) {
          const stack = ctx.activationStack.get(pid);
          if (stack && stack.length > 0) {
            stack[stack.length - 1].endY = y;
          }
        }
        ctx.lastMessageY = y;
        cursor = y + (self ? SELF_LOOP_HEIGHT : 0) + MESSAGE_AFTER;
        break;
      }
      case "activate": {
        // `activate` follows the message that causes it, so the bar starts
        // there rather than at the next row.
        const y = ctx.lastMessageY ?? cursor;
        let stack = ctx.activationStack.get(event.participant);
        if (!stack) {
          stack = [];
          ctx.activationStack.set(event.participant, stack);
        }
        stack.push({ participantId: event.participant, startY: y, endY: y, depth: stack.length });
        const column = ctx.columns.get(event.participant);
        if (column !== undefined) {
          extent.left = Math.min(extent.left, column.left);
          extent.right = Math.max(extent.right, column.right);
        }
        break;
      }
      case "deactivate": {
        const stack = ctx.activationStack.get(event.participant);
        if (stack && stack.length > 0) {
          const activation = stack.pop()!;
          activation.endY = Math.max(activation.startY, ctx.lastMessageY ?? cursor);
          ctx.completedActivations.push({ ...activation });
        }
        break;
      }
      case "fragment": {
        const frameY = cursor + FRAGMENT_LEAD;
        // Claim the slot now: the frame's own geometry is only known once its
        // contents are laid out, but it must be listed before them.
        const slot = ctx.fragments.length;
        ctx.fragments.push(undefined as unknown as LayoutFragment);

        const inner: FragmentExtent = { depth: 0, left: Infinity, right: -Infinity };
        const sections: LayoutFragmentSection[] = [];
        cursor = frameY + FRAGMENT_HEADER_HEIGHT;

        event.sections.forEach((section, si) => {
          if (si === 0) {
            sections.push({ label: section.label, y: frameY });
          } else {
            const dividerY = cursor + 2;
            sections.push({ label: section.label, y: dividerY });
            cursor = dividerY + (section.label ? SECTION_LABEL_BAND : SECTION_BARE_BAND);
          }
          const before = cursor;
          cursor = layoutEvents(section.events, cursor, ctx, inner);
          if (cursor === before) {
            cursor += EMPTY_SECTION_HEIGHT;
          }
        });

        // A fragment that names no participant frames all of them.
        if (inner.left === Infinity) {
          inner.left = ctx.allLeft;
          inner.right = ctx.allRight;
        }
        const pad = FRAGMENT_PADDING_X + inner.depth * FRAGMENT_NEST_INSET;
        const face = ctx.typeface;
        const chipWidth = estimateTextWidth(event.kind, FRAGMENT_FONT, true, face) + 16;
        const headerLabel = truncateToWidth(`[${event.label}]`, FRAGMENT_LABEL_MAX_WIDTH, FRAGMENT_FONT, false, face);
        const headerWidth = chipWidth + 8 + estimateTextWidth(headerLabel, FRAGMENT_FONT, false, face) + 12;
        const sectionWidth = Math.max(
          0,
          ...event.sections
            .slice(1)
            .map((s) => (s.label ? estimateTextWidth(`[${s.label}]`, FRAGMENT_FONT, false, face) + 24 : 0)),
        );

        const x = inner.left - pad;
        const width = Math.max(inner.right + pad - x, headerWidth, Math.min(sectionWidth, FRAGMENT_LABEL_MAX_WIDTH));
        const frameBottom = cursor;

        ctx.fragments[slot] = {
          id: event.id,
          kind: event.kind,
          label: event.label,
          headerLabel,
          chipWidth,
          x,
          y: frameY,
          width,
          height: frameBottom - frameY,
          sections,
        };

        extent.depth = Math.max(extent.depth, inner.depth + 1);
        // Hand the parent the CONTENT edges, not the frame's: the parent pads
        // one nesting step further than this frame did, which is the inset.
        extent.left = Math.min(extent.left, inner.left);
        extent.right = Math.max(extent.right, x + width - pad);
        ctx.maxX = Math.max(ctx.maxX, x + width);
        cursor = frameBottom + FRAGMENT_TRAIL;
        break;
      }
      case "note": {
        const placed = placeNote(event, cursor + NOTE_LEAD, ctx);
        if (placed === undefined) {
          break;
        }
        ctx.notes.push(placed);
        // A note inside a frame is content of the frame: the frame widens to
        // hold it, exactly as it does for a self-message's label.
        extent.left = Math.min(extent.left, placed.x);
        extent.right = Math.max(extent.right, placed.x + placed.width);
        ctx.minX = Math.min(ctx.minX, placed.x);
        ctx.maxX = Math.max(ctx.maxX, placed.x + placed.width);
        // A band of its own: the next row starts under the sheet, so no
        // message label, fragment header or section label can share it.
        cursor = placed.y + placed.height + NOTE_TRAIL;
        break;
      }
      default:
        // Total, not exhaustive: an event with no row here gets none. An
        // unknown type cannot reach this from the app -- `projectEnvelope`
        // refuses the envelope -- and the layout must not be what throws.
        break;
    }
  }

  return cursor;
}

export function computeSequenceLayout(
  sequence: ProjectedSequence,
  typeface: TypefaceId = DEFAULT_TYPEFACE,
): SequenceLayoutResult {
  const labels = new Map<string, PreparedLabel>();
  // Numbered here, in the one walk that is source order by construction, so
  // the horizontal pass already knows how wide each badge is.
  let nextNumber = 1;
  walkMessages(sequence.events, (message) => {
    labels.set(message.id, prepareLabel(message, sequence.autonumber ? nextNumber++ : undefined, typeface));
  });
  const preparedNotes = new Map<string, PreparedNote>();
  walkNotes(sequence.events, (note) => {
    if (!spansTwo(note)) {
      preparedNotes.set(note.id, prepareNote(note.text, NOTE_TEXT_MAX_WIDTH, typeface));
    }
  });

  const { participants, columns } = layoutColumns(sequence, labels, preparedNotes, typeface);
  const allLeft = participants.length > 0 ? participants[0].x : 0;
  const last = participants[participants.length - 1];
  const allRight = last ? last.x + last.width : 0;
  const headerHeight = participants[0]?.height ?? PARTICIPANT_HEIGHT;

  const ctx: LayoutContext = {
    typeface,
    columns,
    allLeft,
    allRight,
    labels,
    preparedNotes,
    notes: [],
    messages: [],
    fragments: [],
    activationStack: new Map(),
    completedActivations: [],
    lastMessageY: undefined,
    minX: allLeft,
    maxX: allRight,
  };

  const top: FragmentExtent = { depth: 0, left: Infinity, right: -Infinity };
  const end = layoutEvents(sequence.events, headerHeight + FIRST_ROW_LEAD, ctx, top);
  const lifelineEndY = end + LIFELINE_TAIL;

  // A bar never closed runs to the end of its lifeline.
  for (const [, stack] of ctx.activationStack) {
    for (const activation of stack) {
      ctx.completedActivations.push({ ...activation, endY: lifelineEndY });
    }
  }

  const originX = Math.min(ctx.minX, ...ctx.fragments.map((f) => f.x));
  const maxX = Math.max(ctx.maxX, ...ctx.fragments.map((f) => f.x + f.width));

  return {
    participants,
    messages: ctx.messages,
    fragments: ctx.fragments,
    activations: ctx.completedActivations,
    notes: ctx.notes,
    originX,
    originY: 0,
    width: participants.length > 0 ? maxX - originX : 0,
    height: lifelineEndY,
    lifelineEndY,
    typeface,
  };
}
