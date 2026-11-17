import { expect, type Page } from "@playwright/test";

/**
 * A box's menu (ADR 0036 A9, slice 7): right-click on a graph box opens Comment / Expand where Expand is
 * offered (Explore and Highlights, a service with the explorations capability). This chooses Comment, as
 * the right-click itself did before; edges, messages, journeys and Walkthrough still open the composer.
 */
export async function chooseComment(page: Page): Promise<void> {
  const item = page
    .getByRole("menu", { name: /^Actions for / })
    .getByRole("menuitem", { name: "Comment", exact: true });
  await expect(item).toBeFocused();
  await item.click();
}
