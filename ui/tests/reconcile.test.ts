// @vitest-environment jsdom
//
// ROUTES FOR STATE, EVENTS FOR CHANGES (ADR 0010, "Reconnection").
//
// The stream replays nothing, so whatever was announced while it was down is
// gone. A page that marked itself connected on `open` and re-read only the
// compile status kept a retired drawing and an old tab strip on screen with
// the warning withdrawn (adversarial review 2026-10-02, F1). These pin the
// bridge half of the fix: what is read, when the page is told it is current,
// and what is deliberately NOT said again. The outcome on a real page, through
// a real `EventSource`, is `tests/browser/reconnect.e2e.ts` (in the Rust implementation, not in this tree).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

import { RECONCILE_RETRY_MS, connectBridge as createBridge, type BridgeCallbacks } from "../src/app/host-bridge";
import { MockEventSource } from "./app-harness";
const bridges: ReturnType<typeof createBridge>[] = [];
function connectBridge(...args: Parameters<typeof createBridge>) {
  const bridge = createBridge(...args);
  bridges.push(bridge);
  return bridge;
}

const REVISION_A = `sha256:${"a".repeat(64)}`;
const REVISION_B = `sha256:${"b".repeat(64)}`;

const VIEW_A = { id: "a", kind: "c4-context", title: "A", registration: "ephemeral" };
const VIEW_B = { id: "b", kind: "c4-context", title: "B", registration: "ephemeral" };
const inventory = (...views: unknown[]) => ({ schemaVersion: 1, views });
const snapshot = (viewId: string, revision = REVISION_A, extra: Record<string, unknown> = {}) => ({
  envelope: { view: { id: viewId }, revision },
  presentation: { presentationId: "p1", viewId, revision, ...extra },
  diagnostics: [],
});
const emphases = (viewId: string, ...ids: string[]) => ({
  schemaVersion: 1,
  viewId,
  emphases: ids.map((id) => ({
    id,
    viewId,
    title: id,
    groups: [
      { id: "path", style: "flow", palette: "teal", state: "existing", speed: "slow", nodes: ["web"], edges: [] },
    ],
  })),
});
const NOTHING_FAILING = { schemaVersion: 1, failures: [] };

/** The routes, as a table the test rewrites to move the server's state. */
let routes: Record<string, unknown>;
/** Routes that answer with an error status. */
let broken: Set<string>;
let fetchMock: ReturnType<typeof vi.fn>;

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const asked = (url: string): number => fetchMock.mock.calls.filter(([called]) => called === url).length;

type Spies = { [K in keyof Required<BridgeCallbacks>]: ReturnType<typeof vi.fn> };

function connect(viewOnScreen: string | null = "a"): { spies: Spies; source: MockEventSource } {
  const spies = {
    onPresent: vi.fn(),
    onRecovery: vi.fn(),
    onClear: vi.fn(),
    onInventory: vi.fn(),
    onInventoryError: vi.fn(),
    onBootstrapError: vi.fn(),
    onConnection: vi.fn(),
    onEmphasis: vi.fn(),
    onCompileStatus: vi.fn(),
    onCapabilities: vi.fn(),
    onComments: vi.fn(),
    onNotes: vi.fn(),
    onWalkthroughs: vi.fn(),
    onDocuments: vi.fn(),
    onChange: vi.fn(),
    viewOnScreen: vi.fn(() => viewOnScreen),
  } satisfies Spies;
  connectBridge(spies as unknown as BridgeCallbacks);
  return { spies, source: MockEventSource.instances[0] };
}

/** Opens the stream and lets the reads it starts come back. */
async function open(source: MockEventSource): Promise<void> {
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  MockEventSource.instances.at(-1)?.onopen?.(new Event("open"));
  await flush();
}

function drop(source: MockEventSource): void {
  MockEventSource.instances.at(-1)?.onerror?.(new Event("error"));
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("window", { location: { protocol: "http:" } });
  vi.spyOn(console, "error").mockImplementation(() => {});
  routes = {
    "api/connection": {
      browserProtocolMajor: 1,
      supportedBrowserProtocolMajors: [1],
      serverEpoch: "12345678-1234-1234-1234-123456789abc",
      capabilities: [],
      applicationVersion: "0.1.0",
      semanticSchemaVersion: 2,
    },
    "api/diagrams": inventory(VIEW_A),
    "api/bootstrap": snapshot("a"),
    "api/compile": NOTHING_FAILING,
    "api/emphasis/a": emphases("a"),
  };
  broken = new Set();
  fetchMock = vi.fn((url: string) =>
    url in routes && !broken.has(url)
      ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(routes[url]) })
      : Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reconciling when the stream opens", () => {
  it("is not connected until the stream is open and what it read has been applied", async () => {
    const { spies, source } = connect();
    await flush();
    // The routes have answered, and no stream is open yet: nothing is claimed.
    expect(spies.onPresent).toHaveBeenCalledTimes(1);
    expect(spies.onConnection).not.toHaveBeenCalled();

    source.onopen?.(new Event("open"));
    // Open, and the reads are still out: still nothing claimed.
    expect(spies.onConnection).not.toHaveBeenCalled();
    await flush();

    expect(spies.onConnection.mock.calls).toEqual([["connected"]]);
  });

  it("reads the registry, the presentation, what compiles and the emphasis on screen, again on every reopened stream", async () => {
    const { source } = connect();
    await flush();
    await open(source);
    drop(source);
    await open(source);

    // The page's own read is the first stream's (it opened within a second of it); the reopened stream reads again.
    for (const url of ["api/diagrams", "api/bootstrap", "api/compile"]) {
      expect(asked(url), url).toBe(2);
    }
    expect(asked("api/emphasis/a")).toBe(2);
  });

  it("reads again on the first stream when the page's own read is more than a second old", async () => {
    const { spies, source } = connect();
    await flush();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 5000);
    await open(source);
    expect(asked("api/diagrams")).toBe(2);
    expect(spies.onConnection.mock.calls).toEqual([["connected"]]);
  });

  it("adopts the page's own read for the first stream when it opens before that read has finished", async () => {
    const { spies, source } = connect();
    source.onopen?.(new Event("open"));
    await flush();
    expect(asked("api/diagrams")).toBe(1);
    expect(spies.onConnection.mock.calls).toEqual([["connected"]]);
  });

  // The race the adoption opened (browser suite: an agent presenting right after the page loaded was
  // never drawn): the service answered the page's read, published a change, and only then took the
  // stream, so the stream will never say it. The service numbers what it publishes; a read carries
  // the number it was answered at, the stream's first event the number it started from.
  const numbered = (seq: number) => {
    fetchMock.mockImplementation((url: string) =>
      url in routes && !broken.has(url)
        ? Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: (name: string) => (name === "x-archer-event-seq" ? String(seq) : null) },
            json: () => Promise.resolve(routes[url]),
          })
        : Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve(null) }),
    );
  };

  it("reads again on the first stream when the service published something between the page's read and the stream", async () => {
    numbered(3);
    const { spies, source } = connect();
    await flush();
    await open(source);
    routes["api/bootstrap"] = snapshot("b");
    routes["api/diagrams"] = inventory(VIEW_A, VIEW_B);
    source.emit("standing", { seq: 4 });
    await flush();
    expect(asked("api/bootstrap")).toBe(2);
    expect(spies.onPresent.mock.calls.at(-1)?.[0]).toMatchObject({ presentation: { viewId: "b" } });
  });

  it("reads again when the stream's standing count arrives before the page's side of it opens", async () => {
    numbered(3);
    const { source } = connect();
    await flush();
    source.emit("standing", { seq: 5 });
    await open(source);
    await flush();
    expect(asked("api/bootstrap")).toBe(2);
  });

  it("keeps the adopted read when the stream started from what that read already saw", async () => {
    numbered(3);
    const { source } = connect();
    await flush();
    await open(source);
    source.emit("standing", { seq: 3 });
    await flush();
    expect(asked("api/bootstrap")).toBe(1);
  });

  // Under load the stream can open seconds after the page's read (O1: every standing read, the emphasis on
  // screen with them, asked twice). A numbered read needs no age limit: the standing count says whether
  // anything was published since it was answered.
  it("adopts a numbered read for the first stream however late it opens, and reads again only when the count moved", async () => {
    numbered(3);
    const { spies, source } = connect();
    await flush();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 5000);
    await open(source);
    source.emit("standing", { seq: 3 });
    await flush();
    for (const url of ["api/diagrams", "api/bootstrap", "api/compile", "api/emphasis/a"])
      expect(asked(url), url).toBe(1);
    expect(spies.onConnection.mock.calls).toEqual([["connected"]]);
    drop(source);
    await open(source);
    MockEventSource.instances.at(-1)!.emit("standing", { seq: 4 });
    await flush();
    expect(asked("api/bootstrap")).toBe(2);
  });

  it("reads again on a late first stream when the numbered read was answered before a publication", async () => {
    numbered(3);
    const { source } = connect();
    await flush();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 5000);
    await open(source);
    source.emit("standing", { seq: 4 });
    await flush();
    expect(asked("api/bootstrap")).toBe(2);
  });

  it("applies a view that was unregistered while the stream was down, and says nothing is presented", async () => {
    const { spies, source } = connect();
    await flush();
    await open(source);
    drop(source);
    expect(spies.onConnection).toHaveBeenLastCalledWith("lost");

    routes["api/diagrams"] = inventory();
    routes["api/bootstrap"] = null;
    await open(source);

    expect(spies.onInventory).toHaveBeenLastCalledWith([]);
    expect(spies.onClear).toHaveBeenCalledTimes(1);
    // The registry first: the page decides what a retired presentation means
    // from what is registered now.
    expect(spies.onInventory.mock.invocationCallOrder.at(-1)).toBeLessThan(spies.onClear.mock.invocationCallOrder[0]);
    expect(spies.onConnection).toHaveBeenLastCalledWith("connected");
    expect(spies.onClear.mock.invocationCallOrder[0]).toBeLessThan(spies.onConnection.mock.invocationCallOrder.at(-1)!);
  });

  it("applies a view registered and presented while the stream was down", async () => {
    const { spies, source } = connect();
    await flush();
    await open(source);
    drop(source);

    routes["api/diagrams"] = inventory(VIEW_A, VIEW_B);
    routes["api/bootstrap"] = snapshot("b");
    await open(source);

    expect(spies.onInventory).toHaveBeenLastCalledWith([VIEW_A, VIEW_B]);
    expect(spies.onPresent).toHaveBeenLastCalledWith({ type: "present", ...snapshot("b") });
  });

  it("applies a recompile and a compile failure that happened while the stream was down", async () => {
    const { spies, source } = connect();
    await flush();
    await open(source);
    drop(source);

    routes["api/bootstrap"] = snapshot("a", REVISION_B);
    routes["api/compile"] = {
      schemaVersion: 1,
      failures: [{ viewId: "a", sourceRevision: REVISION_B, lastValidRevision: REVISION_A, diagnostics: [] }],
    };
    await open(source);

    expect(spies.onPresent).toHaveBeenLastCalledWith({ type: "present", ...snapshot("a", REVISION_B) });
    expect(spies.onCompileStatus.mock.calls.at(-1)?.[0]).toHaveLength(1);
  });

  it("applies an emphasis set, and one cleared, while the stream was down", async () => {
    const { spies, source } = connect();
    await flush();
    await open(source);
    drop(source);

    routes["api/emphasis/a"] = emphases("a", "walkthrough");
    await open(source);
    expect(spies.onEmphasis.mock.calls.at(-1)?.[0].emphases).toHaveLength(1);

    drop(source);
    routes["api/emphasis/a"] = emphases("a");
    await open(source);
    expect(spies.onEmphasis.mock.calls.at(-1)?.[0].emphases).toEqual([]);
  });

  it("does not present again what the page already holds", async () => {
    // An explicit framing instruction in the command is the case that bites:
    // applied a second time, it frames the drawing again.
    routes["api/bootstrap"] = snapshot("a", REVISION_A, { viewport: "fit-all" });
    const { spies, source } = connect();
    await flush();
    await open(source);
    drop(source);
    await open(source);

    expect(spies.onPresent).toHaveBeenCalledTimes(1);
    expect(spies.onClear).not.toHaveBeenCalled();
    expect(spies.onConnection).toHaveBeenLastCalledWith("connected");
  });

  it("does not clear again a page that already holds nothing", async () => {
    routes["api/bootstrap"] = null;
    const { spies, source } = connect(null);
    await flush();
    await open(source);
    drop(source);
    await open(source);

    expect(spies.onClear).toHaveBeenCalledTimes(1);
  });

  it("still applies an event that repeats what the page holds: that is the agent presenting again", async () => {
    const { spies, source } = connect();
    await flush();
    await open(source);

    source.emit("presentation", snapshot("a"));

    expect(spies.onPresent).toHaveBeenCalledTimes(2);
  });

  it("lets an event that arrived during the read stand over the read", async () => {
    const { spies, source } = connect();
    await flush();
    await open(source);
    drop(source);

    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    const replacement = MockEventSource.instances.at(-1)!;
    // Hold the snapshot read after negotiation: ordered events supersede it.
    let answer: ((value: unknown) => void) | undefined;
    const fetchDefault = fetchMock.getMockImplementation() as (url: string, init: RequestInit) => unknown;
    fetchMock.mockImplementation((url: string, init: RequestInit) =>
      url === "api/bootstrap"
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : fetchDefault(url, init),
    );
    replacement.onopen?.(new Event("open"));
    await flush();
    replacement.emit("presentation", snapshot("b"));
    replacement.emit("inventory", inventory(VIEW_A, VIEW_B));
    answer?.({ ok: true, status: 200, json: async () => snapshot("a") });
    await flush();

    expect(spies.onPresent).toHaveBeenLastCalledWith({ type: "present", ...snapshot("b") });
    expect(spies.onInventory).toHaveBeenLastCalledWith([VIEW_A, VIEW_B]);
    expect(spies.onConnection).toHaveBeenLastCalledWith("connected");
  });

  it.each(["api/diagrams", "api/bootstrap", "api/compile", "api/emphasis/a"])(
    "does not call itself connected while %s cannot be read, and asks again until it can",
    async (url) => {
      vi.useFakeTimers();
      const { spies, source } = connect();
      await vi.advanceTimersByTimeAsync(0);
      source.onopen?.(new Event("open"));
      await vi.advanceTimersByTimeAsync(0);
      drop(source);

      broken.add(url);
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      MockEventSource.instances.at(-1)?.onopen?.(new Event("open"));
      await vi.advanceTimersByTimeAsync(0);
      expect(spies.onConnection).toHaveBeenLastCalledWith("unsynced");
      const before = asked(url);

      await vi.advanceTimersByTimeAsync(RECONCILE_RETRY_MS);
      expect(asked(url)).toBe(before + 1);
      expect(spies.onConnection).toHaveBeenLastCalledWith("unsynced");

      broken.delete(url);
      await vi.advanceTimersByTimeAsync(RECONCILE_RETRY_MS);
      expect(spies.onConnection).toHaveBeenLastCalledWith("connected");
    },
  );

  it("reports nothing for a stream that dropped before its reads came back", async () => {
    const { spies, source } = connect();
    await flush();
    await open(source);
    drop(source);

    source.onopen?.(new Event("open"));
    drop(source);
    await flush();

    expect(spies.onConnection).toHaveBeenLastCalledWith("lost");
  });
});

it("hands initial recovery over once after presentation, never on a stream reconnect", async () => {
  const recovery = { selection: { viewId: "a" }, envelope: snapshot("a").envelope };
  routes["api/bootstrap"] = { ...snapshot("a"), recovery };
  const { spies, source } = connect();
  await flush();
  expect(spies.onRecovery).toHaveBeenCalledExactlyOnceWith(recovery);
  expect(spies.onPresent.mock.invocationCallOrder[0]).toBeLessThan(spies.onRecovery.mock.invocationCallOrder[0]);
  await open(source);
  drop(source);
  await open(source);
  expect(spies.onRecovery).toHaveBeenCalledTimes(1);
});
it("a newer initial stream presentation consumes stale recovery instead of replaying it on reconnect", async () => {
  const fetchDefault = fetchMock.getMockImplementation() as (url: string, init: RequestInit) => unknown;
  let answer: ((value: unknown) => void) | undefined;
  fetchMock.mockImplementation((url: string, init: RequestInit) =>
    url === "api/bootstrap"
      ? new Promise((resolve) => {
          answer = resolve;
        })
      : fetchDefault(url, init),
  );
  const { spies, source } = connect();
  source.onopen?.(new Event("open"));
  await flush();
  source.emit("presentation", snapshot("b"));
  answer?.({
    ok: true,
    status: 200,
    json: async () => ({
      ...snapshot("a"),
      recovery: { selection: { viewId: "a" }, envelope: snapshot("a").envelope },
    }),
  });
  await flush();
  expect(spies.onRecovery).not.toHaveBeenCalled();
});
