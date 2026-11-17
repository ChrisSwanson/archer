// The follow camera frames a step clear of the chrome floating over the canvas (rendered review, 2026-11-13):
// on the avian QoS walkthrough step 2 "Concorde Queue" sat under the tool rail and "Coach Queue" touched the chat
// button. The example diagram and its walkthrough, in an isolated project; never the live service.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sharedTsProject } from "./support/shared-service";

const EXAMPLE = resolve("../examples/rfc-1149-ipoac/.archer/diagrams");
const COFFEE = resolve("../examples/rfc-2324-htcpcp/.archer/diagrams");
const files = {
  ".archer/qos-queues.mmd": readFileSync(`${EXAMPLE}/qos-queues.mmd`, "utf8"),
  ".archer/qos-queues.walkthroughs.json": readFileSync(`${EXAMPLE}/qos-queues.walkthroughs.json`, "utf8"),
};
const STEP_NODES = [
  ["barcode", "scan"],
  ["level", "concorde", "first", "business", "coach"],
  ["gate", "red", "scales"],
  ["gate", "departure"],
];

const step = (page: Page) => page.getByRole("slider", { name: "Step" });

/** The camera has stopped: the same transform for a few frames running. */
async function settled(page: Page): Promise<void> {
  const transform = () =>
    page.evaluate(() => getComputedStyle(document.querySelector(".react-flow__viewport")!).transform);
  let last = await transform();
  let still = 0;
  await expect
    .poll(
      async () => {
        const now = await transform();
        still = now === last ? still + 1 : 0;
        last = now;
        return still;
      },
      { timeout: 5000, intervals: [80] },
    )
    .toBeGreaterThan(4);
}

/** Walked nodes that a piece of floating chrome covers, as `node under chrome`. */
async function covered(page: Page, ids: readonly string[]): Promise<string[]> {
  return page.evaluate((nodeIds) => {
    const chrome = [...document.querySelectorAll(".react-flow__controls, .archer-chat-fab")].map((el) => ({
      name: el.className.toString().split(" ")[0]!,
      r: el.getBoundingClientRect(),
    }));
    const pane = document.querySelector(".react-flow")!.getBoundingClientRect();
    const hits: string[] = [];
    for (const id of nodeIds) {
      const n = document.querySelector(`.react-flow__node[data-id="${id}"]`)?.getBoundingClientRect();
      if (n === undefined) {
        hits.push(`${id} not drawn`);
        continue;
      }
      if (n.left < pane.left || n.right > pane.right || n.top < pane.top || n.bottom > pane.bottom)
        hits.push(`${id} outside the canvas`);
      for (const { name, r } of chrome)
        if (r.width > 0 && n.left < r.right && n.right > r.left && n.top < r.bottom && n.bottom > r.top)
          hits.push(`${id} under ${name}`);
    }
    return hits;
  }, ids);
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]) {
  test(`each QoS step is framed clear of the tool rail and the chat button at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const project = await sharedTsProject({ files });
    try {
      await project.present("qos-queues");
      await page.goto(project.url);
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      await page.locator(".archer-walk-open").click();
      await page
        .getByRole("group", { name: "Walkthroughs on this diagram" })
        .getByRole("button", { name: /From wing mark to departure/ })
        .click();
      await expect(step(page)).toHaveValue("1");
      await expect(page.locator(".archer-chat-fab")).toBeVisible();
      for (const [index, ids] of STEP_NODES.entries()) {
        await step(page).fill(String(index + 1));
        await expect(step(page)).toHaveValue(String(index + 1));
        await settled(page);
        expect(await covered(page, ids), `step ${index + 1}`).toEqual([]);
      }
    } finally {
      await project.stop();
    }
  });
}

// Brew step 1 (same review): the step is the top of a tall drawing, and centring it left ~280px of empty canvas above
// the drawing while the drawing ran off the bottom. The camera moves toward the cut-off side instead.
test("Brew step 1 shows no more than the gutter and the margin above a drawing cut off below", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const project = await sharedTsProject({
    files: {
      ".archer/brew-decisions.mmd": readFileSync(`${COFFEE}/brew-decisions.mmd`, "utf8"),
      ".archer/brew-decisions.walkthroughs.json": readFileSync(`${COFFEE}/brew-decisions.walkthroughs.json`, "utf8"),
    },
  });
  try {
    await project.present("brew-decisions");
    await page.goto(project.url);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await page.locator(".archer-walk-open").click();
    await page
      .getByRole("group", { name: "Walkthroughs on this diagram" })
      .getByRole("button", { name: /A Request Is Not/ })
      .click();
    await expect(step(page)).toHaveValue("1");
    await settled(page);
    expect(await covered(page, ["request", "body", "media"])).toEqual([]);
    const { above, cutBelow, zoom } = await page.evaluate(() => {
      const pane = document.querySelector(".react-flow")!.getBoundingClientRect();
      const nodes = [...document.querySelectorAll(".react-flow__node")].map((n) => n.getBoundingClientRect());
      const m = new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform);
      return {
        above: Math.min(...nodes.map((n) => n.top)) - pane.top,
        cutBelow: Math.max(...nodes.map((n) => n.bottom)) > pane.bottom,
        zoom: m.a,
      };
    });
    expect(cutBelow).toBe(true);
    // The fit gutter (24px) and the follow margin (40 layout units), and a pixel of rounding.
    expect(above).toBeLessThanOrEqual(24 + 40 * zoom + 1);
  } finally {
    await project.stop();
  }
});
