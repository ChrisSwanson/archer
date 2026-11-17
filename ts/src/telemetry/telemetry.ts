// The development telemetry of one service (ARCHER_DEBUG=1): a structured log
// ring, a metrics registry and the "should not happen" detectors of
// docs/devkit/CONTRACT.md. Built only when debug is on; nothing here runs otherwise.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Counts, Keyed, KeyedWindows, Ring, SlidingWindow, Stat } from "./primitives.ts";
import { redact, redactText } from "./redact.ts";

export type Level = "debug" | "info" | "warn" | "error";
export const LEVEL_ORDER: Readonly<Record<Level, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
export const isLevel = (value: unknown): value is Level =>
  typeof value === "string" && Object.hasOwn(LEVEL_ORDER, value);

export interface LogEntry {
  readonly seq: number;
  readonly at: string;
  readonly level: Level;
  readonly code: string;
  readonly msg: string;
  readonly source?: "client";
  readonly requestId?: string;
  readonly route?: string;
  readonly ms?: number;
  readonly action?: string;
  readonly data?: unknown;
}
export interface LogFields {
  readonly requestId?: string;
  readonly route?: string;
  readonly ms?: number;
  readonly action?: string;
  readonly data?: unknown;
}

/** Thresholds, as the contract states them. */
export const THRESHOLDS = {
  slowRequestMs: 1_000,
  slowCompileMs: 500,
  eventLoopLagMs: 100,
  duplicate: { count: 3, windowMs: 2_000 },
  burst: { count: 60, windowMs: 5_000 },
  watchStorm: { count: 50, windowMs: 1_000 },
  cacheMissStorm: { count: 20, windowMs: 10_000 },
  memoryGrowth: { ratio: 1.5, windowMs: 10 * 60_000 },
  streamLeak: 50,
  warningsWindowMs: 5 * 60_000,
} as const;

export const LIMITS = {
  serviceLog: 4_000,
  clientLog: 2_000,
  warningTimes: 4_096,
  routes: 128,
  reloadRoots: 64,
  sampleMs: 5_000,
} as const;

export type RejectionPolicy = "throw" | "strict" | "warn" | "none" | "warn-with-error-code";
const POLICIES: ReadonlySet<string> = new Set<RejectionPolicy>([
  "throw",
  "strict",
  "warn",
  "none",
  "warn-with-error-code",
]);

/** The process's `--unhandled-rejections` mode: the command line wins over NODE_OPTIONS; `throw` by default. */
export function rejectionPolicy(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string | undefined = process.env["NODE_OPTIONS"],
): RejectionPolicy {
  const find = (args: readonly string[]): string | undefined => {
    let found: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg.startsWith("--unhandled-rejections=")) found = arg.slice("--unhandled-rejections=".length);
      else if (arg === "--unhandled-rejections") found = args[++i];
    }
    return found;
  };
  const value = find(execArgv) ?? find((nodeOptions ?? "").split(/\s+/).filter(Boolean));
  return value !== undefined && POLICIES.has(value) ? (value as RejectionPolicy) : "throw";
}

export interface TelemetryOptions {
  readonly now?: () => number;
  /** Memory / event-loop sampling period; 5 s by default. */
  readonly sampleMs?: number;
  /** Where warn and error lines are mirrored (the service log), so they survive a crash. */
  readonly sink?: (line: string) => void;
  readonly serviceLogCapacity?: number;
  readonly clientLogCapacity?: number;
}

export interface RequestRecord {
  readonly requestId: string;
  readonly method: string;
  readonly route: string;
  /**
   * A digest of the request target (path and query), never the target itself: it tells repeats of one
   * address apart for svc.duplicate-request. No log line spells a request's path or query (C-34, X-04).
   */
  readonly target: string;
  readonly status: number;
  readonly ms: number;
  readonly bytes: number;
  readonly client: string;
  readonly streaming: boolean;
  readonly action?: string;
  readonly phases: Readonly<Record<string, number>>;
  /** A write's body as a short digest: repeats of one URL with different bodies are different requests. */
  readonly bodyHash?: string;
  /** The page load that asked (a debug page's `x-archer-page-load`): each page of the app reads what it needs once. */
  readonly page?: string;
}

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;
/** Megabytes to one decimal. */
const mb = (bytes: number): number => Math.round((bytes * 10) / (1024 * 1024)) / 10;

interface RouteMetrics {
  readonly latency: Stat;
  readonly statuses: Counts;
  bytes: number;
  errors: number;
  streams: number;
}
interface Outcomes {
  readonly latency: Stat;
  readonly outcomes: Counts;
}
interface Sample {
  readonly at: number;
  readonly heapUsedMb: number;
  readonly rssMb: number;
  readonly loopMaxMs: number;
  readonly loopP99Ms: number;
}

class Registry {
  readonly routes = new Keyed<RouteMetrics>(
    () => ({ latency: new Stat(), statuses: new Counts(16), bytes: 0, errors: 0, streams: 0 }),
    LIMITS.routes,
  );
  readonly compile = new Keyed<Outcomes>(() => ({ latency: new Stat(), outcomes: new Counts(4) }), 16);
  readonly compileCache = new Counts(2);
  readonly thumbnailCache = new Counts(2);
  readonly thumbnailRender = new Stat();
  readonly thumbnailRefusals = new Counts(8);
  readonly watcherEvents = new Counts(64);
  readonly reloads = new Keyed<Outcomes>(() => ({ latency: new Stat(), outcomes: new Counts(4) }), 64);
  readonly streams = new Counts(4);
  readonly edits = new Keyed<Outcomes>(() => ({ latency: new Stat(), outcomes: new Counts(64) }), 128);
  readonly authoring = new Keyed<Outcomes>(() => ({ latency: new Stat(), outcomes: new Counts(64) }), 16);
  readonly management = new Keyed<Outcomes>(() => ({ latency: new Stat(), outcomes: new Counts(32) }), 64);
  readonly warnings = new Counts(64);
  readonly client = new Counts(128);
}

const outcomes = (keyed: Keyed<Outcomes>): Record<string, unknown> =>
  Object.fromEntries(
    [...keyed.entries()].map(([key, value]) => [
      key,
      { latency: value.latency.snapshot(), outcomes: value.outcomes.toJSON() },
    ]),
  );

export class Telemetry {
  readonly startedAt: number;
  readonly #now: () => number;
  readonly #sink: ((line: string) => void) | undefined;
  readonly #serviceLog: Ring<LogEntry>;
  readonly #clientLog: Ring<LogEntry>;
  #seq = 0;
  #resetAt: number;
  #registry = new Registry();
  #warningTimes = new Ring<number>(LIMITS.warningTimes);
  readonly #samples: Ring<Sample>;
  readonly #sampleMs: number;
  #duplicates = new KeyedWindows(THRESHOLDS.duplicate.count - 1, THRESHOLDS.duplicate.windowMs);
  #bursts = new KeyedWindows(THRESHOLDS.burst.count, THRESHOLDS.burst.windowMs, 512);
  #watchStorms = new KeyedWindows(THRESHOLDS.watchStorm.count, THRESHOLDS.watchStorm.windowMs, 64);
  #missStorm = new SlidingWindow(THRESHOLDS.cacheMissStorm.count, THRESHOLDS.cacheMissStorm.windowMs);
  #memoryWarnedAt = -Infinity;
  #lagWarnedAt = -Infinity;
  readonly #reloadMs = new Map<string, number>();
  readonly #compiledFamilies = new Set<string>();
  #interval: IntervalHistogram | null = null;
  #cumulative: IntervalHistogram | null = null;
  #timer: NodeJS.Timeout | null = null;
  #listeners: (() => void) | null = null;

  constructor(options: TelemetryOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#sink = options.sink;
    this.startedAt = this.#resetAt = this.#now();
    this.#serviceLog = new Ring(options.serviceLogCapacity ?? LIMITS.serviceLog);
    this.#clientLog = new Ring(options.clientLogCapacity ?? LIMITS.clientLog);
    this.#sampleMs = options.sampleMs ?? LIMITS.sampleMs;
    this.#samples = new Ring(
      Math.max(2, Math.min(720, Math.ceil(THRESHOLDS.memoryGrowth.windowMs / this.#sampleMs) + 1)),
    );
  }

  // ------------------------------------------------------------ lifecycle

  /** Starts the event-loop monitors, the sampler and the process-level failure hooks. */
  start(): void {
    if (this.#timer !== null) return;
    this.#interval = monitorEventLoopDelay({ resolution: 10 });
    this.#cumulative = monitorEventLoopDelay({ resolution: 10 });
    this.#interval.enable();
    this.#cumulative.enable();
    this.#timer = setInterval(() => this.sample(), this.#sampleMs);
    this.#timer.unref();
    const exception = (error: Error, origin: string): void => {
      this.log("error", "svc.unhandled", `uncaught ${origin}: ${error?.message ?? String(error)}`, {
        data: { origin, error },
      });
    };
    const rejected = (reason: unknown): void => {
      this.log(
        "error",
        "svc.unhandled",
        `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`,
        { data: { origin: "unhandledRejection", reason } },
      );
    };
    // Observe without changing what the process does with a failure. The monitor sees every uncaught
    // exception, including a rejection Node raises as one (`throw`, the default, and `strict`).
    process.on("uncaughtExceptionMonitor", exception);
    const offs: (() => void)[] = [() => process.off("uncaughtExceptionMonitor", exception)];
    const policy = rejectionPolicy();
    const handledElsewhere = process.listenerCount("unhandledRejection") > 0;
    if (
      policy === "warn" ||
      policy === "none" ||
      ((policy === "throw" || policy === "warn-with-error-code") && handledElsewhere)
    ) {
      // A listener changes nothing here: `warn` and `none` ignore listeners, and otherwise another
      // listener already handles rejections. Should that listener go away, do what Node would.
      const rejection = (reason: unknown): void => {
        const alone = process.listenerCount("unhandledRejection") === 1;
        if (alone && policy === "throw") throw reason;
        rejected(reason);
        if (alone && policy === "warn-with-error-code") {
          process.exitCode = 1;
          process.emitWarning(
            reason instanceof Error ? reason.message : String(reason),
            "UnhandledPromiseRejectionWarning",
          );
        }
      };
      process.on("unhandledRejection", rejection);
      offs.push(() => process.off("unhandledRejection", rejection));
    } else if (policy === "warn-with-error-code") {
      // A rejection listener would suppress Node's warning and exit code; its warning is observable instead.
      const warning = (warning: Error): void => {
        if (warning.name === "UnhandledPromiseRejectionWarning") rejected(warning.message);
      };
      process.on("warning", warning);
      offs.push(() => process.off("warning", warning));
    }
    // `throw` without other listeners and `strict`: the monitor above already logs it.
    this.#listeners = () => {
      for (const off of offs) off();
    };
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#interval?.disable();
    this.#cumulative?.disable();
    this.#listeners?.();
    this.#listeners = null;
  }

  /**
   * Forgets the event-loop delay measured so far: work done before the service listens (loading
   * Mermaid's parsers, mermaid/warm.ts) holds no request, so it is not a stall anyone waited on.
   */
  discardLoopDelay(): void {
    this.#interval?.reset();
    this.#cumulative?.reset();
  }

  /** Clears metrics, logs and detector windows; `seq` keeps counting so a poller never rereads. */
  reset(): void {
    this.#registry = new Registry();
    this.#serviceLog.clear();
    this.#clientLog.clear();
    this.#warningTimes = new Ring(LIMITS.warningTimes);
    this.#samples.clear();
    this.#duplicates = new KeyedWindows(THRESHOLDS.duplicate.count - 1, THRESHOLDS.duplicate.windowMs);
    this.#bursts = new KeyedWindows(THRESHOLDS.burst.count, THRESHOLDS.burst.windowMs, 512);
    this.#watchStorms = new KeyedWindows(THRESHOLDS.watchStorm.count, THRESHOLDS.watchStorm.windowMs, 64);
    this.#missStorm = new SlidingWindow(THRESHOLDS.cacheMissStorm.count, THRESHOLDS.cacheMissStorm.windowMs);
    this.#reloadMs.clear();
    this.#interval?.reset();
    this.#cumulative?.reset();
    this.#resetAt = this.#now();
  }

  // ------------------------------------------------------------------ log

  log(level: Level, code: string, msg: string, fields: LogFields = {}): LogEntry {
    const entry: LogEntry = {
      seq: ++this.#seq,
      at: new Date(this.#now()).toISOString(),
      level,
      code: redactText(code, 96),
      msg: redactText(msg),
      ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
      ...(fields.route === undefined ? {} : { route: redactText(fields.route, 160) }),
      ...(fields.ms === undefined ? {} : { ms: Math.round(fields.ms * 100) / 100 }),
      ...(fields.action === undefined ? {} : { action: fields.action }),
      ...(fields.data === undefined ? {} : { data: redact(fields.data) }),
    };
    this.#serviceLog.push(entry);
    if (LEVEL_ORDER[level] >= LEVEL_ORDER.warn) {
      this.#registry.warnings.add(entry.code);
      this.#warningTimes.push(this.#now());
      this.#sink?.(`[archer] debug: ${level} ${entry.code} ${entry.msg}`);
    }
    return entry;
  }

  /** A browser event, stored beside the service's entries with `source: "client"`. */
  client(level: Level, code: string, msg: string, at: string, data: unknown): void {
    const entry: LogEntry = {
      seq: ++this.#seq,
      at,
      level,
      code: redactText(code, 96),
      msg: redactText(msg),
      source: "client",
      ...(data === undefined ? {} : { data: redact(data) }),
    };
    this.#clientLog.push(entry);
    this.#registry.client.add(entry.code);
    if (LEVEL_ORDER[level] >= LEVEL_ORDER.warn) this.#warningTimes.push(this.#now());
  }

  get seq(): number {
    return this.#seq;
  }

  /** Entries after `since` (oldest first, at most `limit`), or the newest `limit` without it. */
  entries(query: {
    since?: number;
    level?: Level;
    limit: number;
    code?: string;
    source?: "client" | "all";
  }): LogEntry[] {
    const min = LEVEL_ORDER[query.level ?? "debug"];
    const pool =
      query.source === "client"
        ? this.#clientLog.toArray()
        : merge(this.#serviceLog.toArray(), this.#clientLog.toArray());
    const matched = pool.filter(
      (entry) =>
        (query.since === undefined || entry.seq > query.since) &&
        LEVEL_ORDER[entry.level] >= min &&
        (query.code === undefined || entry.code.startsWith(query.code)),
    );
    return query.since === undefined ? matched.slice(-query.limit) : matched.slice(0, query.limit);
  }

  warningsWithin(ms: number): number {
    const from = this.#now() - ms;
    return this.#warningTimes.toArray().filter((at) => at >= from).length;
  }

  // ------------------------------------------------------------- requests

  request(record: RequestRecord, debugRoute: boolean): void {
    const now = this.#now();
    // The key is a route pattern (no caller-chosen text), redacted again here: a metrics key is never a secret.
    const route = this.#registry.routes.get(redactText(`${record.method} ${record.route}`, 160));
    route.statuses.add(String(record.status));
    route.bytes += record.bytes;
    if (record.status >= 500) route.errors++;
    if (record.streaming) route.streams++;
    else route.latency.add(record.ms);
    if (debugRoute) return;
    const fields = {
      requestId: record.requestId,
      route: record.route,
      ms: record.ms,
      ...(record.action === undefined ? {} : { action: record.action }),
    };
    // The route pattern, not the path: a path or query holds what the caller sent, a mistyped token included.
    this.log("debug", "svc.request", `${record.method} ${record.route} ${record.status}`, {
      ...fields,
      data: { status: record.status, bytes: record.bytes, client: record.client, phases: record.phases },
    });
    if (!record.streaming && record.ms > THRESHOLDS.slowRequestMs)
      this.log(
        "warn",
        "svc.slow-request",
        `${record.method} ${record.route} took ${Math.round(record.ms)} ms (> ${THRESHOLDS.slowRequestMs})`,
        { ...fields, data: { phases: record.phases } },
      );
    const repeated = this.#duplicates.hit(
      `${record.client}${record.page === undefined ? "" : ` ${record.page}`} ${record.method} ${record.target}${record.bodyHash === undefined ? "" : ` #${record.bodyHash}`}`,
      now,
    );
    if (repeated !== null)
      this.log(
        "warn",
        "svc.duplicate-request",
        `${record.method} ${record.route} ${repeated}× within ${THRESHOLDS.duplicate.windowMs} ms from one client`,
        { ...fields, data: { client: record.client, count: repeated } },
      );
    const burst = this.#bursts.hit(record.client, now);
    if (burst !== null)
      this.log(
        "warn",
        "svc.request-burst",
        `one client made more than ${THRESHOLDS.burst.count} requests within ${THRESHOLDS.burst.windowMs} ms`,
        { ...fields, data: { client: record.client, count: burst } },
      );
  }

  // --------------------------------------------------------------- domain

  compiled(family: string, ms: number, ok: boolean, requestId?: string): void {
    const metrics = this.#registry.compile.get(family);
    // The process's first compile of a family also loads and JITs its parser.
    const cold = !this.#compiledFamilies.has(family);
    if (cold && this.#compiledFamilies.size < 32) this.#compiledFamilies.add(family);
    metrics.latency.add(ms);
    metrics.outcomes.add(ok ? "compiled" : "failed");
    if (ms > THRESHOLDS.slowCompileMs)
      this.log(
        "warn",
        "svc.slow-compile",
        `a ${family} compile took ${Math.round(ms)} ms (> ${THRESHOLDS.slowCompileMs})${cold ? "; the first of its family, which includes loading the parser" : ""}`,
        { ms, ...(requestId === undefined ? {} : { requestId }), data: { family, ok, cold } },
      );
  }

  compileCache(hit: boolean): void {
    this.#registry.compileCache.add(hit ? "hit" : "miss");
    if (!hit) this.#miss("compile");
  }

  thumbnailCache(hit: boolean): void {
    this.#registry.thumbnailCache.add(hit ? "hit" : "miss");
    if (!hit) this.#miss("thumbnail");
  }

  thumbnailRendered(ms: number): void {
    this.#registry.thumbnailRender.add(ms);
  }

  thumbnailRefused(code: string): void {
    this.#registry.thumbnailRefusals.add(code);
    this.log("info", "svc.thumbnail-refused", `thumbnail refused: ${code}`, { data: { code } });
  }

  #miss(kind: string): void {
    const count = this.#missStorm.hit(this.#now());
    if (count !== null)
      this.log(
        "warn",
        "svc.cache-miss-storm",
        `more than ${THRESHOLDS.cacheMissStorm.count} thumbnail/compile cache misses within ${THRESHOLDS.cacheMissStorm.windowMs} ms`,
        { data: { last: kind, count } },
      );
  }

  watchEvent(project: string): void {
    this.#registry.watcherEvents.add(project);
    const count = this.#watchStorms.hit(project, this.#now());
    if (count !== null)
      this.log(
        "warn",
        "svc.watch-storm",
        `more than ${THRESHOLDS.watchStorm.count} file events within ${THRESHOLDS.watchStorm.windowMs} ms`,
        { data: { project, count } },
      );
  }

  reloaded(project: string, ms: number, ok: boolean): void {
    const metrics = this.#registry.reloads.get(project);
    metrics.latency.add(ms);
    metrics.outcomes.add(ok ? "ok" : "failed");
    // Insertion order is recency: the oldest root goes first once the cap is reached.
    this.#reloadMs.delete(project);
    this.#reloadMs.set(project, Math.round(ms * 100) / 100);
    if (this.#reloadMs.size > LIMITS.reloadRoots) this.#reloadMs.delete(this.#reloadMs.keys().next().value as string);
    this.log(
      ok ? "debug" : "warn",
      ok ? "svc.reload" : "svc.reload-failed",
      `reload ${ok ? "finished" : "failed"} in ${Math.round(ms)} ms`,
      { ms, data: { project } },
    );
  }

  lastReloadMs(project: string): number | null {
    return this.#reloadMs.get(project) ?? null;
  }

  reloadRootsTracked(): number {
    return this.#reloadMs.size;
  }

  /** A detached project: its reload timing goes (its metrics stay until reset, under the capped keys). */
  forgetProject(project: string): void {
    this.#reloadMs.delete(project);
  }

  /** `open` after the change; `limit` is the service's stream cap. */
  stream(event: "opened" | "closed" | "refused", open: number, limit: number): void {
    this.#registry.streams.add(event);
    const threshold = Math.min(THRESHOLDS.streamLeak, limit);
    if (event === "refused" || (event === "opened" && open > THRESHOLDS.streamLeak))
      this.log(
        "warn",
        "svc.stream-leak",
        `${open} event streams open (cap ${limit}, leak threshold ${threshold})${event === "refused" ? "; a new stream was refused" : ""}`,
        { data: { open, limit } },
      );
  }

  edit(family: string, op: string, code: string | null, ms: number, requestId?: string): void {
    const metrics = this.#registry.edits.get(`${family} ${op}`);
    metrics.latency.add(ms);
    metrics.outcomes.add(code ?? "ok");
    if (code === null) return;
    const fields = { ms, ...(requestId === undefined ? {} : { requestId }), data: { family, op, code } };
    if (code === "edit_invalid_result" || code === "edit_source_mapping_ambiguous")
      this.log("warn", "svc.edit-postcondition", `the ${family} editor refused its own ${op} result: ${code}`, fields);
    else this.log("info", "svc.edit-refused", `${family} ${op} refused: ${code}`, fields);
  }

  authoring(
    action: string,
    code: string | null,
    status: number,
    ms: number,
    data?: Record<string, unknown>,
    requestId?: string,
  ): void {
    const metrics = this.#registry.authoring.get(action);
    metrics.latency.add(ms);
    metrics.outcomes.add(code ?? "ok");
    if (code === null) return;
    this.log(
      status >= 500 ? "warn" : "info",
      code === "authoring_forbidden"
        ? "svc.authoring-forbidden"
        : action === "presentation"
          ? "svc.presentation-refused"
          : "svc.authoring-refused",
      `authoring ${action} refused ${status} ${code}`,
      { ms, ...(requestId === undefined ? {} : { requestId }), data: { action, code, status, ...data } },
    );
  }

  management(method: string, ms: number, code: string | null): void {
    const metrics = this.#registry.management.get(method);
    metrics.latency.add(ms);
    metrics.outcomes.add(code ?? "ok");
    this.log(code === "internal" ? "warn" : "debug", "svc.management", `${method} ${code ?? "ok"}`, {
      ms,
      data: { method, code },
    });
  }

  // -------------------------------------------------------------- process

  /** One memory / event-loop sample; also run by the timer. */
  sample(): void {
    const now = this.#now();
    const memory = process.memoryUsage();
    const loop = this.#interval;
    const loopMaxMs = loop !== null && loop.count > 0 ? loop.max / 1e6 : 0;
    const loopP99Ms = loop !== null && loop.count > 0 ? loop.percentile(99) / 1e6 : 0;
    loop?.reset();
    const sample: Sample = {
      at: now,
      heapUsedMb: mb(memory.heapUsed),
      rssMb: mb(memory.rss),
      loopMaxMs: Math.round(loopMaxMs * 10) / 10,
      loopP99Ms: Math.round(loopP99Ms * 10) / 10,
    };
    this.#samples.push(sample);
    if (loopMaxMs > THRESHOLDS.eventLoopLagMs && now - this.#lagWarnedAt > this.#sampleMs) {
      this.#lagWarnedAt = now;
      this.log(
        "warn",
        "svc.event-loop-lag",
        `the event loop was blocked up to ${Math.round(loopMaxMs)} ms (> ${THRESHOLDS.eventLoopLagMs})`,
        { ms: loopMaxMs, data: { p99Ms: sample.loopP99Ms } },
      );
    }
    this.#checkMemory(now);
  }

  /** Heap grew by more than the ratio across the window and its low point never came back down. */
  #checkMemory(now: number): void {
    const window = THRESHOLDS.memoryGrowth.windowMs;
    const samples = this.#samples.toArray();
    const first = samples[0];
    if (first === undefined || now - first.at < window * 0.9 || now - this.#memoryWarnedAt < window) return;
    const early = samples.filter((s) => s.at - first.at <= window / 5),
      late = samples.filter((s) => now - s.at <= window / 2);
    const baseline = Math.min(...early.map((s) => s.heapUsedMb)),
      floor = Math.min(...late.map((s) => s.heapUsedMb));
    if (baseline > 0 && floor > baseline * THRESHOLDS.memoryGrowth.ratio) {
      this.#memoryWarnedAt = now;
      this.log(
        "warn",
        "svc.memory-growth",
        `heap low point rose from ${baseline} MB to ${floor} MB over ${Math.round((now - first.at) / 60_000)} min`,
        { data: { baselineMb: baseline, floorMb: floor } },
      );
    }
  }

  memoryNow(): { heapUsedMb: number; rssMb: number } {
    const memory = process.memoryUsage();
    return { heapUsedMb: mb(memory.heapUsed), rssMb: mb(memory.rss) };
  }

  eventLoopLagMs(): number {
    const live = this.#interval !== null && this.#interval.count > 0 ? this.#interval.max / 1e6 : 0;
    return Math.round(Math.max(live, this.#samples.last()?.loopMaxMs ?? 0) * 10) / 10;
  }

  metrics(): Record<string, unknown> {
    const r = this.#registry,
      loop = this.#cumulative;
    const ms = (ns: number): number => Math.round(ns / 1e4) / 100;
    return {
      schemaVersion: 1,
      uptimeMs: this.#now() - this.startedAt,
      windowMs: this.#now() - this.#resetAt,
      routes: Object.fromEntries(
        [...r.routes.entries()].map(([key, value]) => [
          key,
          {
            count: value.latency.count + value.streams,
            statuses: value.statuses.toJSON(),
            errors: value.errors,
            bytes: value.bytes,
            streams: value.streams,
            latency: value.latency.snapshot(),
          },
        ]),
      ),
      compile: { byFamily: outcomes(r.compile), cache: r.compileCache.toJSON() },
      thumbnails: {
        cache: r.thumbnailCache.toJSON(),
        render: r.thumbnailRender.snapshot(),
        refused: r.thumbnailRefusals.toJSON(),
      },
      eventLoop: {
        delayMs:
          loop === null || loop.count === 0
            ? null
            : {
                mean: ms(loop.mean),
                p50: ms(loop.percentile(50)),
                p90: ms(loop.percentile(90)),
                p99: ms(loop.percentile(99)),
                max: ms(loop.max),
              },
        series: this.#samples.toArray().map((s) => ({ at: s.at, maxMs: s.loopMaxMs, p99Ms: s.loopP99Ms })),
      },
      memory: {
        now: this.memoryNow(),
        series: this.#samples.toArray().map((s) => ({ at: s.at, heapUsedMb: s.heapUsedMb, rssMb: s.rssMb })),
      },
      watcher: { events: r.watcherEvents.toJSON(), reloads: outcomes(r.reloads) },
      streams: r.streams.toJSON(),
      authoring: { edits: outcomes(r.edits), requests: outcomes(r.authoring) },
      management: outcomes(r.management),
      warnings: r.warnings.toJSON(),
      client: r.client.toJSON(),
    };
  }
}

function merge(a: LogEntry[], b: LogEntry[]): LogEntry[] {
  const out: LogEntry[] = [];
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i]!.seq < b[j]!.seq)) out.push(a[i++]!);
    else out.push(b[j++]!);
  }
  return out;
}
