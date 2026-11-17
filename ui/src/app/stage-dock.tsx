/**
 * The stage's dock: on a phone, what would float over the drawing sits under it instead (G1).
 *
 * Below `DOCK_QUERY` the diagram side panel (`diagram-panel.tsx`: the mode's surface and the key)
 * and the chat are each a compact chip in a strip at the bottom of the stage, outside the drawing; a
 * tap opens a bottom sheet. On a larger screen there is no dock: the panel sits beside the drawing.
 *
 * The stage owns the strip (`App`) and says where it is through `StageDockContext`; a panel
 * asks `useStageDock()` and, when docked, renders through `DockedPanel`. A canvas outside a
 * stage (tests, the editor) has no dock, so it draws its panels in place as before.
 */
import { createContext, useContext, useEffect, useId, useRef, useState, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "./media";
import { CloseGlyph } from "../diagrams/ControlGlyphs";

/** A phone: narrower than the smallest window a corner panel leaves a drawing beside. */
export const DOCK_QUERY = "(max-width: 599px)";

/** Said on the dock's strip when a sheet opens, so the others close. */
const DOCK_OPENED = "archer-dock-opened";
/** The canvas toolbars (graph, sequence, journey): kept reachable above an open sheet. */
const TOOLBAR = ".react-flow__controls, .archer-canvas-controls";
const CHAT_BUTTON = ".archer-chat-fab";
/** The open sheet's height from the window's bottom, set on `:root` while one is open. */
const SHEET_HEIGHT = "--archer-dock-sheet-height";

export type StageDock = { readonly host: HTMLElement | null };

/**
 * Inside an open sheet: closes it without handing focus back to the chip, for a control
 * that moves the reader to the drawing (the legend's member list), which the sheet may cover.
 * `null` outside a sheet.
 */
export const DockSheetClose = createContext<(() => void) | null>(null);
export const StageDockContext = createContext<StageDock | null>(null);

/** The dock's strip when this panel should dock into it, else `null`: draw in place. */
export function useStageDock(): HTMLElement | null {
  const dock = useContext(StageDockContext);
  const compact = useMediaQuery(DOCK_QUERY);
  return compact ? (dock?.host ?? null) : null;
}

/** Whether panels in this stage are docked rather than drawn over the canvas. */
export function useDocked(): boolean {
  return useStageDock() !== null;
}

/**
 * A sheet that is not a dock chip's (the chat bubble's) joins the one-sheet rule: while `open` it
 * closes when a chip's sheet opens, and opening it closes theirs.
 */
export function useDockSheet(host: HTMLElement | null, open: boolean, close: () => void): void {
  const id = useId();
  const closing = useRef(close);
  closing.current = close;
  useEffect(() => {
    if (!open || host === null) return;
    host.dispatchEvent(new CustomEvent(DOCK_OPENED, { detail: id }));
    const other = (event: Event): void => {
      if ((event as CustomEvent<string>).detail !== id) closing.current();
    };
    host.addEventListener(DOCK_OPENED, other);
    return () => host.removeEventListener(DOCK_OPENED, other);
  }, [open, host, id]);
}

/**
 * Fold whichever chip's sheet is open, as opening another sheet would: the chat button parked above
 * the sheet does this when it starts being dragged, so it is free to go where it is dropped.
 */
export function foldDockSheets(host: HTMLElement | null): void {
  host?.dispatchEvent(new CustomEvent(DOCK_OPENED, { detail: "fold" }));
}

/** The strip itself, for a stage to render under its drawing. */
export function StageDockStrip({ onHost }: { readonly onHost: (host: HTMLElement | null) => void }): JSX.Element {
  // Named to the stage only on a phone: a larger screen never re-renders the stage for a dock it
  // does not use (a late re-render under a resting pointer can hover the sidebar open).
  const compact = useMediaQuery(DOCK_QUERY);
  return <div className="archer-stage-dock" ref={compact ? onHost : undefined} />;
}

/**
 * A panel docked as a chip that opens a bottom sheet.
 *
 * The sheet is a non-modal dialog: Escape or a press outside closes it and gives focus back to
 * the chip; it never moves or resizes the drawing.
 */
export function DockedPanel(props: {
  readonly host: HTMLElement;
  /** Where in the strip: lower comes first. */
  readonly order: number;
  /** The chip's accessible name and the sheet's title. */
  readonly name: string;
  /** What the chip shows. */
  readonly chip: ReactNode;
  readonly className?: string;
  /** The sheet is open when the panel first appears (a press that asked for it). */
  readonly defaultOpen?: boolean;
  /** The sheet opens each time this becomes a new non-null value (a walkthrough the agent or the person opened). */
  readonly openOn?: string | null;
  /** The sheet's ✕ (and Escape) also end what the sheet is for (a walkthrough, D3); a press outside only folds it to the chip. */
  readonly onClose?: () => void;
  /** A fold by outside press, its chip, or another sheet (no focus restoration). */
  readonly onFold?: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(props.defaultOpen === true || (props.openOn ?? null) !== null);
  const openOn = props.openOn ?? null;
  const opened = useRef(openOn);
  useEffect(() => {
    if (openOn === opened.current) return;
    opened.current = openOn;
    if (openOn !== null) setOpen(true);
  }, [openOn]);
  const chip = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const id = useId();
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const onFoldRef = useRef(props.onFold);
  onFoldRef.current = props.onFold;
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) chip.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const focusable = "button, [href], select, [tabindex]:not([tabindex='-1'])";
    (
      sheet.current?.querySelector<HTMLElement>(`.archer-dock-sheet-body :is(${focusable})`) ??
      sheet.current?.querySelector<HTMLElement>(focusable)
    )?.focus();
    // The canvas toolbar rides above the open sheet (Select / Hand, zoom), so a press on it is not "outside".
    // Nor is one on the chat button parked above it: folding the sheet as the finger lands would move that
    // button before the tap's click, and the click would land on whatever lay under it (round 1 pass 3,
    // C-22). Opening the chat folds the sheet anyway, by the one-sheet rule (`useDockSheet`).
    const outside = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (target instanceof Element && target.closest(`${TOOLBAR}, ${CHAT_BUTTON}`) !== null) return;
      if (!sheet.current?.contains(target) && !chip.current?.contains(target)) {
        setOpen(false);
        onFoldRef.current?.();
      }
    };
    // How much of the window the sheet takes, for the toolbar to sit above it (stage-dock.css).
    const root = document.documentElement;
    const measure = (): void => {
      const node = sheet.current;
      if (node !== null)
        root.style.setProperty(SHEET_HEIGHT, `${Math.round(window.innerHeight - node.getBoundingClientRect().top)}px`);
    };
    measure();
    const sized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (sheet.current !== null) sized?.observe(sheet.current);
    document.addEventListener("pointerdown", outside);
    // Escape closes the sheet wherever focus is, before the page's own shortcuts see it.
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close(true);
      onCloseRef.current?.();
    };
    window.addEventListener("keydown", onEscape, true);
    // One sheet at a time: opening this one closes any other in the dock.
    const host = props.host;
    host.dispatchEvent(new CustomEvent(DOCK_OPENED, { detail: id }));
    const other = (event: Event): void => {
      if ((event as CustomEvent<string>).detail !== id) {
        setOpen(false);
        onFoldRef.current?.();
      }
    };
    host.addEventListener(DOCK_OPENED, other);
    return () => {
      document.removeEventListener("pointerdown", outside);
      sized?.disconnect();
      root.style.removeProperty(SHEET_HEIGHT);
      window.removeEventListener("keydown", onEscape, true);
      host.removeEventListener(DOCK_OPENED, other);
    };
  }, [open, props.host, id]);
  return createPortal(
    <>
      <button
        ref={chip}
        type="button"
        className={`archer-dock-chip${props.className === undefined ? "" : ` ${props.className}`}`}
        style={{ order: props.order }}
        aria-label={props.name}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open);
          if (open) props.onFold?.();
        }}
      >
        {props.chip}
      </button>
      {open ? (
        <div ref={sheet} id={id} className="archer-dock-sheet" role="dialog" aria-label={props.name}>
          <div className="archer-dock-sheet-head">
            <span>{props.name}</span>
            <button
              type="button"
              className="archer-dock-sheet-close"
              aria-label={`Close ${props.name}`}
              onClick={() => {
                close(true);
                props.onClose?.();
              }}
            >
              <CloseGlyph />
            </button>
          </div>
          {/* Focusable, so a keyboard can scroll a long sheet. */}
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container is a Tab stop so a keyboard can scroll it (axe scrollable-region-focusable; UI_UX.md, RS1-02). */}
          <div className="archer-dock-sheet-body" tabIndex={0}>
            <DockSheetClose.Provider value={() => close(false)}>{props.children}</DockSheetClose.Provider>
          </div>
        </div>
      ) : null}
    </>,
    props.host,
  );
}
