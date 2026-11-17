import { expect, test } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const files = {
  "archer.toml": `version = 1\nname = "Swap"\n\n[[views]]\nid = "fan"\nkind = "freeform"\ntitle = "Fan out"\nsource = ".archer/fan.mmd"\n`,
  ".archer/fan.mmd": "flowchart LR\n  a[Gateway]\n  b[Orders]\n  a ab@--> b\n",
};
let project: TsProject;
test.afterEach(async ({ page }) => {
  await page.close();
  await project?.stop();
});

test("the project review takes the diagram panel's place and gives it back", async ({ page }) => {
  project = await sharedTsProject({ files });
  // A highlight, so the drawing has its side panel.
  await project.setEmphasis("fan", [
    {
      id: "path",
      title: "Order path",
      groups: [{ id: "path", label: "Order path", style: "flow", nodes: [], edges: ["ab"] }],
    },
  ]);
  await page.goto((await project.issueAccess("Swap")).url);
  const origin = new URL(project.url).origin,
    slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  await page.goto(`${origin}/projects/${slug}/fan.mmd`);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  const panel = page.getByRole("complementary", { name: "Diagram panel" }),
    review = page.getByRole("region", { name: "Project Review" });
  const panelOwn = panel.getByRole("button", { name: "Collapse diagram panel" });
  await expect(panelOwn).toBeVisible();
  const cell = (await panel.boundingBox())!;
  const bell = page.getByRole("button", { name: "Notifications" });

  await bell.click();
  await expect(review).toBeVisible();
  await expect(panelOwn).toBeHidden();
  // In the panel's cell, not over the drawing beside it.
  const box = (await review.boundingBox())!;
  expect(Math.abs(box.x - cell.x)).toBeLessThan(2);
  expect(Math.abs(box.width - cell.width)).toBeLessThan(2);

  // Dragging the drawing keeps it; a click on the drawing gives the panel back.
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  await page.mouse.move(pane.x + pane.width / 2, pane.y + pane.height / 2);
  await page.mouse.down();
  await page.mouse.move(pane.x + pane.width / 2 - 80, pane.y + pane.height / 2 - 40, { steps: 6 });
  await page.mouse.up();
  await expect(review).toBeVisible();
  await page.mouse.click(pane.x + 20, pane.y + pane.height - 20);
  await expect(review).toBeHidden();
  await expect(panelOwn).toBeVisible();

  // Its close button does the same.
  await bell.click();
  await expect(review).toBeVisible();
  await page.getByRole("button", { name: "Close project review" }).click();
  await expect(review).toBeHidden();
  await expect(panelOwn).toBeVisible();
});
