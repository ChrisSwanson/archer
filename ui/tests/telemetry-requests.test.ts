import { describe, expect, it } from "vitest";
import type { TelemetryReport } from "../src/telemetry/dev";
import { RequestTracker, parseServerTiming, urlPattern, type RequestRecord } from "../src/telemetry/requests";
import {
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  Transport,
  batches,
  eventsUrl,
  type TelemetryEvent,
} from "../src/telemetry/transport";
import { ClsWindow, InteractionLatency } from "../src/telemetry/vitals";

const ORIGIN = "https://host:40399";

function tracker() {
  const reports: TelemetryReport[] = [];
  return { reports, requests: new RequestTracker((r) => reports.push(r)), codes: () => reports.map((r) => r.code) };
}
const record = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  at: 0,
  page: "/projects/",
  method: "GET",
  url: "/p/demo/api/views",
  pattern: "/p/demo/api/views",
  status: 200,
  ms: 20,
  bytes: 10,
  ...over,
});

describe("request warnings (contract ui.fetch-*)", () => {
  it.each([
    ["a 500", record({ status: 500 }), ["ui.fetch-failed"], "error"],
    ["a 404", record({ status: 404 }), ["ui.fetch-failed"], "warn"],
    ["a network failure", record({ status: null, error: "TypeError: Failed to fetch" }), ["ui.fetch-failed"], "error"],
    ["a slow success (> 1000 ms)", record({ ms: 1001 }), ["ui.fetch-slow"], "warn"],
    ["exactly 1000 ms", record({ ms: 1000 }), [], undefined],
    ["a fast success", record(), [], undefined],
  ] as const)("%s", (_name, finished, codes, level) => {
    const t = tracker();
    t.requests.finished(finished);
    expect(t.codes()).toEqual(codes);
    if (level) expect(t.reports[0]!.level).toBe(level);
    expect(t.requests.all()).toHaveLength(1);
  });

  it("reports the same URL issued 3 times within 2 s once, and not when spread out", () => {
    const t = tracker();
    for (const at of [0, 500, 1000, 1500]) t.requests.started("GET", "/p/demo/api/comments?path=a", "/", at);
    expect(t.codes()).toEqual(["ui.fetch-duplicate"]);
    expect(t.reports[0]!.data).toMatchObject({ count: 3, url: "/p/demo/api/comments?path=a" });
    const spread = tracker();
    for (const at of [0, 1500, 3000, 4500]) spread.requests.started("GET", "/x", "/", at);
    expect(spread.codes()).toEqual([]);
    const methods = tracker();
    for (const method of ["GET", "POST", "GET"]) methods.requests.started(method, "/x", "/", 0);
    expect(methods.codes()).toEqual([]);
  });

  it("reports a page view with more than 40 requests once, and counts again after a route change", () => {
    const t = tracker();
    for (let i = 0; i < 40; i++) t.requests.started("GET", `/r/${i}`, "/", i * 10_000);
    expect(t.codes()).toEqual([]);
    for (let i = 40; i < 60; i++) t.requests.started("GET", `/r/${i}`, "/", i * 10_000);
    expect(t.codes()).toEqual(["ui.request-count"]);
    t.requests.pageView();
    for (let i = 0; i < 41; i++) t.requests.started("GET", `/s/${i}`, "/b", 1e9 + i * 10_000);
    expect(t.codes()).toEqual(["ui.request-count", "ui.request-count"]);
  });

  it("a committed edit is a person's change, not a read: 45 of them in one editing view stay under the count", () => {
    // smoke-a-labels2: 8 reads and 45 edits in one editor view; the count is about what the page reads.
    const t = tracker();
    for (let i = 0; i < 45; i++)
      t.requests.started("POST", "/p/demo/api/authoring/edit", "/e", i * 10_000, `{"edit":${i}}`);
    for (let i = 0; i < 8; i++) t.requests.started("GET", `/p/demo/api/r/${i}`, "/e", 1e6 + i * 10_000);
    expect(t.codes()).toEqual([]);
    // A preview is a read sent as POST: it still counts.
    for (let i = 0; i < 33; i++)
      t.requests.started("POST", "/p/demo/api/authoring/preview", "/e", 2e6 + i * 10_000, `{"p":${i}}`);
    expect(t.codes()).toEqual(["ui.request-count"]);
  });
});

describe("request records", () => {
  it.each([
    ["/p/demo/api/comments?path=a.mmd&x=1", "/p/demo/api/comments?path&x"],
    ["/p/demo/api/thumbnails/0123456789abcdef0123/view.svg", "/p/demo/api/thumbnails/:id/view.svg"],
    ["/api/authoring/operations/" + "a".repeat(32), "/api/authoring/operations/:id"],
    ["/projects/demo/diagrams/42", "/projects/demo/diagrams/:id"],
    ["https://elsewhere.example/a?b=1", "https://elsewhere.example/a?b"],
    [`${ORIGIN}/projects/`, "/projects/"],
  ])("pattern of %s", (url, pattern) => {
    expect(urlPattern(url, ORIGIN)).toBe(pattern);
  });

  it("reads Server-Timing durations", () => {
    expect(parseServerTiming('auth;dur=1.5, compile;dur=30;desc="mermaid", cache, total;dur=40')).toEqual({
      auth: 1.5,
      compile: 30,
      cache: 0,
      total: 40,
    });
    expect(parseServerTiming(null)).toBeUndefined();
    expect(parseServerTiming("")).toBeUndefined();
  });
});

describe("transport (POST /-/debug/events)", () => {
  const event = (i: number, data?: Record<string, unknown>): TelemetryEvent => ({
    at: i,
    type: "warn",
    code: "ui.long-task",
    msg: `m${i}`,
    page: "/p",
    ...(data ? { data } : {}),
  });

  it("posts to the origin root, never under a project or token prefix", () => {
    expect(eventsUrl("https://host:1/tok/p/demo/browse/?tab=diagrams")).toBe("https://host:1/-/debug/events");
    expect(eventsUrl("http://localhost:5173/projects/demo/")).toBe("http://localhost:5173/-/debug/events");
  });

  it("splits batches within 200 events and 64 KiB", () => {
    const many = Array.from({ length: 450 }, (_, i) => event(i));
    const parts = batches("s", "dev", many);
    expect(parts.map((b) => b.events.length)).toEqual([200, 200, 50]);
    const big = Array.from({ length: 100 }, (_, i) => event(i, { blob: "x".repeat(4000) }));
    for (const batch of batches("s", "dev", big)) {
      expect(new TextEncoder().encode(JSON.stringify(batch)).length).toBeLessThanOrEqual(MAX_BATCH_BYTES);
      expect(batch.events.length).toBeLessThanOrEqual(MAX_BATCH_EVENTS);
    }
    const huge = batches("s", "dev", [event(1, { blob: "x".repeat(100_000) })]);
    expect(huge[0]!.events[0]!.data).toMatchObject({ truncated: true });
    expect(huge[0]).toMatchObject({ session: "s", build: "dev", page: "/p" });
  });

  it("stops sending when the service has no debug routes (404)", async () => {
    const calls: string[] = [];
    const transport = new Transport({
      url: "https://h/-/debug/events",
      session: "s",
      build: "dev",
      fetch: (async (url: string) => {
        calls.push(url);
        return new Response("", { status: 404 });
      }) as typeof fetch,
    });
    transport.enqueue(event(1));
    await transport.flush();
    expect(calls).toEqual(["https://h/-/debug/events"]);
    expect(transport.stopped).toBe(true);
    transport.enqueue(event(2));
    await transport.flush();
    expect(calls).toHaveLength(1);
  });

  it("uses the beacon on pagehide", async () => {
    const beacons: string[] = [];
    const transport = new Transport({
      url: "https://h/-/debug/events",
      session: "s",
      build: "dev",
      fetch: (async () => new Response("{}")) as typeof fetch,
      beacon: (url) => {
        beacons.push(url);
        return true;
      },
    });
    transport.enqueue(event(1));
    await transport.flush(true);
    expect(beacons).toEqual(["https://h/-/debug/events"]);
    expect(transport.pending).toBe(0);
  });
});

describe("vitals", () => {
  it("CLS keeps the largest session window (1 s gap, 5 s cap)", () => {
    const cls = new ClsWindow();
    cls.add(0, 0.1);
    cls.add(500, 0.1); // window 1: 0.2
    cls.add(2000, 0.05); // gap > 1 s: window 2
    expect(cls.value).toBeCloseTo(0.2);
    for (let t = 2500; t <= 7000; t += 500) cls.add(t, 0.02); // window 2 reaches 5 s: 0.05 + 10 × 0.02
    expect(cls.value).toBeCloseTo(0.25);
    cls.add(7500, 0.3); // past the 5 s cap: a new window
    expect(cls.value).toBeCloseTo(0.3);
  });

  it("INP is the worst interaction below 50, a high percentile above", () => {
    const inp = new InteractionLatency();
    expect(inp.value()).toBeUndefined();
    inp.add(1, 40);
    inp.add(1, 120);
    inp.add(2, 80);
    inp.add(0, 999);
    expect(inp.value()).toBe(120);
    for (let i = 10; i < 110; i++) inp.add(i, i);
    expect(inp.count).toBe(102);
    expect(inp.value()).toBe(108);
  });
});

describe("bounded telemetry structures", () => {
  it("the duplicate detector holds a capped set of keys and a few timestamps per key", () => {
    const t = tracker();
    for (let i = 0; i < 5000; i++) t.requests.started("GET", "/same", "/", i);
    expect(t.requests.held().longestTimes).toBeLessThanOrEqual(3);
    for (let i = 0; i < 5000; i++) for (let k = 0; k < 3; k++) t.requests.started("GET", `/k/${i}`, "/", 10_000 + i);
    const held = t.requests.held();
    expect(held.keys).toBeLessThanOrEqual(RequestTracker.MAX_KEYS);
    expect(held.reported).toBeLessThanOrEqual(RequestTracker.MAX_KEYS);
    expect(t.codes().filter((c) => c === "ui.fetch-duplicate").length).toBeGreaterThan(1000);
  });

  it("INP holds only its longest interactions and stays exact while that suffices", () => {
    const inp = new InteractionLatency();
    const all: number[] = [];
    for (let i = 1; i <= 499; i++) {
      const d = (i * 7919) % 1000;
      all.push(d);
      inp.add(i, d);
      inp.add(i, d / 2);
    }
    expect(inp.held).toBeLessThanOrEqual(10);
    expect(inp.count).toBe(499);
    expect(inp.value()).toBe([...all].sort((a, b) => b - a)[Math.floor(499 / 50)]);
    for (let i = 500; i <= 20_000; i++) inp.add(i, 1);
    expect(inp.held).toBeLessThanOrEqual(10);
  });

  it("never returns a token from a URL it cannot parse or a token-named parameter", () => {
    const token = "0123456789abcdef".repeat(2);
    expect(urlPattern(`http://[bad/projects/?token=${token}`)).not.toContain(token.slice(0, 12));
    expect(urlPattern(`/p/demo/api/x?${token}=1`, ORIGIN)).not.toContain(token.slice(0, 12));
  });
});
