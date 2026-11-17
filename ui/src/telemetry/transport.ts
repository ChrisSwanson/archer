/**
 * Batches telemetry events to `POST /-/debug/events` (docs/devkit/CONTRACT.md): every `intervalMs`,
 * and on `pagehide` by `sendBeacon` (or a keepalive fetch). A batch stays within the service's limits
 * (≤ 200 events, ≤ 64 KiB). A service without debug routes answers 404; sending then stops, and the
 * events stay readable in `window.__archerTelemetry`.
 */

export interface TelemetryEvent {
  /** Epoch ms. */
  readonly at: number;
  readonly type: "info" | "warn" | "error" | "pageview";
  readonly code?: string;
  readonly msg?: string;
  readonly data?: Record<string, unknown>;
  /** The page view it belongs to. */
  readonly page: string;
}

export interface Batch {
  readonly session: string;
  readonly page: string;
  readonly build: string;
  readonly events: readonly Omit<TelemetryEvent, "page">[];
}

export const MAX_BATCH_EVENTS = 200;
export const MAX_BATCH_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 8 * 1024;
const MAX_QUEUE = 1000;

/** The events endpoint at the page's origin root, never under a project or token prefix. */
export function eventsUrl(href: string): string {
  return new URL("/-/debug/events", href).href;
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** One event as sent: oversized `data` is replaced by a note of its size. */
export function bounded(event: TelemetryEvent): Omit<TelemetryEvent, "page"> & { data?: Record<string, unknown> } {
  const { page, ...rest } = event;
  const withPage = { ...rest, data: { ...(rest.data ?? {}), page } };
  const size = bytes(JSON.stringify(withPage));
  if (size <= MAX_EVENT_BYTES) return withPage;
  return { ...rest, msg: rest.msg?.slice(0, 1000), data: { page, truncated: true, originalBytes: size } };
}

/** Split events into batches within the service's limits. */
export function batches(session: string, build: string, events: readonly TelemetryEvent[]): Batch[] {
  const result: Batch[] = [];
  let current: Omit<TelemetryEvent, "page">[] = [],
    page = events[0]?.page ?? "",
    size = 0;
  const envelope = (list: Omit<TelemetryEvent, "page">[]) => ({ session, page, build, events: list });
  const overhead = bytes(JSON.stringify(envelope([]))) + 64;
  for (const event of events) {
    const item = bounded(event),
      itemBytes = bytes(JSON.stringify(item)) + 1;
    if (current.length > 0 && (current.length >= MAX_BATCH_EVENTS || overhead + size + itemBytes > MAX_BATCH_BYTES)) {
      result.push(envelope(current));
      current = [];
      size = 0;
    }
    if (current.length === 0) page = event.page;
    current.push(item);
    size += itemBytes;
  }
  if (current.length > 0) result.push(envelope(current));
  return result;
}

export interface TransportOptions {
  readonly url: string;
  readonly session: string;
  readonly build: string;
  /** The page's own fetch, before telemetry wrapped it, so sending is never itself recorded. */
  readonly fetch: typeof fetch;
  readonly beacon?: (url: string, body: Blob) => boolean;
}

export class Transport {
  private queue: TelemetryEvent[] = [];
  private disabled = false;
  private inFlight = false;
  dropped = 0;

  constructor(private readonly options: TransportOptions) {}

  enqueue(event: TelemetryEvent): void {
    if (this.disabled) return;
    this.queue.push(event);
    if (this.queue.length > MAX_QUEUE) {
      this.dropped += this.queue.length - MAX_QUEUE;
      this.queue.splice(0, this.queue.length - MAX_QUEUE);
    }
  }

  get pending(): number {
    return this.queue.length;
  }
  get stopped(): boolean {
    return this.disabled;
  }

  /** Send what is queued. `unloading` uses the beacon, which outlives the page. */
  async flush(unloading = false): Promise<void> {
    if (this.disabled || this.queue.length === 0 || (this.inFlight && !unloading)) return;
    const events = this.queue;
    this.queue = [];
    const parts = batches(this.options.session, this.options.build, events);
    if (unloading) {
      for (const batch of parts) {
        const body = JSON.stringify(batch);
        const sent = this.options.beacon?.(this.options.url, new Blob([body], { type: "application/json" })) ?? false;
        if (!sent)
          void this.options
            .fetch(this.options.url, {
              method: "POST",
              body,
              keepalive: true,
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
            })
            .catch(() => undefined);
      }
      return;
    }
    this.inFlight = true;
    try {
      for (const batch of parts) {
        const response = await this.options.fetch(this.options.url, {
          method: "POST",
          body: JSON.stringify(batch),
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
        });
        // No debug routes on this service (ARCHER_DEBUG off) or no access: keep the events local only.
        if (response.status === 404 || response.status === 403 || response.status === 401) {
          this.disabled = true;
          this.queue = [];
          return;
        }
      }
    } catch {
      // The service is away; this batch is lost, the local buffer still has it.
    } finally {
      this.inFlight = false;
    }
  }
}
