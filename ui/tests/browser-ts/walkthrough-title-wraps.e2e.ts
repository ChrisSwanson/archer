/**
 * The walkthrough chooser shows a long title whole (rendered review polish, 2026-11-13): "A Request Is Not a Pro…"
 * was cut to one line with an ellipsis. It wraps to a second line instead.
 */
import { expect, test } from "@playwright/test";
import { containersWalkthroughs, walkthroughFiles } from "../support/walkthrough-project";
import { sharedTsProject } from "./support/shared-service";

// Six words, the most a walkthrough title may have (`ts/src/walkthroughs/contract.ts`).
const LONG = "Requesting Coffee Never Promises Any Delivery";

test("at 1440x900 a long walkthrough title wraps in the chooser rather than being cut", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await sharedTsProject({
    files: walkthroughFiles({
      ".archer/containers.walkthroughs.json": containersWalkthroughs().replace(
        '"Checkout and payment"',
        JSON.stringify(LONG),
      ),
    }),
  });
  try {
    await server.present("containers");
    await page.goto(server.url);
    await expect(page.locator(".react-flow__node[data-id='api']")).toBeVisible();
    await page.getByRole("button", { name: /^Walkthroughs · 4/ }).click();
    await page
      .getByRole("group", { name: "Walkthroughs on this diagram" })
      .getByRole("button", { name: new RegExp(LONG) })
      .click();
    const title = page.getByRole("region", { name: "Walkthrough", exact: true }).locator(".archer-walk-pick-title");
    await expect(title).toHaveText(LONG);
    const shown = await title.evaluate((el) => ({
      cut: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
      // Two lines at most: each about 1.2 font sizes tall.
      lines: el.getBoundingClientRect().height / (1.2 * Number.parseFloat(getComputedStyle(el).fontSize)),
    }));
    expect(shown.cut, "the title is cut").toBe(false);
    expect(shown.lines).toBeLessThan(2.5);
  } finally {
    await server.stop();
  }
});
