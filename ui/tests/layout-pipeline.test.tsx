// @vitest-environment jsdom
//
// Two promises `App` makes about graph layout, asserted on what is drawn and
// on whether the layout function ran -- not on reducer counters, which is all
// that held them before (release review 2026-10-01, surviving mutants U1 and
// U2: applying a stale layout result, and a cache that always misses).
//
//   1. A layout that finishes after a newer presentation has taken the page is
//      dropped. Layout is asynchronous, so presenting A and then B can resolve
//      as B, A; A's result must not be drawn over B.
//   2. A focus change on the view already on screen does not lay it out again
//      (plan section 5.2). The picture is the same; only what is dimmed moves.
//
// `computeLayout` is wrapped, not replaced: every call still runs the real ELK
// layout, and the wrapper only counts the calls and can hold one back.
import { act, cleanup, render, waitFor } from "@testing-library/react";
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

const layout = vi.hoisted(() => ({
  /** The view id of every layout that was started, in order. */
  started: [] as string[],
  /** View id -> a promise its layout waits on before it resolves. */
  held: new Map<string, Promise<void>>(),
}));

vi.mock("../src/layout/elk-adapter", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/layout/elk-adapter")>();
  const computeLayout: typeof real.computeLayout = async (view, typeface) => {
    layout.started.push(view.viewId);
    // Read when the layout STARTS: a hold placed for one call must not be
    // lifted, or picked up, by what the test does while the layout runs.
    const hold = layout.held.get(view.viewId);
    const result = await real.computeLayout(view, typeface);
    await hold;
    return result;
  };
  return { ...real, computeLayout };
});

import { App } from "../src/app/App";
import { DIMMED_OPACITY } from "../src/diagrams/focus-style";
import {
  ENVELOPE,
  MockEventSource,
  mountAgentPresented,
  restoreLocation,
  serveOverHttp,
  settle,
  stubRoutes,
} from "./app-harness";

/** A second view, with node ids the first does not have. */
const OTHER = {
  schemaVersion: 2,
  view: { id: "beta", kind: "data-flow", title: "Beta" },
  revision: `sha256:${"b".repeat(64)}`,
  model: {
    type: "data-flow-graph",
    nodes: [
      { id: "queue", label: "Queue" },
      { id: "worker", label: "Worker" },
      { id: "store", label: "Store" },
    ],
    edges: [{ id: "feeds", source: "queue", target: "worker" }],
    groups: [],
  },
};

const drawnIds = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLElement>(".react-flow__node")].map((node) => node.dataset.id ?? "").sort();

function presentTo(source: MockEventSource, envelope: unknown, presentation: Record<string, unknown>): void {
  act(() => {
    source.emit("presentation", { envelope, presentation, diagnostics: [] });
  });
}

beforeEach(() => {
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
  layout.started.length = 0;
  layout.held.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreLocation();
});

describe("a layout that finishes late", () => {
  it("is not drawn over the presentation that superseded it", async () => {
    serveOverHttp();
    stubRoutes();
    const { container } = render(<App />);
    await waitFor(() => expect(MockEventSource.instances[0]).toBeDefined());
    const source = MockEventSource.instances[0];
    await act(async () => {
      source.onopen?.(new Event("open"));
    });

    let release = (): void => {};
    layout.held.set("alpha", new Promise<void>((resolve) => (release = resolve)));

    // Alpha is presented and its layout is held back...
    presentTo(source, ENVELOPE, { presentationId: "first", viewId: "alpha" });
    await waitFor(() => expect(layout.started).toEqual(["alpha"]));

    // ...beta is presented meanwhile, and is drawn.
    presentTo(source, OTHER, { presentationId: "second", viewId: "beta" });
    await waitFor(() => expect(drawnIds(container)).toEqual(["queue", "store", "worker"]));

    // Alpha's layout finishes now. It answers a question nobody is asking.
    await act(async () => {
      release();
      await settle();
      await settle();
    });

    expect(drawnIds(container), "the superseded view's layout was drawn").toEqual(["queue", "store", "worker"]);
    expect(layout.started).toEqual(["alpha", "beta"]);
  });

  it("is not drawn over a newer revision of the same view", async () => {
    serveOverHttp();
    stubRoutes();
    const { container } = render(<App />);
    await waitFor(() => expect(MockEventSource.instances[0]).toBeDefined());
    const source = MockEventSource.instances[0];
    await act(async () => {
      source.onopen?.(new Event("open"));
    });

    let release = (): void => {};
    layout.held.set("alpha", new Promise<void>((resolve) => (release = resolve)));
    presentTo(source, ENVELOPE, { presentationId: "first", viewId: "alpha" });
    await waitFor(() => expect(layout.started).toEqual(["alpha"]));

    // The same view at a new revision: a second layout of alpha, not held.
    layout.held.clear();
    const edited = {
      ...ENVELOPE,
      revision: `sha256:${"c".repeat(64)}`,
      model: { ...ENVELOPE.model, nodes: [...ENVELOPE.model.nodes, { id: "ledger", label: "Ledger" }] },
    };
    presentTo(source, edited, { presentationId: "first", viewId: "alpha" });
    await waitFor(() => expect(drawnIds(container)).toEqual(["api", "ledger", "web"]));

    await act(async () => {
      release();
      await settle();
      await settle();
    });

    expect(drawnIds(container), "the older revision's layout replaced the newer one").toEqual(["api", "ledger", "web"]);
  });
});

describe("the layout cache", () => {
  it("draws a focus change on the view on screen without laying it out again", async () => {
    const { container, source } = await mountAgentPresented(<App />);
    expect(layout.started).toEqual(["alpha"]);

    presentTo(source, ENVELOPE, { presentationId: "agent-run", viewId: "alpha", focus: { nodeIds: ["web"] } });

    // The focus is drawn: the node outside it is dimmed...
    const bystander = (): HTMLElement => container.querySelector<HTMLElement>('.react-flow__node[data-id="api"]')!;
    await waitFor(() => expect(bystander().style.opacity).toBe(String(DIMMED_OPACITY)));
    await act(settle);
    // ...and the layout function was not called a second time to draw it.
    expect(layout.started, "a same-view focus reran the layout").toEqual(["alpha"]);

    // Nor for a second focus, nor for clearing it.
    presentTo(source, ENVELOPE, { presentationId: "agent-run", viewId: "alpha", focus: { nodeIds: ["api"] } });
    await waitFor(() => expect(bystander().style.opacity).toBe("1"));
    presentTo(source, ENVELOPE, { presentationId: "agent-run", viewId: "alpha" });
    await waitFor(() =>
      expect(container.querySelector<HTMLElement>('.react-flow__node[data-id="web"]')!.style.opacity).toBe("1"),
    );
    await act(settle);
    expect(layout.started).toEqual(["alpha"]);
  });

  it("does lay the view out again when its model changes", async () => {
    const { container, source } = await mountAgentPresented(<App />);
    const edited = {
      ...ENVELOPE,
      revision: `sha256:${"c".repeat(64)}`,
      model: { ...ENVELOPE.model, nodes: [...ENVELOPE.model.nodes, { id: "ledger", label: "Ledger" }] },
    };

    presentTo(source, edited, { presentationId: "agent-run", viewId: "alpha" });

    await waitFor(() => expect(drawnIds(container)).toEqual(["api", "ledger", "web"]));
    expect(layout.started).toEqual(["alpha", "alpha"]);
  });
});

describe("a sequence diagram (ledger perf#7)", () => {
  it("is drawn without ELK: no graph layout starts for it", async () => {
    serveOverHttp();
    stubRoutes();
    const { findAllByText } = render(<App />);
    await waitFor(() => expect(MockEventSource.instances[0]).toBeDefined());
    const source = MockEventSource.instances[0];
    await act(async () => {
      source.onopen?.(new Event("open"));
    });
    const sequence = {
      schemaVersion: 2,
      view: { id: "trace", kind: "sequence", title: "Trace" },
      revision: `sha256:${"d".repeat(64)}`,
      model: {
        type: "sequence-trace",
        participants: [
          { id: "p", label: "Client" },
          { id: "q", label: "Server" },
        ],
        events: [{ type: "message", id: "msg-0", from: "p", to: "q", kind: "sync", label: "call" }],
      },
    };
    presentTo(source, sequence, { presentationId: "seq", viewId: "trace" });
    expect((await findAllByText("Server")).length).toBeGreaterThan(0);
    // A graph presented after it is laid out; had the sequence started a layout, it would come first.
    presentTo(source, ENVELOPE, { presentationId: "graph", viewId: "alpha" });
    await waitFor(() => expect(layout.started).toContain("alpha"));
    expect(layout.started).toEqual(["alpha"]);
  });
});
