/// <reference lib="dom" />

import { createRequire } from "node:module";
import { expect, it, vi } from "vitest";
import { warmPlayground } from "../../../site/.vitepress/theme/warm-playground.mts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const LIST = {
  files: ["index.html", "assets/playground-a.js", "page-assets/elk-layout-worker-b.js", "data/shared-c.json"],
};

async function fixture(connection?: { saveData?: boolean; effectiveType?: string }) {
  const dom = new JSDOM("<head></head>", { url: "https://example.test/archer/install" });
  if (dom.window.document.readyState !== "complete")
    await new Promise((done) => dom.window.addEventListener("load", done, { once: true }));
  const win = dom.window as unknown as Window & typeof globalThis;
  if (connection) Object.defineProperty(win.navigator, "connection", { value: connection });
  let idle: (() => void) | undefined;
  (win as unknown as { requestIdleCallback: (fn: () => void) => void }).requestIdleCallback = (fn) => (idle = fn);
  const fetch = vi.fn(async () => ({ ok: true, json: async () => LIST }));
  const links = () =>
    Array.from(win.document.head.querySelectorAll<HTMLLinkElement>('link[rel="prefetch"]'), (link) =>
      link.getAttribute("href"),
    );
  return {
    win,
    fetch,
    links,
    idle: async () => {
      idle?.();
      await new Promise((done) => setTimeout(done, 0));
    },
  };
}

it("prefetches the Playground's first-view files once the page is idle, once per session", async () => {
  const { win, fetch, links, idle } = await fixture();
  const started = warmPlayground(win, "/archer/", fetch);
  // Nothing before the page is idle.
  expect(fetch).not.toHaveBeenCalled();
  await idle();
  await started;
  expect(fetch).toHaveBeenCalledWith("/archer/playground/app/warm.json");
  expect(links()).toEqual([
    "/archer/playground/app/index.html",
    "/archer/playground/app/assets/playground-a.js",
    "/archer/playground/app/page-assets/elk-layout-worker-b.js",
    "/archer/playground/app/data/shared-c.json",
  ]);
  // A second page of the same visit (a client-side route change, or a new load in the same tab) does not repeat it.
  await warmPlayground(win, "/archer/", fetch);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(links()).toHaveLength(4);
});

for (const connection of [{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }])
  it(`skips the warm-up under ${JSON.stringify(connection)}`, async () => {
    const { win, fetch, links, idle } = await fixture(connection);
    const started = warmPlayground(win, "/archer/", fetch);
    await idle();
    await started;
    expect(fetch).not.toHaveBeenCalled();
    expect(links()).toEqual([]);
  });

it("ignores a list it cannot read, and names nothing outside the Playground", async () => {
  const { win, links, idle } = await fixture();
  const bad = vi.fn(async () => ({
    ok: true,
    json: async () => ({ files: ["../../evil.js", "https://x.test/a.js", "ok.js", 3] }),
  }));
  const started = warmPlayground(win, "/archer/", bad);
  await idle();
  await started;
  expect(links()).toEqual(["/archer/playground/app/ok.js"]);
});
