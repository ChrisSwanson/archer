import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { settled } from "./support/settled";
import { sharedTsProject } from "./support/shared-service";

async function openEditor(page: Page, corpus: string, source: string) {
  const project = await sharedTsProject({
    files: {
      "archer.toml": "version = 1\n",
      [`.archer/${source}`]: readFileSync(
        new URL(`../../../tools/devkit/corpus/${corpus}/.archer/${source}`, import.meta.url),
        "utf8",
      ),
    },
  });
  const access = await project.issueAuthoringAccess("canvas clearance");
  await page.goto(access.url);
  const { origin, pathname } = new URL(project.url);
  const slug = pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  await page.goto(`${origin}/projects/${slug}/${source}?edit`);
  await page.mouse.move(700, 450);
  await expect(page.getByRole("region", { name: "Diagram Editor" })).toBeVisible();
  return project;
}

test("the editor frames the Client lifeline clear of the expanded Diagram Key", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const project = await openEditor(page, "journeys", "diagrams/seq.mmd");
  try {
    const key = page.getByRole("region", { name: "Diagram Key", exact: true });
    await expect(key.getByRole("button", { name: "Diagram Key", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const lifeline = page.locator('line.archer-seq-lifeline[data-seq-lifeline="c"]');
    await expect(lifeline).toHaveCount(1);
    await settled(page);
    await expect
      .poll(() =>
        lifeline.evaluate((line) => {
          const panel = line.closest(".authoring-preview")?.querySelector(".archer-diagram-key");
          if (!panel) return false;
          const drawn = line.getBoundingClientRect();
          const cover = panel.getBoundingClientRect();
          return (
            drawn.right < cover.left || drawn.left > cover.right || drawn.bottom < cover.top || drawn.top > cover.bottom
          );
        }),
      )
      .toBe(true);
  } finally {
    await page.close();
    await project.stop();
  }
});

test("editing the queue label keeps the Unicode node available in the drawing", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1300 });
  const project = await openEditor(page, "awkward", "diagrams/flow-styled.mmd");
  try {
    const queue = page.locator('.react-flow__node[data-id="q"]');
    const unicode = page.locator('.react-flow__node[data-id="uni"]');
    await expect(queue).toBeVisible();
    await settled(page);
    await expect(unicode).toBeInViewport();
    await queue.dblclick();
    const label = page.getByRole("textbox", { name: "q label", exact: true });
    await expect(label).toBeFocused();
    await label.press("Enter");
    await expect(label).toHaveCount(0);
    await settled(page);
    await unicode.dblclick({ timeout: 3000 });
    await expect(page.getByRole("textbox", { name: "uni label", exact: true })).toBeFocused();
  } finally {
    await page.close();
    await project.stop();
  }
});

test("clicking the Jobs connection selects it where the Payments hit area reaches it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const project = await openEditor(page, "awkward", "diagrams/c4-boundaries.mmd");
  try {
    const jobs = page.locator('.react-flow__edge[data-id="api--jobs"]');
    const path = jobs.locator("path.react-flow__edge-path");
    await expect(path).toHaveCount(1);
    await settled(page);
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    await settled(page);
    const point = await path.evaluate((element) => {
      const stroke = element as SVGPathElement;
      const point = stroke.getPointAtLength(stroke.getTotalLength() * 0.234).matrixTransform(stroke.getScreenCTM()!);
      return { x: point.x, y: point.y };
    });
    await page.mouse.click(point.x, point.y);
    const selected = page.locator(
      '.react-flow__edge:is([data-id="api--jobs"], [data-id="api--payments"])[aria-pressed="true"]',
    );
    await expect(selected).toHaveCount(1);
    expect(await selected.getAttribute("data-id")).toBe("api--jobs");
  } finally {
    await page.close();
    await project.stop();
  }
});
