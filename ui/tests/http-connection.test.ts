import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHttpConnection,
  HANDOVER_GRACE_MS,
  HTTP_READ_DEADLINE_MS,
  HEARTBEAT_FRESH_MS,
  HEARTBEAT_STALL_MS,
  NETWORK_PROBE_MS,
} from "../src/app/http-connection";
import { forgetFileRouteReads, readAhead } from "../src/app/file-route-reads";
import { browserFetch } from "../src/app/browser-resource";
class Source {
  static instances: Source[] = [];
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn();
  listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
  constructor(readonly url: string) {
    Source.instances.push(this);
  }
  addEventListener(type: string, fn: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  emit(type: string, body: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify(body) }));
  }
}
const info = {
  browserProtocolMajor: 1,
  supportedBrowserProtocolMajors: [1],
  serverEpoch: "12345678-1234-1234-1234-123456789abc",
  capabilities: ["heartbeat"],
  applicationVersion: "0.1.0",
  semanticSchemaVersion: 2,
  heartbeatIntervalMs: 15000,
};
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
describe("HTTP recovery controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Source.instances = [];
    vi.stubGlobal("EventSource", Source);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(info)),
    );
    vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
    vi.stubGlobal("window", new EventTarget());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("recreates a permanently closed stream after transient 503", async () => {
    const status = vi.fn();
    const connection = createHttpConnection(status);
    vi.mocked(fetch).mockResolvedValueOnce(response(null, 503) as Response);
    Source.instances[0].onerror?.(new Event("error"));
    await vi.advanceTimersByTimeAsync(31000);
    expect(Source.instances.length).toBeGreaterThan(1);
    expect(status).toHaveBeenCalledWith("lost");
    connection.disconnect();
  });
  it("a restarted service still opening its projects is retried when it says, not after a grown backoff (O34)", async () => {
    // The service's answer while it drains or reopens projects (restart-drain, restore-background tests):
    // 503 with Retry-After: 1. Twelve seconds of it grew the backoff to 8-16 s, so the page kept saying
    // "Reconnecting" for up to that long after the service was ready.
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    let readyAt = Infinity;
    const loading = {
      ok: false,
      status: 503,
      headers: new Headers({ "retry-after": "1" }),
      json: async () => ({ error: { code: "project_loading" } }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (Date.now() >= readyAt ? response(info) : loading)),
    );
    const connection = createHttpConnection(vi.fn());
    Source.instances[0].onerror?.(new Event("error"));
    await vi.advanceTimersByTimeAsync(12000);
    expect(Source.instances).toHaveLength(1);
    readyAt = Date.now();
    await vi.advanceTimersByTimeAsync(1500);
    expect(Source.instances).toHaveLength(2);
    connection.disconnect();
    random.mockRestore();
  });
  it.each([
    ["unsupported major", response({ ...info, supportedBrowserProtocolMajors: [2] }), "incompatible"],
    ["malformed negotiation", response(null), "incompatible"],
    ["unauthorized", response(null, 403), "access-required"],
  ])("stops retrying after %s", async (_label, result, expected) => {
    vi.mocked(fetch).mockResolvedValue(result as Response);
    const status = vi.fn();
    const connection = createHttpConnection(status);
    Source.instances[0].onopen?.(new Event("open"));
    await flush();
    expect(status).toHaveBeenCalledWith(expected);
    const calls = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(120000);
    window.dispatchEvent(new Event("online"));
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(calls);
    expect(Source.instances).toHaveLength(1);
    connection.disconnect();
  });
  it("reads a hidden refusal (404) as access no longer granted, and asks nothing else", async () => {
    vi.mocked(fetch).mockResolvedValue(response(null, 404) as Response);
    const status = vi.fn();
    const connection = createHttpConnection(status);
    const opened = vi.fn();
    connection.events.onopen = opened;
    Source.instances[0].onopen?.(new Event("open"));
    await flush();
    expect(status).toHaveBeenLastCalledWith("access-required");
    expect(opened).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.map(([path]) => path)).toEqual(["api/connection"]);
    connection.disconnect();
  });
  it("recreates an open stream whose foreground heartbeat stalls", async () => {
    const status = vi.fn();
    const connection = createHttpConnection(status);
    Source.instances[0].onopen?.(new Event("open"));
    await flush();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_STALL_MS - 1);
    expect(status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(status).toHaveBeenCalledWith("lost");
    expect(Source.instances).toHaveLength(2);
    connection.disconnect();
  });
  it("uses valid epoch heartbeat events to keep an idle stream healthy", async () => {
    const status = vi.fn();
    const connection = createHttpConnection(status);
    Source.instances[0].onopen?.(new Event("open"));
    await flush();
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(15000);
      Source.instances[0].emit("heartbeat", { serverEpoch: info.serverEpoch });
    }
    expect(status).not.toHaveBeenCalled();
    expect(Source.instances).toHaveLength(1);
    connection.disconnect();
  });
  it("does not declare a foreground stall while the document is hidden", async () => {
    const status = vi.fn();
    const connection = createHttpConnection(status);
    Source.instances[0].onopen?.(new Event("open"));
    await flush();
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(120000);
    expect(status).not.toHaveBeenCalled();
    expect(Source.instances).toHaveLength(1);
    connection.disconnect();
  });
  it("a tab coming back replaces its stream without reporting a stream error", async () => {
    const connection = createHttpConnection(vi.fn());
    const errored = vi.fn();
    connection.events.onerror = errored;
    Source.instances[0].onopen?.(new Event("open"));
    await flush();
    // Quiet for longer than a heartbeat interval: the stream may have died unseen while the tab was away.
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(HEARTBEAT_FRESH_MS + 1);
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(Source.instances.length).toBeGreaterThan(1);
    expect(errored).not.toHaveBeenCalled();
    connection.disconnect();
  });
  it.each(["pagehide", "beforeunload"])(
    "an error after %s is the page leaving, not a stream failure; pageshow ends it",
    async (leave) => {
      const connection = createHttpConnection(vi.fn());
      const errored = vi.fn();
      connection.events.onerror = errored;
      Source.instances[0].onopen?.(new Event("open"));
      await flush();
      expect(connection.leaving()).toBe(false);
      window.dispatchEvent(new Event(leave));
      expect(connection.leaving()).toBe(true);
      Source.instances[0].onerror?.(new Event("error"));
      expect(errored).not.toHaveBeenCalled();
      window.dispatchEvent(new Event("pageshow"));
      expect(connection.leaving()).toBe(false);
      // Still alive (a cancelled navigation, or back from the back-forward cache): it has reconnected.
      await vi.advanceTimersByTimeAsync(1000);
      expect(Source.instances.length).toBeGreaterThan(1);
      connection.disconnect();
    },
  );
  it("a tab coming back keeps a stream that proved itself alive within a heartbeat interval (perf #10)", async () => {
    const status = vi.fn();
    const connection = createHttpConnection(status);
    const opened = vi.fn();
    connection.events.onopen = opened;
    Source.instances[0].onopen?.(new Event("open"));
    await flush();
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(15000);
    Source.instances[0].emit("heartbeat", { serverEpoch: info.serverEpoch });
    await vi.advanceTimersByTimeAsync(10000);
    const reads = vi.mocked(fetch).mock.calls.length;
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(Source.instances).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.length).toBe(reads);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    // The watchdog runs again: a stream that then goes silent is still replaced.
    await vi.advanceTimersByTimeAsync(HEARTBEAT_STALL_MS);
    expect(status).toHaveBeenCalledWith("lost");
    expect(Source.instances.length).toBeGreaterThan(1);
    connection.disconnect();
  });
  it("bounds hanging reads even if fetch ignores its AbortSignal", async () => {
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    const connection = createHttpConnection(vi.fn());
    const result = connection.read("api/bootstrap");
    const assertion = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(HTTP_READ_DEADLINE_MS);
    await assertion;
    const init = vi.mocked(fetch).mock.calls[0][1];
    expect(init?.signal?.aborted).toBe(true);
    connection.disconnect();
  });
  it("bounds response body parsing as well as response headers", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: () => new Promise(() => {}) } as Response);
    const connection = createHttpConnection(vi.fn());
    const assertion = expect(connection.read("api/bootstrap")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(HTTP_READ_DEADLINE_MS);
    await assertion;
    connection.disconnect();
  });
  it("ignores negotiation replies and events from an obsolete stream", async () => {
    let answer: ((value: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const connection = createHttpConnection(vi.fn());
    const opened = vi.fn();
    const changed = vi.fn();
    connection.events.onopen = opened;
    connection.events.addEventListener("change", changed);
    const old = Source.instances[0];
    old.onopen?.(new Event("open"));
    old.onerror?.(new Event("error"));
    await vi.advanceTimersByTimeAsync(1000);
    const current = Source.instances.at(-1)!;
    current.onopen?.(new Event("open"));
    await flush();
    answer?.(response(info) as Response);
    await flush();
    old.emit("change", {});
    current.emit("change", {});
    expect(opened).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    connection.disconnect();
  });
  it("cleans up pending reads, retry timers and wake listeners on disconnect", async () => {
    const connection = createHttpConnection(vi.fn());
    Source.instances[0].onerror?.(new Event("error"));
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    const assertion = expect(connection.read("api/bootstrap")).rejects.toThrow("aborted");
    connection.disconnect();
    await assertion;
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(120000);
    expect(Source.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("coalesces online and visibility recovery signals into one replacement", async () => {
    const connection = createHttpConnection(vi.fn());
    Source.instances[0].onerror?.(new Event("error"));
    let answer: ((value: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    answer?.(response(info) as Response);
    await flush();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(Source.instances).toHaveLength(2);
    connection.disconnect();
  });

  it("renegotiates the backend actually serving a replacement stream", async () => {
    const status = vi.fn();
    const connection = createHttpConnection(status);
    Source.instances[0].onerror?.(new Event("error"));
    await vi.advanceTimersByTimeAsync(1000);
    vi.mocked(fetch).mockResolvedValue(
      response({ ...info, browserProtocolMajor: 2, supportedBrowserProtocolMajors: [2] }) as Response,
    );
    Source.instances.at(-1)?.onopen?.(new Event("open"));
    await flush();
    expect(status).toHaveBeenLastCalledWith("incompatible");
    connection.disconnect();
  });
  it("treats a negotiated route with invalid JSON as incompatible", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("bad JSON");
      },
    } as unknown as Response);
    const status = vi.fn();
    const connection = createHttpConnection(status);
    Source.instances[0].onopen?.(new Event("open"));
    await flush();
    expect(status).toHaveBeenLastCalledWith("incompatible");
    await vi.advanceTimersByTimeAsync(60000);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    connection.disconnect();
  });
  it("buffers state events until compatibility has been established", async () => {
    let answer: ((value: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const connection = createHttpConnection(vi.fn());
    const listener = vi.fn();
    connection.events.addEventListener("presentation", listener);
    Source.instances[0].onopen?.(new Event("open"));
    Source.instances[0].emit("presentation", { view: "a" });
    expect(listener).not.toHaveBeenCalled();
    answer?.(response(info) as Response);
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    connection.disconnect();
  });
  it("never delivers buffered events from an incompatible backend", async () => {
    const connection = createHttpConnection(vi.fn());
    const listener = vi.fn();
    connection.events.addEventListener("presentation", listener);
    vi.mocked(fetch).mockResolvedValue(response({ ...info, supportedBrowserProtocolMajors: [2] }) as Response);
    Source.instances[0].onopen?.(new Event("open"));
    Source.instances[0].emit("presentation", { view: "a" });
    await flush();
    expect(listener).not.toHaveBeenCalled();
    expect(connection.canSend()).toBe(false);
    connection.disconnect();
  });
  it("refuses or validates arbitrary, vocabulary and edited metadata on a small stack within a deadline", () => {
    const source = new URL("../src/app/http-connection.ts", import.meta.url).href;
    const script = `
      import {parseBrowserConnection} from ${JSON.stringify(source)};
      const valid=${JSON.stringify(info)};
      let seed=0x51A7;
      const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
      const vocabulary=[null,true,false,0,1,2,"heartbeat",valid.serverEpoch,"0.1.0",[],{},[1],[2],15000];
      const keys=Object.keys(valid);
      for(let i=0;i<4000;i++){
        const atom=()=>vocabulary[Math.floor(random()*vocabulary.length)];
        const arbitrary=atom();
        const record={};for(const key of keys){if(random()<0.5)record[key]=atom();}
        const edited={...valid};edited[keys[Math.floor(random()*keys.length)]]=atom();
        for(const value of [arbitrary,record,edited]){
          const result=parseBrowserConnection(value);
          if(result!==undefined && (typeof result.heartbeat!=="boolean" || result.epoch!==valid.serverEpoch))throw new Error("invalid accepted result");
        }
      }
      if(!parseBrowserConnection(valid))throw new Error("valid metadata refused");
    `;
    expect(() =>
      execFileSync(process.execPath, ["--stack-size=256", "--import", "tsx", "--input-type=module", "-e", script], {
        timeout: 5000,
        stdio: "pipe",
      }),
    ).not.toThrow();
  }, 10000);
});
describe("planned hand-over (archer restart)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Source.instances = [];
    vi.stubGlobal("EventSource", Source);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(info)),
    );
    vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
    vi.stubGlobal("window", new EventTarget());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const refused = () => Promise.reject(new TypeError("Failed to fetch"));
  /** An open, negotiated stream that the service has just told to reconnect, and then ended. */
  async function handedOver() {
    const status = vi.fn();
    const connection = createHttpConnection(status);
    const errored = vi.fn();
    connection.events.onerror = errored;
    const opened = vi.fn();
    connection.events.onopen = opened;
    Source.instances[0].onopen?.(new Event("open"));
    await flush();
    Source.instances[0].emit("reconnect", { reason: "handover" });
    Source.instances[0].onerror?.(new Event("error"));
    return { status, connection, errored, opened };
  }
  it("reconnects about 250 ms after a reconnect event and never reports the hand-over as lost", async () => {
    const { status, connection, errored, opened } = await handedOver();
    await vi.advanceTimersByTimeAsync(249);
    expect(Source.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(Source.instances).toHaveLength(2);
    Source.instances[1].onopen?.(new Event("open"));
    await flush();
    Source.instances[1].emit("standing", { seq: 1 });
    expect(opened).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HANDOVER_GRACE_MS * 2);
    expect(status).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();
    connection.disconnect();
  });
  it("keeps retrying every 250-500 ms through refused connections and 503s inside the grace window", async () => {
    const { status, connection, errored } = await handedOver();
    vi.mocked(fetch).mockImplementation(refused);
    await vi.advanceTimersByTimeAsync(1500);
    vi.mocked(fetch).mockResolvedValue(response(null, 503) as Response);
    await vi.advanceTimersByTimeAsync(1500);
    // Without backoff growth: at least six tries in three seconds (250 ms, then at most 500 ms apart).
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(status).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValue(response(info) as Response);
    await vi.advanceTimersByTimeAsync(500);
    const current = Source.instances.at(-1)!;
    expect(Source.instances.length).toBeGreaterThan(1);
    current.onopen?.(new Event("open"));
    await flush();
    current.emit("standing", { seq: 1 });
    await vi.advanceTimersByTimeAsync(HANDOVER_GRACE_MS * 2);
    expect(status).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();
    connection.disconnect();
  });
  it("takes the stopping service's empty `: restarting` stream as part of the hand-over, not a failure", async () => {
    const { status, connection, errored } = await handedOver();
    await vi.advanceTimersByTimeAsync(300);
    // The old service answers the stream with an empty 200 that ends at once.
    const restarting = Source.instances.at(-1)!;
    restarting.onopen?.(new Event("open"));
    await flush();
    restarting.onerror?.(new Event("error"));
    await vi.advanceTimersByTimeAsync(500);
    const current = Source.instances.at(-1)!;
    expect(current).not.toBe(restarting);
    current.onopen?.(new Event("open"));
    await flush();
    current.emit("standing", { seq: 1 });
    await vi.advanceTimersByTimeAsync(HANDOVER_GRACE_MS * 2);
    expect(status).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();
    connection.disconnect();
  });
  it("reports lost once the grace window passes without a replacement, then backs off as before", async () => {
    const { status, connection, errored } = await handedOver();
    vi.mocked(fetch).mockImplementation(refused);
    await vi.advanceTimersByTimeAsync(HANDOVER_GRACE_MS - 100);
    expect(status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(status).toHaveBeenCalledWith("lost");
    expect(errored).toHaveBeenCalledTimes(1);
    const before = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    // Ordinary exponential backoff again: a handful of tries, not twenty. A refused read is asked
    // once more (browserFetch, E11), so each try is at most two requests.
    expect(vi.mocked(fetch).mock.calls.length - before).toBeLessThanOrEqual(5 * 2);
    connection.disconnect();
  });
  it("an ordinary stream error without a reconnect event still reports lost", async () => {
    const status = vi.fn();
    const connection = createHttpConnection(status);
    Source.instances[0].onopen?.(new Event("open"));
    await flush();
    Source.instances[0].onerror?.(new Event("error"));
    expect(status).toHaveBeenCalledWith("lost");
    connection.disconnect();
  });
  it("reports each negotiated application version, also after a reconnect", async () => {
    const versions: string[] = [];
    const connection = createHttpConnection(vi.fn(), { onApplicationVersion: (version) => versions.push(version) });
    Source.instances[0].onopen?.(new Event("open"));
    await flush();
    vi.mocked(fetch).mockResolvedValue(response({ ...info, applicationVersion: "0.2.0" }) as Response);
    Source.instances[0].emit("reconnect", { reason: "handover" });
    Source.instances[0].onerror?.(new Event("error"));
    await vi.advanceTimersByTimeAsync(300);
    Source.instances.at(-1)!.onopen?.(new Event("open"));
    await flush();
    expect(versions[0]).toBe("0.1.0");
    expect(versions.at(-1)).toBe("0.2.0");
    connection.disconnect();
  });
});
describe("conditional reads (ETag)", () => {
  const withEtag = (body: unknown, status: number, etag: string | null) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(etag === null ? {} : { etag }),
    json: vi.fn(async () => body),
  });
  beforeEach(() => {
    Source.instances = [];
    vi.stubGlobal("EventSource", Source);
    vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
    vi.stubGlobal("window", new EventTarget());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("sends if-none-match, keeps no-store, and answers 304 without reading a body", async () => {
    const unchanged = withEtag(null, 304, '"abc"');
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => unchanged),
    );
    const connection = createHttpConnection(vi.fn());
    await expect(connection.readConditional("api/diagrams/v1", '"abc"')).resolves.toEqual({
      status: 304,
      etag: '"abc"',
      body: undefined,
      seq: null,
    });
    expect(fetch).toHaveBeenCalledWith(
      "api/diagrams/v1",
      expect.objectContaining({ cache: "no-store", headers: { "if-none-match": '"abc"' } }),
    );
    expect(unchanged.json).not.toHaveBeenCalled();
    connection.disconnect();
  });
  it("returns the body and the new ETag on 200, and sends no condition without one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => withEtag({ view: 1 }, 200, '"def"')),
    );
    const connection = createHttpConnection(vi.fn());
    await expect(connection.readConditional("api/diagrams/v1", null)).resolves.toEqual({
      status: 200,
      etag: '"def"',
      body: { view: 1 },
      seq: null,
    });
    expect((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).headers).toBeUndefined();
    connection.disconnect();
  });
  it("names the publication count a read was answered at (x-archer-event-seq)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "x-archer-event-seq": "7" }),
        json: async () => ({}),
      })),
    );
    const connection = createHttpConnection(vi.fn());
    await expect(connection.readNumbered("api/bootstrap")).resolves.toEqual({ body: {}, seq: 7 });
    connection.disconnect();
  });
  it("joins the open diagram's read the file route started, instead of a second request (speed: diagram at page start)", async () => {
    forgetFileRouteReads();
    let answer: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise<void>((r) => {
          answer = r;
        });
        return withEtag({ view: 1 }, 200, '"e1"');
      }),
    );
    readAhead("api/diagrams/v1");
    const connection = createHttpConnection(vi.fn());
    const read = connection.readConditional("api/diagrams/v1", null);
    answer!();
    await expect(read).resolves.toEqual({ status: 200, etag: '"e1"', body: { view: 1 }, seq: null });
    expect(fetch).toHaveBeenCalledTimes(1);
    // Handed over once: the next read asks the service.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => withEtag({ view: 2 }, 200, '"e2"')),
    );
    await expect(connection.readConditional("api/diagrams/v1", null)).resolves.toMatchObject({ body: { view: 2 } });
    connection.disconnect();
  });
  it("still fails on an HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => withEtag(null, 404, null)),
    );
    const connection = createHttpConnection(vi.fn());
    await expect(connection.readConditional("api/diagrams/v1", '"abc"')).rejects.toThrow("HTTP 404");
    connection.disconnect();
  });
});

describe("telling the truth when the network goes (O68)", () => {
  const failed = () => Promise.reject(new TypeError("Failed to fetch"));
  beforeEach(() => {
    vi.useFakeTimers();
    Source.instances = [];
    vi.stubGlobal("EventSource", Source);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(info)),
    );
    vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("navigator", { onLine: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const opened = async () => {
    const status = vi.fn();
    const connection = createHttpConnection(status);
    Source.instances[0].onopen?.(new Event("open"));
    await flush();
    return { status, connection };
  };
  it("reports lost as soon as the browser goes offline, though the open stream says nothing, and recovers on online", async () => {
    const { status, connection } = await opened();
    const reopened = vi.fn();
    connection.events.onopen = reopened;
    vi.mocked(fetch).mockImplementation(failed);
    vi.stubGlobal("navigator", { onLine: false });
    window.dispatchEvent(new Event("offline"));
    expect(status).toHaveBeenCalledWith("lost");
    expect(Source.instances[0].close).toHaveBeenCalled();
    // While offline the retries fail quietly; back online it reconnects at once, not after its backoff.
    await vi.advanceTimersByTimeAsync(5000);
    vi.mocked(fetch).mockImplementation(async () => response(info) as Response);
    vi.stubGlobal("navigator", { onLine: true });
    window.dispatchEvent(new Event("online"));
    await flush();
    const current = Source.instances.at(-1)!;
    current.onopen?.(new Event("open"));
    await flush();
    expect(reopened).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
    connection.disconnect();
  });
  it("back online while a retry is still asking the service, it tries again at once instead of waiting out its backoff", async () => {
    // At this jitter the 5 s offline wait ends with a retry's read still out: no timer is pending and no stream is open.
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    const { status, connection } = await opened();
    const reopened = vi.fn();
    connection.events.onopen = reopened;
    vi.mocked(fetch).mockImplementation(failed);
    vi.stubGlobal("navigator", { onLine: false });
    window.dispatchEvent(new Event("offline"));
    await vi.advanceTimersByTimeAsync(5000);
    const before = Source.instances.length;
    vi.mocked(fetch).mockImplementation(async () => response(info) as Response);
    vi.stubGlobal("navigator", { onLine: true });
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(Source.instances.length).toBe(before + 1);
    Source.instances.at(-1)!.onopen?.(new Event("open"));
    await flush();
    expect(reopened).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
    connection.disconnect();
  });
  it("a data read that fails at the network while the browser says offline reports lost at once", async () => {
    const { status, connection } = await opened();
    vi.mocked(fetch).mockImplementation(failed);
    vi.stubGlobal("navigator", { onLine: false });
    const reading = expect(connection.read("api/diagrams/checkout")).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(300);
    await reading;
    expect(status).toHaveBeenCalledWith("lost");
    connection.disconnect();
  });
  it("a data read that fails at the network is checked once: lost when the service does not answer either", async () => {
    const { status, connection } = await opened();
    vi.mocked(fetch).mockImplementation(failed);
    const reading = expect(connection.read("api/diagrams/checkout")).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(300);
    await reading;
    await vi.advanceTimersByTimeAsync(1000);
    expect(status).toHaveBeenCalledWith("lost");
    connection.disconnect();
  });
  it("a single dropped read the service then answers is no false alarm", async () => {
    const { status, connection } = await opened();
    vi.mocked(fetch).mockImplementationOnce(failed).mockImplementationOnce(failed);
    const reading = expect(connection.read("api/diagrams/checkout")).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(300);
    await reading;
    await vi.advanceTimersByTimeAsync(NETWORK_PROBE_MS * 2);
    expect(status).not.toHaveBeenCalled();
    expect(Source.instances).toHaveLength(1);
    connection.disconnect();
  });
  it("a read the page aborted itself is not evidence of anything", async () => {
    const { status, connection } = await opened();
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        ),
    );
    const reading = expect(connection.read("api/diagrams/checkout")).rejects.toThrow();
    connection.disconnect();
    await reading;
    expect(status).not.toHaveBeenCalled();
  });
  it("a read with no answer within its deadline is checked the same way", async () => {
    const { status, connection } = await opened();
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {}));
    const reading = expect(connection.read("api/diagrams/checkout")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(HTTP_READ_DEADLINE_MS);
    await reading;
    expect(status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(NETWORK_PROBE_MS);
    expect(status).toHaveBeenCalledWith("lost");
    connection.disconnect();
  });
  // User-flows v1.1 J8a: the notice by the first failed read OR WRITE. A write goes through browserFetch, not the
  // connection's own reads, and is never repeated (it may have arrived); its network failure is the same evidence.
  const write = () =>
    browserFetch("api/comments", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const probes = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("api/connection")).length;
  it("a write that fails at the network is checked once: lost when the service does not answer either", async () => {
    const { status, connection } = await opened();
    const before = probes();
    vi.mocked(fetch).mockImplementation(failed);
    await expect(write()).rejects.toThrow(TypeError);
    // One check: browserFetch asks a dropped read once more after a moment, as it does for every read.
    expect(probes() - before).toBe(1);
    expect(status).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(probes() - before).toBe(2);
    expect(status).toHaveBeenCalledWith("lost");
    connection.disconnect();
  });
  it("a write that fails at the network while the browser says offline reports lost at once", async () => {
    const { status, connection } = await opened();
    const before = probes();
    vi.mocked(fetch).mockImplementation(failed);
    vi.stubGlobal("navigator", { onLine: false });
    await expect(write()).rejects.toThrow(TypeError);
    expect(status).toHaveBeenCalledWith("lost");
    expect(probes()).toBe(before);
    connection.disconnect();
  });
  it("a failed write the service then answers is no false alarm", async () => {
    const { status, connection } = await opened();
    vi.mocked(fetch).mockImplementationOnce(failed);
    await expect(write()).rejects.toThrow(TypeError);
    await vi.advanceTimersByTimeAsync(NETWORK_PROBE_MS * 2);
    expect(status).not.toHaveBeenCalled();
    expect(Source.instances).toHaveLength(1);
    connection.disconnect();
  });
  it("a write the service answered, even with an error, or one the page aborted, is not evidence", async () => {
    const { status, connection } = await opened();
    const before = probes();
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: { code: "internal" } }, 500) as Response);
    expect((await write()).status).toBe(500);
    const controller = new AbortController();
    vi.mocked(fetch).mockImplementationOnce(
      (_url, init) =>
        new Promise((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
        ),
    );
    const aborted = expect(
      browserFetch("api/comments", { method: "POST", body: "{}", signal: controller.signal }),
    ).rejects.toThrow();
    controller.abort();
    await aborted;
    await vi.advanceTimersByTimeAsync(NETWORK_PROBE_MS * 2);
    expect(probes()).toBe(before);
    expect(status).not.toHaveBeenCalled();
    connection.disconnect();
  });
  it("a closed connection hears nothing of later writes", async () => {
    const { status, connection } = await opened();
    connection.disconnect();
    const before = probes();
    vi.mocked(fetch).mockImplementation(failed);
    await expect(write()).rejects.toThrow(TypeError);
    await vi.advanceTimersByTimeAsync(NETWORK_PROBE_MS * 2);
    expect(probes()).toBe(before);
    expect(status).not.toHaveBeenCalled();
  });
});
