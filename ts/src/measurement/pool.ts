import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { workerLocation, workerModule } from "../workers/module.ts";
import { sharedPool } from "../workers/shared-pool.ts";
import { LAYOUT_ENGINE_VERSION, type AnalysisState, type DiagramGeometry } from "../../../shared/layout-analysis.mts";

export const LAYOUT_LIMITS = {
  authoringMs: 150,
  workerMs: 3_000,
  explicitMs: 5_000,
  queue: 32,
  cacheEntries: 128,
  cacheBytes: 16 * 1024 * 1024,
} as const;
export { LAYOUT_ENGINE_VERSION };
export class LayoutInputError extends Error {
  readonly code = "invalid_arguments";
}
export interface LayoutPoolOptions {
  readonly workerMs?: number;
  readonly deadlineMs?: number;
  readonly queue?: number;
  readonly cacheEntries?: number;
  readonly cacheBytes?: number;
  /** A real worker module, for embedders and failure/cancellation verification. */
  readonly worker?: URL;
}
export interface CompilationInput {
  readonly source: string;
  readonly view: import("../application/diagrams.ts").ViewEntry;
  readonly embedded?: import("../notes/embedded.ts").EmbeddedRead;
}
export interface CompiledInput {
  readonly envelope: import("../model/envelope.ts").DiagramEnvelope | null;
  readonly diagnostics: readonly import("../application/diagrams.ts").WireDiagnostic[];
}
export interface GeometryRequest {
  readonly compilation?: CompilationInput;
  readonly envelope: unknown;
  readonly states?: readonly AnalysisState[];
  readonly typeface?: "fira";
  /** Automatic authoring jobs for this exact project/view supersede older queued jobs. */
  readonly automatic?: string;
  /** Cancellation belongs to this deduplicated job, including every caller sharing it. */
  readonly signal?: AbortSignal;
  /** Observes completed production states, before the next state settles. */
  readonly onState?: (stateCount: number) => void;
  /** A caller may shorten the fixed explicit deadline, for a remaining operation budget. */
  readonly deadlineMs?: number;
}
export interface GeometryOutcome {
  readonly compiled?: CompiledInput;
  readonly status: "ready" | "partial" | "unavailable";
  readonly geometry?: DiagramGeometry;
  readonly reason?: string;
  readonly complete: boolean;
  readonly unmeasuredStates?: readonly { stateIndex: number; reason: string }[];
}
interface Job {
  readonly id: number;
  readonly key: string;
  readonly request: GeometryRequest;
  readonly promise: Promise<GeometryOutcome>;
  readonly resolve: (result: GeometryOutcome) => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  deadlineAt: number;
  abort?: () => void;
  requested?: readonly AnalysisState[];
  geometry?: DiagramGeometry;
  compiled?: CompiledInput;
}
interface Slot {
  readonly worker: Worker;
  job: Job | null;
  timer?: NodeJS.Timeout;
  /** The worker has loaded its modules. Until then its job waits on the caller's deadline alone. */
  ready: boolean;
}

export function layoutWorkerLocation(): URL {
  return (
    workerLocation(import.meta.url, "layout-worker", "worker.ts") ?? new URL("./layout-worker.js", import.meta.url)
  );
}
/** Canonical recipe spelling makes request order irrelevant without changing the fresh route. */
function keyOf(request: GeometryRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        engine: LAYOUT_ENGINE_VERSION,
        envelope: request.envelope,
        compilation: request.compilation,
        typeface: request.typeface ?? "fira",
        states:
          request.states?.map((s) => (s.mode === "full" ? s : { mode: s.mode, open: [...new Set(s.open)].sort() })) ??
          null,
        presentation: { mode: "source", revision: null },
      }),
    )
    .digest("hex");
}

/** One CPU worker, a finite waiting room and an LRU bounded by both count and bytes. No in-process fallback. */
export class LayoutPool {
  readonly #options: Required<Omit<LayoutPoolOptions, "worker">> & { worker: URL };
  readonly #queue: Job[] = [];
  readonly #jobs = new Map<string, Job>();
  readonly #cache = new Map<string, { geometry: DiagramGeometry; compiled?: CompiledInput; bytes: number }>();
  #bytes = 0;
  #slot: Slot | null = null;
  #stopping = false;
  #closed = false;
  #next = 0;
  #started = 0;
  #terminated = 0;
  constructor(options: LayoutPoolOptions = {}) {
    this.#options = {
      workerMs: options.workerMs ?? LAYOUT_LIMITS.workerMs,
      deadlineMs: options.deadlineMs ?? LAYOUT_LIMITS.explicitMs,
      queue: options.queue ?? LAYOUT_LIMITS.queue,
      cacheEntries: options.cacheEntries ?? LAYOUT_LIMITS.cacheEntries,
      cacheBytes: options.cacheBytes ?? LAYOUT_LIMITS.cacheBytes,
      worker: options.worker ?? layoutWorkerLocation(),
    };
  }
  get stats() {
    return {
      active: this.#slot?.job ? 1 : 0,
      queued: this.#queue.length,
      cached: this.#cache.size,
      cacheBytes: this.#bytes,
      started: this.#started,
      terminated: this.#terminated,
      stopping: this.#stopping,
    };
  }
  request(request: GeometryRequest): Promise<GeometryOutcome> {
    if (this.#closed) return Promise.resolve({ status: "unavailable", reason: "stopped", complete: false });
    if (request.signal?.aborted)
      return Promise.resolve({ status: "unavailable", reason: "cancelled", complete: false });
    const key = keyOf(request);
    const cached = this.#cache.get(key);
    if (cached) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return Promise.resolve({
        status: "ready",
        ...structuredClone({
          geometry: cached.geometry,
          ...(cached.compiled === undefined ? {} : { compiled: cached.compiled }),
        }),
        complete: true,
      });
    }
    const same = this.#jobs.get(key);
    if (same !== undefined) {
      const deadlineAt =
        Date.now() + Math.min(request.deadlineMs ?? this.#options.deadlineMs, this.#options.deadlineMs);
      if (deadlineAt < same.deadlineAt) {
        clearTimeout(same.timer);
        same.deadlineAt = deadlineAt;
        same.timer = setTimeout(() => this.#finish(same, "budget_exceeded"), Math.max(0, deadlineAt - Date.now()));
      }
      return same.promise;
    }
    if (request.automatic !== undefined) {
      for (const job of [...this.#queue])
        if (job.request.automatic === request.automatic) this.#finish(job, "superseded");
    }
    if (this.#queue.length >= this.#options.queue && (this.#slot?.job != null || this.#stopping)) {
      // Explicit work can evict an automatic waiting job, but never another explicit caller.
      const auto =
        request.automatic === undefined ? this.#queue.find((job) => job.request.automatic !== undefined) : undefined;
      if (auto) this.#finish(auto, "queue_full");
      else return Promise.resolve({ status: "unavailable", reason: "queue_full", complete: false });
    }
    let resolve!: Job["resolve"], reject!: Job["reject"];
    const promise = new Promise<GeometryOutcome>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const job: Job = {
      id: ++this.#next,
      key,
      request,
      promise,
      resolve,
      reject,
      deadlineAt: Date.now() + Math.min(request.deadlineMs ?? this.#options.deadlineMs, this.#options.deadlineMs),
      timer: setTimeout(
        () => this.#finish(job, "budget_exceeded"),
        Math.min(request.deadlineMs ?? this.#options.deadlineMs, this.#options.deadlineMs),
      ),
    };
    if (request.signal) {
      job.abort = () => this.#finish(job, "cancelled");
      request.signal.addEventListener("abort", job.abort, { once: true });
    }
    this.#jobs.set(key, job);
    if (request.automatic === undefined) {
      const firstAutomatic = this.#queue.findIndex((j) => j.request.automatic !== undefined);
      this.#queue.splice(firstAutomatic < 0 ? this.#queue.length : firstAutomatic, 0, job);
    } else this.#queue.push(job);
    this.#pump();
    return promise;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const job of [...this.#jobs.values()]) this.#finish(job, "stopped");
    if (this.#slot) void this.#stop(this.#slot);
    this.#cache.clear();
    this.#bytes = 0;
  }
  #pump(): void {
    if (this.#closed || this.#stopping || this.#slot?.job != null) return;
    const job = this.#queue.shift();
    if (!job) {
      this.#slot?.worker.unref();
      return;
    }
    let slot = this.#slot;
    if (slot === null) {
      let worker: Worker;
      try {
        worker = new Worker(workerModule(this.#options.worker), {
          name: "archer-layout",
          resourceLimits: { maxOldGenerationSizeMb: 256 },
        });
      } catch {
        this.#finish(job, "worker_failed");
        return;
      }
      this.#started++;
      slot = { worker, job: null, ready: false };
      this.#slot = slot;
      const owned = slot;
      worker.on(
        "message",
        (message: {
          id?: number;
          ready?: boolean;
          requested?: readonly AnalysisState[];
          compiled?: CompiledInput;
          unavailable?: string;
          geometry?: DiagramGeometry;
          done?: boolean;
          code?: string;
          error?: string;
        }) => {
          if (message.ready) {
            owned.ready = true;
            if (this.#slot === owned && owned.job !== null) this.#startBudget(owned, owned.job);
            return;
          }
          const active = owned.job;
          if (this.#slot !== owned || active === null || message.id !== active.id) return;
          if (message.requested) active.requested = message.requested;
          if (message.compiled) active.compiled = message.compiled;
          if (message.unavailable) {
            this.#finish(active, message.unavailable);
            return;
          }
          if (message.geometry)
            active.geometry = {
              ...message.geometry,
              states: [...(active.geometry?.states ?? []), ...message.geometry.states],
            };
          if (message.geometry && active.request.onState) {
            try {
              active.request.onState(active.geometry!.states.length);
            } catch {
              this.#finish(active, "cancelled");
            }
            if (this.#slot !== owned || owned.job !== active) return;
          }
          if (message.done) {
            if (active.geometry) this.#remember(active.key, active.geometry, active.compiled);
            this.#finish(active);
          } else if (message.error) {
            if (message.code === "invalid_arguments") {
              this.#remove(active);
              active.reject(new LayoutInputError(message.error));
              void this.#stop(owned);
            } else this.#finish(active, "worker_failed");
          }
        },
      );
      worker.on("error", () => {
        if (this.#slot !== owned) return;
        if (owned.job) this.#finish(owned.job, "worker_failed");
        else void this.#stop(owned);
      });
      worker.on("exit", () => {
        if (this.#slot !== owned) return;
        if (owned.job) this.#finish(owned.job, "worker_failed");
        else void this.#stop(owned);
      });
    }
    slot.job = job;
    slot.worker.ref();
    // The layout budget bounds the layout, not a cold worker loading its modules: on a busy machine that
    // load alone can outlast it. The caller's deadline (job.timer) still bounds the whole wait.
    if (slot.ready) this.#startBudget(slot, job);
    slot.worker.postMessage({
      id: job.id,
      envelope: job.request.envelope,
      ...(job.request.compilation === undefined ? {} : { compilation: job.request.compilation }),
      ...(job.request.states === undefined ? {} : { states: job.request.states }),
      typeface: job.request.typeface ?? "fira",
    });
  }
  #startBudget(slot: Slot, job: Job): void {
    clearTimeout(slot.timer);
    slot.timer = setTimeout(() => this.#finish(job, "budget_exceeded"), this.#options.workerMs);
  }
  #remove(job: Job): void {
    this.#jobs.delete(job.key);
    clearTimeout(job.timer);
    if (job.abort) job.request.signal?.removeEventListener("abort", job.abort);
    const i = this.#queue.indexOf(job);
    if (i >= 0) this.#queue.splice(i, 1);
  }
  #finish(job: Job, reason?: string): void {
    if (!this.#jobs.has(job.key)) return;
    this.#remove(job);
    const states = job.geometry?.states ?? [];
    const remaining = (job.requested ?? job.request.states ?? [{ mode: "full" as const }]).flatMap((_, stateIndex) =>
      states.some((s) => s.stateIndex === stateIndex) ? [] : [{ stateIndex, reason: reason ?? "worker_failed" }],
    );
    const data = {
      ...(job.geometry === undefined ? {} : { geometry: job.geometry }),
      ...(job.compiled === undefined ? {} : { compiled: job.compiled }),
    };
    job.resolve({
      status: reason === undefined && job.geometry ? "ready" : states.length > 0 ? "partial" : "unavailable",
      complete: reason === undefined && job.geometry !== undefined,
      // The cache owns the worker's copy; isolate the answer that leaves the pool.
      ...(this.#cache.has(job.key) ? structuredClone(data) : data),
      ...(reason === undefined ? {} : { reason, unmeasuredStates: remaining }),
    });
    if (this.#slot?.job === job) {
      if (reason !== undefined) void this.#stop(this.#slot);
      else {
        clearTimeout(this.#slot.timer);
        this.#slot.job = null;
        this.#pump();
      }
    } else this.#pump();
  }
  async #stop(slot: Slot): Promise<void> {
    if (this.#slot !== slot) return;
    clearTimeout(slot.timer);
    this.#slot = null;
    this.#stopping = true;
    try {
      await slot.worker.terminate();
    } finally {
      this.#terminated++;
      this.#stopping = false;
      this.#pump();
    }
  }
  #remember(key: string, geometry: DiagramGeometry, compiled?: CompiledInput): void {
    const bytes = Buffer.byteLength(JSON.stringify({ geometry, compiled }));
    if (bytes > this.#options.cacheBytes) return;
    this.#cache.set(key, {
      geometry,
      ...(compiled === undefined ? {} : { compiled }),
      bytes,
    });
    this.#bytes += bytes;
    while (this.#cache.size > this.#options.cacheEntries || this.#bytes > this.#options.cacheBytes) {
      const oldest = this.#cache.keys().next().value!;
      this.#bytes -= this.#cache.get(oldest)!.bytes;
      this.#cache.delete(oldest);
    }
  }
}
const acquireLayoutPool = sharedPool(() => new LayoutPool());
export function useLayoutPool(): { pool: LayoutPool; release: () => void } {
  const { pool, release } = acquireLayoutPool(undefined);
  return { pool, release };
}
