/**
 * Where the keyboard goes next on the sequence canvas, what a message is
 * called, and what the camera has to do to show it.
 *
 * The sequence counterpart of `keyboard-nav.ts`, and pure for the same reason:
 * jsdom does no layout, so the decisions live here where they can be tested
 * against real coordinates, and `SequenceCanvas` only wires them up.
 *
 * It does NOT reuse `nextInDirection`. That function is geometric because a
 * graph has no order but the one ELK drew. A sequence diagram has two orders
 * that are the diagram's meaning -- participants left to right, messages in
 * the order they were written -- and the keys follow those.
 */
import {
  MESSAGE_LINE_HEIGHT,
  SELF_LABEL_GAP,
  SELF_LOOP_HEIGHT,
  SELF_LOOP_WIDTH,
  type LayoutMessage,
  type LayoutNote,
  type LayoutParticipant,
  type SequenceLayoutResult,
} from "../layout/sequence-layout";
import type { ArrowDirection } from "./keyboard-nav";

/**
 * The two keyboard rings. Participants are published as `nodes` and messages
 * as `edges`; the names here are the ones a reader of the diagram would use.
 */
export type SequenceChannel = "participants" | "messages";

export type SequenceTarget = { readonly channel: SequenceChannel; readonly id: string };

export type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

type Camera = { readonly x: number; readonly y: number; readonly scale: number };

type NavLayout = Pick<SequenceLayoutResult, "participants" | "messages">;

/**
 * The one element of a ring that carries `tabindex="0"`.
 *
 * Exactly one, always, for the reasons on `rovingStopId`: none makes the ring
 * unreachable, all of them puts a whole conversation in the page's tab order.
 * A focused id that a recompile removed falls back to the first item rather
 * than holding the stop on a ghost.
 */
export function sequenceStopId(items: readonly { readonly id: string }[], focusedId: string | null): string | null {
  if (focusedId !== null && items.some((item) => item.id === focusedId)) {
    return focusedId;
  }
  return items[0]?.id ?? null;
}

function touches(message: LayoutMessage, participantId: string): boolean {
  return message.from === participantId || message.to === participantId;
}

/** `step` along a ring, wrapping; `null` when there is nowhere else to stand. */
function stepped<T extends { readonly id: string }>(ring: readonly T[], fromId: string, step: 1 | -1): string | null {
  const index = ring.findIndex((item) => item.id === fromId);
  if (index === -1) {
    // A redraw removed what the keyboard was on: start over.
    return ring[0]?.id ?? null;
  }
  if (ring.length < 2) {
    return null;
  }
  return ring[(index + step + ring.length) % ring.length].id;
}

/**
 * The element an arrow key moves focus to, or `null` when there is nowhere.
 *
 * WITHIN A RING, the keys follow the diagram's own two orders and wrap, so no
 * key dead-ends (the reasoning on `nextInDirection` applies unchanged):
 *
 *   - Left/Right on a participant: the neighbouring column.
 *   - Up/Down on a message: the previous/next message IN SOURCE ORDER. Layout
 *     order is source order -- the layout walks the events depth-first -- so a
 *     message inside an `alt` is reached between the ones around the frame.
 *
 * THE CROSS KEYS CHANGE RING, following the drawing. A participant is a column
 * and a message is a row, so each ring has one axis it does not use, and that
 * axis points at the other ring:
 *
 *   - Left/Right on a message: the participant at that END of the arrow, as
 *     drawn. Left is the column on the left, whichever way the arrow points --
 *     the key is spatial, and "the sender" would flip under a reply. A message
 *     to self has one column at both ends.
 *   - Up/Down on a participant: into its column -- Down to the first message
 *     it takes part in, Up to the last. If the message ring's own stop
 *     (`stops.messageId`) already touches this participant, that is where it
 *     goes instead, so stepping sideways off a message and back returns to the
 *     same message rather than to the top of the column. A participant in no
 *     message at all goes to the first/last message of the diagram.
 *
 * Chosen over the two alternatives. Making the cross keys aliases of the main
 * ones (Up on a participant = Left) gives four keys two meanings and teaches
 * nothing. Making them do nothing is the dead end this canvas must not have.
 * Crossing costs nothing in tab stops: there are still exactly two, and each
 * ring's stop simply moves to wherever the keyboard last stood in it.
 *
 * `null` only when there is truly nowhere: one participant and Left/Right, one
 * message and Up/Down, or a cross key with an empty ring on the other side.
 */
export function sequenceMove(
  layout: NavLayout,
  from: SequenceTarget,
  direction: ArrowDirection,
  stops?: { readonly messageId: string | null },
): SequenceTarget | null {
  const { participants, messages } = layout;
  const horizontal = direction === "left" || direction === "right";
  const forward = direction === "right" || direction === "down";

  if (from.channel === "participants") {
    if (horizontal) {
      const id = stepped(participants, from.id, forward ? 1 : -1);
      return id === null ? null : { channel: "participants", id };
    }
    if (messages.length === 0) {
      return null;
    }
    const held = messages.find((message) => message.id === stops?.messageId);
    if (held !== undefined && touches(held, from.id)) {
      return { channel: "messages", id: held.id };
    }
    const own = messages.filter((message) => touches(message, from.id));
    const pool = own.length > 0 ? own : messages;
    return { channel: "messages", id: (forward ? pool[0] : pool[pool.length - 1]).id };
  }

  if (!horizontal) {
    const id = stepped(messages, from.id, forward ? 1 : -1);
    return id === null ? null : { channel: "messages", id };
  }
  const message = messages.find((entry) => entry.id === from.id);
  if (message === undefined) {
    return messages[0] === undefined ? null : { channel: "messages", id: messages[0].id };
  }
  // The two ends in drawn order. An end that names no drawn participant is
  // skipped, so a malformed message still leads somewhere.
  const ends = participants.filter((p) => touches(message, p.id));
  const end = forward ? ends[ends.length - 1] : ends[0];
  if (end !== undefined) {
    return { channel: "participants", id: end.id };
  }
  return participants[0] === undefined ? null : { channel: "participants", id: participants[0].id };
}

/**
 * What a focused message is called: "Client to Server: POST /login".
 *
 * The ends by LABEL, never by id -- `msg-3` and `db` are authored for Mermaid,
 * not for reading aloud. Both ends are always named, even when there is text,
 * because the same text ("200 OK") routinely appears on several arrows and the
 * ends are what tell them apart. An end the layout does not know falls back to
 * its id, which is the only thing left that identifies it.
 *
 * An autonumbered message leads with its number -- "2. Server to Database:
 * SELECT user" -- because the badge is drawn, not text, and the number is how
 * a sighted reader would refer to the message.
 */
export function messageAccessibleName(
  message: Pick<LayoutMessage, "from" | "to" | "label" | "number">,
  participants: readonly Pick<LayoutParticipant, "id" | "label">[],
): string {
  const labelOf = (id: string): string => participants.find((participant) => participant.id === id)?.label || id;
  const ends = `${labelOf(message.from)} to ${labelOf(message.to)}`;
  const numbered = message.number === undefined ? ends : `${message.number}. ${ends}`;
  // `||`, not `??`: an empty caption is not a name.
  return message.label ? `${numbered}: ${message.label}` : numbered;
}

const NOTE_PLACE = { "left-of": "left of", "right-of": "right of", over: "over" } as const;

/**
 * What a note is called: "Note over Client and Server: TLS 1.3".
 *
 * Mermaid's own phrasing, with labels for ids, and the whole text -- a note
 * drawn wrapped or cut is still read out in full.
 */
export function noteAccessibleName(
  note: Pick<LayoutNote, "position" | "participants" | "text">,
  participants: readonly Pick<LayoutParticipant, "id" | "label">[],
): string {
  const labelOf = (id: string): string => participants.find((participant) => participant.id === id)?.label || id;
  const where = [...new Set(note.participants)].map(labelOf).join(" and ");
  return `Note ${NOTE_PLACE[note.position]} ${where}: ${note.text}`;
}

/** How far the hit box reaches past the arrow, above and below. */
const MESSAGE_REACH = 9;

/**
 * The box a message occupies: its arrow and the label above (or beside) it.
 *
 * One definition for two uses -- the invisible pointer target and the box the
 * camera reveals -- so what can be clicked and what is scrolled to are the
 * same rectangle. A 1.5px line is not a target; this is at least 18px tall.
 */
export function messageBox(message: LayoutMessage): Box {
  // The number badge is centred on the start of the arrow, so half of it lies
  // outside the arrow's own span. It is part of the message: it must be
  // clickable and it must be brought into view.
  const badgeReach = (message.badgeWidth ?? 0) / 2;
  if (message.from === message.to) {
    const right =
      message.fromX + SELF_LOOP_WIDTH + (message.lines.length > 0 ? SELF_LABEL_GAP + message.labelWidth : 0);
    const left = message.fromX - Math.max(MESSAGE_REACH, badgeReach);
    return {
      x: left,
      y: message.y - MESSAGE_REACH,
      width: right + MESSAGE_REACH - left,
      height: SELF_LOOP_HEIGHT + MESSAGE_REACH * 2,
    };
  }
  const left = Math.min(message.fromX - badgeReach, message.toX);
  const right = Math.max(message.fromX + badgeReach, message.toX);
  const labelHeight = message.lines.length * MESSAGE_LINE_HEIGHT;
  const top = message.y - Math.max(labelHeight + 4, MESSAGE_REACH);
  return {
    x: left,
    y: top,
    width: right - left,
    height: message.y + MESSAGE_REACH - top,
  };
}

/** The box of whatever `target` names, or `null` if the layout has no such thing. */
export function targetBox(layout: NavLayout, target: SequenceTarget): Box | null {
  if (target.channel === "participants") {
    const participant = layout.participants.find((entry) => entry.id === target.id);
    return participant === undefined
      ? null
      : { x: participant.x, y: participant.y, width: participant.width, height: participant.height };
  }
  const message = layout.messages.find((entry) => entry.id === target.id);
  return message === undefined ? null : messageBox(message);
}

/**
 * Room kept between a revealed element and the edge of the canvas.
 *
 * Smaller than the canvas's own fit gutter (20px), so an element of a diagram
 * that was just fitted already counts as in view and focusing it moves nothing.
 */
const REVEAL_MARGIN = 16;

function revealAxis(start: number, size: number, extent: number): number {
  const room = extent - REVEAL_MARGIN * 2;
  if (size > room || start < REVEAL_MARGIN) {
    // Too big to show whole, or cut off at the near edge: show where it starts.
    return REVEAL_MARGIN - start;
  }
  if (start + size > extent - REVEAL_MARGIN) {
    return extent - REVEAL_MARGIN - (start + size);
  }
  return 0;
}

/**
 * The camera that shows `box`, moved as little as possible.
 *
 * A sequence diagram is as long as its conversation and opens at a readable
 * scale rather than a fitted one, so the message the keyboard steps to is
 * routinely below the fold. Focus on something the reader cannot see is focus
 * lost. Pan only -- never zoom: the scale is the reader's, and a camera that
 * rescales as the keyboard moves cannot be read.
 *
 * Returns the SAME object when nothing has to move, so the caller can tell
 * "already visible" from "moved" without comparing fields, and when the
 * viewport has no size yet (an unmeasured or hidden container).
 */
export function revealPanZoom<T extends Camera>(
  panZoom: T,
  box: Box,
  viewport: { readonly width: number; readonly height: number },
): T {
  if (viewport.width <= REVEAL_MARGIN * 2 || viewport.height <= REVEAL_MARGIN * 2) {
    return panZoom;
  }
  const { scale } = panZoom;
  const dx = revealAxis(box.x * scale + panZoom.x, box.width * scale, viewport.width);
  const dy = revealAxis(box.y * scale + panZoom.y, box.height * scale, viewport.height);
  if (dx === 0 && dy === 0) {
    return panZoom;
  }
  return { ...panZoom, x: panZoom.x + dx, y: panZoom.y + dy };
}
