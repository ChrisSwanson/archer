import { chromium, expect, test, type Locator } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

async function box(locator: Locator): Promise<Box> {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

test("the Folders, Diagrams and Notes tabs keep the search header in the same place on desktop and phone", async () => {
  const server = await sharedTsProject({
    files: {
      ".archer/pipeline.mmd": "flowchart LR\n parser[Parser] step@--> model[Model]\n",
      ".archer/notes/operations.md": "# Operations\n\nHow the compiler is operated.\n",
    },
  });
  const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
  try {
    const page = await browser.newPage();
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(server.url); // Nothing presented: the follow page is the all-projects overview.
      const bar = page.locator(".archer-search-bar");
      const summaryLine = page.locator(".archer-search-summary-line");
      const tabs = page.getByRole("tablist", { name: "Project content" });
      // The tabs replace the Cards/Table toggle.
      await expect(page.locator("button.archer-browser-view")).toHaveCount(0);
      await expect(tabs.getByRole("tab", { name: /^Folders/ })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("treegrid", { name: "Project files" })).toBeVisible();
      const measure = async () => ({
        bar: await box(bar),
        search: await box(bar.locator(".archer-browser-search-field")),
        actions: await box(bar.getByRole("button", { name: /^Filters(?: \(\d+\))?$/ })),
        summary: await box(summaryLine),
        tabs: await box(tabs),
      });
      // A legacy follow page opens on its overview; the first tab choice makes it the search page
      // (its header names the search), so the comparison starts from Folders chosen as a tab.
      await tabs.getByRole("tab", { name: /^Notes/ }).click();
      await tabs.getByRole("tab", { name: /^Folders/ }).click();
      await expect(page.getByRole("treegrid", { name: "Project files" })).toBeVisible();
      const folders = await measure();
      await expect(bar.getByRole("button", { name: /^(?:Card Details|Table Columns)$/ })).toHaveCount(0);
      await expect(page.getByRole("combobox", { name: "Sort by", exact: true })).toHaveCount(0);
      await bar.getByRole("button", { name: "Filters", exact: true }).click();
      await expect(
        page.getByRole("dialog", { name: "Project Filters" }).getByRole("combobox", { name: "Sort by", exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Close filters", exact: true }).click();

      for (const name of ["Diagrams", "Notes"]) {
        await tabs.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
        await expect(tabs.getByRole("tab", { name: new RegExp(`^${name}`) })).toHaveAttribute("aria-selected", "true");
        await expect(page).toHaveURL(new RegExp(`[?&]tab=${name.toLowerCase()}`));
        expect(await measure()).toEqual(folders);
      }
      await tabs.getByRole("tab", { name: /^Notes/ }).press("ArrowRight");
      await expect(tabs.getByRole("tab", { name: /^Folders/ })).toBeFocused();
      await expect(tabs.getByRole("tab", { name: /^Folders/ })).toHaveAttribute("aria-selected", "true");
    }
  } finally {
    await browser.close();
    await server.stop();
  }
});
