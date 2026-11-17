/**
 * What the page says about itself when it is not simply drawing a diagram.
 *
 * The page states ground truth about what exists, independently of what the
 * agent claims. If an agent says it drew a diagram and did not, or says one is
 * on screen when it is not, the screen has to contradict it -- so a blank
 * canvas is never an acceptable answer. Every non-drawing condition is named.
 *
 * These are DIFFERENT FACTS and must not collapse into one message:
 *   - nothing is registered
 *   - things are registered but none is being shown
 *   - what is being shown has been unregistered since
 *   - we do not know yet
 *   - we asked what is being shown and could not find out
 *   - we have lost touch with the server
 *   - the diagram asked for has never compiled, so there is nothing to draw
 * Saying "no diagrams" when the truth is "the connection dropped" is its own
 * false statement, and a person acting on it would draw the wrong conclusion.
 *
 * Kept pure and separate from `App` so the rules can be enumerated in tests
 * rather than inferred from a rendered tree.
 */
import { parseDiagramAddress } from "../../../shared/note-diagrams.mjs";
import type { BridgeMode } from "./host-bridge";
import type { DiagramView } from "./inventory";

/**
 * "connected" means CURRENT: the stream is open and the standing state read
 * after it opened has been applied. "unsynced" is the stream open and that
 * read failed, so updates are arriving and what is on screen is unconfirmed;
 * "lost" is no stream at all.
 */
export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "static-ready"
  | "lost"
  | "unsynced"
  | "incompatible"
  | "access-required";

/**
 * What is known about the registered set.
 *
 * "unknown" is not "empty": it is the answer before the first listing lands,
 * and it is the permanent answer in the MCP shell, which has no inventory
 * route and no inventory event. A shell that cannot observe the registry must
 * never make a claim about it.
 */
export type InventoryStatus = "unknown" | "loaded" | "failed";

export type PageNoticeKind =
  | "loading"
  | "no-diagrams"
  | "none-presented"
  | "unregistered"
  | "inventory-failed"
  | "presentation-failed"
  | "never-compiled"
  | "disconnected"
  | "incompatible"
  | "access-required";

export type PageNotice = {
  readonly kind: PageNoticeKind;
  readonly headline: string;
  readonly detail?: string;
};

export type PageStateInput = {
  readonly mode: BridgeMode;
  readonly connection: ConnectionStatus;
  /** Whether the host has sent anything at all yet -- a presentation or a clear. */
  readonly heardFromHost: boolean;
  readonly inventory: InventoryStatus;
  readonly views: readonly DiagramView[];
  /** The view the presentation state names, drawn or still laying out. */
  readonly presentedViewId: string | null;
  /**
   * Whether the presented view has ever appeared in a listing this page saw.
   *
   * "No longer registered" is a claim about a CHANGE, so it can only be made
   * about something we watched being registered. A view presented but never
   * listed is ambiguous -- most likely a registration this page has not been
   * told about yet -- and that ambiguity is not grounds for blanking a real
   * drawing.
   */
  readonly presentedWasRegistered: boolean;
  /** Whether the canvas has a real diagram to show right now. */
  readonly hasDrawing: boolean;
  /**
   * Whether the canvas has its own failure to report about the diagram it was
   * handed -- an envelope that would not project, a layout that failed.
   */
  readonly hasCanvasError: boolean;
  /**
   * Whether the request for what is presented came back unusable.
   *
   * Bootstrap is the only thing that tells a freshly opened page what is on
   * screen -- the stream carries deltas and replays nothing on connect. When it
   * fails, `heardFromHost` never flips, and without this flag the page reads
   * that as "not yet" and says "Loading..." for an answer that is never coming.
   *
   * It expires: anything the host subsequently says (a presentation, a clear)
   * sets `heardFromHost`, and the page then knows and must stop claiming it
   * does not. That is why this is read together with `heardFromHost` rather
   * than on its own.
   */
  readonly bootstrapFailed: boolean;
  /**
   * Whether the reader picked the tab of a view that has never compiled.
   *
   * Such a view is registered and has no envelope at all -- a durable view
   * whose file was already broken when the server started -- so there is no
   * last valid drawing to fall back to. This is the one notice that replaces a
   * drawing which is still true: the reader asked for THIS view, and leaving
   * the previous one up would answer "show me B" with a picture of A. Why it
   * does not compile is listed by the compile notice beside it (ADR 0010).
   *
   * Optional, and absent in the MCP shell, which has no tabs to pick.
   */
  readonly pickedViewNeverCompiled?: boolean;
};

/**
 * The notice to show INSTEAD of the canvas, or `null` to let the canvas speak.
 *
 * `null` also covers the canvas's own transient states -- laying out, or an
 * envelope that failed to project -- which it already reports itself and which
 * are about one diagram rather than about the page.
 */
export function pageNotice(input: PageStateInput): PageNotice | null {
  const knowsRegistry = input.inventory === "loaded";
  const presentedIsRegistered =
    input.presentedViewId !== null && input.views.some((v) => v.id === input.presentedViewId);

  // First, because it is the one case that overrides a drawing. The view on
  // screen has been unregistered -- the agent called `unregister_diagram`, or
  // the watcher dropped it when its source file was deleted -- so what is
  // rendered is a snapshot of something that is gone. Keeping it up would be
  // the page vouching for it.
  if (knowsRegistry && input.presentedViewId !== null && input.presentedWasRegistered && !presentedIsRegistered) {
    // A diagram embedded in a note leaves when its block is renamed, moved
    // or deleted (ADR 0012): the same notice, said of its note.
    const embedded = parseDiagramAddress(input.presentedViewId);
    if (embedded !== null)
      return {
        kind: "unregistered",
        headline: "This diagram is no longer in its note.",
        detail: `${embedded.notePath} has no diagram named ${embedded.name} now: it was renamed, moved or deleted. What was on screen is no longer live.`,
      };
    return {
      kind: "unregistered",
      headline: "This diagram is no longer registered.",
      detail: "It was removed from Archer. What was on screen is no longer live.",
    };
  }

  if (input.pickedViewNeverCompiled === true) {
    return {
      kind: "never-compiled",
      headline: "This diagram has not compiled yet.",
      detail: "Its file has problems, so there is no drawing to show. It appears here once the file compiles.",
    };
  }

  // A diagram that is genuinely on screen stays on screen. A dropped
  // connection is reported next to it rather than in place of it: blanking a
  // true drawing would trade one false statement for another.
  if (input.hasDrawing) {
    return null;
  }

  // The canvas knows WHICH diagram broke and HOW, which is more than this
  // function does. Covering that with a page-level notice would replace a
  // usable error with a vaguer one.
  if (input.hasCanvasError) {
    return null;
  }

  if (input.connection === "incompatible") {
    return {
      kind: "incompatible",
      headline: "This page needs a compatible Archer version.",
      detail: "Keep your unsaved text before opening an updated page.",
    };
  }
  if (input.connection === "access-required") {
    return {
      kind: "access-required",
      headline: "Archer access is no longer available.",
      detail: "Keep your unsaved text and ask for a current project link.",
    };
  }

  if (input.connection === "lost") {
    return {
      kind: "disconnected",
      headline: "Not connected to Archer.",
      detail: "The connection dropped, so this page is no longer receiving updates.",
    };
  }

  if (input.inventory === "failed") {
    return {
      kind: "inventory-failed",
      headline: "Cannot list the registered diagrams.",
      detail: "Archer did not answer with a readable list, so what exists is unknown.",
    };
  }

  // Asked, and could not find out. Placed after the connection check because a
  // server that is DOWN fails bootstrap too, and "not connected to Archer"
  // names the cause where this only names the symptom. Placed BEFORE the
  // loading check because that is the false statement this replaces: nothing
  // is in progress, the request is over and it failed.
  if (input.bootstrapFailed && !input.heardFromHost) {
    return {
      kind: "presentation-failed",
      headline: "Cannot tell what Archer is showing.",
      detail: "Archer did not answer with a readable presentation, so what is on screen is unknown.",
    };
  }

  // Not yet known is not nothing. The web shell needs both answers -- what the
  // host is presenting and what is registered -- before it can say either.
  //
  // In the MCP shell a completed handshake counts as having heard: the host
  // delivers whatever it is presenting with the connection, so silence after
  // it is an answer ("nothing"), where silence before it is not.
  const heard = input.heardFromHost || (input.mode === "mcp" && input.connection === "connected");
  if (!heard || (input.mode === "web" && input.inventory === "unknown")) {
    return { kind: "loading", headline: "Loading..." };
  }

  if (knowsRegistry && input.views.length === 0) {
    return {
      kind: "no-diagrams",
      // Says what to do next, in the reader's terms: they do not "register"
      // anything, their agent does, and only when asked for a diagram.
      headline: "No diagrams yet.",
      detail: "Ask your agent to draw one. It appears here as soon as the agent adds it.",
    };
  }

  if (input.presentedViewId === null) {
    // The web shell has tabs to point at; the MCP shell has none, and cannot
    // say whether anything exists to be presented, so it reports only the fact
    // it owns. Neither shell picks a diagram on the user's behalf: doing so
    // would have the page invent a presentation the agent never made.
    return knowsRegistry
      ? { kind: "none-presented", headline: "Select a diagram to view." }
      : { kind: "none-presented", headline: "No diagram presented." };
  }

  return null;
}
