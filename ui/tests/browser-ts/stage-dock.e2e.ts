/**
 * Phone reading (G1) and the diagram key's footprint (G2), in a real browser.
 *
 * A phone: a two-row header; the side panel (legend, key, walkthroughs; 0.6.4 D5) is one chip in a
 * strip under the drawing, never over it, opening one sheet. Larger screens: the key is closed to its header
 * on a small stage or under a legend, open on a roomy stage, and the viewer's choice is kept.
 */
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTAINERS = readFileSync(
  resolve(HERE, "../../../ts/test/fixtures/pageturner/.archer/diagrams/containers.mmd"),
  "utf8",
);
let project: TsProject | undefined;
test.afterEach(async () => {
  await project?.stop();
  project = undefined;
});

async function open(page: Page, emphasis: boolean): Promise<void> {
  project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "containers"\nkind = "c4"\ntitle = "Containers"\nsource = ".archer/containers.mmd"\n',
      ".archer/containers.mmd": CONTAINERS,
    },
  });
  await page.goto(project.url);
  await project.present("containers");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  if (emphasis) {
    await project.setEmphasis("containers", [
      {
        id: "focus",
        title: "Checkout path",
        groups: [
          { id: "a", style: "highlight", label: "Storefront", description: "Where customers buy.", nodes: ["web"] },
          { id: "b", style: "highlight", label: "Shop API", nodes: ["api"] },
          { id: "c", style: "highlight", label: "Database", nodes: ["db"] },
        ],
      },
    ]);
  }
}
const box = async (page: Page, selector: string) => (await page.locator(selector).first().boundingBox())!;
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

for (const theme of ["light", "dark"] as const) {
  test(`phone ${theme}: a short header, and the panel as a chip under the drawing that opens one sheet with the legend and key`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await open(page, true);
    const dock = page.locator(".archer-stage-dock");
    const legendChip = dock.locator(".archer-dock-chip--panel");
    await expect(legendChip).toHaveAccessibleName("Highlights");
    await expect(dock.getByRole("button", { name: "Diagram Key", exact: true })).toHaveCount(0);
    // The header is two rows: the trail with the workspace actions, then the title.
    expect((await box(page, ".primary-document-bar")).height).toBeLessThanOrEqual(110);
    const title = await box(page, ".primary-document-title");
    expect(overlaps(title, await box(page, ".primary-document-actions"))).toBe(false);
    // The trail does not repeat the title: what is open is the h1, not a crumb.
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).locator("[aria-current=page]")).toBeHidden();
    // Nothing floats over the drawing: the strip is below it, and neither panel is inside it.
    const content = await box(page, ".archer-diagram-content");
    expect((await legendChip.boundingBox())!.y).toBeGreaterThanOrEqual(content.y + content.height - 1);
    await expect(page.locator(".archer-diagram-content :is(.archer-emph-legend, .archer-diagram-key)")).toHaveCount(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

    await legendChip.click();
    const sheet = page.getByRole("dialog", { name: "Highlights" });
    await expect(sheet).toBeVisible();
    const last = sheet.getByRole("button", { name: /^Database/ });
    await expect(last).toBeInViewport();
    expect(
      await last.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".archer-dock-sheet");
      }),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).include(".archer-dock-sheet").analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(legendChip).toBeFocused();
    // Escape closed the sheet only: the emphasis is still on.
    await expect(
      page.getByRole("group", { name: "Highlights" }).getByRole("button", { name: "Checkout path" }),
    ).toHaveAttribute("aria-pressed", "true");

    // The key is in the same sheet, under the legend.
    await legendChip.click();
    await expect(sheet.getByRole("region", { name: "Diagram Key" }).getByText("Person", { exact: true })).toBeVisible();
    await page.mouse.click(195, content.y + 40);
    await expect(sheet).toHaveCount(0);
    if (process.env.ARCHER_SHOTS)
      await page.screenshot({ path: `${process.env.ARCHER_SHOTS}/stage-dock-phone-${theme}.png` });
  });
}

// The Key opens expanded wherever it appears (owner, 2026-11-12, 2e9252e0); it was closed to its header under a
// legend at 1024px. What this case holds is unchanged: the Key and the legend keep separate, reachable footprints,
// open or closed, and the reader's choice is kept.
test("1024px: the key starts open under a legend, clear of it; closes on a tap, and the choice is kept", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, true);
  const legend = page.getByRole("region", { name: "Highlights", exact: true });
  await expect(legend).toBeVisible();
  const button = page.getByRole("button", { name: "Diagram Key", exact: true });
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const key = page.getByRole("region", { name: "Diagram Key", exact: true });
  await expect(key.getByText("Person", { exact: true })).toBeVisible();
  // Open, the legend sits clear of the key rather than under it, and both are on screen.
  await expect.poll(async () => overlaps((await key.boundingBox())!, (await legend.boundingBox())!)).toBe(false);
  for (const region of [key, legend]) {
    const box = (await region.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(768);
  }
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "false");
  expect((await key.boundingBox())!.height).toBeLessThanOrEqual(48);
  await expect.poll(async () => overlaps((await key.boundingBox())!, (await legend.boundingBox())!)).toBe(false);
  await page.reload();
  await expect(page.getByRole("button", { name: "Diagram Key", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("desktop with room and no legend: the key opens to its rows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, false);
  await expect(page.getByRole("button", { name: "Diagram Key", exact: true })).toHaveAttribute("aria-expanded", "true");
});
