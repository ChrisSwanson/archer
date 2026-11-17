// @vitest-environment jsdom
// The stream bridge hands the service's `listeners` event to the chat as a window event, and says when the
// stream opened (it replays nothing, so the chat reads the listing again). ADR 0035 §8.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));

import { connectBridge } from "../src/app/host-bridge";
import { LISTENERS_DOM_EVENT, LISTENERS_LOST } from "../src/chat/listener-event";
import { CONNECTION, MockEventSource, restoreLocation, serveOverHttp } from "./app-harness";

const seen: unknown[] = [];
const hear = (event: Event): void => {
  seen.push((event as CustomEvent<unknown>).detail);
};
let bridge: ReturnType<typeof connectBridge> | undefined;
beforeEach(() => {
  serveOverHttp();
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", MockEventSource);
  // A service with no connection route: the bridge then trusts the bootstrap (as comments-bridge.test.ts serves it).
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve(
        url === "api/connection"
          ? { ok: true, status: 200, json: () => Promise.resolve(CONNECTION) }
          : url === "api/bootstrap"
            ? { ok: true, status: 200, json: () => Promise.resolve(null) }
            : { ok: false, status: 404, json: () => Promise.resolve(null) },
      ),
    ),
  );
  seen.length = 0;
  window.addEventListener(LISTENERS_DOM_EVENT, hear);
});
afterEach(() => {
  bridge?.disconnect();
  window.removeEventListener(LISTENERS_DOM_EVENT, hear);
  vi.unstubAllGlobals();
  restoreLocation();
});

it("passes each listeners event on, and an open of the stream as null", async () => {
  bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
  const stream = MockEventSource.instances[0]!;
  stream.onopen?.(new Event("open"));
  // The open is said once the stream is negotiated.
  await vi.waitFor(() => expect(seen).toEqual([null]));
  const listing = {
    current: { root: "/r", state: "none", listener: null, pinnedByPerson: false, agents: [] },
    otherCheckouts: [],
  };
  stream.emit("listeners", listing);
  await vi.waitFor(() => expect(seen).toEqual([null, listing]));
});

it("says a dropped stream as lost, so the chat stops claiming who listens until it reads again", async () => {
  bridge = connectBridge({ onPresent: vi.fn(), onClear: vi.fn() });
  const stream = MockEventSource.instances[0]!;
  stream.onopen?.(new Event("open"));
  await vi.waitFor(() => expect(seen).toEqual([null]));
  stream.onerror?.(new Event("error"));
  await vi.waitFor(() => expect(seen).toEqual([null, LISTENERS_LOST]));
});
