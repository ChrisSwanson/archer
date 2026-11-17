/**
 * Keyboard bindings that need React Flow's imperative handle.
 *
 * Fitting the view is one of them: `fitView` only exists inside the provider,
 * so this binding cannot live with the app-level ones in `App.tsx` and is
 * mounted by the canvas instead.
 *
 * A Fit pressed while no drawing can take it -- a diagram opening, or Edit
 * handing over from the reading drawing to the editor's -- is kept, not lost
 * (V7-1, V7-2): the page queues it (`useFitQueue`), a held handover keeps it,
 * and the next canvas to be ready fits once. However slow the open: what drops a queued Fit is the page moving
 * on, never a clock (a 3 s life dropped `1` whenever an open took longer, O59).
 *
 * It is kept only for the drawing that was opening when it was pressed
 * (R6-claude-07): the page names that drawing (`fitOpens`), a page that opens
 * none (the project page, a folder, a note) queues nothing, and a page that
 * moves on to another drawing drops it. A canvas the page has moved on from
 * (`FitDrawing` names what it shows) neither takes a Fit nor fits on one.
 */
import { isTypingTarget, matchesShortcut, useWindowKeydown } from "../app/shortcuts";
import { createContext, useContext, useEffect, useRef } from "react";
import { useHelp } from "../app/HelpOverlay";

/**
 * The drawing the page is opening or showing: its id; `null` for none (a Fit is not queued); `undefined` while it
 * is not known yet (a page still loading), when a queued Fit goes to the first drawing named.
 */
type Target = string | null | undefined;
let target: Target;
let pending: { readonly target: Target } | null = null;
let held = false;
let handled: Event | null = null;
const waiting = new Set<() => void>();

/** Which drawing a canvas shows, for the page that hosts several in turn; a canvas outside one takes any Fit. */
export const FitDrawing = createContext<string | undefined>(undefined);

/** A Fit nobody could apply yet, for the drawing now opening; none where nothing opens. */
function queueFit(): void {
  if (target !== null) pending = { target };
}
/**
 * The page names the drawing it is opening (or `null`: none). A queued Fit for another drawing is dropped; one
 * pressed before any drawing was named goes to this one.
 */
export function fitOpens(next: string | null): void {
  if (pending !== null && pending.target !== next) {
    pending = pending.target === undefined && next !== null ? { target: next } : null;
  }
  target = next;
}
/** Whether a canvas showing `drawing` is one the page has moved on from. */
const outgoing = (drawing: string | undefined): boolean =>
  drawing !== undefined && typeof target === "string" && drawing !== target;
/** The queued Fit, if one is waiting for `drawing` and nothing holds it; taking it clears it. */
function takeFit(drawing: string | undefined): boolean {
  if (held || pending === null || outgoing(drawing)) return false;
  if (drawing !== undefined && typeof pending.target === "string" && pending.target !== drawing) return false;
  pending = null;
  return true;
}
/** While a drawing is being handed over, a Fit waits for the drawing that takes the stage. */
export function holdFit(on: boolean): void {
  held = on;
  if (!on) for (const ready of [...waiting]) ready();
}
/** For tests: forget any queued Fit, hold and named drawing. */
export function resetFitQueue(): void {
  pending = null;
  held = false;
  target = undefined;
  handled = null;
}

const fitKey = (event: KeyboardEvent, enabled: boolean): boolean =>
  enabled &&
  !isTypingTarget(event.target) &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.altKey &&
  matchesShortcut(event, "fit");

/**
 * The page's side of the queue: a Fit pressed where no canvas takes it (the
 * route has changed and the drawing is not there yet) is queued, if a drawing
 * is opening. A canvas that takes the key marks it handled, and clears the
 * queue whichever runs first.
 */
export function useFitQueue(enabled: boolean): void {
  useWindowKeydown((event) => {
    if (fitKey(event, enabled) && handled !== event) queueFit();
  });
}

export function useCanvasShortcuts(options: {
  readonly onFitView: () => void;
  /** False while a modal owns the keyboard. */
  readonly enabled: boolean;
  /** False until the canvas has framed its drawing: a Fit before then is queued and applied once it has. */
  readonly ready?: boolean;
}): void {
  const { onFitView, enabled, ready = true } = options;
  const help = useHelp();
  useEffect(() => help?.registerFit?.(), [help?.registerFit]);
  const drawing = useContext(FitDrawing);
  const fit = useRef(onFitView);
  fit.current = onFitView;

  useWindowKeydown((event) => {
    // A modified `1` is the browser's -- Cmd+1 and Ctrl+1 switch tabs, and
    // claiming them would take a gesture the user relies on everywhere else.
    if (!fitKey(event, enabled)) return;
    event.preventDefault();
    handled = event;
    // A drawing the page is leaving (`]` pressed, the next one not drawn yet) is not the one asked to fit.
    if (ready && !held && !outgoing(drawing)) {
      pending = null;
      onFitView();
    } else {
      queueFit();
    }
  });

  useEffect(() => {
    if (!ready || !enabled) return;
    const take = (): void => {
      if (takeFit(drawing)) fit.current();
    };
    take();
    waiting.add(take);
    return () => {
      waiting.delete(take);
    };
  }, [ready, enabled, drawing]);
}
