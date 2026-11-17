// An ordinary access link (no authoring roots): any admitted link may edit (decided 2026-10-28), so Edit opens the
// editor in place and New opens its menu, exactly as with the editing link; Source and ?source work too.
// The harness issues the link itself (ui.readerContext); READER_LINK overrides it.
export const meta = { name: "smoke-c-reader-only", invariants: { "http-errors": false } };
export default async ({ step, expect, sandbox, ui }) => {
  const O = sandbox.origin.replace(/\/$/, "");
  const { page, context } = await step(
    "open a reader context",
    () => ui.readerContext(process.env.READER_LINK ? { link: process.env.READER_LINK } : {}),
    { leavesEditor: true },
  );
  try {
    await step("reading page: Source yes, Edit opens the editor in place", async () => {
      await page.goto(`${O}/projects/journeys/diagrams/flow.mmd`);
      await expect(page.getByRole("button", { name: "Source", exact: true })).toBeVisible();
      await page.locator(".archer-diagram-edit").getByRole("button", { name: "Edit", exact: true }).click();
      await expect(page.getByRole("region", { name: "Diagram Editor" })).toBeVisible();
      await expect(page.getByRole("dialog", { name: /^Editing (needs|is turned off)/ })).toHaveCount(0);
      await page.getByRole("banner").getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("region", { name: "Diagram Editor" })).toHaveCount(0);
    });
    await step("project page: New opens its menu", async () => {
      await page.goto(`${O}/projects/journeys/`);
      await expect(page.getByRole("tablist")).toBeVisible();
      await page.getByRole("button", { name: "New", exact: true }).click();
      await expect(
        page.getByRole("menu", { name: "New" }).getByRole("menuitem", { name: "Diagram", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
    });
    await step("?source works for a reader", async () => {
      await page.goto(`${O}/projects/journeys/diagrams/flow.mmd?source`);
      await expect(
        page.locator("section.archer-source-panel").locator("pre.archer-source-panel-code, .cm-content").first(),
      ).toContainText("flowchart");
    });
  } finally {
    await context.close();
  }
};
