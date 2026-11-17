import { basename } from "node:path";
import { expect, test } from "@playwright/test";
import { startTsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";

const files = {
  "archer.toml":
    'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/system.mmd"\n',
  ".archer/system.mmd": "flowchart LR\nweb[Web] e1@--> api[API]\n",
};

test("service settings trap and restore focus, and are read-only", async ({ page }) => {
  const project = await startTsProject({ files, pagePath: testPage() });
  try {
    await page.goto(project.url);
    const launcher = page.getByRole("button", { name: "Archer settings" });
    await expect(launcher).toBeVisible();
    await launcher.click();

    const dialog = page.getByRole("dialog", { name: "Archer Settings" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
    await expect(page.locator("#root")).toHaveAttribute("inert", "");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(launcher).toBeFocused();

    await launcher.click();
    await expect(dialog.getByRole("listitem", { name: "Comment submission" })).toContainText("Send each comment");
    await expect(dialog.getByRole("list", { name: "Service settings" })).toHaveAttribute("aria-disabled", "true");
    // A person can find the file; a link holder never reads the absolute path (S13). The test HOME is the state dir.
    await expect(dialog).toContainText(`~/${basename(project.configPath)}`);
    await expect(dialog).not.toContainText(project.configPath);
    await expect(dialog.getByRole("button", { name: "Save settings" })).toHaveCount(0);
    const refused = await page.evaluate(async () => {
      const current = (await fetch("/api/settings", { cache: "no-store" }).then((response) => response.json())) as {
        configRevision: string;
      };
      return (
        await fetch("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commentSubmission: "immediate", expectedRevision: current.configRevision }),
        })
      ).status;
    });
    expect(refused).toBe(403);
  } finally {
    await project.stop();
  }
});

for (const check of ["target", "focus"] as const) {
  test(`phone settings preserve ${check === "target" ? "a full-size close target" : "the drawer and launcher focus"}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const project = await startTsProject({ files, pagePath: testPage() });
    try {
      await page.goto(project.url);
      await page.getByRole("button", { name: "Menu", exact: true }).click();
      const launcher = page.getByRole("button", { name: "Archer settings" });
      await launcher.click();
      const dialog = page.getByRole("dialog", { name: "Archer Settings" });
      await expect(dialog).toBeVisible();
      const close = dialog.getByRole("button", { name: "Close settings" });
      if (check === "target") {
        const bounds = await close.boundingBox();
        expect(bounds!.width).toBeGreaterThanOrEqual(44);
        expect(bounds!.height).toBeGreaterThanOrEqual(44);
      } else {
        await close.click();
        await expect(dialog).toBeHidden();
        // The drawer itself stays open: a press inside the dialog it opened is not a press outside it.
        // Checking only the launcher passed while the drawer was still animating closed.
        await expect(page.getByRole("button", { name: "Menu", exact: true })).toHaveAttribute("aria-expanded", "true");
        await expect(launcher).toBeVisible();
        await expect(launcher).toBeFocused();
      }
    } finally {
      await project.stop();
    }
  });
}
