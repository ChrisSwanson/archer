// Round 1 (UI/UX) fixes, batch F3: shell layout, targets and overlays. Each test names its row in
// the round's fixes list and the rubric criterion it answers (docs/quality/rubrics/ui-ux.md, v1).
// The Pageturner corpus, served from this checkout's build (`ARCHER_PAGE`, else ui/dist).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
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
// @ts-expect-error the harness is plain JavaScript
import { censusPage } from "../../../tools/devkit/harness/targets.mjs";
import { sharedTsProject } from "./support/shared-service";

const CORPUS = resolve(import.meta.dirname, "../../../tools/devkit/corpus/pageturner");
const BROKEN = ".archer/diagrams/deep/er/still/broken.mmd";

function corpus(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(CORPUS, path)] = readFileSync(path, "utf8");
    }
  };
  walk(CORPUS);
  // A diagram that does not compile (an edge without an id), three folders down.
  out[BROKEN] = "flowchart LR\n  a[One] --> b[Two]\n";
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
async function open(browser: Browser, context: BrowserContextOptions, git = false): Promise<Opened> {
  project = await sharedTsProject({ files: corpus(), ...(git ? { beforeAttach: commit } : {}) });
  const page = await (await opened(browser, context)).newPage();
  await page.goto((await project.issueAccess("round1-f3")).url);
  const origin = new URL(project.url).origin;
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  return { page, at: (path) => `${origin}/projects/${slug}/${path}` };
}
type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

test("#2 G4: controls under the review sidebar leave the Tab order, and come back when it closes", async ({
  browser,
}) => {
  const { page, at } = await open(browser, { viewport: { width: 1500, height: 900 } });
  await page.goto(at(""));
  await expect(page.getByRole("button", { name: "Project settings" })).toBeVisible();
  const bell = page.getByRole("button", { name: "Notifications" });
  await bell.click();
  const review = page.getByRole("region", { name: "Project Review" });
  await expect(review).toBeVisible();
  // The controls it covers on this page (the round's repro).
  for (const name of ["Project settings", "New"])
    await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("inert", "");

  const hidden: string[] = [];
  for (let press = 0; press < 45; press++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active === null || active === document.body) return null;
      const box = active.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      const covered = hit?.closest(".primary-review-inbox") != null && active.closest(".primary-review-inbox") === null;
      return covered
        ? `${active.tagName} ${active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 40)}`
        : null;
    });
    if (stop !== null) hidden.push(stop);
  }
  expect(hidden).toEqual([]);

  // Closing gives the controls back and focus to the bell.
  await review.getByRole("button", { name: "Close project review" }).click();
  await expect(review).toBeHidden();
  await expect(page.locator("[inert]")).toHaveCount(0);
  await bell.focus();
  await bell.press("Enter");
  await expect(review).toBeVisible();
  await review.getByRole("tab").first().focus();
  await page.keyboard.press("Escape");
  await expect(review).toBeHidden();
  await expect(bell).toBeFocused();
  await expect(page.locator("[inert]")).toHaveCount(0);
});

for (const [width, height] of [
  [1000, 800],
  [1500, 900],
] as const) {
  test(`#3 G4: the journey's Source and Graph tools sit side by side at ${width}×${height}`, async ({ browser }) => {
    const { page, at } = await open(browser, { viewport: { width, height } });
    await page.goto(at("diagrams/buying-a-book.mmd"));
    const source = page.getByRole("button", { name: "Source", exact: true });
    const tools = page.getByRole("button", { name: "Export, compare and more" });
    await expect(source).toBeVisible();
    await expect(tools).toBeVisible();
    expect(overlaps((await source.boundingBox())!, (await tools.boundingBox())!)).toBe(false);
    // Each is what a pointer meets at its centre.
    for (const control of [source, tools]) {
      expect(
        await control.evaluate((el) => {
          const box = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        }),
      ).toBe(true);
    }
    await source.click();
    await expect(source).toHaveAttribute("aria-pressed", "true");
  });
}

test("#12 V4/G8: at 320 px the breadcrumb's crumbs are readable, not stubs", async ({ browser }) => {
  const { page, at } = await open(browser, { viewport: { width: 320, height: 640 } });
  await page.goto(at("diagrams/deep/er/still/broken.mmd"));
  const crumbs = page.locator(".primary-breadcrumb button");
  await expect(crumbs.first()).toBeAttached();
  const shown = await crumbs.evaluateAll((els) =>
    els
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => {
        const box = el.getBoundingClientRect();
        // Cut short by its own ellipsis, or by the trail's edge.
        const nav = el.closest("nav")!.getBoundingClientRect();
        return {
          text: el.textContent ?? "",
          width: box.width,
          height: box.height,
          clipped: el.scrollWidth > el.clientWidth + 1 || box.right > nav.right + 0.5,
          right: box.right,
        };
      }),
  );
  expect(shown.length).toBeGreaterThan(0);
  for (const crumb of shown) {
    expect(crumb, crumb.text).toMatchObject({ clipped: false });
    expect(crumb.right, crumb.text).toBeLessThanOrEqual(320);
  }
  // And each is a target WCAG 2.5.8 accepts: 24 px, or spaced 24 px from the next.
  type Target = { path: string; name: string; w: string };
  const census = (await censusPage(page)) as { targets: Target[] };
  expect(census.targets.filter((t) => /primary-breadcrumb/.test(t.path) && t.w === "fail").map((t) => t.name)).toEqual(
    [],
  );
  // The whole trail is one press away.
  const more = page.getByRole("button", { name: "Show the whole path" });
  await expect(more).toBeVisible();
  await more.click();
  for (const name of ["Projects", "Pageturner", "diagrams", "deep", "er", "still"])
    await expect(page.locator(".primary-breadcrumb").getByRole("button", { name, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("#13 G8: at 320 px the compile-error card does not cover its heading, and no text runs off", async ({
  browser,
}) => {
  const { page, at } = await open(browser, { viewport: { width: 320, height: 640 } });
  await page.goto(at("diagrams/deep/er/still/broken.mmd"));
  const notice = page.locator(".archer-compile-notice");
  const heading = page.getByText("This diagram has not compiled yet.");
  await expect(notice).toBeVisible();
  await expect(heading).toBeVisible();
  expect(overlaps((await notice.boundingBox())!, (await heading.boundingBox())!)).toBe(false);
  const runOff = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        ".archer-compile-notice *, .archer-page-notice *, .archer-diagram-content p, .archer-diagram-content h2",
      ),
    ]
      .filter(
        (el) =>
          el.getClientRects().length > 0 &&
          (el.getBoundingClientRect().right > innerWidth + 0.5 || el.getBoundingClientRect().left < -0.5),
      )
      .map((el) => `${el.className} ${el.textContent?.slice(0, 40)}`),
  );
  expect(runOff).toEqual([]);
});

test("#14 G7 [H]: under a coarse pointer the tree's and tools' targets are 44 px both ways", async ({ browser }) => {
  const { page, at } = await open(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  type Target = { name: string; path: string; box: { w: number; h: number }; h44: boolean | null };
  const short = async (pattern: RegExp): Promise<string[]> => {
    const census = (await censusPage(page)) as { targets: Target[] };
    return census.targets
      .filter((t) => pattern.test(t.path) && t.h44 === false)
      .map((t) => `${t.name} ${t.box.w}×${t.box.h}`);
  };
  await page.goto(at(""));
  await expect(page.locator(".archer-folder-tree-disclose").first()).toBeVisible();
  expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  expect(await short(/archer-folder-tree|primary-breadcrumb/)).toEqual([]);

  await page.goto(at("diagrams/buying-a-book.mmd"));
  const tools = page.getByRole("button", { name: "Export, compare and more" });
  await tools.click();
  await expect(page.locator(".archer-canvas-tools-menu")).toBeVisible();
  expect(await short(/archer-canvas-tools|archer-canvas-controls|primary-breadcrumb/)).toEqual([]);
});

test("#15 G7 [W]: the panel divider is a 24 px target and keeps its narrow look", async ({ browser }) => {
  const { page, at } = await open(browser, { viewport: { width: 1500, height: 900 } });
  await page.goto(at("diagrams/order-lifecycle.mmd"));
  const divider = page.getByRole("separator", { name: "Resize diagram panel" });
  await expect(divider).toBeVisible();
  const box = (await divider.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(24);
  type Target = { name: string; w: string };
  const census = (await censusPage(page)) as { targets: Target[] };
  expect(census.targets.find((t) => t.name === "Resize diagram panel")?.w).toBe("size");
  // The drawing and the panel keep their places: the wider hit area lies over their edges, not between them.
  const drawing = (await page.locator(".archer-diagram-content").boundingBox())!;
  const panel = (await page.getByRole("complementary", { name: "Diagram panel" }).boundingBox())!;
  expect(panel.x - (drawing.x + drawing.width)).toBeLessThanOrEqual(11.5);
  // Dragging it still resizes the panel.
  await page.mouse.move(box.x + 3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 60, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  expect((await page.getByRole("complementary", { name: "Diagram panel" }).boundingBox())!.width).toBeGreaterThan(
    panel.width + 40,
  );
});

test("#16 G12: under the four text-spacing overrides no file-table cell clips its text", async ({ browser }) => {
  const { page, at } = await open(browser, { viewport: { width: 1500, height: 900 } }, true);
  await page.goto(at(""));
  // The widest Created cell names Git ("… · Git"), shown when the file system keeps no certain birth time for the
  // corpus's files (`birthTime` in ts/src/project/file-dates.ts: Linux reports one equal to the change time). APFS
  // keeps a certain one, so on a Mac the date is the file system's and no row can name Git: the cells are checked
  // as drawn there (docs/agents/ui-testing.md, "Created dates on macOS").
  const birthCertain = Object.keys(corpus()).every((path) => {
    const stat = statSync(join(project!.root, path), { bigint: true });
    return stat.birthtimeNs > 0n && stat.birthtimeNs !== stat.ctimeNs;
  });
  await expect(
    page
      .locator(`.archer-folder-tree-row ${birthCertain ? 'time[data-column="created"]' : ".archer-files-source"}`)
      .first(),
  ).toBeVisible();
  await page.addStyleTag({
    content:
      "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }",
  });
  // A cell's text may not run into the next column or past the table's frame, which clips it. Names and
  // titles end in an ellipsis by design (their whole text is their tooltip); they are left out.
  const clipped = await page.locator(".archer-folder-tree-row, .archer-folder-tree-head").evaluateAll((rows) =>
    rows.flatMap((row) => {
      const frame = row.closest(".archer-folder-tree-frame")!.getBoundingClientRect();
      const cells = [...row.children].filter((cell) => cell.getClientRects().length > 0);
      return cells
        .filter((cell, at) => {
          if ([cell, ...cell.querySelectorAll("*")].some((el) => getComputedStyle(el).textOverflow === "ellipsis"))
            return false;
          const range = document.createRange();
          range.selectNodeContents(cell);
          const right = Math.max(...[...range.getClientRects()].map((r) => r.right));
          const next = cells[at + 1];
          const limit = next === undefined ? frame.right : next.getBoundingClientRect().left;
          return right > limit + 0.5;
        })
        .map((cell) => `${cell.getAttribute("data-column")}: ${cell.textContent}`);
    }),
  );
  expect(clipped).toEqual([]);
  if (birthCertain) return;
  // The source mark reads in full.
  const git = page.locator(".archer-folder-tree-row .archer-files-source").first();
  const inFull = await git.evaluate((el) => {
    const row = el.closest(".archer-folder-tree-row")!.getBoundingClientRect();
    const frame = el.closest(".archer-folder-tree-frame")!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return box.right <= Math.min(row.right, frame.right) + 0.5;
  });
  expect(inFull).toBe(true);
});

test("#21 V1: the Help glyph is set on the type scale", async ({ browser }) => {
  const { page, at } = await open(browser, { viewport: { width: 1500, height: 900 } });
  await page.goto(at(""));
  const glyph = page.locator(".primary-help-glyph");
  await expect(glyph).toBeVisible();
  const sizes = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return ["--type-floor", "--type-small", "--type-body", "--type-title", "--type-display"].map(
      (token) => parseFloat(root.getPropertyValue(token)) * 16,
    );
  });
  const size = await glyph.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(sizes).toContain(size);
});

test("#25 H1: a plain diagram names its mode, Explore, in text", async ({ browser }) => {
  const { page, at } = await open(browser, { viewport: { width: 1500, height: 900 } });
  await page.goto(at("diagrams/system-context.mmd"));
  const panel = page.getByRole("complementary", { name: "Diagram panel" });
  await expect(panel).toBeVisible();
  await expect(panel.locator(".archer-panel-bar")).toContainText("Explore");
});
