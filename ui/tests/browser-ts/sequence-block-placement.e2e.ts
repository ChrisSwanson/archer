// A sequence discussion stands clear of what it is about (rendered review, 2026-11-13): a block's card was placed
// under its 28px header strip, on top of the block's own body; a note's covered the note and message after it; on a
// phone the card covered the canvas's "1 more to the right · Show all" cue (that one is in
// sequence-block-discussion.test.tsx: pressing the canvas here takes the camera, and the cue goes). The coffee
// example's own sequence.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

/** Screenshots for the hand-off, when asked for (`PLACEMENT_SHOTS=<dir>`). */
const SHOTS = process.env["PLACEMENT_SHOTS"];
const SOURCE = readFileSync(resolve("../examples/rfc-2324-htcpcp/.archer/diagrams/coffee-conversations.mmd"), "utf8");
const discussion = (page: Page) => page.getByRole("region", { name: "Contextual discussion", exact: true });
type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function open(page: Page): Promise<TsProject> {
  const project = await sharedTsProject({
    files: { ".archer/coffee.mmd": SOURCE },
    commentSubmission: "queued",
  });
  await project.present("coffee");
  await page.goto(project.url);
  await expect(page.locator(".archer-seq-block-header[data-seq-id]").first()).toBeVisible();
  return project;
}
async function compose(page: Page, target: Locator): Promise<Box> {
  await target.click({ button: "right", position: { x: 30, y: 10 } });
  await expect(discussion(page).getByRole("textbox", { name: "Comment", exact: true })).toBeFocused();
  // Placement has settled once the card stops moving.
  let last = "";
  await expect
    .poll(async () => {
      const now = JSON.stringify(await discussion(page).boundingBox());
      const same = now === last;
      last = now;
      return same;
    })
    .toBe(true);
  return (await discussion(page).boundingBox())!;
}
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

for (const scheme of ["light", "dark"] as const) {
  test(`a block's discussion leaves the whole block in view (${scheme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: scheme });
    const project = await open(page);
    try {
      const frame = (await page.locator(".archer-seq-fragment-border-hit[data-seq-id]").first().boundingBox())!;
      const card = await compose(page, page.locator(".archer-seq-block-header[data-seq-id]").first());
      await shot(page, `seq-block-${scheme}`);
      expect(overlaps(card, frame), JSON.stringify({ card, frame })).toBe(false);
    } finally {
      await project.stop();
    }
  });
}

test("a note's discussion leaves the steps after it in view", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const project = await open(page);
  try {
    const target = page.getByRole("button", { name: /^Note over .+: Available additions SHOULD accompany 406$/ });
    const id = await target.getAttribute("data-seq-id");
    const card = await compose(page, target);
    await shot(page, "seq-note-light");
    const neighbours = await page
      .locator(`[data-seq-channel="notes"]:not([data-seq-id="${id}"]), [data-seq-channel="messages"]`)
      .evaluateAll((all) => all.map((el) => el.getBoundingClientRect().toJSON() as Box));
    expect(neighbours.length).toBeGreaterThan(3);
    for (const neighbour of neighbours) expect(overlaps(card, neighbour), JSON.stringify(neighbour)).toBe(false);
  } finally {
    await project.stop();
  }
});
