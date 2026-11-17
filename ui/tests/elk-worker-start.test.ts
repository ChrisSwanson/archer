// The page starts its ELK worker on its first graph layout (an MCP host at boot), and keeps that one
// worker for every drawing until the page goes (perf #1; PF-5: a page without a graph never fetches it).
import { afterEach, expect, it, vi } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { ProjectedView } from "../src/diagrams/projection";
import {
  computeBackgroundLayout,
  resetBackgroundLayout,
  startBackgroundLayout,
  startsLayoutAtBoot,
} from "../src/layout/elk-worker-transport";
import { computeLayout } from "../src/layout/elk-layout";
import { DEFAULT_TYPEFACE } from "../src/layout/text-measure";

vi.unmock("../src/layout/elk-worker-transport");
afterEach(() => {
  vi.unstubAllGlobals();
  resetBackgroundLayout();
});

const view: ProjectedView = {
  viewId: "start",
  kind: "freeform",
  title: "Start",
  revision: "1",
  modelType: "freeform-graph",
  nodes: [
    { id: "a", label: "A", shape: undefined, classes: [], groupId: undefined },
    { id: "b", label: "B", shape: undefined, classes: [], groupId: undefined },
  ],
  edges: [{ id: "hop", source: "a", target: "b", label: "calls" }],
  groups: [],
};

/** Made before `Worker` is stubbed: the bundled ELK picks its own worker from the global. */
const elk = new ELK();
type Request = { id: number; cmd: string; graph?: ElkNode };
const workers: Kernel[] = [];
class Kernel {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  sent: Request[] = [];
  terminate = vi.fn();
  constructor() {
    workers.push(this);
  }
  postMessage(message: Request) {
    this.sent.push(message);
    if (message.cmd === "register" || message.cmd === "algorithms")
      queueMicrotask(() => this.onmessage?.({ data: { id: message.id, data: [] } } as MessageEvent));
    else
      void elk
        .layout(message.graph!)
        .then((data) => this.onmessage?.({ data: { id: message.id, data } } as MessageEvent));
  }
  get layouts() {
    return this.sent.filter((message) => message.cmd === "layout");
  }
}
function stubBrowser() {
  workers.length = 0;
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("Worker", Kernel);
}

it("starts the worker and, once ELK has loaded, runs one small warm-up layout", async () => {
  stubBrowser();
  startBackgroundLayout();
  expect(workers).toHaveLength(1);
  await vi.waitFor(() => expect(workers[0]!.layouts).toHaveLength(1));
  expect(workers[0]!.sent.map((message) => message.cmd)).toEqual(["register", "algorithms", "layout"]);
  // Archer's own options, so the warm-up compiles the code paths a real drawing takes.
  expect(workers[0]!.layouts[0]!.graph!.layoutOptions).toMatchObject({
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.edgeRouting": "ORTHOGONAL",
  });
});

it("lays out every later drawing on the worker it started, and starts it only once", async () => {
  stubBrowser();
  startBackgroundLayout();
  startBackgroundLayout();
  await vi.waitFor(() => expect(workers[0]!.layouts).toHaveLength(1));
  await computeBackgroundLayout(view, DEFAULT_TYPEFACE);
  await computeBackgroundLayout({ ...view, edges: [] }, DEFAULT_TYPEFACE);
  expect(workers).toHaveLength(1);
  expect(workers[0]!.layouts).toHaveLength(3);
});

it("skips the warm-up when a drawing asks before ELK has loaded", async () => {
  stubBrowser();
  startBackgroundLayout();
  const drawn = computeBackgroundLayout(view, DEFAULT_TYPEFACE);
  await drawn;
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(workers[0]!.layouts).toHaveLength(1);
  expect(workers[0]!.layouts[0]!.graph!.children!.map((child) => child.id)).toEqual(["a", "b"]);
});

it("starts no new worker once the page is going, and starts one again if it comes back", async () => {
  workers.length = 0;
  const page = new EventTarget();
  vi.stubGlobal("window", page);
  vi.stubGlobal("Worker", Kernel);
  const pending = computeBackgroundLayout(view, DEFAULT_TYPEFACE);
  // The page is left while ELK is still busy: the outgoing page's layout is refused, and asking again
  // (as the nested view's fallback does) must not fetch a worker for a page nobody will see.
  page.dispatchEvent(new Event("pagehide"));
  await expect(pending).rejects.toThrow(/page is closing/);
  await expect(computeBackgroundLayout({ ...view, edges: [] }, DEFAULT_TYPEFACE)).rejects.toThrow(/page is closing/);
  startBackgroundLayout();
  expect(workers).toHaveLength(1);
  // Back from the back/forward cache: the page draws again.
  page.dispatchEvent(new Event("pageshow"));
  await computeBackgroundLayout({ ...view, edges: [] }, DEFAULT_TYPEFACE);
  expect(workers).toHaveLength(2);
});

it("a browser without workers starts nothing and throws nothing", () => {
  vi.stubGlobal("Worker", undefined);
  expect(() => startBackgroundLayout()).not.toThrow();
});

it("the web page starts no worker at boot; an MCP host does (PF-5)", () => {
  // A sequence diagram, its editor, the empty draft and a sequence by its folder path draw without ELK; even a graph's
  // page waits for its first layout (computeBackgroundLayout), so no address costs the worker before a graph needs it.
  expect(startsLayoutAtBoot("web")).toBe(false);
  // An MCP host presents a diagram, and its worker is inline (no fetch to save).
  expect(startsLayoutAtBoot("mcp")).toBe(true);
});

it("an empty graph (the new draft's starter) is laid out without a worker, as ELK lays it out (PF-5)", async () => {
  const empty: ProjectedView = { ...view, viewId: "draft", nodes: [], edges: [], groups: [] };
  const expected = await computeLayout(empty, DEFAULT_TYPEFACE, { layout: (graph: ElkNode) => elk.layout(graph) });
  stubBrowser();
  const drawn = await computeBackgroundLayout(empty, DEFAULT_TYPEFACE);
  expect(workers).toHaveLength(0);
  expect(drawn).toEqual(expected);
  // The first graph with a part starts it.
  await computeBackgroundLayout(view, DEFAULT_TYPEFACE);
  expect(workers).toHaveLength(1);
});
