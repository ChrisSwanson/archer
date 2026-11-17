/**
 * Comment pins: every thread on an element, as a numbered pin on it
 * (phase2-feedback-loop.md, "Pins on the canvas").
 *
 * In the person's hue: outlined while the thread is a draft, filled once
 * sent; the agent's small mark once it has answered or resolved. The number
 * is the thread's number in the panel, where its card wears the same pin.
 *
 * Each pin is a named control and a tab stop of its own ("Comment 2: sent. Open it."): Tab reaches it after
 * the element it sits on, Enter or Space opens its thread, and closing the thread returns focus to it
 * (F52, round 1). A press -- pointer or key -- is a click, taken by the page (`data-pin-thread`,
 * `App.tsx`) before the canvas sees it, and opens the thread. Keys stop at the pin, so the element
 * under it (a node, an edge, a participant) is not activated as well.
 *
 * `nopan nodrag`: React Flow does not start a pan or a drag from a pin.
 */
import type { JSX, KeyboardEvent } from "react";
import { STATE_WORD, type CanvasPin } from "./xflow-adapter";

/** Where a pin's thread id is, for the page to find under a press. */
export const PIN_THREAD_ATTRIBUTE = "data-pin-thread";

function pinTitle(pin: CanvasPin): string {
  return `Comment ${pin.number}: ${STATE_WORD[pin.state]}. Open it.`;
}

/** Enter or Space on a pin is a click on it: the page opens its thread from the click (`App.tsx`). */
function pressByKey(event: KeyboardEvent<Element>): void {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

/**
 * One pin, in HTML: on a node, a frame, an edge's label, a journey card, and the panel's cards. `title`
 * replaces the usual tooltip where the number is not the thread's own (a step's count). `control`: a named
 * tab stop that opens its thread from the keyboard too, as a pin on the drawing is. Off where the pin sits
 * inside another control (a walkthrough step's button), which then names the count itself.
 */
export function PinBadge(props: {
  readonly pin: CanvasPin;
  readonly className?: string;
  readonly interactive?: boolean;
  readonly control?: boolean;
  readonly title?: string;
}): JSX.Element {
  const { pin } = props;
  const answered = pin.state === "answered" || pin.state === "resolved";
  const interactive = props.interactive !== false;
  const control = interactive && props.control === true;
  return (
    <span
      className={`archer-pin nopan nodrag${props.className === undefined ? "" : ` ${props.className}`}`}
      data-state={pin.state}
      {...(interactive ? { [PIN_THREAD_ATTRIBUTE]: pin.threadId, title: props.title ?? pinTitle(pin) } : {})}
      {...(control
        ? { role: "button", tabIndex: 0, "aria-label": props.title ?? pinTitle(pin), onKeyDown: pressByKey }
        : { "aria-hidden": true })}
    >
      {pin.number}
      {answered ? <span className="archer-pin-agent" aria-hidden="true" /> : null}
    </span>
  );
}

/**
 * An element's pins, in a row off its top-right corner (or inside it, for a frame). They stay in the element, at
 * full strength, whatever fades: a faded box's wrapper is lifted back to full opacity and only its shapes fade
 * (`.react-flow__node.archer-dimmed`, round 1 C-07), so a pin inside it is never faded with it -- the reader's voice
 * stays as loud while a highlight or a focus is shown. `owner` is the box's node id. (`dimmed` is accepted and no
 * longer moves the row: pins used to be lifted out into the canvas's own layer when the whole box faded by opacity.)
 */
export function PinRow(props: {
  readonly pins: readonly CanvasPin[] | undefined;
  readonly inside?: boolean;
  readonly owner?: string;
  readonly dimmed?: boolean;
}): JSX.Element | null {
  if (props.pins === undefined || props.pins.length === 0) return null;
  return (
    <span
      className={props.inside === true ? "archer-pins archer-pins--inside" : "archer-pins"}
      data-owner={props.owner}
    >
      {props.pins.map((pin) => (
        <PinBadge key={pin.threadId} pin={pin} control />
      ))}
    </span>
  );
}

const SVG_PIN_HEIGHT = 20;
const SVG_PIN_GAP = 3;

function svgPinWidth(pin: CanvasPin): number {
  return Math.max(SVG_PIN_HEIGHT, 10 + String(pin.number).length * 7);
}

/** Exact horizontal space occupied by an SVG row, including its independent hit cells. */
export function svgPinRowWidth(pins: readonly CanvasPin[], hitSize: number): number {
  return (
    pins.reduce((width, pin) => width + Math.max(svgPinWidth(pin) + 10, hitSize), 0) +
    Math.max(0, pins.length - 1) * SVG_PIN_GAP
  );
}

/**
 * An element's pins in SVG, for the sequence canvas, their middle on `y`:
 * by default the row's right end is at `x` and it grows leftwards, as the
 * HTML row does; `from="left"` starts it at `x` and grows rightwards.
 */
export function SvgPinRow(props: {
  readonly pins: readonly CanvasPin[] | undefined;
  readonly x: number;
  readonly y: number;
  readonly from?: "left" | "right";
  /** Associates an external SVG pin row with the header whose placement must keep clear of it. */
  readonly owner?: string;
  /** Minimum hit size in drawing units; the host divides its screen floor by the current zoom. */
  readonly hitSize?: number;
}): JSX.Element | null {
  if (props.pins === undefined || props.pins.length === 0) return null;
  let edge = props.x;
  const rightwards = props.from === "left";
  const placed = props.pins.map((pin) => {
    const width = svgPinWidth(pin);
    const hitWidth = Math.max(width + 10, props.hitSize ?? 0);
    const hitHeight = Math.max(SVG_PIN_HEIGHT + 10, props.hitSize ?? 0);
    // A block row reserves the full hit cell, keeping neighboring comments independently pressable.
    // Other rows retain their existing spacing until their host opts into a screen floor.
    const cellWidth = props.hitSize === undefined ? width : hitWidth;
    const cellLeft = rightwards ? edge : edge - cellWidth;
    const left = cellLeft + (cellWidth - width) / 2;
    edge = rightwards ? cellLeft + cellWidth + SVG_PIN_GAP : cellLeft - SVG_PIN_GAP;
    return { pin, left, width, hitWidth, hitHeight };
  });
  const top = props.y - SVG_PIN_HEIGHT / 2;
  return (
    <g className="archer-pins-svg" data-owner={props.owner}>
      {placed.map(({ pin, left, width, hitWidth, hitHeight }) => (
        <g
          key={pin.threadId}
          className="archer-svg-pin nopan nodrag"
          data-state={pin.state}
          {...{ [PIN_THREAD_ATTRIBUTE]: pin.threadId }}
          role="button"
          tabIndex={0}
          aria-label={pinTitle(pin)}
          onKeyDown={pressByKey}
        >
          <title>{pinTitle(pin)}</title>
          <rect
            className="archer-svg-pin-hit"
            x={left + (width - hitWidth) / 2}
            y={props.y - hitHeight / 2}
            width={hitWidth}
            height={hitHeight}
          />
          <rect
            className="archer-svg-pin-body"
            x={left + 1}
            y={top + 1}
            width={width - 2}
            height={SVG_PIN_HEIGHT - 2}
            rx={(SVG_PIN_HEIGHT - 2) / 2}
          />
          <text x={left + width / 2} y={props.y} textAnchor="middle" dominantBaseline="central" fontSize={11}>
            {pin.number}
          </text>
          {pin.state === "answered" || pin.state === "resolved" ? (
            <circle className="archer-svg-pin-agent" cx={left + width - 1} cy={top + 1} r={5} />
          ) : null}
        </g>
      ))}
    </g>
  );
}
