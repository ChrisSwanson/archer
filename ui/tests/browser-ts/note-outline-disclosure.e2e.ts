/**
 * The note outline's disclosure and its section names (rendered review polish, 2026-11-13): the summary showed the
 * browser's own ▼ marker instead of the app's chevron, and long section names were cut with an ellipsis while the
 * gutter beside them had room.
 */
import { expect, test } from "@playwright/test";
import { files as projectPage } from "./support/primary-navigation";
import { sharedTsProject } from "./support/shared-service";

const LONG = "What does this request name, and what does it ask the pot to do";

test("the outline opens with the app's chevron and shows long section names whole", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const project = await sharedTsProject({
    files: {
      "archer.toml": "version = 1\n",
      ".archer/notes/topics.md": `# Topics\n\n## ${LONG}\n\n${"A passage.\n\n".repeat(30)}## Conclusion\n\nThe end.\n`,
    },
  });
  try {
    await page.goto(project.url);
    await (await projectPage(page)).getByRole("button", { name: "Topics", exact: true }).click();
    const reader = page.getByRole("article", { name: "Reading Topics" });
    const summary = reader.locator(".primary-note-outline summary");
    await expect(summary).toBeVisible();
    const marker = await summary.evaluate((el) => ({
      display: getComputedStyle(el).display,
      listStyle: getComputedStyle(el).listStyleType,
      chevron: el.querySelector("svg.primary-note-outline-chevron") !== null,
    }));
    expect(marker.display, "a list-item summary draws the browser's marker").not.toBe("list-item");
    expect(marker.chevron, "the app's disclosure chevron").toBe(true);
    const link = reader.getByRole("navigation", { name: "Table of contents" }).getByRole("link", { name: LONG });
    await expect(link).toBeVisible();
    const cut = await link.evaluate((el) => ({
      overflow: el.scrollWidth > el.clientWidth + 1,
      ellipsis: getComputedStyle(el).textOverflow === "ellipsis" && getComputedStyle(el).whiteSpace === "nowrap",
    }));
    expect(cut).toEqual({ overflow: false, ellipsis: false });
  } finally {
    await project.stop();
  }
});
