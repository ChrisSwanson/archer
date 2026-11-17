/**
 * The cue that says a diagram continues past the edge of the canvas.
 *
 * An automatic fit holds a reading floor (`readingZoom`), so a big
 * diagram can open with part of itself off screen, and a canvas that shows two
 * thirds of a graph with nothing to say so shows it as if it were the whole.
 * This is the smallest thing that says so: one quiet pill, naming each edge
 * the content runs past in plain words, which is itself the button that shows
 * everything -- what `1` and the fit control do.
 *
 * Both canvases draw it, and neither decides anything here: `overflowOf`
 * decides what is off screen, and the canvas passes an empty list once the
 * reader has taken the camera or everything is in view.
 *
 * NOT MODAL, and never in the way: it takes no focus when it appears and the
 * canvas under it still pans and selects.
 *
 * AND NOT ON THE DRAWING, where there is anywhere else to be. A framing that
 * leaves anything off screen keeps a band free at the top of the canvas
 * (`frameClearOfChrome`), and that is where the pill goes: at the end of the
 * band the drawing runs past, so "more to the right" is on the right. The
 * stylesheet puts it there. Then, once the browser has laid it out, this
 * measures the pill and the canvas's other chrome and asks `placeCue` whether
 * that place is free -- and moves it to the nearest free canvas if it is not.
 *
 * AND WHEN EVERYTHING IS SHOWN, TOO SMALL TO READ, it says that instead. "Show
 * all" on a diagram of hundreds of nodes lands at a zoom where the labels are
 * marks, not words. The action did what it said, so the pill stops offering
 * it; what it owes the reader now is the other half -- nothing here can be
 * read at this size -- and the way back to a size that can ("Zoom to read",
 * which frames the diagram as it opened). A page that showed a thin line and
 * said nothing would be showing the whole drawing as if that were useful
 * (adversarial review 2026-10-02, F7).
 *
 * ONE PILL, not one per edge. There used to be a pill pinned 52px down each
 * edge the drawing ran past, each a button that did the same thing; on a
 * diagram that starts at the top of a narrow canvas that is on its first
 * message, and two of them do not fit side by side at 420px (release review
 * 2026-10-01, I1). One control for one action, which fits the band.
 */
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type MouseEvent,
  type RefObject,
} from "react";
import { EMPHASIS_SURFACE_CLASS } from "../emphasis/surface";
import { placeCue, type CueAlign } from "./chrome-clearance";
import { overflowText, type Box, type Overflow, type Side } from "./viewport-fit";

/** Which way a side's chevron points: the way the content continues. */
const CHEVRON: Readonly<Record<Side, string>> = {
  left: "M10 3.5 5.5 8l4.5 4.5",
  right: "M6 3.5 10.5 8 6 12.5",
  top: "M3.5 10 8 5.5l4.5 4.5",
  bottom: "M3.5 6 8 10.5 12.5 6",
};

/**
 * The rest of what floats over a canvas, which the cue must not cover either:
 * both control clusters, the emphasis legend, the compile notice, and the two controls
 * the embedded view floats in its top-right corner.
 */
const CHROME_SELECTOR = [
  ".react-flow__controls",
  ".archer-canvas-controls",
  ".archer-emph-legend",
  ".archer-canvas-heading",
  ".archer-compile-notice",
  ".archer-theme-toggle",
  // The editor's panels and notes over the canvas (the selected message's panel sits on it).
  ".authoring-message-panel",
  ".authoring-coach",
  ".authoring-feedback",
  ".authoring-stale-note",
].join(", ");

/** Every side in one phrase: "2 more to the right, 12 more below". */
function phrase(overflow: readonly Overflow[]): string {
  return overflow
    .map((entry, index) => {
      const words = overflowText(entry);
      return index === 0 ? words : words.charAt(0).toLowerCase() + words.slice(1);
    })
    .join(", ");
}

/**
 * What a screen reader is told, once, when the cue appears.
 *
 * One sentence for every side, and the key rather than the button: the reader
 * hears it wherever their focus is, and `1` works from there.
 */
function announcement(overflow: readonly Overflow[]): string {
  if (overflow.length === 0) {
    return "";
  }
  const said = phrase(overflow);
  return `Part of the diagram is off screen: ${said.charAt(0).toLowerCase() + said.slice(1)}. Press Show all to see all of it.`;
}

/** What a screen reader is told when everything is in view and none of it reads. */
function overviewAnnouncement(shown: string): string {
  return `All ${shown} are shown, too small to read. Zoom in to explore.`;
}

/** The end of the band the pill prefers: the one edge the drawing runs past, else the middle. */
function alignOf(overflow: readonly Overflow[]): CueAlign {
  const sides = new Set(overflow.map((entry) => entry.side));
  if (sides.size === 1 && sides.has("right")) return "right";
  if (sides.size === 1 && sides.has("left")) return "left";
  return "center";
}

type Spot = { readonly left: number; readonly top: number };

/**
 * Where the pill should be, measured from the laid-out page: `null` while
 * there is nothing to place or nothing to measure (jsdom lays nothing out),
 * which leaves the pill where the stylesheet puts it.
 */
function useCueSpot(
  overflow: readonly Overflow[],
  blocked: readonly Box[],
  /** Whether there is a pill at all: something off screen, or an overview to describe. */
  shown: boolean,
): { pill: RefObject<HTMLButtonElement | null>; spot: Spot | null } {
  const pill = useRef<HTMLButtonElement>(null);
  const [spot, setSpot] = useState<Spot | null>(null);
  // Bumped when a piece of chrome appears, goes or resizes, so the pill is placed again.
  const [chromeChanged, setChromeChanged] = useState(0);
  useLayoutEffect(() => {
    const element = pill.current;
    if (!shown || element === null || typeof MutationObserver === "undefined") return;
    const root = element.closest(".authoring-workspace") ?? element.offsetParent?.parentElement ?? null;
    if (root === null) return;
    let frame = 0;
    const bump = () => {
      if (frame === 0)
        frame = requestAnimationFrame(() => {
          frame = 0;
          setChromeChanged((n) => n + 1);
        });
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(bump);
    let pieces: Element[] = [];
    const watch = () => {
      const next = [...root.querySelectorAll(CHROME_SELECTOR)];
      if (next.length === pieces.length && next.every((piece, i) => piece === pieces[i])) return;
      resize?.disconnect();
      pieces = next;
      for (const piece of pieces) resize?.observe(piece);
      bump();
    };
    pieces = [...root.querySelectorAll(CHROME_SELECTOR)];
    for (const piece of pieces) resize?.observe(piece);
    // Only additions and removals of elements: the drawing's own attribute churn is not watched.
    const mutations = new MutationObserver(watch);
    mutations.observe(root, { childList: true, subtree: true });
    return () => {
      mutations.disconnect();
      resize?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [shown]);

  useLayoutEffect(() => {
    const element = pill.current;
    const canvas = element?.offsetParent ?? null;
    if (!shown || element === null || canvas === null) {
      setSpot(null);
      return;
    }
    const size = element.getBoundingClientRect();
    const frame = canvas.getBoundingClientRect();
    if (size.width === 0 || size.height === 0 || frame.width === 0 || frame.height === 0) {
      setSpot(null);
      return;
    }
    const chrome: Box[] = [];
    for (const piece of document.querySelectorAll(CHROME_SELECTOR)) {
      const box = piece.getBoundingClientRect();
      const onCanvas =
        box.width > 0 &&
        box.height > 0 &&
        box.left < frame.right &&
        box.right > frame.left &&
        box.top < frame.bottom &&
        box.bottom > frame.top;
      if (onCanvas) {
        chrome.push({ x: box.left - frame.left, y: box.top - frame.top, width: box.width, height: box.height });
      }
    }
    const next = placeCue(
      { width: size.width, height: size.height },
      { width: frame.width, height: frame.height },
      alignOf(overflow),
      [...blocked, ...chrome],
      chrome,
    );
    setSpot((held) => (held !== null && held.left === next.left && held.top === next.top ? held : next));
  }, [overflow, blocked, shown, chromeChanged]);

  return { pill, spot };
}

/** Stable "nothing is drawn", so a canvas that passes none does not re-place the pill. */
const NOTHING_BLOCKED: readonly Box[] = [];

export function OffscreenCue(props: {
  /** What the current framing left out; empty when there is nothing to say. */
  overflow: readonly Overflow[];
  /** Frame the whole diagram, however small that makes it. */
  onShowAll: () => void;
  /**
   * What the pill must not cover: the drawing as the current framing draws it,
   * as boxes on the canvas. Omitted, it stays where the stylesheet puts it.
   */
  blocked?: readonly Box[];
  /**
   * What is in view when ALL of the diagram is, at a size nobody can read:
   * "200 nodes", "300 messages". `null` (or absent) otherwise. Only said
   * while nothing is off screen; a diagram cannot be both.
   */
  overview?: string | null;
  /** Frame the diagram at a size that reads, from where reading it starts. */
  onZoomToRead?: () => void;
}): JSX.Element {
  const { overflow, onShowAll, blocked = NOTHING_BLOCKED, onZoomToRead } = props;
  const overview = overflow.length === 0 ? (props.overview ?? null) : null;
  const { pill, spot } = useCueSpot(overflow, blocked, overflow.length > 0 || overview !== null);
  // The measured place overrides the stylesheet's, whichever end that was.
  const placed: CSSProperties | undefined =
    spot === null ? undefined : { left: spot.left, top: spot.top, right: "auto", transform: "none" };

  /** Presses the pill: either of its two actions replaces or removes it. */
  const press = (event: MouseEvent<HTMLButtonElement>, action: () => void): void => {
    const pressed = event.currentTarget;
    const held = document.activeElement === pressed;
    action();
    // Either action removes this pill, and a focused element that is removed
    // drops focus on `<body>`. A reader who pressed it from the keyboard is
    // handed to the fit control, which is beside it and stays put.
    if (held) {
      pressed
        .closest(`.${EMPHASIS_SURFACE_CLASS}`)
        ?.querySelector<HTMLElement>('button[aria-label="Fit view"]')
        ?.focus();
    }
  };

  return (
    <div className="archer-offscreen">
      {/* Always mounted: a live region has to be in the page before its text
          changes for the change to be read out. Polite and atomic, which is
          what `role="status"` means -- spelled out instead, because the page
          already has a status (the connection strip) and an always-present
          second one would make "the status" ambiguous to anything that asks
          for it by role. The text is a string, so React keeps one text node
          while it does not change and a redraw with the same overflow
          announces nothing. */}
      <p className="archer-offscreen-status" aria-live="polite" aria-atomic="true">
        {overview === null ? announcement(overflow) : overviewAnnouncement(overview)}
      </p>
      {overview === null ? null : (
        <button
          type="button"
          ref={pill}
          className="archer-overview-cue archer-overview-cue--center"
          style={placed}
          aria-label={`All ${overview} shown, too small to read. Zoom to read`}
          onClick={(event) => press(event, () => onZoomToRead?.())}
        >
          <span className="archer-offscreen-cue-text">All {overview} shown · too small to read</span>
          <span className="archer-offscreen-cue-action">Zoom to read</span>
        </button>
      )}
      {overflow.length === 0 ? null : (
        <button
          type="button"
          ref={pill}
          className={`archer-offscreen-cue archer-offscreen-cue--${alignOf(overflow)}`}
          style={placed}
          aria-label={`${phrase(overflow)}. Show all`}
          onClick={(event) => press(event, onShowAll)}
        >
          {overflow.map((entry) => (
            <span key={entry.side} className={`archer-offscreen-cue-side archer-offscreen-cue-side--${entry.side}`}>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
                <path
                  d={CHEVRON[entry.side]}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="archer-offscreen-cue-text">{overflowText(entry)}</span>
            </span>
          ))}
          <span className="archer-offscreen-cue-action">Show all</span>
        </button>
      )}
    </div>
  );
}
