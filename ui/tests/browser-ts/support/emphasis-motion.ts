import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Where the first arrow is, independently of camera movement or layout; null while none is drawn. Found
 * inside the one `evaluate` from its group: switching between still and moving arrows replaces them, so
 * an arrow resolved in one protocol call can be gone (no parent) by the next.
 */
export async function chevronPosition(chevrons: Locator): Promise<{ x: number; y: number } | null> {
  return chevrons.evaluate((group) => {
    const chevron = group.querySelector(".archer-emph-chevron") as SVGGraphicsElement | null;
    const parent = chevron?.parentElement as unknown as SVGGraphicsElement | null | undefined;
    const own = chevron?.getCTM(),
      base = parent?.getCTM();
    if (own == null || base == null) return null;
    const matrix = base.inverse().multiply(own);
    return { x: matrix.e, y: matrix.f };
  });
}

/** The arrows are the moving kind and travel along their route: two readings of the same arrows differ. */
export async function expectChevronsMoving(chevrons: Locator): Promise<void> {
  await expect(chevrons).toBeAttached();
  // A change of motion setting re-renders the arrows after the call that made it returns: measure the moving ones.
  await expect(chevrons.locator("animateMotion")).not.toHaveCount(0);
  const before = await chevronPosition(chevrons);
  expect(before, "a moving arrow is drawn").not.toBeNull();
  await expect
    .poll(
      async () => {
        const after = await chevronPosition(chevrons);
        return after === null ? 0 : Math.hypot(after.x - before!.x, after.y - before!.y);
      },
      { message: "the flow's moving arrows must move along their route" },
    )
    .toBeGreaterThan(2);
}

/**
 * Flow animation is On by default; this makes the page follow the browser's reduced-motion setting (Auto),
 * as a test of reduced motion needs. Only when the person has not chosen, so a test's own choice stands.
 */
export async function followBrowserMotion(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      if (localStorage.getItem("archer.flow-animation") === null) localStorage.setItem("archer.flow-animation", "auto");
    } catch {
      // A page that cannot store follows the default.
    }
  });
}
