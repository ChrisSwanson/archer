import { afterEach, expect, test, vi } from "vitest";
import { ReadDeadlineError, withReadDeadline } from "../src/app/read-deadline";
afterEach(() => {
  vi.useRealTimers();
});

test("a read that ignores abort cannot keep the catalog in flight forever", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const pending = withReadDeadline((current) => {
    signal = current;
    return new Promise<never>(() => {});
  });
  let failure: unknown;
  void pending.catch((error) => {
    failure = error;
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(failure).toBeInstanceOf(ReadDeadlineError);
  expect(signal?.aborted).toBe(true);
});

test("the same deadline covers response body parsing and releases its timer on success", async () => {
  vi.useFakeTimers();
  const body = withReadDeadline(async () => {
    const response = { json: () => new Promise<never>(() => {}) };
    return response.json();
  });
  const refused = expect(body).rejects.toBeInstanceOf(ReadDeadlineError);
  await vi.advanceTimersByTimeAsync(10_000);
  await refused;
  expect(await withReadDeadline(async () => ({ complete: true }))).toEqual({ complete: true });
  expect(vi.getTimerCount()).toBe(0);
});
