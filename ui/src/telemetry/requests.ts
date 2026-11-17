/**
 * Request bookkeeping for dev telemetry: one record per `fetch`, and the request warnings of the
 * contract (`ui.fetch-failed`, `ui.fetch-slow`, `ui.fetch-duplicate`, `ui.request-count`).
 */
import type { TelemetryReport } from "./dev";
import { redactText, redactUrl } from "./redact";

export interface RequestRecord {
  /** Epoch ms when the request started. */
  readonly at: number;
  /** The page view (`pageKey`) it was made in. */
  readonly page: string;
  readonly method: string;
  /** Path and query, origin dropped when it is the page's own; bounded. */
  readonly url: string;
  /** `url` with id-like path segments as `:id` and query values dropped: groups the same call. */
  readonly pattern: string;
  /** Null when the request failed before a response. */
  readonly status: number | null;
  /** Until the response headers (the body may still be streaming). */
  readonly ms: number;
  /** Content-Length, or the resource-timing body size once known; null when neither is. */
  bytes: number | null;
  readonly serverTiming?: Readonly<Record<string, number>>;
  readonly requestId?: string;
  readonly error?: string;
}

export interface RequestLimits {
  readonly slowMs: number;
  readonly duplicateCount: number;
  readonly duplicateWindowMs: number;
  readonly pageRequestLimit: number;
  readonly keep: number;
}
const isCommittedEdit = (method: string, url: string): boolean =>
  method === "POST" && /\/api\/authoring\/edit(?:[?#]|$)/.test(url);

export const CONTRACT_LIMITS: RequestLimits = {
  slowMs: 1000,
  duplicateCount: 3,
  duplicateWindowMs: 2000,
  pageRequestLimit: 40,
  keep: 2000,
};

const ID_SEGMENT =
  /^(?:[0-9a-f]{12,}|[0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:drf|op)_[0-9a-f]{16,})$/i;

/** `/p/demo/api/comments?path=a.mmd&x=1` → `/p/demo/api/comments?path&x`. */
export function urlPattern(url: string, origin?: string): string {
  let parsed: URL;
  // Redacted as well as cut: an unparsable URL, or a parameter named by a token, may carry one.
  try {
    parsed = new URL(url, origin ?? "http://pattern.invalid");
  } catch {
    return redactText(url, 200);
  }
  const path = parsed.pathname
    .split("/")
    .map((segment) => (ID_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
  const names = [...new Set([...parsed.searchParams.keys()])];
  const own =
    origin === undefined || parsed.origin === new URL(origin).origin || parsed.origin === "http://pattern.invalid";
  return redactText(`${own ? "" : parsed.origin}${path}${names.length ? `?${names.join("&")}` : ""}`, 300);
}

export function shortUrl(url: string, origin?: string): string {
  try {
    const parsed = new URL(url, origin ?? "http://pattern.invalid");
    const own =
      origin === undefined || parsed.origin === new URL(origin).origin || parsed.origin === "http://pattern.invalid";
    return redactUrl(`${own ? "" : parsed.origin}${parsed.pathname}${parsed.search}`).slice(0, 500);
  } catch {
    return redactUrl(url).slice(0, 500);
  }
}

/** `total;dur=12.5, compile;dur=3;desc="x"` → `{total: 12.5, compile: 3}`. */
export function parseServerTiming(header: string | null): Record<string, number> | undefined {
  if (!header) return undefined;
  const result: Record<string, number> = {};
  for (const metric of header.split(",")) {
    const [name, ...params] = metric.split(";").map((part) => part.trim());
    if (!name) continue;
    const duration = params.find((param) => param.toLowerCase().startsWith("dur="));
    const value = duration === undefined ? Number.NaN : Number(duration.slice(4));
    result[name] = Number.isFinite(value) ? value : 0;
  }
  return Object.keys(result).length ? result : undefined;
}

/** A short, non-cryptographic fingerprint of a request body (FNV-1a, 32 bit). */
function bodyHash(body: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) hash = Math.imul(hash ^ body.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
}

export class RequestTracker {
  private readonly records: RequestRecord[] = [];
  private readonly recent = new Map<string, number[]>();
  private readonly duplicateReported = new Map<string, number>();
  private pageCount = 0;
  private pageCountReported = false;

  /** Keys tracked for duplicates, and timestamps per key: enough to see `duplicateCount` repeats. */
  static readonly MAX_KEYS = 500;

  constructor(
    private readonly report: (event: TelemetryReport) => void,
    private readonly limits: RequestLimits = CONTRACT_LIMITS,
  ) {}

  /** A new page view: the per-page request count starts again. */
  pageView(): void {
    this.pageCount = 0;
    this.pageCountReported = false;
  }

  /** Called when a request starts, so duplicates are seen as they are issued. */
  started(method: string, url: string, page: string, now: number, body?: string): void {
    // Writes with different bodies (a chain of edits to one route) are different requests, not duplicates.
    const key = body === undefined ? `${method} ${url}` : `${method} ${url} #${bodyHash(body)}`;
    const windowMs = this.limits.duplicateWindowMs;
    const times = (this.recent.get(key) ?? []).filter((at) => now - at <= windowMs);
    times.push(now);
    if (times.length > this.limits.duplicateCount) times.splice(0, times.length - this.limits.duplicateCount);
    // Insertion order is recency: idle keys go first, then the oldest, so both maps stay capped.
    this.recent.delete(key);
    this.recent.set(key, times);
    if (this.recent.size > RequestTracker.MAX_KEYS) {
      for (const [other, list] of this.recent) if (now - list[list.length - 1]! > windowMs) this.recent.delete(other);
      while (this.recent.size > RequestTracker.MAX_KEYS) this.recent.delete(this.recent.keys().next().value as string);
    }
    for (const [other, at] of this.duplicateReported) if (now - at > windowMs) this.duplicateReported.delete(other);
    while (this.duplicateReported.size >= RequestTracker.MAX_KEYS)
      this.duplicateReported.delete(this.duplicateReported.keys().next().value as string);
    const last = this.duplicateReported.get(key);
    if (times.length >= this.limits.duplicateCount && (last === undefined || now - last > windowMs)) {
      this.duplicateReported.set(key, now);
      this.report({
        level: "warn",
        code: "ui.fetch-duplicate",
        msg: `${method} ${url} issued ${times.length} times within ${windowMs} ms`,
        data: { method, url, count: times.length, page },
      });
    }
    // A committed edit is one change a person made, not a read: the per-view count is about what the page reads
    // (tools/perf/lib/requests.mjs isCommittedEdit, the same rule); an edit sent twice is ui.edit.double-commit.
    if (!isCommittedEdit(method, url)) this.pageCount += 1;
    if (this.pageCount > this.limits.pageRequestLimit && !this.pageCountReported) {
      this.pageCountReported = true;
      this.report({
        level: "warn",
        code: "ui.request-count",
        msg: `this page view made more than ${this.limits.pageRequestLimit} requests`,
        data: { page, limit: this.limits.pageRequestLimit },
      });
    }
  }

  finished(record: RequestRecord): void {
    this.records.push(record);
    if (this.records.length > this.limits.keep) this.records.splice(0, this.records.length - this.limits.keep);
    const data = {
      method: record.method,
      url: record.url,
      status: record.status,
      ms: Math.round(record.ms),
      page: record.page,
      ...(record.requestId ? { requestId: record.requestId } : {}),
      ...(record.serverTiming ? { serverTiming: record.serverTiming } : {}),
    };
    if (record.status === null || record.status >= 400) {
      this.report({
        level: record.status === null || record.status >= 500 ? "error" : "warn",
        code: "ui.fetch-failed",
        msg: `${record.method} ${record.url} ${record.status === null ? `failed: ${record.error ?? "network error"}` : `returned ${record.status}`}`,
        data,
      });
    }
    if (record.ms > this.limits.slowMs)
      this.report({
        level: "warn",
        code: "ui.fetch-slow",
        msg: `${record.method} ${record.url} took ${Math.round(record.ms)} ms`,
        data,
      });
  }

  all(): RequestRecord[] {
    return [...this.records];
  }
  /** What the duplicate detector holds now (for the bound's tests). */
  held(): { keys: number; reported: number; longestTimes: number } {
    return {
      keys: this.recent.size,
      reported: this.duplicateReported.size,
      longestTimes: Math.max(0, ...[...this.recent.values()].map((times) => times.length)),
    };
  }
  clear(): void {
    this.records.length = 0;
    this.recent.clear();
    this.duplicateReported.clear();
    this.pageView();
  }
}
