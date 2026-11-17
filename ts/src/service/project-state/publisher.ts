// A project state's publications (ProjectState's, moved here whole): its listeners, the service-wide
// publication count each event takes, the events a transaction holds until it commits, and the comment
// targets one page write gathers to announce once (`announcingOnce`).
import type { TargetRef } from "../../comments/contract.ts";

/** Publications across every project state in this process (`ProjectState.eventSeq`). */
let publications = 0;

export type PublisherListener<E extends string> = (event: E, payload: unknown) => void;

export class Publisher<E extends string> {
  readonly #listeners = new Set<PublisherListener<E>>();
  #queued: { event: E; payload: unknown }[] | null = null;
  /** The comment targets a page write changed while `gathering` runs: each is announced once, at its end. */
  #gathered: Set<TargetRef> | null = null;
  /**
   * Where this project's publications are in the service's count: reads are answered at it, streams
   * start from it (`standing`). One count for every project state in the process, and a new state
   * (a project attached again) takes a fresh number, so a stream on it is never taken for older than
   * a read of the state it replaced.
   */
  #seq = ++publications;
  readonly #log: (line: string) => void;

  constructor(log: (line: string) => void) {
    this.#log = log;
  }

  get seq(): number {
    return this.#seq;
  }

  subscribe(listener: PublisherListener<E>): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Whether `listener` is still subscribed. */
  has(listener: PublisherListener<E>): boolean {
    return this.#listeners.has(listener);
  }

  /** Tells every listener now, or, while a transaction queues, when it commits. A listener's failure is the publisher's caller's. */
  publish(event: E, payload: unknown): void {
    if (this.#queued !== null) {
      this.#queued.push({ event, payload });
      return;
    }
    this.#seq = ++publications;
    for (const listener of this.#listeners) listener(event, payload);
  }

  /** Whether a transaction is holding publications. */
  get queuing(): boolean {
    return this.#queued !== null;
  }

  /** Holds every publication from now until `flush` or `discard`. */
  queue(): void {
    this.#queued = [];
  }

  /** Stops holding and tells every listener what was held, in order, each with its own count; a listener's failure is logged. */
  flush(): void {
    const events = this.#queued ?? [];
    this.#queued = null;
    for (const { event, payload } of events) {
      this.#seq = ++publications;
      for (const listener of this.#listeners) {
        try {
          listener(event, payload);
        } catch (e) {
          this.#log(`[archer] state publication failed: ${String(e)}`);
        }
      }
    }
  }

  /** Stops holding and drops what was held: the transaction did not commit. */
  discard(): void {
    this.#queued = null;
  }

  /** Adds `target` to the page write being gathered, if one is: true when it was gathered (not to announce now). */
  gather(target: TargetRef): boolean {
    if (this.#gathered === null) return false;
    this.#gathered.add(target);
    return true;
  }

  /**
   * Runs `run`, gathering the comment targets it changes, then hands them to `announce` (also when `run` throws).
   * Inside another gathering it just runs: the outer one announces.
   */
  gathering<T>(run: () => T, announce: (targets: ReadonlySet<TargetRef>) => void): T {
    if (this.#gathered !== null) return run();
    const gathered = (this.#gathered = new Set<TargetRef>());
    try {
      return run();
    } finally {
      this.#gathered = null;
      announce(gathered);
    }
  }

  /** Forgets every listener. */
  close(): void {
    this.#listeners.clear();
  }
}
