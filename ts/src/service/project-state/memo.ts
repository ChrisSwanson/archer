// A project state's memoized file reads (ProjectState's, moved here whole): the note list, document
// discovery, the catalog, every note. Kept until `forget` (a file event, a reload or a write), bounded
// by READ_MEMO_MS, made again off the request path when they expire, and warmed after a burst of drops.

/**
 * The longest a memoized file read is reused without a file event, a reload or a write through this state.
 * The watcher reports every change in the folder and the discovery roots (forgetReads), so this only bounds
 * what an unreported change (a directory past the watch budget) can hide; an expired read is made again in
 * the background, not by the request that finds it. At 5 s every page visit after a pause re-walked the
 * catalog: 42 % of the service's CPU, p95 175 ms on api/browser-projects.
 */
export const READ_MEMO_MS = 60_000;
/** After reads are dropped, the page's common reads are made again this long after the last drop. */
export const READ_WARM_DELAY_MS = 50;

export interface ReadMemoOptions {
  /** The page's common reads, asked for when a warm starts (so they read the settings of that moment). */
  readonly warmParts: () => (() => unknown)[];
  /** Whether a warm may read now: false while the state is still opening. */
  readonly ready: () => boolean;
  /** A warm read failed: the warm stops there. */
  readonly warmFailed: (failure: unknown) => void;
}

/**
 * Reads of the project's files that a page load repeats many times (the
 * note list, document discovery, the catalog, every note): kept until a
 * file event (the service's watcher calls forgetReads), a reload or a write
 * through this state. Past READ_MEMO_MS, which bounds what a change no
 * watcher reported can hide, a read is made again off the request path:
 * the request gets the held value, and each expired read it touched is made
 * again in a turn of its own (#revalidateNext), so no request waits for a
 * walk and requests run between them (O6: at scale M every expiry was one
 * ~300 ms stall, and a 304 waited for it).
 */
export class ReadMemo {
  readonly #memo = new Map<string, { readonly at: number; readonly value: unknown; readonly read: () => unknown }>();
  /** Expired keys a request touched, made again one per turn; never more than the memo's keys. */
  readonly #expired = new Set<string>();
  #revalidating = false;
  #closed = false;
  #warmTimer: NodeJS.Timeout | undefined;
  readonly #options: ReadMemoOptions;

  constructor(options: ReadMemoOptions) {
    this.#options = options;
  }

  get<T>(key: string, read: () => T): T {
    const now = performance.now(),
      kept = this.#memo.get(key);
    if (kept !== undefined && now - kept.at < READ_MEMO_MS) return kept.value as T;
    if (kept !== undefined && !this.#revalidating && !this.#closed) {
      if (this.#expired.size === 0) setImmediate(() => this.#revalidateNext()).unref();
      this.#expired.add(key);
      return kept.value as T;
    }
    const value = read();
    this.#memo.set(key, { at: now, value, read });
    return value;
  }

  /** Makes one expired read again (with any expired read inside it), then yields before the next. */
  #revalidateNext(): void {
    const [key] = this.#expired;
    if (key === undefined) return;
    this.#expired.delete(key);
    const kept = this.#memo.get(key);
    if (!this.#closed && kept !== undefined && performance.now() - kept.at >= READ_MEMO_MS) {
      this.#revalidating = true;
      try {
        this.get(key, kept.read);
      } catch {
        // Dropped: the next request makes the read itself and reports what failed.
        this.#memo.delete(key);
      } finally {
        this.#revalidating = false;
      }
    }
    if (this.#expired.size > 0) setImmediate(() => this.#revalidateNext()).unref();
  }

  /** Drops every memoized read: the files may have changed. The page's common reads are made again soon after. */
  forget(): void {
    this.#memo.clear();
    this.#expired.clear();
    this.#scheduleWarm();
  }

  /**
   * Re-reads the catalog, the notes and the inventory once a burst of drops has settled, in the
   * background, so the next page request finds them memoized instead of walking the files itself.
   * One read per turn of the event loop: at scale M the four together held it for ~250 ms.
   */
  #scheduleWarm(): void {
    if (this.#closed) return;
    if (this.#warmTimer !== undefined) clearTimeout(this.#warmTimer);
    this.#warmTimer = setTimeout(() => {
      this.#warmTimer = undefined;
      const reads = this.#options.warmParts();
      const next = (): void => {
        const read = reads.shift();
        // A later drop starts its own warm; this one stops rather than read twice.
        if (read === undefined || this.#closed || !this.#options.ready() || this.#warmTimer !== undefined) return;
        try {
          read();
        } catch (failure) {
          this.#options.warmFailed(failure);
          return;
        }
        setImmediate(next).unref();
      };
      next();
    }, READ_WARM_DELAY_MS);
    this.#warmTimer.unref?.();
  }

  /** Makes the page's common reads now, memoizing them. */
  warm(): void {
    for (const read of this.#options.warmParts()) read();
  }

  /** Stops warming and revalidating; held reads still answer. */
  close(): void {
    this.#closed = true;
    if (this.#warmTimer !== undefined) clearTimeout(this.#warmTimer);
  }
}
