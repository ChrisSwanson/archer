/**
 * Web vitals by `PerformanceObserver`, without a library: TTFB, FCP, LCP, CLS, INP.
 *
 * TTFB, FCP and LCP describe the document load, so only the first page view has them; a route
 * change in this single-page app is not a navigation and the browser reports no new paint for it.
 * CLS and INP are per page view: they start again at each route change.
 */

/** CLS session windows: shifts less than 1 s apart, at most 5 s long; the largest window counts. */
export class ClsWindow {
  private windowValue = 0;
  private windowStart = -Infinity;
  private last = -Infinity;
  value = 0;
  add(startTime: number, shift: number): void {
    if (startTime - this.last > 1000 || startTime - this.windowStart > 5000) {
      this.windowValue = 0;
      this.windowStart = startTime;
    }
    this.windowValue += shift;
    this.last = startTime;
    this.value = Math.max(this.value, this.windowValue);
  }
}

/**
 * INP: the 98th-percentile interaction latency (the worst one below 50 interactions). Bounded like the
 * web-vitals library: only the `keep` longest interactions are held (exact below 50 × keep
 * interactions), and recently seen ids, to merge the entries of one interaction.
 */
export class InteractionLatency {
  private readonly longest: { id: number; duration: number }[] = [];
  private readonly recentIds = new Set<number>();
  private interactions = 0;
  constructor(
    private readonly keep = 10,
    private readonly recentKeep = 64,
  ) {}
  add(interactionId: number, duration: number): void {
    if (!interactionId) return;
    if (!this.recentIds.has(interactionId)) {
      this.interactions += 1;
      this.recentIds.add(interactionId);
      if (this.recentIds.size > this.recentKeep) this.recentIds.delete(this.recentIds.values().next().value as number);
    }
    const existing = this.longest.find((entry) => entry.id === interactionId);
    if (existing) existing.duration = Math.max(existing.duration, duration);
    else if (this.longest.length < this.keep || duration > this.longest[this.longest.length - 1]!.duration)
      this.longest.push({ id: interactionId, duration });
    this.longest.sort((a, b) => b.duration - a.duration);
    if (this.longest.length > this.keep) this.longest.length = this.keep;
  }
  get count(): number {
    return this.interactions;
  }
  /** Interactions held: never more than `keep`. */
  get held(): number {
    return this.longest.length;
  }
  value(): number | undefined {
    if (this.longest.length === 0) return undefined;
    return this.longest[Math.min(this.longest.length - 1, Math.floor(this.interactions / 50))]!.duration;
  }
}

export interface VitalsObserver {
  /** The current page view's values, rounded (ms; CLS unitless). */
  current(): Record<string, number>;
  /** Start a new page view: CLS and INP restart; load vitals belong to the first view only. */
  pageView(): void;
  disconnect(): void;
}

type Observe = (
  type: string,
  callback: (entries: PerformanceEntry[]) => void,
  options?: Record<string, unknown>,
) => (() => void) | null;

const observeWith: Observe = (type, callback, options = {}) => {
  if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes(type))
    return null;
  try {
    const observer = new PerformanceObserver((list) => callback(list.getEntries()));
    observer.observe({ type, buffered: true, ...options } as PerformanceObserverInit);
    return () => observer.disconnect();
  } catch {
    return null;
  }
};

export function observeVitals(observe: Observe = observeWith): VitalsObserver {
  let first = true;
  const load: Record<string, number> = {};
  let cls = new ClsWindow(),
    inp = new InteractionLatency();
  const navigation =
    typeof performance !== "undefined"
      ? (performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined)
      : undefined;
  if (navigation)
    load.TTFB = navigation.responseStart - ((navigation as { activationStart?: number }).activationStart ?? 0);
  const stops = [
    observe("paint", (entries) => {
      for (const entry of entries) if (entry.name === "first-contentful-paint") load.FCP = entry.startTime;
    }),
    observe("largest-contentful-paint", (entries) => {
      const last = entries[entries.length - 1];
      if (last) load.LCP = last.startTime;
    }),
    observe("layout-shift", (entries) => {
      for (const entry of entries as (PerformanceEntry & { value: number; hadRecentInput: boolean })[])
        if (!entry.hadRecentInput) cls.add(entry.startTime, entry.value);
    }),
    observe(
      "event",
      (entries) => {
        for (const entry of entries as (PerformanceEntry & { interactionId?: number })[])
          inp.add(entry.interactionId ?? 0, entry.duration);
      },
      { durationThreshold: 16 },
    ),
  ];
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    current() {
      const values: Record<string, number> = {};
      if (first) for (const [name, value] of Object.entries(load)) values[name] = Math.round(value);
      values.CLS = round(cls.value);
      const latency = inp.value();
      if (latency !== undefined) values.INP = Math.round(latency);
      return values;
    },
    pageView() {
      first = false;
      cls = new ClsWindow();
      inp = new InteractionLatency();
    },
    disconnect() {
      for (const stop of stops) stop?.();
    },
  };
}
