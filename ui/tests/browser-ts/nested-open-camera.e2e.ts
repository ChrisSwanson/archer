/**
 * Opening a frame brings it into view (second rendered review, 2026-11-13, F): at 1440x900 Where Archer Runs and
 * Archer Containers opened with the frame cut at the canvas's left edge and its left under the tool rail, because the
 * camera kept the pressed box where it was whatever the frame grew to.
 */
import { expect, test } from "@playwright/test";
import { startTsProject, type TsProject } from "../support/ts-service";
import { archerTourFiles } from "../support/archer-tour";
import { testPage } from "./support/page-path";
import { settled } from "./support/settled";

let server: TsProject;
test.beforeAll(async () => {
  server = await startTsProject({ pagePath: testPage(), files: archerTourFiles(), nestedView: true });
});
test.afterAll(async () => {
  await server?.stop();
});

for (const [view, frame, name] of [
  ["deployment", "agent_host", "Agent's Computer"],
  ["containers", "archer", "Archer"],
] as const) {
  test(`at 1440x900 opening ${name} in ${view} shows the whole frame, clear of the tool rail`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    try {
      const page = await context.newPage();
      await server.present(view);
      await page.goto(server.url);
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      await settled(page);
      await page.getByRole("button", { name: `Open ${name}` }).click();
      await expect(page.getByRole("button", { name: `Close ${name}` })).toBeVisible();
      await expect(page.locator(".archer-nest-moving")).toHaveCount(0);
      await settled(page);
      const seen = await page.evaluate((id) => {
        const rect = (el: Element | null) => {
          const r = el!.getBoundingClientRect();
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        };
        return {
          canvas: rect(document.querySelector(".react-flow")),
          rail: rect(document.querySelector(".react-flow__controls")),
          frame: rect(document.querySelector(`.react-flow__node[data-id="${id}"]`)),
        };
      }, frame);
      expect(seen.frame.left, "the frame's left edge is on the canvas").toBeGreaterThanOrEqual(seen.canvas.left);
      expect(seen.frame.right).toBeLessThanOrEqual(seen.canvas.right);
      expect(seen.frame.top).toBeGreaterThanOrEqual(seen.canvas.top);
      expect(seen.frame.bottom).toBeLessThanOrEqual(seen.canvas.bottom);
      const underRail =
        seen.frame.left < seen.rail.right &&
        seen.rail.left < seen.frame.right &&
        seen.frame.top < seen.rail.bottom &&
        seen.rail.top < seen.frame.bottom;
      expect(underRail, "the frame is under the tool rail").toBe(false);
    } finally {
      await context.close();
    }
  });
}
