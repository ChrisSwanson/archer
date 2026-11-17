/**
 * Publishes the person's selection to the service the way presence is published elsewhere: as live state,
 * not one request per change. One POST per change would race (arrowing through 50 boxes sends 50, and a
 * later answer could land first and leave the service holding an older selection).
 *
 * - Throttled: the first change after a quiet moment is sent at once (leading edge: one click reaches the
 *   agent immediately); further changes within `intervalMs` are held and the last of them is sent when the
 *   window closes (trailing edge), so an agent sees where the person stopped within `intervalMs`.
 * - A selection in another view or at another revision is a change of context, not a keystroke: it goes at
 *   once, ending any window.
 * - Serialized: one request in flight; a change made meanwhile is sent when it answers, so the service
 *   receives selections in the order the person made them.
 * - Not deduplicated: the page re-publishes an unchanged selection on purpose (a redraw at a new revision,
 *   a reconnect to a service that restarted and lost it), so every publication is sent, only coalesced.
 * - `flush()` sends what is pending at once (the page is hidden, or the connection is closing).
 */
export interface SelectionSender {
  /** `context` names what the selection is in (view and revision): a change of it is sent at once. */
  update(selection: unknown, context?: string): void;
  flush(): void;
  dispose(): void;
}

export interface SelectionSenderOptions {
  readonly intervalMs?: number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

/** How long a change waits for the next one before it is sent: under what a person or an agent notices. */
export const SELECTION_SEND_INTERVAL_MS = 150;

export function createSelectionSender(
  send: (body: string) => Promise<void>,
  options: SelectionSenderOptions = {},
): SelectionSender {
  const intervalMs = options.intervalMs ?? SELECTION_SEND_INTERVAL_MS;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let pending: string | undefined;
  let lastContext: string | undefined;
  let timer: unknown;
  let inFlight = false;
  let disposed = false;

  const sendPending = (): void => {
    if (disposed || inFlight || pending === undefined) return;
    const body = pending;
    pending = undefined;
    inFlight = true;
    void send(body)
      .catch(() => {
        // Not sent (offline, refused): the next publication or flush sends the selection then current.
      })
      .finally(() => {
        inFlight = false;
        // A change made while this was out goes now, in order; the throttle already held it back.
        sendPending();
      });
  };

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
    sendPending();
  };

  return {
    update(selection: unknown, context?: string): void {
      if (disposed) return;
      pending = JSON.stringify(selection);
      // A selection on another view or revision is a new context, not a keystroke: it goes at once.
      if (context !== lastContext) {
        lastContext = context;
        if (timer !== undefined) {
          clearTimer(timer);
          timer = undefined;
        }
      }
      if (timer !== undefined) return; // inside a window: the trailing send takes the latest
      sendPending(); // leading edge
      const window = (): void => {
        timer = setTimer(() => {
          timer = undefined;
          if (pending === undefined) return; // quiet: the next change goes at once
          sendPending(); // trailing edge, and the window stays open for a steady stream
          window();
        }, intervalMs);
      };
      window();
    },
    flush,
    dispose(): void {
      flush();
      disposed = true;
    },
  };
}
