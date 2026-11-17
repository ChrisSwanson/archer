// @vitest-environment jsdom
// The tab-ownership rule (draft-tabs.ts, O117): each open tab has its own owner id, settled before anything is
// restored. A duplicated tab (sessionStorage copied, so the opener's id with it) takes a new id; a reload keeps its id
// once its old page lets go of it; a fresh tab and a reopened closed tab are as before. No wait decides it.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { holdTab } from "./support/fake-locks";

// The fake lock manager lives for the whole file and a settled tab never lets go: each case its own id.
let n = 0;
const nextId = (): string => `fedc${(++n).toString(16).padStart(12, "0")}`;
let X = "";
beforeEach(() => {
  X = nextId();
});
type Tabs = typeof import("../src/comments/draft-tabs");
const fresh = async (): Promise<Tabs> => {
  vi.resetModules();
  return import("../src/comments/draft-tabs");
};
beforeEach(() => sessionStorage.clear());
afterEach(() => sessionStorage.clear());

it("a new tab takes a new id and holds it", async () => {
  const tabs = await fresh();
  const id = await tabs.tabReady();
  expect(id).toMatch(/^[0-9a-f]{16}$/);
  expect((await navigator.locks.query()).held?.some((l) => l.name === `archer.tab.v1:${id}`)).toBe(true);
  expect(sessionStorage.getItem("archer.tab-id.v1")).toBe(id);
});

it("a reopened closed tab (its id kept, nobody holding it) keeps its id", async () => {
  sessionStorage.setItem("archer.tab-id.v1", X);
  const tabs = await fresh();
  expect(await tabs.tabReady()).toBe(X);
});

it("a duplicated tab (the opener open and holding the id) takes a new id, without waiting on a clock", async () => {
  sessionStorage.setItem("archer.tab-id.v1", X);
  const close = holdTab(X);
  const opener = new BroadcastChannel("archer.tabs.v2");
  opener.onmessage = (e: MessageEvent<{ type: string; id: string }>) => {
    if (e.data?.type === "who-has" && e.data.id === X) opener.postMessage({ type: "have", id: X });
  };
  const tabs = await fresh();
  const started = Date.now();
  const id = await tabs.tabReady();
  expect(id).not.toBe(X);
  expect(Date.now() - started).toBeLessThan(1000);
  opener.close();
  await close();
});

it("a reload (the old page still letting go of the id, and answering nobody) keeps its id once it is free", async () => {
  sessionStorage.setItem("archer.tab-id.v1", X);
  const close = holdTab(X);
  const tabs = await fresh();
  const settled = tabs.tabReady();
  setTimeout(() => void close(), 50);
  expect(await settled).toBe(X);
});

it("open tabs are read from their locks, with no wait", async () => {
  const tabs = await fresh();
  await tabs.tabReady();
  const close = holdTab(X);
  expect((await tabs.liveTabs())!.has(X)).toBe(true);
  await close();
  expect((await tabs.liveTabs())!.has(X)).toBe(false);
});

it("a frame whose lock manager refuses every request (an opaque origin) still settles, as a browser without Web Locks (O175)", async () => {
  const real = navigator.locks;
  const refuse = (): Promise<never> => Promise.reject(new DOMException("opaque origin", "SecurityError"));
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: refuse, query: refuse } });
  try {
    for (const kept of [null, X]) {
      if (kept === null) sessionStorage.clear();
      else sessionStorage.setItem("archer.tab-id.v1", kept);
      const tabs = await fresh();
      const id = await Promise.race([
        tabs.tabReady(),
        new Promise<string>((_, no) => setTimeout(() => no(new Error("tabReady never settled")), 1000)),
      ]);
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      expect(await tabs.liveTabs()).toBeNull();
      expect(await tabs.withDraftsLock(() => "done")).toBe("done");
    }
  } finally {
    Object.defineProperty(navigator, "locks", { configurable: true, value: real });
  }
});
