import { expect, test } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { chooseComment } from "./support/element-menu";
import { sharedTsProject } from "./support/shared-service";

const files = {
  "archer.toml": `version = 1\nname = "Follow"\n\n[[views]]\nid = "fan"\nkind = "freeform"\ntitle = "Fan out"\nsource = ".archer/fan.mmd"\n`,
  ".archer/fan.mmd": "flowchart LR\n  a[Gateway]\n  b[Orders]\n  a ab@--> b\n",
};
let project: TsProject;
test.afterEach(async ({ page }) => {
  await page.close();
  await project?.stop();
});

test("a comment discussion moves with its node in the same frame while the canvas pans", async ({ page }) => {
  project = await sharedTsProject({ files });
  await page.goto((await project.issueAccess("Follow")).url);
  const origin = new URL(project.url).origin,
    slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  await page.goto(`${origin}/projects/${slug}/fan.mmd`);
  const node = page.locator('.react-flow__node[data-id="a"]');
  await node.click({ button: "right" });
  await chooseComment(page);
  await page.getByRole("textbox", { name: "Comment" }).fill("follow me");
  await page.getByRole("button", { name: "Add comment" }).click();
  const bubble = page.getByRole("region", { name: "Contextual discussion" });
  await expect(bubble.getByText("follow me")).toBeVisible();
  // Each frame: where the node and the discussion are drawn.
  await page.evaluate(() => {
    const w = window as unknown as { frames: number[][]; run: boolean };
    w.frames = [];
    w.run = true;
    const tick = () => {
      const a = document.querySelector('.react-flow__node[data-id="a"]')?.getBoundingClientRect(),
        s = document.querySelector(".primary-floating-discussion")?.getBoundingClientRect();
      if (a && s) w.frames.push([a.x, s.x]);
      if (w.run) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  const sx = pane.x + pane.width / 2,
    sy = pane.y + pane.height - 40;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(sx - i * 5, sy);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  const frames = await page.evaluate(() => {
    const w = window as unknown as { frames: number[][]; run: boolean };
    w.run = false;
    return w.frames;
  });
  // Panning keeps it open.
  await expect(bubble).toBeVisible();
  let moved = 0,
    trailed = 0;
  for (let i = 1; i < frames.length; i++)
    if (frames[i]![0] !== frames[i - 1]![0]) {
      moved++;
      if (frames[i]![1] === frames[i - 1]![1]) trailed++;
    }
  expect(moved).toBeGreaterThan(5);
  expect(trailed).toBe(0);
});
