// Round 1 (UI/UX) fixes, pass 8, batch F29: state cues and focus (R6-claude-01..06, -08). Each check reads
// the composited page's pixels, in both themes at 1500 and 1000, because the findings were measured that way:
// a ring drawn at a quarter strength, or a focus outline clipped by its group, has the right computed colour.
// The Pageturner corpus, served from this checkout's build (`ARCHER_PAGE`, else ui/dist).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { grab, mode, park, ratio, stateCue, type Pixels, type Rgb } from "./support/pixels";
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
  await page.goto((await project.issueAccess("round1-f29")).url);
  const origin = new URL(project.url).origin;
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  return { page, at: (path) => `${origin}/projects/${slug}/${path}` };
}

/** With F29_DEBUG set, print a measurement (for the before/after table in the batch's report). */
const report = (what: string, value: unknown): void => {
  if (process.env.F29_DEBUG) console.log("F29", what, JSON.stringify(value));
};
/** With F29_SHOTS set to a folder, keep a picture of the state measured. */
const shot = async (
  page: Page,
  name: string,
  clip: { x: number; y: number; width: number; height: number },
): Promise<void> => {
  if (process.env.F29_SHOTS) await page.screenshot({ path: join(process.env.F29_SHOTS, `${name}.png`), clip });
};

type Box = { x: number; y: number; width: number; height: number };
const around = (b: Box, m: number): Box => ({
  x: Math.floor(b.x - m),
  y: Math.floor(b.y - m),
  width: Math.ceil(b.width + 2 * m),
  height: Math.ceil(b.height + 2 * m),
});

/** A point on an edge's line, clear of its caption, and the line's normal there, in page pixels. */
async function lineAt(edge: Locator): Promise<{ x: number; y: number; nx: number; ny: number }> {
  return await edge.evaluate((g) => {
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
}
/** Where the line comes to rest after a focus pan. */
async function settled(page: Page, edge: Locator): Promise<{ x: number; y: number; nx: number; ny: number }> {
  let geo = await lineAt(edge);
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(50);
    const next = await lineAt(edge);
    if (Math.hypot(next.x - geo.x, next.y - geo.y) < 0.1) break;
    geo = next;
  }
  return geo;
}
/** Along the line's normal, each side: the strongest change of a pixel between two pictures, from `from` px out. */
function change(
  before: Pixels,
  after: Pixels,
  clip: Box,
  geo: { x: number; y: number; nx: number; ny: number },
  from: number,
  to: number,
): number {
  const ox = geo.x - clip.x,
    oy = geo.y - clip.y;
  const side = (sign: 1 | -1): number => {
    let best = 0;
    for (let t = from; t <= to; t += 0.5) {
      const x = Math.round(ox + sign * t * geo.nx),
        y = Math.round(oy + sign * t * geo.ny);
      best = Math.max(best, ratio(before.get(x, y), after.get(x, y)));
    }
    return best;
  };
  return Math.min(side(1), side(-1));
}

const themes: readonly Theme[] = ["light", "dark"];
const sizes = [
  [1500, 900],
  [1000, 800],
] as const;

// ---- R6-claude-01, -02, -08: the drawing's edges, and the mode buttons ----------------------------------
for (const theme of themes)
  for (const [width, height] of sizes) {
    test(`R6-claude-01: at ${width} in ${theme}, a focused dimmed edge's ring is 3:1 against the canvas, as on any edge`, async ({
      browser,
    }) => {
      const { page, at } = await open(browser, { viewport: { width, height }, colorScheme: theme });
      await page.goto(at("diagrams/containers.mmd?walkthrough=checkout-tour&step=1"));
      const edge = page.locator(".react-flow__edge.archer-dimmed[tabindex]").first();
      await expect(edge).toBeAttached();
      await edge.scrollIntoViewIfNeeded().catch(() => undefined);
      await park(page);
      await page.keyboard.press("Shift");
      await edge.focus();
      await expect(edge).toHaveClass(/archer-kbd-focus/);
      // Focus pans the line clear of the panels: measure where it settles.
      const geo = await settled(page, edge);
      const clip = around({ x: geo.x, y: geo.y, width: 0, height: 0 }, 16);
      const img = await grab(page, clip);
      // The ring against the canvas it lies on: 2px of `--kbd-focus` beyond a 1.5px band, outside the line.
      const all: Rgb[] = [];
      for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) all.push(img.get(x, y));
      const ground = mode(all);
      const ox = geo.x - clip.x,
        oy = geo.y - clip.y;
      const side = (sign: 1 | -1): number => {
        let best = 0;
        for (let t = 2.5; t <= 7; t += 0.5)
          best = Math.max(
            best,
            ratio(img.get(Math.round(ox + sign * t * geo.nx), Math.round(oy + sign * t * geo.ny)), ground),
          );
        return best;
      };
      const ring = Math.min(side(1), side(-1));
      report(`01 ${width} ${theme}`, ring);
      await shot(page, `01-${width}-${theme}`, around({ x: geo.x, y: geo.y, width: 0, height: 0 }, 60));
      expect(ring).toBeGreaterThanOrEqual(3);
    });

    test(`R6-claude-02: at ${width} in ${theme}, a selected edge (Hand mode, Space) shows its state at 3:1`, async ({
      browser,
    }) => {
      const { page, at } = await open(browser, { viewport: { width, height }, colorScheme: theme });
      await page.goto(at("diagrams/containers.mmd"));
      const edge = page.locator(".react-flow__edge[tabindex]").first();
      await expect(edge).toBeAttached();
      await park(page);
      await page.keyboard.press("Shift");
      // Focus once first, so its pan is over before the picture of the resting line.
      await edge.focus();
      const geo = await settled(page, edge);
      await edge.evaluate((g) => (g as unknown as HTMLElement).blur());
      await expect(edge).not.toHaveClass(/archer-kbd-focus/);
      const clip = around({ x: geo.x, y: geo.y, width: 0, height: 0 }, 16);
      const before = await grab(page, clip);
      await edge.focus();
      await page.keyboard.press("Space");
      await expect(edge).toHaveAttribute("aria-pressed", "true");
      // Unfocused, so only the selection is measured.
      await edge.evaluate((g) => (g as unknown as HTMLElement).blur());
      await expect(edge).not.toHaveClass(/archer-kbd-focus/);
      await expect(edge).toHaveAttribute("aria-pressed", "true");
      const now = await settled(page, edge);
      expect(Math.hypot(now.x - geo.x, now.y - geo.y), "the line did not move between the pictures").toBeLessThan(0.5);
      const after = await grab(page, clip);
      // Just outside the resting 2px line, each side: canvas before, the selected 6px line after.
      const cue = change(before, after, clip, geo, 1, 4);
      report(`02 ${width} ${theme}`, cue);
      await shot(page, `02-${width}-${theme}`, around({ x: geo.x, y: geo.y, width: 0, height: 0 }, 60));
      expect(cue).toBeGreaterThanOrEqual(3);
    });

    // Geometry only: the dark token set changes colours and shadows, never a dimension, so light at both widths is enough.
    if (theme === "light")
      test(`R6-claude-08: at ${width} in ${theme}, Highlights and Walkthroughs are one height`, async ({ browser }) => {
        const { page, at } = await open(browser, { viewport: { width, height }, colorScheme: theme }, true);
        await page.goto(at("diagrams/containers.mmd"));
        const modes = page.locator(".archer-diagram-modes button");
        await expect(modes).toHaveCount(2);
        const heights = (): Promise<number[]> =>
          modes.evaluateAll((all) => all.map((b) => b.getBoundingClientRect().height));
        await expect
          .poll(async () => {
            const [a, b] = await heights();
            return a === b;
          })
          .toBe(true);
        report(`08 ${width} ${theme}`, await heights());
        await shot(
          page,
          `08-${width}-${theme}`,
          around((await page.locator(".archer-diagram-modes").boundingBox())!, 8),
        );
      });
  }

// ---- R6-claude-03: the editor toolbar ---------------------------------------------------------------------
for (const theme of themes)
  for (const [width, height] of sizes) {
    test(`R6-claude-03: at ${width} in ${theme}, a pressed editor tool shows its state at 3:1`, async ({ browser }) => {
      const { page, at } = await open(browser, { viewport: { width, height }, colorScheme: theme });
      await page.goto(at("diagrams/fulfilment.mmd?edit"));
      await expect(page.locator(".authoring-workspace").first()).toBeVisible();
      // No wait for the header's presence line: its row is held from the editor's first frame (O176, tested below).
      const cues: Record<string, number> = {};
      for (const name of [/Structure and properties/i, /Move selected/i]) {
        // Move works on a selected shape.
        if (String(name).includes("Move")) await page.locator(".authoring-workspace .react-flow__node").first().click();
        const tool = page.locator(".authoring-edit-cluster").getByRole("button", { name });
        await expect(tool).toBeVisible();
        if ((await tool.getAttribute("aria-pressed")) !== "true") await tool.click();
        await expect(tool).toHaveAttribute("aria-pressed", "true");
        cues[String(name)] = await stateCue(page, tool);
        await shot(
          page,
          `03-${String(name).replace(/\W+/g, "")}-${width}-${theme}`,
          around((await tool.boundingBox())!, 24),
        );
      }
      report(`03 ${width} ${theme}`, cues);
      expect(Object.entries(cues).filter(([, r]) => r < 3)).toEqual([]);
    });
  }

// O209: the cluster used to list its family's tools only once the preview compiled, a moment after the editor
// was shown, so Structure and properties jumped 152 px right under the pointer and R6-claude-03 measured where it
// had been. Watched every frame from the first one that shows it, with the preview held back: it stays put.
test("O209: the editor's tools keep their places while the preview lands", async ({ browser }) => {
  const { page, at } = await open(browser, { viewport: { width: 1500, height: 900 }, colorScheme: "light" });
  await page.addInitScript(() => {
    const xs: number[] = [];
    (window as unknown as { structureXs: number[] }).structureXs = xs;
    const watch = (): void => {
      const x = document
        .querySelector('.authoring-edit-cluster [aria-label="Structure and properties"]')
        ?.getBoundingClientRect().x;
      if (x !== undefined && xs.at(-1) !== x) xs.push(x);
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/preview(\?|$)/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(at("diagrams/fulfilment.mmd?edit"));
  const cluster = page.locator(".authoring-edit-cluster");
  await expect(cluster.getByRole("button", { name: /Structure and properties/i })).toBeVisible();
  // Before the preview: the flowchart's tools are there, waiting for it.
  await expect(cluster.getByRole("button", { name: /Move selected/i })).toBeDisabled();
  release();
  await expect(page.locator(".authoring-workspace .react-flow__node").first()).toBeVisible();
  await page.locator(".authoring-workspace .react-flow__node").first().click();
  await expect(cluster.getByRole("button", { name: /Move selected/i })).toBeEnabled();
  expect(await page.evaluate(() => (window as unknown as { structureXs: number[] }).structureXs)).toHaveLength(1);
});

// O176: the header's presence line ("Changed on disk · time") waits for the stage's drawing, which can land after
// the in-place editor is shown; the header's row then arrived and pushed the whole editor down 28 px. Watched every
// frame from the first one that shows the editor, with the drawing held back: its top stays put.
test("O176: the in-place editor keeps its top while the presence line arrives", async ({ browser }) => {
  const { page, at } = await open(browser, { viewport: { width: 1500, height: 900 }, colorScheme: "light" });
  await page.addInitScript(() => {
    const tops: number[] = [];
    (window as unknown as { editorTops: number[] }).editorTops = tops;
    const watch = (): void => {
      const top = document.querySelector(".authoring-workspace")?.getBoundingClientRect().top;
      if (top !== undefined && tops.at(-1) !== top) tops.push(top);
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  // The line waits for the stage's drawing behind the editor; holding the layout worker holds that drawing.
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/-\/page-assets\/[^/]*worker/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto(at("diagrams/fulfilment.mmd?edit"));
  await expect(page.locator(".authoring-workspace").first()).toBeVisible();
  await expect(page.locator(".archer-presence")).toHaveCount(0);
  release();
  await expect(page.locator(".archer-presence")).toContainText(/^Changed on disk · /);
  await expect(page.locator(".authoring-workspace .react-flow__node").first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { editorTops: number[] }).editorTops)).toHaveLength(1);
});

// ---- R6-claude-04..06: segmented controls -------------------------------------------------------------------
/** The pixel `d` px outward from a box's side, at the side's middle (negative: inward). */
type Side = "left" | "right" | "top" | "bottom";
function onSide(img: Pixels, clip: Box, b: Box, side: Side, d: number): Rgb {
  const cx = Math.round(b.x + b.width / 2 - clip.x),
    cy = Math.round(b.y + b.height / 2 - clip.y);
  const left = Math.round(b.x - clip.x),
    right = Math.round(b.x + b.width - clip.x) - 1,
    top = Math.round(b.y - clip.y),
    bottom = Math.round(b.y + b.height - clip.y) - 1;
  return side === "left"
    ? img.get(left - d, cy)
    : side === "right"
      ? img.get(right + d, cy)
      : side === "top"
        ? img.get(cx, top - d)
        : img.get(cx, bottom + d);
}
/** How many px, from 2 inside to 6 outside a side, change by 3:1 between two pictures: the width of a ring. */
function ringWidth(before: Pixels, after: Pixels, clip: Box, b: Box, side: Side): number {
  let n = 0;
  for (let d = -2; d <= 6; d++) if (ratio(onSide(before, clip, b, side, d), onSide(after, clip, b, side, d)) >= 3) n++;
  return n;
}
async function focusRing(page: Page, control: Locator, sides: readonly Side[]): Promise<Record<Side, number>> {
  await control.scrollIntoViewIfNeeded();
  await park(page);
  const b = (await control.boundingBox())!;
  const clip = around(b, 10);
  const before = await grab(page, clip);
  await page.keyboard.press("Shift");
  await control.focus();
  await expect(control).toBeFocused();
  const after = await grab(page, clip);
  return Object.fromEntries(sides.map((s) => [s, ringWidth(before, after, clip, b, s)])) as Record<Side, number>;
}
/**
 * On a pressed segment's outer side, going outward from the accent edge: the next pixel is already the panel
 * (no grey border line between them). Returns that pixel's contrast against the panel 6px out.
 */
async function strayLine(page: Page, control: Locator, side: Side): Promise<number> {
  await park(page);
  const b = (await control.boundingBox())!;
  const clip = around(b, 10);
  const img = await grab(page, clip);
  const outside = onSide(img, clip, b, side, 6);
  let d = -3;
  // Out to the last pixel of the accent edge (3:1 on the panel), then one more.
  while (
    d < 4 &&
    !(ratio(onSide(img, clip, b, side, d), outside) >= 3 && ratio(onSide(img, clip, b, side, d + 1), outside) < 3)
  )
    d++;
  return ratio(onSide(img, clip, b, side, d + 1), outside);
}

for (const theme of themes)
  for (const [width, height] of sizes) {
    test(`R6-claude-04..06: at ${width} in ${theme}, segmented controls ring focus whole and apart from pressed, with one clean edge`, async ({
      browser,
    }) => {
      const { page, at } = await open(browser, { viewport: { width, height }, colorScheme: theme }, true);
      await page.goto(at("diagrams/containers.mmd"));
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      const out: Record<string, unknown> = {};

      // 05 and 06 on the legend's One (pressed, the group's first segment).
      const one = page.locator(".archer-emph-legend-mode button[aria-pressed='true']").first();
      await expect(one).toBeVisible();
      out["06 One left"] = await strayLine(page, one, "left");
      await shot(
        page,
        `06-one-${width}-${theme}`,
        around((await page.locator(".archer-emph-legend-mode").boundingBox())!, 8),
      );
      out["05 One"] = await focusRing(page, one, ["left", "top"]);
      await shot(
        page,
        `05-one-focused-${width}-${theme}`,
        around((await page.locator(".archer-emph-legend-mode").boundingBox())!, 8),
      );

      // The walkthrough tabs: the selected Steps tab.
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
      const tab = page.locator(".archer-walk-tabs button[aria-selected='true']").first();
      await expect(tab).toBeVisible();
      out["06 Steps left"] = await strayLine(page, tab, "left");
      await shot(
        page,
        `06-tabs-${width}-${theme}`,
        around((await page.locator(".archer-walk-tabs").boundingBox())!, 8),
      );
      out["05 Steps"] = await focusRing(page, tab, ["left", "top"]);

      // 04 on the chat scope switch: Whole project (its last segment, unpressed), rung on every side.
      await page.locator(".archer-chat-fab").first().click();
      const scope = page.locator(".archer-chat-switch button[aria-pressed='true']").first();
      await expect(scope).toBeVisible();
      out["06 chat pressed left"] = await strayLine(page, scope, "left");
      const whole = page.locator(".archer-chat-switch button").filter({ hasText: "Whole project" });
      out["04 Whole project"] = await focusRing(page, whole, ["left", "right", "top", "bottom"]);
      await shot(
        page,
        `04-chat-focused-${width}-${theme}`,
        around((await page.locator(".archer-chat-switch").boundingBox())!, 8),
      );

      report(`04-06 ${width} ${theme}`, out);
      const problems: string[] = [];
      for (const [name, v] of Object.entries(out)) {
        if (typeof v === "number") {
          if (v >= 1.5) problems.push(`${name}: a line beside the accent edge, ${v.toFixed(2)}:1`);
          continue;
        }
        for (const [side, w] of Object.entries(v as Record<string, number>))
          if (w < 2) problems.push(`${name} ${side}: ring ${w}px`);
      }
      expect(problems, JSON.stringify(out)).toEqual([]);
    });
  }
