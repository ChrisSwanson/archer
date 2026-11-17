/**
 * A tiny profile for the grow-in-place layout: named spans (milliseconds, summed) and work
 * counters (load-independent: grid points built, search nodes expanded, ...). Optional
 * everywhere: without one, the search runs uninstrumented; the few phase clocks (a handful of
 * `performance.now()` calls per press) remain.
 */
export type NestProfile = { readonly spans: Record<string, number>; readonly counts: Record<string, number> };

export function newProfile(): NestProfile {
  return { spans: {}, counts: {} };
}

/** Adds `n` to counter `name`. */
export function count(profile: NestProfile | undefined, name: string, n = 1): void {
  if (profile !== undefined) profile.counts[name] = (profile.counts[name] ?? 0) + n;
}

/** Runs `work`, adding its time to span `name`. */
export function span<T>(profile: NestProfile | undefined, name: string, work: () => T): T {
  if (profile === undefined) return work();
  const start = performance.now();
  try {
    return work();
  } finally {
    profile.spans[name] = (profile.spans[name] ?? 0) + performance.now() - start;
  }
}

/** `span` for async work. */
export async function spanAsync<T>(profile: NestProfile | undefined, name: string, work: () => Promise<T>): Promise<T> {
  if (profile === undefined) return work();
  const start = performance.now();
  try {
    return await work();
  } finally {
    profile.spans[name] = (profile.spans[name] ?? 0) + performance.now() - start;
  }
}
