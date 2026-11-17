import { runtime } from "./runtime.ts";
import { LISTENER_EVENT } from "../../../ts/src/agents/contract";
import { createSelectionSender } from "./selection-sender.ts";
import { announceListeners, LISTENERS_LOST } from "../chat/listener-event";
import { listenForFileUpdates } from "./file-updates";
import { browserFetch } from "./browser-resource";
// Host bridge: connects the Archer UI to an MCP Apps host. The official SDK
// owns the postMessage transport and ui/initialize lifecycle. The standalone
// bridge remains transport-neutral for tests and future browser fallback use.

import type { App as McpApp, McpUiToolResultNotification } from "@modelcontextprotocol/ext-apps";
import { parseInventory, type DiagramView } from "./inventory";
import { createHttpConnection, type RecoveryStatus } from "./http-connection";
import { parseEmphasisSnapshot, type EmphasisSnapshot } from "../emphasis/contract";
import { parseCompileStatus, type CompileFailure } from "./compile-status";
import type { Capabilities, CommentsChanged } from "../comments/contract";
import { isTargetRef, parseCapabilities } from "../comments/parse";
import { parseChange, type ViewChange } from "./change";
import { markProjectCatalogStale } from "./project-directory";

export type BridgeMessage =
  | {
      type: "present";
      envelope: unknown;
      presentation: unknown;
      diagnostics: unknown[];
      initial?: boolean /** The Archer page's URL a tool result names (`ui.url`), for "open in Archer". */;
      pageUrl?: string;
    }
  | { type: "clear" };

export type BridgeCallbacks = {
  /** Initial page recovery only. Reconnects never replay a reader's old selection. */
  onRecovery?: (recovery: { selection: unknown; envelope: unknown }) => void;
  onPresent: (msg: Extract<BridgeMessage, { type: "present" }>) => void;
  onClear: () => void;
  /**
   * The registered set changed. Only the web transport reports one: the
   * MCP-App view renders no tab strip, so it has nobody to tell.
   */
  onInventory?: (views: DiagramView[]) => void;
  /**
   * The registry could not be read. Distinct from an empty inventory on
   * purpose: "nothing is registered" and "we could not find out" are different
   * facts, and the page says which one it is.
   */
  onInventoryError?: () => void;
  /**
   * The bootstrap snapshot could not be read.
   *
   * Bootstrap is the ONLY thing that tells a page what is presented when it
   * connects -- the stream carries deltas and replays nothing on connect. So a
   * failure here is not merely worth logging: without it the shell never hears
   * anything at all, and a page that is told nothing goes on saying "Loading..."
   * for an answer that will never arrive. Reported for the same reason
   * `onInventoryError` is: "we could not find out" is a fact the page owes the
   * reader, and it is a different fact from "nothing is presented".
   */
  onBootstrapError?: () => void;
  /**
   * Whether this page is in touch with the server. A page that has silently
   * stopped receiving updates looks exactly like a page where nothing is
   * happening, so the transport reports the difference rather than leaving the
   * screen to imply it.
   *
   * "connected" is a claim that the page is CURRENT, not merely that a socket
   * is open: over HTTP it is reported only once the stream is open and every
   * read of the standing state made after it opened has been applied (see
   * `connectHttpBridge`). "unsynced" is the stream open and one of those reads
   * failed -- updates are arriving again, and what is on screen is still
   * unconfirmed. "lost" is no stream.
   */
  onConnection?: (status: "connected" | "static-ready" | "lost" | "unsynced" | RecoveryStatus) => void;
  /**
   * The view the page has on screen, whoever put it there.
   *
   * Asked for, not told: emphasis is stored per view, so reconciling it means
   * reading the list of the view the reader is looking at, and only the page
   * knows which that is.
   */
  viewOnScreen?: () => string | null;
  /**
   * The agent's stored emphasis list for one view changed.
   *
   * Carries the WHOLE list for that view, oldest-first, not a delta within it:
   * a page that reconstructed the list from increments would drift the moment
   * it missed one, and there is no way for it to notice that it had.
   */
  onEmphasis?: (snapshot: EmphasisSnapshot) => void;
  /**
   * Which registered views do not compile right now (ADR 0010).
   *
   * The WHOLE list, like the inventory and for the same reason. Never called
   * with a guess: a payload that could not be read is logged and dropped, so
   * the page keeps what it held rather than being told nothing is failing.
   *
   * Both transports report it. Over HTTP it is a route read whenever the
   * stream opens and a `compile` event; inside an MCP host, which has no push
   * channel, it rides
   * the `compile` key of whichever tool result the page is handed next.
   */
  onCompileStatus?: (failures: CompileFailure[]) => void;
  /**
   * What the server supports beyond the drawing: comments and notes
   * (`ts/src/comments/contract.ts`). Read off every bootstrap read, which is
   * the authority, and off a presentation event that carries them. A bootstrap
   * that names none tells the page "none", and it shows none.
   * HTTP only: the MCP-App view has no routes to comment through.
   */
  onCapabilities?: (capabilities: Capabilities) => void;
  /** A target's comment threads changed: the `comments` event. */
  onComments?: (changed: CommentsChanged) => void;
  /** Notes changed, or durable passage emphasis changed for one note. */
  onDocuments?: () => void;
  onNotes?: (changed: { readonly viewId?: string; readonly notePath?: string }) => void;
  /** A view's walkthroughs, or how they resolve, changed: the `walkthroughs` event. */
  onWalkthroughs?: (changed: { readonly viewId: string }) => void;
  /** A view recompiled, with what changed and who changed it: the `change` event. */
  onChange?: (change: ViewChange) => void;
};

/**
 * Which shell the document is being served into.
 *
 * TWO shells over one diagram stage (ADR-0004, `diagram-stage.ts`): "web" is the
 * browser-served page and wears chrome; "mcp" is the embedded MCP-App view and
 * is canvas only. Both consume the same envelope and the same presentation
 * state -- this selects chrome, never semantics. Each page build carries only
 * its own target's shell (`page-shell.tsx`).
 */
export type BridgeMode = "web" | "mcp";

export type Bridge = {
  readonly mode: BridgeMode;
  disconnect: () => void;
  setSelection: (context: unknown) => void;
  /**
   * Reads one registered view's envelope.
   *
   * A READ, deliberately: this is how the web shell answers a user clicking a
   * tab, and looking at a diagram is not the same act as the agent presenting
   * one. It sends nothing, so the presentation stays the agent's to set.
   *
   * The MCP transport calls the host-proxied read_diagram tool.
   */
  fetchView: (viewId: string) => Promise<unknown>;
  /**
   * Re-reads a view the page already read, answering `null` when it is unchanged since (web only:
   * `if-none-match` with the ETag of that read, a 304 parses nothing). Absent in an MCP host.
   */
  refreshView?: (viewId: string) => Promise<unknown>;
  /**
   * Reads one view's stored emphasis list.
   *
   * Needed because the stream carries DELTAS and sends nothing on connect: a
   * page that joins after the agent published would otherwise show no
   * emphasis until the agent happened to publish again. This is the read for
   * a view the page has just turned to; the read for the view already on
   * screen when a stream opens is `reconcile`'s. An unregistered view
   * answers the same shape with an empty list rather than a 404, so "nothing
   * stored" never arrives as an error.
   *
   * Answers `null` over HTTP when an `emphasis` event for the view arrived while the read was out:
   * the stream is ordered, the read is not, so the event is newer and already applied.
   *
   * The MCP transport reads the authoritative list_emphases tool snapshot.
   */
  fetchEmphasis: (viewId: string) => Promise<unknown>;
};

/**
 * The page target this file was built for (`vite.config.ts` defines it for `vite build` only; the dev server and
 * the tests leave it undefined, so both transports stay live there). It is the one target split in the page's code:
 * no feature has a build case of its own. The build's other differences are module swaps (`pageBuildAliases`): the
 * ELK worker, and the shell the entry mounts (`page-shell.tsx`). The web build never runs inside an MCP host, so
 * Rolldown leaves the MCP Apps SDK (and zod) out of it; the MCP build is never served over http(s), so it leaves
 * out the HTTP transport.
 */
export type PageTarget = "web" | "mcp";
const BUILT_FOR = import.meta.env.ARCHER_TARGET as PageTarget | undefined;

/**
 * THE protocol check. Nothing else in the app may look at
 * `window.location.protocol`: which transport gets built and which shell gets
 * rendered are the same decision, and a second copy of it is a way for the two
 * to disagree. `connectBridge` calls this to pick a transport and republishes
 * the answer as `Bridge.mode`; `page-shell.tsx` calls it to pick a shell in the
 * dev server and the tests (a build mounts the shell of its target).
 *
 * A document with no browser at all (SSR, a non-jsdom test) is "mcp": that is
 * the chrome-free shell, and rendering chrome for a host that has none is the
 * worse failure.
 */
export function hostMode(): BridgeMode {
  if (typeof window === "undefined") {
    return "mcp";
  }
  return window.location.protocol === "http:" || window.location.protocol === "https:" ? "web" : "mcp";
}

function dispatch(message: BridgeMessage, callbacks: BridgeCallbacks): void {
  if (message.type === "present") {
    callbacks.onPresent(message);
    return;
  }
  callbacks.onClear();
}

function presentationMessage(structuredContent: unknown): Extract<BridgeMessage, { type: "present" }> | undefined {
  if (typeof structuredContent !== "object" || structuredContent === null) {
    return undefined;
  }

  const content = structuredContent as Record<string, unknown>;
  if (!("envelope" in content) || !("presentation" in content) || !Array.isArray(content.diagnostics)) {
    return undefined;
  }

  const ui = content.ui as { url?: unknown } | undefined;
  const pageUrl =
    typeof ui === "object" && ui !== null && typeof ui.url === "string" && /^https?:\/\//.test(ui.url)
      ? ui.url
      : undefined;
  return {
    type: "present",
    envelope: content.envelope,
    presentation: content.presentation,
    diagnostics: content.diagnostics,
    ...(pageUrl === undefined ? {} : { pageUrl }),
  };
}

/**
 * The compile status a tool result carries, if it carries one.
 *
 * `undefined` for a result with no `compile` key, which says nothing about
 * what compiles -- most results have none -- and for one whose key is not a
 * status this page reads, which `parseCompileStatus` has already logged.
 */
function compileStatusOf(structuredContent: unknown): CompileFailure[] | undefined {
  if (typeof structuredContent !== "object" || structuredContent === null) {
    return undefined;
  }
  const content = structuredContent as Record<string, unknown>;
  return "compile" in content ? parseCompileStatus(content.compile) : undefined;
}

function selectionRecord(context: unknown): Record<string, unknown> | undefined {
  return typeof context === "object" && context !== null && !Array.isArray(context)
    ? (context as Record<string, unknown>)
    : undefined;
}

/** UI-only metadata preserves complete visual data when model text is requested. */
function toolPayload(result: { structuredContent?: unknown; _meta?: unknown }): unknown {
  return result.structuredContent ?? selectionRecord(result._meta)?.["archer/ui"];
}

function reportBridgeError(operation: string, error: unknown): void {
  console.error(`[archer] MCP Apps bridge ${operation} failed`, error);
}

/**
 * Does a bootstrap body mean "nothing is presented"?
 *
 * `api/bootstrap` sends a bare `null` in that state, and that is the frozen
 * contract -- bootstrap is the source of truth for PRESENTATION only, and
 * carries no other payload. Nothing here anticipates that changing.
 *
 * What this deliberately does NOT do is test `snapshot === null` directly.
 * "Empty" is a claim about the presentation, so it is read off the
 * presentation: the absence of a `presentation` key. That happens to accept
 * `null` too, since a null body has no keys at all. The narrower test would
 * mistake any other empty spelling for a malformed snapshot and report a
 * fault instead of clearing the canvas.
 *
 * `presentation` present but null is NOT this case -- that is a real
 * presentation whose command the host chose not to send.
 */
function isNothingPresented(snapshot: unknown): boolean {
  if (snapshot === null) {
    return true;
  }
  return (
    typeof snapshot === "object" &&
    !Array.isArray(snapshot) &&
    !("presentation" in (snapshot as Record<string, unknown>))
  );
}

function reportHttpBridgeError(operation: string, error: unknown): void {
  console.error(`[archer] HTTP bridge ${operation} failed`, error);
}

/**
 * How long a page whose stream is open waits before reading the standing
 * state again, after a read of it failed. The stream being open means the
 * server is there, so the failure is expected to be brief; until a read
 * succeeds the page goes on saying it may be out of date.
 */
export const RECONCILE_RETRY_MS = 2000;

/**
 * What identifies a presentation snapshot: the agent's command and the
 * revision of the model it is drawn from. Two snapshots with one key are the
 * same statement, and applying the second would be the page acting on
 * something nobody said -- framing the drawing again, or taking the reader
 * off a tab they picked.
 */
function presentationKey(message: Extract<BridgeMessage, { type: "present" }> | null): string {
  if (message === null) {
    return "null";
  }
  const envelope = message.envelope;
  const revision =
    typeof envelope === "object" && envelope !== null ? (envelope as Record<string, unknown>).revision : undefined;
  return JSON.stringify([message.presentation, revision]);
}

/**
 * The browser-served transport: ROUTES FOR STATE, EVENTS FOR CHANGES (ADR
 * 0010, "Reconnection").
 *
 * The stream says what changed while it was open and nothing else: it replays
 * nothing on connect, and nothing it missed is ever resent. So the standing
 * state -- what is registered, what is presented (including nothing), what
 * does not compile, and the emphasis of the view on screen -- is read from the
 * routes, by ONE function, `reconcile`, at two moments:
 *
 *   - when the page opens, so the first paint does not wait for the stream,
 *     and a page whose stream is refused still shows what the routes say;
 *   - every time the stream opens, the first time included. The server
 *     subscribes a stream before it answers, so whatever changes after `open`
 *     arrives as an event, and whatever changed before it is in what the
 *     routes answer when asked afterwards. Reading only before the stream
 *     opened leaves a gap between the two; reading only compile status on a
 *     reconnect left a retired drawing on screen with the warning gone
 *     (adversarial review 2026-10-02, F1).
 *
 * Only when a reconcile made on an open stream has been applied is the page
 * told it is "connected".
 */
/** How many views the HTTP bridge holds for conditional re-reads. */
const HELD_VIEWS = 8;

function connectHttpBridge(callbacks: BridgeCallbacks): Bridge {
  const mode: BridgeMode = "web";
  /** A bridge failure, unless the page is leaving and the browser dropped the request itself. */
  const report = (operation: string, error: unknown): void => {
    if (!connection.leaving()) reportHttpBridgeError(operation, error);
  };

  // How many events of each kind have arrived. A read that was in flight when
  // an event of its kind arrived is older than that event, and is dropped: the
  // stream is ordered, the read is not.
  const arrived = { presentation: 0, inventory: 0, compile: 0, emphasis: 0 };
  // The same count for emphasis, per view: `fetchEmphasis` reads one view, and only that view's event supersedes it.
  const emphasisArrived = new Map<string, number>();
  // The presentation this page was last handed, by route or by event;
  // `undefined` before it has been handed anything.
  let presented: string | undefined;
  let initialized = false;
  // Advances with every reconcile, so an older one still in flight applies
  // nothing once a newer one has started.
  let reconciles = 0;
  // Advances every time the stream opens or drops, so a reconcile reports the
  // connection only for the stream it was started on.
  let streamEpoch = 0;
  let streamOpen = false;
  const selections = createSelectionSender(async (body) => {
    if (!connection.canSend() || !streamOpen) throw new Error("not connected");
    try {
      const response = await browserFetch("api/selection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      // 409: the selection names a presentation or revision the agent has just replaced. That is a race, not a
      // failure: the page publishes again for the new one, so it is not reported as an error.
      if (response.status === 409) return;
      if (!response.ok) throw new Error(`request failed with HTTP ${response.status}`);
    } catch (error) {
      report("selection publication", error);
      throw error;
    }
  });
  // A page being left sends its last selection at once rather than after the throttle.
  const flushSelection = (): void => selections.flush();
  globalThis.addEventListener?.("pagehide", flushSelection);
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  // The read made before any stream existed, for the first `open` to adopt instead of asking again:
  // when it started, whether it has finished, how, and the stream (if any) that adopted it.
  // `seq`: the lowest publication count its answers were given at (`x-archer-event-seq`); null when
  // one named none. `standing`: what the current stream said it started from (its `standing` event,
  // which can come before `open`: the connection opens the page's side only after its own check).
  const connectRead: {
    startedAt: number;
    done: boolean;
    complete: boolean;
    mine: number;
    adopted: number | null;
    seq: number | null;
    standing: number | null;
    adoptedBy: number | null;
  } = {
    startedAt: 0,
    done: false,
    complete: false,
    mine: 0,
    adopted: null,
    seq: null,
    standing: null,
    adoptedBy: null,
  };
  /**
   * An adopted read is only as good as its order against the stream: the service may answer the
   * read, publish a change, and only then take the stream, which will never say that change. The
   * stream's first event names the publication count it started from; when that is past what the
   * read was answered at (or the read could not say), the stream reads again.
   */
  const checkAdopted = (): void => {
    const by = connectRead.adoptedBy,
      standing = connectRead.standing;
    if (by === null || standing === null || !connectRead.done) return;
    connectRead.adoptedBy = null;
    if (by !== streamEpoch || !streamOpen) return;
    if (connectRead.seq === null || standing > connectRead.seq) reconcile(by);
  };
  const ADOPT_WITHIN_MS = 1000;

  const present = (message: Extract<BridgeMessage, { type: "present" }>): void => {
    presented = presentationKey(message);
    dispatch(message, callbacks);
  };

  /**
   * Reads the standing state and applies it as one step.
   *
   * `stream` is the epoch of the open stream this was started on, or `null`
   * for the read made before any stream is open, which reports no connection.
   *
   * Applied together, after every read is back, and in the order the server
   * announces a change in: the registry, then what compiles, then the
   * presentation. A page that applied them as they arrived would draw a new
   * view before it had a tab for it, or put a notice calling a drawing old
   * over one that had just been replaced.
   *
   * A failed read claims nothing and changes nothing: the page keeps what it
   * held, is told which question went unanswered, and -- on an open stream --
   * asks again.
   */
  const reconcile = (stream: number | null): void => {
    const mine = ++reconciles;
    if (retry !== undefined) {
      clearTimeout(retry);
      retry = undefined;
    }
    const before = { ...arrived };
    const seqs: (number | null)[] = [];
    const readAt = (path: string): Promise<unknown> =>
      stream === null
        ? connection.readNumbered(path).then(({ body, seq }) => {
            seqs.push(seq);
            return body;
          })
        : connection.read(path);
    const emphasisView = callbacks.onEmphasis === undefined ? null : (callbacks.viewOnScreen?.() ?? null);

    const inventory =
      callbacks.onInventory === undefined
        ? undefined
        : readAt("api/diagrams").then((body) => {
            const views = parseInventory(body);
            if (views === undefined) {
              throw new Error("response did not contain an inventory");
            }
            return views;
          });
    const compile =
      callbacks.onCompileStatus === undefined
        ? undefined
        : readAt("api/compile").then((body) => {
            const failures = parseCompileStatus(body);
            if (failures === undefined) {
              throw new Error("response did not contain a compile status");
            }
            return failures;
          });
    // Read off the same body as the presentation: a bootstrap that says
    // nothing about them says the page has none.
    let capabilities: Capabilities | undefined;
    let recovery: { selection: unknown; envelope: unknown } | undefined;
    const presentation = readAt("api/bootstrap").then((snapshot) => {
      capabilities = parseCapabilities(snapshot);
      const record = selectionRecord(snapshot);
      const restored = selectionRecord(record?.recovery);
      if (restored !== undefined && "selection" in restored && "envelope" in restored) {
        recovery = { selection: restored.selection, envelope: restored.envelope };
      }
      if (isNothingPresented(snapshot)) {
        return null;
      }
      const message = presentationMessage(snapshot);
      if (message === undefined) {
        throw new Error("response did not contain a presentation snapshot");
      }
      return message;
    });
    const emphasis =
      emphasisView === null
        ? undefined
        : readAt(`api/emphasis/${encodeURIComponent(emphasisView)}`).then((body) => {
            const snapshot = parseEmphasisSnapshot(body);
            if (snapshot === undefined) {
              throw new Error("response did not contain an emphasis snapshot");
            }
            return snapshot;
          });

    void Promise.allSettled([inventory, compile, presentation, emphasis]).then(
      ([inventoryRead, compileRead, presentationRead, emphasisRead]) => {
        if (closed || mine !== reconciles) {
          return;
        }
        let complete = true;

        if (inventoryRead.status === "rejected") {
          complete = false;
          report("inventory", inventoryRead.reason);
          callbacks.onInventoryError?.();
        } else if (inventoryRead.value !== undefined && arrived.inventory === before.inventory) {
          callbacks.onInventory?.(inventoryRead.value);
        }

        // A failed read claims nothing. "Nothing is failing" would be a
        // statement about files this page could not ask about.
        if (compileRead.status === "rejected") {
          complete = false;
          report("compile status", compileRead.reason);
        } else if (compileRead.value !== undefined && arrived.compile === before.compile) {
          callbacks.onCompileStatus?.(compileRead.value);
        }

        if (capabilities !== undefined) {
          callbacks.onCapabilities?.(capabilities);
        }

        if (presentationRead.status === "rejected") {
          complete = false;
          report("bootstrap", presentationRead.reason);
          callbacks.onBootstrapError?.();
        } else if (arrived.presentation === before.presentation) {
          const message = presentationRead.value;
          // What the page already holds is not said again: see `presentationKey`.
          if (presentationKey(message) !== presented) {
            if (message === null) {
              presented = "null";
              callbacks.onClear();
            } else {
              present(!initialized && callbacks.onRecovery !== undefined ? { ...message, initial: true } : message);
            }
          }
          if (!initialized) {
            initialized = true;
            if (recovery !== undefined) callbacks.onRecovery?.(recovery);
          }
        }

        // A newer stream presentation also consumes initial recovery: it must
        // never be replayed later merely because this old read was discarded.
        if (presentationRead.status === "fulfilled") initialized = true;

        if (emphasisRead.status === "rejected") {
          complete = false;
          // Emphasis is an addition to the diagram, not a precondition for it:
          // the drawing stays, and the page does not yet call itself current.
          report("emphasis", emphasisRead.reason);
        } else if (emphasisRead.value !== undefined && arrived.emphasis === before.emphasis) {
          callbacks.onEmphasis?.(emphasisRead.value);
        }

        if (stream === null) {
          connectRead.done = true;
          connectRead.complete = complete;
          connectRead.seq =
            seqs.length === 0 || seqs.some((seq) => seq === null) ? null : Math.min(...(seqs as number[]));
          checkAdopted();
          // A stream opened while this read was out and took it as its own.
          if (connectRead.adopted === null) return;
        }
        const reporting = stream ?? connectRead.adopted;
        if (reporting !== streamEpoch || !streamOpen) {
          return;
        }
        if (complete) {
          callbacks.onConnection?.("connected");
          return;
        }
        callbacks.onConnection?.("unsynced");
        retry = setTimeout(() => {
          retry = undefined;
          if (!closed && streamOpen && reporting === streamEpoch) {
            reconcile(reporting);
          }
        }, RECONCILE_RETRY_MS);
      },
    );
  };

  const connection = createHttpConnection((status) => {
    // "lost" is transient: the connection reconnects by itself and the page's status says so. Only
    // giving up for good is worth a console line.
    if (status !== "lost") console.warn("[archer] HTTP bridge event stream gave up", status);
    streamOpen = false;
    connectRead.standing = null;
    streamEpoch += 1;
    // Neither an old read nor its failure belongs to the recovered stream.
    reconciles += 1;
    if (retry !== undefined) {
      clearTimeout(retry);
      retry = undefined;
    }
    // Who listens is no longer known: a "Listening" line would outlive the agent it names (C12).
    announceListeners(LISTENERS_LOST);
    callbacks.onConnection?.(status);
  });
  const events = connection.events;
  // ADR 0028: which files changed, for the transient "<file> updated" popup (never the inbox).
  listenForFileUpdates(events, (error) => report("files event", error));
  events.addEventListener("documents", () => {
    markProjectCatalogStale();
    callbacks.onDocuments?.();
  });
  events.addEventListener("compile", (event) => {
    try {
      const failures = parseCompileStatus(JSON.parse((event as MessageEvent<string>).data));
      if (failures === undefined) {
        throw new Error("event did not contain a compile status");
      }
      arrived.compile += 1;
      callbacks.onCompileStatus?.(failures);
    } catch (error) {
      report("compile event", error);
    }
  });
  events.addEventListener("inventory", (event) => {
    try {
      const views = parseInventory(JSON.parse((event as MessageEvent<string>).data));
      if (views === undefined) {
        throw new Error("event did not contain an inventory");
      }
      arrived.inventory += 1;
      callbacks.onInventory?.(views);
    } catch (error) {
      report("inventory event", error);
    }
  });
  events.addEventListener("emphasis", (event) => {
    try {
      const snapshot = parseEmphasisSnapshot(JSON.parse((event as MessageEvent<string>).data));
      if (snapshot === undefined) {
        throw new Error("event did not contain an emphasis snapshot");
      }
      arrived.emphasis += 1;
      emphasisArrived.set(snapshot.viewId, (emphasisArrived.get(snapshot.viewId) ?? 0) + 1);
      callbacks.onEmphasis?.(snapshot);
    } catch (error) {
      // A malformed emphasis is not a reason to drop the diagram: what is
      // drawn is still a true picture of what it claims.
      report("emphasis event", error);
    }
  });
  events.addEventListener("presentation", (event) => {
    try {
      const snapshot: unknown = JSON.parse((event as MessageEvent<string>).data);
      const message = presentationMessage(snapshot);
      if (message === undefined) {
        throw new Error("event did not contain a presentation snapshot");
      }
      arrived.presentation += 1;
      // Only when named: an event is a delta, and one without them says
      // nothing about what the server supports.
      if (typeof snapshot === "object" && snapshot !== null && "capabilities" in snapshot) {
        callbacks.onCapabilities?.(parseCapabilities(snapshot));
      }
      // Always applied, even when it repeats what the page holds: an event is
      // the agent presenting, and presenting the same thing again is how it
      // takes the page back from a tab the reader picked.
      present(message);
    } catch (error) {
      report("presentation event", error);
    }
  });
  events.addEventListener("comments", (event) => {
    try {
      const changed: unknown = JSON.parse((event as MessageEvent<string>).data);
      const target = (changed as { target?: unknown } | null)?.target;
      if (!isTargetRef(target)) {
        throw new Error("event did not name a comments target");
      }
      callbacks.onComments?.({ target });
    } catch (error) {
      report("comments event", error);
    }
  });
  events.addEventListener("notes", (event) => {
    try {
      const changed: unknown = JSON.parse((event as MessageEvent<string>).data);
      if (typeof changed !== "object" || changed === null) {
        throw new Error("event was not a notes change");
      }
      const viewId = (changed as { viewId?: unknown }).viewId;
      callbacks.onNotes?.(typeof viewId === "string" ? { viewId } : {});
    } catch (error) {
      report("notes event", error);
    }
  });
  events.addEventListener("walkthroughs", (event) => {
    try {
      const viewId = (JSON.parse((event as MessageEvent<string>).data) as { viewId?: unknown } | null)?.viewId;
      if (typeof viewId !== "string" || viewId === "") throw new Error("event did not name a view");
      callbacks.onWalkthroughs?.({ viewId });
    } catch (error) {
      report("walkthroughs event", error);
    }
  });
  events.addEventListener("note-emphasis", (event) => {
    try {
      const changed: unknown = JSON.parse((event as MessageEvent<string>).data);
      const notePath = (changed as { notePath?: unknown } | null)?.notePath;
      if (typeof notePath !== "string" || notePath === "") throw new Error("event did not name a note");
      callbacks.onNotes?.({ notePath });
    } catch (error) {
      report("note-emphasis event", error);
    }
  });
  // Phase 3: a view recompiled, with what changed (`change.ts`).
  events.addEventListener("change", (event) => {
    try {
      const change = parseChange(JSON.parse((event as MessageEvent<string>).data));
      if (change === undefined) {
        throw new Error("event did not contain a change");
      }
      callbacks.onChange?.(change);
    } catch (error) {
      report("change event", error);
    }
  });
  // Who listens for the chat (ADR 0035 §8): handed on to the chat as a window event, unread here.
  events.addEventListener(LISTENER_EVENT, (event) => {
    try {
      announceListeners(JSON.parse((event as MessageEvent<string>).data) as unknown);
    } catch (error) {
      report("listeners event", error);
    }
  });
  events.onopen = () => {
    streamOpen = true;
    streamEpoch += 1;
    // The stream replays nothing: whoever shows the listeners reads them again.
    announceListeners(null);
    // The first open does not read what the connect read just read (and is still reading, or finished
    // under a second ago). Opening after it began means nothing changed that this stream would have said.
    // A read the service numbered has no age limit: the stream's standing count says whether anything was
    // published after it (`checkAdopted`). Only an unnumbered one is trusted for a second at most; under load
    // the stream opened later than that and every standing read was asked twice (O1).
    const fresh = !connectRead.done || connectRead.complete;
    const numbered = connectRead.done && connectRead.complete && connectRead.seq !== null;
    if (
      connectRead.startedAt > 0 &&
      fresh &&
      (numbered || Date.now() - connectRead.startedAt < ADOPT_WITHIN_MS) &&
      connectRead.mine === reconciles
    ) {
      connectRead.startedAt = 0;
      connectRead.adoptedBy = streamEpoch;
      if (connectRead.done) {
        callbacks.onConnection?.("connected");
        checkAdopted();
        return;
      }
      connectRead.adopted = streamEpoch;
      return;
    }
    connectRead.startedAt = 0;
    reconcile(streamEpoch);
  };
  // No `events.onerror` log: a dropped stream (a restart, a network blip, the page navigating away)
  // reconnects on its own, and every page view used to end with one console error for it (G12).
  // The service's first event on a stream: the publication count it was taken at (see `checkAdopted`).
  events.addEventListener("standing", (event) => {
    try {
      const seq = (JSON.parse((event as MessageEvent<string>).data) as { seq?: unknown } | null)?.seq;
      if (typeof seq !== "number" || !Number.isSafeInteger(seq))
        throw new Error("event did not name a publication count");
      connectRead.standing = seq;
      checkAdopted();
    } catch (error) {
      report("standing event", error);
    }
  });

  // The last few views read by GET, with their ETags (`api/diagrams/<id>`): a re-read
  // sends `if-none-match`, and a 304 hands back the copy held here, unparsed and unchanged.
  const heldViews = new Map<string, { etag: string; envelope: unknown }>();
  async function readView(viewId: string): Promise<{ changed: boolean; envelope: unknown }> {
    const held = heldViews.get(viewId);
    let answer: Awaited<ReturnType<typeof connection.readConditional>>;
    try {
      answer = await connection.readConditional(`api/diagrams/${encodeURIComponent(viewId)}`, held?.etag ?? null);
    } catch (error) {
      throw new Error(`request for view ${viewId} failed`, { cause: error });
    }
    heldViews.delete(viewId);
    if (answer.status === 304 && held !== undefined) {
      heldViews.set(viewId, held);
      return { changed: false, envelope: held.envelope };
    }
    if (answer.etag !== null) {
      heldViews.set(viewId, { etag: answer.etag, envelope: answer.body });
      if (heldViews.size > HELD_VIEWS) heldViews.delete(heldViews.keys().next().value!);
    }
    return { changed: true, envelope: answer.body };
  }

  reconcile(null);
  connectRead.startedAt = Date.now();
  connectRead.mine = reconciles;

  return {
    mode,
    async fetchEmphasis(viewId: string): Promise<unknown> {
      const before = emphasisArrived.get(viewId) ?? 0;
      let body: unknown;
      try {
        body = await connection.read(`api/emphasis/${encodeURIComponent(viewId)}`);
      } catch (error) {
        throw new Error(`request for emphasis on ${viewId} failed`, { cause: error });
      }
      // An event for this view landed while the read was out: the read is older, and would empty
      // highlights the agent set just after the page turned to the view (O41).
      return (emphasisArrived.get(viewId) ?? 0) === before ? body : null;
    },
    async fetchView(viewId: string): Promise<unknown> {
      return (await readView(viewId)).envelope;
    },
    async refreshView(viewId: string): Promise<unknown> {
      const read = await readView(viewId);
      return read.changed ? read.envelope : null;
    },
    disconnect(): void {
      // The selection the person last made goes before the connection does.
      selections.dispose();
      globalThis.removeEventListener?.("pagehide", flushSelection);
      closed = true;
      if (retry !== undefined) {
        clearTimeout(retry);
        retry = undefined;
      }
      connection.disconnect();
    },
    setSelection(context: unknown): void {
      const selection = selectionRecord(context);
      if (selection === undefined || !connection.canSend() || !streamOpen) {
        return;
      }
      // Throttled, in order, deduplicated (selection-sender.ts): live state, not a request per keypress.
      selections.update(
        selection,
        `${String(selection["viewId"])}@${String(selection["revision"] ?? selection["modelRevision"] ?? "")}`,
      );
    },
  };
}

/**
 * Connects to the MCP Apps host using the standardized postMessage protocol.
 * Safe to call only in a browser context (guards internally for SSR/tests).
 */
export function connectBridge(callbacks: BridgeCallbacks): Bridge {
  if (runtime.connect !== undefined) return runtime.connect(callbacks);
  if (typeof window === "undefined") {
    return {
      mode: hostMode(),
      disconnect: () => {},
      setSelection: () => {},
      fetchView: () => Promise.reject(new Error("no host to read a view from")),
      fetchEmphasis: () => Promise.reject(new Error("no host to read emphasis from")),
    };
  }

  if (BUILT_FOR !== "mcp" && hostMode() === "web") {
    return connectHttpBridge(callbacks);
  }
  if (BUILT_FOR === "web") {
    // Opened outside a browser tab (an MCP host loading the web build): this file has no host transport.
    console.error("[archer] this is the browser page; an MCP host loads the MCP App build (ui/dist/mcp/index.html)");
    return {
      mode: "mcp",
      disconnect: () => {},
      setSelection: () => {},
      fetchView: () => Promise.reject(new Error("the browser page has no MCP host transport")),
      fetchEmphasis: () => Promise.reject(new Error("the browser page has no MCP host transport")),
    };
  }

  // The MCP Apps SDK (and zod, ~300 KB) is evaluated only inside an MCP host:
  // the web page never runs it (perf #3).
  const appReady: Promise<McpApp> = import("@modelcontextprotocol/ext-apps").then(({ App }) => {
    const app = new App({ name: "Archer", version: "0.1.0" }, {}, { autoResize: false, strict: true });

    app.addEventListener("toolresult", (result: McpUiToolResultNotification["params"]) => {
      // First, and whatever else the result is: `present_diagram` and
      // `write_diagram` both carry it beside their own payload. Before the
      // presentation for the reason the server sends the event first -- a new
      // drawing must not land under a notice calling it an old one.
      const failures = compileStatusOf(toolPayload(result));
      if (failures !== undefined) {
        callbacks.onCompileStatus?.(failures);
      }
      const message = presentationMessage(toolPayload(result));
      if (message !== undefined) {
        dispatch(message, callbacks);
        // present_diagram can set an emphasis in the same call: after the page turns to its view.
        const set = parseEmphasisSnapshot(selectionRecord(toolPayload(result))?.emphasisSnapshot);
        if (set !== undefined) {
          callbacks.onEmphasis?.(set);
        }
        return;
      }
      // This transport has no server push, so `set_emphasis` carries its own
      // result back the same way `present_diagram` does. Checked second: a
      // presentation snapshot has neither key, so the two cannot be confused.
      const snapshot = parseEmphasisSnapshot(toolPayload(result));
      if (snapshot !== undefined) {
        callbacks.onEmphasis?.(snapshot);
      }
    });

    return app;
  });

  const connectionReady = appReady
    .then((app) => app.connect())
    .then(
      () => {
        callbacks.onConnection?.("connected");
        return true;
      },
      (error: unknown) => {
        reportBridgeError("connection", error);
        callbacks.onConnection?.("lost");
        return false;
      },
    );

  return {
    mode: "mcp",
    async fetchView(viewId: string): Promise<unknown> {
      if (!(await connectionReady)) throw new Error("MCP host is unavailable");
      const result = await (await appReady).callServerTool({ name: "read_diagram", arguments: { viewId } });
      const payload = selectionRecord(toolPayload(result));
      if (result.isError || payload?.envelope == null) throw new Error(`no compiled model for view ${viewId}`);
      return payload.envelope;
    },
    async fetchEmphasis(viewId: string): Promise<unknown> {
      if (!(await connectionReady)) throw new Error("MCP host is unavailable");
      const result = await (await appReady).callServerTool({ name: "list_emphases", arguments: { viewId } });
      const payload = selectionRecord(toolPayload(result));
      const views = payload?.views;
      const snapshot = Array.isArray(views)
        ? views.find((view) => parseEmphasisSnapshot(view)?.viewId === viewId)
        : undefined;
      if (result.isError || snapshot === undefined) throw new Error(`no emphasis snapshot for view ${viewId}`);
      return snapshot;
    },
    disconnect(): void {
      void appReady.then((app) => app.close()).catch((error: unknown) => reportBridgeError("disconnect", error));
    },
    setSelection(context: unknown): void {
      const selection = selectionRecord(context);
      if (selection === undefined) {
        return;
      }

      void connectionReady.then(async (connected) => {
        if (!connected) {
          return;
        }
        try {
          const app = await appReady;
          await Promise.all([
            app.updateModelContext({ structuredContent: selection }),
            app.callServerTool({ name: "set_selection", arguments: selection }),
          ]);
        } catch (error) {
          reportBridgeError("selection publication", error);
        }
      });
    },
  };
}

/**
 * A bridge implementation for tests and non-browser hosts: callers push
 * messages directly via `deliver` instead of going through `postMessage`.
 */
export function createStandaloneBridge(callbacks: BridgeCallbacks): {
  deliver: (msg: BridgeMessage) => void;
  setSelection: (context: unknown) => void;
  getSelection: () => unknown;
} {
  let lastSelection: unknown;

  return {
    deliver(msg: BridgeMessage): void {
      dispatch(msg, callbacks);
    },
    setSelection(context: unknown): void {
      lastSelection = context;
    },
    getSelection(): unknown {
      return lastSelection;
    },
  };
}
