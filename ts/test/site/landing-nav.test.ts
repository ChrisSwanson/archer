/// <reference lib="dom" />

import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { NAV_STAGE_CLASS, navOnStage } from "../../../site/.vitepress/theme/landing-nav.mts";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

it("wears the stage's colour at the top of the landing and the page's own past 640px, and lets go when the page goes", () => {
  const dom = new JSDOM("<body></body>", { url: "https://example.test/archer/" });
  const win = dom.window as unknown as Window & typeof globalThis;
  const root = win.document.documentElement;
  const scroll = (y: number) => {
    Object.defineProperty(win, "scrollY", { value: y, configurable: true });
    win.dispatchEvent(new win.Event("scroll"));
  };
  scroll(0);
  const release = navOnStage(win);
  expect(root.classList.contains(NAV_STAGE_CLASS)).toBe(true);
  scroll(640);
  expect(root.classList.contains(NAV_STAGE_CLASS)).toBe(true);
  scroll(641);
  expect(root.classList.contains(NAV_STAGE_CLASS)).toBe(false);
  scroll(10);
  expect(root.classList.contains(NAV_STAGE_CLASS)).toBe(true);
  release();
  expect(root.classList.contains(NAV_STAGE_CLASS)).toBe(false);
  scroll(0);
  expect(root.classList.contains(NAV_STAGE_CLASS), "a docs page after the landing keeps its own nav").toBe(false);
});

it("starts in the page's own colours when it opens scrolled past the stage", () => {
  const dom = new JSDOM("<body></body>", { url: "https://example.test/archer/#install" });
  const win = dom.window as unknown as Window & typeof globalThis;
  Object.defineProperty(win, "scrollY", { value: 2400, configurable: true });
  const release = navOnStage(win);
  expect(win.document.documentElement.classList.contains(NAV_STAGE_CLASS)).toBe(false);
  release();
});
