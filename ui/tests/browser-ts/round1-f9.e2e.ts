// Round 1 (UI/UX) fixes, pass 3, batch F9: the shell and the chat on a phone. Each test names its row in the
// round's third fixes list and the finding it answers. The Pageturner corpus, served from this checkout's build
// (`ARCHER_PAGE`, else ui/dist), on a touch phone (Playwright `hasTouch`, real touch events).
import AxeBuilder from "@axe-core/playwright";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  expect,
  test,
  type Browser,
  type Page,
  type BrowserContext,
  type BrowserContextOptions,
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
async function open(
  browser: Browser,
  width: number,
  height: number,
  touch = true,
  motion: "reduce" | "no-preference" = "no-preference",
  name = "pageturner",
): Promise<Opened> {
  project = await sharedTsProject({ files: corpus(name), beforeAttach: commit });
  const context = await opened(browser, {
    viewport: { width, height },
    hasTouch: touch,
    isMobile: touch,
    reducedMotion: motion,
  });
  const page = await context.newPage();
  await page.goto((await project.issueAccess("round1-f9")).url);
  const origin = new URL(project.url).origin;
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  return { page, at: (path) => `${origin}/projects/${slug}/${path}`, project };
}

// The rescore's case (C-22): one short Highlights group, so its sheet is low and the chat button parks
// above it where the chat's Collapse button then lies.
const REQUEST_PATH = [
  {
    id: "request-path",
    title: "Request path",
    groups: [{ id: "req", label: "request", style: "flow", nodes: ["a", "b"], edges: ["calls"] }],
  },
];

/** The journeys corpus's flow with its Highlights sheet open, on a touch phone. */
async function highlightsOpen(
  browser: Browser,
  width: number,
  height: number,
  motion: "reduce" | "no-preference" = "no-preference",
): Promise<Page> {
  const { page, at, project } = await open(browser, width, height, true, motion, "journeys");
  await page.goto(at("diagrams/flow.mmd"));
  await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
  await project.setEmphasis("flow", REQUEST_PATH);
  const chip = page.locator(".archer-stage-dock > .archer-dock-chip").first();
  await expect(chip).toBeVisible();
  await chip.tap();
  await expect(page.locator(".archer-dock-sheet")).toBeVisible();
  await expect(page.locator(".archer-chat-fab")).toBeVisible();
  // Every click the page sees, by the button it lands on.
  await page.evaluate(() => {
    const w = window as unknown as { clicks: string[] };
    w.clicks = [];
    document.addEventListener(
      "click",
      (event) => {
        const button = (event.target as Element | null)?.closest("button");
        w.clicks.push(
          button?.getAttribute("aria-label") ?? button?.textContent?.trim() ?? (event.target as Element).tagName,
        );
      },
      true,
    );
  });
  return page;
}
const frames = (page: Page): Promise<void> =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const centre = async (page: Page, selector: string): Promise<{ x: number; y: number }> => {
  const box = (await page.locator(selector).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

// Reduced motion puts the chat's Collapse button under the finger at once; with motion it slides in.
for (const [width, height, motion] of [
  [390, 844, "reduce"],
  [390, 844, "no-preference"],
  [320, 640, "reduce"],
  [320, 640, "no-preference"],
] as const) {
  test(`a C-22: one tap on the parked chat button opens the chat and nothing else, ${width}×${height}, motion ${motion}`, async ({
    browser,
  }) => {
    const page = await highlightsOpen(browser, width, height, motion);
    const at = await centre(page, ".archer-chat-fab");
    await page.touchscreen.tap(at.x, at.y);
    await expect(page.locator(".archer-chat")).toBeVisible();
    await frames(page);
    // The tap's own click must not reach the chat's Collapse button, which now lies where the finger was.
    expect(await page.evaluate(() => (window as unknown as { clicks: string[] }).clicks)).not.toContain(
      "Collapse to the bubble",
    );
    await expect(page.locator(".archer-chat")).toHaveCount(1);
    // One sheet at a time: the chat took the Highlights sheet's place.
    await expect(page.locator(".archer-dock-sheet")).toHaveCount(0);
  });
}

test("a C-22: a tap outside the sheet still folds it", async ({ browser }) => {
  const page = await highlightsOpen(browser, 390, 844);
  const sheet = page.locator(".archer-dock-sheet");
  // A tap on the drawing's empty pane, clear of every control, folds it to its chip.
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  const spot = await page.evaluate(
    ({ x0, y0, x1, y1 }) => {
      for (let y = y0 + 8; y < y1; y += 8)
        for (let x = x0 + 8; x < x1; x += 8) {
          if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
        }
      return null;
    },
    { x0: pane.x, y0: pane.y, x1: pane.x + pane.width, y1: pane.y + pane.height },
  );
  expect(spot, "an empty spot on the pane").not.toBeNull();
  await page.touchscreen.tap(spot!.x, spot!.y);
  await expect(sheet).toHaveCount(0);
  await expect(page.locator(".archer-chat")).toHaveCount(0);
});

test("a C-22: a touch drag moves the chat button and does not open the chat", async ({ browser }) => {
  const page = await highlightsOpen(browser, 390, 844);
  const from = await centre(page, ".archer-chat-fab");
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number): Promise<unknown> =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y, id: 1 }] });
  await touch("touchStart", from.x, from.y);
  for (let step = 1; step <= 8; step++) await touch("touchMove", from.x - step * 10, from.y - step * 25);
  // It starts from where it is parked and stays under the finger, rather than jumping back to its own place.
  // (Touch moves reach the page aligned to frames.)
  await frames(page);
  const mid = await centre(page, ".archer-chat-fab");
  expect(Math.hypot(mid.x - (from.x - 80), mid.y - (from.y - 200))).toBeLessThan(2);
  // The finger rests before it lifts. A release still moving is a fling to the browser, and Chromium does
  // not turn the next tap into a click (it stops the fling instead), for any button.
  await page.waitForTimeout(300);
  await touch("touchMove", from.x - 80, from.y - 200);
  await touch("touchEnd", from.x - 80, from.y - 200);
  await frames(page);
  const to = await centre(page, ".archer-chat-fab");
  expect(Math.hypot(to.x - from.x, to.y - from.y)).toBeGreaterThan(100);
  expect(Math.hypot(to.x - (from.x - 80), to.y - (from.y - 200)), "it stays where it was dropped").toBeLessThan(2);
  await expect(page.locator(".archer-chat")).toHaveCount(0);
  // A drag folds the Highlights sheet, so the button is free to go where it is dropped.
  await expect(page.locator(".archer-dock-sheet")).toHaveCount(0);
  // And a tap where it now lies opens it.
  await page.touchscreen.tap(to.x, to.y);
  await expect(page.locator(".archer-chat")).toBeVisible();
});

test("a C-22: a mouse drag moves the chat button and the click that ends it does not open the chat", async ({
  browser,
}) => {
  const { page, at } = await open(browser, 1440, 900, false, "no-preference", "journeys");
  await page.goto(at("diagrams/flow.mmd"));
  await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
  const from = await centre(page, ".archer-chat-fab");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 150, from.y - 120, { steps: 8 });
  await page.mouse.up();
  await frames(page);
  const to = await centre(page, ".archer-chat-fab");
  expect(Math.hypot(to.x - from.x, to.y - from.y)).toBeGreaterThan(100);
  await expect(page.locator(".archer-chat")).toHaveCount(0);
  // A plain click and Enter still open and close it.
  await page.mouse.click(to.x, to.y);
  await expect(page.locator(".archer-chat")).toBeVisible();
  await page.getByRole("button", { name: "Collapse to the bubble" }).click();
  await expect(page.locator(".archer-chat")).toHaveCount(0);
  await page.locator(".archer-chat-fab").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".archer-chat")).toBeVisible();
});

for (const [width, height] of [
  [390, 844],
  [320, 640],
] as const) {
  test(`b RS2-02: the page keeps its h1 for assistive tech while the phone review covers it, ${width}×${height}`, async ({
    browser,
  }) => {
    const { page, at } = await open(browser, width, height);
    await page.goto(at(""));
    await page.getByRole("button", { name: /^Notifications\b/ }).click();
    await expect(page.getByRole("region", { name: "Project Review" })).toBeVisible();
    // The sheet has arrived and the shell has marked what it covers.
    await expect(page.getByRole("button", { name: "Project settings", exact: true })).toHaveAttribute("inert", "");
    await frames(page);
    expect(await page.locator("h1").count()).toBe(1);
    expect(
      await page.locator("h1").evaluate((h1) => h1.closest("[inert]")?.className ?? null),
      "the h1 is not inside an inert subtree",
    ).toBeNull();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    // The whole axe sweep, best practice included, is clean with the review open.
    const axe = await new AxeBuilder({ page }).analyze();
    expect(axe.violations.flatMap((rule) => rule.nodes.map((node) => `${rule.id}: ${node.target.join(" ")}`))).toEqual(
      [],
    );
  });
}

test("follow-up (F8): at 390×844 with the review sheet open on fulfilment, Tab reaches the drawing's nodes, each with its centre clear of the sheet", async ({
  browser,
}) => {
  const { page, at } = await open(browser, 390, 844);
  await page.goto(at("diagrams/fulfilment.mmd"));
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  const bell = page.getByRole("button", { name: /^Notifications\b/ });
  await bell.click();
  await expect(page.getByRole("region", { name: "Project Review" })).toBeVisible();
  // The sheet has arrived and the shell has marked what it covers.
  await expect.poll(() => page.locator("[inert]").count()).toBeGreaterThan(0);
  await frames(page);
  /** The focused node, once the canvas has stopped bringing it into view, and whether its centre is clear of the sheet. */
  const settled = async (): Promise<{ node: string | null; name: string; clear?: boolean }> => {
    let last = "";
    for (let tries = 0; tries < 30; tries++) {
      await frames(page);
      const now = JSON.stringify(await page.evaluate(() => document.activeElement?.getBoundingClientRect().toJSON()));
      if (now === last) break;
      last = now;
    }
    return page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active === null || !active.classList.contains("react-flow__node"))
        return { node: null, name: active?.getAttribute("aria-label") ?? "" };
      const b = active.getBoundingClientRect();
      const x = b.left + b.width / 2,
        y = b.top + b.height / 2;
      const hit = x >= 0 && x < innerWidth && y >= 0 && y < innerHeight ? document.elementFromPoint(x, y) : null;
      return {
        node: active.getAttribute("data-id"),
        name: active.getAttribute("aria-label") ?? "",
        clear: hit !== null && hit.closest(".primary-review-inbox") === null,
      };
    });
  };
  // The drawing is one Tab stop for its lines and one for its nodes (arrows move within): Tab must land on a node.
  await bell.focus();
  const seen: string[] = [];
  const hidden: string[] = [];
  for (let press = 0; press < 14; press++) {
    await page.keyboard.press("Tab");
    const stop = await settled();
    if (stop.node !== null) {
      seen.push(stop.node);
      if (stop.clear !== true) hidden.push(stop.node);
      break;
    }
    expect(stop.name, "Tab reached the controls past the drawing without a node").not.toBe("Zoom in");
  }
  expect(seen.length, "Tab reaches a node").toBe(1);
  // And from there the arrows walk the other nodes, each brought clear of the sheet.
  for (const key of ["ArrowRight", "ArrowRight", "ArrowDown", "ArrowLeft", "ArrowDown", "ArrowRight"]) {
    await page.keyboard.press(key);
    const stop = await settled();
    expect(stop.node, `${key} keeps focus on a node`).not.toBeNull();
    if (!seen.includes(stop.node!)) seen.push(stop.node!);
    if (stop.clear !== true) hidden.push(stop.node!);
  }
  expect(seen.length, seen.join(" ")).toBeGreaterThan(2);
  expect(hidden).toEqual([]);
});
