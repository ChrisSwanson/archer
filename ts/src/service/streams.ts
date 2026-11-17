// How many live event streams (`GET api/events`) the service serves at once,
// across every project: Rust's MAX_EVENT_STREAMS. A page holds one while it
// is open; the next is answered 503 too_many_connections.
export const MAX_EVENT_STREAMS = 32;
/** How many of them one access link may hold, so one link holder cannot lock every other page out. */
export const MAX_EVENT_STREAMS_PER_GRANT = 8;

export class StreamCap {
  #open = 0;
  constructor(readonly limit = MAX_EVENT_STREAMS) {}

  get open(): number {
    return this.#open;
  }

  /** A release function, or null when the cap is reached. Releasing twice gives back one permit. */
  acquire(): (() => void) | null {
    if (this.#open >= this.limit) return null;
    this.#open++;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.#open--;
    };
  }
}
