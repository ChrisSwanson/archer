// The page's own retries of an unanswered comment write, on the real clock (O67, O100). The suites that send
// through the review controls and the chat (comment-operation-owner, comments-operations, chat-send) step these
// delays on a fake clock (support/retry-clock.ts) against OPERATION_RETRY_DELAYS_MS; this holds what that constant
// is, and that `settle`, the one path both surfaces send through, waits it out in real time.
import { expect, it } from "vitest";
import { OPERATION_RETRY_DELAYS_MS, settle } from "../src/comments/operations";
import { UncertainWriteError } from "../src/comments/transport";

it("the default cadence: a try at once, again after 250 ms, again after 1 s more, then uncertain", async () => {
  expect(OPERATION_RETRY_DELAYS_MS).toEqual([250, 1000]);
  const at: number[] = [];
  const operation = { id: "a".repeat(32) };
  const seen: string[] = [];
  const outcome = await settle(operation, async (sent) => {
    at.push(performance.now());
    seen.push(sent.id);
    throw new UncertainWriteError("Failed to fetch");
  });
  expect(outcome.kind).toBe("uncertain");
  expect(seen).toEqual([operation.id, operation.id, operation.id]);
  // A Node timer can fire up to a millisecond early (it keeps whole milliseconds). Late is load, not cadence: no bound.
  expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(250 - 1);
  expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(1000 - 1);
});
