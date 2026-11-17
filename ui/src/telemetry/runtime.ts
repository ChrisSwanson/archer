/**
 * Browser telemetry for debug builds (docs/devkit/CONTRACT.md, docs/devkit/browser-telemetry.md).
 *
 * Loaded only by `main.tsx` behind `__ARCHER_DEBUG__`, before the app renders, so every request the
 * app makes goes through the wrapped `fetch`. Nothing here changes what the page does: errors are
 * recorded and passed on, requests are timed and returned untouched.
 */
import type { RootOptions } from "react-dom/client";
import { setTelemetrySink, type TelemetryReport } from "./dev";
import { RequestTracker, parseServerTiming, shortUrl, urlPattern, type RequestRecord } from "./requests";
import { Transport, eventsUrl, type TelemetryEvent } from "./transport";
import { observeVitals, type VitalsObserver } from "./vitals";
import { redact, redactText, redactUrl, withoutTrailingRun } from "./redact";

export interface ArcherTelemetry {
  events(): TelemetryEvent[];
  warnings(): TelemetryEvent[];
  requests(): RequestRecord[];
  vitals(): Record<string, number>;
  clear(): void;
  /** Send what is queued now (also every 2 s and on pagehide). */
  flush(): Promise<void>;
}

declare global {
  interface Window {
    __archerTelemetry?: ArcherTelemetry;
  }
}

const KEEP_EVENTS = 2000;
const LONG_TASK_WARN_MS = 200;
/** Query parameters that name a different page (the rest are filters and scroll state). */
const PAGE_PARAMS = ["tab", "edit", "view", "note", "folder"];

/** The page view a location names: its path and the parameters that change the page. */
export function pageKey(href: string): string {
  try {
    const url = new URL(href);
    const kept = PAGE_PARAMS.filter((name) => url.searchParams.has(name)).map((name) => {
      const value = url.searchParams.get(name) ?? "";
      return value === "" ? name : `${name}=${value}`;
    });
    return `${url.pathname}${kept.length ? `?${kept.join("&")}` : ""}`;
  } catch {
    return href;
  }
}

/** Chrome's and Firefox's wording, then older Chrome's. */
const RESIZE_OBSERVER_LOOP =
  /^(Uncaught )?ResizeObserver loop (completed with undelivered notifications|limit exceeded)/;
/** Distinct CSP violations reported per page load. */
const CSP_KEYS = 64;
/** A CSP address without its query or fragment (`inline`, `eval`, `data` stay as given), then redacted. */
export function cspAddress(value: string | undefined): string {
  if (!value) return "unknown";
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") return redactUrl(`${url.origin}${url.pathname}`);
    return url.protocol.replace(/:$/, "");
  } catch {
    return redactUrl(value);
  }
}

const text = (value: unknown): string => {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};
const stack = (value: unknown): string | undefined =>
  value instanceof Error && value.stack ? value.stack.split("\n").slice(0, 12).join("\n") : undefined;

let started: { rootOptions: RootOptions } | null = null;
let pageLoad: string | null = null;

/**
 * An EventSource can send no headers, so a same-origin stream names this page load in its address (`page-load`)
 * instead: the service counts one client's repeats per page load (svc.duplicate-request), and without it three
 * editors opened within two seconds (one stream each) read as one page opening its stream three times.
 */
export function installEventSourcePageLoad(session: string | null = pageLoad): void {
  const Original = window.EventSource;
  if (typeof Original !== "function" || session === null) return;
  const named = (url: string | URL): string | URL => {
    try {
      const absolute = new URL(String(url), location.href);
      if (absolute.origin !== location.origin) return url;
      absolute.searchParams.set("page-load", session);
      return absolute.href;
    } catch {
      return url;
    }
  };
  window.EventSource = class extends Original {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(named(url), init);
    }
  };
}

/** Install telemetry once; returns the options for `createRoot` that report React's errors. */
export function startTelemetry(): { rootOptions: RootOptions } {
  if (started) return started;
  const originalFetch = window.fetch.bind(window);
  const originalConsoleError = console.error.bind(console);
  // Two groups of 8 hex digits: an unbroken 16-digit run is redacted as a possible grant prefix (C-35).
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => n.toString(16).padStart(2, "0")).join("");
  const session = `${hex.slice(0, 8)}-${hex.slice(8)}`;
  pageLoad = session;
  installEventSourcePageLoad(session);
  const build = (import.meta as { env?: { DEV?: boolean } }).env?.DEV ? "dev-server" : "debug-build";
  const transport = new Transport({
    url: eventsUrl(location.href),
    session,
    build,
    fetch: originalFetch,
    beacon: navigator.sendBeacon ? (url, body) => navigator.sendBeacon(url, body) : undefined,
  });
  const events: TelemetryEvent[] = [];
  let page = pageKey(location.href),
    pageStartedAt = performance.now(),
    pageRequests = 0,
    longTasks = { count: 0, totalMs: 0 };

  const push = (event: TelemetryEvent) => {
    events.push(event);
    if (events.length > KEEP_EVENTS) events.splice(0, events.length - KEEP_EVENTS);
    transport.enqueue(event);
  };
  // Redacted before it is kept or sent: the page's own buffer holds no secret either.
  const report = (r: TelemetryReport) =>
    push({
      at: Date.now(),
      type: r.level,
      code: r.code,
      ...(r.msg === undefined ? {} : { msg: redactText(r.msg, 2000) }),
      ...(r.data === undefined ? {} : { data: redact(r.data) as Record<string, unknown> }),
      page,
    });
  setTelemetrySink(report);
  const requests = new RequestTracker(report);
  const vitals: VitalsObserver = observeVitals();

  // ---- errors: recorded, never swallowed -------------------------------------------------------
  // Errors React reports globally (below) are already recorded as `ui.react-error`.
  const reportedByReact = new WeakSet<object>();
  window.addEventListener("error", (event) => {
    if (typeof event.error === "object" && event.error !== null && reportedByReact.has(event.error)) return;
    // The browser's notice that a resize callback changed layout again: delivered next frame, not a fault.
    if (RESIZE_OBSERVER_LOOP.test(event.message ?? "")) {
      report({ level: "info", code: "ui.resize-observer-loop", msg: event.message });
      return;
    }
    report({
      level: "error",
      code: "ui.page-error",
      msg: event.message || text(event.error),
      data: {
        file: event.filename,
        line: event.lineno,
        column: event.colno,
        ...(stack(event.error) ? { stack: stack(event.error) } : {}),
      },
    });
  });
  // A blocked load or script is otherwise only a console line the page cannot see (perf: CSP-blocked thumbnails).
  const cspSeen = new Set<string>();
  document.addEventListener("securitypolicyviolation", (event) => {
    const directive = event.effectiveDirective || event.violatedDirective || "unknown";
    const blocked = cspAddress(event.blockedURI);
    const key = `${directive}\0${blocked}`;
    if (cspSeen.has(key) || cspSeen.size >= CSP_KEYS) return;
    cspSeen.add(key);
    report({
      level: "warn",
      code: "ui.csp-violation",
      msg: `CSP ${directive} blocked ${blocked}`,
      data: {
        directive,
        blocked,
        ...(event.sourceFile ? { sourceFile: cspAddress(event.sourceFile) } : {}),
        line: event.lineNumber,
        column: event.columnNumber,
        disposition: event.disposition,
      },
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    report({
      level: "error",
      code: "ui.unhandled-rejection",
      msg: text(event.reason),
      data: stack(event.reason) ? { stack: stack(event.reason) } : {},
    });
  });
  // A bound for memory only, well past report's 2000-character limit (applied after redaction).
  // Redaction shortens the text, so what lies near the cut can move under the limit: the cut drops
  // its trailing token-shaped run, as the service's redactText does, so no partial token survives.
  const CONSOLE_CUT = 2000 * 4;
  const cut = (message: string): string =>
    message.length <= CONSOLE_CUT ? message : withoutTrailingRun(message.slice(0, CONSOLE_CUT));
  let inConsole = false;
  console.error = (...args: unknown[]) => {
    if (!inConsole) {
      inConsole = true;
      try {
        report({
          level: "error",
          code: "ui.console-error",
          msg: cut(args.map(text).join(" ")),
          ...(stack(args.find((a) => a instanceof Error))
            ? { data: { stack: stack(args.find((a) => a instanceof Error)) } }
            : {}),
        });
      } finally {
        inConsole = false;
      }
    }
    originalConsoleError(...args);
  };
  const reactError =
    (kind: "uncaught" | "caught" | "recoverable") => (error: unknown, info: { componentStack?: string }) => {
      report({
        level: "error",
        code: "ui.react-error",
        msg: text(error),
        data: {
          kind,
          ...(stack(error) ? { stack: stack(error) } : {}),
          ...(info.componentStack ? { componentStack: info.componentStack.split("\n").slice(0, 15).join("\n") } : {}),
        },
      });
      // Then React's own default, so the error still propagates as it would without telemetry: uncaught
      // and recoverable errors are reported globally (`reportError`: a window `error` event, which
      // test runners see as a page error); caught ones go to the console (not counted twice).
      if (kind !== "caught") {
        if (typeof error === "object" && error !== null) reportedByReact.add(error);
        if (typeof window.reportError === "function") return window.reportError(error);
        // React's own fallback without `reportError`: a cancelable window `error` event, then the console.
        const message =
          typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string"
            ? String((error as { message: string }).message)
            : String(error);
        if (
          typeof window.ErrorEvent === "function" &&
          !window.dispatchEvent(new window.ErrorEvent("error", { bubbles: true, cancelable: true, message, error }))
        )
          return;
      }
      inConsole = true;
      try {
        originalConsoleError(error);
      } finally {
        inConsole = false;
      }
    };
  const rootOptions: RootOptions = {
    onUncaughtError: reactError("uncaught"),
    onCaughtError: reactError("caught"),
    onRecoverableError: reactError("recoverable"),
  };

  // ---- requests ------------------------------------------------------------------------------
  const debugEvents = eventsUrl(location.href);
  const absoluteOf = new WeakMap<RequestRecord, string>();
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const absolute = (() => {
      try {
        return new URL(raw, location.href).href;
      } catch {
        return raw;
      }
    })();
    if (absolute === debugEvents) return originalFetch(input, init);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = shortUrl(absolute, location.origin),
      pattern = urlPattern(absolute, location.origin),
      at = Date.now(),
      start = performance.now(),
      view = page;
    requests.started(
      method,
      url,
      view,
      start,
      method !== "GET" && typeof init?.body === "string" ? init.body : undefined,
    );
    pageRequests += 1;
    // This page load's name on its own requests: the service counts one client's repeats per page load
    // (svc.duplicate-request), since each page of the app reads what it needs once.
    if (absolute.startsWith(`${location.origin}/`)) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set("x-archer-page-load", session);
      // A scheduled poll's tick sets its own `x-archer-poll` (app/polls.ts withPollTag); it is kept as given.
      init = { ...init, headers };
    }
    try {
      const response = await originalFetch(input, init);
      const length = response.headers.get("content-length");
      const serverTiming = parseServerTiming(response.headers.get("server-timing"));
      const requestId = response.headers.get("x-archer-request-id") ?? undefined;
      const record: RequestRecord = {
        at,
        page: view,
        method,
        url,
        pattern,
        status: response.status,
        ms: performance.now() - start,
        bytes: length === null ? null : Number(length),
        ...(serverTiming ? { serverTiming } : {}),
        ...(requestId ? { requestId } : {}),
      };
      absoluteOf.set(record, absolute);
      requests.finished(record);
      return response;
    } catch (failure) {
      // An abort is the page cancelling its own request, not a failure.
      if (!(failure instanceof DOMException && failure.name === "AbortError")) {
        requests.finished({
          at,
          page: view,
          method,
          url,
          pattern,
          status: null,
          ms: performance.now() - start,
          bytes: null,
          error: text(failure),
        });
      }
      throw failure;
    }
  };
  /** Body sizes arrive in resource timing once the body has been read. */
  const fillSizes = (): RequestRecord[] => {
    const records = requests.all();
    for (const record of records) {
      const absolute = absoluteOf.get(record);
      if (record.bytes !== null || absolute === undefined) continue;
      const entry = performance.getEntriesByName(absolute, "resource").at(-1) as PerformanceResourceTiming | undefined;
      if (entry && entry.encodedBodySize > 0) record.bytes = entry.encodedBodySize;
    }
    return records;
  };

  // ---- long tasks ----------------------------------------------------------------------------
  if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.count += 1;
        longTasks.totalMs += entry.duration;
        if (entry.duration > LONG_TASK_WARN_MS)
          report({
            level: "warn",
            code: "ui.long-task",
            msg: `a ${Math.round(entry.duration)} ms task blocked the page`,
            data: { ms: Math.round(entry.duration), startTime: Math.round(entry.startTime), name: entry.name },
          });
      }
    }).observe({ type: "longtask", buffered: true });
  }
  try {
    performance.setResourceTimingBufferSize(2000);
  } catch {
    /* not supported */
  }

  // ---- page views ----------------------------------------------------------------------------
  const resourceSummary = (since: number) => {
    const entries = (performance.getEntriesByType("resource") as PerformanceResourceTiming[]).filter(
      (entry) => entry.startTime >= since && !entry.name.startsWith(debugEvents),
    );
    const byType: Record<string, number> = {};
    let transfer = 0,
      encoded = 0,
      decoded = 0;
    for (const entry of entries) {
      byType[entry.initiatorType] = (byType[entry.initiatorType] ?? 0) + 1;
      transfer += entry.transferSize;
      encoded += entry.encodedBodySize;
      decoded += entry.decodedBodySize;
    }
    const slowest = [...entries]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 5)
      .map((entry) => ({ url: urlPattern(entry.name, location.origin), ms: Math.round(entry.duration) }));
    return {
      count: entries.length,
      transferBytes: transfer,
      encodedBytes: encoded,
      decodedBytes: decoded,
      byType,
      slowest,
    };
  };
  const endPageView = (reason: string) => {
    report({ level: "info", code: "ui.web-vitals", msg: `vitals for ${page}`, data: { ...vitals.current(), reason } });
    report({
      level: "info",
      code: "ui.page-view",
      msg: `page view ${page}`,
      data: {
        reason,
        durationMs: Math.round(performance.now() - pageStartedAt),
        requests: pageRequests,
        longTasks: { count: longTasks.count, totalMs: Math.round(longTasks.totalMs) },
        resources: resourceSummary(pageStartedAt),
        domNodes: document.getElementsByTagName("*").length,
      },
    });
  };
  const beginPageView = (reason: string) => {
    const next = pageKey(location.href);
    if (next === page) return;
    endPageView(reason);
    page = next;
    pageStartedAt = performance.now();
    pageRequests = 0;
    longTasks = { count: 0, totalMs: 0 };
    requests.pageView();
    vitals.pageView();
    push({ at: Date.now(), type: "pageview", code: "ui.page-view-start", msg: page, data: { reason }, page });
  };
  const { pushState, replaceState } = history;
  history.pushState = function (...args: Parameters<History["pushState"]>) {
    pushState.apply(this, args);
    beginPageView("push");
  };
  // A replace corrects the address of the page already shown (canonical paths, filters): same view.
  history.replaceState = function (...args: Parameters<History["replaceState"]>) {
    replaceState.apply(this, args);
    page = pageKey(location.href);
  };
  window.addEventListener("popstate", () => beginPageView("pop"));
  push({ at: Date.now(), type: "pageview", code: "ui.page-view-start", msg: page, data: { reason: "load" }, page });

  // ---- transport -----------------------------------------------------------------------------
  setInterval(() => {
    void transport.flush();
  }, 2000);
  window.addEventListener("pagehide", () => {
    endPageView("pagehide");
    void transport.flush(true);
  });

  window.__archerTelemetry = {
    events: () => [...events],
    warnings: () => events.filter((event) => event.type === "warn" || event.type === "error"),
    requests: () => fillSizes().map((record) => ({ ...record })),
    vitals: () => vitals.current(),
    clear: () => {
      events.length = 0;
      requests.clear();
      pageRequests = 0;
      longTasks = { count: 0, totalMs: 0 };
    },
    flush: () => transport.flush(),
  };
  started = { rootOptions };
  return started;
}
