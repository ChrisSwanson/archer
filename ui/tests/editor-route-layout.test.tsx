// @vitest-environment jsdom
//
// The editor's own route (a new diagram, or the editor for a file) draws its own preview: a graph presented
// behind it is not on screen, so it is not laid out (no layout worker, 349 KB, for a picture nobody sees).
// The lab found it on new-diagram after flow-diagram: the bootstrap's `recovery` (the reader's last view,
// flow-styled) was restored behind the editor and laid out (perf/fix-a open item 1).
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

const layout = vi.hoisted(() => ({ started: [] as string[] }));

vi.mock("../src/layout/elk-adapter", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/layout/elk-adapter")>();
  const computeLayout: typeof real.computeLayout = async (view, typeface) => {
    layout.started.push(view.viewId);
    return real.computeLayout(view, typeface);
  };
  return { ...real, computeLayout };
});

import { App } from "../src/app/App";
import { ENVELOPE, MockEventSource, restoreLocation, serveOverHttp, settle, stubRoutes } from "./app-harness";

const startPath = window.location.pathname;

beforeEach(() => {
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
  layout.started.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreLocation();
  window.history.replaceState(null, "", startPath);
});

/** An agent's sequence (laid out without the worker), standing as the lab's fixture presents one. */
const SEQUENCE = {
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

/** The bootstrap after a reader looked at the graph alpha: the agent's sequence stands, alpha is remembered. */
const REMEMBERED = {
  presentation: { presentationId: "seq", viewId: "trace", revision: SEQUENCE.revision, viewport: "fit-all" },
  envelope: SEQUENCE,
  diagnostics: [],
  recovery: {
    selection: {
      schemaVersion: 1,
      viewId: "alpha",
      revision: ENVELOPE.revision,
      presentationId: "reader:alpha",
      selectionRevision: 0,
      nodes: [],
      edges: [],
    },
    envelope: ENVELOPE,
  },
};

async function rememberedOn(path: string): Promise<void> {
  window.history.replaceState(null, "", path);
  serveOverHttp();
  stubRoutes({ bootstrap: REMEMBERED });
  // A project route asks `<origin>/p/<slug>/api/…`; the harness answers the page-relative `api/…`.
  const answer = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string, init?: unknown) =>
    answer(String(url).replace(/^https?:\/\/[^/]+\/p\/[^/]+\//u, ""), init as RequestInit),
  );
  render(<App />);
  await waitFor(() => expect(MockEventSource.instances[0]).toBeDefined());
  await act(async () => {
    MockEventSource.instances[0].onopen?.(new Event("open"));
  });
  await act(async () => {
    for (let i = 0; i < 8; i++) await settle();
  });
}

async function presentOn(path: string): Promise<void> {
  window.history.replaceState(null, "", path);
  serveOverHttp();
  stubRoutes();
  render(<App />);
  await waitFor(() => expect(MockEventSource.instances[0]).toBeDefined());
  const source = MockEventSource.instances[0];
  await act(async () => {
    source.onopen?.(new Event("open"));
  });
  act(() => {
    source.emit("presentation", {
      envelope: ENVELOPE,
      presentation: { presentationId: "p1", viewId: "alpha" },
      diagnostics: [],
    });
  });
  await act(async () => {
    for (let i = 0; i < 6; i++) await settle();
  });
}

describe("the agent's presented graph on the editor's route", () => {
  it("is not laid out while a new diagram is being written", async () => {
    await presentOn("/projects/demo/-/edit/");
    expect(layout.started, "the presented graph was laid out behind the editor").toEqual([]);
  });

  it("is not laid out when the reader's remembered view is restored behind a new diagram", async () => {
    await rememberedOn("/projects/demo/-/edit/");
    expect(layout.started, "the remembered graph was laid out behind the editor").toEqual([]);
  });

  it("is laid out when the remembered view is restored on the project's own route (the control)", async () => {
    await rememberedOn("/");
    await waitFor(() => expect(layout.started).toContain("alpha"));
  });

  it("is laid out on the project's own route (the control)", async () => {
    await presentOn("/");
    await waitFor(() => expect(layout.started).toContain("alpha"));
  });
});
