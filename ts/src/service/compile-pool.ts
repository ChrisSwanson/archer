// The service compiles in worker threads (server review S1). Mermaid's parse is synchronous:
// in the service's own thread one pathological source held every request, hello included, for
// 40 s. Here a compile holds only its worker, and one that runs past its budget has its worker
// stopped and answers `compile_timeout`; the next compile starts a fresh worker.
//
// Installed through `setCompileBackend`, so every caller of `compile` in the service process goes
// through it. A worker that cannot start (a packaged build missing its file) is not an answer
// about a source: that compile and every later one run in this thread instead, as before.

import { Worker } from "node:worker_threads";
import { workerLocation, workerModule } from "../workers/module.ts";
import { sharedPool } from "../workers/shared-pool.ts";
import { compileInThisThread, setCompileBackend, type CompileOptions, type CompileResult } from "../mermaid/compile.ts";
import { error, span } from "../mermaid/diagnostics.ts";
import { activeTelemetry } from "../telemetry/index.ts";

/** How long one compile may run in its worker. Real diagrams take tens of milliseconds. */
export const COMPILE_BUDGET_MS = 10_000;
/** Compiles at once: one stuck source leaves the other worker taking work. */
export const COMPILE_WORKERS = 2;

export interface CompilePoolOptions {
  readonly workers?: number;
  readonly budgetMs?: number;
  /** The worker module; found beside this module (source or bundle) by default. null: compile in this thread. */
  readonly worker?: URL | null;
}

interface Job {
  readonly id: number;
  readonly source: string;
  readonly options: CompileOptions;
  readonly resolve: (result: CompileResult) => void;
  readonly reject: (failure: Error) => void;
}

interface Slot {
  readonly worker: Worker;
  ready: boolean;
  job: Job | null;
  timer?: NodeJS.Timeout;
}

/** The refusal of a compile stopped at its budget. */
export function compileTimeout(budgetMs: number): CompileResult {
  return {
    model: null,
    diagnostics: [
      error(
        "compile_timeout",
        `Archer stopped compiling this diagram after ${budgetMs / 1000} s. ` +
          "Split it into smaller views, or shorten its longest statements; a diagram people can read compiles in well under a second.",
        span(1, 1),
      ),
    ],
  };
}

/** The worker beside this module: dist/compile-worker.js from the bundle (this code may sit in dist/chunks/), or the source file. */
export function compileWorkerLocation(): URL | null {
  return workerLocation(import.meta.url, "compile-worker");
}

export class CompilePool {
  readonly #size: number;
  readonly #budgetMs: number;
  readonly #slots = new Set<Slot>();
  readonly #queue: Job[] = [];
  #worker: URL | null;
  #nextId = 0;
  #closed = false;

  constructor(options: CompilePoolOptions = {}) {
    this.#size = Math.max(1, options.workers ?? COMPILE_WORKERS);
    this.#budgetMs = options.budgetMs ?? COMPILE_BUDGET_MS;
    this.#worker = options.worker === undefined ? compileWorkerLocation() : options.worker;
  }

  /** Whether compiles go to worker threads (false once a worker could not start). */
  get threaded(): boolean {
    return this.#worker !== null;
  }

  readonly compile = (source: string, options: CompileOptions = {}): Promise<CompileResult> => {
    if (this.#closed) return Promise.reject(new Error("The compiler stopped: the service is stopping."));
    if (this.#worker === null) return compileInThisThread(source, options);
    return new Promise<CompileResult>((resolve, reject) => {
      this.#queue.push({ id: ++this.#nextId, source, options, resolve, reject });
      this.#pump();
    });
  };

  /** Starts the workers now, so the first compiles do not wait for Mermaid to load. */
  warm(): void {
    while (!this.#closed && this.#worker !== null && this.#slots.size < this.#size) this.#spawn(this.#worker);
  }

  /** Stops every worker and fails what is queued or running, and every later compile: a stopping service compiles nothing more. */
  close(): void {
    this.#closed = true;
    const stopped = new Error("The compiler stopped: the service is stopping.");
    for (const job of this.#queue.splice(0)) job.reject(stopped);
    for (const slot of [...this.#slots]) {
      const job = slot.job;
      this.#drop(slot);
      job?.reject(stopped);
    }
  }

  #pump(): void {
    while (!this.#closed && this.#queue.length > 0) {
      if (this.#worker === null) {
        for (const job of this.#queue.splice(0))
          compileInThisThread(job.source, job.options).then(job.resolve, job.reject);
        return;
      }
      const slot = [...this.#slots].find((candidate) => candidate.ready && candidate.job === null);
      if (slot === undefined) {
        if (this.#slots.size >= this.#size || [...this.#slots].some((candidate) => !candidate.ready)) return;
        this.#spawn(this.#worker);
        continue; // it takes work once ready
      }
      this.#assign(slot, this.#queue.shift()!);
    }
  }

  #spawn(url: URL): void {
    let worker: Worker;
    try {
      worker = new Worker(workerModule(url), { name: "archer-compile" });
    } catch (failure) {
      return this.#unavailable(failure);
    }
    const slot: Slot = { worker, ready: false, job: null };
    this.#slots.add(slot);
    worker.on("message", (message: { ready?: true; id?: number; result?: CompileResult; error?: string }) => {
      if (message.ready === true) {
        slot.ready = true;
        return this.#pump();
      }
      const job = slot.job;
      if (job === null || message.id !== job.id) return;
      clearTimeout(slot.timer);
      slot.job = null;
      if (message.result !== undefined) job.resolve(message.result);
      else job.reject(new Error(message.error ?? "The diagram could not be compiled."));
      this.#pump();
    });
    worker.on("error", (failure) => {
      if (!slot.ready) return this.#startFailed(slot, failure);
      this.#fail(slot, new Error(`The compiler failed: ${failure.message}`));
    });
    worker.on("exit", (code) => {
      if (!this.#slots.has(slot)) return;
      if (!slot.ready) return this.#startFailed(slot, new Error(`exited with code ${code}`));
      this.#fail(slot, new Error(`The compiler stopped (exit code ${code}).`));
    });
    // After the listeners: attaching a "message" listener refs the worker again.
    worker.unref();
  }

  #assign(slot: Slot, job: Job): void {
    slot.job = job;
    slot.timer = setTimeout(() => {
      this.#drop(slot);
      activeTelemetry()?.log("warn", "svc.compile-timeout", "a compile ran past its budget; its worker was stopped", {
        data: { budgetMs: this.#budgetMs, bytes: job.source.length },
      });
      job.resolve(compileTimeout(this.#budgetMs));
      this.#pump();
    }, this.#budgetMs);
    slot.timer.unref();
    slot.worker.postMessage({ id: job.id, source: job.source, options: job.options });
  }

  /** Removes a worker without answering its job. */
  #drop(slot: Slot): void {
    if (!this.#slots.delete(slot)) return;
    clearTimeout(slot.timer);
    slot.job = null;
    void slot.worker.terminate();
  }

  /** Removes a worker that failed mid-compile, failing its compile, and lets the queue start a fresh one. */
  #fail(slot: Slot, failure: Error): void {
    const job = slot.job;
    this.#drop(slot);
    job?.reject(failure);
    this.#pump();
  }

  #startFailed(slot: Slot, failure: unknown): void {
    this.#drop(slot);
    this.#unavailable(failure);
  }

  #unavailable(failure: unknown): void {
    activeTelemetry()?.log("warn", "svc.compile-worker", "compile worker could not start; compiling in process", {
      data: { error: failure instanceof Error ? failure.message : String(failure) },
    });
    this.#worker = null;
    this.#pump();
  }
}

const acquireCompilePool = sharedPool(
  (options: CompilePoolOptions) => {
    const pool = new CompilePool(options);
    setCompileBackend(pool.compile);
    pool.warm();
    return pool;
  },
  (pool) => {
    setCompileBackend(null);
    pool.close();
  },
);

export interface CompilePoolUse {
  /** Fails every compile, running or later, until released: what a stopping service still has under way ends now. */
  stop(): void;
  /** Gives the pool back; the last user's release closes it and compiles return to this thread. Idempotent. */
  release(): void;
}

/**
 * Routes this process's compiles through a shared pool until every user has released it. Services
 * started together in one process (tests) share one pool.
 */
export function useCompilePool(options: CompilePoolOptions = {}): CompilePoolUse {
  const { stop, release } = acquireCompilePool(options);
  return { stop, release };
}
