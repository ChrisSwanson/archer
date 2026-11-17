import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";
for (const phone of [false, true])
  test(`sidebar Projects and graph tools coexist with document notifications; phone=${phone}`, async ({ page }) => {
    const project = await sharedTsProject({
      files: {
        "archer.toml":
          'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n',
        ".archer/flow.mmd": "flowchart LR\n a[Customer] e1@--> b[Shop]\n",
      },
    });
    try {
      if (phone) await page.setViewportSize({ width: 390, height: 844 });
      await project.present("flow");
      await page.goto(project.url);
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      const nav = page.locator(".primary-navigation");
      await page.mouse.move(phone ? 370 : 700, 500);
      await expect(nav).toHaveAttribute("data-expanded", "false");
      const before = await page.locator(".react-flow").boundingBox();
      // On a phone the sidebar is a drawer behind the bar's menu button; on a desktop, a rail that expands over the page.
      if (phone) await page.getByRole("button", { name: "Menu", exact: true }).click();
      else await page.getByRole("button", { name: "Archer contents", exact: true }).hover();
      const projects = page.getByRole("navigation", { name: "Projects" });
      await expect(projects).toBeVisible();
      await expect.poll(async () => (await nav.boundingBox())?.width).toBe(phone ? 320 : 340);
      await expect.poll(async () => (await page.locator(".primary-rail").boundingBox())?.x).toBe(0);
      const rail = await page.locator(".primary-rail").boundingBox(),
        body = await projects.boundingBox();
      expect(body!.x).toBeGreaterThanOrEqual(rail!.x);
      expect(body!.x + body!.width).toBeLessThanOrEqual(rail!.x + rail!.width);
      // Over the page, never narrowing it.
      expect(await page.locator(".react-flow").boundingBox()).toEqual(before);
      await expect.poll(() => nav.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      // No close control: Escape from within the navigation (or leaving the rail) closes it.
      const contents = page.getByRole("button", { name: "Archer contents", exact: true });
      await contents.focus();
      await expect(contents).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(nav).toHaveAttribute("data-expanded", "false");
      await expect(phone ? page.getByRole("button", { name: "Menu", exact: true }) : contents).toBeFocused();
      await page.getByRole("button", { name: /^Notifications/ }).click();
      const review = page.getByRole("region", { name: "Project Review" });
      await expect(review).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(await review.evaluate((el) => !!el.closest(".primary-rail"))).toBe(false);
      await expect(nav).toHaveAttribute("data-expanded", "false");
      await page.getByRole("button", { name: "Close project review", exact: true }).click();
      await expect(review).toBeHidden();
      await expect(page.getByRole("button", { name: /^Notifications/ })).toBeFocused();
      const tools = page.getByRole("button", { name: "Export, compare and more", exact: true });
      await tools.click();
      await expect(
        page
          .getByRole("group", { name: "Export, compare and more", exact: true })
          .getByRole("button", { name: "Compare revisions", exact: true }),
      ).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(tools).toBeFocused();
      await expect(nav).toHaveAttribute("data-expanded", "false");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    } finally {
      await project.stop();
    }
  });
