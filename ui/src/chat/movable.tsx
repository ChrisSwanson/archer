/**
 * A panel the person can move, the way they move the chat bubble (ADR 0034 §10), by the same rules
 * (`chat-position.ts`): anywhere, no snapping, kept as fractions of the window per viewer, held fully inside
 * the window after a drag and after a resize. Until it is moved it rests where its stylesheet puts it.
 *
 * Wears: the Diagram key and the Highlights legend. The panel gets `ref` and `style`; its header gets a
 * `<MoveHandle>`: a real button that is dragged, or moved with the arrow keys (10 px, 50 px with Shift;
 * Home puts it back), plus a visible Reset once it has been moved. That is also WCAG 2.5.7's single-pointer
 * alternative to the drag.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefCallback,
  type RefObject,
} from "react";
import { browserReviewStorage } from "../comments/review-seen";
import { browserStateKey } from "../runtime/address.ts";
import {
  clampPoint,
  fromFraction,
  nudge,
  readFraction,
  toFraction,
  writeJson,
  type Point,
  type Win,
} from "./chat-position";

/** Said on the window when a panel is moved or put back, so the bubble's corner clears it again. */
export const PANEL_MOVED = "archer-panel-moved";
const announce = (): void => {
  window.dispatchEvent(new Event(PANEL_MOVED));
};

const winSize = (): Win => ({ w: window.innerWidth, h: window.innerHeight });

export type Movable = {
  /** For the panel's `ref`: measuring follows the element itself, so a panel that goes away and comes back is held by its new size. */
  readonly ref: RefCallback<HTMLElement>;
  /** The panel element now, for reading. */
  readonly node: RefObject<HTMLElement | null>;
  /** The inline place once moved (fixed to the window); `undefined` while it rests where the stylesheet puts it. */
  readonly style: CSSProperties | undefined;
  readonly moved: boolean;
  readonly label: string;
  readonly said: string;
  readonly hintId: string;
  readonly begin: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly drag: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly drop: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly cancel: () => void;
  readonly key: (event: KeyboardEvent<HTMLElement>) => void;
  readonly reset: () => void;
};

export function useMovable(options: {
  readonly storageKey: string;
  readonly label: string;
  readonly enabled?: boolean;
}): Movable {
  const { storageKey, label } = options;
  const enabled = options.enabled !== false;
  const storage = useMemo(browserReviewStorage, []);
  const hintId = useId();
  const ref = useRef<HTMLElement | null>(null);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const attach = useCallback((el: HTMLElement | null): void => {
    ref.current = el;
    setElement(el);
  }, []);
  const [pos, setPos] = useState<Point | null>(() => readFraction(storage, browserStateKey(storageKey)));
  const [win, setWin] = useState<Win>(winSize);
  const [size, setSize] = useState<Win>({ w: 0, h: 0 });
  const [said, setSaid] = useState("");
  const dragging = useRef<{ id: number; x: number; y: number; from: Point; to: Point; moved: boolean } | null>(null);

  useEffect(() => {
    const onResize = (): void => setWin(winSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const active = enabled && pos !== null;
  // Its size, so that a key that opens or a legend that gains a row is held inside the window too.
  useLayoutEffect(() => {
    const el = element;
    if (el === null || !active) return;
    const measure = (): void => {
      const box = el.getBoundingClientRect();
      setSize((held) => (held.w === box.width && held.h === box.height ? held : { w: box.width, h: box.height }));
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [active, element]);

  const at = active ? clampPoint(fromFraction(pos, win), win, size) : null;
  /** Where it is now: its place if it has been moved, else where the stylesheet rests it. */
  const here = useCallback((): { point: Point; size: Win } | null => {
    const el = ref.current;
    if (el === null) return null;
    const box = el.getBoundingClientRect();
    return { point: { x: Math.round(box.left), y: Math.round(box.top) }, size: { w: box.width, h: box.height } };
  }, []);

  const commit = useCallback(
    (to: Point, box: Win): void => {
      const f = toFraction(clampPoint(to, winSize(), box), winSize());
      setSize(box);
      setPos(f);
      writeJson(storage, browserStateKey(storageKey), f);
      announce();
    },
    [storage, storageKey],
  );
  const reset = useCallback((): void => {
    if (ref.current !== null) ref.current.style.transform = "";
    setPos(null);
    writeJson(storage, browserStateKey(storageKey), null);
    setSaid(`${label} moved back.`);
    announce();
  }, [storage, storageKey, label]);

  const begin = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    const now = here();
    if (now === null) return;
    event.preventDefault();
    dragging.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      from: now.point,
      to: now.point,
      moved: false,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* A synthetic pointer. */
    }
  };
  const drag = (event: ReactPointerEvent<HTMLElement>): void => {
    const d = dragging.current;
    const now = here();
    if (d === null || event.pointerId !== d.id || now === null || ref.current === null) return;
    d.moved = true;
    d.to = clampPoint({ x: d.from.x + event.clientX - d.x, y: d.from.y + event.clientY - d.y }, winSize(), now.size);
    // By transform while the pointer is down; the place is only decided at the drop.
    ref.current.style.transform = `translate(${d.to.x - d.from.x}px, ${d.to.y - d.from.y}px)`;
  };
  const drop = (event: ReactPointerEvent<HTMLElement>): void => {
    const d = dragging.current;
    dragging.current = null;
    if (d === null || event.pointerId !== d.id) return;
    const now = here();
    if (ref.current !== null) ref.current.style.transform = "";
    if (d.moved && now !== null) commit(d.to, now.size);
  };
  const cancel = (): void => {
    dragging.current = null;
    if (ref.current !== null) ref.current.style.transform = "";
  };
  const key = (event: KeyboardEvent<HTMLElement>): void => {
    // The handle's own: arrow keys and Home would otherwise reach the canvas behind.
    if (event.key === "Home") {
      event.preventDefault();
      event.stopPropagation();
      reset();
      return;
    }
    const now = here();
    if (now === null) return;
    const to = nudge(at ?? now.point, event.key, event.shiftKey, winSize(), now.size);
    if (to === null) return;
    event.preventDefault();
    event.stopPropagation();
    commit(to, now.size);
    setSaid(`${label} moved.`);
  };

  const style: CSSProperties | undefined =
    at === null ? undefined : { position: "fixed", left: at.x, top: at.y, right: "auto", bottom: "auto" };
  return {
    ref: attach,
    node: ref,
    style,
    moved: at !== null,
    label,
    said,
    hintId,
    begin,
    drag,
    drop,
    cancel,
    key,
    reset,
  };
}

/** A function, not a module-scope element: an element built at import needs `React` in scope wherever this module is loaded. */
function Grip(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      {[4, 8, 12].flatMap((y) => [5.5, 10.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.1" />))}
    </svg>
  );
}

/** The grip in a movable panel's header, and its Reset once it has been moved. */
export function MoveHandle({ movable }: { readonly movable: Movable }): JSX.Element {
  const grip = useRef<HTMLButtonElement>(null);
  return (
    <span className="archer-move">
      <button
        ref={grip}
        type="button"
        className="archer-move-grip"
        aria-label={`Move ${movable.label}`}
        aria-describedby={movable.hintId}
        title={`Drag to move ${movable.label}`}
        onPointerDown={movable.begin}
        onPointerMove={movable.drag}
        onPointerUp={movable.drop}
        onPointerCancel={movable.cancel}
        onKeyDown={movable.key}
      >
        <Grip />
      </button>
      {movable.moved ? (
        <button
          type="button"
          className="archer-move-reset"
          aria-label={`Reset ${movable.label} position`}
          title="Back to its place"
          onClick={() => {
            movable.reset();
            grip.current?.focus();
          }}
        >
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3" />
          </svg>
        </button>
      ) : null}
      <span id={movable.hintId} className="archer-visually-hidden">
        Drag it, or use the arrow keys, to move it. Home puts it back.
      </span>
      <span role="status" className="archer-visually-hidden">
        {movable.said}
      </span>
    </span>
  );
}
