import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

test("one launcher opens a responsive, focus-contained Filters dialog", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      ".archer/flow.mmd": "flowchart LR\n a[Reader] route@--> b[Result]\n",
      ".archer/notes/guide.md": "# Guide\n",
    },
  });
  try {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(project.url); // Nothing presented: the follow page is the all-projects overview.
      const searchBar = page.locator(".archer-search-bar");
      const launcher = searchBar.getByRole("button", { name: "Filters", exact: true });
      await expect(launcher).toHaveCount(1);
      await expect(searchBar.getByRole("button", { name: /^(?:Card Details|Table Columns)$/ })).toHaveCount(0);

      await launcher.click();
      const dialog = page.getByRole("dialog", { name: "Project Filters" });
      // Filters are the dialog's only content: the Card Details and Table Columns panels went with the cards and tables.
      await expect(dialog.getByRole("navigation", { name: "Browse settings sections" })).toHaveCount(0);
      await expect(dialog.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
      await expect(dialog.locator("details")).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Close filters" })).toBeFocused();

      const last = dialog
        .locator(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
        )
        .last();
      await last.focus();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "Close filters" })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(last).toBeFocused();
      await dialog.getByRole("button", { name: "Close filters" }).click();
      await expect(launcher).toBeFocused();

      await launcher.click();
      await expect(dialog.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Close filters" }).click();
    }
  } finally {
    await project.stop();
  }
});
