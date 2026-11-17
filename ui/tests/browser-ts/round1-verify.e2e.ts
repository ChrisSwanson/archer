// Round 1 (UI/UX) integration: what the combined batches left behind, checked on the built page.
// Each test names the leftover it pins (rounds/r1 integration hand-back).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const FIXTURES = resolve(import.meta.dirname, "../../../ts/test/fixtures");
const KINDS = {
  flow: "freeform",
  seq: "sequence",
  state: "state",
  er: "entity-relationship",
  c4: "c4",
  arch: "architecture",
} as const;
type View = keyof typeof KINDS;
const SOURCES: Record<View, string> = {
  flow: readFileSync(resolve(FIXTURES, "flowchart", "widened.mmd"), "utf8"),
  // Long enough that the opening framing stops at the floor, not at reading size: numbered, with a fragment.
  seq:
    readFileSync(resolve(FIXTURES, "sequence", "widened.mmd"), "utf8") +
    "    loop Every minute\n" +
    Array.from({ length: 30 }, (_, i) => `        user->>web: Poll ${i}\n`).join("") +
    "    end\n",
  state: readFileSync(resolve(FIXTURES, "state", "widened.mmd"), "utf8"),
  er: readFileSync(resolve(FIXTURES, "er", "widened.mmd"), "utf8"),
  c4: readFileSync(resolve(FIXTURES, "c4", "widened.mmd"), "utf8"),
  arch: readFileSync(resolve(FIXTURES, "architecture", "widened.mmd"), "utf8"),
};

let project: TsProject | undefined;
test.afterEach(async () => {
  await project?.stop();
  project = undefined;
});

async function open(page: Page, view: View): Promise<void> {
  const files: Record<string, string> = { "archer.toml": "version = 1\n" };
  for (const [id, kind] of Object.entries(KINDS)) {
    files["archer.toml"] +=
      `[[views]]\nid = "${id}"\nkind = "${kind}"\ntitle = "${id}"\nsource = ".archer/${id}.mmd"\n`;
    files[`.archer/${id}.mmd`] = SOURCES[id as View];
  }
  project ??= await sharedTsProject({ files });
  if (!page.url().startsWith(new URL(project.url).origin))
    await page.goto((await project.issueAccess("Round 1 verify")).url);
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  await page.goto(`${new URL(project.url).origin}/projects/${slug}/${view}.mmd`);
  await expect(page.locator(".react-flow__controls, .archer-canvas-controls").first()).toBeVisible();
}

/** Every drawn word on the canvas, with the size it reaches the screen at. */
async function canvasText(page: Page): Promise<{ text: string; px: number; where: string }[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector(".react-flow__viewport, .archer-seq-svg")!;
    const out: { text: string; px: number; where: string }[] = [];
    for (const el of canvas.querySelectorAll<HTMLElement | SVGElement>("*")) {
      const own = [...el.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== "",
      );
      if (!own || el.closest("defs, style, script")) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility !== "visible") continue;
      let scale: number;
      if (el instanceof SVGGraphicsElement) scale = el.getScreenCTM()?.a ?? 1;
      else {
        scale = 1;
        for (let node: Element | null = el; node; node = node.parentElement) {
          const transform = getComputedStyle(node).transform;
          if (transform !== "none") scale *= new DOMMatrix(transform).a;
        }
      }
      out.push({
        text: el.textContent!.trim().slice(0, 30),
        px: Math.round(parseFloat(style.fontSize) * scale * 100) / 100,
        where: el.getAttribute("class") ?? el.tagName,
      });
    }
    return out;
  });
}

// The floor holds on the opening framing only: explicit Fit (`Fit view`, `1`) shows the whole drawing
// with no floor and says when it is too small to read (AM-R1-02, viewport-fit.ts NO_ZOOM_FLOOR).
for (const view of ["flow", "seq", "state", "er", "c4", "arch"] as const) {
  test(`V6: as the ${view} canvas opens no word is drawn under the 11 px floor`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await open(page, view);
    await expect(page.locator(".react-flow__viewport, .archer-seq-svg").first()).toBeAttached();
    await expect.poll(async () => (await canvasText(page)).length).toBeGreaterThan(5);
    await expect.poll(async () => (await canvasText(page)).filter((word) => word.px < 10.995)).toEqual([]);
  });
}

for (const view of ["flow", "seq"] as const) {
  test(`the panel divider takes no press inside the ${view} canvas`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, view);
    await expect(page.locator(".archer-diagram-panel")).toBeVisible();
    const misses = await page.evaluate(() => {
      const box = document.querySelector(".archer-diagram-content")!.getBoundingClientRect();
      const out: string[] = [];
      // The divider's 24 px target may lie 6.5 px over the drawing's edge, no further.
      for (let x = box.left + 8; x < box.right - 8; x += 12) {
        for (let y = box.top + 8; y < box.bottom - 8; y += 40) {
          const hit = document.elementFromPoint(x, y);
          if (hit?.closest(".archer-panel-divider, .archer-walk-divider"))
            out.push(`${Math.round(x)},${Math.round(y)} ${hit.className}`);
        }
      }
      return out;
    });
    expect(misses).toEqual([]);
  });
}

test("the New button's plus and caret are on the icon scale, on the project page and in a diagram's header", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "flow");
  const glyphs = async () =>
    page.evaluate(() => {
      const box = (selector: string) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      };
      return { plus: box(".archer-new-button .archer-new-plus"), caret: box(".archer-new-button .archer-new-caret") };
    });
  // The scale's inline icon (16 px) and indicator (14 px): styles.css --icon-inline, --icon-indicator.
  expect(await glyphs()).toEqual({ plus: [16, 16], caret: [14, 14] });
  await page.goto(page.url().replace(/flow\.mmd$/, ""));
  await expect(page.locator(".archer-new-button")).toBeVisible();
  expect(await glyphs()).toEqual({ plus: [16, 16], caret: [14, 14] });
});

test("Archer Settings: the single-character shortcuts row reads at the settings' body size", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, "flow");
  await page.locator(".archer-settings-launcher").first().click();
  const row = page.getByText("Single-character shortcuts", { exact: true });
  await expect(row).toBeVisible();
  const body = await page
    .locator(".archer-settings-name, .archer-settings-identity dd")
    .first()
    .evaluate((el) => getComputedStyle(el).fontSize);
  await expect(row).toHaveCSS("font-size", body);
  await expect(row).toHaveCSS("font-size", "14px");
});
