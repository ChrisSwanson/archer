// Round 1 (UI/UX) fixes, pass 4, batch F13: canvas and comments. Each test names its row in the pass's fix
// list and the finding it answers. The Pageturner corpus, served from this checkout's build (`ARCHER_PAGE`,
// else ui/dist).
import { commentOperation } from "../support/comment-operations";
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

type Opened = { readonly page: Page; readonly at: (path: string) => string; readonly project: TsProject };
async function open(browser: Browser, options: BrowserContextOptions): Promise<Opened> {
  project = await sharedTsProject({ files: corpus("pageturner"), beforeAttach: commit });
  const context = await opened(browser, options);
  const page = await context.newPage();
  await page.goto((await project.issueAccess("round1-f13")).url);
  const origin = new URL(project.url).origin;
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  return { page, project, at: (path) => `${origin}/projects/${slug}/${path}` };
}
const phone = (width: number, height: number): BrowserContextOptions => ({
  viewport: { width, height },
  hasTouch: true,
  isMobile: true,
});

/** How many points of the focused element's box (a 5×5 grid) something else lies over, and whether its middle is covered. */
function focusState(): { name: string; covered: number; points: number; middle: boolean; drawing: boolean } {
  const active = document.activeElement;
  if (active === null || active === document.body)
    return { name: "BODY", covered: 0, points: 0, middle: false, drawing: false };
  const name = active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 40) ?? active.tagName;
  const box = active.getBoundingClientRect();
  const svg = active.closest("svg.archer-seq-svg");
  const isCovered = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return true;
    const hit = document.elementFromPoint(x, y);
    if (hit === null) return true;
    if (active.contains(hit) || hit.contains(active)) return false;
    // The drawing under a message's thin line (a lifeline, the ground) is not a cover.
    return !svg?.contains(hit);
  };
  let covered = 0,
    points = 0;
  for (let i = 0; i <= 4; i++)
    for (let j = 0; j <= 4; j++) {
      points += 1;
      if (isCovered(box.left + (box.width * i) / 4, box.top + (box.height * j) / 4)) covered += 1;
    }
  return {
    name,
    covered,
    points,
    middle: isCovered(box.left + box.width / 2, box.top + box.height / 2),
    drawing: svg !== null,
  };
}

for (const [width, height] of [
  [390, 844],
  [320, 640],
] as const)
  test(`row 1 R3-13: at ${width}×${height} with the review sheet open, Tab through the sequence brings each participant and message out from under the sheet`, async ({
    browser,
  }, testInfo) => {
    const { page, at } = await open(browser, { ...phone(width, height), reducedMotion: "reduce" });
    await page.goto(at("diagrams/checkout.mmd"));
    await expect(page.locator(".archer-seq-participant").first()).toBeVisible();
    await page.getByRole("button", { name: /^Notifications\b/ }).click();
    await expect(page.getByRole("region", { name: "Project Review" })).toBeVisible();
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: /^Notifications\b/ }).focus();
    const stops: string[] = [];
    const hidden: string[] = [];
    let drawing = 0;
    for (let press = 0; press < 16 && stops.at(-1) !== "Zoom in"; press++) {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(300);
      const state = await page.evaluate(focusState);
      stops.push(state.name);
      if (state.drawing) {
        drawing += 1;
        if (state.covered === state.points || state.middle)
          hidden.push(`${state.name} ${state.covered}/${state.points}`);
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`seq-review-${width}.png`) });
    expect(stops, stops.join(" | ")).not.toContain("BODY");
    expect(drawing, stops.join(" | ")).toBeGreaterThan(0);
    expect(hidden, stops.join(" | ")).toEqual([]);
    // Arrow keys move along the drawing the same way.
    await page.locator('.archer-seq-svg [data-seq-channel="messages"][tabindex="0"]').first().focus();
    for (let press = 0; press < 5; press++) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(200);
      const state = await page.evaluate(focusState);
      expect(state.covered === state.points || state.middle, `${state.name} ${state.covered}/${state.points}`).toBe(
        false,
      );
    }
  });

test("row 2 F46 / R3-04: Enter on Zoom in to the limit keeps focus on it, which says it is at the limit", async ({
  browser,
}) => {
  const { page, at } = await open(browser, { viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  await page.goto(at("diagrams/fulfilment.mmd"));
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  for (const name of ["Zoom in", "Zoom out"]) {
    const button = page.getByRole("button", { name, exact: true });
    await button.focus();
    for (let press = 0; press < 40 && (await button.getAttribute("aria-disabled")) !== "true"; press++)
      await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Enter");
    await expect(button).toBeFocused();
  }
});

test("row 3 F49 / R3-07, T01 / T18 / R3-08: the tools launcher names export and compare, and opening it leaves focus on it", async ({
  browser,
}) => {
  const { page, at } = await open(browser, { viewport: { width: 1280, height: 800 } });
  await page.goto(at("diagrams/fulfilment.mmd"));
  const launcher = page
    .getByRole("button", { name: /export/i })
    .filter({ hasText: "" })
    .and(page.locator(".archer-canvas-tools-trigger"));
  await expect(launcher).toHaveAccessibleName(/export.*compare/i);
  // Opened on the drawn diagram: an Enter landing as the loading launcher is swapped is O266, tested on its own.
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await launcher.focus();
  await page.keyboard.press("Enter");
  await expect(launcher).toBeFocused();
  await expect(launcher).toHaveAttribute("aria-expanded", "true");
  const actions = page.getByRole("group", { name: "Export, compare and more", exact: true });
  await page.keyboard.press("Tab");
  await expect(actions.getByRole("button").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await expect(launcher).toBeFocused();
});

test("row 4 F52 / R3-09, D7: a comment pin takes focus, Enter opens its thread, and Escape returns to the pin (also after a click)", async ({
  browser,
}) => {
  const {
    page,
    at,
    project: served,
  } = await open(browser, { viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  const origin = new URL(served.url).origin;
  await page.goto(at("diagrams/fulfilment.mmd"));
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  const response = await served.fetch("api/comments", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(
      commentOperation.create({
        target: "view:fulfilment",
        anchor: { kind: "node", id: "pick", label: "Pick from Shelf" },
        body: "How long does a pick take?",
      }),
    ),
  });
  const posted = response.status;
  expect(posted).toBeLessThan(300);
  await page.reload();
  const pin = page.getByRole("button", { name: /^Comment 1: /, exact: false });
  await expect(pin).toBeVisible();
  // Reached by Tab from the node it sits on.
  await page.locator('.react-flow__node[data-id="pick"]').focus();
  await page.keyboard.press("Tab");
  await expect(pin).toBeFocused();
  await page.keyboard.press("Enter");
  const discussion = page.getByRole("region", { name: "Contextual discussion" });
  await expect(discussion).toBeVisible();
  await expect.poll(() => discussion.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(discussion).toHaveCount(0);
  await expect(pin).toBeFocused();
  // The pointer path still opens it, and Escape returns to the pin too.
  await pin.click();
  await expect(discussion).toBeVisible();
  await expect.poll(() => discussion.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(pin).toBeFocused();
});

// Row 5, R3-16 (the caption's More mark on the icon scale) is superseded: the ⓘ control is gone and a relationship's technology and description are drawn
// inline on the caption plate (decided 2026-10-31; `edge-detail-inline.e2e.ts`).
