// Round 1 (UI/UX) fixes, pass 5, batch F16: the project page and the sidebar, from the owner's own review of
// the live build (O1–O3 in the round's fifth fixes list). The Pageturner corpus, served from this checkout's
// build (`ARCHER_PAGE`, else ui/dist).
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

type Opened = { readonly page: Page; readonly at: (path: string) => string; readonly origin: string };
async function open(browser: Browser, options: BrowserContextOptions = {}): Promise<Opened> {
  project = await sharedTsProject({ files: corpus("pageturner"), beforeAttach: commit });
  const context = await opened(browser, { viewport: { width: 1500, height: 900 }, ...options });
  const page = await context.newPage();
  await page.goto((await project.issueAccess("round1-f16")).url);
  const origin = new URL(project.url).origin;
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  return { page, at: (path) => `${origin}/projects/${slug}/${path}`, origin };
}

type Box = { x: number; y: number; width: number; height: number };
const filters = (page: Page) =>
  page.locator(".archer-search-bar").getByRole("button", { name: /^Filters(?: \(\d+\))?$/ });

/** The search field holds Search and then Filters at its trailing end: one row, both inside the field's border. */
async function expectFiltersInField(page: Page, width: number): Promise<void> {
  const input = page.getByRole("searchbox", { name: "Search projects and files" });
  const search = page.locator(".archer-search-bar").getByRole("button", { name: "Search", exact: true });
  const filter = filters(page);
  await expect(filter).toBeVisible();
  const field = (await input.boundingBox())!;
  const s = (await search.boundingBox())!,
    f = (await filter.boundingBox())!;
  const inside = (box: Box): boolean =>
    box.x >= field.x &&
    box.x + box.width <= field.x + field.width + 0.5 &&
    box.y >= field.y &&
    box.y + box.height <= field.y + field.height + 0.5;
  expect(inside(f), `Filters sits inside the search field at ${width}`).toBe(true);
  expect(inside(s), `Search sits inside the search field at ${width}`).toBe(true);
  expect(f.x, "Filters is the trailing control").toBeGreaterThanOrEqual(s.x + s.width);
  expect(field.x + field.width - (f.x + f.width), "Filters is at the field's trailing edge").toBeLessThanOrEqual(8);
  const middle = (box: Box): number => box.y + box.height / 2;
  expect(Math.abs(middle(f) - middle(field))).toBeLessThanOrEqual(1);
  const size = await page.evaluate(() => (matchMedia("(pointer: coarse)").matches ? 44 : 36));
  for (const control of [s, f]) {
    expect(control.width).toBe(size);
    expect(control.height).toBe(size);
  }
  // The typed text stops before the trailing controls.
  const textEnd = await input.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.right - parseFloat(getComputedStyle(element).paddingRight);
  });
  expect(textEnd).toBeLessThanOrEqual(s.x + 0.5);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    `no sideways scroll at ${width}`,
  ).toBe(true);
  // Keyboard order: the field, Search, then Filters.
  await input.focus();
  await page.keyboard.press("Tab");
  await expect(search).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(filter).toBeFocused();
}

test("O1: Filters sits inside the search field, trailing, on the project page and the all-projects page", async ({
  browser,
}) => {
  const { page, at, origin } = await open(browser);
  for (const width of [1500, 1000, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of [at(""), `${origin}/projects/`]) {
      await page.goto(path);
      await expectFiltersInField(page, width);
    }
  }
  // The count stays in its name, and Filters still opens the dialog.
  await page.goto(at(""));
  await filters(page).click();
  await expect(page.getByRole("dialog", { name: "Project Filters" })).toBeVisible();
});

test("O1: on a touch screen the in-field Search and Filters are 44px targets", async ({ browser }) => {
  const { page, at } = await open(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  await page.goto(at(""));
  await expectFiltersInField(page, 390);
});

/** Each top-level rail row's glyph centre and label start: Archer, Projects, Settings, Shortcuts. */
async function railRows(
  page: Page,
): Promise<Record<string, { glyph: number; glyphMiddle: number; label: number | null; labelMiddle: number | null }>> {
  return page.evaluate(() => {
    const rows: Record<string, [string, string, string]> = {
      Archer: [".primary-brand", "svg", "span"],
      Projects: [".primary-projects-heading", "svg", "span"],
      Settings: [".archer-settings-launcher", "svg", "span"],
      Shortcuts: [".primary-help", ".primary-help-glyph", ".primary-help-label"],
    };
    const out: Record<
      string,
      { glyph: number; glyphMiddle: number; label: number | null; labelMiddle: number | null }
    > = {};
    for (const [name, [row, glyph, label]] of Object.entries(rows)) {
      const element = document.querySelector(`.primary-rail ${row}`)!;
      const g = element.querySelector(glyph)!.getBoundingClientRect();
      const l = element.querySelector(label)!;
      const visible = getComputedStyle(l).display !== "none" && getComputedStyle(l).visibility !== "hidden";
      const range = document.createRange();
      range.selectNodeContents(l);
      const t = range.getBoundingClientRect();
      out[name] = {
        glyph: g.left + g.width / 2,
        glyphMiddle: g.top + g.height / 2,
        label: visible ? t.left : null,
        labelMiddle: visible ? t.top + t.height / 2 : null,
      };
    }
    return out;
  });
}

test("O2: Settings and Shortcuts line up with Archer and Projects in the rail, collapsed and expanded", async ({
  browser,
}) => {
  for (const scheme of ["light", "dark"] as const) {
    const { page, at } = await open(browser, { colorScheme: scheme, reducedMotion: "reduce" });
    for (const width of [1500, 1000]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(at(""));
      await expect(page.locator(".primary-help")).toBeVisible();
      await page.mouse.move(width - 20, 450);
      const collapsed = await railRows(page);
      // The rail's real pointer route: enter the collapsed rail, and it opens.
      await page.mouse.move(30, 400);
      await page.mouse.move(32, 410);
      await expect(page.locator(".primary-navigation")).toHaveAttribute("data-expanded", "true");
      await expect.poll(async () => (await railRows(page)).Shortcuts.label).not.toBeNull();
      const expanded = await railRows(page);
      for (const [state, rows] of [
        ["collapsed", collapsed],
        ["expanded", expanded],
      ] as const) {
        for (const name of ["Projects", "Settings", "Shortcuts"] as const) {
          expect(
            Math.abs(rows[name].glyph - rows.Archer.glyph),
            `${name} glyph centre, ${state}, ${width}, ${scheme}`,
          ).toBeLessThanOrEqual(0.5);
        }
      }
      for (const name of ["Projects", "Settings", "Shortcuts"] as const) {
        expect(
          Math.abs(expanded[name].label! - expanded.Archer.label!),
          `${name} label start, ${width}, ${scheme}`,
        ).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(expanded[name].glyph - collapsed[name].glyph),
          `${name} glyph stays put as the rail opens`,
        ).toBeLessThanOrEqual(0.5);
      }
      for (const name of ["Settings", "Shortcuts"] as const) {
        expect(
          Math.abs(expanded[name].labelMiddle! - expanded[name].glyphMiddle),
          `${name} label centred on its glyph`,
        ).toBeLessThanOrEqual(1.5);
      }
      // An expanded row's hover fill covers its label, not just the glyph.
      for (const selector of [".archer-settings-launcher", ".primary-help"]) {
        const covered = await page.locator(`.primary-rail ${selector}`).evaluate((button) => {
          const label = [...button.querySelectorAll("span")].at(-1)!;
          return label.getBoundingClientRect().right <= button.getBoundingClientRect().right + 0.5;
        });
        expect(covered, `${selector} contains its label when expanded`).toBe(true);
      }
      await page.mouse.move(width - 20, 450);
      await expect(page.locator(".primary-navigation")).toHaveAttribute("data-expanded", "false");
    }
    await project?.stop();
    project = undefined;
  }
});

test("O3: the Folders headings each stay on one line, at normal text size and with the browser's text size doubled", async ({
  browser,
}) => {
  const { page, at } = await open(browser);
  // The browser's own text size (the root's font size) doubled: the rem columns grow with it.
  for (const [width, root] of [
    [1500, ""],
    [1000, ""],
    [1500, "200%"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(at(""));
    await page.getByRole("tab", { name: /^Folders/ }).click();
    await expect(page.locator(".archer-folder-tree-head")).toBeVisible();
    await page.evaluate((size) => {
      document.documentElement.style.fontSize = size;
    }, root);
    const wrapped = await page.locator(".archer-folder-tree-heading").evaluateAll((cells) =>
      cells.flatMap((cell) => {
        const label = cell.querySelector(".archer-files-sort")!;
        // The label's words only (not its sort mark): one line box each, or it wrapped.
        const words = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
        const rects: DOMRect[] = [];
        for (let node = words.nextNode(); node !== null; node = words.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          rects.push(...[...range.getClientRects()].filter((rect) => rect.width > 0));
        }
        const lines = new Set(rects.map((rect) => Math.round(rect.top)));
        const text = { right: Math.max(...rects.map((rect) => rect.right)) };
        const box = cell.getBoundingClientRect();
        const problems: string[] = [];
        if (lines.size > 1) problems.push(`${cell.getAttribute("data-column")} wraps onto ${lines.size} lines`);
        if (text.right > box.right + 12.5) problems.push(`${cell.getAttribute("data-column")} runs out of its column`);
        return problems;
      }),
    );
    expect(wrapped, `at ${width}, root ${root || "normal"}`).toEqual([]);
  }
});
