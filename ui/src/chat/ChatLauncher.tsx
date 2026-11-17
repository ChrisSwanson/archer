/**
 * The chat launcher (ADR 0034 §10): a real button that opens the chat, can be dragged anywhere,
 * and moved with the arrow keys (10 px, 50 px with Shift; Home returns it to the corner).
 * It reports where it is dragged to every frame (the chat follows by transform) and where it
 * was dropped; it never decides what the position means.
 */
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { LAUNCHER_PX, nudge, type Point, type Win } from "./chat-position";

const DRAG_START_PX = 5;

export const ChatLauncher = forwardRef<
  HTMLButtonElement,
  {
    readonly at: Point;
    readonly win: Win;
    readonly label: string;
    readonly describedBy: string;
    readonly controls: string;
    readonly expanded: boolean;
    readonly unread: boolean;
    /** Animate to a new place (a key press or the corner), not while dragging. */
    readonly glide: boolean;
    readonly onToggle: () => void;
    readonly onDrag: (to: Point) => void;
    /** A press has become a drag (it has moved past the threshold). */
    readonly onDragStart?: () => void;
    readonly onDrop: (to: Point) => void;
    readonly onMove: (to: Point) => void;
    readonly onCorner: () => void;
    readonly onMenu: (at: Point) => void;
  }
>(function ChatLauncher(props, ref) {
  const drag = useRef<{ x: number; y: number; dx: number; dy: number; id: number; moved: boolean; to: Point } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);
  /** The next click ends a drag or a long press, and does not toggle. */
  const swallow = useRef(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const set = (el: HTMLButtonElement | null): void => {
    button.current = el;
    if (typeof ref === "function") ref(el);
    else if (ref !== null) ref.current = el;
  };
  // A drag in progress is by transform only; a new place from outside clears it.
  useEffect(() => {
    if (button.current !== null) button.current.style.transform = "";
  }, [props.at.x, props.at.y]);

  const down = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    // A press that ended without a click (a touch drag, a cancelled gesture) leaves nothing to swallow.
    swallow.current = false;
    // From where it is drawn, which is not `at` while it is parked above a dock sheet (chat.css): the
    // drag starts under the finger instead of jumping back to `at`.
    const box = event.currentTarget.getBoundingClientRect();
    const from = { x: box.left, y: box.top };
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      dx: event.clientX - from.x,
      dy: event.clientY - from.y,
      id: event.pointerId,
      moved: false,
      to: from,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* A synthetic pointer. */
    }
  };
  const move = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const d = drag.current;
    if (d === null || event.pointerId !== d.id) return;
    if (!d.moved && Math.hypot(event.clientX - d.x, event.clientY - d.y) < DRAG_START_PX) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
      props.onDragStart?.();
    }
    const max = { x: props.win.w - LAUNCHER_PX - 8, y: props.win.h - LAUNCHER_PX - 8 };
    d.to = {
      x: Math.max(8, Math.min(max.x, event.clientX - d.dx)),
      y: Math.max(8, Math.min(max.y, event.clientY - d.dy)),
    };
    event.currentTarget.style.transform = `translate(${d.to.x - props.at.x}px, ${d.to.y - props.at.y}px)`;
    props.onDrag(d.to);
  };
  // It opens on the click, not on pointer-up (round 1 pass 3, C-22). Opening on pointer-up puts the chat
  // under the finger before the tap's own click arrives, and that click then lands on whatever the chat
  // laid there (its Collapse button), closing it again. The click comes after the layout change and goes
  // to this button, so one tap is one toggle. A drag ends in a click too (the pointer was captured): that
  // one, and the release after a long press's menu, are not presses.
  const up = (): void => {
    const d = drag.current;
    drag.current = null;
    if (d === null) return;
    setDragging(false);
    if (d.moved) {
      swallow.current = true;
      props.onDrop(d.to);
    }
  };
  const click = (event: ReactMouseEvent<HTMLButtonElement>): void => {
    // A key's click (detail 0) is always a press.
    if (swallow.current && event.detail !== 0) {
      swallow.current = false;
      return;
    }
    swallow.current = false;
    props.onToggle();
  };
  const key = (event: KeyboardEvent<HTMLButtonElement>): void => {
    // Not the page's: arrow keys and Home would otherwise reach the canvas behind.
    if (event.key === "Home") {
      event.preventDefault();
      event.stopPropagation();
      props.onCorner();
      return;
    }
    const to = nudge(props.at, event.key, event.shiftKey, props.win);
    if (to === null) return;
    event.preventDefault();
    event.stopPropagation();
    props.onMove(to);
  };

  return (
    <button
      ref={set}
      type="button"
      className="archer-chat-fab"
      style={{ left: props.at.x, top: props.at.y }}
      {...(dragging ? { "data-dragging": "" } : {})}
      {...(props.glide && !dragging ? { "data-glide": "" } : {})}
      aria-label={props.label}
      aria-describedby={props.describedBy}
      aria-haspopup="dialog"
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
        if (button.current !== null) button.current.style.transform = "";
      }}
      onClick={click}
      onKeyDown={key}
      onContextMenu={(event) => {
        event.preventDefault();
        // A long press raises the menu while the finger is still down: its release is not a click.
        drag.current = null;
        setDragging(false);
        swallow.current = true;
        props.onMenu({ x: event.clientX || props.at.x, y: event.clientY || props.at.y });
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 5.5h16v10H11l-4.5 3.5v-3.5H4z" />
      </svg>
      {props.unread ? (
        <span className="archer-chat-agent-dot" data-testid="chat-unread-dot" aria-hidden="true" />
      ) : null}
    </button>
  );
});
