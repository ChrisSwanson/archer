// Development telemetry (ARCHER_DEBUG=1; docs/devkit/service-telemetry.md).
//
// Domain code reports through `activeTelemetry()`, which is null unless a
// service started with debug on: every hook is one null check when it is off.
// A request's timing context rides an AsyncLocalStorage that is entered only
// for debug services, so compile or render time spent on behalf of a request
// lands in that request's Server-Timing without threading a parameter.
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { Telemetry } from "./telemetry.ts";

export {
  Telemetry,
  THRESHOLDS,
  LIMITS,
  LEVEL_ORDER,
  isLevel,
  rejectionPolicy,
  type Level,
  type LogEntry,
  type RejectionPolicy,
  type RequestRecord,
} from "./telemetry.ts";
export { knowSecret, redact, redactText, redactUrl, REDACTED } from "./redact.ts";

/** Whether the environment turns development telemetry on: exactly `ARCHER_DEBUG=1`. */
export function debugEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env["ARCHER_DEBUG"] === "1";
}

/** Whether CPU profiles and heap snapshots may be taken: exactly `ARCHER_DEBUG_PROFILING=1`, on top of debug. */
export function profilingEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return debugEnabled(env) && env["ARCHER_DEBUG_PROFILING"] === "1";
}

let active: Telemetry | null = null;

/** The running debug service's telemetry, or null (always null when debug is off). */
export function activeTelemetry(): Telemetry | null {
  return active;
}

/** Makes `telemetry` the process's reporting target; one debug service per process reports. */
export function activate(telemetry: Telemetry): void {
  active = telemetry;
}

export function deactivate(telemetry: Telemetry): void {
  if (active === telemetry) active = null;
}

const PHASE_NAME = /^[a-z][a-z0-9-]{0,23}$/;

/** One HTTP request's identity and server-side phases. */
export class RequestTiming {
  readonly startedAt = performance.now();
  readonly #phases = new Map<string, number>();
  /** `grant:<id>` once a grant authenticated, else `addr:<peer address>`. */
  client: string;
  constructor(
    readonly id: string,
    remote: string | undefined,
    readonly action?: string,
  ) {
    this.client = `addr:${remote ?? "unknown"}`;
  }
  add(name: string, ms: number): void {
    if (!PHASE_NAME.test(name) || (this.#phases.size >= 12 && !this.#phases.has(name))) return;
    this.#phases.set(name, (this.#phases.get(name) ?? 0) + ms);
  }
  phases(): Record<string, number> {
    return Object.fromEntries([...this.#phases].map(([name, ms]) => [name, Math.round(ms * 100) / 100]));
  }
  elapsed(): number {
    return performance.now() - this.startedAt;
  }
  /** `auth;dur=0.4, compile;dur=12.1, total;dur=13.0` */
  serverTiming(): string {
    const parts = [...this.#phases].map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`);
    parts.push(`total;dur=${this.elapsed().toFixed(1)}`);
    return parts.join(", ");
  }
}

export const requestContext = new AsyncLocalStorage<RequestTiming>();

/** The current request's timing, when a debug service is serving one. */
export function currentRequest(): RequestTiming | undefined {
  return active === null ? undefined : requestContext.getStore();
}

/** A start mark for `phaseEnd`; 0 (and no clock read) when debug is off. */
export function phaseStart(): number {
  return active === null ? 0 : performance.now();
}

/** Adds the time since `started` to the current request's `name` phase; returns the duration in ms. */
export function phaseEnd(name: string, started: number): number {
  if (started === 0 || active === null) return 0;
  const ms = performance.now() - started;
  requestContext.getStore()?.add(name, ms);
  return ms;
}

/** Records which grant a request authenticated as, for the per-client detectors. */
export function requestClient(grantId: string | undefined): void {
  if (grantId === undefined || active === null) return;
  const timing = requestContext.getStore();
  if (timing !== undefined) timing.client = `grant:${grantId}`;
}
