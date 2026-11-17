/**
 * The page's own retries of an unanswered comment write (`settle` in src/comments/operations.ts), stepped on a fake
 * clock instead of waited out: OPERATION_RETRY_DELAYS_MS is 1.25 s of real time per uncertain write, and these
 * suites make dozens.
 *
 * Only `setTimeout`/`clearTimeout` are faked, and only while one write runs: `Date`, React's scheduler (setImmediate)
 * and Testing Library's polling stay real. Each retry delay is stepped one millisecond short, then the last
 * millisecond, so a try sent early or late, one too many or one too few, fails here. The real clock's cadence is
 * held once, in comment-retry-cadence.test.ts.
 */
import { expect, vi } from "vitest";
import { OPERATION_RETRY_DELAYS_MS } from "../../src/comments/operations";

/**
 * Runs `write` (one call of the page that sends a comment operation) with the retry clock under the test's control.
 * `tries()` counts the sends the transport received; `expected` is how many this write makes: 1 + the retries.
 * Resolves to what `write` resolved to, once every expected try was made exactly at its delay and no more were.
 */
export async function steppedRetries<T>(write: () => Promise<T>, tries: () => number, expected: number): Promise<T> {
  if (expected < 1 || expected > OPERATION_RETRY_DELAYS_MS.length + 1)
    throw new Error(`a write makes 1 to ${OPERATION_RETRY_DELAYS_MS.length + 1} tries, not ${expected}`);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const before = tries();
    let done = false;
    const running = write().finally(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(tries() - before, "the first try is sent at once").toBe(1);
    for (let n = 1; n < expected; n++) {
      const delay = OPERATION_RETRY_DELAYS_MS[n - 1]!;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(tries() - before, `try ${n + 1} waits its full ${delay} ms`).toBe(n);
      expect(done, `the write is still trying before try ${n + 1}`).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(tries() - before, `try ${n + 1} is sent at ${delay} ms`).toBe(n + 1);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(done, `the write ends after ${expected} tries, with no further wait`).toBe(true);
    expect(tries() - before, `${expected} tries in all`).toBe(expected);
    return await running;
  } finally {
    vi.useRealTimers();
  }
}
