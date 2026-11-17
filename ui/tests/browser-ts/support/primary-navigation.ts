import { expect, type Locator, type Page } from "@playwright/test";

/**
 * A project's files are its project browser's Folders tree (projects-and-search.md),
 * opened from the sidebar's Archer button. Going there is a navigation of its own.
 * Every folder of the tree starts open, so every file is in sight.
 */
export async function files(page: Page): Promise<Locator> {
  const documents = page.getByRole("region", { name: "Project documents", exact: true });
  if (!(await documents.isVisible())) {
    const archer = page.getByRole("button", { name: "Archer contents", exact: true });
    // At phone width the sidebar is a drawer behind the bar's menu button.
    if (!(await archer.isVisible())) await page.getByRole("button", { name: "Menu", exact: true }).click();
    await archer.click();
    await expect(page.getByRole("region", { name: "Project files", exact: true })).toBeVisible();
  }
  await expect(documents).toBeVisible();
  return documents;
}
/** A file's open control: its title in the Folders tree. */
export async function fileButton(page: Page, options: { name?: string | RegExp; id?: string }): Promise<Locator> {
  const documents = await files(page);
  return options.id === undefined
    ? documents
        .locator("[data-browser-row]")
        .getByRole("button", { name: options.name, exact: typeof options.name === "string" })
    : documents.locator(
        `[data-browser-row][data-target=${JSON.stringify(`view:${options.id}`)}] .archer-folder-tree-open`,
      );
}
export async function openFile(page: Page, options: { name?: string | RegExp; id?: string }): Promise<void> {
  await (await fileButton(page, options)).click();
  await expect(page.getByRole("region", { name: "Project documents", exact: true })).toBeHidden();
}
/** The file on screen, as the sidebar's Recent marks it. */
export async function expectCurrentFile(page: Page, options: { name?: string | RegExp }): Promise<void> {
  const recent = page.getByRole("navigation", { name: "Recent" });
  if (!(await recent.isVisible())) {
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    if (await menu.isVisible()) await menu.click();
    else await page.getByRole("button", { name: "Archer contents", exact: true }).hover();
  }
  await expect(recent).toBeVisible();
  await expect(recent.locator('[aria-current="page"]')).toHaveCount(1);
  if (options.name !== undefined)
    await expect(recent.locator('[aria-current="page"] .primary-place-name')).toHaveText(options.name);
  await page.getByRole("button", { name: "Archer contents", exact: true }).focus();
  await page.keyboard.press("Escape");
}
export async function expectFileCount(page: Page, count: number): Promise<void> {
  await expect((await files(page)).locator('[data-browser-row][data-kind="diagram"]')).toHaveCount(count);
}

export const graphToolsTrigger = (page: Page): Locator =>
  page.locator(".archer-canvas-tools-trigger").filter({ visible: true });

export async function openGraphTool(page: Page, name: string): Promise<void> {
  const trigger = graphToolsTrigger(page);
  await expect(trigger).toBeVisible();
  await trigger.click();
  const tools = page.getByRole("group", { name: "Export, compare and more", exact: true });
  await expect(tools).toBeVisible();
  await tools.getByRole("button", { name, exact: true }).click();
}
