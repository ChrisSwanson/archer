import { afterEach, expect, it, vi } from "vitest";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import { computeLayout } from "../src/layout/elk-adapter";
import type { ProjectedView } from "../src/diagrams/projection";
import {
  resetBackgroundLayout,
  computeBackgroundLayout,
  LayoutWorkerTransport,
  MAX_PENDING_LAYOUTS,
  LAYOUT_TIMEOUT_MS,
} from "../src/layout/elk-worker-transport";
import PageElk, { PAGE_KERNEL_CONCURRENCY } from "../src/layout/elk-page-kernel";
import { DEFAULT_TYPEFACE } from "../src/layout/text-measure";
import { layoutWorkerAddress } from "../src/layout/elk-worker-script";
import { resetApplicationUpdate, subscribeApplicationUpdate } from "../src/app/application-update";

vi.unmock("../src/layout/elk-worker-transport");
const view: ProjectedView = {
  viewId: "worker",
  kind: "freeform",
  title: "Worker",
  revision: "1",
  modelType: "freeform-graph",
  nodes: [
    { id: "a", label: "A", shape: undefined, classes: [], groupId: undefined },
    { id: "b", label: "B", shape: undefined, classes: [], groupId: undefined },
  ],
  edges: [{ id: "hop", source: "a", target: "b", label: "calls" }],
  groups: [],
};
/** The test view with geometry of its own: `n` more nodes. */
const variant = (n: number): ProjectedView => ({
  ...view,
  nodes: [
    ...view.nodes,
    ...Array.from({ length: n }, (_, i) => ({
      id: `x${i}`,
      label: "X",
      shape: undefined,
      classes: [],
      groupId: undefined,
    })),
  ],
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetBackgroundLayout();
});

type Request = { id: number; cmd: string; graph?: ElkNode };
/** Same ELK kernel as production; this fake adapts only message delivery. */
class KernelWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  sent: Request[] = [];
  terminate = vi.fn();
  hold = true;
  postMessage(message: Request) {
    this.sent.push(message);
    if (message.cmd === "register") queueMicrotask(() => this.answer(message.id, { data: true }));
    else if (!this.hold) void this.render(message);
  }
  answer(id: number, reply: unknown) {
    this.onmessage?.({ data: { id, ...(reply as object) } } as MessageEvent);
  }
  async render(message: Request) {
    this.answer(message.id, { data: await new ELK().layout(message.graph!) });
  }
  get layouts() {
    return this.sent.filter((message) => message.cmd === "layout");
  }
}
function held() {
  const worker = new KernelWorker();
  return { worker, transport: new LayoutWorkerTransport(() => worker as unknown as Worker) };
}

it("dispatches browser production layout through ELK's worker API without changing geometry", async () => {
  const expected = await computeLayout(view);
  const workers: KernelWorker[] = [];
  class ImmediateKernel extends KernelWorker {
    constructor() {
      super();
      this.hold = false;
      workers.push(this);
    }
  }
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("Worker", ImmediateKernel);
  const actual = await computeBackgroundLayout(view, DEFAULT_TYPEFACE);
  expect(workers).toHaveLength(1);
  expect(workers[0]!.layouts).toHaveLength(1);
  expect(actual).toEqual(expected);
});

it("reuses one layout for the same model in another revision, so entering edit does not lay out again", async () => {
  const workers: KernelWorker[] = [];
  class ImmediateKernel extends KernelWorker {
    constructor() {
      super();
      this.hold = false;
      workers.push(this);
    }
  }
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("Worker", ImmediateKernel);
  const reading = await computeBackgroundLayout(view, DEFAULT_TYPEFACE);
  const editing = await computeBackgroundLayout(
    { ...view, viewId: "authoring-preview", title: "authoring-preview", revision: "2" },
    DEFAULT_TYPEFACE,
  );
  expect(editing).toBe(reading);
  expect(workers.flatMap((worker) => worker.layouts)).toHaveLength(1);
  await computeBackgroundLayout({ ...view, edges: [] }, DEFAULT_TYPEFACE);
  expect(workers.flatMap((worker) => worker.layouts)).toHaveLength(2);
});

it("does not keep a refused layout", async () => {
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  let fail = true;
  class FlakyKernel extends KernelWorker {
    constructor() {
      super();
      this.hold = false;
    }
    // After ELK's `register` answer, as a worker that loaded and then failed.
    override async render(message: Request) {
      if (fail) queueMicrotask(() => this.onerror?.({} as ErrorEvent));
      else await super.render(message);
    }
  }
  vi.stubGlobal("Worker", FlakyKernel);
  await expect(computeBackgroundLayout(view, DEFAULT_TYPEFACE)).rejects.toThrow("worker failed");
  fail = false;
  await expect(computeBackgroundLayout(view, DEFAULT_TYPEFACE)).resolves.toEqual(await computeLayout(view));
});

it("the page build's ELK stand-in lays out through the worker, a few graphs at a time", async () => {
  const workers: KernelWorker[] = [];
  class HeldKernel extends KernelWorker {
    constructor() {
      super();
      workers.push(this);
    }
  }
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal("Worker", HeldKernel);
  const engine = new PageElk();
  // A note's figures: many more than the transport admits at once.
  const total = MAX_PENDING_LAYOUTS * 3;
  const views = Array.from({ length: total }, (_, n) => variant(n));
  const expected = await Promise.all(views.map((one) => computeLayout(one)));
  const drawings = Promise.all(views.map((one) => computeLayout(one, DEFAULT_TYPEFACE, engine)));
  const answered = new Set<number>();
  while (answered.size < total) {
    let open: Request[] = [];
    await vi.waitFor(() => {
      open = workers[0]!.layouts.filter((request) => !answered.has(request.id));
      expect(open.length).toBeGreaterThan(0);
    });
    expect(open.length).toBeLessThanOrEqual(PAGE_KERNEL_CONCURRENCY);
    for (const request of open) {
      answered.add(request.id);
      await workers[0]!.render(request);
    }
  }
  expect(PAGE_KERNEL_CONCURRENCY).toBeLessThan(MAX_PENDING_LAYOUTS);
  expect(await drawings).toEqual(expected);
});

it("correlates out-of-order results and refuses queue overflow before dispatch", async () => {
  const { worker, transport } = held();
  const views = Array.from({ length: MAX_PENDING_LAYOUTS }, (_, n) => variant(n));
  const expected = await Promise.all(views.map((one) => computeLayout(one)));
  const pending = views.map((one) => transport.layout(one, DEFAULT_TYPEFACE));
  const settled = Promise.all(pending);
  await expect(transport.layout(view, DEFAULT_TYPEFACE)).rejects.toThrow("Too many diagrams");
  await vi.waitFor(() => expect(worker.layouts).toHaveLength(MAX_PENDING_LAYOUTS));
  for (const request of [...worker.layouts].reverse()) await worker.render(request);
  expect(await settled).toEqual(expected);
  transport.close();
  transport.close();
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it("worker failure rejects every outstanding request and clears owned timers", async () => {
  vi.useFakeTimers();
  const { worker, transport } = held();
  await Promise.resolve(); // ELK's `register` answered (ELK reads it on a timer of its own): the worker loaded, then fails.
  vi.runOnlyPendingTimers();
  const all = Promise.allSettled([transport.layout(view, DEFAULT_TYPEFACE), transport.layout(view, DEFAULT_TYPEFACE)]);
  worker.onerror?.({} as ErrorEvent);
  const results = await all;
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  for (const result of results)
    if (result.status === "rejected") expect(result.reason.message).toContain("worker failed");
  expect(transport.closed).toBe(true);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("timeout closes a hung worker and rejects pending work without retrying it", async () => {
  vi.useFakeTimers();
  const { worker, transport } = held();
  const result = expect(transport.layout(view, DEFAULT_TYPEFACE)).rejects.toThrow("time limit");
  await vi.advanceTimersByTimeAsync(LAYOUT_TIMEOUT_MS);
  await result;
  expect(worker.layouts).toHaveLength(1);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("ELK-reported errors leave the transport available for another drawing", async () => {
  const { worker, transport } = held();
  const error = expect(transport.layout(view, DEFAULT_TYPEFACE)).rejects.toThrow("sample failure");
  await vi.waitFor(() => expect(worker.layouts).toHaveLength(1));
  worker.answer(worker.layouts[0]!.id, { error: { message: "sample failure" } });
  await error;
  expect(transport.closed).toBe(false);
  transport.close();
});

it("postMessage failure refuses all work and terminates the worker", async () => {
  const { worker, transport } = held();
  await vi.waitFor(() => expect(worker.sent[0]?.cmd).toBe("register"));
  worker.postMessage = () => {
    throw new Error("clone refused");
  };
  await expect(transport.layout(view, DEFAULT_TYPEFACE)).rejects.toThrow("could not be sent");
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it("a browser without workers refuses instead of laying out on its main thread", async () => {
  vi.stubGlobal("Worker", undefined);
  await expect(computeBackgroundLayout(view, DEFAULT_TYPEFACE)).rejects.toThrow("does not support workers");
});

it("worker construction failure is a rejected operation, so App can show its error", async () => {
  vi.resetModules();
  vi.stubGlobal("window", { addEventListener: vi.fn() });
  vi.stubGlobal(
    "Worker",
    class {
      constructor() {
        throw new Error("worker policy refused");
      }
    },
  );
  const fresh = await import("../src/layout/elk-worker-transport");
  await expect(fresh.computeBackgroundLayout(view, DEFAULT_TYPEFACE)).rejects.toMatchObject({
    message: expect.stringMatching(/could not start\. Reload the page/),
    cause: new Error("worker policy refused"),
  });
});

it("routes both real caption-clearance passes through the supplied engine", async () => {
  const feed: ProjectedView = {
    ...view,
    direction: "tb",
    nodes: [
      { id: "src", label: "Source", shape: "rectangle", classes: [], groupId: undefined },
      { id: "a", label: "First", shape: "rectangle", classes: [], groupId: "g" },
      { id: "b", label: "Second", shape: "rectangle", classes: [], groupId: "g" },
      { id: "c", label: "Third", shape: "rectangle", classes: [], groupId: "g" },
    ],
    edges: [
      { id: "e1", source: "src", target: "a", label: "feeds" },
      { id: "e2", source: "src", target: "b", label: undefined },
      { id: "e3", source: "a", target: "c", label: undefined },
      { id: "e4", source: "src", target: "c", label: undefined },
    ],
    groups: [{ id: "g", label: "A".repeat(30), parentId: undefined }],
  };
  const calls: ElkNode[] = [];
  const engine = new ELK();
  const actual = await computeLayout(feed, DEFAULT_TYPEFACE, {
    layout(graph) {
      calls.push(graph);
      return engine.layout(graph);
    },
  });
  expect(calls).toHaveLength(2);
  expect(actual).toEqual(await computeLayout(feed));
});

it("a worker that fails before it ever answers asks for a reload, for any cause, and shows the page's reload cue", async () => {
  const cues: unknown[] = [];
  const unsubscribe = subscribeApplicationUpdate((cue) => cues.push(cue));
  try {
    const worker = new KernelWorker();
    const transport = new LayoutWorkerTransport(() => worker as unknown as Worker);
    const pending = transport.layout(view, DEFAULT_TYPEFACE);
    worker.onerror?.(new Event("error") as ErrorEvent);
    await expect(pending).rejects.toThrow(
      "Background layout could not start. Reload the page (Archer may have been updated since it loaded).",
    );
    expect(transport.closed).toBe(true);
    expect(cues.at(-1)).toBe("layout");
    // A worker the browser refuses to create (a policy, say) is the same failure.
    expect(
      () =>
        new LayoutWorkerTransport(() => {
          throw new Error("refused");
        }),
    ).toThrow(/could not start\. Reload the page/);
    // A worker made later that runs takes the cue away.
    held();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cues.at(-1)).toBe(false);
  } finally {
    unsubscribe();
    resetApplicationUpdate();
  }
});

it("a worker that fails after answering keeps the try-again message", async () => {
  const { worker, transport } = held();
  // ELK's `register` is answered as soon as the worker runs.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pending = transport.layout(view, DEFAULT_TYPEFACE);
  worker.onerror?.(new Event("error") as ErrorEvent);
  await expect(pending).rejects.toThrow(/Try opening the diagram again/);
});

it("the web page asks for its worker at the service's page-assets root; the dev server's address is kept", () => {
  expect(
    layoutWorkerAddress("https://archer.test/projects/shop/page-assets/elk-layout-worker-AbC123xy.js", false),
  ).toBe("/-/page-assets/elk-layout-worker-AbC123xy.js");
  expect(layoutWorkerAddress("page-assets/elk-layout-worker-AbC123xy.js", false)).toBe(
    "/-/page-assets/elk-layout-worker-AbC123xy.js",
  );
  expect(layoutWorkerAddress("/src/layout/elk-layout-worker.ts?worker_file&type=module", true)).toBe(
    "/src/layout/elk-layout-worker.ts?worker_file&type=module",
  );
});
