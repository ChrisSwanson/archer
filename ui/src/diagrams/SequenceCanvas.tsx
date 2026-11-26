import type { Edges } from "../geometry/rect";
import { layoutFrame, observeLayoutElements } from "../app/layout-observer";
import { InlineLabelInput } from "./InlineLabelInput";
import { DEFAULT_POINTER_MODE, PanSelectControl, type PointerMode } from "./PanSelectControl";
import { CanvasTools } from "./CanvasTools";
import { SourceToolButton } from "./SourceTool";
import { usePointerHandCheck } from "../telemetry/dev-hooks";
import { Lines, ActorGlyph, Arrowhead } from "./SequencePrimitives";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type {
  SequenceLayoutResult,
  LayoutParticipant,
  LayoutMessage,
  LayoutFragment,
  LayoutActivation,
  LayoutNote,
} from "../layout/sequence-layout";
import {
  ACTIVATION_NEST_OFFSET,
  ACTIVATION_WIDTH,
  ACTOR_GLYPH_GAP,
  ACTOR_GLYPH_HEIGHT,
  ACTOR_GLYPH_WIDTH,
  BADGE_FONT,
  BADGE_HEIGHT,
  FRAGMENT_FONT,
  FRAGMENT_HEADER_HEIGHT,
  MESSAGE_FONT,
  MESSAGE_LINE_HEIGHT,
  NOTE_FOLD,
  NOTE_FONT,
  NOTE_LINE_HEIGHT,
  NOTE_PADDING_Y,
  PARTICIPANT_FONT,
  SELF_LABEL_GAP,
  SELF_LOOP_HEIGHT,
  SELF_LOOP_WIDTH,
} from "../layout/sequence-layout";
import { estimateTextWidth, type TypefaceId } from "../layout/text-measure";
import { focusOpacity } from "./focus-style";
import { useHelp } from "../app/HelpOverlay";
import { COARSE_POINTER_QUERY, useMediaQuery } from "../app/media";
import { useCanvasShortcuts } from "./canvas-shortcuts";
import { OffscreenCue } from "./OffscreenCue";
import {
  drawnOn,
  editorDiagramKey,
  frameClearOfChrome,
  measureFloating,
  hitsAny,
  measureChrome,
  measureNotice,
  sequenceObstacles,
} from "./chrome-clearance";
import { useCompileNoticeUp } from "./notice-context";
import {
  NO_OVERFLOW,
  tooSmallToRead,
  fitPadding,
  frameViewport,
  overflowOf,
  readingZoom,
  revealShift,
  sameOverflow,
  showAllZoom,
  uncoveredArea,
  type Box,
  type CoveredAt,
  type Overflow,
  type Padding,
  type ZoomRange,
} from "./viewport-fit";
import { markRouteReady } from "./route-ready";
import {
  EMPHASIS_MEMBER_CLASS,
  emphasisMembership,
  travelOrder,
  type Emphasis,
  type EmphasisAssignment,
} from "../emphasis/contract";
import { EmphasisChevrons, parkedAt } from "../emphasis/EmphasisChevrons";
import { EmphasisMarker } from "../emphasis/EmphasisMarker";
import { useEmphasisSurface } from "../emphasis/surface";
import { directionForKey } from "./keyboard-nav";
import { SvgPinRow, svgPinRowWidth } from "./CommentPins";
import type { CanvasPin, CommentedElements } from "./xflow-adapter";
import { FitGlyph, HelpGlyph, ZoomInGlyph, ZoomOutGlyph } from "./ControlGlyphs";
import {
  messageAccessibleName,
  messageBox,
  noteAccessibleName,
  revealPanZoom,
  sequenceMove,
  sequenceStopId,
  targetBox,
  type SequenceChannel,
  type SequenceTarget,
} from "./sequence-nav";

export type SequenceFocus = {
  participantIds?: string[];
  messageIds?: string[];
};

/**
 * What the user has selected, in the graph canvas's own shape: participants
 * are `nodeIds` and messages are `edgeIds` (see `sequence-selection.ts`).
 */
export type SequenceSelection = {
  readonly nodeIds?: readonly string[];
  readonly edgeIds?: readonly string[];
};

/** Lifeline kept in view under a message whose label opens: about one message row, to draw the next. */
const NEXT_MESSAGE_ROOM = 56;

/** The host's framing instruction; `key` changes once per instruction. */
export type SequenceViewportRequest = {
  readonly mode: "fit-all" | "fit-focus" | "preserve";
  readonly key: number;
};

export type PanZoomState = {
  x: number;
  y: number;
  scale: number;
};

/** The box a framing is computed for: where the drawing starts and how big it is. */
type Extent = {
  readonly originX?: number;
  readonly originY?: number;
  readonly width: number;
  readonly height: number;
};

/** Where the canvas sits before it has a box to measure. */
export const INITIAL_PAN_ZOOM: PanZoomState = { x: 20, y: 20, scale: 1 };

/** Breathing room kept between the diagram and every edge of the container. */
export const FIT_GUTTER_PX = 20;

/**
 * The scales a framing chooses on its own: the policy every canvas keeps
 * (`READING_TEXT_PX` in `viewport-fit.ts`), held to a sequence diagram's
 * smallest reading text -- a fragment's condition, at 11px, a pixel under a
 * message. The reader can still zoom further either way by hand; this only
 * bounds what the canvas does unasked.
 */
export const SEQUENCE_READING: ZoomRange = readingZoom("sequence");

/** How far the reader may zoom by hand. An explicit fit is not bound by it. */
const MIN_SCALE = 0.1;
const MAX_SCALE = 3;

/**
 * The scale a hand zoom by `factor` arrives at.
 *
 * Held inside the hand-zoom limits -- widened to where the camera already is.
 * `1` and the fit control show the whole diagram however small that makes it
 * (`fitPanZoom` has no floor), and from a fit at 0.04 a plain clamp to 0.1
 * made "zoom out" magnify by 2.5x and "zoom in" jump the same distance.
 */
export function zoomedScale(scale: number, factor: number): number {
  const floor = Math.min(MIN_SCALE, scale);
  return Math.max(floor, Math.min(MAX_SCALE, scale * factor));
}
const ZOOM_STEP = 1.25;
const DEFAULT_REQUEST: SequenceViewportRequest = { mode: "fit-all", key: 0 };

/** Stable "nothing is drawn where the cue could be", so the cue is not re-placed for a fresh empty list. */
const NOTHING_DRAWN: readonly Box[] = [];

/** The SVG transform for a pan/zoom state, applied to the inner viewport group. */
export function viewportTransform(panZoom: PanZoomState): string {
  return `translate(${panZoom.x} ${panZoom.y}) scale(${panZoom.scale})`;
}

const GUTTERS: Padding = {
  top: FIT_GUTTER_PX,
  right: FIT_GUTTER_PX,
  bottom: FIT_GUTTER_PX,
  left: FIT_GUTTER_PX,
};

/**
 * The room a framing must leave clear on each side of the canvas.
 *
 * The gutter, and -- while a legend is up -- its corner as well. The legend rests at
 * the canvas's bottom left, beside the toolbar, not at the diagram, so framing to the
 * whole box is what drives the last participant underneath it. The size of the
 * reservation, and its cap on a narrow canvas, are the graph canvas's own
 * (`fitPadding`): it is the same panel in the same corner.
 */
export function sequenceFitPadding(
  canvas: { readonly width: number; readonly height: number },
  reserveLegend: boolean,
): Padding {
  if (!reserveLegend) {
    return GUTTERS;
  }
  const reserved = fitPadding(canvas, true);
  return {
    ...GUTTERS,
    left: Math.max(FIT_GUTTER_PX, reserved.left),
    bottom: Math.max(FIT_GUTTER_PX, reserved.bottom),
  };
}

function available(
  viewport: { readonly width: number; readonly height: number },
  padding: Padding,
): {
  width: number;
  height: number;
} {
  return {
    width: viewport.width - padding.left - padding.right,
    height: viewport.height - padding.top - padding.bottom,
  };
}

/**
 * Frames `layout` within `zooms`, by the policy every canvas keeps
 * (`frameViewport`): centred across, from the top down, and from its start --
 * the first participant, the first message -- on an axis that does not fit.
 *
 * Pure, and over numbers only, because the component cannot be trusted to
 * report a box under test: jsdom performs no layout. The component measures;
 * this decides.
 *
 * A box that cannot hold its own gutters is not a viewport yet (an unmeasured
 * or hidden container), and an empty layout has nothing to frame; both give
 * back the initial framing rather than an infinite or negative scale.
 */
function frameWithin(
  layout: Extent,
  viewport: { readonly width: number; readonly height: number },
  padding: Padding,
  zooms: ZoomRange,
): PanZoomState {
  const box = available(viewport, padding);
  if (box.width <= 0 || box.height <= 0 || layout.width <= 0 || layout.height <= 0) {
    return INITIAL_PAN_ZOOM;
  }
  const content = { x: layout.originX ?? 0, y: layout.originY ?? 0, width: layout.width, height: layout.height };
  const frame = frameViewport(content, viewport, padding, zooms);
  return { x: frame.x, y: frame.y, scale: frame.zoom };
}

/**
 * The framing that shows the whole diagram: the explicit fit, and a fit on
 * the host's focus. As small as that takes, and never larger than the
 * diagram reads at (`SEQUENCE_READING.max`): every size in a sequence layout
 * is absolute, and a three-participant diagram blown up to fill the window
 * looks broken rather than fitted.
 */
export function fitPanZoom(
  layout: Extent,
  viewport: { readonly width: number; readonly height: number },
  padding: Padding = GUTTERS,
): PanZoomState {
  return frameWithin(layout, viewport, padding, showAllZoom(SEQUENCE_READING));
}

/**
 * The framing the canvas opens on.
 *
 * The whole diagram when it fits at a size that reads. A sequence diagram is
 * as long as its conversation, though, and fitting forty messages into one
 * screen makes all forty illegible -- so at `SEQUENCE_READING.min` it stops
 * shrinking and starts at the top left, where a sequence is read from.
 */
export function framePanZoom(
  layout: Extent,
  viewport: { readonly width: number; readonly height: number },
  padding: Padding = GUTTERS,
): PanZoomState {
  return frameWithin(layout, viewport, padding, SEQUENCE_READING);
}

/**
 * What a camera leaves outside the canvas, in this notation's own units.
 *
 * A sequence diagram grows two ways and each has its own thing to count:
 * across, it has more PARTICIPANTS; down, it has more MESSAGES. A message
 * between two participants that are off to the right is not a thing "to the
 * right", and a participant's box is not a thing "below" -- so the two lists
 * are kept apart (see `overflowOf`). A box that is not a viewport yet makes no
 * claim.
 */
export function sequenceOverflow(
  layout: SequenceLayoutResult,
  panZoom: PanZoomState,
  viewport: { readonly width: number; readonly height: number },
): readonly Overflow[] {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return NO_OVERFLOW;
  }
  return overflowOf(
    { x: layout.originX, y: layout.originY, width: layout.width, height: layout.height },
    { across: layout.participants, down: layout.messages.map((message) => messageBox(message)) },
    { x: panZoom.x, y: panZoom.y, zoom: panZoom.scale },
    viewport,
  );
}

/** The box around the focused messages and participants, or `null` for none. */
function focusExtent(layout: SequenceLayoutResult, focus: SequenceFocus | undefined): Extent | null {
  const messageIds = new Set(focus?.messageIds ?? []);
  const participantIds = new Set(focus?.participantIds ?? []);
  const messages = layout.messages.filter((m) => messageIds.has(m.id));
  const participants = layout.participants.filter((p) => participantIds.has(p.id));
  if (messages.length === 0 && participants.length === 0) {
    return null;
  }

  const MARGIN = 48;
  const xs = [...messages.flatMap((m) => [m.fromX, m.toX]), ...participants.flatMap((p) => [p.x, p.x + p.width])];
  // Focused participants alone have no rows of their own: frame their columns
  // over the whole height.
  const ys =
    messages.length > 0
      ? messages.flatMap((m) => [m.y - m.lines.length * MESSAGE_LINE_HEIGHT, m.y])
      : [layout.originY, layout.originY + layout.height];
  const minX = Math.min(...xs) - MARGIN;
  const minY = Math.min(...ys) - MARGIN;
  return {
    originX: minX,
    originY: minY,
    width: Math.max(...xs) + MARGIN - minX,
    height: Math.max(...ys) + MARGIN - minY,
  };
}

/**
 * How far a press may wander and still be a click.
 *
 * A drag pans and a click selects, and both begin with the same pointerdown.
 * Below this the pointer has only jittered -- a trackpad tap routinely moves a
 * pixel or two -- and treating that as a drag would make selection miss at
 * random. At or past it the gesture is a pan and the click that ends it is
 * swallowed.
 */
const DRAG_THRESHOLD_PX = 4;

/**
 * Sequence diagrams hold NO colours of their own.
 *
 * They used to: a `COLORS` object carrying a light slate palette, drawn on the
 * dark graph canvas. Two canvases, two visual languages, and the sequence one
 * barely legible on its own background. It is deleted -- every colour now
 * comes from the one shared token set, applied through these classes in
 * `src/styles.css`, so the component cannot disagree with the theme.
 *
 * Classes rather than inline `style`: SVG presentation attributes are not CSS
 * values, so `fill="var(--x)"` never resolves, and routing every colour
 * through the stylesheet leaves nowhere for a local palette to reappear.
 */
const SEQ_CLASS = {
  participant: "archer-seq-participant",
  lifeline: "archer-seq-lifeline",
  message: "archer-seq-message",
  fragment: "archer-seq-fragment",
  activation: "archer-seq-activation",
  /** An annotation, with a separate comments-only button when comments are available. */
  note: "archer-seq-note",
  /** Wears the pointer: its own class, so `:hover` on a 1.5px line is not the test. */
  hover: "archer-seq-hover",
  selected: "archer-seq-selected",
  /** The keyboard is here. A third state, drawn apart from the other two. */
  kbdFocus: "archer-seq-kbd-focus",
  selectable: "archer-seq-selectable",
} as const;

/** What one drawn participant or message needs to know about the user. */
type Interaction = {
  readonly hovered: boolean;
  readonly selected: boolean;
  /** Wears the keyboard ring. */
  readonly ring: boolean;
  /**
   * `0` on the one element of its ring in the tab order, `-1` on the rest, and
   * `null` when the canvas has no handlers at all -- in which case nothing is
   * focusable and nothing is called a button. `button` and `aria-pressed` are
   * claims about a control that works; a canvas rendered with nothing
   * listening must not make them (the graph canvas learnt this on the
   * last-valid drawing under an error banner).
   */
  readonly tabIndex: 0 | -1 | null;
};

/**
 * What the AGENT is saying about one drawn participant or message.
 *
 * A separate value from `Interaction`, and separate classes (`archer-emph-*`),
 * because it is a separate voice: hover, selection and the keyboard ring are
 * the reader's, and nothing here may stand in for any of them.
 */
type Marks = {
  readonly assignment: EmphasisAssignment;
  /** In the group a legend row is isolating right now. */
  readonly member: boolean;
  /** Place in the group's journey, in the order the diagram reads. */
  readonly hop: number;
  readonly hops: number;
  /** Draw the group's number on it (the reader's Group numbers). */
  readonly numbered: boolean;
};

/** The emphasis classes one element wears: the group's own, plus membership. */
function emphasisClasses(marks: Marks | null): readonly string[] {
  return marks === null ? [] : [...marks.assignment.classes, ...(marks.member ? [EMPHASIS_MEMBER_CLASS] : [])];
}

/**
 * Emphasis classes are APPENDED, never substituted: the element goes on saying
 * what the reader did to it, and the stylesheet can address the two voices
 * apart.
 */
function stateClasses(base: string, interaction: Interaction, marks: Marks | null = null): string {
  return [
    base,
    ...(interaction.tabIndex === null ? [] : [SEQ_CLASS.selectable]),
    ...(interaction.hovered ? [SEQ_CLASS.hover] : []),
    ...(interaction.selected ? [SEQ_CLASS.selected] : []),
    ...(interaction.ring ? [SEQ_CLASS.kbdFocus] : []),
    ...emphasisClasses(marks),
  ].join(" ");
}

/**
 * The attributes that make a drawn element a target: which ring it is in and
 * which model id it carries (read back by the delegated handlers), and -- only
 * when the canvas is interactive -- the button contract.
 *
 * `button` + `aria-pressed`, as on the graph canvas and for its reasons: this
 * is an activatable control that Enter and Space operate, and `aria-pressed`
 * says whether it is in the selection.
 */
function targetAttributes(
  channel: SequenceChannel,
  id: string,
  name: string,
  interaction: Interaction,
): Record<string, string | number | boolean> {
  const identity = { "data-seq-channel": channel, "data-seq-id": id };
  if (interaction.tabIndex === null) {
    return identity;
  }
  return {
    ...identity,
    role: "button",
    "aria-label": name,
    "aria-pressed": interaction.selected,
    tabIndex: interaction.tabIndex,
  };
}

const MESSAGE_KIND_WORDS: Readonly<Record<LayoutMessage["kind"], string>> = {
  sync: "Call",
  reply: "Reply",
  async: "Asynchronous message",
};

/**
 * What a message's drawing says beyond its name, in words (rubric G10): its kind (the arrow's line
 * and head), each fragment branch it sits in, outermost first, and the activation bar it starts or
 * ends. Read from the layout's geometry, which is where those facts are drawn: a fragment section
 * holds the messages between its divider and the next, and a bar starts at the message that caused
 * it and ends at the last message on that lifeline before `deactivate`.
 */
export function messageFacts(
  message: LayoutMessage,
  layout: Pick<SequenceLayoutResult, "participants" | "fragments" | "activations">,
): string {
  const labelOf = (id: string): string => layout.participants.find((p) => p.id === id)?.label || id;
  const facts = [
    message.bidirectional === true ? `${MESSAGE_KIND_WORDS[message.kind]}, two-way` : MESSAGE_KIND_WORDS[message.kind],
  ];
  for (const fragment of layout.fragments) {
    if (message.y <= fragment.y || message.y >= fragment.y + fragment.height) continue;
    let index = 0;
    fragment.sections.forEach((section, i) => {
      if (section.y <= message.y) index = i;
    });
    const label = fragment.sections[index]?.label ?? (index === 0 ? fragment.label : undefined);
    const branch = fragment.sections.length > 1 ? `, branch ${index + 1} of ${fragment.sections.length}` : "";
    facts.push(`In ${fragment.kind}${label ? ` [${label}]` : ""}${branch}`);
  }
  for (const bar of layout.activations) {
    if (bar.startY === message.y && bar.participantId === message.to)
      facts.push(`Activates ${labelOf(bar.participantId)}`);
  }
  for (const bar of layout.activations) {
    if (
      bar.endY === message.y &&
      bar.endY > bar.startY &&
      (bar.participantId === message.from || bar.participantId === message.to)
    ) {
      facts.push(`Ends ${labelOf(bar.participantId)}’s activation`);
    }
  }
  return facts.map((fact) => `${fact}.`).join(" ");
}

/** Message kind selects a class; the stylesheet owns what that class looks
 *  like. Kept alongside the dash pattern and the arrowhead, so colour is never
 *  the only channel distinguishing a reply from a call. */
function messageClass(kind: LayoutMessage["kind"]): string {
  return `${SEQ_CLASS.message} ${SEQ_CLASS.message}--${kind}`;
}

function hasFocus(focus: SequenceFocus | undefined): boolean {
  if (!focus) return false;
  const pCount = focus.participantIds?.length ?? 0;
  const mCount = focus.messageIds?.length ?? 0;
  return pCount > 0 || mCount > 0;
}

/** How far inside the box the keyboard ring sits. */
const RING_INSET = 3;

/**
 * A note: a sheet with a turned-down corner, the text on it.
 *
 * The sheet keeps its note semantics; a comments-only button wraps it when available.
 * Participant/message targetOf deliberately excludes notes from selection.
 */
function NoteSheet(props: { note: LayoutNote; name: string; dimmed: boolean }): JSX.Element {
  const { note, name, dimmed } = props;
  const right = note.x + note.width;
  const bottom = note.y + note.height;
  const cx = note.x + note.width / 2;
  const lastBaseline = note.y + NOTE_PADDING_Y + note.lines.length * NOTE_LINE_HEIGHT - 4;
  const shown = note.lines.join(" ");

  return (
    // biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: an SVG <g> is not interactive; role="note" names the drawn note for assistive technology.
    <g className={SEQ_CLASS.note} role="note" aria-label={name} opacity={focusOpacity(dimmed)}>
      {shown === note.text ? null : <title>{note.text}</title>}
      <path
        className="archer-seq-note-sheet"
        d={`M ${note.x} ${note.y} H ${right - NOTE_FOLD} L ${right} ${note.y + NOTE_FOLD} V ${bottom} H ${note.x} Z`}
        strokeWidth={1}
        strokeLinejoin="round"
      />
      <path
        className="archer-seq-note-fold"
        d={`M ${right - NOTE_FOLD} ${note.y} V ${note.y + NOTE_FOLD} H ${right}`}
        strokeWidth={1}
        strokeLinejoin="round"
      />
      <text x={cx} y={lastBaseline} textAnchor="middle" fontSize={NOTE_FONT}>
        <Lines lines={note.lines} x={cx} lastBaseline={lastBaseline} lineHeight={NOTE_LINE_HEIGHT} />
      </text>
    </g>
  );
}

function ParticipantBox(props: {
  participant: LayoutParticipant;
  /** The face the layout sized this box for. */
  typeface: TypefaceId | undefined;
  dimmed: boolean;
  interaction: Interaction;
  marks: Marks | null;
  /** Some comment thread is about it: said after its name, as on a graph node. */
  commented?: boolean;
}): JSX.Element {
  const { participant, typeface, dimmed, interaction, marks } = props;

  const cx = participant.x + participant.width / 2;
  const cy = participant.y + participant.height / 2;
  const lineHeight = 15;
  const shown = participant.lines.join(" ");
  const actor = participant.kind === "actor";
  // An actor's figure and its name are centred in the box as one unit, the
  // figure first. The name's slot is the layout's own (bold) estimate of it.
  const textWidth = actor
    ? Math.max(0, ...participant.lines.map((line) => estimateTextWidth(line, PARTICIPANT_FONT, true, typeface)))
    : 0;
  const glyphX = cx - (ACTOR_GLYPH_WIDTH + ACTOR_GLYPH_GAP + textWidth) / 2;
  const textX = actor ? glyphX + ACTOR_GLYPH_WIDTH + ACTOR_GLYPH_GAP + textWidth / 2 : cx;
  // The figure is drawn, so it is said: the name is the label, then the kind.
  const name = `${participant.label || participant.id}${actor ? ", actor" : ""}${emphasisMembership(marks?.assignment)}${props.commented === true ? COMMENTED_SUFFIX : ""}`;

  return (
    <g
      opacity={focusOpacity(dimmed)}
      className={stateClasses(SEQ_CLASS.participant, interaction, marks)}
      {...targetAttributes("participants", participant.id, name, interaction)}
    >
      {shown === participant.label ? null : <title>{participant.label}</title>}
      {/* The selection glow. `--node-shadow-selected` is a `box-shadow`, which
          SVG does not have, so the same ring is drawn as a wide translucent
          stroke of the same accent, under the box. */}
      {interaction.selected ? (
        <rect
          className="archer-seq-participant-halo"
          x={participant.x}
          y={participant.y}
          width={participant.width}
          height={participant.height}
          rx={6}
        />
      ) : null}
      <rect
        className="archer-seq-participant-box"
        x={participant.x}
        y={participant.y}
        width={participant.width}
        height={participant.height}
        rx={6}
        strokeWidth={1.5}
      />
      {/* Keyboard focus is an INSET ring, as on a graph node: selection fills
          the body and glows outside it, so the two can be read together. */}
      {interaction.ring ? (
        <rect
          className="archer-seq-participant-ring"
          x={participant.x + RING_INSET}
          y={participant.y + RING_INSET}
          width={participant.width - RING_INSET * 2}
          height={participant.height - RING_INSET * 2}
          rx={4}
        />
      ) : null}
      {actor ? <ActorGlyph x={glyphX} y={cy - ACTOR_GLYPH_HEIGHT / 2} /> : null}
      <text
        x={textX}
        y={cy + ((participant.lines.length - 1) * lineHeight) / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={PARTICIPANT_FONT}
        fontWeight={600}
      >
        <Lines
          lines={participant.lines}
          x={textX}
          lastBaseline={cy + ((participant.lines.length - 1) * lineHeight) / 2}
          lineHeight={lineHeight}
        />
      </text>
      {marks?.numbered === true ? (
        <EmphasisMarker slot={marks.assignment.slot} x={participant.x} y={participant.y} />
      ) : null}
    </g>
  );
}

/**
 * A participant's lifeline: part of the participant, for the pointer.
 *
 * It lights up with its box and selects its participant, because in a long
 * diagram the box is the first thing to scroll off and the lifeline is all
 * that is left of the column. The second, invisible line is the target -- a
 * 1px dashed line cannot be hit. It carries the participant's id but no role
 * and no tab stop: the box is the one control, this is more of its surface.
 */
function Lifeline(props: {
  participant: LayoutParticipant;
  endY: number;
  dimmed: boolean;
  interaction: Interaction;
  marks: Marks | null;
}): JSX.Element {
  const { participant, endY, dimmed, interaction, marks } = props;
  const cx = participant.x + participant.width / 2;
  const line = { x1: cx, y1: participant.y + participant.height, x2: cx, y2: endY };

  return (
    <>
      <line
        className={stateClasses(SEQ_CLASS.lifeline, { ...interaction, ring: false, tabIndex: null }, marks)}
        data-seq-lifeline={participant.id}
        {...line}
        strokeWidth={1}
        strokeDasharray="6 4"
        opacity={focusOpacity(dimmed)}
      />
      {interaction.tabIndex === null ? null : (
        <line
          className="archer-seq-lifeline-hit"
          data-seq-channel="participants"
          data-seq-id={participant.id}
          {...line}
          strokeWidth={14}
          strokeOpacity={0}
        />
      )}
    </>
  );
}

/** Reply is dashed; sync and async are solid and differ by arrowhead. */
function dashFor(kind: LayoutMessage["kind"]): string | undefined {
  return kind === "reply" ? "6 3" : undefined;
}

/** Padding of the plate a selected message's label sits on. */
const PLATE_PAD_X = 7;
const PLATE_PAD_Y = 3;

/**
 * How wide a message's label is ONCE SELECTED.
 *
 * Not `message.labelWidth`: that is the regular-weight width the layout
 * reserved, and a selected label is drawn bold. A plate cut to the regular
 * width let the bold text run over both of its ends.
 */
function boldLabelWidth(message: LayoutMessage, typeface: TypefaceId | undefined): number {
  return Math.max(0, ...message.lines.map((line) => estimateTextWidth(line, MESSAGE_FONT, true, typeface)));
}

/**
 * The `id` of the path a message's packet travels.
 *
 * Namespaced, so it cannot collide with anything else in the document, and
 * built from a message id -- which the parser generates (`msg-N`) and no
 * author chooses.
 */
function routeId(messageId: string): string {
  return `archer-seq-route-${messageId}`;
}

/** What a screen reader hears after a commented participant's or message's name, as on a graph. */
const COMMENTED_SUFFIX = ", has comments";

/**
 * Where a message's pins start: just past the right end of its label's plate,
 * on the plate's middle, or above the arrow's middle when it has no label.
 */
function messagePinAnchor(message: LayoutMessage, typeface: TypefaceId | undefined): { x: number; y: number } {
  const self = message.from === message.to;
  const plateWidth = boldLabelWidth(message, typeface) + PLATE_PAD_X * 2;
  if (self) {
    return {
      x: message.fromX + SELF_LOOP_WIDTH + SELF_LABEL_GAP - PLATE_PAD_X + plateWidth + 4,
      y: message.y + SELF_LOOP_HEIGHT / 2,
    };
  }
  const midX = (message.fromX + message.toX) / 2;
  if (message.lines.length === 0) return { x: midX + 4, y: message.y - 14 };
  const labelHeight = message.lines.length * MESSAGE_LINE_HEIGHT;
  const plateTop = message.y - 7 + 3 - labelHeight - PLATE_PAD_Y;
  return { x: midX + plateWidth / 2 + 4, y: plateTop + (labelHeight + PLATE_PAD_Y * 2) / 2 };
}

/** The box a sequence name or message is typed into: wide enough to read, tall enough for a few wrapped lines. */
const LABEL_EDITOR_WIDTH = 260;
const LABEL_EDITOR_HEIGHT = 96;

function MessageArrow(props: {
  message: LayoutMessage;
  /** The face the layout measured this label in. */
  typeface: TypefaceId | undefined;
  /** "Client to Server: POST /login" -- see `messageAccessibleName`. */
  name: string;
  dimmed: boolean;
  interaction: Interaction;
  marks: Marks | null;
  /** Its text is being typed in place: the drawn label (and its plate) stand aside for the box. */
  renaming?: boolean;
  /** `messageFacts`: read out as the message's description. */
  facts?: string;
}): JSX.Element {
  const { message, typeface, name, dimmed, interaction, marks } = props;
  const factsId = useId();
  const described = props.facts !== undefined && interaction.tabIndex !== null;
  const { fromX, toX, y } = message;
  const open = message.kind !== "sync";
  const wrapped = message.label !== undefined && message.lines.join(" ") !== message.label.replace(/\n/g, " ");
  const title = wrapped ? <title>{message.label}</title> : null;
  const self = message.from === message.to;
  const hasLabel = message.lines.length > 0 && props.renaming !== true;

  const loopRight = fromX + SELF_LOOP_WIDTH;
  const returnY = y + SELF_LOOP_HEIGHT;
  const direction = toX > fromX ? 1 : -1;
  const midX = (fromX + toX) / 2;
  const lastBaseline = y - 7;
  const labelHeight = message.lines.length * MESSAGE_LINE_HEIGHT;

  // Where the label is drawn, as a box: the plate a selected message's text
  // sits on.
  const plateWidth = boldLabelWidth(message, typeface) + PLATE_PAD_X * 2;
  const plate = self
    ? {
        x: loopRight + SELF_LABEL_GAP - PLATE_PAD_X,
        y: y + SELF_LOOP_HEIGHT / 2 - labelHeight / 2 - PLATE_PAD_Y,
        width: plateWidth,
        height: labelHeight + PLATE_PAD_Y * 2,
      }
    : {
        x: midX - plateWidth / 2,
        y: lastBaseline + 3 - labelHeight - PLATE_PAD_Y,
        width: plateWidth,
        height: labelHeight + PLATE_PAD_Y * 2,
      };
  // Drawn FROM the sender TO the receiver, which is what makes a packet on it
  // travel the way the message does.
  const route = self ? `M ${fromX} ${y} H ${loopRight} V ${returnY} H ${fromX}` : `M ${fromX} ${y} H ${toX}`;
  const routePoints = self
    ? [
        { x: fromX, y },
        { x: loopRight, y },
        { x: loopRight, y: returnY },
        { x: fromX, y: returnY },
      ]
    : [
        { x: fromX, y },
        { x: toX, y },
      ];
  const hit = messageBox(message);
  const flow = marks !== null && marks.assignment.style === "flow";

  return (
    <g
      opacity={focusOpacity(dimmed)}
      className={stateClasses(messageClass(message.kind), interaction, marks)}
      {...targetAttributes("messages", message.id, name, interaction)}
      {...(described ? { "aria-describedby": factsId } : {})}
    >
      {title}
      {described ? <desc id={factsId}>{props.facts}</desc> : null}
      {/* The pointer target: the arrow AND its label, as one generous box. The
          arrow is a 1.5px line; nobody can be asked to hit that. */}
      <rect className="archer-seq-hit" x={hit.x} y={hit.y} width={hit.width} height={hit.height} />
      {/* Selection plates the label the way a selected graph edge's caption is
          plated: accent fill, accent rule. */}
      {interaction.selected && hasLabel ? <rect className="archer-seq-message-plate" {...plate} rx={4} /> : null}
      {/* Keyboard focus is a HALO under the arrow, as on a graph edge: a band
          of its own, so the stroke above it is still free to say hovered or
          selected. A band rather than only a blur, because a blur of a
          1.5px dashed reply is too faint to find. */}
      {/* The route a flow message's moving arrows ride: an id, and no paint. */}
      {marks !== null && flow ? (
        // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a decorative SVG part with no tabindex, never focusable; biome misreads SVG elements as focusable.
        <path className="archer-seq-emph-route" id={routeId(message.id)} d={route} fill="none" aria-hidden="true" />
      ) : null}
      {interaction.ring ? <path className="archer-seq-message-ring" d={route} /> : null}
      {/* The arrow in a group of its own, so the halo's glow can be put on
          the line and its head without smearing the label. */}
      <g className="archer-seq-message-stroke">
        {self ? (
          <path
            d={route}
            fill="none"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeDasharray={dashFor(message.kind)}
          />
        ) : (
          <line x1={fromX} y1={y} x2={toX} y2={y} strokeWidth={1.5} strokeDasharray={dashFor(message.kind)} />
        )}
        {self ? (
          <Arrowhead tipX={fromX} y={returnY} direction={-1} open={open} />
        ) : (
          <Arrowhead tipX={toX} y={y} direction={direction} open={open} />
        )}
        {/* A two-way message (`<<->>`, `<<-->>`) has a head at the sender too. */}
        {message.bidirectional === true ? (
          <Arrowhead tipX={fromX} y={y} direction={self ? -1 : direction === 1 ? -1 : 1} open={open} />
        ) : null}
      </g>
      {/* The autonumber badge, centred on the start of the arrow (the choice is
          argued on `badgeWidthFor`). Hidden from assistive technology: the
          number is already the first thing in the message's name. */}
      {message.number !== undefined && message.badgeWidth !== undefined ? (
        // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a decorative SVG part with no tabindex, never focusable; biome misreads SVG elements as focusable.
        <g className="archer-seq-message-number" aria-hidden="true">
          <rect
            x={fromX - message.badgeWidth / 2}
            y={y - BADGE_HEIGHT / 2}
            width={message.badgeWidth}
            height={BADGE_HEIGHT}
            rx={BADGE_HEIGHT / 2}
          />
          <text x={fromX} y={y} textAnchor="middle" dominantBaseline="central" fontSize={BADGE_FONT} fontWeight={600}>
            {message.number}
          </text>
        </g>
      ) : null}
      {hasLabel && self ? (
        <text
          x={loopRight + SELF_LABEL_GAP}
          y={y + SELF_LOOP_HEIGHT / 2}
          fontSize={MESSAGE_FONT}
          dominantBaseline="central"
        >
          {/* Every line, centred on the loop as the painter does. */}
          <Lines
            lines={message.lines}
            x={loopRight + SELF_LABEL_GAP}
            lastBaseline={y + SELF_LOOP_HEIGHT / 2 + ((message.lines.length - 1) * MESSAGE_LINE_HEIGHT) / 2}
            lineHeight={MESSAGE_LINE_HEIGHT}
          />
        </text>
      ) : null}
      {hasLabel && !self ? (
        <text x={midX} y={lastBaseline} textAnchor="middle" fontSize={MESSAGE_FONT}>
          <Lines lines={message.lines} x={midX} lastBaseline={lastBaseline} lineHeight={MESSAGE_LINE_HEIGHT} />
        </text>
      ) : null}
      {/* The group's number, on the arrow's middle and clear of its label (ADR 0030, "Group numbers"). */}
      {marks?.numbered === true
        ? (() => {
            const at = parkedAt(routePoints, 0.5, hasLabel ? plate : undefined);
            return <EmphasisMarker slot={marks.assignment.slot} x={at.x} y={at.y} />;
          })()
        : null}
      {/* Last, so it travels over the arrow and its badge. */}
      {marks !== null && flow && marks.assignment.speed !== null ? (
        <EmphasisChevrons
          edgeId={message.id}
          twoWay={message.bidirectional === true}
          avoid={hasLabel ? plate : undefined}
          pathId={routeId(message.id)}
          speed={marks.assignment.speed}
          hop={marks.hop}
          hops={marks.hops}
          route={routePoints}
        />
      ) : null}
    </g>
  );
}

/**
 * A fragment is drawn in TWO layers, and this is the lower one: the frame and
 * its section dividers, background to everything.
 *
 * Its words are `FragmentHeader`, painted after the lifelines. As one group,
 * drawn first, a lifeline and its activation bar ran straight through the
 * header text -- "[Auth|rised]".
 */
function FragmentFrame(props: { fragment: LayoutFragment; commentable?: boolean }): JSX.Element {
  const { fragment } = props;

  return (
    <g className={SEQ_CLASS.fragment}>
      <rect x={fragment.x} y={fragment.y} width={fragment.width} height={fragment.height} strokeWidth={1} rx={5} />
      {props.commentable ? (
        <rect
          className="archer-seq-fragment-border-hit"
          data-seq-channel="fragments"
          data-seq-id={fragment.id}
          x={fragment.x}
          y={fragment.y}
          width={fragment.width}
          height={fragment.height}
          rx={5}
          fill="none"
          stroke="transparent"
          strokeWidth={24}
          vectorEffect="non-scaling-stroke"
          pointerEvents="stroke"
        />
      ) : null}
      {fragment.sections.slice(1).map((section, i) => (
        <line
          // biome-ignore lint/suspicious/noArrayIndexKey: the position is the identity here (fixed-length or ordered parts drawn from one layout), and the items hold no state.
          key={i}
          x1={fragment.x}
          y1={section.y}
          x2={fragment.x + fragment.width}
          y2={section.y}
          className="archer-seq-fragment-divider"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      ))}
    </g>
  );
}

/** The kind chip, the header label and the section labels of one fragment. */
function FragmentHeader(props: {
  fragment: LayoutFragment;
  commentable?: boolean;
  commented?: boolean;
  hitHeight?: number;
}): JSX.Element {
  const { fragment } = props;
  const headerMid = fragment.y + FRAGMENT_HEADER_HEIGHT / 2 - 1;
  const chipHeight = FRAGMENT_HEADER_HEIGHT - 6;

  return (
    <g className="archer-seq-fragment-header">
      <g
        className={`archer-seq-block-header${props.commented ? " archer-commented" : ""}`}
        {...(props.commentable
          ? {
              "data-seq-channel": "fragments",
              "data-seq-id": fragment.id,
              role: "button",
              tabIndex: 0,
              "aria-label": `${fragment.kind} block: ${fragment.label}${props.commented ? COMMENTED_SUFFIX : ""}`,
              "aria-description": "Comment on this whole block. Press C, Enter or the context-menu key.",
            }
          : {})}
      >
        {props.commentable ? (
          <rect
            className="archer-seq-fragment-header-hit"
            x={fragment.x}
            y={fragment.y}
            width={fragment.width}
            height={props.hitHeight ?? FRAGMENT_HEADER_HEIGHT}
            fill="transparent"
            stroke="none"
            pointerEvents="all"
            rx={5}
          />
        ) : null}
        {fragment.headerLabel === `[${fragment.label}]` ? null : <title>{fragment.label}</title>}
        {/* Kind chip, tucked into the frame's top-left corner */}
        <rect
          x={fragment.x}
          y={fragment.y}
          width={fragment.chipWidth}
          height={chipHeight}
          className="archer-seq-fragment-chip"
          rx={5}
        />
        <text
          x={fragment.x + fragment.chipWidth / 2}
          y={fragment.y + chipHeight / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={FRAGMENT_FONT}
          fontWeight={700}
          className="archer-seq-fragment-chip-text"
        >
          {fragment.kind}
        </text>
        {fragment.label && (
          <text
            x={fragment.x + fragment.chipWidth + 8}
            y={headerMid}
            dominantBaseline="central"
            fontSize={FRAGMENT_FONT}
            className="archer-seq-fragment-label"
          >
            {fragment.headerLabel}
          </text>
        )}
      </g>
      {fragment.sections.slice(1).map((section, i) =>
        section.label ? (
          <text
            // biome-ignore lint/suspicious/noArrayIndexKey: the position is the identity here (fixed-length or ordered parts drawn from one layout), and the items hold no state.
            key={i}
            x={fragment.x + 10}
            y={section.y + 13}
            fontSize={FRAGMENT_FONT}
            className="archer-seq-fragment-label"
          >
            [{section.label}]
          </text>
        ) : null,
      )}
    </g>
  );
}

function ActivationBar(props: {
  activation: LayoutActivation;
  centerX: number;
  dimmed: boolean;
  /** Its participant is in the group a legend row is isolating. */
  member: boolean;
}): JSX.Element {
  const { activation, centerX, dimmed, member } = props;
  const x = centerX + activation.depth * ACTIVATION_NEST_OFFSET - ACTIVATION_WIDTH / 2;

  return (
    <rect
      className={member ? `${SEQ_CLASS.activation} ${EMPHASIS_MEMBER_CLASS}` : SEQ_CLASS.activation}
      x={x}
      y={activation.startY}
      width={ACTIVATION_WIDTH}
      height={Math.max(activation.endY - activation.startY, 6)}
      strokeWidth={1}
      opacity={focusOpacity(dimmed)}
      rx={2}
    />
  );
}

const NO_IDS: readonly string[] = [];

/**
 * The participant or message an event started on, or `null` for anything else:
 * a fragment frame, an activation bar, the bare canvas.
 *
 * Read off the DOM rather than closed over per element, so one handler on the
 * canvas serves every target (the graph canvas's `targetOf`, and for its
 * reason: no handler identity per element, per render).
 */
function targetOf(target: EventTarget | null): SequenceTarget | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const element = target.closest("[data-seq-id]");
  const channel = element?.getAttribute("data-seq-channel");
  const id = element?.getAttribute("data-seq-id");
  if (id === null || id === undefined || (channel !== "participants" && channel !== "messages")) {
    return null;
  }
  return { channel, id };
}

function sameTarget(a: SequenceTarget | null, b: SequenceTarget | null): boolean {
  return a === b || (a !== null && b !== null && a.channel === b.channel && a.id === b.id);
}

type Ghost =
  | { kind: "draw"; from: string; x: number; y: number }
  | { kind: "message"; id: string; mode: "source" | "target" | "move"; x: number; y: number };

/** The message being drawn, re-ended or moved, under the pointer: it alone re-renders as the pointer moves. */
function GestureGhost(props: {
  subscribe: (sink: (ghost: Ghost | null) => void) => () => void;
  participants: readonly LayoutParticipant[];
  messages: readonly LayoutMessage[];
}): JSX.Element | null {
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const { subscribe } = props;
  useLayoutEffect(() => subscribe(setGhost), [subscribe]);
  if (ghost === null) return null;
  if (ghost.kind === "draw") {
    // The message being drawn: from its lifeline to the pointer, and the row it will take.
    const from = props.participants.find((p) => p.id === ghost.from);
    if (from === undefined) return null;
    const x1 = from.x + from.width / 2;
    const to = nearestLifeline(props.participants, ghost.x);
    const target = props.participants.find((p) => p.id === to);
    const x2 = target !== undefined && to !== ghost.from ? target.x + target.width / 2 : ghost.x;
    const head = x2 >= x1 ? -1 : 1;
    return (
      <g className="archer-seq-draw-ghost" pointerEvents="none">
        <line x1={x1} x2={x2} y1={ghost.y} y2={ghost.y} />
        <path d={`M${x2 + head * 9} ${ghost.y - 5} L${x2} ${ghost.y} L${x2 + head * 9} ${ghost.y + 5}`} fill="none" />
      </g>
    );
  }
  const message = props.messages.find((m) => m.id === ghost.id);
  if (message === undefined) return null;
  if (ghost.mode === "move") {
    const left = Math.min(message.fromX, message.toX),
      right = Math.max(message.fromX, message.toX, left + 40);
    return (
      <g className="archer-seq-draw-ghost" pointerEvents="none">
        <line x1={left} x2={right} y1={ghost.y} y2={ghost.y} />
      </g>
    );
  }
  const fixed = ghost.mode === "source" ? message.toX : message.fromX;
  const to = nearestLifeline(props.participants, ghost.x);
  const target = props.participants.find((p) => p.id === to);
  const x = target !== undefined ? target.x + target.width / 2 : ghost.x;
  return (
    <g className="archer-seq-draw-ghost" pointerEvents="none">
      <line x1={fixed} x2={x} y1={message.y} y2={message.y} />
      <circle cx={x} cy={message.y} r={6} />
    </g>
  );
}

/** The participant whose lifeline is closest to `x`. */
export function nearestLifeline(participants: readonly LayoutParticipant[], x: number): string | null {
  let best: string | null = null,
    distance = Infinity;
  for (const p of participants) {
    const d = Math.abs(p.x + p.width / 2 - x);
    if (d < distance) {
      distance = d;
      best = p.id;
    }
  }
  return best;
}

/** The first message drawn below `y`, other than `skip` (null when none): a message dropped at `y` goes before it. */
export function messageBelow(messages: readonly LayoutMessage[], y: number, skip: string): string | null {
  let below: LayoutMessage | null = null;
  for (const message of messages)
    if (message.id !== skip && message.y > y && (below === null || message.y < below.y)) below = message;
  return below?.id ?? null;
}

/** The last message drawn above `y` (null when none): a new message drawn at `y` goes below it. */
export function messageAbove(messages: readonly LayoutMessage[], y: number): string | null {
  let above: LayoutMessage | null = null;
  for (const message of messages) if (message.y < y && (above === null || message.y > above.y)) above = message;
  return above?.id ?? null;
}

/**
 * Where a participant dragged sideways by `dx` lands: the participant it would stand before
 * (null for last), the x of the gap it drops into, and whether that differs from where it is.
 */
export function reorderSlot(
  participants: readonly LayoutParticipant[],
  id: string,
  dx: number,
): { before: string | null; x: number; changed: boolean } {
  const index = participants.findIndex((p) => p.id === id);
  const self = participants[index];
  if (self === undefined) return { before: null, x: 0, changed: false };
  const centre = self.x + self.width / 2 + dx;
  const others = participants.filter((p) => p.id !== id);
  const at = others.findIndex((p) => centre < p.x + p.width / 2);
  const before = at === -1 ? null : others[at]!.id;
  const originalBefore = participants[index + 1]?.id ?? null;
  const left = at === -1 ? others.at(-1) : at === 0 ? undefined : others[at - 1];
  const right = at === -1 ? undefined : others[at];
  const x =
    right === undefined
      ? left
        ? left.x + left.width + 16
        : self.x
      : left === undefined
        ? right.x - 16
        : (left.x + left.width + right.x) / 2;
  return { before, x, changed: before !== originalBefore };
}

/**
 * How far to pan (screen px) so the drawn `target` is clear of everything over the canvas -- a point is
 * covered when it is off the canvas or the topmost thing there is not the drawing -- or `null` when it is
 * clear already, or the page cannot be hit-tested (jsdom). The browser's own scroll of the clipped canvas
 * to show a Tab-focused element is undone first, as on the graph canvas (`coveredFocus`).
 */
function clearOfCover(
  container: HTMLElement | null,
  target: SequenceTarget | SVGElement,
): { dx: number; dy: number } | null {
  if (container === null || typeof document.elementFromPoint !== "function") return null;
  const svg = container.querySelector("svg.archer-seq-svg");
  const element =
    target instanceof SVGElement
      ? target
      : [...container.querySelectorAll<SVGElement>("[data-seq-id][tabindex]")].find((at) =>
          sameTarget(targetOf(at), target),
        );
  if (svg === null || element === undefined) return null;
  for (let at: Element | null = element.parentElement; at !== null && container.contains(at); at = at.parentElement) {
    if (at.scrollLeft !== 0) at.scrollLeft = 0;
    if (at.scrollTop !== 0) at.scrollTop = 0;
  }
  if (container.scrollLeft !== 0) container.scrollLeft = 0;
  if (container.scrollTop !== 0) container.scrollTop = 0;
  const rect = container.getBoundingClientRect();
  const drawn = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0 || (drawn.width === 0 && drawn.height === 0)) return null;
  const covered: CoveredAt = (x, y) => {
    if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) return true;
    const hit = document.elementFromPoint(x, y);
    return hit === null || !svg.contains(hit);
  };
  const canvas = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  return revealShift(
    { x: drawn.left, y: drawn.top, width: drawn.width, height: drawn.height },
    uncoveredArea(canvas, covered),
    covered,
  );
}

export function SequenceCanvas(props: {
  /**
   * Keep the legend's corner free whenever the view has emphasis sets, not
   * only while one is drawn: turning a dataflow on or off then never moves
   * the drawing under the reader.
   */
  reserveLegendRoom?: boolean;
  primaryShell?: boolean;
  layout: SequenceLayoutResult;
  focus?: SequenceFocus;
  /** The host's framing instruction. Omitted means "show all of it" once. */
  viewport?: SequenceViewportRequest;
  selection?: SequenceSelection;
  /**
   * The agent's emphasis for this view, or `null` for none. Participants are
   * its `nodes` and messages its `edges`, as they are for a selection.
   */
  emphasis?: Emphasis | null;
  /**
   * What comment threads are about, and their pins: participants as nodes,
   * messages as edges, as for a selection (`CommentPins.tsx`).
   */
  commented?: CommentedElements;
  /** Whole-block comments are available only when the host supports comments. This never adds fragments to selection. */
  blockComments?: boolean;
  /** Activates a whole-block composer, independently of participant/message selection. */
  onBlockComment?: (fragmentId: string) => void;
  /** A note is a comment target only, independent of published selection. */
  onNoteComment?: (noteId: string) => void;
  /**
   * The handlers the graph canvas calls, by the same names, because they ARE
   * the same handlers: a participant is selected as a node and a message as an
   * edge (`sequence-selection.ts`), so `App` passes one set to both canvases.
   * `additive` is Shift, on a click and on Enter/Space alike.
   *
   * With none of them the canvas is a picture: nothing is focusable and
   * nothing claims to be a button.
   */
  onNodeClick?: (participantId: string, additive: boolean) => void;
  onEdgeClick?: (messageId: string, additive: boolean) => void;
  /** A click that landed on no participant and no message. */
  onPaneClick?: () => void;
  tools?: ReactNode;
  /** Extra buttons in the canvas control cluster (the editor's undo, redo, delete). */
  controls?: ReactNode;
  /**
   * Editing: dragging a participant's header left or right reorders it. Called on drop with
   * the participant it now stands before (`null` for last); never for a drop in place.
   */
  onParticipantMove?: (participantId: string, before: string | null) => void;
  /**
   * Editing: a drag from one lifeline to another draws a message between them. `after` is the
   * message it goes below (null: first), chosen by where the drag was released.
   */
  onMessageDraw?: (from: string, to: string, after: string | null) => void;
  /** Editing: double-click asks to rename a participant or a message; the field is typed in place. */
  onLabelEdit?: (channel: "participants" | "messages", id: string) => void;
  editingLabel?: { readonly channel: "participants" | "messages"; readonly id: string } | null;
  onLabelCommit?: (channel: "participants" | "messages", id: string, text: string) => void;
  onLabelClose?: () => void;
  /** Editing: a selected message's end dragged onto another lifeline. */
  onMessageRetarget?: (id: string, end: "source" | "target", participant: string) => void;
  /** Editing: a selected message dragged up or down, to stand before `before` (null: last). */
  onMessageMove?: (id: string, before: string | null) => void;
  /** Editing: a note or a block (fragment) clicked; `edit` on a double-click. Notes and blocks are picked here, apart from selection. */
  onPartClick?: (kind: "note" | "fragment", id: string, edit: boolean) => void;
  /** Editing: the note or block picked now, outlined. */
  selectedPart?: string | null;
  /** Filled here: switches the canvas from Hand to Select (the editor's parts bar calls it). */
  selectMode?: { current: (() => void) | null };
}): JSX.Element {
  const { layout, focus, onNodeClick, onEdgeClick, onPaneClick } = props;
  const interactive = onNodeClick !== undefined || onEdgeClick !== undefined;
  const coarsePointer = useMediaQuery(COARSE_POINTER_QUERY);
  const blockComments = props.blockComments === true;
  const request = props.viewport ?? DEFAULT_REQUEST;
  const containerRef = useRef<HTMLDivElement>(null);
  const [panZoom, setPanZoom] = useState<PanZoomState>(INITIAL_PAN_ZOOM);
  // Pins follow the visible part of their annotation's header when an overlay panel expands
  // after the reader has moved the camera. Moving a pin along that header must not reframe the drawing.
  const [pinRoom, setPinRoom] = useState<{
    width: number;
    obstacles: readonly Edges[];
  } | null>(null);
  const hasAnnotationPins =
    (props.commented?.groupPins?.size ?? 0) > 0 ||
    layout.notes.some((note) => (props.commented?.nodePins?.get(note.id)?.length ?? 0) > 0);
  useLayoutEffect(() => {
    const canvas = containerRef.current;
    if (!canvas || !hasAnnotationPins || typeof ResizeObserver === "undefined") return;
    const selector = ".archer-diagram-panel, .archer-diagram-key, .archer-canvas-controls, .archer-canvas-tools";
    const update = () => {
      const box = canvas.getBoundingClientRect();
      if (!box.width) return;
      const next = {
        width: box.width,
        obstacles: [...document.querySelectorAll(selector)].flatMap((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width && rect.height
            ? [
                {
                  left: rect.left - box.left,
                  right: rect.right - box.left,
                  top: rect.top - box.top,
                  bottom: rect.bottom - box.top,
                },
              ]
            : [];
        }),
      };
      setPinRoom((previous) =>
        previous?.width === next.width &&
        previous.obstacles.length === next.obstacles.length &&
        previous.obstacles.every((box, i) => {
          const other = next.obstacles[i]!;
          return (
            box.left === other.left && box.right === other.right && box.top === other.top && box.bottom === other.bottom
          );
        })
          ? previous
          : next,
      );
    };
    const frame = layoutFrame(update);
    update();
    // ResizeObserver already batches size delivery, and pins must move before its paint.
    const stop = observeLayoutElements(selector, frame.schedule, { fixed: [canvas], resized: update });
    return () => {
      frame.cancel();
      stop();
    };
  }, [hasAnnotationPins]);

  // The camera as last rendered, for the one caller that has to decide
  // something from it outside a state updater (`reveal`).
  const annotationPinX = (
    annotation: { x: number; y: number; width: number },
    pins: readonly CanvasPin[] | undefined,
  ): number => {
    const original = annotation.x + annotation.width - 8;
    if (!pinRoom || !pins?.length) return original;
    const hitSize = (coarsePointer ? 44 : 24) / panZoom.scale;
    const width = svgPinRowWidth(pins, hitSize) * panZoom.scale;
    const y = annotation.y * panZoom.scale + panZoom.y;
    const halfHeight = Math.max(30 * panZoom.scale, coarsePointer ? 44 : 24) / 2;
    let free = [
      {
        left: Math.max(8, annotation.x * panZoom.scale + panZoom.x),
        right: Math.min(pinRoom.width - 8, original * panZoom.scale + panZoom.x),
      },
    ];
    for (const obstacle of pinRoom.obstacles) {
      if (obstacle.bottom <= y - halfHeight || obstacle.top >= y + halfHeight) continue;
      free = free
        .flatMap((room) =>
          obstacle.right <= room.left || obstacle.left >= room.right
            ? [room]
            : [
                { left: room.left, right: Math.min(room.right, obstacle.left - 8) },
                { left: Math.max(room.left, obstacle.right + 8), right: room.right },
              ],
        )
        .filter((room) => room.right - room.left >= width);
    }
    const right = Math.max(...free.filter((room) => room.right - room.left >= width).map((room) => room.right));
    return Number.isFinite(right) ? (right - panZoom.x) / panZoom.scale : original;
  };
  const panZoomRef = useRef(panZoom);
  panZoomRef.current = panZoom;
  const [isPanning, setIsPanning] = useState(false);
  const editable = props.onParticipantMove !== undefined || props.onMessageDraw !== undefined;
  const [pointerMode, setPointerMode] = useState<PointerMode>(() => (editable ? "select" : DEFAULT_POINTER_MODE));
  // Editing can be switched on after the canvas mounts (access is checked first): select mode then, or every drag pans.
  useEffect(() => {
    if (editable) setPointerMode("select");
  }, [editable]);
  // A part picked from the editor's parts bar: back to Select from Hand.
  useEffect(() => {
    const slot = props.selectMode;
    if (!slot) return;
    slot.current = () => setPointerMode("select");
    return () => {
      slot.current = null;
    };
  }, [props.selectMode]);
  // Dev builds: an editable canvas must not be left in hand mode (`ui.edit.pointer-hand`).
  // biome-ignore lint/correctness/useHookAtTopLevel: __ARCHER_DEBUG__ is a build-time constant (vite define), so the hook order never changes within a build.
  if (__ARCHER_DEBUG__) usePointerHandCheck("sequence canvas", editable, pointerMode);
  // A participant header being dragged sideways: its id and how far, in diagram units.
  const reorderRef = useRef<{ id: string; startX: number } | null>(null);
  const [reorder, setReorder] = useState<{ id: string; dx: number } | null>(null);
  // A message being drawn from a lifeline: where it starts and where the pointer is, in diagram units.
  const drawRef = useRef<{ from: string; y: number } | null>(null);
  const drawingRef = useRef<{ from: string; x: number; y: number } | null>(null);
  // A selected message being re-ended (one end dragged sideways) or moved (dragged up or down).
  const messageDragRef = useRef<{
    id: string;
    mode: "source" | "target" | "move";
    startX: number;
    startY: number;
  } | null>(null);
  // The pointer's place in a draw or message drag reaches only the ghost (GestureGhost), not this canvas: one
  // render of the whole diagram per pointer move was the editor's render storm while drawing. The canvas itself
  // re-renders when such a gesture starts and ends (`ghosting`).
  const ghostSink = useRef<((ghost: Ghost | null) => void) | null>(null);
  const [ghosting, setGhosting] = useState<{ kind: "draw" } | { kind: "message"; id: string } | null>(null);
  const subscribeGhost = useCallback((sink: (ghost: Ghost | null) => void) => {
    ghostSink.current = sink;
    return () => {
      if (ghostSink.current === sink) ghostSink.current = null;
    };
  }, []);
  const showGhost = (ghost: Ghost | null): void => {
    ghostSink.current?.(ghost);
    setGhosting((current) =>
      ghost === null
        ? null
        : ghost.kind === "draw"
          ? current?.kind === "draw"
            ? current
            : { kind: "draw" }
          : current?.kind === "message" && current.id === ghost.id
            ? current
            : { kind: "message", id: ghost.id },
    );
  };
  const messageDragNow = useRef<{ id: string; mode: "source" | "target" | "move"; x: number; y: number } | null>(null);
  const reorderingRef = useRef<{ id: string; dx: number } | null>(null);
  const toDiagram = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = containerRef.current?.getBoundingClientRect();
    const view = panZoomRef.current;
    return {
      x: (clientX - (rect?.left ?? 0) - view.x) / view.scale,
      y: (clientY - (rect?.top ?? 0) - view.y) / view.scale,
    };
  };
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  // Whether the press in progress (or the one just ended) became a pan. Read
  // by the click that follows it, which must then select nothing.
  const draggedRef = useRef(false);
  // What the pointer is over. State rather than `:hover`, because a
  // participant is two elements -- its box and its lifeline -- that are not
  // nested and must light up together.
  const [hovered, setHovered] = useState<SequenceTarget | null>(null);
  /*
   * WHERE THE KEYBOARD IS: two rings, two stops, as on the graph canvas.
   *
   * Participants rove among participants and messages among messages, so a
   * diagram of any size has exactly two tab stops. Each ring remembers where
   * the user left it (`focused*Id` outlives the canvas losing focus);
   * `focusedChannel` is what the visible ring follows and is null whenever
   * focus is outside the canvas, so a ring is never painted on something no
   * key can act on.
   *
   * Unlike a React Flow edge, these elements are ours and keyed by id: React
   * keeps the same `<g>` across every re-render, so focus is never dropped by
   * a redraw and there is no restore-from-`body` observer here to get wrong.
   */
  const [focusedParticipantId, setFocusedParticipantId] = useState<string | null>(null);
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const [focusedChannel, setFocusedChannel] = useState<SequenceChannel | null>(null);
  // Whether the reader has taken the camera since the canvas last framed
  // itself. A resize re-frames only while they have not.
  const userMovedRef = useRef(false);
  // What the framing in force left off screen, for the cue. Set by every
  // framing the canvas does itself and emptied the moment the reader takes
  // the camera: from then on the view is theirs, and it has nothing to add.
  const [overflow, setOverflow] = useState<readonly Overflow[]>(NO_OVERFLOW);
  const reportOverflow = useCallback((next: readonly Overflow[]): void => {
    setOverflow((previous) => (sameOverflow(previous, next) ? previous : next));
  }, []);
  // Whether the framing in force shows ALL of the diagram at a size too small
  // to read. An explicit fit kept its promise; this is the rest of the truth
  // about it, and the cue says so (`OffscreenCue`). A participant's name is
  // drawn at a node label's size, so the graph canvas's threshold is this
  // one's too.
  const [overview, setOverview] = useState(false);
  /** The reader moved the camera: it is theirs, and the cue goes. */
  const takeCamera = useCallback((): void => {
    userMovedRef.current = true;
    reportOverflow(NO_OVERFLOW);
    setOverview(false);
  }, [reportOverflow]);
  const appliedKeyRef = useRef<number | null>(null);
  const help = useHelp();
  // Isolation, reduced motion and the legend: the graph canvas's own surface.
  const nameOf = useMemo(() => {
    const participants = new Map(
      layout.participants.map((participant) => [participant.id, participant.label.trim() || participant.id]),
    );
    const messages = new Map(
      layout.messages.map((message) => {
        const ends = `${participants.get(message.from) ?? message.from} → ${participants.get(message.to) ?? message.to}`;
        const text = message.lines.join(" ");
        return [message.id, text ? `“${text}” (${ends})` : ends];
      }),
    );
    return (id: string, channel: "nodes" | "edges") => (channel === "nodes" ? participants : messages).get(id) ?? id;
  }, [layout.participants, layout.messages]);
  // The legend's member list takes the reader to a member. Its camera and focus
  // helpers are defined further down, so the legend calls through this ref.
  const revealMemberRef = useRef<(id: string, channel: "nodes" | "edges") => void>(() => {});
  const onReveal = useCallback((id: string, channel: "nodes" | "edges") => revealMemberRef.current(id, channel), []);
  const surface = useEmphasisSurface(props.emphasis, "sequence", { nameOf, onReveal });
  const { assignments, isolated } = surface.render;
  const journey = useMemo(
    () =>
      travelOrder(
        assignments.edges,
        layout.messages.map((message) => message.id),
      ),
    [assignments, layout.messages],
  );

  /** What the agent says about one participant or message, or `null`. */
  const marksFor = (channel: SequenceChannel, id: string): Marks | null => {
    const key = channel === "participants" ? "nodes" : "edges";
    const assignment = assignments[key].get(id);
    if (assignment === undefined) {
      return null;
    }
    const place = journey.get(id) ?? { hop: assignment.hop, hops: assignment.hops };
    return {
      assignment,
      member: isolated?.[key].has(id) === true,
      ...place,
      numbered: surface.render.numbered,
    };
  };

  const focusActive = hasFocus(focus);
  const focusedParticipantIds = new Set(focus?.participantIds ?? []);
  const focusedMessageIds = new Set(focus?.messageIds ?? []);
  const messageFactsById = useMemo(
    () => new Map(layout.messages.map((message) => [message.id, messageFacts(message, layout)])),
    [layout],
  );
  const selectedParticipantIds = useMemo(() => new Set(props.selection?.nodeIds ?? NO_IDS), [props.selection]);
  const selectedMessageIds = useMemo(() => new Set(props.selection?.edgeIds ?? NO_IDS), [props.selection]);

  const participantStopId = sequenceStopId(layout.participants, focusedParticipantId);
  const messageStopId = sequenceStopId(layout.messages, focusedMessageId);

  /** Everything the drawing needs to know about one target and the user. */
  const interactionFor = (channel: SequenceChannel, id: string): Interaction => {
    const stopId = channel === "participants" ? participantStopId : messageStopId;
    return {
      // Not while panning: the diagram is sliding under a pointer that is
      // holding the canvas, not pointing at anything on it.
      hovered: !isPanning && hovered !== null && hovered.channel === channel && hovered.id === id,
      selected: (channel === "participants" ? selectedParticipantIds : selectedMessageIds).has(id),
      ring: focusedChannel === channel && stopId === id,
      tabIndex: !interactive ? null : stopId === id ? 0 : -1,
    };
  };

  /*
   * WHERE PRESENTATION FOCUS AND SELECTION MEET: a selected element is never
   * dimmed by focus.
   *
   * Focus is the host's framing and selection is the user's own claim, and
   * opacity is one property that only one of them can have. At
   * `DIMMED_OPACITY` the accent fill and the plate drop to a quarter strength
   * and the user cannot see what they just selected -- nor what will be sent
   * to the agent on their behalf. Everything they did NOT select still dims,
   * so the framing still reads.
   *
   * ...AND EMPHASIS: an emphasised element is never dimmed by focus either, on
   * this canvas as on the graph (`dimmedBy` in `xflow-adapter.ts`, where the
   * rule is argued). Dimmed to a quarter strength the agent's ring would be a
   * claim the tool reported as published and nobody could see.
   */
  const dimmedFor = (focused: boolean, selected: boolean, emphasised = false): boolean =>
    focusActive && !focused && !selected && !emphasised;

  const participantCenterXMap = new Map<string, number>();
  for (const p of layout.participants) {
    participantCenterXMap.set(p.id, p.x + p.width / 2);
  }

  const measure = useCallback((): { width: number; height: number } => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  }, []);

  const reserveLegend = !surface.docked && (surface.hasLegend || (props.reserveLegendRoom ?? false));

  // Everything this diagram draws, in its own coordinates: what a framing
  // keeps out from under the controls, and what the cue stays off.
  const obstacles = useMemo(() => sequenceObstacles(layout), [layout]);

  /**
   * Applies a framing with room left for the chrome (`frameClearOfChrome`):
   * `frameWith` is the framing wanted for a given padding, `reports` whether
   * what it leaves off screen is to be said, and `showsAll` whether it is the
   * reader's explicit fit of the whole diagram, which has no floor.
   */
  const applyFraming = useCallback(
    (
      frameWith: (box: { width: number; height: number }, padding: Padding) => PanZoomState,
      reports: boolean,
      showsAll = false,
    ) => {
      const box = measure();
      const container = containerRef.current;
      const framed = frameClearOfChrome<PanZoomState>({
        base: sequenceFitPadding(box, reserveLegend),
        controls: measureChrome(container, container?.parentElement?.querySelector(".archer-canvas-controls") ?? null),
        floating: measureFloating(container),
        canvas: box,
        notice: measureNotice(container),
        frameWith: (padding) => frameWith(box, padding),
        overflowOf: (next) => (reports ? sequenceOverflow(layout, next, box) : NO_OVERFLOW),
        hits: (next, rect) => hitsAny(drawnOn(obstacles, { x: next.x, y: next.y, zoom: next.scale }), rect),
        // The band is kept for the overview cue too: see `OffscreenCue`.
        cueFor: (next) => showsAll && tooSmallToRead(next.scale),
      });
      userMovedRef.current = false;
      setPanZoom(framed.frame);
      reportOverflow(framed.overflow);
      setOverview(showsAll && framed.overflow.length === 0 && tooSmallToRead(framed.frame.scale));
    },
    [layout, obstacles, measure, reserveLegend, reportOverflow],
  );

  /** Frame as the host asked: the focus when it named one, else the diagram. */
  const frame = useCallback(
    (mode: SequenceViewportRequest["mode"]) => {
      const focused = mode === "fit-focus" ? focusExtent(layout, focus) : null;
      // A framing on the host's focus leaves the rest off screen on purpose.
      applyFraming(
        (box, padding) => (focused ? fitPanZoom(focused, box, padding) : framePanZoom(layout, box, padding)),
        focused === null,
      );
    },
    [layout, focus, applyFraming],
  );

  // Latest `frame` for the effects below, which must not re-run (and re-frame)
  // merely because a live reload produced a new layout object.
  const frameRef = useRef(frame);
  frameRef.current = frame;

  useLayoutEffect(() => {
    const first = appliedKeyRef.current === null;
    if (appliedKeyRef.current === request.key) {
      return;
    }
    appliedKeyRef.current = request.key;
    // `preserve` means "leave the camera" -- except on mount, when there is no
    // camera position to preserve yet.
    if (request.mode === "preserve" && !first) {
      return;
    }
    frameRef.current(request.mode === "preserve" ? "fit-all" : request.mode);
    // Drawn and framed: the sequence page's route-ready point (performance rubric S7).
    if (first) markRouteReady("sequence");
  }, [request.key, request.mode]);

  // The canvas box changes under the diagram -- the window resizes, the tab
  // strip arrives after first paint. Follow it, unless the reader has moved.
  const modeRef = useRef(request.mode);
  modeRef.current = request.mode;
  useEffect(() => {
    const element = containerRef.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const key = editorDiagramKey(element);
    let seen = false;
    const observer = new ResizeObserver(() => {
      // The mount effect already measured the canvas. The editor's sibling key can expand after that framing.
      if (!seen) {
        seen = true;
        if (key === null) return;
      }
      if (!userMovedRef.current) {
        frameRef.current(modeRef.current === "preserve" ? "fit-all" : modeRef.current);
      }
    });
    observer.observe(element);
    if (key !== null) observer.observe(key);
    return () => observer.disconnect();
  }, []);

  // The legend's corner appearing or going is the box changing too: the room
  // a framing may use is not what it was. Followed on the same terms as a
  // resize -- only while the reader has not taken the camera.
  // The compile notice arriving or going is the same kind of change.
  const noticeUp = useCompileNoticeUp();
  const reservedRef = useRef({ legend: reserveLegend, notice: noticeUp });
  useEffect(() => {
    if (reservedRef.current.legend === reserveLegend && reservedRef.current.notice === noticeUp) {
      return;
    }
    reservedRef.current = { legend: reserveLegend, notice: noticeUp };
    if (!userMovedRef.current) {
      frameRef.current(modeRef.current === "preserve" ? "fit-all" : modeRef.current);
    }
  }, [reserveLegend, noticeUp]);

  const zoomAbout = useCallback(
    (factor: number, point?: { x: number; y: number }) => {
      const box = measure();
      const anchor = point ?? { x: box.width / 2, y: box.height / 2 };
      takeCamera();
      setPanZoom((prev) => {
        const scale = zoomedScale(prev.scale, factor);
        const ratio = scale / prev.scale;
        // Keep the diagram point under the anchor where it is.
        return {
          scale,
          x: anchor.x - (anchor.x - prev.x) * ratio,
          y: anchor.y - (anchor.y - prev.y) * ratio,
        };
      });
    },
    [measure, takeCamera],
  );

  // A native listener, because React attaches `wheel` passively and a passive
  // listener cannot stop the page from scrolling or the browser from zooming.
  useEffect(() => {
    const element = containerRef.current;
    if (element === null) {
      return;
    }
    const onWheel = (e: globalThis.WheelEvent): void => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = element.getBoundingClientRect();
        zoomAbout(e.deltaY > 0 ? 0.9 : 1.1, { x: e.clientX - rect.left, y: e.clientY - rect.top });
        return;
      }
      takeCamera();
      setPanZoom((prev) => ({ ...prev, x: prev.x - e.deltaX, y: prev.y - e.deltaY }));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomAbout, takeCamera]);

  /*
   * ONE PRESS, TWO POSSIBLE GESTURES -- and exactly one of them happens.
   *
   * A press that travels is a pan; a press that does not is a click. The pan
   * therefore does not start on pointerdown, as it used to: it starts when the
   * pointer has moved `DRAG_THRESHOLD_PX`, and from that moment the click that
   * will follow the release is already spoken for (`draggedRef`).
   *
   * Pointer capture is taken only THEN, and that ordering matters. A captured
   * pointer's `click` is delivered to the capturing element, not to what was
   * under the pointer -- so capturing on pointerdown would make every click on
   * a participant arrive as a click on the canvas, i.e. as "clear the
   * selection". Capturing once the gesture is known to be a pan costs the pan
   * nothing and leaves a plain click's target alone.
   */
  // Whether a pointer is down. A focus that arrives then is a click's, and the
  // thing clicked is by definition already on screen.
  const pointerDownRef = useRef(false);

  const handlePointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0 && e.button !== 1) {
        return;
      }
      draggedRef.current = false;
      pointerDownRef.current = true;
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      // A press on a participant's header, while editing in select mode, may become a reorder.
      const header = e.target instanceof Element ? e.target.closest(`.${SEQ_CLASS.participant}`) : null;
      const target = header === null ? null : targetOf(e.target);
      reorderRef.current =
        props.onParticipantMove && pointerMode === "select" && e.button === 0 && target?.channel === "participants"
          ? { id: target.id, startX: e.clientX }
          : null;
      // A press on a selected message's end handle re-ends it; on the selected message itself, moves it.
      const handle = e.target instanceof Element ? e.target.closest<SVGElement>("[data-seq-end]") : null;
      const selectedMessage = props.selection?.edgeIds?.length === 1 ? props.selection.edgeIds[0] : undefined;
      const onMessage =
        target?.channel === "messages"
          ? target.id
          : targetOf(e.target)?.channel === "messages"
            ? targetOf(e.target)!.id
            : undefined;
      messageDragRef.current =
        pointerMode !== "select" || e.button !== 0
          ? null
          : handle !== null && props.onMessageRetarget
            ? {
                id: handle.dataset.seqMessage ?? "",
                mode: handle.dataset.seqEnd === "source" ? "source" : "target",
                startX: e.clientX,
                startY: e.clientY,
              }
            : props.onMessageMove && onMessage !== undefined && onMessage === selectedMessage
              ? { id: onMessage, mode: "move", startX: e.clientX, startY: e.clientY }
              : null;
      if (messageDragRef.current !== null) {
        reorderRef.current = null;
        drawRef.current = null;
        return;
      }
      // A press on a lifeline (below the header) starts drawing a message from it.
      const lifeline = e.target instanceof Element ? e.target.closest(".archer-seq-lifeline-hit") : null;
      const from = lifeline === null ? null : targetOf(e.target);
      drawRef.current =
        props.onMessageDraw && pointerMode === "select" && e.button === 0 && from?.channel === "participants"
          ? { from: from.id, y: toDiagram(e.clientX, e.clientY).y }
          : null;
    },
    [
      props.onParticipantMove,
      props.onMessageDraw,
      props.onMessageRetarget,
      props.onMessageMove,
      props.selection,
      pointerMode,
    ],
  );

  const handlePointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const last = lastPointerRef.current;
      if (last === null) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      const dragging = messageDragRef.current;
      if (dragging !== null) {
        if (
          !draggedRef.current &&
          Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) < DRAG_THRESHOLD_PX
        )
          return;
        if (!draggedRef.current) {
          draggedRef.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }
        const at = toDiagram(e.clientX, e.clientY);
        messageDragNow.current = { id: dragging.id, mode: dragging.mode, x: at.x, y: at.y };
        showGhost({ kind: "message", ...messageDragNow.current });
        return;
      }
      const draw = drawRef.current;
      if (draw !== null) {
        if (!draggedRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        if (!draggedRef.current) {
          draggedRef.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }
        const at = toDiagram(e.clientX, e.clientY);
        drawingRef.current = { from: draw.from, x: at.x, y: at.y };
        showGhost({ kind: "draw", ...drawingRef.current });
        return;
      }
      const moving = reorderRef.current;
      if (moving !== null) {
        const sideways = e.clientX - moving.startX;
        if (!draggedRef.current && Math.abs(sideways) < DRAG_THRESHOLD_PX) return;
        if (!draggedRef.current) {
          draggedRef.current = true;
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }
        reorderingRef.current = { id: moving.id, dx: sideways / panZoomRef.current.scale };
        setReorder(reorderingRef.current);
        return;
      }
      if (!draggedRef.current) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) {
          return;
        }
        draggedRef.current = true;
        setIsPanning(true);
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
      lastPointerRef.current = { x: e.clientX, y: e.clientY };
      takeCamera();
      setPanZoom((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
    },
    [takeCamera],
  );

  const handlePointerUp = useCallback(() => {
    setIsPanning(false);
    pointerDownRef.current = false;
    lastPointerRef.current = null;
    // Side effects stay out of state updaters (React may run those twice).
    const dragging = messageDragRef.current,
      dragged = messageDragNow.current;
    messageDragRef.current = null;
    messageDragNow.current = null;
    showGhost(null);
    if (dragging !== null && dragged !== null) {
      const message = layout.messages.find((m) => m.id === dragging.id);
      if (message !== undefined && dragging.mode === "move") {
        const before = messageBelow(layout.messages, dragged.y, message.id);
        const next = [...layout.messages].sort((a, b) => a.y - b.y);
        const currentBefore = next[next.indexOf(message) + 1]?.id ?? null;
        if (before !== currentBefore) props.onMessageMove?.(message.id, before);
      } else if (message !== undefined) {
        const to = nearestLifeline(layout.participants, dragged.x);
        const current = dragging.mode === "source" ? message.from : message.to;
        if (to !== null && to !== current)
          props.onMessageRetarget?.(message.id, dragging.mode === "move" ? "target" : dragging.mode, to);
      }
    }
    const draw = drawRef.current,
      drawn = drawingRef.current;
    drawRef.current = null;
    drawingRef.current = null;
    showGhost(null);
    if (draw !== null && drawn !== null) {
      const to = nearestLifeline(layout.participants, drawn.x);
      if (to !== null && to !== draw.from) props.onMessageDraw?.(draw.from, to, messageAbove(layout.messages, drawn.y));
    }
    const moving = reorderRef.current,
      moved = reorderingRef.current;
    reorderRef.current = null;
    reorderingRef.current = null;
    setReorder(null);
    if (moving !== null && moved !== null && moved.id === moving.id) {
      const slot = reorderSlot(layout.participants, moved.id, moved.dx);
      if (slot.changed) props.onParticipantMove?.(moved.id, slot.before);
    }
  }, [
    layout.participants,
    layout.messages,
    props.onParticipantMove,
    props.onMessageDraw,
    props.onMessageRetarget,
    props.onMessageMove,
  ]);

  // Escape during a drag (drawing, re-ending or moving a message, reordering a header) cancels it: nothing is
  // sent. So does a gesture the browser takes away (pointercancel) or the window losing focus mid-drag.
  const cancelGesture = useCallback((): void => {
    setIsPanning(false);
    pointerDownRef.current = false;
    lastPointerRef.current = null;
    messageDragRef.current = null;
    messageDragNow.current = null;
    drawRef.current = null;
    drawingRef.current = null;
    ghostSink.current?.(null);
    setGhosting(null);
    reorderRef.current = null;
    reorderingRef.current = null;
    setReorder(null);
  }, []);
  const gestureActive = reorder !== null || ghosting !== null;
  useEffect(() => {
    if (!gestureActive) return;
    const cancel = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cancelGesture();
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [gestureActive, cancelGesture]);
  useEffect(() => {
    window.addEventListener("blur", cancelGesture);
    return () => window.removeEventListener("blur", cancelGesture);
  }, [cancelGesture]);

  const commentOnBlock = useCallback(
    (block: Element) => {
      const id = block.getAttribute("data-seq-id");
      if (id !== null) {
        if (block.getAttribute("data-seq-channel") === "notes") props.onNoteComment?.(id);
        else props.onBlockComment?.(id);
      }
    },
    [props.onBlockComment, props.onNoteComment],
  );

  /**
   * The click, resolved here from the click's own target and modifier.
   *
   * ONE WRITER PER GESTURE: nothing else on this canvas forms an opinion about
   * what a click selected, so there is no second account to reconcile with the
   * one `App` holds -- the failure the graph canvas had with React Flow's
   * store cannot be built here. Whether the click ADDS is `event.shiftKey`,
   * as it is there.
   */
  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (draggedRef.current) {
        // The release of a pan. It selected nothing and it cleared nothing.
        draggedRef.current = false;
        return;
      }
      const block =
        e.target instanceof Element
          ? e.target.closest(".archer-seq-block-header[data-seq-id], .archer-seq-note-comment-target[data-seq-id]")
          : null;
      if (block !== null && blockComments && !editable) {
        commentOnBlock(block);
        return;
      }
      if (pointerMode === "hand") return;
      // A note or a block's header, while editing: picked for its own panel (text, delete, remove the block).
      const part = props.onPartClick && e.target instanceof Element ? e.target.closest("[data-seq-part]") : null;
      if (part !== null && targetOf(e.target) === null) {
        const kind = part.getAttribute("data-seq-part"),
          id = part.getAttribute("data-seq-part-id");
        if ((kind === "note" || kind === "fragment") && id) {
          props.onPartClick?.(kind, id, e.detail >= 2);
          return;
        }
      }
      const target = targetOf(e.target);
      if (target === null) {
        onPaneClick?.();
      } else if (target.channel === "participants") {
        onNodeClick?.(target.id, e.shiftKey);
      } else {
        onEdgeClick?.(target.id, e.shiftKey);
      }
    },
    [onNodeClick, onEdgeClick, onPaneClick, pointerMode, props.onPartClick, blockComments, editable, commentOnBlock],
  );

  const handlePointerOver = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const next = targetOf(e.target);
    // The same target again is the pointer crossing between two children of
    // one message; returning `prev` keeps React from re-rendering for it.
    setHovered((prev) => (sameTarget(prev, next) ? prev : next));
  }, []);

  const handlePointerLeave = useCallback(() => setHovered(null), []);

  /**
   * Pan, if need be, until `target` is on screen and clear of what lies over the canvas: the phone's review
   * sheet, a panel, the controls. Never zooms. Measured on the drawn element, as the graph canvas does
   * (`RevealCamera`): a participant Tab focused under the review sheet was left wholly under it (R3-13).
   */
  const reveal = useCallback(
    (target: SequenceTarget) => {
      const box = targetBox(layout, target);
      if (box === null) {
        return;
      }
      const viewport = measure();
      const clear = clearOfCover(containerRef.current, target);
      const next =
        clear === null
          ? revealPanZoom(panZoomRef.current, box, viewport)
          : { ...panZoomRef.current, x: panZoomRef.current.x + clear.dx, y: panZoomRef.current.y + clear.dy };
      if (next !== panZoomRef.current) {
        // The camera followed the user's own key; it is theirs now, and a
        // resize must not snap it back to the fitted framing.
        takeCamera();
        setPanZoom(next);
      }
    },
    [layout, measure, takeCamera],
  );

  // A message whose label opens -- the one just drawn, most often -- is brought into view with a row of
  // lifeline under it, so the next message can be drawn below without panning first (smoke-b#13:b: past
  // the 7th message the lifelines' ends ran off the canvas and "draw after the last" silently missed).
  const editingMessageId = props.editingLabel?.channel === "messages" ? props.editingLabel.id : null;
  const revealedEditing = useRef<string | null>(null);
  useEffect(() => {
    if (editingMessageId === null) {
      revealedEditing.current = null;
      return;
    }
    // Once per label opened (a later layout change must not drag the camera back), but only once the
    // message is in the layout: a freshly drawn one can open its label a render before it is drawn.
    if (revealedEditing.current === editingMessageId) return;
    const box = targetBox(layout, { channel: "messages", id: editingMessageId });
    if (box === null) return;
    revealedEditing.current = editingMessageId;
    const room = { ...box, height: box.height + NEXT_MESSAGE_ROOM };
    const next = revealPanZoom(panZoomRef.current, room, measure());
    if (next !== panZoomRef.current) {
      takeCamera();
      setPanZoom(next);
    }
  }, [editingMessageId, layout, measure, takeCamera]);

  const focusTarget = useCallback((target: SequenceTarget): void => {
    const elements = containerRef.current?.querySelectorAll<SVGElement>("[tabindex]");
    for (const element of elements ?? []) {
      // Matched in JS rather than with an attribute selector: a stable id is
      // author-supplied and can hold characters that would break one.
      if (sameTarget(targetOf(element), target)) {
        // The camera is moved by `reveal`, deliberately and minimally; the
        // browser's own scroll-into-view would fight it.
        element.focus({ preventScroll: true });
        return;
      }
    }
  }, []);

  revealMemberRef.current = (id: string, channel: "nodes" | "edges"): void => {
    const target: SequenceTarget = { channel: channel === "nodes" ? "participants" : "messages", id };
    if (target.channel === "participants") setFocusedParticipantId(id);
    else setFocusedMessageId(id);
    focusTarget(target);
    reveal(target);
  };

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>): void => {
      const block =
        e.target instanceof Element
          ? e.target.closest<SVGElement>(
              ".archer-seq-block-header[data-seq-id], .archer-seq-note-comment-target[data-seq-id]",
            )
          : null;
      if (block !== null && (e.key === "Enter" || e.key === " ") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (editable && props.onPartClick) {
          const id = block.getAttribute("data-seq-id");
          if (id !== null)
            props.onPartClick(block.getAttribute("data-seq-channel") === "notes" ? "note" : "fragment", id, false);
        } else commentOnBlock(block);
        return;
      }
      const from = targetOf(e.target);
      if (from === null) {
        return;
      }
      // A modified arrow belongs to the browser or the OS.
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }

      const direction = directionForKey(e.key);
      if (direction !== null) {
        // Prevented whether or not there is somewhere to go, so the page never
        // scrolls out from under a canvas the user is arrowing across.
        e.preventDefault();
        const next = sequenceMove(layout, from, direction, { messageId: focusedMessageId });
        if (next !== null) {
          if (next.channel === "participants") {
            setFocusedParticipantId(next.id);
          } else {
            setFocusedMessageId(next.id);
          }
          focusTarget(next);
          reveal(next);
        }
        return;
      }

      if (e.key === "Enter" || e.key === " ") {
        // Space is also the page's scroll key.
        e.preventDefault();
        // The SAME handler a click uses, so a keyboard selection reaches the
        // reducer and the host by exactly the route a pointer selection takes.
        if (from.channel === "participants") {
          onNodeClick?.(from.id, e.shiftKey);
        } else {
          onEdgeClick?.(from.id, e.shiftKey);
        }
      }
    },
    [
      layout,
      focusedMessageId,
      focusTarget,
      reveal,
      onNodeClick,
      onEdgeClick,
      editable,
      props.onPartClick,
      commentOnBlock,
    ],
  );

  const handleFocus = useCallback(
    (e: FocusEvent<HTMLDivElement>): void => {
      const from = targetOf(e.target);
      if (from === null) {
        const block =
          e.target instanceof Element
            ? e.target.closest<SVGElement>(
                ".archer-seq-block-header[data-seq-id], .archer-seq-note-comment-target[data-seq-id]",
              )
            : null;
        if (block === null || pointerDownRef.current) return;
        const isNote = block.getAttribute("data-seq-channel") === "notes";
        const fragment = (isNote ? layout.notes : layout.fragments).find(
          (item) => item.id === block.getAttribute("data-seq-id"),
        );
        if (fragment === undefined) return;
        const clear = clearOfCover(containerRef.current, block);
        const next =
          clear === null
            ? revealPanZoom(
                panZoomRef.current,
                {
                  x: fragment.x,
                  y: fragment.y,
                  width: fragment.width,
                  height: isNote ? fragment.height : FRAGMENT_HEADER_HEIGHT,
                },
                measure(),
              )
            : { ...panZoomRef.current, x: panZoomRef.current.x + clear.dx, y: panZoomRef.current.y + clear.dy };
        setFocusedChannel(null);
        if (next !== panZoomRef.current) {
          takeCamera();
          setPanZoom(next);
        }
        return;
      }
      // Covers the pointer too: clicking an element moves its ring's stop onto
      // it, so a user who switches to the keyboard carries on from there.
      if (from.channel === "participants") {
        setFocusedParticipantId(from.id);
      } else {
        setFocusedMessageId(from.id);
      }
      setFocusedChannel(from.channel);
      // Tab can land on a stop the camera has since left. A click cannot --
      // and panning under a pointer that is mid-press would move the target
      // out from under it.
      if (!pointerDownRef.current) {
        reveal(from);
      }
    },
    [reveal, layout.fragments, measure, takeCamera],
  );

  const handleBlur = useCallback((e: FocusEvent<HTMLDivElement>): void => {
    // A move between two targets reports the incoming one as `relatedTarget`
    // and must not take the ring off; only focus leaving the canvas does.
    if (e.currentTarget.contains(e.relatedTarget)) {
      return;
    }
    setFocusedChannel(null);
  }, []);

  /**
   * `1` means the same thing here as on the graph canvas: show me all of it.
   *
   * The measurement happens at the moment the key is pressed rather than being
   * tracked, because that is the only moment it is needed and the only moment
   * the container is certainly laid out.
   */
  const handleFit = useCallback(() => {
    // All of it, as the cue's Show all (AM-R1-02); when that is too small to read the canvas says so.
    applyFraming((box, padding) => fitPanZoom(layout, box, padding), true, true);
  }, [layout, applyFraming]);

  // The cue's "Show all": the overview, everything however small. When that is
  // too small to read the canvas says so and offers the way back.
  const handleShowAll = useCallback(() => {
    applyFraming((box, padding) => fitPanZoom(layout, box, padding), true, true);
  }, [layout, applyFraming]);

  // The way back from an overview too small to read: the framing the diagram
  // opens on, readable and from the top.
  const handleZoomToRead = useCallback(() => {
    applyFraming((box, padding) => framePanZoom(layout, box, padding), true);
  }, [layout, applyFraming]);

  // Where the drawing is on the canvas, for the cue to stay off. Only worked
  // out while there is a cue: the reader taking the camera clears `overflow`.
  const blocked = useMemo<readonly Box[]>(
    () =>
      overflow.length === 0 && !overview
        ? NOTHING_DRAWN
        : drawnOn(obstacles, { x: panZoom.x, y: panZoom.y, zoom: panZoom.scale }),
    [overflow, overview, obstacles, panZoom],
  );

  // The same hook the graph canvas uses, so the two cannot drift apart on the
  // guards that matter: a typing target, a modified `1`, or an open cheat
  // sheet.
  useCanvasShortcuts({ onFitView: handleFit, enabled: !(help?.open ?? false) });

  return (
    <div className={`archer-seq-surface ${surface.className}`}>
      <div
        ref={containerRef}
        className={`archer-seq-canvas${isPanning ? " archer-seq-canvas--panning" : ""}${pointerMode === "hand" ? " archer-pan-hand" : ""}${editable ? " archer-seq-canvas--editing" : ""}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={cancelGesture}
        onClick={handleClick}
        onDoubleClick={
          props.onLabelEdit
            ? (event) => {
                const target = targetOf(event.target);
                if (target !== null) {
                  event.preventDefault();
                  props.onLabelEdit?.(target.channel, target.id);
                }
              }
            : undefined
        }
        onPointerOver={handlePointerOver}
        onPointerLeave={handlePointerLeave}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        // A role, or the label is not allowed: `aria-label` on a bare
        // `div` is prohibited and assistive technology drops it, leaving the
        // participants and messages inside it unnamed as a set.
        role="group"
        aria-label="Sequence diagram canvas"
      >
        {/* biome-ignore lint/a11y/noSvgWithoutTitle: the drawing is named by its container (role=group, "Sequence diagram canvas") and each part inside names itself. */}
        <svg className="archer-seq-svg" width="100%" height="100%">
          <g className="archer-seq-viewport" transform={viewportTransform(panZoom)}>
            {/* Fragments (background), enclosing frames first */}
            {layout.fragments.map((fragment) => (
              <FragmentFrame key={fragment.id} fragment={fragment} commentable={blockComments} />
            ))}

            {layout.participants.map((p) => {
              const interaction = interactionFor("participants", p.id);
              const marks = marksFor("participants", p.id);
              return (
                <Lifeline
                  key={`lifeline-${p.id}`}
                  participant={p}
                  // While editing, lifelines run on below the last message: room to draw the next one.
                  endY={props.onMessageDraw ? layout.lifelineEndY + 140 : layout.lifelineEndY}
                  dimmed={dimmedFor(focusedParticipantIds.has(p.id), interaction.selected, marks !== null)}
                  interaction={interaction}
                  marks={marks}
                />
              );
            })}

            {layout.activations.map((activation, i) => (
              <ActivationBar
                // biome-ignore lint/suspicious/noArrayIndexKey: the position is the identity here (fixed-length or ordered parts drawn from one layout), and the items hold no state.
                key={`activation-${i}`}
                activation={activation}
                centerX={participantCenterXMap.get(activation.participantId) ?? 0}
                dimmed={dimmedFor(
                  focusedParticipantIds.has(activation.participantId),
                  selectedParticipantIds.has(activation.participantId),
                  assignments.nodes.has(activation.participantId),
                )}
                member={isolated?.nodes.has(activation.participantId) === true}
              />
            ))}

            {/* A frame's words, over the lifelines and bars that cross it. */}
            {layout.fragments.map((fragment) =>
              props.onPartClick ? (
                <g
                  key={`header-${fragment.id}`}
                  className="archer-seq-part"
                  data-seq-part="fragment"
                  data-seq-part-id={fragment.id}
                >
                  <FragmentHeader
                    fragment={fragment}
                    commentable={blockComments}
                    commented={props.commented?.groupIds.has(fragment.id)}
                    hitHeight={Math.max(FRAGMENT_HEADER_HEIGHT, (coarsePointer ? 44 : 24) / panZoom.scale)}
                  />
                  {props.selectedPart === fragment.id ? (
                    <rect
                      x={fragment.x - 3}
                      y={fragment.y - 3}
                      width={fragment.width + 6}
                      height={fragment.height + 6}
                      rx={6}
                      className="archer-seq-part-selection archer-seq-part-selection-fragment"
                    />
                  ) : null}
                </g>
              ) : (
                <FragmentHeader
                  key={`header-${fragment.id}`}
                  fragment={fragment}
                  commentable={blockComments}
                  commented={props.commented?.groupIds.has(fragment.id)}
                  hitHeight={Math.max(FRAGMENT_HEADER_HEIGHT, (coarsePointer ? 44 : 24) / panZoom.scale)}
                />
              ),
            )}

            {/* Notes over the lifelines they annotate and under everything that
                can be selected. A note dims with the rest when the host
                focuses elsewhere, and stays lit beside a focused participant. */}
            {layout.notes.map((note) => {
              const drawing = (
                <NoteSheet
                  key={note.id}
                  note={note}
                  name={noteAccessibleName(note, layout.participants)}
                  dimmed={focusActive && !note.participants.some((id) => focusedParticipantIds.has(id))}
                />
              );
              const sheet =
                blockComments && !layout.participants.some((participant) => participant.id === note.id) ? (
                  <g
                    key={note.id}
                    className="archer-seq-note-comment-target"
                    data-seq-channel="notes"
                    data-seq-id={note.id}
                    role="button"
                    tabIndex={0}
                    aria-label={
                      noteAccessibleName(note, layout.participants) +
                      (props.commented?.nodeIds.has(note.id) ? COMMENTED_SUFFIX : "")
                    }
                  >
                    <rect
                      className="archer-seq-note-comment-hit"
                      x={note.x + (note.width - Math.max(note.width, (coarsePointer ? 44 : 24) / panZoom.scale)) / 2}
                      y={note.y + (note.height - Math.max(note.height, (coarsePointer ? 44 : 24) / panZoom.scale)) / 2}
                      width={Math.max(note.width, (coarsePointer ? 44 : 24) / panZoom.scale)}
                      height={Math.max(note.height, (coarsePointer ? 44 : 24) / panZoom.scale)}
                      fill="transparent"
                    />
                    {drawing}
                  </g>
                ) : (
                  drawing
                );
              return props.onPartClick ? (
                <g key={note.id} className="archer-seq-part" data-seq-part="note" data-seq-part-id={note.id}>
                  {sheet}
                  {props.selectedPart === note.id ? (
                    <rect
                      x={note.x - 3}
                      y={note.y - 3}
                      width={note.width + 6}
                      height={note.height + 6}
                      rx={4}
                      className="archer-seq-part-selection"
                    />
                  ) : null}
                </g>
              ) : (
                sheet
              );
            })}

            {/* Participants BEFORE messages. Document order is tab order, so
                this is what makes the first Tab land on who is talking and the
                second on what they say. Nothing is lost in the painting: a
                box sits above the first row and no message is drawn over it. */}
            <GestureGhost subscribe={subscribeGhost} participants={layout.participants} messages={layout.messages} />
            {reorder === null
              ? null
              : (() => {
                  // Where the dragged participant would land: a marker between two columns.
                  const slot = reorderSlot(layout.participants, reorder.id, reorder.dx);
                  const top = Math.min(...layout.participants.map((p) => p.y)) - 8;
                  const bottom = Math.max(...layout.participants.map((p) => p.y + p.height)) + 8;
                  return slot.changed ? (
                    <line className="archer-seq-reorder-marker" x1={slot.x} x2={slot.x} y1={top} y2={bottom} />
                  ) : null;
                })()}
            {(reorder === null
              ? layout.participants
              : [...layout.participants].sort((a, b) => Number(a.id === reorder.id) - Number(b.id === reorder.id))
            ).map((p) => {
              const interaction = interactionFor("participants", p.id);
              const marks = marksFor("participants", p.id);
              if (reorder !== null && reorder.id === p.id) {
                return (
                  <g key={p.id} className="archer-seq-reordering" transform={`translate(${reorder.dx} 0)`}>
                    <ParticipantBox
                      participant={p}
                      typeface={layout.typeface}
                      dimmed={false}
                      interaction={interaction}
                      marks={marks}
                      commented={props.commented?.nodeIds.has(p.id) === true}
                    />
                  </g>
                );
              }
              return (
                <ParticipantBox
                  key={p.id}
                  participant={p}
                  typeface={layout.typeface}
                  dimmed={dimmedFor(focusedParticipantIds.has(p.id), interaction.selected, marks !== null)}
                  interaction={interaction}
                  marks={marks}
                  commented={props.commented?.nodeIds.has(p.id) === true}
                />
              );
            })}

            {layout.messages.map((message) => {
              const interaction = interactionFor("messages", message.id);
              const marks = marksFor("messages", message.id);
              return (
                <MessageArrow
                  key={message.id}
                  message={message}
                  renaming={props.editingLabel?.channel === "messages" && props.editingLabel.id === message.id}
                  typeface={layout.typeface}
                  name={
                    messageAccessibleName(message, layout.participants) +
                    emphasisMembership(marks?.assignment) +
                    (props.commented?.edgeIds.has(message.id) === true ? COMMENTED_SUFFIX : "")
                  }
                  facts={messageFactsById.get(message.id)}
                  dimmed={dimmedFor(focusedMessageIds.has(message.id), interaction.selected, marks !== null)}
                  interaction={interaction}
                  marks={marks}
                />
              );
            })}

            {/* Comment pins, over everything they sit on: off a participant's
                top-right corner, and off a message's label (or above its
                middle). Outside the targets, so a pin is never part of one's
                name; the page takes a press on one (`CommentPins.tsx`). */}
            {props.commented === undefined
              ? null
              : layout.participants.map((p) => (
                  <SvgPinRow
                    key={`pins-${p.id}`}
                    pins={props.commented?.nodePins?.get(p.id)}
                    x={p.x + p.width + 8}
                    y={p.y}
                  />
                ))}
            {props.commented === undefined
              ? null
              : layout.messages.map((message) => {
                  const pins = props.commented?.edgePins?.get(message.id);
                  if (pins === undefined) return null;
                  const at = messagePinAnchor(message, layout.typeface);
                  return <SvgPinRow key={`pins-${message.id}`} pins={pins} x={at.x} y={at.y} from="left" />;
                })}
            {props.commented === undefined
              ? null
              : layout.fragments.map((fragment) => (
                  <SvgPinRow
                    key={`pins-${fragment.id}`}
                    owner={`group:${fragment.id}`}
                    hitSize={(coarsePointer ? 44 : 24) / panZoom.scale}
                    pins={props.commented?.groupPins?.get(fragment.id)}
                    x={annotationPinX(fragment, props.commented?.groupPins?.get(fragment.id))}
                    y={fragment.y}
                  />
                ))}
            {layout.notes
              .filter((note) => !layout.participants.some((participant) => participant.id === note.id))
              .map((note) => (
                <SvgPinRow
                  key={`pins-${note.id}`}
                  owner={note.id}
                  hitSize={(coarsePointer ? 44 : 24) / panZoom.scale}
                  pins={props.commented?.nodePins?.get(note.id)}
                  x={annotationPinX(note, props.commented?.nodePins?.get(note.id))}
                  y={note.y}
                />
              ))}
            {props.onMessageRetarget && props.selection?.edgeIds?.length === 1
              ? (() => {
                  // The selected message's ends: drag one onto another lifeline to reattach it.
                  const message = layout.messages.find((m) => m.id === props.selection?.edgeIds?.[0]);
                  if (message === undefined || ghosting?.kind === "message") return null;
                  return (
                    <g className="archer-seq-end-handles">
                      <circle
                        data-seq-end="source"
                        data-seq-message={message.id}
                        cx={message.fromX}
                        cy={message.y}
                        r={7}
                      >
                        <title>Drag to attach the start to another participant</title>
                      </circle>
                      <circle data-seq-end="target" data-seq-message={message.id} cx={message.toX} cy={message.y} r={7}>
                        <title>Drag to attach the end to another participant</title>
                      </circle>
                    </g>
                  );
                })()
              : null}
            {/* Last, so it paints over every participant, message and handle: the text typed in place must be
                on top (participants and messages are drawn after where it used to sit, and hid it). */}
            {props.editingLabel
              ? (() => {
                  // The name or message text typed in place, over where it is drawn.
                  const editing = props.editingLabel;
                  const participant =
                    editing.channel === "participants"
                      ? layout.participants.find((p) => p.id === editing.id)
                      : undefined;
                  const message =
                    editing.channel === "messages" ? layout.messages.find((m) => m.id === editing.id) : undefined;
                  // Room for a few wrapped lines: a name at least LABEL_EDITOR_WIDTH wide, centred on its header; a
                  // message's text sitting on its arrow, as it is drawn. The frame is click-through around the box.
                  const participantWidth =
                    participant === undefined ? 0 : Math.max(participant.width, LABEL_EDITOR_WIDTH);
                  const box =
                    participant !== undefined
                      ? {
                          x: participant.x + participant.width / 2 - participantWidth / 2,
                          y: participant.y + participant.height / 2 - LABEL_EDITOR_HEIGHT / 2,
                          width: participantWidth,
                          value: participant.label,
                          align: "center" as const,
                        }
                      : message !== undefined
                        ? {
                            x:
                              message.from === message.to
                                ? message.fromX + 20
                                : (message.fromX + message.toX) / 2 - LABEL_EDITOR_WIDTH / 2,
                            y: message.y - 4 - LABEL_EDITOR_HEIGHT,
                            width: LABEL_EDITOR_WIDTH,
                            value: message.label ?? "",
                            align: "end" as const,
                          }
                        : null;
                  if (box === null) return null;
                  return (
                    <foreignObject
                      x={box.x}
                      y={box.y}
                      width={box.width}
                      height={LABEL_EDITOR_HEIGHT}
                      className="archer-seq-label-editor"
                    >
                      <div className="archer-seq-label-editor-plate" data-align={box.align}>
                        <InlineLabelInput
                          key={`${editing.channel}:${editing.id}`}
                          label={`${editing.id} ${editing.channel === "participants" ? "name" : "message"}`}
                          value={box.value}
                          onCommit={(text) => props.onLabelCommit?.(editing.channel, editing.id, text)}
                          onClose={() => props.onLabelClose?.()}
                        />
                      </div>
                    </foreignObject>
                  );
                })()
              : null}
          </g>
        </svg>
      </div>

      {/* The same cluster, in the same corner, as the graph canvas: a reader
          should not have to know which renderer drew the diagram to zoom it. */}
      <div className="archer-canvas-controls" role="group" aria-label="Canvas controls">
        <button type="button" onClick={() => zoomAbout(ZOOM_STEP)} title="Zoom in" aria-label="Zoom in">
          <ZoomInGlyph />
        </button>
        <button type="button" onClick={() => zoomAbout(1 / ZOOM_STEP)} title="Zoom out" aria-label="Zoom out">
          <ZoomOutGlyph />
        </button>
        <button type="button" onClick={handleFit} title="Fit view (1)" aria-label="Fit view">
          <FitGlyph />
        </button>
        <PanSelectControl mode={pointerMode} onChange={setPointerMode} />
        {props.controls}
        <SourceToolButton />
        <CanvasTools>{props.tools}</CanvasTools>
        {help === null || props.primaryShell ? null : (
          <button type="button" onClick={help.toggle} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
            <HelpGlyph />
          </button>
        )}
      </div>

      {/* After the controls in the document, so Tab reaches it after them. */}
      <OffscreenCue
        overflow={overflow}
        onShowAll={handleShowAll}
        blocked={blocked}
        overview={overview ? `${layout.messages.length} messages` : null}
        onZoomToRead={handleZoomToRead}
      />

      {/* The same legend, in the same corner, as the graph canvas. */}
      {surface.legend}
    </div>
  );
}
