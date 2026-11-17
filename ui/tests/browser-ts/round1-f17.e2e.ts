// Round 1 (UI/UX) fixes, pass 5, batch F17: diagram fit and key. Each test names its row in the pass's fix
// list (fixes5.md) and the finding it answers. The Pageturner corpus, served from this checkout's build (`ARCHER_PAGE`,
// else ui/dist).
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
import { settled } from "./support/settled";
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
async function open(browser: Browser, options: BrowserContextOptions, highlights = false): Promise<Opened> {
  project = await sharedTsProject({ files: corpus("pageturner"), beforeAttach: commit });
  if (highlights)
    await project.setEmphasis("containers", [
      JSON.parse(readFileSync(join(CORPUS, "pageturner/.devkit/emphasis.json"), "utf8")),
    ]);
  const context = await opened(browser, options);
  const page = await context.newPage();
  await page.goto((await project.issueAccess("round1-f17")).url);
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
  test(`row R4-claude-08: at ${width}×${height} with the Highlights sheet open, Tab to the canvas nest toggle brings it out from under the sheet`, async ({
    browser,
  }, testInfo) => {
    const { page, at } = await open(browser, { ...phone(width, height), reducedMotion: "reduce" }, true);
    await page.goto(at("diagrams/containers.mmd"));
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await page
      .getByRole("button", { name: /^Highlights/ })
      .first()
      .click();
    await expect(page.locator(".archer-emph-legend").first()).toBeVisible();
    await settled(page);
    const stops: string[] = [];
    let toggle: ReturnType<typeof focusState> | null = null;
    for (let press = 0; press < 40 && toggle === null; press++) {
      await page.keyboard.press("Tab");
      await settled(page);
      const state = await page.evaluate(focusState);
      stops.push(state.name);
      // The highlights' boxes are inside the boundary, so their emphasis opened it once (J11-F1, 0.10.0): its toggle
      // now says Close.
      if (/^Close Pageturner Online Bookshop$/.test(state.name)) {
        await settled(page);
        toggle = await page.evaluate(focusState);
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`nest-toggle-${width}.png`) });
    expect(toggle, stops.join(" | ")).not.toBeNull();
    // As the nodes are (row 1 R3-13 in round1-f13): its middle in the clear, never wholly under the sheet. At 320 the
    // clear strip between the sheet and the canvas controls is shorter than the 44 px toggle, so only part of it shows.
    expect(toggle!.middle, `${toggle!.covered}/${toggle!.points}`).toBe(false);
    expect(toggle!.covered, `${toggle!.covered}/${toggle!.points}`).toBeLessThan(toggle!.points);
  });

for (const [width, height] of [
  [1500, 900],
  [1000, 800],
] as const)
  test(`row O4: at ${width}×${height} the opening framing and Fit view are made in the canvas left of the docked key`, async ({
    browser,
  }) => {
    const { page, at } = await open(browser, { viewport: { width, height }, reducedMotion: "reduce" });
    for (const diagram of ["containers", "system-context", "deployment", "data-model"]) {
      await page.goto(at(`diagrams/${diagram}.mmd`));
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      const key = page.locator('.archer-diagram-key[data-placement="panel"]');
      await expect(key).toBeVisible();
      for (const when of ["open", "fit"]) {
        if (when === "fit") await page.getByRole("button", { name: "Fit view", exact: true }).click();
        await settled(page);
        const seen = await page.evaluate(() => {
          const panel = document.querySelector(".archer-diagram-panel")!.getBoundingClientRect();
          const canvas = document.querySelector(".react-flow")!.getBoundingClientRect();
          const nodes = [...document.querySelectorAll(".react-flow__node")].map((n) => n.getBoundingClientRect());
          const past = nodes.filter((b) => b.right > canvas.right + 1).length;
          const cue = document.querySelector(".archer-offscreen")?.textContent ?? "";
          return { canvasRight: canvas.right, panelLeft: panel.left, past, cue };
        });
        // The canvas ends where the docked panel (and its key) begins: the framing never has room under the key.
        expect(seen.canvasRight, `${diagram} ${when}`).toBeLessThanOrEqual(seen.panelLeft + 7);
        // Whatever the framing leaves past the key's edge, the off-screen cue says so.
        if (seen.past > 0) expect(seen.cue, `${diagram} ${when}: ${seen.past} past the key`).toMatch(/to the right/);
      }
    }
  });

for (const [diagram, width, height] of [
  ["containers", 1000, 800],
  ["data-model", 1500, 900],
] as const)
  test(`row O4, AM-R1-02: at ${width}×${height} with the key docked, Fit view shows all of ${diagram}`, async ({
    browser,
  }, testInfo) => {
    const { page, at } = await open(browser, { viewport: { width, height }, reducedMotion: "reduce" });
    await page.goto(at(`diagrams/${diagram}.mmd`));
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(page.locator('.archer-diagram-key[data-placement="panel"]')).toBeVisible();
    await page.getByRole("button", { name: "Fit view", exact: true }).click();
    await settled(page);
    await page.screenshot({ path: testInfo.outputPath(`fit-${diagram}-${width}.png`) });
    const seen = await page.evaluate(() => {
      const canvas = document.querySelector(".react-flow")!.getBoundingClientRect();
      const panel = document.querySelector(".archer-diagram-panel")!.getBoundingClientRect();
      const out = [...document.querySelectorAll(".react-flow__node")]
        .map((n) => n.getBoundingClientRect())
        .filter(
          (b) =>
            b.left < canvas.left - 1 ||
            b.top < canvas.top - 1 ||
            b.right > Math.min(canvas.right, panel.left) + 1 ||
            b.bottom > canvas.bottom + 1,
        ).length;
      return { out, cue: document.querySelector(".archer-offscreen")?.textContent ?? "" };
    });
    expect(seen.out, seen.cue).toBe(0);
    expect(seen.cue).not.toMatch(/more to the right|more below/);
  });
