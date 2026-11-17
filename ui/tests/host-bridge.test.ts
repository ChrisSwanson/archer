// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  callServerTool: vi.fn(() => Promise.resolve({ content: [] })),
  close: vi.fn(() => Promise.resolve()),
  connect: vi.fn(() => Promise.resolve()),
  events: [] as string[],
  toolResultHandler: undefined as ((result: unknown) => void) | undefined,
  updateModelContext: vi.fn(() => Promise.resolve({})),
}));

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(event: string, handler: (result: unknown) => void): void {
      appMock.events.push(`add:${event}`);
      if (event === "toolresult") {
        appMock.toolResultHandler = handler;
      }
    }

    callServerTool = appMock.callServerTool;
    close = appMock.close;

    connect(): Promise<void> {
      appMock.events.push("connect");
      return appMock.connect();
    }

    updateModelContext = appMock.updateModelContext;
  },
}));

import { connectBridge, hostMode } from "../src/app/host-bridge";

// A macrotask, not a count of microtask ticks: how many promise hops lie
// between a request and its callback is the bridge's business, and a test that
// counted them broke whenever one was added.
function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("connectBridge", () => {
  beforeEach(() => {
    appMock.callServerTool.mockReset().mockResolvedValue({ content: [] });
    appMock.close.mockClear();
    appMock.connect.mockReset().mockResolvedValue();
    appMock.events.length = 0;
    appMock.toolResultHandler = undefined;
    appMock.updateModelContext.mockClear();
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      location: { protocol: "ui:" },
      parent: {},
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers the tool result handler before connecting", async () => {
    connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await vi.dynamicImportSettled();

    expect(appMock.events).toEqual(["add:toolresult", "connect"]);
  });

  it("dispatches presentation structured content from a tool result", async () => {
    const onPresent = vi.fn();
    connectBridge({ onPresent, onClear: vi.fn() });
    await vi.dynamicImportSettled();
    const structuredContent = {
      envelope: { view: { id: "v1" } },
      presentation: { presentationId: "p1", viewId: "v1" },
      diagnostics: [],
    };

    appMock.toolResultHandler?.({ structuredContent });

    expect(onPresent).toHaveBeenCalledWith({ type: "present", ...structuredContent });
  });

  it("dispatches the presentation, then the emphasis present_diagram set with it", async () => {
    const order: string[] = [];
    const onPresent = vi.fn(() => order.push("present"));
    const onEmphasis = vi.fn(() => order.push("emphasis"));
    connectBridge({ onPresent, onClear: vi.fn(), onEmphasis });
    await vi.dynamicImportSettled();
    const emphasisSnapshot = { schemaVersion: 1, viewId: "v1", emphases: [] };
    appMock.toolResultHandler?.({
      structuredContent: {
        envelope: { view: { id: "v1" } },
        presentation: { presentationId: "p1", viewId: "v1" },
        diagnostics: [],
        emphasisSnapshot,
      },
    });
    expect(order).toEqual(["present", "emphasis"]);
    expect(onEmphasis).toHaveBeenCalledWith(expect.objectContaining({ viewId: "v1", emphases: [] }));
  });

  it("publishes selection to model context and connection state", async () => {
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await vi.dynamicImportSettled();
    const context = { schemaVersion: 1, viewId: "v1" };

    bridge.setSelection(context);
    await flushPromises();

    expect(appMock.updateModelContext).toHaveBeenCalledWith({ structuredContent: context });
    expect(appMock.callServerTool).toHaveBeenCalledWith({
      name: "set_selection",
      arguments: context,
    });
  });

  it("reads models and authoritative emphasis through server tools", async () => {
    const envelope = { view: { id: "v1" } };
    const snapshot = { schemaVersion: 1, viewId: "v1", emphases: [] };
    appMock.callServerTool.mockResolvedValueOnce({ content: [], structuredContent: { envelope } } as never);
    appMock.callServerTool.mockResolvedValueOnce({
      content: [],
      structuredContent: { schemaVersion: 1, views: [snapshot] },
    } as never);
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await vi.dynamicImportSettled();
    await expect(bridge.fetchView("v1")).resolves.toEqual(envelope);
    await expect(bridge.fetchEmphasis("v1")).resolves.toEqual(snapshot);
    expect(appMock.callServerTool).toHaveBeenCalledWith({ name: "read_diagram", arguments: { viewId: "v1" } });
    expect(appMock.callServerTool).toHaveBeenCalledWith({ name: "list_emphases", arguments: { viewId: "v1" } });
  });

  it("refuses missing models and unrelated emphasis snapshots from server tools", async () => {
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await vi.dynamicImportSettled();
    appMock.callServerTool.mockResolvedValueOnce({ content: [], structuredContent: { envelope: null } } as never);
    await expect(bridge.fetchView("v1")).rejects.toThrow("no compiled model");
    appMock.callServerTool.mockResolvedValueOnce({
      content: [],
      structuredContent: { views: [{ schemaVersion: 1, viewId: "other", emphases: [] }] },
    } as never);
    await expect(bridge.fetchEmphasis("v1")).rejects.toThrow("no emphasis snapshot");
  });

  it("consumes hidden UI payloads for explicit text tool output", async () => {
    const onPresent = vi.fn();
    connectBridge({ onPresent, onClear: vi.fn() });
    await vi.dynamicImportSettled();
    const payload = {
      envelope: { view: { id: "v1" } },
      presentation: { presentationId: "p1", viewId: "v1" },
      diagnostics: [],
    };
    appMock.toolResultHandler?.({ content: [{ type: "text", text: "Presented." }], _meta: { "archer/ui": payload } });
    expect(onPresent).toHaveBeenCalledWith({ type: "present", ...payload });
  });

  it("closes the app when disconnected", async () => {
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await vi.dynamicImportSettled();

    bridge.disconnect();
    await flushPromises();

    expect(appMock.close).toHaveBeenCalledTimes(1);
  });

  it("logs a rejected connection without an unhandled rejection", async () => {
    const error = new Error("host unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    appMock.connect.mockRejectedValueOnce(error);

    expect(() => connectBridge({ onPresent: vi.fn(), onClear: vi.fn() })).not.toThrow();
    await flushPromises();

    expect(consoleError).toHaveBeenCalledWith("[archer] MCP Apps bridge connection failed", error);
  });
});

describe("connectBridge HTTP transport", () => {
  const connectionInfo = {
    browserProtocolMajor: 1,
    supportedBrowserProtocolMajors: [1],
    serverEpoch: "12345678-1234-1234-1234-123456789abc",
    capabilities: [],
    applicationVersion: "0.1.0",
    semanticSchemaVersion: 2,
  };
  async function openStream() {
    MockEventSource.instances[0].onopen?.(new Event("open"));
    await flushPromises();
    await flushPromises();
  }

  class MockEventSource {
    static instances: MockEventSource[] = [];

    readonly close = vi.fn();
    readonly listeners = new Map<string, (event: { data: string }) => void>();
    onerror: ((event: unknown) => void) | null = null;
    onopen: ((event: Event) => void) | null = null;

    constructor(readonly url: string) {
      MockEventSource.instances.push(this);
    }

    addEventListener(type: string, listener: (event: { data: string }) => void): void {
      this.listeners.set(type, listener);
    }

    emit(type: string, data: unknown): void {
      this.listeners.get(type)?.({ data: JSON.stringify(data) });
    }
  }

  const response = (body: unknown, ok = true) => ({
    json: vi.fn(() => Promise.resolve(body)),
    ok,
    status: ok ? 200 : 500,
  });

  beforeEach(() => {
    appMock.events.length = 0;
    MockEventSource.instances.length = 0;
    vi.stubGlobal("window", { location: { protocol: "http:" } });
    vi.stubGlobal("EventSource", MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("dispatches a non-null bootstrap snapshot using a relative URL", async () => {
    const snapshot = {
      envelope: { view: { id: "v1" } },
      presentation: { presentationId: "p1", viewId: "v1" },
      diagnostics: [],
    };
    const fetchMock = vi.fn(() => Promise.resolve(response(snapshot)));
    vi.stubGlobal("fetch", fetchMock);
    const onPresent = vi.fn();

    connectBridge({ onPresent, onClear: vi.fn() });
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      "api/bootstrap",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(onPresent).toHaveBeenCalledWith({ type: "present", ...snapshot });
    expect(appMock.events).toEqual([]);
  });

  // A bare `null` is what `api/bootstrap` actually sends when nothing is
  // presented, and that is the frozen contract. It is the first row below and
  // the only one any server produces today.
  //
  // The other rows are not predictions about the contract. They pin that the
  // bridge reads "empty" off the PRESENTATION -- the absence of a
  // `presentation` key -- rather than off the shape of the envelope around it.
  // A bridge testing `snapshot === null` would report any other empty spelling
  // as "response did not contain a presentation snapshot" and leave a stale
  // diagram on screen instead of clearing it. This costs nothing and removes a
  // way for the UI to fail loudly at something harmless.
  //
  // Nothing here implies bootstrap will grow a payload: it is the source of
  // truth for presentation only. Inventory lives at `GET /api/diagrams` and
  // the `inventory` SSE event, and neither carries the other.
  it.each([
    ["a bare null -- what the server actually sends", null],
    ["an object carrying no presentation", { session: "s1" }],
    ["an object carrying nothing at all", {}],
  ])("clears when the bootstrap reports nothing presented: %s", async (_label, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response(body))),
    );
    const onClear = vi.fn();
    const onPresent = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    connectBridge({ onPresent, onClear });
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onPresent).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("still reports a bootstrap snapshot it cannot understand", async () => {
    // A `presentation` key with the rest of the payload missing is a broken
    // snapshot, not an empty one -- silently clearing would hide a real fault.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response({ presentation: {} }))),
    );
    const onClear = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    connectBridge({ onPresent: vi.fn(), onClear });
    await vi.dynamicImportSettled();

    // The rejection travels one `await` further than the success path, so this
    // waits for the report rather than assuming a fixed number of ticks.
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("[archer] HTTP bridge bootstrap failed", expect.any(Error));
    });
    expect(onClear).not.toHaveBeenCalled();
  });

  it("ignores bootstrap keys it does not own", async () => {
    // The body already carries more than the bridge consumes -- `ui` today.
    // Reading only the three keys it owns is what keeps an unrelated field
    // from being mistaken for a malformed snapshot.
    const snapshot = {
      diagnostics: [],
      envelope: { view: { id: "v1" } },
      presentation: { presentationId: "p1", viewId: "v1" },
      ui: {},
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response(snapshot))),
    );
    const onPresent = vi.fn();

    connectBridge({ onPresent, onClear: vi.fn() });
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(onPresent).toHaveBeenCalledWith({
      type: "present",
      envelope: snapshot.envelope,
      presentation: snapshot.presentation,
      diagnostics: [],
    });
  });

  it("dispatches presentation events from the SSE stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => Promise.resolve(response(path === "api/connection" ? connectionInfo : null))),
    );
    const onPresent = vi.fn();
    const snapshot = {
      envelope: { view: { id: "v2" } },
      presentation: { presentationId: "p2", viewId: "v2" },
      diagnostics: [],
    };

    connectBridge({ onPresent, onClear: vi.fn() });
    await vi.dynamicImportSettled();
    const source = MockEventSource.instances[0];
    await openStream();
    source.emit("presentation", snapshot);

    expect(source.url).toBe("api/events");
    expect(onPresent).toHaveBeenCalledWith({ type: "present", ...snapshot });
  });

  it("posts selection JSON using a relative URL", async () => {
    const fetchMock = vi.fn((path: string) =>
      Promise.resolve(response(path === "api/connection" ? connectionInfo : null)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const context = { schemaVersion: 1, viewId: "v1" };
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await vi.dynamicImportSettled();

    await openStream();
    bridge.setSelection(context);
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith("api/selection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(context),
    });
  });

  // A 409 names a presentation or revision the agent has just replaced: the page publishes again for the new
  // one. Reporting it would be a console error for an expected race; any other failure is still reported.
  for (const [statusCode, reported] of [
    [409, false],
    [500, true],
  ] as const) {
    it(`a selection answered HTTP ${statusCode} is ${reported ? "" : "not "}reported as an error`, async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const fetchMock = vi.fn((path: string) =>
          Promise.resolve(
            path === "api/selection"
              ? { json: vi.fn(() => Promise.resolve(null)), ok: false, status: statusCode }
              : response(path === "api/connection" ? connectionInfo : null),
          ),
        );
        vi.stubGlobal("fetch", fetchMock);
        const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
        await vi.dynamicImportSettled();
        await openStream();
        bridge.setSelection({ schemaVersion: 1, viewId: "v1", revision: "r1" });
        await flushPromises();
        await flushPromises();
        expect(fetchMock).toHaveBeenCalledWith("api/selection", expect.anything());
        const logged = errors.mock.calls.some((call) => String(call[0]).includes("selection publication"));
        expect(logged).toBe(reported);
      } finally {
        errors.mockRestore();
      }
    });
  }

  it("publishes revision-stamped selection while reconciliation is pending, but pauses after stream loss", async () => {
    const fetchMock = vi.fn((path: string) =>
      path === "api/bootstrap"
        ? new Promise(() => {})
        : Promise.resolve(response(path === "api/connection" ? connectionInfo : null)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await vi.dynamicImportSettled();
    await openStream();
    const context = { schemaVersion: 1, viewId: "v1", revision: `sha256:${"a".repeat(64)}` };
    bridge.setSelection(context);
    await flushPromises();
    expect(fetchMock.mock.calls.filter(([path]) => path === "api/selection")).toHaveLength(1);
    MockEventSource.instances[0].onerror?.(new Event("error"));
    bridge.setSelection(context);
    await flushPromises();
    expect(fetchMock.mock.calls.filter(([path]) => path === "api/selection")).toHaveLength(1);
    bridge.disconnect();
  });

  it("loads the inventory from api/diagrams and follows the inventory event", async () => {
    const registered = [{ id: "system-context", kind: "c4-context", title: "System context", registration: "durable" }];
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        response(
          url === "api/connection"
            ? connectionInfo
            : url === "api/diagrams"
              ? { schemaVersion: 1, views: registered }
              : null,
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onInventory = vi.fn();

    connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onInventory });
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(fetchMock).toHaveBeenCalledWith(
      "api/diagrams",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(onInventory).toHaveBeenLastCalledWith(registered);

    // The event rides the EXISTING stream; a second one would be a second
    // subscription to the same connection-scoped state.
    expect(MockEventSource.instances).toHaveLength(1);
    await openStream();
    MockEventSource.instances[0].emit("inventory", { schemaVersion: 1, views: [] });
    expect(onInventory).toHaveBeenLastCalledWith([]);
  });

  it("asks for no inventory when the caller wants none", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(response(null)));
    vi.stubGlobal("fetch", fetchMock);

    connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(fetchMock.mock.calls.map((call: unknown[]) => call[0])).not.toContain("api/diagrams");
  });

  it("keeps the known inventory when an event is not one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => Promise.resolve(response(path === "api/connection" ? connectionInfo : null))),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onInventory = vi.fn();

    connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onInventory });
    await vi.dynamicImportSettled();
    await openStream();
    onInventory.mockClear();
    MockEventSource.instances[0].emit("inventory", { schemaVersion: 1 });

    expect(onInventory).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("[archer] HTTP bridge inventory event failed", expect.any(Error));
  });

  it("reads a view envelope without writing anything", async () => {
    const envelope = { schemaVersion: 2, view: { id: "system-context" } };
    const fetchMock = vi.fn(() => Promise.resolve(response(envelope)));
    vi.stubGlobal("fetch", fetchMock);
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await vi.dynamicImportSettled();

    await expect(bridge.fetchView("system-context")).resolves.toEqual(envelope);
    expect(fetchMock).toHaveBeenCalledWith(
      "api/diagrams/system-context",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(
      fetchMock.mock.calls.filter(
        (call: unknown[]) => call[1] !== undefined && (call[1] as RequestInit).method !== undefined,
      ),
    ).toEqual([]);
  });

  it("re-reads a view with its ETag and reuses the held copy on 304", async () => {
    const envelope = { schemaVersion: 2, view: { id: "v1" } };
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path !== "api/diagrams/v1") return Promise.resolve(response(null));
      const held = (init?.headers as Record<string, string> | undefined)?.["if-none-match"];
      const answer = held === '"t1"' ? { ...response(null), ok: false, status: 304 } : response(envelope);
      return Promise.resolve({ ...answer, headers: new Headers({ etag: '"t1"' }) });
    });
    vi.stubGlobal("fetch", fetchMock);
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await vi.dynamicImportSettled();

    await expect(bridge.fetchView("v1")).resolves.toEqual(envelope);
    // Unchanged since that read: no body, and the refresh says so.
    await expect(bridge.refreshView?.("v1")).resolves.toBeNull();
    // A tab click on an unchanged view still gets the envelope, from the held copy.
    await expect(bridge.fetchView("v1")).resolves.toEqual(envelope);
    const reads = fetchMock.mock.calls.filter(([path]) => path === "api/diagrams/v1");
    expect(
      reads.map(([, init]) => (init?.headers as Record<string, string> | undefined)?.["if-none-match"] ?? null),
    ).toEqual([null, '"t1"', '"t1"']);
    expect(reads.every(([, init]) => init?.cache === "no-store")).toBe(true);
  });

  it("rejects a view the server does not know", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response({ error: "unknown view" }, false))),
    );
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await vi.dynamicImportSettled();

    await expect(bridge.fetchView("gone")).rejects.toThrow(/view gone/);
  });

  it("escapes a view id into the path", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(response({})));
    vi.stubGlobal("fetch", fetchMock);
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await vi.dynamicImportSettled();

    await bridge.fetchView("a/../b");

    expect(fetchMock).toHaveBeenCalledWith(
      "api/diagrams/a%2F..%2Fb",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
  });

  it("closes the SSE stream when disconnected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response(null))),
    );
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await vi.dynamicImportSettled();

    bridge.disconnect();

    expect(MockEventSource.instances[0].close).toHaveBeenCalledTimes(1);
  });

  it("logs bootstrap failures without an unhandled rejection", async () => {
    const error = new Error("bootstrap unavailable");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(error)),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => connectBridge({ onPresent: vi.fn(), onClear: vi.fn() })).not.toThrow();
    await flushPromises();

    expect(consoleError).toHaveBeenCalledWith("[archer] HTTP bridge bootstrap failed", error);
  });

  // A console line is not an answer to the person looking at the page. Without
  // a callback the shell never hears that the question failed, so it goes on
  // saying "Loading..." for a request that will never come back.
  it("tells the shell when bootstrap could not be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("bootstrap unavailable"))),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onBootstrapError = vi.fn();

    connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onBootstrapError });
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(onBootstrapError).toHaveBeenCalledTimes(1);
  });

  it("tells the shell when bootstrap answers HTTP 500", async () => {
    // The case the finding names: server UP, stream connected, bootstrap
    // failing. Distinct from the transport being unreachable, and equally
    // unanswerable by the page.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response({ error: "boom" }, false))),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onBootstrapError = vi.fn();
    const onClear = vi.fn();

    connectBridge({ onPresent: vi.fn(), onClear, onBootstrapError });
    await vi.dynamicImportSettled();
    // Twice: rejecting from inside the async `then` handler takes an extra
    // turn for the returned promise to be adopted before `catch` sees it.
    await flushPromises();
    await flushPromises();

    expect(onBootstrapError).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
  });

  // G12: every page view used to end with `console.error "HTTP bridge event stream failed"`. A dropped
  // stream reconnects by itself and the status line says so; only giving up is worth a console line.
  it("a dropped stream reconnects without a console line: the connection status says it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => Promise.resolve(response(path === "api/connection" ? connectionInfo : null))),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const onConnection = vi.fn();
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onConnection });
    await vi.dynamicImportSettled();
    await openStream();
    MockEventSource.instances[0].onerror?.(new Event("error"));
    await flushPromises();
    expect(onConnection).toHaveBeenLastCalledWith("lost");
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    bridge.disconnect();
  });

  // ADR 0032: `archer restart` tells every stream to reconnect, then the replacement takes the address.
  it("a planned hand-over keeps the page's status: no lost, and the replacement stream reconciles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) => Promise.resolve(response(path === "api/connection" ? connectionInfo : null))),
    );
    const onConnection = vi.fn();
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onConnection });
    await vi.dynamicImportSettled();
    await openStream();
    vi.useFakeTimers();
    try {
      MockEventSource.instances[0].emit("reconnect", { reason: "handover" });
      MockEventSource.instances[0].onerror?.(new Event("error"));
      await vi.advanceTimersByTimeAsync(300);
      expect(MockEventSource.instances).toHaveLength(2);
      MockEventSource.instances[1].onopen?.(new Event("open"));
      await vi.advanceTimersByTimeAsync(0);
      MockEventSource.instances[1].emit("standing", { seq: 1 });
      await vi.advanceTimersByTimeAsync(20000);
      expect(onConnection).not.toHaveBeenCalledWith("lost");
      expect(onConnection).toHaveBeenLastCalledWith("connected");
    } finally {
      vi.useRealTimers();
      bridge.disconnect();
    }
  });

  it("warns once when the stream gives up for good", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string) =>
        Promise.resolve(
          path === "api/connection"
            ? { json: vi.fn(() => Promise.resolve(null)), ok: false, status: 403 }
            : response(null),
        ),
      ),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onConnection: vi.fn() });
    await vi.dynamicImportSettled();
    await openStream();
    await flushPromises();
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledWith("[archer] HTTP bridge event stream gave up", "access-required");
    expect(consoleError).not.toHaveBeenCalled();
    bridge.disconnect();
  });

  it("logs nothing for the stream or the reads the browser drops while the page is leaving", async () => {
    vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { protocol: "http:" } }));
    const pending: ((error: Error) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise((_resolve, reject) => pending.push(reject))),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onConnection: vi.fn() });
    await vi.dynamicImportSettled();
    expect(pending.length).toBeGreaterThan(0);
    window.dispatchEvent(new Event("pagehide"));
    MockEventSource.instances[0].onerror?.(new Event("error"));
    for (const reject of pending.splice(0)) reject(new TypeError("Failed to fetch"));
    await flushPromises();
    await flushPromises();
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    bridge.disconnect();
  });

  it("reports no bootstrap failure when bootstrap answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response(null))),
    );
    const onBootstrapError = vi.fn();

    connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onBootstrapError });
    await vi.dynamicImportSettled();
    await flushPromises();

    expect(onBootstrapError).not.toHaveBeenCalled();
  });
});

/**
 * The transport decision replaces the hand-rolled origin pinning that
 * `connectBridge` used to carry. An earlier change handed the postMessage
 * transport to `@modelcontextprotocol/ext-apps`, so the six trust-on-first-use
 * origin tests that used to live here were asserting against code that no
 * longer exists and have been deleted.
 *
 * What remains security-relevant is which transport gets built. An embedded
 * `ui://` app must talk to the host through the SDK and must never issue
 * same-origin `fetch`/`EventSource` calls to a `/api/*` path it does not own;
 * a browser-served page must do the opposite and must never hand credentials
 * to a postMessage peer. Routing on the wrong protocol picks the wrong peer,
 * so each protocol gets an assertion on both halves: the transport that must
 * be built, and the one that must not.
 */
describe("connectBridge transport routing", () => {
  const cases = [
    { protocol: "ui:", transport: "sdk", mode: "mcp" },
    { protocol: "file:", transport: "sdk", mode: "mcp" },
    { protocol: "http:", transport: "http", mode: "web" },
    { protocol: "https:", transport: "http", mode: "web" },
  ] as const;

  let fetchMock: ReturnType<typeof vi.fn>;
  let eventSourceMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    appMock.events.length = 0;
    fetchMock = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(null) }));
    eventSourceMock = vi.fn(function (this: Record<string, unknown>) {
      this.addEventListener = vi.fn();
      this.close = vi.fn();
      this.onerror = null;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", eventSourceMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  for (const { protocol, transport, mode } of cases) {
    it(`routes a ${protocol} document to the ${transport} transport in ${mode} mode`, async () => {
      vi.stubGlobal("window", { location: { protocol } });

      // The shell reads `hostMode()` and the transport is chosen by the same
      // call, so a bridge that reports a mode its transport contradicts is the
      // failure this pins: chrome and transport are one decision.
      expect(hostMode()).toBe(mode);
      expect(connectBridge({ onPresent: vi.fn(), onClear: vi.fn() }).mode).toBe(mode);
      await vi.dynamicImportSettled();

      if (transport === "sdk") {
        expect(appMock.events).toEqual(["add:toolresult", "connect"]);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(eventSourceMock).not.toHaveBeenCalled();
      } else {
        expect(appMock.events).toEqual([]);
        expect(fetchMock).toHaveBeenCalledWith(
          "api/bootstrap",
          expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
        );
        expect(eventSourceMock).toHaveBeenCalledWith("api/events");
      }
    });
  }

  it("builds no transport at all outside a browser", async () => {
    vi.stubGlobal("window", undefined);

    const bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await vi.dynamicImportSettled();
    bridge.setSelection({ viewId: "v1" });
    bridge.disconnect();

    // No window means no chrome: "mcp" is the shell that adds none.
    expect(bridge.mode).toBe("mcp");
    expect(hostMode()).toBe("mcp");
    expect(appMock.events).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(eventSourceMock).not.toHaveBeenCalled();
  });
});
