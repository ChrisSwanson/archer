/**
 * F6 runs against the built page (`ui/dist`), which the test service serves: from the Vite dev server
 * the panel divider's lazily loaded rule arrives after its override and the divider's band covers the
 * stage, which is not what ships.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startTsProject } from "../support/ts-service";

let project: Awaited<ReturnType<typeof startTsProject>>;

const corpus = resolve(import.meta.dirname, "../../../tools/devkit/corpus/pageturner");

test.beforeAll(async () => {
  project = await startTsProject({
    files: {
      "archer.toml":
        'version=1\n[[views]]\nid="system-context"\nkind="c4-context"\ntitle="System context"\nsource=".archer/system-context.mmd"\n',
      ".archer/system-context.mmd": readFileSync(join(corpus, ".archer/diagrams/system-context.mmd"), "utf8"),
    },
  });
});
test.afterAll(async () => {
  await project?.stop();
});

/**
 * Where the focused node's ring is covered: points just outside its box (where the outline is drawn)
 * and its middle, hit-tested. A point is covered when what is on top there is neither the node nor the
 * drawing under it, or when it is off the window.
 */
async function coveredRing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const node = document.activeElement;
    if (
      !(node instanceof Element) ||
      !(node.classList.contains("react-flow__node") || node.classList.contains("react-flow__edge"))
    )
      return ["focus is not on a node or edge"];
    const box = node.getBoundingClientRect();
    const out = 3;
    const xs = [box.left - out, box.left + box.width / 2, box.right + out];
    const ys = [box.top - out, box.top + box.height / 2, box.bottom + out];
    const covered: string[] = [];
    for (const x of xs)
      for (const y of ys) {
        const hit = document.elementFromPoint(x, y);
        if (hit === null) {
          covered.push(`${x},${y}: off the window`);
          continue;
        }
        if (node.contains(hit) || hit.closest(".react-flow__renderer") !== null) continue;
        covered.push(`${Math.round(x)},${Math.round(y)}: ${hit.className || hit.tagName}`);
      }
    return covered;
  });
}

for (const [width, height] of [
  [1000, 800],
  [1500, 900],
] as const)
  test(`R1-codex-19 arrow focus lands in the uncovered canvas at ${width}x${height}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await project.present("system-context");
    await page.goto(project.url);
    await expect(page.locator(".react-flow__node")).toHaveCount(6);
    await expect(page.getByRole("region", { name: "Diagram Key", exact: true })).toBeVisible();
    // The roving stop is the first node; a key press first so the focus that follows is keyboard focus.
    await page.keyboard.press("Shift");
    await page.locator('.react-flow__node[tabindex="0"]').focus();
    const seen = new Set<string>();
    for (const key of [
      "ArrowRight",
      "ArrowRight",
      "ArrowRight",
      "ArrowDown",
      "ArrowDown",
      "ArrowUp",
      "ArrowLeft",
      "ArrowLeft",
    ]) {
      await page.keyboard.press(key);
      const id = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.id ?? "");
      seen.add(id);
      await expect.poll(() => coveredRing(page), { message: `${key} to ${id}` }).toEqual([]);
    }
    await page.screenshot({ path: testInfo.outputPath(`arrow-focus-${width}.png`) });
    // The traversal reached the right-hand column, the part the panel covers at 1000.
    expect([...seen].some((id) => ["email", "payments", "courier"].includes(id))).toBe(true);
  });

/**
 * The controls F7 classified as coarse-pointer failures (G7 [H]), each in its own markup and the page's real stylesheet.
 * Project settings is measured in its opened dialog instead (`settingsSizes`): its stylesheet is added only when the
 * dialog first opens (O195, `theme/on-demand-styles.ts`), so markup injected before then has none of its rules (O241).
 */
const TARGETS = `
<div class="react-flow" style="position:relative;height:60px"><div class="archer-offscreen"><button class="archer-offscreen-cue archer-offscreen-cue--right" data-t="offscreen cue">1 more to the right. Show all</button></div></div>
<div class="archer-journey"><div class="archer-journey-board"><div class="archer-journey-section"><div class="archer-journey-el archer-journey-section-head" role="button" tabindex="0" data-t="journey section head"><span class="archer-journey-section-label">Find a book</span></div></div></div></div>
<section class="archer-compile-notice"><div class="archer-compile-notice-head"><button type="button" class="archer-compile-notice-toggle" data-t="compile notice toggle">Hide problems</button></div></section>
<main class="archer-main"><article class="primary-note-reader archer-source-reader"><div role="alert"><p>This document is unavailable.</p><button type="button" data-t="document Try again">Try again</button></div></article></main>
<section class="archer-contents archer-search-page"><div class="archer-search-results"><div class="archer-search-summary-line"><button type="button" class="archer-search-project-scope" data-t="clear folder filter">docs ×</button><button type="button" class="archer-search-widen" data-t="search all projects">Search all projects</button></div></div></section>
<div id="archer-comparison-panel"><section class="accuracy-compare"><header class="accuracy-header"><div><h2>Compare revisions</h2></div><button type="button" data-t="compare Close">Close</button></header><form><div class="accuracy-refs"><label>From <input data-t="compare ref" value="HEAD~1"></label></div><button type="submit" data-t="Compare">Compare</button></form></section></div>
<div class="authoring-workspace"><div class="authoring-body"><aside class="authoring-panel"><details><summary data-t="draft tools summary">Draft and proposal tools</summary></details></aside></div></div>`;

async function targetSizes(page: Page): Promise<Record<string, { width: number; height: number }>> {
  return page.evaluate((markup) => {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:9999;overflow:auto;background:var(--bg)";
    host.innerHTML = markup;
    document.body.append(host);
    const sizes: Record<string, { width: number; height: number }> = {};
    for (const el of host.querySelectorAll<HTMLElement>("[data-t]")) {
      const box = el.getBoundingClientRect();
      sizes[el.dataset.t!] = { width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10 };
    }
    host.remove();
    return sizes;
  }, TARGETS);
}

/** The opened Project settings dialog's first section button and Name field; the dialog is closed again after. */
async function settingsSizes(page: Page): Promise<Record<string, { width: number; height: number }>> {
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  await page.goto(`${new URL(project.url).origin}/projects/${slug}/`);
  await page.getByRole("button", { name: "Project settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /Project Settings/ });
  const field = dialog.getByLabel("Name", { exact: true });
  await expect(field).toBeVisible();
  const nav = dialog.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: /^General/ });
  const sizes: Record<string, { width: number; height: number }> = {};
  for (const [name, target] of [
    ["settings nav", nav],
    ["settings field", field],
  ] as const) {
    const box = (await target.boundingBox())!;
    sizes[name] = { width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10 };
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  return sizes;
}

test("F7 coarse targets are at least 44x44 at 390x844 with touch, and the fine-pointer layout is unchanged", async ({
  browser,
}, testInfo) => {
  const coarse = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const fine = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  try {
    await project.present("system-context");
    const phone = await coarse.newPage();
    await phone.goto(project.url);
    await expect(phone.locator(".react-flow__node").first()).toBeVisible();
    expect(await phone.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const small = Object.entries(await targetSizes(phone)).filter(([, box]) => box.width < 44 || box.height < 44);
    await phone.screenshot({ path: testInfo.outputPath("coarse-390.png") });
    expect(small).toEqual([]);
    // The live cue on the phone's canvas, where the drawing runs past the edge.
    const cue = phone.locator(".archer-offscreen-cue");
    if ((await cue.count()) > 0) expect((await cue.first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // Project settings, opened from the project page (this leaves the diagram, so it comes last).
    expect(Object.entries(await settingsSizes(phone)).filter(([, box]) => box.width < 44 || box.height < 44)).toEqual(
      [],
    );

    const desk = await fine.newPage();
    await desk.goto(project.url);
    await expect(desk.locator(".react-flow__node").first()).toBeVisible();
    const sizes = { ...(await targetSizes(desk)), ...(await settingsSizes(desk)) };
    // Fine pointer keeps its compact controls.
    expect(sizes["offscreen cue"]!.height).toBeLessThan(44);
    expect(sizes["compile notice toggle"]!.height).toBeLessThan(44);
    expect(sizes["settings nav"]!.height).toBeLessThan(44);
    expect(sizes["draft tools summary"]!.height).toBeLessThan(44);
  } finally {
    await coarse.close();
    await fine.close();
  }
});

test("R1-codex-19 at 390x844 with touch: Shift+Tab out of the dock sheet lands on a node or edge above the sheet", async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  try {
    const page = await context.newPage();
    await project.present("system-context");
    await page.goto(project.url);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await page.locator(".archer-stage-dock .archer-dock-chip--panel").tap();
    const sheet = page.locator(".archer-dock-sheet");
    await expect(sheet.getByRole("region", { name: "Diagram Key", exact: true })).toBeVisible();
    // Keyboard from the sheet's first control back into the drawing.
    await sheet.locator("button").first().focus();
    let reached = false;
    for (let i = 0; i < 40 && !reached; i += 1) {
      await page.keyboard.press("Shift+Tab");
      reached = await page.evaluate(
        () => document.activeElement?.closest(".react-flow__node, .react-flow__edge") === document.activeElement,
      );
    }
    expect(reached, "Shift+Tab reaches the drawing").toBe(true);
    await expect.poll(() => coveredRing(page), { message: "the first stop" }).toEqual([]);
    for (const key of ["ArrowDown", "ArrowDown", "ArrowRight", "ArrowDown", "ArrowRight"]) {
      await page.keyboard.press(key);
      await expect.poll(() => coveredRing(page), { message: key }).toEqual([]);
    }
    await expect(sheet).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("dock-sheet-390.png") });
  } finally {
    await context.close();
  }
});
