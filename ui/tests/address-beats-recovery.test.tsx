// @vitest-environment jsdom
//
// The page's own address beats the project's remembered reader selection (round 1, pass 5, L-app). The service keeps
// one `reader:<view>` recovery per project, written by whichever reader opened a diagram last; a page addressed to
// another diagram must never draw that view first, nor ask for its emphasis, walkthroughs or comments. A reload of
// the same diagram still gets its selection back.
import { cleanup, render, waitFor } from "@testing-library/react";
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

import { App } from "../src/app/App";
import { MockEventSource, restoreLocation, serveOverHttp } from "./app-harness";

const VIEWS = [
  { id: "alpha", kind: "data-flow", title: "Alpha", registration: "durable", sourcePath: "diagrams/alpha.mmd" },
  { id: "beta", kind: "data-flow", title: "Beta", registration: "durable", sourcePath: "diagrams/beta.mmd" },
];
const revision = (viewId: string): string => `sha256:${(viewId === "alpha" ? "a" : "b").repeat(64)}`;
const envelope = (viewId: string) => ({
  schemaVersion: 2,
  view: { id: viewId, kind: "data-flow", title: viewId === "alpha" ? "Alpha" : "Beta" },
  revision: revision(viewId),
  model: {
    type: "data-flow-graph",
    nodes: [
      { id: "web", label: `web of ${viewId}` },
      { id: "api", label: `api of ${viewId}` },
    ],
    edges: [{ id: "calls", source: "web", target: "api", label: "calls" }],
    groups: [],
  },
});
/** Another reader's last page: alpha, with its API box selected. */
const RECOVERY = {
  selection: {
    schemaVersion: 1,
    viewId: "alpha",
    revision: revision("alpha"),
    presentationId: "reader:alpha",
    selectionRevision: 3,
    nodes: [{ id: "api" }],
    edges: [],
  },
  envelope: envelope("alpha"),
};

let calls: string[] = [];
/** Every node label the page has drawn, in order. */
let drawn: string[] = [];
let observer: MutationObserver | undefined;

function mount(path: string): void {
  serveOverHttp();
  window.history.replaceState(null, "", path);
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn((requested: string) => {
      const url = requested.replace(/^.*?(?=api\/)/, "");
      calls.push(url);
      const route = url.split("?")[0]!;
      const viewId = route.startsWith("api/diagrams/") ? decodeURIComponent(route.slice("api/diagrams/".length)) : null;
      const body =
        route === "api/bootstrap"
          ? { capabilities: { comments: true, notes: true }, project: { name: "p" }, recovery: RECOVERY }
          : route === "api/diagrams"
            ? { schemaVersion: 1, views: VIEWS }
            : viewId !== null
              ? envelope(viewId)
              : route === "api/compile"
                ? { schemaVersion: 1, failures: [] }
                : route.startsWith("api/emphasis/")
                  ? { schemaVersion: 1, viewId: decodeURIComponent(route.slice("api/emphasis/".length)), emphases: [] }
                  : route === "api/comments"
                    ? { schemaVersion: 2, target: "view:x", threads: [] }
                    : route === "api/comments/pending"
                      ? { total: 0, targets: [] }
                      : // Neither diagram has threads, so the project inbox reads none of them on its own.
                        route === "api/comment-activity"
                        ? { schemaVersion: 1, targets: {} }
                        : route === "api/notes/all"
                          ? { notes: [] }
                          : null;
      return Promise.resolve({
        ok: body !== null,
        status: body === null ? 404 : 200,
        json: () => Promise.resolve(body),
      });
    }),
  );
  observer = new MutationObserver(() => {
    for (const node of document.querySelectorAll(".react-flow__node")) {
      const text = node.textContent ?? "";
      if (drawn.at(-1) !== text && !drawn.includes(text)) drawn.push(text);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  render(<App />);
  queueMicrotask(() => MockEventSource.instances[0]?.onopen?.(new Event("open")));
}

beforeEach(() => {
  MockEventSource.instances = [];
  calls = [];
  drawn = [];
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  observer?.disconnect();
  cleanup();
  window.history.replaceState(null, "", "/");
  restoreLocation();
  vi.unstubAllGlobals();
});

it("never draws another reader's remembered view, nor reads its emphasis, walkthroughs or comments, on a page addressed to another diagram", async () => {
  mount("/projects/p/diagrams/beta.mmd");
  await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(2));
  await waitFor(() => expect(document.querySelector(".react-flow__node")?.textContent).toContain("of beta"));
  // A little longer, so anything late would have landed.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(drawn.filter((text) => text.includes("of alpha"))).toEqual([]);
  expect(calls.filter((url) => /alpha/.test(url))).toEqual([]);
  expect(document.querySelectorAll(".react-flow__node.selected")).toHaveLength(0);
});

it("restores the remembered selection on a page addressed to that same diagram", async () => {
  mount("/projects/p/diagrams/alpha.mmd");
  await waitFor(() => expect(document.querySelector(".react-flow__node")?.textContent).toContain("of alpha"));
  await waitFor(() =>
    expect([...document.querySelectorAll(".react-flow__node.selected")].map((node) => node.textContent)).toEqual([
      "api of alpha",
    ]),
  );
  expect(drawn.filter((text) => text.includes("of beta"))).toEqual([]);
});
