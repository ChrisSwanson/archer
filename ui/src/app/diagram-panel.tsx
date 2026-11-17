/**
 * The diagram side panel (0.6.4, D5): one panel on the right of the drawing, a part of the diagram stage
 * both shells share (the MCP shell has no walkthroughs, so its top is Highlights or nothing).
 *
 * - **Top, the mode's surface** (`DiagramModes`, `diagram-mode.ts`): in Walkthrough, the walkthrough's
 *   picker, Steps / Sequence tabs and transport, and its ✕ (`modes.exit`); in Highlights, the agent's
 *   groups (the legend, portalled here by the emphasis surface through `panel-context.ts`) and their ✕; in
 *   Explore, the walkthroughs to start and the agent's highlights to show. "Show highlights" is offered
 *   when the agent sets them during a walkthrough. Sequence and journey diagrams have no walkthroughs.
 * - **Bottom, the Diagram key**, always there. `↗` pops it out as the floating, movable box (its place
 *   kept as before); the box's dock button puts it back.
 * - **`»` collapses** the panel to a rail of icons; the choice is kept per viewer. Entering a walkthrough
 *   (the person's or the agent's) opens a collapsed panel once, over the drawing in a narrow window; a
 *   collapse during that walkthrough holds until it ends, and then the viewer's choice is back.
 * - **Focus has one owner**: what the panel replaces (collapsing, a section the mode swapped, the key popped
 *   out) hands focus on to the section asked for, else the switcher, the key, then the rail.
 * - **A phone** (`DOCK_QUERY`) has the same sections in one sheet of the stage's dock, which follows the
 *   dock's one-sheet rule; nothing sits beside or over the drawing.
 *
 * It wraps the drawing (`children`), so it can hand the canvas inside it where the legend goes.
 */
import { useOfferReviewHost } from "../comments/review-host";
import { browserStateKey } from "../runtime/address.ts";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { DiagramKey, keyShown, type KeyModel } from "../diagrams/DiagramKey";
import type { Walk } from "../walkthroughs/contract";
import { WalkList } from "../walkthroughs/WalkList";
import type { DiagramModes } from "./diagram-mode";
import { useMediaQuery } from "./media";
import { DiagramPanelContext, DiagramPanelPart, type PanelSlot } from "./panel-context";
import { PanelDivider, readPanelWidth } from "./PanelDivider";
import { DockedPanel, DockSheetClose, useStageDock } from "./stage-dock";
import "./diagram-panel.css";

/** Where a viewer's collapsed or expanded panel is kept (this browser only). */
export const PANEL_COLLAPSED_STORAGE = "archer.diagram-panel.collapsed";
/** Where a viewer's choice to have the key popped out of the panel is kept. */
export const KEY_POPPED_STORAGE = "archer.diagram-key.popped";
/** A window narrower than this starts with the panel collapsed, unless the viewer chose (an MCP host's frame). */
export const PANEL_ROOMY_WIDTH = 1000;
/** Narrower than that, a panel opened for a walkthrough lies over the drawing rather than narrowing it. */
const CRAMPED_QUERY = `(max-width: ${PANEL_ROOMY_WIDTH - 1}px)`;

function readFlag(key: string): boolean | null {
  try {
    const value = window.localStorage.getItem(browserStateKey(key));
    return value === "true" ? true : value === "false" ? false : null;
  } catch {
    return null;
  }
}
function writeFlag(key: string, on: boolean): void {
  try {
    window.localStorage.setItem(browserStateKey(key), String(on));
  } catch {
    // Storage refused (private window, blocked site data): the choice lasts this page only.
  }
}

export type DiagramPanelProps = {
  readonly modes: DiagramModes;
  /** The diagram's walkthroughs; empty for sequence and journey diagrams, and in the MCP shell. */
  readonly walks: readonly Walk[];
  /** The diagram's model revision, to say whether a walkthrough was written for it. */
  readonly revision?: string | undefined;
  /** How many highlights the agent has stored on this diagram. */
  readonly highlightCount: number;
  /** The open walkthrough's section (the lazy `WalkthroughSurface`); `null` outside Walkthrough mode. */
  readonly walkthrough: ReactNode;
  /** The phone chip's words while a walkthrough is open: "Walkthrough · Step 2 of 5". */
  readonly walkLabel?: string | null;
  /** The key of what is drawn; `null` before a drawing. */
  readonly keyModel: KeyModel | null;
  readonly omitLinePatterns?: boolean;
  /**
   * The mode switcher (D3), at the top of the panel: Highlights and Walkthroughs, each pressed while its mode
   * is up; pressing the one up leaves it. The page's handlers, so a switch also does the page's part (the
   * review panel gives way to a walkthrough).
   */
  readonly switcher: { readonly highlights: () => void; readonly walkthroughs: () => void };
  /** "Added to This View" (Expand, ADR 0036 A13): the sources this page added, under the key; null when none. */
  readonly added?: ReactNode;
  /** Element details temporarily replace mode content, retaining the Key and the prior mode. */
  readonly details?: {
    readonly content: ReactNode;
    readonly onClose: () => void;
    readonly onDismiss: () => void;
  } | null;
  /** Under the drawing on a phone, while the sheet may be closed (the walkthrough's transport). */
  readonly phoneBelow?: ReactNode;
  /** The drawing. */
  readonly children: ReactNode;
};

type Top = "walkthrough" | "highlights" | "explore" | null;
/** Where focus goes once the panel has redrawn; when that is not there, the switcher, the key, then the rail. */
type Focus = "top" | "key" | "collapse" | "expand" | "pop" | "dock" | "walks";

const FOCUSABLE = "button:not([disabled]), [href], select, [tabindex]:not([tabindex='-1'])";

/** On the icon scale (`--icon`, 1.5px line): the 16-unit drawings at 20px draw the 12.5px glyph the key's pop-out and dock beside them draw (round 1, O5). */
function Icon({ d }: { readonly d: string }): JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="20" height="20">
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
const ICON = {
  collapse: "M4 4l4 4-4 4M9 4l4 4-4 4",
  expand: "M12 4L8 8l4 4M7 4L3 8l4 4",
  walk: "M3 3.5h2.5M3 8h2.5M3 12.5h2.5M8 3.5h5M8 8h5M8 12.5h5",
  highlights: "M2.5 13.5h11M4 11l6.5-6.5 2 2L6 13H4z",
  key: "M2.5 3.5h3v3h-3zM2.5 9.5h3v3h-3zM8 5h5.5M8 11h5.5",
} as const;

/** Hands the open sheet's close to the panel slot (the legend is portalled, so it cannot read the sheet's context). */
function SheetCloser({ into }: { readonly into: { current: (() => void) | null } }): null {
  const close = useContext(DockSheetClose);
  into.current = close;
  useEffect(
    () => () => {
      if (into.current === close) into.current = null;
    },
    [close, into],
  );
  return null;
}

export function DiagramSidePanel(props: DiagramPanelProps): JSX.Element {
  const offerReviewHost = useOfferReviewHost();
  const { modes, walks, highlightCount, keyModel } = props;
  const dock = useStageDock();
  const sheet = dock !== null;
  const cramped = useMediaQuery(CRAMPED_QUERY);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(
    () => readFlag(PANEL_COLLAPSED_STORAGE) ?? window.innerWidth < PANEL_ROOMY_WIDTH,
  );
  const [popped, setPopped] = useState(() => readFlag(KEY_POPPED_STORAGE) === true);
  const [width, setWidth] = useState(readPanelWidth);
  const ids = useId();
  const row = useRef<HTMLDivElement | null>(null);
  const aside = useRef<HTMLElement | null>(null);
  const pending = useRef<Focus | null>(null);
  const focusIn = useRef(false);
  const escapedFromNowhere = useRef(false);
  const escapedFromDrawing = useRef(false);
  const closeSheet = useRef<(() => void) | null>(null);

  const mode = modes.mode;
  const walkable = walks.length > 0;
  // Entering Walkthrough opens the panel for it, once (review F1): a walkthrough with no visible steps has no
  // visible way out. A collapse during the walkthrough holds until it ends; then the viewer's choice is back.
  const walking = mode === "walkthrough";
  const [entry, setEntry] = useState({ walking, open: walking });
  if (entry.walking !== walking) setEntry({ walking, open: walking });
  const shut = collapsed && !entry.open && props.details == null;
  // Opened only for the walkthrough in a narrow window: over the drawing, so the drawing keeps its size.
  const overlay = !shut && collapsed && cramped;
  const top: Top =
    mode === "walkthrough" && props.walkthrough != null
      ? "walkthrough"
      : mode === "highlights"
        ? "highlights"
        : walkable
          ? "explore"
          : null;
  const keyHas = keyModel !== null && keyShown(keyModel, props.omitLinePatterns ?? false);
  const keyFloats = popped && !sheet && keyHas;
  const keyInPanel = keyHas && !keyFloats;
  const shown =
    props.details != null ||
    top !== null ||
    keyInPanel ||
    modes.highlightsOffered ||
    highlightCount > 0 ||
    props.added != null;

  const hide = useCallback(() => modes.exit("close"), [modes]);
  const slot = useMemo<PanelSlot>(() => ({ host, hide, closeSheet: () => closeSheet.current?.() }), [host, hide]);

  // Whether focus is in the panel, the portalled Highlights legend included (DOM events, which a portal's React
  // events are not). A focusout with nowhere to go (a press on the drawing) leaves it, unless the element was
  // taken away: that is the panel replacing what had focus, which the hold below answers.
  useEffect(() => {
    // Follow steps sits beside the canvas's zoom controls but is the walkthrough's: leaving from it is leaving from the panel.
    const inside = (node: EventTarget | null): boolean =>
      node instanceof Node &&
      (aside.current?.contains(node) === true ||
        (node instanceof Element && node.closest(".archer-walk-follow") !== null));
    const focusin = (event: FocusEvent): void => {
      focusIn.current = inside(event.target);
    };
    const focusout = (event: FocusEvent): void => {
      if (event.relatedTarget !== null) {
        focusIn.current = inside(event.relatedTarget);
        return;
      }
      const from = event.target;
      queueMicrotask(() => {
        if (from instanceof Node && from.isConnected && !inside(document.activeElement)) focusIn.current = false;
      });
    };
    // Escape pressed with nothing focused (after a press on the drawing): what it closes hands focus to the
    // panel, or the next Tab starts from the top of the page (round 1, F30, a body origin).
    const keydown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      escapedFromNowhere.current = document.activeElement === null || document.activeElement === document.body;
      // From a node or line of the drawing, the walkthrough's boundary among them (R5-claude-03).
      escapedFromDrawing.current =
        document.activeElement?.closest(".react-flow, .archer-seq-canvas, .archer-journey-board") != null;
      queueMicrotask(() => {
        setTimeout(() => {
          escapedFromNowhere.current = false;
          escapedFromDrawing.current = false;
        }, 0);
      });
    };
    document.addEventListener("focusin", focusin);
    document.addEventListener("focusout", focusout);
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.removeEventListener("focusin", focusin);
      document.removeEventListener("focusout", focusout);
      document.removeEventListener("keydown", keydown, true);
    };
  }, []);
  // A section the mode took away had focus (its ✕, Escape, Show highlights): focus moves to what replaced it.
  const lastTop = useRef(top);
  useLayoutEffect(() => {
    if (lastTop.current === top) return;
    const left = lastTop.current === "walkthrough";
    lastTop.current = top;
    const gone = document.activeElement === null || document.activeElement === document.body;
    // Leaving a walkthrough (its ✕, Escape) returns to Walkthroughs; Show highlights sets "top" itself, so it lands on the rows, the launcher, not to what took the panel's top
    // (round 1, F30: a Highlights row, or the page body).
    // Escape from nowhere ends a walkthrough too, from anywhere on the page: it lands on Walkthroughs as well.
    if (gone && (focusIn.current || (left && escapedFromNowhere.current)) && pending.current === null)
      pending.current = left ? "walks" : "top";
    // Escape from the drawing ends a walkthrough too: it lands on Walkthroughs, not on the node that replaced the
    // one focused when the walkthrough's nesting gave way (round 1, R5-claude-03).
    else if (left && escapedFromDrawing.current && pending.current === null) pending.current = "walks";
  }, [top]);
  // Focus held across what the panel itself replaces: collapsing, expanding, a section swapped by the mode, the
  // key popped out (the panel itself may be gone then: the stage row finds the floating key).
  useLayoutEffect(() => {
    const want = pending.current;
    if (want === null) return;
    const node = aside.current;
    const one = (selector: string): HTMLElement | null => node?.querySelector<HTMLElement>(selector) ?? null;
    const topSection = node?.querySelector(".archer-panel-top") ?? null;
    // The Highlights legend arrives in the host's own render: wait for it.
    if (want === "top" && top === "highlights" && host === null && !shut) return;
    pending.current = null;
    const target =
      want === "collapse"
        ? one(".archer-panel-collapse")
        : want === "expand"
          ? one(".archer-panel-expand")
          : want === "key"
            ? one(".archer-diagram-key-title button")
            : want === "pop"
              ? one(".archer-diagram-key-action")
              : want === "dock"
                ? (row.current?.querySelector<HTMLElement>(
                    ".archer-diagram-key[data-placement='floating'] .archer-diagram-key-action",
                  ) ?? null)
                : want === "walks"
                  ? one(".archer-diagram-modes .archer-walk-open")
                  : (topSection?.querySelector<HTMLElement>(
                      ".archer-walk-list .archer-walk-item, [aria-current='step'], .archer-emph-legend-rows button",
                    ) ??
                    topSection?.querySelector<HTMLElement>(FOCUSABLE) ??
                    null);
    const fallback =
      target ??
      one(".archer-diagram-modes [aria-pressed='true']") ??
      one(".archer-diagram-modes button") ??
      one(".archer-diagram-key-title button") ??
      one(".archer-panel-expand");
    fallback?.focus();
  });

  const setCollapse = (next: boolean, focus: Focus): void => {
    pending.current = focus;
    setCollapsed(next);
    writeFlag(PANEL_COLLAPSED_STORAGE, next);
    if (next && entry.open) setEntry({ walking, open: false });
  };
  const pop = (out: boolean): void => {
    setPopped(out);
    writeFlag(KEY_POPPED_STORAGE, out);
    // Focus follows the key: to the floating box's dock button, or back to the button that pops it out.
    pending.current = out ? "dock" : "pop";
  };

  const keySection =
    keyInPanel && keyModel !== null ? (
      <DiagramKey
        key={keyModel.view.viewId}
        model={keyModel}
        placement={sheet ? "sheet" : "panel"}
        omitLinePatterns={props.omitLinePatterns ?? false}
        suspended={mode === "walkthrough"}
        {...(sheet ? {} : { onPopOut: () => pop(true) })}
      />
    ) : null;
  const floatingKey =
    keyFloats && keyModel !== null ? (
      <DiagramKey
        key={keyModel.view.viewId}
        model={keyModel}
        omitLinePatterns={props.omitLinePatterns ?? false}
        suspended={mode === "walkthrough"}
        onDock={() => pop(false)}
      />
    ) : null;

  const offer = modes.highlightsOffered ? (
    <p className="archer-panel-offer" role="status">
      <span>The agent sent highlights.</span>
      <button
        type="button"
        onClick={() => {
          pending.current = "top";
          modes.enter("highlights");
        }}
      >
        Show highlights
      </button>
    </p>
  ) : null;
  const exploreId = `${ids}-explore`;
  const explore =
    top === "explore" ? (
      <section className="archer-panel-explore" aria-labelledby={exploreId}>
        <h2 id={exploreId} className="archer-panel-heading">
          Walkthroughs
        </h2>
        <div className="archer-walk-list" role="group" aria-label="Walkthroughs on this diagram">
          <WalkList
            walks={walks}
            chosen={null}
            revision={props.revision}
            onSelect={(id) => modes.enter("walkthrough", { id })}
          />
        </div>
      </section>
    ) : null;
  const topSection = (
    <div className="archer-panel-top" data-top={props.details != null ? "details" : (top ?? "none")}>
      {props.details == null ? offer : null}
      {props.details != null ? (
        props.details.content
      ) : (
        <>
          {top === "walkthrough" ? (
            <DiagramPanelPart.Provider value="panel">{props.walkthrough}</DiagramPanelPart.Provider>
          ) : null}
          {top === "highlights" ? <div ref={setHost} className="archer-panel-highlights" /> : null}
          {explore}
        </>
      )}
    </div>
  );

  // The mode switcher (D3): one press to Highlights or Walkthroughs, pressed while up; it replaces the canvas's.
  // Explore, the mode with nothing pressed, is named in words beside it (H1, round 1 #25).
  const explored = mode === "explore" ? <span className="archer-panel-mode">Explore</span> : null;
  const switcher =
    highlightCount > 0 || walkable ? (
      <>
        {explored}
        <div className="archer-diagram-modes" role="group" aria-label="Show on the diagram">
          {highlightCount > 0 ? (
            <button
              type="button"
              className="archer-highlights-open"
              aria-pressed={mode === "highlights"}
              onClick={props.switcher.highlights}
            >
              Highlights · {highlightCount}
            </button>
          ) : null}
          {walkable ? (
            <button
              type="button"
              className="archer-walk-open"
              {...(top === "walkthrough" ? { "aria-controls": "archer-walk-panel" } : {})}
              aria-pressed={mode === "walkthrough"}
              onClick={props.switcher.walkthroughs}
            >
              Walkthroughs · {walks.length}
            </button>
          ) : null}
        </div>
      </>
    ) : (
      (explored ?? <span className="archer-panel-mode">Diagram</span>)
    );
  let body: ReactNode = null;
  if (shown && sheet) {
    const name =
      props.details != null
        ? "Details and Additions"
        : top === "walkthrough"
          ? (props.walkLabel ?? "Walkthrough")
          : top === "highlights"
            ? "Highlights"
            : walkable
              ? `Walkthroughs · ${walks.length}`
              : highlightCount > 0
                ? `Highlights · ${highlightCount}`
                : "Diagram Key";
    body = (
      // One ✕: the sheet's ✕ (and Escape) end a walkthrough (D3) and otherwise only fold the sheet, so highlights stay on; a press outside folds it.
      <DockedPanel
        host={dock}
        order={0}
        name={name}
        className="archer-dock-chip--panel"
        chip={<span>{name}</span>}
        openOn={props.details != null ? "details" : top === "walkthrough" ? "walkthrough" : null}
        {...(props.details != null
          ? { onClose: props.details.onClose, onFold: props.details.onDismiss }
          : top === "walkthrough"
            ? { onClose: () => modes.exit("close") }
            : {})}
      >
        <SheetCloser into={closeSheet} />
        <div className="archer-diagram-panel archer-diagram-panel--sheet" data-mode={mode}>
          <div className="archer-panel-bar">{switcher}</div>
          {topSection}
          {keySection}
          {props.added}
        </div>
      </DockedPanel>
    );
  } else if (shown) {
    const rail = (
      <>
        <button
          type="button"
          className="archer-panel-expand"
          aria-label="Expand diagram panel"
          title="Expand the panel"
          aria-expanded="false"
          onClick={() => setCollapse(false, "collapse")}
        >
          <Icon d={ICON.expand} />
        </button>
        {walkable ? (
          <button
            type="button"
            className="archer-panel-rail-icon"
            data-active={mode === "walkthrough" || undefined}
            aria-label="Expand to walkthroughs"
            title="Walkthroughs"
            onClick={() => {
              if (mode === "highlights") props.switcher.walkthroughs();
              setCollapse(false, "top");
            }}
          >
            <Icon d={ICON.walk} />
          </button>
        ) : null}
        {highlightCount > 0 ? (
          <button
            type="button"
            className="archer-panel-rail-icon"
            data-active={mode === "highlights" || undefined}
            aria-label="Expand to highlights"
            title="Highlights"
            onClick={() => {
              if (mode !== "highlights") modes.enter("highlights");
              setCollapse(false, "top");
            }}
          >
            <Icon d={ICON.highlights} />
          </button>
        ) : null}
        {keyInPanel ? (
          <button
            type="button"
            className="archer-panel-rail-icon"
            aria-label="Expand to the diagram key"
            title="Diagram Key"
            onClick={() => setCollapse(false, "key")}
          >
            <Icon d={ICON.key} />
          </button>
        ) : null}
      </>
    );
    body = (
      <>
        {shut || overlay ? null : <PanelDivider width={width} onChange={setWidth} />}
        {/* Over the drawing, the rail's place is kept, so the drawing does not change size under it. */}
        {overlay ? <div className="archer-panel-rail-space" aria-hidden="true" /> : null}
        <aside
          ref={aside}
          id={`${ids}-panel`}
          className="archer-diagram-panel"
          aria-label="Diagram panel"
          data-mode={mode}
          {...(shut ? { "data-collapsed": "" } : { style: { width } })}
          {...(overlay ? { "data-overlay": "" } : {})}
        >
          {shut ? (
            rail
          ) : (
            <>
              <div className="archer-panel-bar">
                {switcher}
                <button
                  type="button"
                  className="archer-panel-collapse"
                  aria-label="Collapse diagram panel"
                  title="Collapse the panel"
                  aria-expanded="true"
                  onClick={() => {
                    props.details?.onClose();
                    setCollapse(true, "expand");
                  }}
                >
                  <Icon d={ICON.collapse} />
                </button>
              </div>
              {topSection}
              {keySection}
              {props.added}
              {/* The project review takes this cell while it is open (review-host.ts). */}
              <div ref={offerReviewHost} className="archer-panel-review-host" />
            </>
          )}
        </aside>
      </>
    );
  }

  return (
    <DiagramPanelContext.Provider value={slot}>
      {/* The mode's part of the walkthrough (its step keys and spoken step): mounted while the mode is, wherever the panel is. */}
      {walking && props.walkthrough != null ? (
        <DiagramPanelPart.Provider value="mode">{props.walkthrough}</DiagramPanelPart.Provider>
      ) : null}
      <div ref={row} className="archer-stage-row">
        {props.children}
        {floatingKey}
        {sheet ? null : body}
      </div>
      {sheet ? body : null}
      {sheet ? props.phoneBelow : null}
    </DiagramPanelContext.Provider>
  );
}
