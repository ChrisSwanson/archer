import { fileButton, filesTable } from "./support/primary-navigation";
// @vitest-environment jsdom
//
// A view the READER picked stays current.
//
// The server pushes a redraw only for the view it is presenting. A tab the
// reader picks is read once, by a GET, and the page was never told when that
// view's file changed: the drawing went stale with nothing to say so (release
// review 2026-10-01, I14). The stream's inventory now names every view's model
// revision; the page re-reads the picked view when that revision moves, and
// asks nothing on a timer.
//
// What is pinned here is the rule; `tests/browser/live-reload.e2e.ts` (in the Rust implementation, not in this tree) pins
// the outcome against a real file, a real watcher and the real route.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import { App } from "../src/app/App";
import { MockEventSource, restoreLocation, serveOverHttp } from "./app-harness";

const revisionOf = (letter: string): string => `sha256:${letter.repeat(64)}`;
const view = (id: string, title: string, revision: string) => ({
  id,
  kind: "data-flow",
  title,
  registration: "durable" as const,
  modelRevision: revisionOf(revision),
});
const VIEWS = [view("alpha", "Alpha", "a"), view("beta", "Beta", "b")];

function envelope(viewId: string, revision: string, nodeIds: readonly string[]): unknown {
  return {
    schemaVersion: 2,
    view: { id: viewId, kind: "data-flow", title: viewId },
    revision: revisionOf(revision),
    model: {
      type: "data-flow-graph",
      nodes: nodeIds.map((id) => ({ id, label: id })),
      edges: [],
      groups: [],
    },
  };
}

/** What `api/diagrams/<id>` answers right now; a test changes it to "edit the file". */
let served: Record<string, unknown>;
/** Views whose read fails, as a view that has just been unregistered does. */
let failing: Set<string>;
let fetchSpy: ReturnType<typeof vi.fn>;

const reads = (viewId: string): number =>
  fetchSpy.mock.calls.filter(([url]) => url === `api/diagrams/${viewId}`).length;
const posts = (): unknown[] => fetchSpy.mock.calls.filter(([url]) => url === "api/selection");
const drawn = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLElement>(".react-flow__node")].map((node) => node.dataset.id ?? "").sort();

/** A second passes, and whatever it started is allowed to land: nothing should, as nothing polls. */
async function tick(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
  });
}

/** The file changed and recompiled: the stream's inventory names the view's new model revision. */
function announce(source: MockEventSource, revisions: Record<string, string>): void {
  act(() => {
    source.emit("inventory", {
      schemaVersion: 1,
      views: [view("alpha", "Alpha", revisions.alpha ?? "a"), view("beta", "Beta", revisions.beta ?? "b")],
    });
  });
}

async function mountAndPick(viewId: string): Promise<{ container: HTMLElement; source: MockEventSource }> {
  serveOverHttp();
  const { container } = render(<App />);
  await act(async () => {
    MockEventSource.instances[0].onopen?.(new Event("open"));
  });
  await filesTable();
  fireEvent.click(fileButton(new RegExp(`^${viewId}`, "i")));
  await waitFor(() => expect(drawn(container).length).toBeGreaterThan(0));
  fireEvent.click(screen.getByRole("button", { name: "Select mode" }));
  return { container, source: MockEventSource.instances[0] };
}

beforeEach(() => {
  // Only the interval is faked: `waitFor` polls on `setTimeout`, and the
  // layout runs on real promises.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
  served = {
    alpha: envelope("alpha", "a", ["web", "api"]),
    beta: envelope("beta", "b", ["queue"]),
  };
  failing = new Set();
  fetchSpy = vi.fn((url: string) => {
    const viewId = url.startsWith("api/diagrams/") ? url.slice("api/diagrams/".length) : null;
    if (viewId !== null && failing.has(viewId)) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    }
    const body =
      url === "api/connection"
        ? {
            browserProtocolMajor: 1,
            supportedBrowserProtocolMajors: [1],
            serverEpoch: "12345678-1234-1234-1234-123456789abc",
            capabilities: [],
            applicationVersion: "0.1.0",
            semanticSchemaVersion: 2,
          }
        : url === "api/diagrams"
          ? { schemaVersion: 1, views: VIEWS }
          : url === "api/compile"
            ? { schemaVersion: 1, failures: [] }
            : viewId !== null
              ? served[viewId]
              : url.startsWith("api/emphasis/")
                ? { schemaVersion: 1, viewId: "alpha", emphases: [] }
                : null;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  restoreLocation();
});

describe("a view the reader picked", () => {
  it("is redrawn when its file changes, without the reader doing anything", async () => {
    const { container, source } = await mountAndPick("alpha");
    expect(drawn(container)).toEqual(["api", "web"]);

    served.alpha = envelope("alpha", "c", ["web", "api", "ledger"]);
    announce(source, { alpha: "c" });

    await waitFor(() => expect(drawn(container)).toEqual(["api", "ledger", "web"]));
  });

  it("is left exactly as it is, and not asked again, while its revision has not moved", async () => {
    const { container, source } = await mountAndPick("alpha");
    const before = container.querySelector('.react-flow__node[data-id="web"]');
    const readsThen = reads("alpha");

    await tick();
    // Another view moved: this one is not read.
    announce(source, { beta: "d" });
    await tick();

    expect(reads("alpha"), "nothing asks for an unchanged view, on a timer or otherwise").toBe(readsThen);
    // The same element: nothing was torn down and redrawn for an unchanged model.
    expect(container.querySelector('.react-flow__node[data-id="web"]')).toBe(before);
  });

  it("keeps what is selected in it across the redraw, and publishes it at the new revision", async () => {
    const { container, source } = await mountAndPick("alpha");
    fireEvent.click(container.querySelector('.react-flow__node[data-id="api"]')!);
    await waitFor(() => expect(container.querySelector('.react-flow__node[data-id="api"].selected')).not.toBeNull());

    served.alpha = envelope("alpha", "c", ["web", "api", "ledger"]);
    announce(source, { alpha: "c" });
    await waitFor(() => expect(drawn(container)).toEqual(["api", "ledger", "web"]));

    expect(container.querySelector('.react-flow__node[data-id="api"].selected')).not.toBeNull();
    // The server holds a selection to the view's CURRENT model (ADR 0011), so
    // the one the reader still has is stamped again and said again.
    await waitFor(() => {
      const last = (posts().at(-1) as [string, { body: string }])[1].body;
      expect(JSON.parse(last)).toMatchObject({
        viewId: "alpha",
        presentationId: "reader:alpha",
        revision: revisionOf("c"),
        nodes: [{ id: "api" }],
      });
    });
  });

  it("stops being read once the agent presents something", async () => {
    const { container, source } = await mountAndPick("alpha");

    act(() => {
      source.emit("presentation", {
        envelope: served.beta,
        presentation: { presentationId: "agent-run", viewId: "beta" },
        diagnostics: [],
      });
    });
    await waitFor(() => expect(drawn(container)).toEqual(["queue"]));

    const readsThen = reads("alpha");
    served.alpha = envelope("alpha", "c", ["web", "api", "ledger"]);
    announce(source, { alpha: "c" });
    await tick();

    expect(reads("alpha"), "a view nobody is looking at was read").toBe(readsThen);
    expect(reads("beta"), "the agent's view is pushed, never read").toBe(0);
    expect(drawn(container), "the picked view was pulled back over the agent's").toEqual(["queue"]);
  });

  it("keeps its drawing, quietly, when a read fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container, source } = await mountAndPick("alpha");
    const readsThen = reads("alpha");

    failing.add("alpha");
    announce(source, { alpha: "c" });
    await waitFor(() => expect(reads("alpha")).toBeGreaterThan(readsThen));
    await tick();

    expect(drawn(container)).toEqual(["api", "web"]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("is not read while the page is hidden, and is read as soon as it is shown again", async () => {
    const { container, source } = await mountAndPick("alpha");
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const readsThen = reads("alpha");

    served.alpha = envelope("alpha", "c", ["web", "api", "ledger"]);
    announce(source, { alpha: "c" });
    await tick();
    expect(reads("alpha")).toBe(readsThen);

    hidden.mockReturnValue(false);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(drawn(container)).toEqual(["api", "ledger", "web"]));
    hidden.mockRestore();
  });
});

describe("a view the agent presented", () => {
  it("is never read: the server pushes it", async () => {
    serveOverHttp();
    const { container } = render(<App />);
    await waitFor(() => expect(MockEventSource.instances[0]).toBeDefined());
    await act(async () => {
      MockEventSource.instances[0].onopen?.(new Event("open"));
    });
    act(() => {
      MockEventSource.instances[0].emit("presentation", {
        envelope: served.alpha,
        presentation: { presentationId: "agent-run", viewId: "alpha" },
        diagnostics: [],
      });
    });
    await waitFor(() => expect(drawn(container)).toEqual(["api", "web"]));

    announce(MockEventSource.instances[0], { alpha: "c" });
    await tick();

    expect(reads("alpha")).toBe(0);
  });
});
