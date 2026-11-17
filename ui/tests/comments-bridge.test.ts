// @vitest-environment jsdom
//
// How the page learns that the server supports comments and notes (the
// bootstrap's `capabilities`), and how it hears that they changed (the
// `comments` and `notes` events on the one existing stream).
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

import { connectBridge as createBridge } from "../src/app/host-bridge";
import { CONNECTION, ENVELOPE, MockEventSource } from "./app-harness";
import { NO_CAPABILITIES } from "../src/comments/contract";
const bridges: ReturnType<typeof createBridge>[] = [];
function connectBridge(...args: Parameters<typeof createBridge>) {
  const bridge = createBridge(...args);
  bridges.push(bridge);
  MockEventSource.instances[0]?.onopen?.(new Event("open"));
  return bridge;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function serve(given: Record<string, unknown>): void {
  const routes: Record<string, unknown> = { "api/connection": CONNECTION, ...given };
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      url in routes
        ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(routes[url]) })
        : Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) }),
    ),
  );
}

const PRESENTED = {
  presentation: { presentationId: "p1", viewId: "alpha" },
  envelope: ENVELOPE,
  diagnostics: [],
};

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("window", { location: { protocol: "http:" } });
});

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.disconnect();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("capabilities", () => {
  it.each([
    [
      "a presentation that names them",
      { ...PRESENTED, capabilities: { comments: true, notes: true } },
      { comments: true, notes: true },
    ],
    // Nothing presented is the absence of `presentation`, so the capabilities
    // can still ride along when nothing is on screen.
    [
      "nothing presented, with capabilities",
      { capabilities: { comments: true, notes: false } },
      { comments: true, notes: false },
    ],
    ["a bare null", null, { comments: false, notes: false }],
    ["a presentation without them", PRESENTED, { comments: false, notes: false }],
  ])("reads them off the bootstrap: %s", async (_name, bootstrap, expected) => {
    serve({ "api/bootstrap": bootstrap });
    const onCapabilities = vi.fn();
    const onClear = vi.fn();
    connectBridge({ onPresent: vi.fn(), onClear, onCapabilities });
    await flush();
    expect(onCapabilities).toHaveBeenLastCalledWith({ ...NO_CAPABILITIES, ...expected });
  });

  it("still treats a capabilities-only bootstrap as nothing presented", async () => {
    serve({ "api/bootstrap": { capabilities: { comments: true, notes: true } } });
    const onClear = vi.fn();
    const onBootstrapError = vi.fn();
    connectBridge({ onPresent: vi.fn(), onClear, onBootstrapError, onCapabilities: vi.fn() });
    await flush();
    expect(onClear).toHaveBeenCalled();
    expect(onBootstrapError).not.toHaveBeenCalled();
  });

  it("reads them again off a presentation event that carries them", async () => {
    serve({ "api/bootstrap": null });
    const onCapabilities = vi.fn();
    connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onCapabilities });
    await flush();
    MockEventSource.instances[0]!.emit("presentation", { ...PRESENTED, capabilities: { comments: true, notes: true } });
    expect(onCapabilities).toHaveBeenLastCalledWith({ ...NO_CAPABILITIES, comments: true, notes: true });
  });
});

describe("change events", () => {
  it("reports a comments event for a target", async () => {
    serve({ "api/bootstrap": null });
    const onComments = vi.fn();
    connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onComments });
    await flush();
    MockEventSource.instances[0]!.emit("comments", { target: "view:alpha" });
    expect(onComments).toHaveBeenCalledWith({ target: "view:alpha" });
  });

  it("drops a comments event that names no target, and says so", async () => {
    serve({ "api/bootstrap": null });
    const onComments = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onComments });
    await flush();
    MockEventSource.instances[0]!.emit("comments", { target: 3 });
    expect(onComments).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it("reports a notes event, with or without a view", async () => {
    serve({ "api/bootstrap": null });
    const onNotes = vi.fn();
    connectBridge({ onPresent: vi.fn(), onClear: vi.fn(), onNotes });
    await flush();
    MockEventSource.instances[0]!.emit("notes", { viewId: "alpha" });
    MockEventSource.instances[0]!.emit("notes", {});
    expect(onNotes.mock.calls).toEqual([[{ viewId: "alpha" }], [{}]]);
  });
});
