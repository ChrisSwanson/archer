// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { devReport } from "../src/telemetry/dev";
import { installEventSourcePageLoad, pageKey, startTelemetry } from "../src/telemetry/runtime";

const served: { url: string; init?: RequestInit }[] = [];
const consoleErrors: unknown[][] = [];
const original = { fetch: window.fetch, error: console.error };

beforeAll(() => {
  window.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    served.push({ url, ...(init ? { init } : {}) });
    if (url.includes("/missing")) return new Response("{}", { status: 404 });
    if (url.includes("/offline")) throw new TypeError("Failed to fetch");
    return new Response("{}", {
      status: 200,
      headers: { "content-length": "2", "server-timing": "auth;dur=1, total;dur=7", "x-archer-request-id": "req-1" },
    });
  }) as typeof fetch;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };
  window.history.replaceState(null, "", "/projects/demo/?tab=diagrams&q=search");
  startTelemetry();
});
afterAll(() => {
  window.fetch = original.fetch;
  console.error = original.error;
});

describe("pageKey", () => {
  it.each([
    ["https://h/projects/demo/?tab=diagrams&q=x&sort=-edited", "/projects/demo/?tab=diagrams"],
    ["https://h/projects/demo/diagrams/a.mmd?edit&draftId=drf_1", "/projects/demo/diagrams/a.mmd?edit"],
    ["https://h/projects/", "/projects/"],
  ])("%s → %s", (href, key) => expect(pageKey(href)).toBe(key));
});

describe("page-load header", () => {
  it("names this page load on its own requests, so the service judges duplicates per page, not across a page change", async () => {
    served.length = 0;
    await window.fetch("/p/demo/api/diagrams", { headers: { accept: "application/json" } });
    await window.fetch("https://elsewhere.example/x");
    const header = (i: number) => new Headers(served[i]?.init?.headers).get("x-archer-page-load");
    expect(header(0)).toMatch(/^[a-f0-9]{8}-[a-f0-9]{8}$/);
    expect(new Headers(served[0]?.init?.headers).get("accept")).toBe("application/json");
    expect(header(1)).toBeNull();
  });
});

describe("poll header", () => {
  it("is the caller's own: a tick passes its tag down its fetch path, and the runtime adds none to other requests", async () => {
    served.length = 0;
    let finish: () => void = () => {};
    // A slow tick in flight does not tag an unrelated read made meanwhile (no ambient provenance).
    const slow = window.fetch("/p/demo/api/comment-activity", { headers: { "x-archer-poll": "notifications#1" } }).then(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await window.fetch("/p/demo/api/comments?target=a");
    const header = (i: number) => new Headers(served[i]?.init?.headers).get("x-archer-poll");
    expect([header(0), header(1)]).toEqual(["notifications#1", null]);
    finish();
    await slow;
  });
});

describe("event stream page load", () => {
  it("names this page load in a same-origin stream's address (EventSource sends no headers), so the service tells one page's reconnect from the next page's stream", () => {
    const opened: string[] = [];
    window.EventSource = class {
      constructor(url: string | URL) {
        opened.push(String(url));
      }
    } as unknown as typeof EventSource;
    // The runtime installed its wrapper at start; re-install over the stub.
    installEventSourcePageLoad();
    new window.EventSource("/p/demo/api/events");
    new window.EventSource("https://elsewhere.example/stream");
    const load = new URL(opened[0]!, location.href).searchParams.get("page-load");
    expect(load).toMatch(/^[a-f0-9]{8}-[a-f0-9]{8}$/);
    expect(new URL(opened[0]!, location.href).pathname).toBe("/p/demo/api/events");
    expect(opened[1]).toBe("https://elsewhere.example/stream");
  });
});

describe("window.__archerTelemetry", () => {
  it("has the contract's surface", () => {
    const t = window.__archerTelemetry!;
    for (const name of ["events", "warnings", "requests", "vitals", "clear"] as const)
      expect(typeof t[name]).toBe("function");
    expect(t.vitals()).toHaveProperty("CLS");
  });

  it("records each fetch and returns the response untouched", async () => {
    window.__archerTelemetry!.clear();
    const response = await fetch("/p/demo/api/views?x=1");
    expect(await response.text()).toBe("{}");
    const [record] = window.__archerTelemetry!.requests();
    expect(record).toMatchObject({
      method: "GET",
      url: "/p/demo/api/views?x=1",
      pattern: "/p/demo/api/views?x",
      status: 200,
      bytes: 2,
      requestId: "req-1",
      serverTiming: { auth: 1, total: 7 },
      page: "/",
    });
  });

  it("raises ui.fetch-failed for an error status and a network failure, and still throws", async () => {
    window.__archerTelemetry!.clear();
    expect((await fetch("/p/demo/api/missing")).status).toBe(404);
    await expect(fetch("/p/demo/api/offline")).rejects.toThrow("Failed to fetch");
    expect(window.__archerTelemetry!.warnings().map((e) => e.code)).toEqual(["ui.fetch-failed", "ui.fetch-failed"]);
  });

  it("records console.error and passes it on", () => {
    window.__archerTelemetry!.clear();
    console.error("boom", new Error("bad"));
    expect(consoleErrors.at(-1)?.[0]).toBe("boom");
    const [event] = window.__archerTelemetry!.warnings();
    expect(event).toMatchObject({ type: "error", code: "ui.console-error" });
    expect(event!.msg).toContain("Error: bad");
  });

  it("redacts a console error before cutting it, so no token is left half-cut at the limit", () => {
    window.__archerTelemetry!.clear();
    // A 32-digit token straddling the 2000-character cut: cut first, 31 digits would survive unredacted.
    console.error("g".repeat(1969) + "0123456789abcdef".repeat(2));
    expect(window.__archerTelemetry!.warnings()[0]!.msg).not.toMatch(/[0-9a-f]{16}/);
  });

  it("leaves no partial token where a long console error is cut, even after redaction shortens it", () => {
    // Early tokens shrink to "[redacted]" and pull the text near the pre-cut back under the
    // 2000-character limit: a 32- or 64-digit token straddling the pre-cut must not survive as a
    // token-shaped run.
    for (const token of ["0123456789abcdef".repeat(2), "0123456789abcdef".repeat(4)]) {
      for (let at = 7990; at <= 8010; at += 5) {
        window.__archerTelemetry!.clear();
        const early = Array.from({ length: Math.floor((at - 40) / 65) }, () => "ab".repeat(32)).join(" ");
        console.error(`${early} ${"g".repeat(at - early.length - 1 - 16)}${token} tail`);
        expect(window.__archerTelemetry!.warnings()[0]!.msg!, `${token.length} at ${at}`).not.toMatch(/[0-9a-f]{8}/);
      }
    }
  });

  it("keeps the benign ResizeObserver loop notice as info, not a page error (monkey #7)", () => {
    window.__archerTelemetry!.clear();
    for (const message of [
      "ResizeObserver loop completed with undelivered notifications.",
      "ResizeObserver loop limit exceeded",
    ]) {
      window.dispatchEvent(new ErrorEvent("error", { message }));
    }
    expect(window.__archerTelemetry!.warnings()).toEqual([]);
    expect(window.__archerTelemetry!.events()).toMatchObject([
      { type: "info", code: "ui.resize-observer-loop" },
      { type: "info", code: "ui.resize-observer-loop" },
    ]);
    window.dispatchEvent(new ErrorEvent("error", { message: "Uncaught TypeError: x is undefined" }));
    expect(window.__archerTelemetry!.warnings().map((e) => e.code)).toEqual(["ui.page-error"]);
  });

  it("reports a CSP violation as ui.csp-violation, redacted, once per directive and blocked address", () => {
    window.__archerTelemetry!.clear();
    const token = "b".repeat(64);
    const violation = () =>
      document.dispatchEvent(
        Object.assign(new Event("securitypolicyviolation", { bubbles: true }), {
          effectiveDirective: "img-src",
          violatedDirective: "img-src",
          blockedURI: `https://h/${token}/p/demo/api/thumbnails/a.svg?grant=${token}`,
          sourceFile: `https://h/${token}/p/demo/`,
          lineNumber: 3,
          columnNumber: 7,
          disposition: "enforce",
        }),
      );
    violation();
    violation();
    const warnings = window.__archerTelemetry!.warnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      type: "warn",
      code: "ui.csp-violation",
      data: {
        directive: "img-src",
        blocked: "https://h/[redacted]/p/demo/api/thumbnails/a.svg",
        sourceFile: "https://h/[redacted]/p/demo/",
        line: 3,
        column: 7,
        disposition: "enforce",
      },
    });
    expect(JSON.stringify(window.__archerTelemetry!.events())).not.toContain(token);
    document.dispatchEvent(
      Object.assign(new Event("securitypolicyviolation", { bubbles: true }), {
        effectiveDirective: "script-src-elem",
        blockedURI: "inline",
      }),
    );
    expect(window.__archerTelemetry!.warnings().at(-1)).toMatchObject({
      code: "ui.csp-violation",
      data: { directive: "script-src-elem", blocked: "inline" },
    });
  });

  it("receives product reports (devReport) as warnings", () => {
    window.__archerTelemetry!.clear();
    devReport("ui.edit.pointer-hand", "x", { surface: "canvas" });
    expect(window.__archerTelemetry!.warnings()).toMatchObject([
      { type: "warn", code: "ui.edit.pointer-hand", data: { surface: "canvas" } },
    ]);
  });

  it("starts a page view on pushState, closing the last with its vitals and summary; replaceState stays in the view", () => {
    window.__archerTelemetry!.clear();
    window.history.replaceState(null, "", "/projects/demo/?tab=diagrams&q=other");
    expect(window.__archerTelemetry!.events()).toEqual([]);
    window.history.pushState(null, "", "/projects/demo/?tab=notes");
    const events = window.__archerTelemetry!.events();
    expect(events.map((e) => e.code)).toEqual(["ui.web-vitals", "ui.page-view", "ui.page-view-start"]);
    expect(events[0]!.page).toBe("/projects/demo/?tab=diagrams");
    expect(events[2]!.page).toBe("/projects/demo/?tab=notes");
  });

  it("redacts before an event is kept or sent: credentials, encoded tokens, file contents", async () => {
    window.__archerTelemetry!.clear();
    const token = "a".repeat(64);
    devReport("ui.edit.pointer-hand", `see ?%74oken=${token}`, {
      cookie: "archer-1=x",
      source: "flowchart LR\n a",
      url: `/x?grant=${token}`,
      nested: { note: `/${token}/p` },
    });
    const [event] = window.__archerTelemetry!.events();
    expect(event).toMatchObject({
      msg: "see ?token=[redacted]",
      data: {
        cookie: "[redacted]",
        source: "[redacted]",
        url: "/x?grant=[redacted]",
        nested: { note: "/[redacted]/p" },
      },
    });
    await fetch(`/p/demo/api/views?token=${token}`);
    expect(window.__archerTelemetry!.requests()[0]!.url).toBe("/p/demo/api/views?token=[redacted]");
    expect(JSON.stringify(window.__archerTelemetry!.events())).not.toContain(token);
  });

  it("sends nothing about its own event posts", async () => {
    window.__archerTelemetry!.clear();
    served.length = 0;
    await window.__archerTelemetry!.flush();
    await fetch(`${location.origin}/-/debug/events`, { method: "POST", body: "{}" });
    expect(window.__archerTelemetry!.requests()).toEqual([]);
  });
});
