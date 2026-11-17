import { runtime } from "./runtime.ts";
import { browserFetch, browserResourceUrl, onUnansweredWrite } from "./browser-resource";
import { awaitFileRouteEntry, eventSeqOf, fileRouteReading, takeFileRouteEntry } from "./file-route-reads";
import { observeApplicationVersion } from "./application-update";
import { observeNetworkAccess, parseNetworkAccess, type NetworkAccess } from "./network-access";
import { withPollTag, type PollTag } from "./polls";
/** Transport recovery owns stream lifetimes; the bridge owns state reconciliation. */
export type RecoveryStatus = "lost" | "incompatible" | "access-required";
export const HTTP_READ_DEADLINE_MS = 10000;
export const HEARTBEAT_STALL_MS = 45000;
export const RECONNECT_MAX_MS = 30000;
/**
 * A tab coming back to the front keeps its stream when the stream proved itself alive this recently
 * (opened, or a heartbeat or event arrived): one heartbeat interval and some slack. Replacing it would
 * read the whole page again (~13 requests) for nothing (perf #10); the re-armed watchdog still catches a
 * stream that died since, as in the foreground.
 */
export const HEARTBEAT_FRESH_MS = 20000;
/**
 * A planned hand-over (`archer restart`, ADR 0032): the service sends `event: reconnect` and ends the
 * stream, and its replacement binds the same address within well under a second. The page tries again
 * after this long (then every 250-500 ms, with no backoff growth) and says nothing about it...
 */
export const HANDOVER_RETRY_MS = 250;
/** ...for this long. A replacement that has not proved itself by then is an ordinary lost connection. */
export const HANDOVER_GRACE_MS = 10000;
/**
 * A data read that failed at the network (no answer at all, or none within its deadline), or a write that got no
 * answer (`onUnansweredWrite`), is evidence the
 * connection is gone, but one such failure is not proof (a request dropped by a network change, a slow
 * answer): the page asks the service once more, this briefly, and reports "lost" only when that fails too.
 * A browser that says it is offline needs no second opinion. The event stream would say so itself only
 * after a heartbeat stall (45 s), and Chromium's offline mode keeps an open stream alive (O68).
 */
export const NETWORK_PROBE_MS = 5000;

class HttpFailure extends Error {
  /** `retryAfterMs`: the service's own `Retry-After` (whole seconds), when it named one. */
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`request failed with HTTP ${status}`);
  }
}
function retryAfterOf(response: Response): number | undefined {
  const seconds = Number(response.headers?.get("retry-after") ?? "");
  return Number.isInteger(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}
class InvalidJson extends Error {}

class TerminalFailure extends Error {
  constructor(readonly status: "incompatible" | "access-required") {
    super(status);
  }
}

/** Only the explicitly negotiated route is extensible. Existing payload parsers stay strict. */
export function parseBrowserConnection(body: unknown):
  | {
      heartbeat: boolean;
      epoch: string;
      applicationVersion: string;
      capabilities: readonly string[];
      networkAccess?: NetworkAccess;
    }
  | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const value = body as Record<string, unknown>;
  if (
    !Array.isArray(value.supportedBrowserProtocolMajors) ||
    value.supportedBrowserProtocolMajors.length > 8 ||
    !value.supportedBrowserProtocolMajors.every((major) => Number.isInteger(major) && major > 0 && major <= 100) ||
    !value.supportedBrowserProtocolMajors.includes(1) ||
    value.browserProtocolMajor !== 1 ||
    value.semanticSchemaVersion !== 2 ||
    typeof value.serverEpoch !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.serverEpoch) ||
    typeof value.applicationVersion !== "string" ||
    value.applicationVersion.length > 128 ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > 64 ||
    !value.capabilities.every((capability) => typeof capability === "string" && capability.length <= 64)
  )
    return undefined;
  const heartbeat = value.capabilities.includes("heartbeat");
  // The v1 watchdog expects the promised 15-second heartbeat cadence.
  if (heartbeat && value.heartbeatIntervalMs !== 15000) return undefined;
  // Optional and informational: a malformed one is ignored, never a reason to refuse the connection.
  const networkAccess = parseNetworkAccess(value.networkAccess);
  return {
    heartbeat,
    epoch: value.serverEpoch,
    applicationVersion: value.applicationVersion,
    capabilities: value.capabilities as string[],
    ...(networkAccess === undefined ? {} : { networkAccess }),
  };
}

export type HttpConnectionOptions = {
  /** Every successful negotiation's `applicationVersion` (default: the page-wide update check). */
  readonly onApplicationVersion?: (version: string) => void;
};

export interface HttpConnection {
  readonly events: {
    onopen: ((event: Event) => void) | null;
    onerror: ((event: Event) => void) | null;
    addEventListener(type: string, listener: (event: Event) => void): void;
  };
  read(path: string): Promise<unknown>;
  readNumbered(path: string): Promise<{ body: unknown; seq: number | null }>;
  readConditional(
    path: string,
    etag: string | null,
    tag?: PollTag,
  ): Promise<{
    status: 200 | 304;
    etag: string | null;
    body: unknown;
    seq: number | null;
  }>;
  canSend(): boolean;
  leaving(): boolean;
  disconnect(): void;
}

export function createHttpConnection(
  onStatus: (status: RecoveryStatus) => void,
  options: HttpConnectionOptions = {},
): HttpConnection {
  if (runtime.connection !== undefined) return runtime.connection(onStatus);
  const onApplicationVersion = options.onApplicationVersion ?? observeApplicationVersion;
  let closed = false;
  let terminal = false;
  let generation = 0;
  let attempt = 0;
  let source: EventSource | undefined;
  /**
   * The page is going away (`beforeunload`/`pagehide`, until a `pageshow`): the browser drops the
   * stream and any read in flight, and that is not a failure to report. It still reconnects, quietly,
   * in case the navigation was cancelled.
   */
  let leaving = false;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  /**
   * The generation a retry is asking the service at (no timer pending, no stream open), and whether a wake
   * started it. A wake (`online`, a tab in front) during a backoff retry starts a fresh attempt at once and
   * retires the old one, whose read went out before the wake and may sit out a timeout (O297).
   */
  let recoveringAt: number | undefined;
  let recoveryWoken = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  /**
   * Set while a planned hand-over is in its grace window (the timer ends it): stream failures in it
   * are part of the hand-over, not a lost connection. It ends quietly once a replacement stream has
   * been negotiated and has spoken (its `standing` event or a heartbeat), and loudly at the deadline.
   */
  let handover: ReturnType<typeof setTimeout> | undefined;
  let handoverTries = 0;
  let heartbeatEnabled = false;
  let heartbeatEpoch: string | undefined;
  /** When the negotiated stream last proved itself alive: its open, a heartbeat or an event. */
  let heardAt: number | undefined;
  let negotiatedGeneration: number | undefined;
  let buffered: { type: string; event: Event }[] = [];
  let bufferedBytes = 0;
  const requests = new Set<AbortController>();
  const listeners = new Map<string, ((event: Event) => void)[]>();
  const events = {
    onopen: null as ((event: Event) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    addEventListener(type: string, listener: (event: Event) => void) {
      const existing = listeners.get(type);
      listeners.set(type, [...(existing ?? []), listener]);
      if (existing === undefined && source !== undefined) attach(source, type, generation);
    },
  };
  function abortReads() {
    for (const request of requests) request.abort();
  }
  let probing = false;
  const browserOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
  /**
   * A read failed at the network while stream `mine` was current (see `NETWORK_PROBE_MS`). A stream that is
   * already being replaced, a page leaving, or a hand-over in its grace window says nothing more.
   */
  function suspectLost(mine: number) {
    if (closed || terminal || leaving || handover !== undefined || mine !== generation || source === undefined) return;
    if (browserOffline()) {
      fail(new Error("browser is offline"));
      return;
    }
    if (probing) return;
    probing = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Bounded even if fetch ignores its signal, as every read here is.
    const silent = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, NETWORK_PROBE_MS);
    });
    const answer = browserFetch("api/connection", { cache: "no-store", signal: controller.signal }).then(
      (response) => response.status > 0,
      () => false,
    );
    void Promise.race([answer, silent]).then((answered) => {
      clearTimeout(timer);
      probing = false;
      if (!answered && mine === generation) fail(new Error("the service did not answer"));
    });
  }
  async function read(path: string): Promise<unknown> {
    return (await readConditional(path, null)).body;
  }
  /** A read with the service's publication count it was answered at (`seq`, null when the service names none). */
  async function readNumbered(path: string): Promise<{ body: unknown; seq: number | null }> {
    const { body, seq } = await readConditional(path, null);
    return { body, seq };
  }
  /**
   * A read that may answer "unchanged": with `etag` (the ETag of the copy the page holds) the request
   * carries `if-none-match`, and a 304 resolves with no body (nothing is parsed). Still `no-store`:
   * the page keeps its own copy, the browser cache keeps none.
   */
  async function readConditional(
    path: string,
    etag: string | null,
    poll?: PollTag,
  ): Promise<{ status: 200 | 304; etag: string | null; body: unknown; seq: number | null }> {
    if (closed || terminal) throw new Error("connection is closed");
    // The file route read this listing (or the open diagram) a moment ago, or is reading it: take it once.
    const url = browserResourceUrl(path);
    let handed = takeFileRouteEntry(url);
    if (handed === undefined && fileRouteReading(url)) {
      handed = await awaitFileRouteEntry(url);
      if (closed || terminal) throw new Error("connection is closed");
    }
    if (handed !== undefined) return { status: 200, etag: handed.etag, body: handed.body, seq: handed.seq };
    const controller = new AbortController();
    requests.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const mine = generation;
    const expired = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("request aborted or timed out")), {
        once: true,
      });
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, HTTP_READ_DEADLINE_MS);
    });
    try {
      const request = (async () => {
        let response: Response;
        try {
          response = await browserFetch(
            path,
            withPollTag(
              {
                cache: "no-store",
                signal: controller.signal,
                ...(etag === null ? {} : { headers: { "if-none-match": etag } }),
              },
              poll,
            ),
          );
        } catch (error) {
          // No answer at all (fetch's TypeError, not a cancel this page asked for): the network, or the service, may be gone.
          if (error instanceof TypeError && !controller.signal.aborted) suspectLost(mine);
          throw error;
        }
        const tag = response.headers?.get("etag") ?? null;
        const seq = eventSeqOf(response);
        if (response.status === 304 && etag !== null)
          return { status: 304 as const, etag: tag ?? etag, body: undefined, seq };
        if (!response.ok) throw new HttpFailure(response.status, retryAfterOf(response));
        try {
          return { status: 200 as const, etag: tag, body: (await response.json()) as unknown, seq };
        } catch (error) {
          if (error instanceof SyntaxError) throw new InvalidJson("invalid JSON response");
          throw error;
        }
      })();
      return await Promise.race([request, expired]);
    } catch (error) {
      if (timedOut) suspectLost(mine);
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      requests.delete(controller);
    }
  }
  async function negotiate(): Promise<{ heartbeat: boolean; epoch: string }> {
    try {
      const info = parseBrowserConnection(await read("api/connection"));
      if (info === undefined) throw new TerminalFailure("incompatible");
      onApplicationVersion(info.applicationVersion);
      observeNetworkAccess(info.networkAccess ?? null);
      return info;
    } catch (error) {
      if (error instanceof InvalidJson) throw new TerminalFailure("incompatible");
      // Every service since the first public release (0.15.0) answers this route, and refused access is hidden
      // as a bare 404 (ADR 0015): a 404 here is access that is no longer granted.
      if (error instanceof HttpFailure && [401, 403, 404].includes(error.status))
        throw new TerminalFailure("access-required");
      throw error;
    }
  }
  function clearWatchdog() {
    if (watchdog !== undefined) clearTimeout(watchdog);
    watchdog = undefined;
  }
  function armWatchdog() {
    clearWatchdog();
    if (!heartbeatEnabled || closed || terminal || (typeof document !== "undefined" && document.hidden)) return;
    const mine = generation;
    watchdog = setTimeout(() => {
      if (mine === generation) fail(new Error("event stream heartbeat stalled"));
    }, HEARTBEAT_STALL_MS);
  }
  function attach(current: EventSource, type: string, mine: number) {
    current.addEventListener(type, (event) => {
      if (closed || terminal || generation !== mine) return;
      if (negotiatedGeneration !== mine) {
        const size = typeof (event as MessageEvent).data === "string" ? (event as MessageEvent<string>).data.length : 0;
        if (buffered.length >= 64 || bufferedBytes + size > 8 * 1024 * 1024) {
          fail(new Error("event negotiation buffer exceeded"));
          return;
        }
        buffered.push({ type, event });
        bufferedBytes += size;
        return;
      }
      heardAt = Date.now();
      for (const listener of listeners.get(type) ?? []) listener(event);
    });
  }
  function endHandover() {
    if (handover !== undefined) clearTimeout(handover);
    handover = undefined;
    handoverTries = 0;
  }
  function beginHandover() {
    if (handover !== undefined) return;
    handover = setTimeout(() => {
      handover = undefined;
      handoverTries = 0;
      if (closed || terminal) return;
      // A replacement opened and negotiated but has not spoken yet: it is connected, not lost.
      if (source !== undefined && negotiatedGeneration === generation) return;
      onStatus("lost");
      events.onerror?.(new Event("error"));
    }, HANDOVER_GRACE_MS);
  }
  function finish(error: TerminalFailure) {
    terminal = true;
    endHandover();
    generation += 1;
    source?.close();
    negotiatedGeneration = undefined;
    buffered = [];
    bufferedBytes = 0;
    clearWatchdog();
    if (reconnect !== undefined) clearTimeout(reconnect);
    reconnect = undefined;
    abortReads();
    detachWakeListeners();
    onStatus(error.status);
  }
  /**
   * `retryAfterMs`: the service answered and said when to ask again (503 while it drains or reopens
   * its projects after a restart). It is up, so that wait is kept and the backoff does not grow: a
   * dozen seconds of "still opening" otherwise grew it to 8-16 s, and the page said "Reconnecting"
   * for that long after the service was ready (O34).
   */
  function schedule(retryAfterMs?: number) {
    if (closed || terminal || reconnect !== undefined) return;
    if (handover !== undefined) {
      // The replacement is expected at once: the first try after 250 ms, then every 250-500 ms.
      const delay = handoverTries++ === 0 ? HANDOVER_RETRY_MS : HANDOVER_RETRY_MS * (1 + Math.random());
      reconnect = setTimeout(() => {
        reconnect = undefined;
        void recover();
      }, delay);
      return;
    }
    if (retryAfterMs !== undefined) {
      const wait = Math.min(RECONNECT_MAX_MS, Math.max(HANDOVER_RETRY_MS, retryAfterMs));
      reconnect = setTimeout(
        () => {
          reconnect = undefined;
          void recover();
        },
        wait * (1 + Math.random() * 0.25),
      );
      return;
    }
    // Equal jitter avoids synchronized tabs while guaranteeing a finite cap.
    const ceiling = Math.min(RECONNECT_MAX_MS, 500 * 2 ** Math.min(attempt++, 6));
    const delay = ceiling * (0.5 + Math.random() * 0.5);
    reconnect = setTimeout(() => {
      reconnect = undefined;
      void recover();
    }, delay);
  }
  /** `checking`: a deliberate replacement (a tab back in front), not a failure the page reports. */
  function fail(error: Event | Error, checking = false) {
    if (closed || terminal) return;
    generation += 1;
    negotiatedGeneration = undefined;
    buffered = [];
    bufferedBytes = 0;
    heartbeatEnabled = false;
    heartbeatEpoch = undefined;
    heardAt = undefined;
    source?.close();
    source = undefined;
    clearWatchdog();
    abortReads();
    // Inside a planned hand-over's grace window the gap is expected: say nothing, try again soon.
    if (handover === undefined) {
      onStatus("lost");
      if (!checking) events.onerror?.(error instanceof Event ? error : new Event("error"));
    }
    schedule();
  }
  async function recover(woken = false) {
    const mine = generation;
    recoveringAt = mine;
    recoveryWoken = woken;
    const settled = () => {
      if (recoveringAt === mine) recoveringAt = undefined;
    };
    try {
      await negotiate();
      settled();
      if (closed || terminal || mine !== generation) return;
      openSource();
    } catch (error) {
      settled();
      if (closed || terminal || mine !== generation) return;
      if (error instanceof TerminalFailure) finish(error);
      else schedule(error instanceof HttpFailure ? error.retryAfterMs : undefined);
    }
  }
  function openSource() {
    if (closed || terminal) return;
    const mine = ++generation;
    const current = new EventSource(browserResourceUrl("api/events"));
    source = current;
    /** This stream's `standing` event (the service's first): a replacement that speaks ends a hand-over. */
    let spoke = false;
    const spoken = () => {
      spoke = true;
      if (negotiatedGeneration === mine) endHandover();
    };
    for (const type of listeners.keys()) attach(current, type, mine);
    current.addEventListener("reconnect", () => {
      if (!closed && !terminal && mine === generation) beginHandover();
    });
    current.addEventListener("standing", () => {
      if (!closed && !terminal && mine === generation) spoken();
    });
    current.addEventListener("heartbeat", (event) => {
      if (closed || terminal || mine !== generation || !heartbeatEnabled) return;
      try {
        const body: unknown = JSON.parse((event as MessageEvent<string>).data);
        if (
          typeof body !== "object" ||
          body === null ||
          (body as { serverEpoch?: unknown }).serverEpoch !== heartbeatEpoch
        ) {
          fail(new Error("event stream epoch changed"));
          return;
        }
        heardAt = Date.now();
        armWatchdog();
        spoken();
      } catch {
        fail(new Error("invalid event stream heartbeat"));
      }
    });
    current.onopen = (event) => {
      void (async () => {
        try {
          const info = await negotiate();
          if (closed || terminal || mine !== generation) return;
          heartbeatEnabled = info.heartbeat;
          heartbeatEpoch = info.epoch;
          attempt = 0;
          negotiatedGeneration = mine;
          heardAt = Date.now();
          armWatchdog();
          if (spoke) endHandover();
          const pending = buffered;
          buffered = [];
          bufferedBytes = 0;
          for (const item of pending) {
            if (closed || terminal || mine !== generation) return;
            for (const listener of listeners.get(item.type) ?? []) listener(item.event);
          }
          events.onopen?.(event);
        } catch (error) {
          if (closed || terminal || mine !== generation) return;
          if (error instanceof TerminalFailure) finish(error);
          else fail(new Error("connection negotiation failed"));
        }
      })();
    };
    current.onerror = (event) => {
      if (mine === generation) fail(event, leaving);
    };
  }
  const wake = () => {
    if (closed || terminal) return;
    if (typeof document !== "undefined" && document.hidden) {
      clearWatchdog();
      return;
    }
    if (reconnect !== undefined) {
      clearTimeout(reconnect);
      reconnect = undefined;
      void recover(true);
    } else if (recoveringAt === generation) {
      // A backoff retry is out: its read went before this wake. Retire it and try again at once; a retry a wake
      // already started is left to answer.
      if (recoveryWoken) return;
      generation += 1;
      void recover(true);
    } else if (source !== undefined && negotiatedGeneration === generation) {
      if (heartbeatEnabled && heardAt !== undefined && Date.now() - heardAt < HEARTBEAT_FRESH_MS) {
        armWatchdog();
        return;
      }
      fail(new Error("checking resumed event stream"), true);
    }
  };
  /** The browser says the network is gone: say so now, not after a heartbeat stall; `online` recovers. */
  const offline = () => {
    if (!leaving && source !== undefined) fail(new Error("browser went offline"));
  };
  const leave = () => {
    leaving = true;
  };
  const stay = () => {
    leaving = false;
  };
  function detachWakeListeners() {
    stopHearingWrites();
    if (typeof window !== "undefined") {
      window.removeEventListener?.("online", wake);
      window.removeEventListener?.("offline", offline);
      window.removeEventListener?.("beforeunload", leave);
      window.removeEventListener?.("pagehide", leave);
      window.removeEventListener?.("pageshow", stay);
    }
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", wake);
  }
  if (typeof window !== "undefined") {
    window.addEventListener?.("online", wake);
    window.addEventListener?.("offline", offline);
    window.addEventListener?.("beforeunload", leave);
    window.addEventListener?.("pagehide", leave);
    window.addEventListener?.("pageshow", stay);
  }
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", wake);
  // A write the page sent that got no answer is evidence too, checked like a failed read (one probe, then "lost").
  const stopHearingWrites = onUnansweredWrite(() => suspectLost(generation));
  openSource();
  return {
    events,
    read,
    readNumbered,
    readConditional,
    canSend: () => !closed && !terminal,
    /** The page is unloading: what fails now is the browser tidying up, not a fault to log. */
    leaving: () => leaving,
    disconnect() {
      if (closed) return;
      closed = true;
      generation += 1;
      negotiatedGeneration = undefined;
      buffered = [];
      bufferedBytes = 0;
      listeners.clear();
      source?.close();
      clearWatchdog();
      endHandover();
      if (reconnect !== undefined) clearTimeout(reconnect);
      abortReads();
      detachWakeListeners();
    },
  };
}
