// Bounded building blocks for the development telemetry (docs/devkit/service-telemetry.md).
// Every structure here has a fixed upper size: a ring, a capped key map, a
// window holding at most threshold + 1 timestamps.

/** A fixed-capacity ring; the oldest entry is overwritten. */
export class Ring<T> {
  readonly #items: (T | undefined)[];
  #next = 0;
  #size = 0;
  constructor(readonly capacity: number) {
    this.#items = new Array<T | undefined>(capacity);
  }
  get size(): number {
    return this.#size;
  }
  push(item: T): void {
    this.#items[this.#next] = item;
    this.#next = (this.#next + 1) % this.capacity;
    if (this.#size < this.capacity) this.#size++;
  }
  /** Oldest first. */
  toArray(): T[] {
    const out: T[] = [];
    const start = (this.#next - this.#size + this.capacity) % this.capacity;
    for (let i = 0; i < this.#size; i++) out.push(this.#items[(start + i) % this.capacity] as T);
    return out;
  }
  last(): T | undefined {
    return this.#size === 0 ? undefined : this.#items[(this.#next - 1 + this.capacity) % this.capacity];
  }
  clear(): void {
    this.#items.fill(undefined);
    this.#next = 0;
    this.#size = 0;
  }
}

export interface StatSnapshot {
  readonly count: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** Count, mean and max of everything seen; p50/p95 over the most recent `window` values. */
export class Stat {
  count = 0;
  #sum = 0;
  #max = 0;
  readonly #recent: Ring<number>;
  constructor(window = 512) {
    this.#recent = new Ring(window);
  }
  add(value: number): void {
    this.count++;
    this.#sum += value;
    if (value > this.#max) this.#max = value;
    this.#recent.push(value);
  }
  snapshot(): StatSnapshot {
    const sorted = this.#recent.toArray().sort((a, b) => a - b);
    const at = (q: number): number =>
      sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    return {
      count: this.count,
      mean: round(this.count === 0 ? 0 : this.#sum / this.count),
      p50: round(at(0.5)),
      p95: round(at(0.95)),
      max: round(this.#max),
    };
  }
}

/** Named counters, at most `maxKeys` of them; further names count under `other`. */
export class Counts {
  readonly #map = new Map<string, number>();
  constructor(readonly maxKeys = 256) {}
  add(key: string, by = 1): void {
    const name = this.#map.has(key) || this.#map.size < this.maxKeys ? key : "other";
    this.#map.set(name, (this.#map.get(name) ?? 0) + by);
  }
  get(key: string): number {
    return this.#map.get(key) ?? 0;
  }
  toJSON(): Record<string, number> {
    return Object.fromEntries(this.#map);
  }
}

/** Values by name, at most `maxKeys` of them; further names share `other`. */
export class Keyed<V> {
  readonly #map = new Map<string, V>();
  constructor(
    readonly make: () => V,
    readonly maxKeys = 128,
  ) {}
  get(key: string): V {
    let value = this.#map.get(key);
    if (value !== undefined) return value;
    const name = this.#map.size < this.maxKeys ? key : "other";
    value = this.#map.get(name);
    if (value === undefined) {
      value = this.make();
      this.#map.set(name, value);
    }
    return value;
  }
  entries(): IterableIterator<[string, V]> {
    return this.#map.entries();
  }
}

/**
 * Fires when more than `threshold` hits land within `windowMs`, then stays
 * quiet for one window. Holds at most threshold + 1 timestamps.
 */
export class SlidingWindow {
  readonly #hits: number[] = [];
  #firedAt = -Infinity;
  constructor(
    readonly threshold: number,
    readonly windowMs: number,
  ) {}
  /** The count within the window after this hit, when this hit crosses the threshold; else null. */
  hit(now: number): number | null {
    const hits = this.#hits;
    while (hits.length > 0 && now - hits[0]! > this.windowMs) hits.shift();
    hits.push(now);
    if (hits.length > this.threshold + 1) hits.shift();
    if (hits.length > this.threshold && now - this.#firedAt > this.windowMs) {
      this.#firedAt = now;
      return hits.length;
    }
    return null;
  }
  idle(now: number): boolean {
    const newest = this.#hits.at(-1);
    return (newest === undefined || now - newest > this.windowMs) && now - this.#firedAt > this.windowMs;
  }
}

/** One SlidingWindow per key, at most `maxKeys`: idle keys go first, then the oldest. */
export class KeyedWindows {
  readonly #windows = new Map<string, SlidingWindow>();
  constructor(
    readonly threshold: number,
    readonly windowMs: number,
    readonly maxKeys = 2048,
  ) {}
  get size(): number {
    return this.#windows.size;
  }
  hit(key: string, now: number): number | null {
    let window = this.#windows.get(key);
    if (window === undefined) {
      if (this.#windows.size >= this.maxKeys) {
        for (const [name, candidate] of this.#windows) if (candidate.idle(now)) this.#windows.delete(name);
        if (this.#windows.size >= this.maxKeys) this.#windows.delete(this.#windows.keys().next().value as string);
      }
      window = new SlidingWindow(this.threshold, this.windowMs);
      this.#windows.set(key, window);
    }
    return window.hit(now);
  }
}
