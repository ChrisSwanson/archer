// @vitest-environment jsdom
import { expect, it } from "vitest";
import { saveBrowserPosition, restoreBrowserPosition } from "../src/app/browser-position";
it("restores the browser scroll and originating row focus from its history entry", () => {
  document.body.innerHTML =
    '<div class="archer-contents-panel"><article data-browser-row="project:note:guide"><button>Guide</button></article></div>';
  const panel = document.querySelector<HTMLElement>(".archer-contents-panel")!;
  panel.scrollTop = 284;
  document.querySelector<HTMLButtonElement>("button")!.focus();
  saveBrowserPosition();
  panel.scrollTop = 0;
  document.querySelector<HTMLButtonElement>("button")!.blur();
  expect(restoreBrowserPosition()).toBe(true);
  expect(panel.scrollTop).toBe(284);
  expect(document.querySelector("button")).toHaveFocus();
  document.body.innerHTML = "";
  window.history.replaceState(null, "");
});
