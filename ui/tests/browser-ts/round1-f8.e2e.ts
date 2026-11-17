// Round 1 (UI/UX) fixes, pass 3, batch F8: canvas focus reveal, the phone compare panel, the edge
// caption's More, the lifeline contrast and the canvas lettering tokens. Each test names its row in
// the pass's fixes list and the finding it answers. The Pageturner corpus, served from this checkout's
// build (`ARCHER_PAGE`, else ui/dist).
import { FRAME_CAPTION_FONT_PX } from "../../src/layout/captions";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
  type BrowserContext,
} from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { measureTokens } from "../../../tools/devkit/harness/tokens.mjs";
import { sharedTsProject } from "./support/shared-service";

const CORPUS = resolve(import.meta.dirname, "../../../tools/devkit/corpus");

function corpus(name: string): Record<string, string> {
  const root = join(CORPUS, name);
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(root, path)] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return out;
}
const commit = async (root: string): Promise<void> => {
  const git = (...args: string[]): void => {
    execFileSync(
      "git",
      ["-c", "user.name=archer-test", "-c", "user.email=test@archer.invalid", "-c", "init.defaultBranch=main", ...args],
      {
        cwd: root,
        stdio: "ignore",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    );
  };
  git("init");
  git("add", "-A");
  git("commit", "-m", "corpus");
};

let project: TsProject | undefined;
// The contexts a test opens are closed with it: one left open keeps its page polling the stopped service for the
// rest of the worker, on the same browser as every later test (known failure O51).
const contexts: BrowserContext[] = [];
async function opened(browser: Browser, options?: BrowserContextOptions): Promise<BrowserContext> {
  const context = await browser.newContext(options);
  contexts.push(context);
  return context;
}
test.afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  await project?.stop();
  project = undefined;
});

type Opened = { readonly page: Page; readonly at: (path: string) => string };
async function open(browser: Browser, options: BrowserContextOptions): Promise<Opened> {
  project = await sharedTsProject({ files: corpus("pageturner"), beforeAttach: commit });
  const context = await opened(browser, options);
  const page = await context.newPage();
  await page.goto((await project.issueAccess("round1-f8")).url);
  const origin = new URL(project.url).origin;
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  return { page, at: (path) => `${origin}/projects/${slug}/${path}` };
}
const phone = (width: number, height: number): BrowserContextOptions => ({
  viewport: { width, height },
  hasTouch: true,
  isMobile: true,
});

/**
 * In the page: what the focused element is, how many points of its box (a 5×5 grid) something else covers, and
 * whether its middle is covered. A phone's review sheet leaves the drawing a strip too narrow for most nodes, so
 * what can be asked there is that focus is not entirely hidden (WCAG 2.4.11) and its middle, which the shell
 * hit-tests to decide what the sheet covers, is clear.
 */
function focusState(): { name: string; covered: number; points: number; middle: boolean } {
  const active = document.activeElement;
  if (active === null || active === document.body) return { name: "BODY", covered: 0, points: 0, middle: false };
  const name = active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 40) ?? active.tagName;
  // An edge's own box is its path's; its focus ring is drawn on the path.
  const shape = active.classList.contains("react-flow__edge")
    ? (active.querySelector("path.react-flow__edge-path") ?? active)
    : active;
  const box = shape.getBoundingClientRect();
  const isCovered = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true;
    const hit = document.elementFromPoint(x, y);
    if (hit === null) return true;
    if (active.contains(hit) || hit.contains(active)) return false;
    // Drawing under an edge's thin line (the pane, another edge, a caption) is not a cover.
    return !(hit.closest(".react-flow__renderer") !== null && active.closest(".react-flow__renderer") !== null);
  };
  let covered = 0,
    points = 0;
  for (let i = 0; i <= 4; i++)
    for (let j = 0; j <= 4; j++) {
      points += 1;
      if (isCovered(box.left + (box.width * i) / 4, box.top + (box.height * j) / 4)) covered += 1;
    }
  return { name, covered, points, middle: isCovered(box.left + box.width / 2, box.top + box.height / 2) };
}

/** Tab from Notifications into the drawing and out to its first control: every stop, and the drawing's stops that were wholly covered. */
async function tabThroughCanvas(page: Page): Promise<{ stops: string[]; hidden: string[]; canvas: number }> {
  await page.getByRole("button", { name: /^Notifications\b/ }).focus();
  const stops: string[] = [];
  const hidden: string[] = [];
  let canvas = 0;
  for (let press = 0; press < 12 && stops.at(-1) !== "Zoom in"; press++) {
    await page.keyboard.press("Tab");
    // Past the reveal's glide and the shell's next look at what the sheet covers.
    await page.waitForTimeout(450);
    const state = await page.evaluate(focusState);
    stops.push(state.name);
    if (await page.evaluate(() => document.activeElement?.closest(".react-flow__renderer") != null)) {
      canvas += 1;
      if (state.covered === state.points || state.middle) hidden.push(`${state.name} ${state.covered}/${state.points}`);
    }
  }
  return { stops, hidden, canvas };
}

async function openReview(page: Page, at: (path: string) => string): Promise<void> {
  await page.goto(at("diagrams/fulfilment.mmd"));
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.getByRole("button", { name: /^Notifications\b/ }).click();
  await expect(page.getByRole("region", { name: "Project Review" })).toBeVisible();
  await page.waitForTimeout(600);
}

test("a RS2-01: at 390×844 with the review sheet open, Tab through the canvas never loses focus to the page, and no focused node or edge is hidden under the sheet", async ({
  browser,
}, testInfo) => {
  const { page, at } = await open(browser, phone(390, 844));
  await openReview(page, at);
  const { stops, hidden } = await tabThroughCanvas(page);
  await page.screenshot({ path: testInfo.outputPath("review-tab-390.png") });
  expect(stops, stops.join(" | ")).not.toContain("BODY");
  expect(stops).toContain("Zoom in");
  expect(hidden).toEqual([]);
});

test("b C-19: at 1000×800 a Tab-focused edge behind the key panel is panned into the clear", async ({
  browser,
}, testInfo) => {
  const { page, at } = await open(browser, { viewport: { width: 1000, height: 800 }, reducedMotion: "reduce" });
  await page.goto(at("diagrams/system-context.mmd"));
  await expect(page.locator('.react-flow__node[tabindex="0"]')).toBeVisible();
  await expect(page.getByRole("region", { name: "Diagram Key", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).focus();
  let edge: { name: string; covered: number; points: number } | null = null;
  for (let press = 0; press < 14 && edge === null; press++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => document.activeElement?.classList.contains("react-flow__edge") === true)) {
      await page.waitForTimeout(300);
      edge = await page.evaluate(focusState);
    }
  }
  await page.screenshot({ path: testInfo.outputPath("edge-focus-1000.png") });
  expect(edge, "Tab reached an edge").not.toBeNull();
  expect(edge!.covered, `${edge!.name}: covered points`).toBe(0);
});

for (const [width, height] of [
  [390, 844],
  [320, 640],
] as const)
  test(`c C-21: at ${width}×${height} with touch, revision compare leaves every canvas control that takes focus uncovered`, async ({
    browser,
  }, testInfo) => {
    const { page, at } = await open(browser, phone(width, height));
    await page.goto(at("diagrams/fulfilment.mmd"));
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await page.getByRole("button", { name: "Export, compare and more", exact: true }).click();
    await page.getByRole("button", { name: "Compare revisions", exact: true }).click();
    const panel = page.locator("#archer-comparison-panel");
    await expect(panel).toBeVisible();
    await page.getByRole("button", { name: /^Notifications\b/ }).focus();
    const covered: string[] = [];
    let controls = 0;
    for (let press = 0; press < 30; press++) {
      await page.keyboard.press("Tab");
      const stop = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        if (active === null || active.closest(".react-flow__controls") === null) return null;
        const box = active.getBoundingClientRect();
        let under = 0;
        for (let i = 0; i <= 4; i++)
          for (let j = 0; j <= 4; j++) {
            const hit = document.elementFromPoint(box.left + (box.width * i) / 4, box.top + (box.height * j) / 4);
            if (hit?.closest("#archer-comparison-panel")) under += 1;
          }
        return { name: active.getAttribute("aria-label") ?? active.textContent ?? "", under };
      });
      if (stop === null) continue;
      controls += 1;
      if (stop.under > 0) covered.push(`${stop.name} ${stop.under}/25`);
    }
    await page.screenshot({ path: testInfo.outputPath(`compare-${width}.png`) });
    expect(controls, "Tab reached the canvas controls").toBeGreaterThan(3);
    expect(covered).toEqual([]);
    // The panel still fits its content: nothing scrolls sideways, and its fields keep a usable width.
    expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect((await panel.getByRole("textbox").first().boundingBox())!.width).toBeGreaterThanOrEqual(180);
  });

// Row d, G7 [H] (the edge caption's More ⓘ as a 44×44 target) is superseded: the ⓘ control is gone and a relationship's technology and description are drawn
// inline on the caption plate (decided 2026-10-31; `edge-detail-inline.e2e.ts`).

test("f V1: the canvas lettering is on named tokens, at the sizes it had", async ({ browser }) => {
  const { page, at } = await open(browser, { viewport: { width: 1500, height: 900 } });
  const expected: Record<string, [string, number]> = {
    "diagrams/checkout.mmd": [".archer-seq-participant text", 13],
    "diagrams/buying-a-book.mmd": [".archer-journey-task-label", 13.5],
    // A frame's caption is 14px since the redesign (slice 4, owner-requested): read from the layout's constant, which
    // the `--type-canvas-frame` token states (type-ramp.test.ts holds them equal).
    "diagrams/deployment.mmd": [".archer-frame-caption", FRAME_CAPTION_FONT_PX],
  };
  for (const [path, [selector, size]] of Object.entries(expected)) {
    await page.goto(at(path));
    // A group's frame and its caption are drawn once it is opened.
    if (selector === ".archer-frame-caption") {
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      await page.getByRole("button", { name: "Open Hosting Region", exact: true }).click();
    }
    await expect(page.locator(selector).first()).toBeVisible();
    expect(
      await page
        .locator(selector)
        .first()
        .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
      `${path} ${selector}`,
    ).toBe(size);
    const census = await measureTokens(page);
    expect(
      census.offScale
        .filter((run) => [FRAME_CAPTION_FONT_PX, 13, 13.5].includes(run.fontSizePx))
        .map((run) => `${run.fontSizePx}px`),
      path,
    ).toEqual([]);
  }
});
