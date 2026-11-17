// Round 1 (UI/UX) fixes, pass 7, batch F26: states and contrast (G5-F1, F3, F4, F5). Every check here
// reads the composited page's pixels (a screenshot decoded below), in both themes, because the findings
// were measured that way: a computed colour cannot say what a fill-only state looks like next to its
// panel. The Pageturner corpus, served from this checkout's build (`ARCHER_PAGE`, else ui/dist).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { grab, mode, park, ratio, stateCue, type Rgb } from "./support/pixels";
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
let context: BrowserContext | undefined;
test.afterEach(async () => {
  await context?.close();
  context = undefined;
  await project?.stop();
  project = undefined;
});

type Theme = "light" | "dark";
type Opened = { readonly page: Page; readonly at: (path: string) => string };
async function open(browser: Browser, options: BrowserContextOptions, highlights = false): Promise<Opened> {
  project = await sharedTsProject({ files: corpus("pageturner"), beforeAttach: commit });
  if (highlights)
    await project.setEmphasis("containers", [
      JSON.parse(readFileSync(join(CORPUS, "pageturner/.devkit/emphasis.json"), "utf8")),
    ]);
  context = await browser.newContext({ reducedMotion: "reduce", ...options });
  const page = await context.newPage();
  if (process.env.F26_DEBUG) page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  await page.goto((await project.issueAccess("round1-f26")).url);
  const origin = new URL(project.url).origin;
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  return { page, at: (path) => `${origin}/projects/${slug}/${path}` };
}

/** The darkest/lightest glyph pixel of a text box against the box's own ground: text contrast as painted. */
async function textInk(page: Page, box: { x: number; y: number; width: number; height: number }): Promise<number> {
  const img = await grab(page, box);
  const all: Rgb[] = [];
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) all.push(img.get(x, y));
  const ground = mode(all);
  return Math.max(...all.map((px) => ratio(px, ground)));
}

const themes: readonly Theme[] = ["light", "dark"];
/** With F26_DEBUG set, print a measurement (for the before/after table in the batch's report). */
const report = (what: string, value: unknown): void => {
  if (process.env.F26_DEBUG) console.log("F26", what, JSON.stringify(value));
};
/** With F26_SHOTS set to a folder, keep a picture of the state measured. */
const shot = async (
  page: Page,
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<void> => {
  if (process.env.F26_SHOTS)
    await page.screenshot({ path: join(process.env.F26_SHOTS, `${name}.png`), ...(clip ? { clip } : {}) });
};

// ---- G5-F1 ------------------------------------------------------------------------------------------
for (const theme of themes)
  for (const [width, height] of [
    [1500, 900],
    [1000, 800],
  ] as const) {
    test(`G5-F1: at ${width} in ${theme}, every pressed or selected control shows its state at 3:1 beside the panel and its own fill`, async ({
      browser,
    }) => {
      const { page, at } = await open(browser, { viewport: { width, height }, colorScheme: theme }, true);
      await page.goto(at("diagrams/containers.mmd"));
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      const cues: Record<string, number> = {};
      const highlights = page.locator(".archer-diagram-modes button[aria-pressed='true']").first();
      await expect(highlights).toHaveText(/^Highlights/);
      cues["Highlights mode"] = await stateCue(page, highlights);
      const one = page.locator(".archer-emph-legend-mode button[aria-pressed='true']").first();
      await expect(one).toBeVisible();
      cues["legend One"] = await stateCue(page, one);
      cues["Hand mode"] = await stateCue(page, page.locator(".archer-pan-select-button[aria-pressed='true']").first());

      await page
        .locator(".archer-diagram-modes button")
        .filter({ hasText: /^Walkthroughs?\b/ })
        .first()
        .click();
      const choice = page
        .getByRole("group", { name: "Walkthroughs on this diagram", exact: true })
        .getByRole("button")
        .first();
      if (await choice.isVisible().catch(() => false)) await choice.click();
      const follow = page.locator(".archer-walk-follow[aria-pressed='true']").first();
      await expect(follow).toBeVisible();
      cues["Follow steps"] = await stateCue(page, follow);
      cues["Walkthroughs mode"] = await stateCue(
        page,
        page.locator(".archer-diagram-modes button[aria-pressed='true']").first(),
      );
      const tab = page.locator(".archer-walk-tabs button[aria-selected='true']").first();
      await expect(tab).toBeVisible();
      cues["walkthrough tab"] = await stateCue(page, tab);

      const chat = page.locator(".archer-chat-fab").first();
      await chat.click();
      const scope = page.locator(".archer-chat-switch button[aria-pressed='true']").first();
      await expect(scope).toBeVisible();
      cues["Chat switch"] = await stateCue(page, scope);

      report(`F1 ${width} ${theme}`, cues);
      await shot(page, `F1-${width}-${theme}`);
      const weak = Object.entries(cues)
        .filter(([, r]) => r < 3)
        .map(([name, r]) => `${name} ${r.toFixed(2)}`);
      expect(weak, JSON.stringify(cues)).toEqual([]);
    });
  }

// ---- G5-F3 ------------------------------------------------------------------------------------------
for (const theme of themes)
  test(`G5-F3: in ${theme}, the New diagram Name placeholder is painted at 4.5:1`, async ({ browser }) => {
    const { page, at } = await open(browser, { viewport: { width: 1500, height: 900 }, colorScheme: theme });
    await page.goto(at(""));
    await page.getByRole("button", { name: /^New/ }).first().click();
    await page
      .getByRole("menuitem", { name: /Diagram/ })
      .first()
      .click();
    const name = page.locator(".authoring-name-input").first();
    await expect(name).toBeVisible();
    await expect(name).toHaveValue("");
    await name.evaluate((el: HTMLInputElement) => el.blur());
    const b = (await name.boundingBox())!;
    // Inside the border: the placeholder on the field's own fill.
    const ink = await textInk(page, { x: b.x + 3, y: b.y + 3, width: b.width - 6, height: b.height - 6 });
    report(`F3 ${theme}`, ink);
    await shot(page, `F3-${theme}`, { x: b.x - 20, y: b.y - 20, width: b.width + 40, height: b.height + 40 });
    expect(ink).toBeGreaterThanOrEqual(4.5);
  });

// ---- G5-F4 ------------------------------------------------------------------------------------------
for (const theme of themes)
  test(`G5-F4: in ${theme}, a keyboard-focused edge has a solid indicator at 3:1 against the canvas on both sides of its line`, async ({
    browser,
  }) => {
    const { page, at } = await open(browser, { viewport: { width: 1500, height: 900 }, colorScheme: theme });
    await page.goto(at("diagrams/system-context.mmd"));
    const edge = page.locator(".react-flow__edge[tabindex]").first();
    await expect(edge).toBeAttached();
    // A point on the line clear of its caption (which sits on the middle), and its normal, in page pixels.
    const geo = await edge.evaluate((g) => {
      const path = g.querySelector("path.react-flow__edge-path") as SVGPathElement;
      const len = path.getTotalLength();
      const toPage = (p: DOMPoint): { x: number; y: number } => {
        const q = p.matrixTransform(path.getScreenCTM()!);
        return { x: q.x, y: q.y };
      };
      const a = toPage(path.getPointAtLength(len * 0.15)),
        c = toPage(path.getPointAtLength(len * 0.15 + 2));
      const n = Math.hypot(c.x - a.x, c.y - a.y);
      return { x: a.x, y: a.y, nx: -(c.y - a.y) / n, ny: (c.x - a.x) / n };
    });
    const r = 14;
    const clip = { x: geo.x - r - 2, y: geo.y - r - 2, width: 2 * r + 4, height: 2 * r + 4 };
    await park(page);
    const before = await grab(page, clip);
    await page.keyboard.press("Shift");
    await edge.focus();
    await expect(edge.locator("xpath=self::*[contains(@class,'archer-kbd-focus')]")).toHaveCount(1);
    const after = await grab(page, clip);
    // Along the normal, each side of the line: the strongest change of a pixel between unfocused and focused.
    const ox = geo.x - Math.floor(clip.x),
      oy = geo.y - Math.floor(clip.y);
    const side = (sign: 1 | -1): number => {
      let best = 0;
      for (let t = 2; t <= r; t++) {
        const x = Math.round(ox + sign * t * geo.nx),
          y = Math.round(oy + sign * t * geo.ny);
        best = Math.max(best, ratio(before.get(x, y), after.get(x, y)));
      }
      return best;
    };
    report(`F4 ${theme}`, [side(1), side(-1)]);
    await shot(page, `F4-${theme}`, { x: 60, y: 110, width: 520, height: 230 });
    expect(Math.min(side(1), side(-1))).toBeGreaterThanOrEqual(3);
  });

// ---- G5-F5 ------------------------------------------------------------------------------------------
for (const theme of themes)
  test(`G5-F5: in ${theme}, the pressed Mermaid Source toggle shows its state at 3:1`, async ({ browser }) => {
    const { page, at } = await open(browser, { viewport: { width: 1500, height: 900 }, colorScheme: theme });
    await page.goto(at("diagrams/fulfilment.mmd?edit"));
    await expect(page.locator(".authoring-workspace").first()).toBeVisible();
    const source = page.locator(".archer-reader-source").first();
    if ((await source.getAttribute("aria-pressed")) !== "true") await source.click();
    await expect(source).toHaveAttribute("aria-pressed", "true");
    const cue = await stateCue(page, source);
    report(`F5 ${theme}`, cue);
    const sb = (await source.boundingBox())!;
    await shot(page, `F5-${theme}`, { x: sb.x - 30, y: sb.y - 30, width: sb.width + 60, height: sb.height + 60 });
    expect(cue).toBeGreaterThanOrEqual(3);
  });
