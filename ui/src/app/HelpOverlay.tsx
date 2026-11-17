/**
 * The `?` cheat sheet, ported from `docs/prototypes/emphasis/graph-common.js`.
 *
 * The list is a PROMISE about what the keys do, so every row here is a binding
 * this app actually has: the pointer rows are settled by `CANVAS_NAVIGATION` in
 * `DiagramCanvas`, the key rows by `useCanvasShortcuts` and the handler in
 * `App`, and the Tab/arrow/Enter rows by the traversal handler on the canvas
 * surface (`EmphasisSurface`, over `keyboard-nav.ts`). A row with no binding
 * behind it is worse than an absent row, because the reader stops looking for
 * the gesture that does work.
 *
 * That promise is why there are TWO lists. `DiagramCanvas` mounts React Flow
 * for a graph and `SequenceCanvas` for a sequence, and the two honour
 * different gestures -- a drag marquees on one and pans on the other, and only
 * the graph has emphasis. One fixed list would have been false on every
 * sequence view it was shown over. `App` decides which list from `canvasState.status`, which is what
 * chose the canvas.
 *
 * Which is why the prototype's list is not copied verbatim:
 *
 *   - plain-wheel zoom is gone. This canvas pans on the plain wheel
 *     (`zoomOnScroll` is off), so zoom is Cmd/Ctrl+scroll or pinch.
 *   - the additive modifier is Shift ALONE, not "⇧ Click / ⌘ Click": Cmd/Ctrl
 *     is spoken for by zoom, and Ctrl+click is the right-click gesture on
 *     macOS.
 *
 * Cmd/Ctrl is written out as "⌘/Ctrl" rather than "⌘", because React Flow
 * binds it per platform (`zoomActivationKeyCode` defaults to Meta on macOS and
 * Control elsewhere) and a Linux reader has no ⌘ key to press.
 */
import { createContext, Fragment, useContext, useEffect, useId, useRef, type JSX, type KeyboardEvent } from "react";
import { KEYMAP, shortcutRow, useCharacterShortcuts } from "./shortcuts";

export type HelpController = {
  readonly open: boolean;
  readonly toggle: () => void;
  readonly hide: () => void;
  /** Canvas-owned bindings stay discoverable when an editor replaces reading Help. */
  readonly fitAvailable?: boolean;
  readonly registerFit?: () => () => void;
};

/**
 * Reaches the canvas without threading props through three components that
 * have no other interest in the cheat sheet. The default is inert, so a
 * `DiagramCanvas` rendered outside the app (as the render tests do) still
 * mounts, with a help button that is simply absent.
 */
const HelpContext = createContext<HelpController | null>(null);

export const HelpProvider = HelpContext.Provider;

export function useHelp(): HelpController | null {
  return useContext(HelpContext);
}

/**
 * One row: what to press, and what it does. A row marked `"control"` names a
 * button on the page ("Send to agent") rather than a key, and is drawn as one.
 */
type Row = readonly [key: string, meaning: string, form?: "control"];

export type Section = { readonly section: string; readonly keys: readonly Row[] };

/**
 * Moving between diagrams, on the web shell with more than one registered:
 * the window handler in `App` (`[`, `]`, `/`, `G`). With one
 * diagram there is nowhere to move, so the section is not shown.
 */
export const DIAGRAMS_SECTION: Section = {
  section: "Diagrams",
  keys: [shortcutRow("previous"), shortcutRow("next")],
};

export const SEARCH_SECTION: Section = {
  section: "Search",
  keys: [shortcutRow("search"), shortcutRow("go")],
};

/**
 * Commenting, where the server takes comments (the TypeScript service): `C`
 * and the context menu are `commentOnSelection` and `handleStageContextMenu`
 * in `App`; the rest are the side panel's own controls (`ReviewPanel`,
 * `Composer`, `ThreadCard`). Without comments the section is absent, since
 * every row would be false.
 */
export const COMMENTING_SECTION: Section = {
  section: "Commenting",
  keys: [
    shortcutRow("comment"),
    ["Right-click", "Comment on a target; long press on touch. Graph boxes also offer Expand"],
    ["New comment", "Choose a target in “Comment on”", "control"],
    ["⌘/Ctrl Enter", "It goes to the agent at once; queued mode keeps a draft"],
    ["Send queued comments", 'When comment_submission = "queued": send this project\'s drafts', "control"],
    ["A numbered pin", "Open its thread; the discussion shows the same number", "control"],
    ["Edit / Delete", "Change or remove your own comments, before or after they are sent", "control"],
  ],
};

/**
 * Commenting while a walkthrough is open (ADR 0034 §9): the same rows, with `C` and right-click
 * reaching the step rows and Sequence messages, and an element comment saying where it was seen.
 */
export const WALK_COMMENTING_SECTION: Section = {
  section: COMMENTING_SECTION.section,
  keys: [
    shortcutRow(
      "comment",
      "Comment on the selection or the focused step; with nothing selected, open the chat about the walkthrough",
    ),
    ["Right-click", "Comment on whatever is under the pointer; Shift F10 for what has focus"],
    ["A step row", "Comment on that step; its count shows on the row", "control"],
    ["A Sequence message", "Comment on its step", "control"],
    ...COMMENTING_SECTION.keys.slice(2),
  ],
};

/**
 * A sequence block or note takes a comment only on `SequenceCanvas` (its block headers, borders and notes), so the
 * row naming them, and the composer's offer of them, are shown over a sequence and nowhere else: a graph's sheet that listed
 * them sent the reader looking for something that is not there.
 */
const SEQUENCE_COMMENT_ROW: Row = [
  "Sequence block / note",
  "Click, Enter or Space to comment; block borders accept right-click",
];

function withSequenceTargets(section: Section): Section {
  const keys = section.keys.map(
    (row): Row =>
      row[0] === "New comment"
        ? ["New comment", `${row[1]}, including sequence blocks and notes`, "control"]
        : row[0] === KEYMAP.comment.label && row[1] === KEYMAP.comment.meaning
          ? shortcutRow("comment", "Comment on the selection or focused block/note; otherwise open diagram chat")
          : row,
  );
  const at = keys.findIndex(([key]) => key === "A numbered pin");
  return { ...section, keys: [...keys.slice(0, at), SEQUENCE_COMMENT_ROW, ...keys.slice(at)] };
}

const SEQUENCE_COMMENTING_SECTION = withSequenceTargets(COMMENTING_SECTION);
const SEQUENCE_WALK_COMMENTING_SECTION = withSequenceTargets(WALK_COMMENTING_SECTION);

/** The Commenting rows true of the canvas on screen, in or out of a walkthrough. */
export function commentingSection(view: HelpView, walking: boolean): Section {
  if (view === "sequence") return walking ? SEQUENCE_WALK_COMMENTING_SECTION : SEQUENCE_COMMENTING_SECTION;
  return walking ? WALK_COMMENTING_SECTION : COMMENTING_SECTION;
}

/** Stepping a walkthrough (ADR 0034 §6): shown only while one is open, as the commenting rows are. */
export const WALKTHROUGH_SECTION: Section = {
  section: "Walkthrough",
  keys: [
    ["← / →", "Previous or next step"],
    ["↑ / ↓ over the panel", "Previous or next step"],
    ["Scroll over the panel", "One step for each notch"],
    ["Home / End", "First or last step"],
    ["Space", "Play or pause; at the last step, play again from the first"],
    shortcutRow("follow"),
    ["Esc", "Leave the walkthrough; the view comes back as it was"],
    ["Click off the path", "Leave the walkthrough and select what was clicked; the camera stays", "control"],
  ],
};

/**
 * Which canvas the reader is looking at.
 *
 * The two canvases are different programs -- `DiagramCanvas` mounts React Flow
 * for a graph and `SequenceCanvas` for a sequence -- and they honour different
 * gestures, so one fixed list cannot be true on both.
 */
export type HelpView = "graph" | "sequence" | "journey" | "none";

/**
 * What a reader can do about the agent's highlights: the same on every canvas
 * that draws one, so it is one section shared by both lists.
 */
const EMPHASIS_SECTION: Section = {
  section: "Highlights",
  keys: [
    ["Hover a legend row", "Isolate that group"],
    ["Esc", "Outside a walkthrough: clear the selection and dismiss the agent's highlights"],
    shortcutRow("help"),
  ],
};

/** The graph canvas: React Flow, selection, emphasis, keyboard traversal. */
export const HOTKEYS: readonly Section[] = [
  {
    section: "Select",
    keys: [
      ["Click", "Select a node or edge"],
      ["⇧ Click", "Add to or remove from the selection"],
      ["Enter / Space", "Select the focused node or edge"],
      ["⇧ Enter / ⇧ Space", "Add to or remove from the selection"],
      ["Drag on canvas", "Marquee — nodes it touches, and the edges between them"],
      ["⇧ Drag", "Marquee, added to the current selection"],
      ["⌘/Ctrl A", "Select everything"],
      ["Esc", "Clear the selection"],
    ],
  },
  {
    section: "Navigate",
    keys: [
      ["Tab", "Move focus into the diagram — once for the edges, again for the nodes"],
      ["Arrow keys", "Move focus between nodes, or between edges — the selection is untouched"],
      ["Two-finger scroll", "Pan"],
      ["Space + drag", "Pan"],
      ["Middle-drag", "Pan"],
      ["⌘/Ctrl scroll / pinch", "Zoom"],
      shortcutRow("fit"),
    ],
  },
  EMPHASIS_SECTION,
];

/**
 * The sequence canvas: `SequenceCanvas`, which mounts no React Flow.
 *
 * It selects and traverses as the graph canvas does, in its own words --
 * participants and messages, not nodes and edges -- and each row names a
 * handler that can be checked:
 *
 *   - Click / ⇧ Click: `handleClick` in `SequenceCanvas`, over the same
 *     `handleNodeClick`/`handleEdgeClick` in `App` that a graph click reaches.
 *   - Enter / Space, Tab and the arrows: `handleKeyDown` there, over
 *     `sequence-nav.ts`. The arrows get two rows because here the two axes
 *     mean different things: columns are participants, rows are messages.
 *   - ⌘/Ctrl A and Esc: the page-level handler in `App`.
 *   - pan, zoom and `1`: the wheel listener, the pointer handlers and
 *     `handleFit`; `?` is the toggle in `App`.
 *   - the emphasis rows: `set_emphasis` draws on this canvas, through the
 *     surface the graph canvas uses (`emphasis/surface.tsx`), so the legend is
 *     the same legend and Esc dismisses here as it does there. The rows are
 *     the graph list's own section rather than a copy of it.
 *
 * And what is absent is absent for a reason:
 *
 *   - no marquee. A drag on this canvas PANS; it is the only pan a mouse has.
 *   - no "Space + drag": a plain drag already pans, and Space is the selection
 *     key.
 */
export const SEQUENCE_HOTKEYS: readonly Section[] = [
  {
    section: "Select",
    keys: [
      ["Click", "Select a participant or message"],
      ["⇧ Click", "Add to or remove from the selection"],
      ["Enter / Space", "Select the focused participant or message"],
      ["⇧ Enter / ⇧ Space", "Add to or remove from the selection"],
      ["⌘/Ctrl A", "Select every participant and message"],
      ["Esc", "Clear the selection"],
    ],
  },
  {
    section: "Navigate",
    keys: [
      ["Tab", "Move through blocks, notes, participants and messages"],
      ["← / →", "Move between participants — from a message, to the participant at that end"],
      ["↑ / ↓", "Move between messages in order — from a participant, into its messages"],
      ["Two-finger scroll", "Pan"],
      ["Drag", "Pan"],
      ["Middle-drag", "Pan"],
      ["⌘/Ctrl scroll / pinch", "Zoom"],
      shortcutRow("fit"),
    ],
  },
  EMPHASIS_SECTION,
];

/**
 * The journey canvas: `JourneyCanvas`, plain HTML in a scrolling board.
 *
 *   - Click / ⇧ Click and Enter / Space: `handleClick` and `handleKeyDown`
 *     there, over the same `handleNodeClick` in `App`.
 *   - the arrows: `journeyStep` -- down a section, across to the next.
 *   - ⌘/Ctrl A and Esc: the page-level handler in `App`.
 *
 * No marquee, no pan and no zoom: the board scrolls like a page, and `1` has
 * nothing to fit.
 */
export const JOURNEY_HOTKEYS: readonly Section[] = [
  {
    section: "Select",
    keys: [
      ["Click", "Select a section or task"],
      ["⇧ Click", "Add to or remove from the selection"],
      ["Enter / Space", "Select the focused section or task"],
      ["⇧ Enter / ⇧ Space", "Add to or remove from the selection"],
      ["⌘/Ctrl A", "Select every section and task"],
      ["Esc", "Clear the selection"],
    ],
  },
  {
    section: "Navigate",
    keys: [
      ["Tab", "Move focus into the journey"],
      ["↑ / ↓", "Move along a section: its heading, then its tasks"],
      ["← / →", "Move to the section beside it"],
      ["Scroll", "Scroll the journey"],
    ],
  },
  EMPHASIS_SECTION,
];

/** The list that is true of the canvas currently on screen. */
/**
 * What is true when there is no canvas at all.
 *
 * A notice REPLACES the diagram, and `loading`/`empty`/a bare error render a
 * message instead of one. Showing the graph list there would put nineteen rows
 * on screen, every one of them false. `?` still works, so `?` is what it says.
 */
export const NO_CANVAS_HOTKEYS: readonly Section[] = [
  {
    section: "Help",
    keys: [shortcutRow("help")],
  },
];

export function hotkeysFor(view: HelpView): readonly Section[] {
  if (view === "none") {
    return NO_CANVAS_HOTKEYS;
  }
  if (view === "journey") {
    return JOURNEY_HOTKEYS;
  }
  return view === "sequence" ? SEQUENCE_HOTKEYS : HOTKEYS;
}

/**
 * Where Escape returns: where focus was, or, when the sheet was opened by `?` with nothing focused (the page body),
 * the Help launcher, its visible logical successor (round 1, F58). The shell's own launcher first; the canvas's
 * where there is no shell. The shell may still swap a launcher in its closed drawer for Menu.
 */
function helpReturnTarget(
  previous: HTMLElement | SVGElement | null,
  panel: HTMLElement | null,
): HTMLElement | SVGElement | null {
  if (previous !== null && previous !== previous.ownerDocument.body && previous.isConnected) return previous;
  const launchers = [
    ...document.querySelectorAll<HTMLElement>('.primary-help, button[aria-label="Keyboard shortcuts"]'),
  ].filter((button) => panel?.contains(button) !== true);
  return (
    launchers.find((button) => button.classList.contains("primary-help")) ??
    launchers.find((button) => button.getClientRects().length > 0) ??
    previous
  );
}

/**
 * The overlay owns Escape while focus is inside it. Consuming the event here
 * closes only the modal, so page-level Escape meanings do not also clear the
 * workspace beneath it. A page may still provide a fallback for focus outside
 * the overlay.
 */
export function HelpOverlay(props: {
  open: boolean;
  onClose: () => void;
  /** The shell may substitute a visible control when the opener belongs to a closed drawer. */
  onRestoreFocus?: (previous: HTMLElement | SVGElement | null) => void;
  /** The canvas on screen. Its rows are the ones the reader is shown. */
  view: HelpView;
  /** Sections the page adds when they are true of it: moving between diagrams, commenting. */
  extra?: readonly Section[];
}): JSX.Element | null {
  const characterKeys = useCharacterShortcuts();
  const help = useHelp();
  const editorFit =
    props.view === "none" && props.extra?.some((group) => group.section === "Editing") && help?.fitAvailable;
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Where focus was when the sheet opened, so it can be given back. Usually
  // the help button in the control cluster; losing it drops a keyboard user on
  // `<body>` and costs them their place on the page.
  //
  // SVG as well as HTML: a graph edge and every sequence participant and
  // message is a focusable `<g>`, which is an `SVGElement` and not an
  // `HTMLElement`. Remembering only HTML elements dropped focus on `<body>`
  // whenever the sheet was opened from one of those.
  const returnFocusRef = useRef<HTMLElement | SVGElement | null>(null);

  const { open } = props;

  useEffect(() => {
    if (!open) {
      return;
    }
    const previouslyFocused = document.activeElement;
    returnFocusRef.current =
      previouslyFocused instanceof HTMLElement || previouslyFocused instanceof SVGElement ? previouslyFocused : null;
    // Focus follows the dialog it opens, or the reader's next Tab lands
    // somewhere behind the overlay they cannot see.
    panelRef.current?.focus();

    return () => {
      const back = helpReturnTarget(returnFocusRef.current, panelRef.current);
      if (props.onRestoreFocus) props.onRestoreFocus(back);
      else back?.focus();
      returnFocusRef.current = null;
    };
  }, [open, props.onRestoreFocus]);

  if (!open) {
    return null;
  }

  /**
   * Keeps Tab inside the panel for as long as `aria-modal="true"` claims the
   * rest of the page is unavailable.
   *
   * The claim is the reason this exists: announcing a modal dialog and then
   * letting the first Tab land on the tab strip behind it tells a screen
   * reader user something false about how to operate the page -- the same
   * class of failure as a tab announcing a keyboard pattern it does not honour.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const focusable = panel.querySelectorAll<HTMLElement>("button, [href], [tabindex]:not([tabindex='-1'])");
    if (focusable.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop closes on a click on itself only; the keyboard closes the dialog with Escape, handled inside it.
    <div
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      // Named by its visible title, so what a screen reader announces is what the reader sees.
      aria-labelledby={titleId}
      // Only a click on the backdrop itself closes: a drag that starts inside
      // the panel and ends outside it must not be read as dismissal.
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          props.onClose();
        }
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the dialog panel handles its own keys (Escape, Tab wrap); it is focusable (tabIndex -1) for that. */}
      <div className="help-panel" ref={panelRef} tabIndex={-1} onKeyDown={handleKeyDown}>
        <h2 id={titleId}>Keyboard &amp; Pointer</h2>
        <p className="help-foot">
          {characterKeys ? "Single-character shortcuts are on." : "Single-character shortcuts are off."} Change this in
          Archer Settings → Keyboard.
        </p>
        {props.view === "graph" || props.view === "sequence" ? (
          <p className="help-foot help-pointer-modes">
            {props.view === "graph"
              ? "Use Select mode to click or marquee-select. "
              : "Use Select mode to click-select. "}
            In Hand mode, drag with the left button to pan. Keyboard selection works in both modes.
          </p>
        ) : null}
        <div className="help-cols">
          {[
            ...hotkeysFor(props.view),
            ...(props.extra ?? []),
            ...(editorFit ? [{ section: "Navigate", keys: [shortcutRow("fit")] }] : []),
          ]
            .map((group) => ({
              ...group,
              keys: group.keys.filter(
                ([key, , form]) =>
                  characterKeys ||
                  form === "control" ||
                  !Object.values(KEYMAP).some((binding) => binding.label === key),
              ),
            }))
            .filter((group) => group.keys.length > 0)
            .map((group) => (
              <section key={group.section}>
                <h3>{group.section}</h3>
                <dl>
                  {/* Fragments, not wrapper elements: the two-column grid is on
                    the `dl` and only works while `dt` and `dd` are its own
                    children. */}
                  {group.keys.map(([key, meaning, form]) => (
                    <Fragment key={`${group.section}:${key}:${meaning}`}>
                      <dt>{form === "control" ? <span className="help-control">{key}</span> : <kbd>{key}</kbd>}</dt>
                      <dd>{meaning}</dd>
                    </Fragment>
                  ))}
                </dl>
              </section>
            ))}
        </div>
        <p className="help-foot">Esc or a click outside closes this. Your selection is untouched.</p>
        {/* A pointer user who opened the sheet from the control cluster needs
            a target to close it with, and the focus trap needs something to
            trap. */}
        <button type="button" className="help-close" onClick={props.onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
