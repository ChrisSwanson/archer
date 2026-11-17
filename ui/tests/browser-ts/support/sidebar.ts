import { expect, type Page } from "@playwright/test";

/** Reveal the permanent Projects section through its desktop rail or phone drawer. */
export async function revealProjects(page: Page): Promise<void> {
  const heading = page.getByRole("heading", { name: "Projects", exact: true });
  const navigation = page.locator(".primary-navigation");
  if ((await navigation.getAttribute("data-expanded")) !== "true") {
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    if (await menu.isVisible()) await menu.click();
    else await page.getByRole("button", { name: "Archer contents", exact: true }).hover();
  }
  await expect(heading).toBeVisible();
  await expect
    .poll(() =>
      navigation.evaluate((element) => ({
        heading: getComputedStyle(element.querySelector(".primary-projects-heading span")!).opacity,
        flyout: getComputedStyle(element.querySelector(".primary-flyout")!).opacity,
        running: element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running")
          .length,
      })),
    )
    .toEqual({ heading: "1", flyout: "1", running: 0 });
}
