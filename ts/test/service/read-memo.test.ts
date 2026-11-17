// ReadMemo (project-state/memo.ts) on its own: a held read answers until forgotten; past READ_MEMO_MS
// the request gets the held value and the read is made again in a later turn, one key per turn; a
// forget warms the common reads after READ_WARM_DELAY_MS, once per burst, never while not ready or closed.
import { afterEach, expect, test, vi } from "vitest";
import { READ_MEMO_MS, READ_WARM_DELAY_MS, ReadMemo } from "../../src/service/project-state/memo.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const turn = () => new Promise<void>((done) => setImmediate(done));
const settle = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function memo(over: { parts?: () => (() => unknown)[]; ready?: () => boolean; failed?: (f: unknown) => void } = {}) {
  return new ReadMemo({
    warmParts: over.parts ?? (() => []),
    ready: over.ready ?? (() => true),
    warmFailed: over.failed ?? (() => {}),
  });
}

test("a held read answers until forgotten, then is read again", () => {
  const m = memo();
  let reads = 0;
  const read = () => ++reads;
  expect(m.get("k", read)).toBe(1);
  expect(m.get("k", read)).toBe(1);
  m.forget();
  expect(m.get("k", read)).toBe(2);
  m.close();
});

test("an expired read answers with the held value and is made again off the request path, one key per turn", async () => {
  const m = memo();
  const counts = { a: 0, b: 0 };
  m.get("a", () => ++counts.a);
  m.get("b", () => ++counts.b);
  const realNow = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => realNow() + READ_MEMO_MS + 1);
  expect(m.get("a", () => ++counts.a)).toBe(1);
  expect(m.get("b", () => ++counts.b)).toBe(1);
  expect(counts).toEqual({ a: 1, b: 1 });
  await turn();
  expect(counts).toEqual({ a: 2, b: 1 });
  await turn();
  expect(counts).toEqual({ a: 2, b: 2 });
  vi.restoreAllMocks();
  m.close();
});

test("a revalidation that throws drops the key: the next request reads it itself", async () => {
  const m = memo();
  let fail = false,
    reads = 0;
  const read = () => {
    reads++;
    if (fail) throw new Error("gone");
    return reads;
  };
  m.get("k", read);
  const realNow = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => realNow() + READ_MEMO_MS + 1);
  fail = true;
  expect(m.get("k", read)).toBe(1);
  await turn();
  vi.restoreAllMocks();
  fail = false;
  expect(m.get("k", read)).toBe(3);
  m.close();
});

test("a burst of forgets warms the common reads once, after the delay; not while not ready, not once closed", async () => {
  let ready = false,
    warmed = 0;
  const failures: unknown[] = [];
  const m = memo({
    parts: () => [() => warmed++, () => warmed++],
    ready: () => ready,
    failed: (f) => failures.push(f),
  });
  m.forget();
  await settle(READ_WARM_DELAY_MS * 3);
  expect(warmed).toBe(0);
  ready = true;
  m.forget();
  m.forget();
  m.forget();
  await settle(READ_WARM_DELAY_MS * 3);
  expect(warmed).toBe(2);
  m.warm();
  expect(warmed).toBe(4);
  m.forget();
  m.close();
  await settle(READ_WARM_DELAY_MS * 3);
  expect(warmed).toBe(4);
  expect(failures).toEqual([]);
});

test("a warm read that fails is reported and stops the warm", async () => {
  const failures: unknown[] = [];
  let after = 0;
  const m = memo({
    parts: () => [
      () => {
        throw new Error("unreadable");
      },
      () => after++,
    ],
    failed: (f) => failures.push(f),
  });
  m.forget();
  await settle(READ_WARM_DELAY_MS * 3);
  expect(failures).toHaveLength(1);
  expect(after).toBe(0);
  m.close();
});
