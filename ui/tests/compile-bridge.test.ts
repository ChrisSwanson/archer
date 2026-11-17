// @vitest-environment jsdom
//
// How the compile status (ADR 0010) reaches the page on each transport: a
// route and an event over HTTP, and the `compile` key of a tool result inside
// an MCP host, which has no push channel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMock = vi.hoisted(() => ({
  toolResultHandler: undefined as ((result: unknown) => void) | undefined,
}));

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(event: string, handler: (result: unknown) => void): void {
      if (event === "toolresult") {
        appMock.toolResultHandler = handler;
      }
    }
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

import { connectBridge as createBridge } from "../src/app/host-bridge";
import { CONNECTION, MockEventSource } from "./app-harness";
const bridges: ReturnType<typeof createBridge>[] = [];
function connectBridge(...args: Parameters<typeof createBridge>) {
  const bridge = createBridge(...args);
  bridges.push(bridge);
  return bridge;
}

const REVISION_A = `sha256:${"a".repeat(64)}`;
const REVISION_B = `sha256:${"b".repeat(64)}`;

const FAILING = {
  schemaVersion: 1,
  failures: [
    {
      viewId: "graph",
      sourceRevision: REVISION_B,
      lastValidRevision: REVISION_A,
      diagnostics: [
        {
          code: "expected_label",
          message: "expected a label inside delimiters",
          span: { start: { line: 2, column: 9 }, end: { line: 2, column: 10 } },
        },
      ],
    },
  ],
};
const NOTHING_FAILING = { schemaVersion: 1, failures: [] };

/** What `FAILING` is once parsed. */
const PARSED = [
  {
    viewId: "graph",
    sourceRevision: REVISION_B,
    lastValidRevision: REVISION_A,
    problems: [{ code: "expected_label", message: "expected a label inside delimiters", line: 2, column: 9 }],
  },
];

// The MCP bridge loads its SDK lazily: wait for that import, then one macrotask.
const flush = async (): Promise<void> => {
  await vi.dynamicImportSettled();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function serve(given: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const routes: Record<string, unknown> = { "api/connection": CONNECTION, ...given };
  const fetchMock = vi.fn((url: string) =>
    url in routes
      ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(routes[url]) })
      : Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.disconnect();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("compile status over HTTP", () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    vi.stubGlobal("window", { location: { protocol: "http:" } });
  });

  it("forwards configured-document changes on the existing managed stream", async () => {
    serve({ "api/bootstrap": null, "api/compile": NOTHING_FAILING });
    const onDocuments = vi.fn();
    connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onDocuments });
    await flush();
    MockEventSource.instances[0].onopen?.(new Event("open"));
    await flush();
    MockEventSource.instances[0].emit("documents", {});
    expect(onDocuments).toHaveBeenCalledOnce();
  });

  it("hands the files event to the change-cue popup (ADR 0028)", async () => {
    const { resetFileUpdates, subscribeFileUpdates, COALESCE_MS } = await import("../src/app/file-updates");
    resetFileUpdates();
    serve({ "api/bootstrap": null, "api/compile": NOTHING_FAILING });
    connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await flush();
    MockEventSource.instances[0].onopen?.(new Event("open"));
    await flush();
    const seen: unknown[] = [];
    subscribeFileUpdates((state) => seen.push(state));
    vi.useFakeTimers();
    try {
      MockEventSource.instances[0].emit("files", {
        changed: [{ path: ".archer/notes/plan.md", kind: "note", revision: REVISION_A }],
        added: [],
        removed: [],
      });
      vi.advanceTimersByTime(COALESCE_MS);
    } finally {
      vi.useRealTimers();
    }
    expect(seen.at(-1)).toMatchObject({ text: "plan.md updated" });
  });

  it("asks what is failing when the page opens, since the stream replays nothing", async () => {
    const fetchMock = serve({ "api/bootstrap": null, "api/compile": FAILING });
    const onCompileStatus = vi.fn();

    connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onCompileStatus });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith(
      "api/compile",
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(onCompileStatus).toHaveBeenCalledWith(PARSED);
  });

  it("follows the compile event on the one existing stream", async () => {
    serve({ "api/bootstrap": null, "api/compile": NOTHING_FAILING });
    const onCompileStatus = vi.fn();
    connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onCompileStatus });
    await flush();

    expect(MockEventSource.instances).toHaveLength(1);
    MockEventSource.instances[0].onopen?.(new Event("open"));
    await flush();
    MockEventSource.instances[0].emit("compile", FAILING);
    expect(onCompileStatus).toHaveBeenLastCalledWith(PARSED);

    MockEventSource.instances[0].emit("compile", NOTHING_FAILING);
    expect(onCompileStatus).toHaveBeenLastCalledWith([]);
  });

  it("asks again every time the stream opens, because a recovery may have been missed", async () => {
    const fetchMock = serve({ "api/bootstrap": null, "api/compile": FAILING });
    const onCompileStatus = vi.fn();
    connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onCompileStatus });
    await flush();
    const source = MockEventSource.instances[0];
    const asked = (): number => fetchMock.mock.calls.filter(([url]) => url === "api/compile").length;
    expect(asked()).toBe(1);

    // The first `open` within a second of the page's own read takes that read as its own (a duplicate of
    // the same four GETs otherwise); every later open asks again, because a recovery may have been missed.
    // The whole contract is in `tests/reconcile.test.ts`.
    source.onopen?.(new Event("open"));
    await flush();
    expect(asked()).toBe(1);

    vi.spyOn(console, "error").mockImplementation(() => {});
    source.onerror?.(new Event("error"));
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    MockEventSource.instances.at(-1)?.onopen?.(new Event("open"));
    await flush();

    expect(asked()).toBe(2);
  });

  it("keeps what it knew when an event is not a compile status", async () => {
    serve({ "api/bootstrap": null, "api/compile": NOTHING_FAILING });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onCompileStatus = vi.fn();
    connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onCompileStatus });
    await flush();
    MockEventSource.instances[0].onopen?.(new Event("open"));
    await flush();
    onCompileStatus.mockClear();

    MockEventSource.instances[0].emit("compile", { schemaVersion: 1 });

    expect(onCompileStatus).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("[archer] HTTP bridge compile event failed", expect.any(Error));
  });

  it("reports a compile route that cannot be read, and claims nothing", async () => {
    serve({ "api/bootstrap": null });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onCompileStatus = vi.fn();

    connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onCompileStatus });
    await flush();

    // Not `[]`: "nothing is failing" is a claim, and this page could not find out.
    expect(onCompileStatus).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith("[archer] HTTP bridge compile status failed", expect.any(Error));
  });

  it("asks for no compile status when the caller wants none", async () => {
    const fetchMock = serve({ "api/bootstrap": null });

    connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
    await flush();

    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain("api/compile");
  });
});

describe("compile status inside an MCP host", () => {
  beforeEach(() => {
    appMock.toolResultHandler = undefined;
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      location: { protocol: "ui:" },
      parent: {},
      removeEventListener: vi.fn(),
    });
  });

  it("reads it off a presentation result, before the drawing that result carries", async () => {
    const order: string[] = [];
    const onCompileStatus = vi.fn(() => order.push("compile"));
    const onPresent = vi.fn(() => order.push("present"));
    connectBridge({ onPresent, onClear: vi.fn(), onCompileStatus });
    await flush();

    appMock.toolResultHandler?.({
      structuredContent: {
        envelope: { view: { id: "graph" } },
        presentation: { presentationId: "p1", viewId: "graph" },
        diagnostics: [],
        compile: FAILING,
      },
    });

    expect(onCompileStatus).toHaveBeenCalledWith(PARSED);
    expect(onPresent).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["compile", "present"]);
  });

  it("reads it off a result that presents nothing, such as a write", async () => {
    const onCompileStatus = vi.fn();
    const onPresent = vi.fn();
    connectBridge({ onPresent, onClear: vi.fn(), onCompileStatus });
    await flush();

    appMock.toolResultHandler?.({
      structuredContent: { revision: REVISION_B, status: "failed", diagnostics: [], compile: FAILING },
    });
    expect(onCompileStatus).toHaveBeenLastCalledWith(PARSED);

    appMock.toolResultHandler?.({
      structuredContent: { revision: REVISION_A, status: "compiled", diagnostics: [], compile: NOTHING_FAILING },
    });
    expect(onCompileStatus).toHaveBeenLastCalledWith([]);
    expect(onPresent).not.toHaveBeenCalled();
  });

  it("takes a result with no compile key to say nothing about it", async () => {
    const onCompileStatus = vi.fn();
    connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onCompileStatus });
    await flush();

    appMock.toolResultHandler?.({ structuredContent: { schemaVersion: 1, viewId: "graph", emphases: [] } });
    appMock.toolResultHandler?.({ structuredContent: undefined });

    expect(onCompileStatus).not.toHaveBeenCalled();
  });
});
