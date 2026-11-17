import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

test("graph tools replace Clear selection and dismiss without losing focus", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "drawing"\nkind = "freeform"\ntitle = "Drawing"\nsource = ".archer/drawing.mmd"\n',
      ".archer/drawing.mmd": "flowchart LR\na[Client] e1@--> b[Server]\n",
    },
  });
  try {
    await page.goto(project.url);
    await project.present("drawing");
    const trigger = page.getByRole("button", { name: "Export, compare and more" });
    await expect(trigger).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear selection" })).toHaveCount(0);

    await trigger.click();
    const menu = page.getByRole("group", { name: "Export, compare and more" });
    await expect(menu).toBeVisible();
    // A disclosure: focus stays on its button; Tab goes on into the actions.
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Tab");
    await expect(menu.getByRole("button", { name: "Compare revisions" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    const select = page.getByRole("button", { name: "Select mode" });
    await select.click();
    await expect(menu).toHaveCount(0);
    await expect(select).toBeFocused();

    for (const [action, heading] of [
      ["Compare revisions", "Compare Revisions"],
      ["Export diagram", "Export Diagram"],
      ["Check diagram accuracy", "Diagram Accuracy"],
    ] as const) {
      await trigger.click();
      await menu.getByRole("button", { name: action }).click();
      await expect(menu).toHaveCount(0);
      const panel = page.getByRole("heading", { name: heading }).locator("xpath=ancestor::section[1]");
      await expect(panel).toBeVisible();
      await panel.getByRole("button", { name: "Close" }).click();
      await expect(panel).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  } finally {
    await project.stop();
  }
});

// While a diagram is laid out the page's own toolbar wears the launcher (O186); the drawing's arrival swaps that
// toolbar for the canvas' cluster. A menu opened in the first must still be open, its button focused, in the second:
// the swap closed it and dropped focus to the page, so a press during a slow load opened nothing (O242).
test("a tools menu opened while the drawing loads stays open and focused when the drawing comes (O242)", async ({
  page,
}) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "drawing"\nkind = "freeform"\ntitle = "Drawing"\nsource = ".archer/drawing.mmd"\n',
      ".archer/drawing.mmd": "flowchart LR\na[Client] e1@--> b[Server]\n",
    },
  });
  try {
    // Hold the layout worker, so the drawing stays loading until the menu is open.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/elk-layout-worker-[^/]*\.js$/, async (route) => {
      await held;
      await route.continue();
    });
    await project.present("drawing");
    await page.goto(project.url);
    await expect(page.getByText("Loading...", { exact: true })).toBeVisible();
    const trigger = page.getByRole("button", { name: "Export, compare and more" });
    await trigger.click();
    const menu = page.getByRole("group", { name: "Export, compare and more" });
    await expect(menu).toBeVisible();
    await expect(trigger).toBeFocused();

    release();
    await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
    await expect(page.getByText("Loading...", { exact: true })).toHaveCount(0);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(menu.getByRole("button", { name: "Compare revisions" })).toBeVisible();
    await expect(trigger).toBeFocused();
  } finally {
    await project.stop();
  }
});
