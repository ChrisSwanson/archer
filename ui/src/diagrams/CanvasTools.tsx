import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import "./CanvasTools.css";

/**
 * Whether anything is left to show. Whitespace is not a tool: the page's own fragment keeps a spacer among its
 * conditional tools, and on a host that withholds all of them (the static Playground) that spacer alone drew a
 * launcher whose menu opened empty.
 */
function hasContent(node: ReactNode): boolean {
  return Children.toArray(node).some((child) => {
    if (typeof child === "string") return child.trim() !== "";
    if (!isValidElement(child)) return true;
    return isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
      ? hasContent(child.props.children)
      : true;
  });
}

/**
 * The launcher's name says what is behind it in the reader's words: export and compare are the tasks a
 * reader comes for (H2 T01, T18); "Graph tools" named neither (round 1, R3-08).
 */
export const CANVAS_TOOLS_LABEL = "Export, compare and more";

/**
 * What a launcher removed in this commit hands the one mounted in it: whether its menu was open, and the name of the
 * button in it that had focus. While a diagram is laid out the launcher is in the loading page's own toolbar (O186);
 * the drawing's arrival swaps that toolbar for the canvas' cluster, a new launcher in the same commit, which started
 * closed with focus dropped to the page, so a press during a slow load opened a menu that then vanished (O242).
 */
let handover: { readonly open: boolean; readonly focus: string | null } | null = null;

/**
 * The canvas's less-used actions (export, compare, accuracy, walkthroughs) behind one button. A disclosure:
 * opening it leaves focus on the button, `aria-expanded` says it is open, and Tab goes on into the actions,
 * which follow it (round 1, R3-07). Escape, or choosing an action, closes it and returns to the button.
 */
export function CanvasTools({ children, className }: { children?: ReactNode; className?: string }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const openRef = useRef(open);
  const refocus = useRef<{ readonly name: string; readonly open: boolean } | null>(null);

  useLayoutEffect(() => {
    openRef.current = open;
  });
  useLayoutEffect(() => {
    const from = handover;
    handover = null;
    if (from === null) return;
    const dropped = document.activeElement === null || document.activeElement === document.body;
    refocus.current = dropped && from.focus !== null ? { name: from.focus, open: from.open } : null;
    if (from.open) setOpen(true);
  }, []);
  useLayoutEffect(
    () => () => {
      // Read before the nodes leave the document; kept only for a launcher mounted in this same commit.
      const root = rootRef.current;
      const active = document.activeElement;
      const focused = root !== null && active instanceof HTMLElement && root.contains(active);
      if (!openRef.current && !focused) return;
      handover = {
        open: openRef.current,
        focus: focused ? (active.getAttribute("aria-label") ?? CANVAS_TOOLS_LABEL) : null,
      };
      queueMicrotask(() => {
        handover = null;
      });
    },
    [],
  );
  useLayoutEffect(() => {
    const pending = refocus.current;
    // An action in the menu waits for the menu, which opens on the next render.
    if (pending === null || (pending.open && !open)) return;
    refocus.current = null;
    const name = pending.name;
    const target = [...(rootRef.current?.querySelectorAll<HTMLElement>("[aria-label]") ?? [])].find(
      (element) => element.getAttribute("aria-label") === name,
    );
    (target ?? triggerRef.current)?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  if (!hasContent(children)) return null;

  const closeToTrigger = (): void => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div ref={rootRef} className={`archer-canvas-tools${className === undefined ? "" : ` ${className}`}`}>
      <button
        ref={triggerRef}
        type="button"
        className="archer-canvas-tools-trigger nopan"
        aria-label={CANVAS_TOOLS_LABEL}
        title={CANVAS_TOOLS_LABEL}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((shown) => !shown)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !open) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
        onBlur={(event) => {
          // Focus moved on past the open actions (Shift+Tab away). A press elsewhere is `outside`'s; a press on an
          // action blurs this with no `relatedTarget` in some browsers, and must not close it first.
          if (open && event.relatedTarget !== null && !rootRef.current?.contains(event.relatedTarget)) setOpen(false);
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path
            transform="translate(12 12) scale(1.25) translate(-8 -8)"
            d="M9.7 2.1a3.5 3.5 0 0 0-4.2 4.6L2.2 10a1.3 1.3 0 0 0 0 1.8l2 2a1.3 1.3 0 0 0 1.8 0l3.3-3.3a3.5 3.5 0 0 0 4.6-4.2l-2.2 2.2-2.2-2.2Z"
          />
        </svg>
      </button>
      {open ? (
        <div
          id={menuId}
          className="archer-canvas-tools-menu nopan"
          role="group"
          aria-label={CANVAS_TOOLS_LABEL}
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest("button")) closeToTrigger();
          }}
          onBlur={(event) => {
            if (!rootRef.current?.contains(event.relatedTarget)) setOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closeToTrigger();
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
