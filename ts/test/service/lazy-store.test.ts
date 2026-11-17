// lazyStore (service/lazy-store.ts): a store the service opens on first use, keeps, and whose failure to open
// it keeps too, so every later caller gets the same refusal rather than a second attempt.
import { describe, expect, test } from "vitest";
import { lazyStore } from "../../src/service/lazy-store.ts";

class Refusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

describe("lazyStore", () => {
  test("opens once, on first get, and peek never opens", () => {
    let opened = 0;
    const store = lazyStore(() => ({ n: ++opened }), {});
    expect(store.peek()).toBeUndefined();
    expect(opened).toBe(0);
    const first = store.get();
    expect(store.get()).toBe(first);
    expect(store.peek()).toBe(first);
    expect(opened).toBe(1);
  });

  test("a failure is sticky: the same mapped error every time, and no second open", () => {
    let attempts = 0;
    const raw = new Error("disk said no");
    const store = lazyStore<object>(
      () => {
        attempts++;
        throw raw;
      },
      { wrap: (failure) => (failure instanceof Refusal ? failure : new Refusal("store_unavailable")) },
    );
    let first: unknown;
    try {
      store.get();
    } catch (failure) {
      first = failure;
    }
    expect(first).toBeInstanceOf(Refusal);
    expect((first as Refusal).code).toBe("store_unavailable");
    expect(() => store.get()).toThrow(first as Error);
    expect(attempts).toBe(1);
    expect(store.peek()).toBeUndefined();
  });

  test("a failure that already has the store's type is kept as it is", () => {
    const own = new Refusal("invalid_store");
    const store = lazyStore<object>(
      () => {
        throw own;
      },
      { wrap: (failure) => (failure instanceof Refusal ? failure : new Refusal("store_unavailable")) },
    );
    expect(() => store.get()).toThrow(own);
  });

  test("without wrap the raw failure is the sticky one", () => {
    const raw = new Error("raw");
    let attempts = 0;
    const store = lazyStore<object>(() => {
      attempts++;
      throw raw;
    }, {});
    expect(() => store.get()).toThrow(raw);
    expect(() => store.get()).toThrow(raw);
    expect(attempts).toBe(1);
  });

  test("stopping refuses before the cached failure, and before the cached store", () => {
    let stopping = false;
    const assertOpen = (): void => {
      if (stopping) throw new Refusal("service_stopping");
    };
    const failing = lazyStore<object>(
      () => {
        throw new Error("no");
      },
      { assertOpen, wrap: () => new Refusal("store_unavailable") },
    );
    expect(() => failing.get()).toThrow(expect.objectContaining({ code: "store_unavailable" }));
    const working = lazyStore(() => ({}), { assertOpen });
    working.get();
    stopping = true;
    expect(() => failing.get()).toThrow(expect.objectContaining({ code: "service_stopping" }));
    expect(() => working.get()).toThrow(expect.objectContaining({ code: "service_stopping" }));
    // peek is no admission: it reports what is open, stopping or not.
    expect(working.peek()).toBeDefined();
  });

  test("stopping is read at each get, not when the store is made", () => {
    let stopping = true;
    let opened = 0;
    const store = lazyStore(() => ({ n: ++opened }), {
      assertOpen: () => {
        if (stopping) throw new Refusal("service_stopping");
      },
    });
    expect(() => store.get()).toThrow(expect.objectContaining({ code: "service_stopping" }));
    expect(opened).toBe(0);
    stopping = false;
    expect(store.get()).toEqual({ n: 1 });
  });
});
