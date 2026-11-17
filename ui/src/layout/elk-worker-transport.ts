import ELK, { type ElkNode } from "elkjs/lib/elk-api.js";
import { createLayoutWorker } from "./elk-worker-script";
import type { ProjectedView } from "../diagrams/projection";
import { computeLayout, type LayoutEngine, type LayoutResult } from "./elk-layout";
import { cachedKernel, type Kernel } from "./elk-kernel-cache";
import { provisionalLayout, type LaidOut } from "./provisional-layout";
import { DEFAULT_TYPEFACE, type TypefaceId } from "./text-measure";
import { layoutKey } from "./layout-key";
import { isNestMessage, NestClient, type NestReply } from "../nesting/nest-protocol";
import { FramesClient, isFramesMessage, type FramesReply } from "../expand/frames-protocol";
import { clearLayoutStartFailure, cueLayoutStartFailure } from "../app/application-update";
import { LayoutCancelled } from "./layout-cancel";

/**
 * A worker that fails before its first answer never ran: its file did not load (after `archer upgrade`, a page
 * older than both builds the service keeps), a policy refused it, or it threw at once. Trying again cannot help.
 */
const START_FAILED =
  "Background layout could not start. Reload the page (Archer may have been updated since it loaded).";

export const MAX_PENDING_LAYOUTS = 8;
export const LAYOUT_TIMEOUT_MS = 30_000;
type Pending = { reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/** One bounded ELK transport per page. Errors refuse work; next call can recover. */
export class LayoutWorkerTransport {
  readonly #pending = new Map<number, Pending>();
  readonly #worker: Worker;
  /** ELK in the worker, and the same behind a cache by geometry (`elk-kernel-cache.ts`). */
  readonly #kernel: InstanceType<typeof ELK>;
  readonly #engine: Kernel;
  /** The nested view's channel to the same worker (`nest-protocol.ts`); its replies never reach ELK. */
  readonly #nest: NestClient;
  /** Source frames' channel to the same worker (`expand/frames-protocol.ts`). */
  readonly #frames: FramesClient;
  /** ELK's reply handler, behind the router that takes the nest channel's replies out first. */
  #elkReplies: ((event: MessageEvent) => void) | null = null;
  /** A drawing has asked: a warm-up queued now would only hold it up. */
  #asked = false;
  /** The worker has answered once, so its script loaded. */
  #answered = false;
  #nextId = 1;
  #closed = false;

  constructor(createWorker: () => Worker = createLayoutWorker) {
    try {
      this.#worker = createWorker();
    } catch (error) {
      this.#closed = true;
      throw this.#startFailed(error);
    }
    this.#worker.onerror = () =>
      this.close(
        this.#answered
          ? new Error("Background layout worker failed. Try opening the diagram again.")
          : this.#startFailed(),
      );
    this.#worker.onmessageerror = () => this.close(new Error("Background layout response could not be read."));
    const guarded = new Proxy(this.#worker, {
      get: (target, key) => {
        if (key === "postMessage")
          return (message: unknown) => {
            try {
              target.postMessage(message);
            } catch {
              const error = new Error("Background layout could not be sent to its worker.");
              this.close(error);
              throw error;
            }
          };
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
      set: (target, key, value) => {
        if (key !== "onmessage") return Reflect.set(target, key, value, target);
        this.#elkReplies = value as ((event: MessageEvent) => void) | null;
        return true;
      },
    });
    this.#worker.onmessage = (event: MessageEvent) => {
      if (!this.#answered) clearLayoutStartFailure();
      this.#answered = true;
      if (isNestMessage(event.data)) this.#nest.receive(event.data.nest as NestReply);
      else if (isFramesMessage(event.data)) this.#frames.receive(event.data.frames as FramesReply);
      else this.#elkReplies?.(event);
    };
    this.#nest = new NestClient(
      (message) => {
        this.#asked = true;
        guarded.postMessage(message);
      },
      { onTimeout: (error) => this.close(error) },
    );
    this.#frames = new FramesClient((message) => {
      this.#asked = true;
      guarded.postMessage(message);
    });
    try {
      this.#kernel = new ELK({ workerFactory: () => guarded });
      this.#engine = cachedKernel(this.#kernel);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** The page's reload cue, and the error each waiting drawing shows. */
  #startFailed(cause?: unknown): Error {
    cueLayoutStartFailure();
    return new Error(START_FAILED, cause === undefined ? undefined : { cause });
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The nested view's requests to this worker: each press bounded by its own time limit. */
  get nest(): NestClient {
    return this.#nest;
  }

  /** Source frames' requests to this worker (Expand). */
  get frames(): FramesClient {
    return this.#frames;
  }

  layout(view: ProjectedView, typeface: TypefaceId): Promise<LayoutResult> {
    this.#asked = true;
    return this.#bounded(() => computeLayout(view, typeface, this.#engine));
  }

  /** One ELK graph through the worker kernel, under the same bounds (`elk-page-kernel.ts`). */
  layoutGraph(graph: ElkNode): Promise<ElkNode> {
    this.#asked = true;
    return this.#bounded(() => this.#engine.layout(graph));
  }

  /**
   * One small drawing through the kernel, uncached, its answer dropped. ELK's
   * first layout in a fresh worker pays for compiling its code: 130-200 ms for
   * a ten-node C4 diagram in Chromium, 40-80 ms once warm (perf #1). Started
   * at boot, the warm-up runs while the page still waits on its requests. It
   * is queued only once ELK has loaded (the worker answers in order, so the
   * cheap `algorithms` question returns after `register`) and only if no
   * drawing asked meanwhile: the worker runs one message at a time, and a
   * drawing waiting behind ~100 ms of warm-up gains nothing from it.
   */
  warmUp(): void {
    void this.#kernel
      .knownLayoutAlgorithms()
      .then(() =>
        this.#asked || this.#closed
          ? undefined
          : this.#bounded(() => computeLayout(WARM_UP_VIEW, DEFAULT_TYPEFACE, this.#kernel)),
      )
      .catch(() => undefined);
  }

  #bounded<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Background layout worker is closed."));
    if (this.#pending.size >= MAX_PENDING_LAYOUTS)
      return Promise.reject(
        new Error("Too many diagrams are waiting for background layout. Try opening the diagram again."),
      );
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.close(new Error("Background layout exceeded its time limit. Try opening the diagram again.")),
        LAYOUT_TIMEOUT_MS,
      );
      this.#pending.set(id, { reject, timer });
      const finish = () => {
        clearTimeout(timer);
        return this.#pending.delete(id);
      };
      void work().then(
        (result) => {
          if (finish()) resolve(result);
        },
        (error: unknown) => {
          if (finish())
            reject(
              error instanceof Error
                ? error
                : new Error(
                    `Background layout failed: ${typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message.slice(0, 1000) : "ELK refused the drawing"}`,
                  ),
            );
        },
      );
    });
  }

  close(reason = new Error("Background layout worker was stopped.")): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
    this.#nest.close(reason);
    this.#frames.close(reason);
    this.#worker.terminate();
    this.#worker.onmessage = this.#worker.onerror = this.#worker.onmessageerror = null;
  }
}

/**
 * What the warm-up lays out: every code path an ordinary drawing takes -- a
 * group (padding, minimum width), a captioned wire, a wire into the group and
 * one out of it, three shapes.
 */
const WARM_UP_VIEW: ProjectedView = {
  viewId: "warm-up",
  kind: "flowchart",
  title: "warm-up",
  revision: "0",
  modelType: "freeform-graph",
  nodes: [
    { id: "a", label: "Start", shape: "rounded", classes: [], groupId: "g" },
    { id: "b", label: "Check the order", shape: "diamond", classes: [], groupId: "g" },
    { id: "c", label: "Store", shape: "cylinder", classes: [], groupId: "g" },
    { id: "d", label: "Client", shape: "rectangle", classes: [], groupId: undefined },
    { id: "e", label: "Done", shape: "rectangle", classes: [], groupId: undefined },
  ],
  edges: [
    { id: "ab", source: "a", target: "b", label: "submits" },
    { id: "bc", source: "b", target: "c", label: undefined },
    { id: "da", source: "d", target: "a", label: "opens" },
    { id: "ce", source: "c", target: "e", label: undefined },
  ],
  groups: [{ id: "g", label: "Service", parentId: undefined }],
};

let transport: LayoutWorkerTransport | undefined;
let observingPage = false;
/**
 * Between `pagehide` and a `pageshow` the page is going: no worker is started for it. Closing the
 * transport refuses what was waiting, and a caller that asks again on a refusal (the nested view's
 * fallback, `nest-layout.ts`) would otherwise fetch a fresh worker that the unload then aborts (O23).
 */
let leaving = false;
/** The page's one transport, made on first use and dropped when the page is hidden. */
export function backgroundTransport(): LayoutWorkerTransport {
  if (typeof Worker === "undefined")
    throw new Error("Background layout is unavailable: this browser does not support workers.");
  if (leaving) throw new LayoutCancelled();
  if (!observingPage) {
    // Registered before any caller's `whenPageShown`, so a restored page's redraw finds the gate open.
    window.addEventListener("pagehide", () => {
      leaving = true;
      transport?.close(new LayoutCancelled());
      transport = undefined;
    });
    window.addEventListener("pageshow", () => {
      leaving = false;
    });
    observingPage = true;
  }
  if (transport === undefined || transport.closed) transport = new LayoutWorkerTransport();
  return transport;
}

/**
 * Start the page's layout worker now and warm its kernel, so the first drawing
 * does not wait ~300 ms for ELK to load and ~100 ms for it to compile (perf #1:
 * the worker used to start only after the page's second round of requests).
 * Does nothing where workers are unavailable: the first drawing reports that.
 */
export function startBackgroundLayout(): void {
  if (transport !== undefined && !transport.closed) return;
  try {
    backgroundTransport().warmUp();
  } catch {
    /* the first layout request reports the reason */
  }
}

/**
 * Whether the page starts its layout worker at boot: only in an MCP host, whose worker is inline in its one file
 * (nothing to fetch) and which always presents a diagram. The web page starts it on its first graph layout
 * (`computeBackgroundLayout` → `backgroundTransport`): a sequence diagram, its editor, a journey, the empty draft
 * and a page of text never fetch ELK (PF-5: ≈ 350 KB transfer, 1.5 MB decoded). A graph pays the worker's start
 * once, on its first drawing; the same worker then serves every drawing until the page goes.
 */
export function startsLayoutAtBoot(mode: "web" | "mcp"): boolean {
  return mode === "mcp";
}

/** An empty graph (the new draft's starter) laid out as ELK lays it out, with no worker: the root at 0,0 and no size. */
const EMPTY_ENGINE: LayoutEngine = {
  layout: (graph) => Promise.resolve({ ...graph, x: 0, y: 0, width: 0, height: 0 }),
};
const isEmpty = (view: ProjectedView): boolean =>
  view.nodes.length === 0 && view.edges.length === 0 && view.groups.length === 0;

/** Layouts kept for the page, newest last: reading ↔ editing and an unchanged reload reuse one. */
const LAYOUT_CACHE_ENTRIES = 16;
const layouts = new Map<string, Promise<LayoutResult>>();

export { layoutKey };

export type LayoutRequest = {
  /**
   * Called at once, before ELK answers, with a drawing of `view` made from the
   * last one handed out (`provisional-layout.ts`) -- when ELK has work to do
   * and the change is one that drawing can show. The promise still resolves
   * with ELK's layout.
   */
  readonly provisional?: (layout: LayoutResult) => void;
};

/** The drawing most recently handed out (ELK's or provisional), what the next provisional one starts from. */
let shown: (LaidOut & { readonly typeface: TypefaceId }) | undefined;
let requests = 0;

/** The page's transport if it has one running; never starts one. */
export function currentTransport(): LayoutWorkerTransport | undefined {
  return transport === undefined || transport.closed ? undefined : transport;
}

/** The view laid out through the page's worker, once per model and face while it stays cached. */
export async function computeBackgroundLayout(
  view: ProjectedView,
  typeface: TypefaceId,
  request: LayoutRequest = {},
): Promise<LayoutResult> {
  const serial = ++requests;
  const remember = (answer: Promise<LayoutResult>): Promise<LayoutResult> => {
    // Only the newest request's answer: an older one arriving late is not what is on screen.
    void answer.then(
      (layout) => {
        if (serial === requests) shown = { view, typeface, layout };
      },
      () => undefined,
    );
    return answer;
  };
  const key = layoutKey(view, typeface);
  const known = layouts.get(key);
  if (known !== undefined) {
    layouts.delete(key);
    layouts.set(key, known);
    return remember(known);
  }
  const answer = isEmpty(view)
    ? computeLayout(view, typeface, EMPTY_ENGINE)
    : backgroundTransport().layout(view, typeface);
  layouts.set(key, answer);
  if (layouts.size > LAYOUT_CACHE_ENTRIES) layouts.delete(layouts.keys().next().value!);
  // A refusal is not kept: the next request tries again.
  answer.catch(() => {
    if (layouts.get(key) === answer) layouts.delete(key);
  });
  if (request.provisional !== undefined && shown !== undefined && shown.typeface === typeface) {
    const drawn = provisionalLayout(shown, view, typeface);
    if (drawn !== null) {
      shown = { view, typeface, layout: drawn };
      request.provisional(drawn);
    }
  }
  return remember(answer);
}

/** Tests only: forget every cached layout and stop the page's worker. */
export function resetBackgroundLayout(): void {
  layouts.clear();
  shown = undefined;
  transport?.close();
  transport = undefined;
  observingPage = false;
  leaving = false;
}
