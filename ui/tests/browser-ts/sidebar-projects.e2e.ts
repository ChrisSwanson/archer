import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

test("Projects is an open hierarchy when the desktop rail widens and in the phone drawer", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\nname = "Sidebar sample"\n[[views]]\nid = "pipeline"\nkind = "freeform"\ntitle = "Compile pipeline"\nsource = ".archer/pipeline.mmd"\n',
      ".archer/pipeline.mmd": "flowchart LR\nlexer[Lexer] e1@--> parser[Parser]\n",
      ".archer/notes/operations.md": "# Operations\n\nHow the compiler is operated.\n",
    },
  });
  try {
    await page.goto(project.url);
    const sidebar = page.locator(".primary-navigation");
    await page.getByRole("button", { name: "Archer contents", exact: true }).hover();

    await expect(sidebar).toHaveAttribute("data-expanded", "true");
    await expect(page.getByRole("heading", { name: "Projects", level: 2 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Overview", exact: true })).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: /Sidebar sample/ }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recent", level: 2 })).toBeVisible();
    // The retired sidebar "Projects" and "Tools" buttons stay gone; the breadcrumb's "Projects" link is not in the sidebar.
    await expect(sidebar.getByRole("button", { name: "Projects", exact: true })).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: "Tools", exact: true })).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await expect(sidebar).toHaveAttribute("data-drawer", "true");
    await expect(page.getByRole("heading", { name: "Projects", level: 2 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Overview", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Menu", exact: true })).toHaveAttribute("aria-expanded", "false");
  } finally {
    await project.stop();
  }
});
