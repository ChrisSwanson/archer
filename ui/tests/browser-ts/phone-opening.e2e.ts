/**
 * The opening view on a phone (review, 2026-11-12; 390x844, ship-loop): the off-screen cue ("N more below") must not
 * sit on the first node the view opens on, and the zoom rail must not cover the opening view's reading target.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startTsProject } from "../support/ts-service";
import { settled } from "./support/settled";

let project: Awaited<ReturnType<typeof startTsProject>>;

test.beforeAll(async () => {
  project = await startTsProject({
    files: {
      "archer.toml":
        'version=1\n[[views]]\nid="ship-loop"\nkind="freeform"\ntitle="Ship Loop"\nsource=".archer/ship-loop.mmd"\n',
      ".archer/ship-loop.mmd": readFileSync(resolve(import.meta.dirname, "../fixtures/palette/ship-loop.mmd"), "utf8"),
    },
  });
});
test.afterAll(async () => {
  await project?.stop();
});

type Box = { x: number; y: number; width: number; height: number };
const meets = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test("at 390x844 the opening view's nodes are clear of the off-screen cue and the zoom rail", async ({
  browser,
}, testInfo) => {
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    await project.present("ship-loop");
    const page = await phone.newPage();
    await page.goto(project.url);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    // The opening framing settles (it animates in).
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath("phone-opening.png") });
    const seen = await page.evaluate(() => {
      const box = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const stage = document.querySelector(".react-flow")!.getBoundingClientRect();
      const inView = (r: DOMRect) =>
        r.right > stage.left && r.left < stage.right && r.bottom > stage.top && r.top < stage.bottom;
      return {
        nodes: [...document.querySelectorAll(".react-flow__node")]
          .filter((n) => inView(n.getBoundingClientRect()))
          .map((n) => ({ id: n.getAttribute("data-id"), ...box(n) })),
        cues: [...document.querySelectorAll(".archer-offscreen-cue")].map(box),
        rail: [...document.querySelectorAll(".archer-canvas-controls")].map(box),
      };
    });
    testInfo.attach("seen", { body: JSON.stringify(seen, null, 1), contentType: "application/json" });
    expect(seen.nodes.length).toBeGreaterThan(0);
    const clashes: string[] = [];
    // The cue keeps the framing's gap (`CHROME_GAP_PX`, 12) from the drawing, however many lines it wraps to.
    const grown = (b: Box, by: number): Box => ({
      x: b.x - by,
      y: b.y - by,
      width: b.width + 2 * by,
      height: b.height + 2 * by,
    });
    for (const node of seen.nodes) {
      for (const cue of seen.cues) if (meets(node, grown(cue, 11))) clashes.push(`${node.id} under the cue`);
      for (const rail of seen.rail) if (meets(node, rail)) clashes.push(`${node.id} under the zoom rail`);
    }
    expect(clashes).toEqual([]);
  } finally {
    await phone.close();
  }
});
