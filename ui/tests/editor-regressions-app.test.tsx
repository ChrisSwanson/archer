// @vitest-environment jsdom
// Editor fix-round regression at the page level: the reading page's diagram-switch keys stay off while editing.
// Harness copied from diagram-switcher.test.tsx (kept apart to avoid merge conflicts).
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("@modelcontextprotocol/ext-apps", () => ({
  App: class MockApp {
    addEventListener(): void {}
    callServerTool = vi.fn(() => Promise.resolve({ content: [] }));
    close = vi.fn(() => Promise.resolve());
    connect = vi.fn(() => Promise.resolve());
    updateModelContext = vi.fn(() => Promise.resolve({}));
  },
}));
vi.mock("../src/source-editor/lazy", () => ({ useSourceEditor: () => null, preloadSourceEditor: async () => null }));

import { App } from "../src/app/App";
import { MockEventSource } from "./app-harness";
import { installViewport } from "./match-media";

const view = (id: string, title: string) => ({ id, kind: "data-flow", title, registration: "durable" as const });
const VIEWS = [
  view("compile", "Compile pipeline"),
  view("orders", "Order lifecycle"),
  view("shop", "Web shop containers"),
];
const envelope = (viewId: string) => ({
  schemaVersion: 2,
  view: { id: viewId, kind: "data-flow", title: viewId },
  revision: `sha256:${"0".repeat(63)}${VIEWS.findIndex((v) => v.id === viewId) + 1}`,
  model: { type: "data-flow-graph", nodes: [{ id: "web", label: "Web" }], edges: [], groups: [] },
});
const REAL_LOCATION = Object.getOwnPropertyDescriptor(window, "location")!;
function serveAt(pathname: string): void {
  const real = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new Proxy(real, {
      get: (target, key) => (key === "protocol" ? "http:" : key === "pathname" ? pathname : Reflect.get(target, key)),
    }),
  });
}
let fetched: string[];
function stubRoutes(): void {
  fetched = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((requested: string) => {
      // The page sits at a project path here, so its relative requests resolve below it.
      const url = String(requested).replace(/^.*\/p\/web-shop\//, "");
      fetched.push(url);
      if (url === "api/browser-projects" || url === "api/projects")
        return Promise.resolve({ ok: false, status: 404, json: async () => null });
      const viewId = url.startsWith("api/diagrams/") ? url.slice("api/diagrams/".length) : null;
      const body =
        url === "api/diagrams"
          ? { schemaVersion: 1, views: VIEWS }
          : url === "api/compile"
            ? { schemaVersion: 1, failures: [] }
            : viewId !== null
              ? envelope(viewId)
              : null;
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }),
  );
}
beforeEach(() => {
  MockEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", MockEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, "location", REAL_LOCATION);
});

const PATH = "/projects/web-shop/";
const QUERY = "?follow&view=orders";
async function mount(edit: boolean): Promise<void> {
  installViewport({ width: 1440, coarse: false });
  window.history.replaceState(null, "", `${PATH}${QUERY}${edit ? "&edit" : ""}`);
  serveAt(PATH);
  stubRoutes();
  await act(async () => {
    render(<App />);
  });
  await waitFor(() => expect(fetched).toContain("api/diagrams/orders"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
}
const diagramReads = () => fetched.filter((url) => url.startsWith("api/diagrams/"));
const press = async (key: string) => {
  await act(async () => {
    fireEvent.keyDown(window, { key });
  });
};

test("] switches to the next diagram while reading (control for smoke-c#2)", async () => {
  await mount(false);
  await press("]");
  await waitFor(() => expect(diagramReads()).toContain("api/diagrams/shop"));
});

test("[ and ] don't switch diagrams while a diagram is open for editing (smoke-c#2)", async () => {
  await mount(true);
  // The editor is what is open: it asked for editing access.
  await waitFor(() => expect(fetched.some((url) => url.startsWith("api/authoring"))).toBe(true));
  const before = diagramReads().length,
    at = window.location.href;
  for (const key of ["]", "]", "["]) await press(key);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  expect(diagramReads()).toHaveLength(before);
  expect(window.location.href).toBe(at);
});
