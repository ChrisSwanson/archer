// Round 1 (UI/UX) fixes, pass 5, batch F18: overlays, panels, phone menu. Each test names its row in the pass's
// fix list and the finding it answers. The Pageturner corpus, served from this checkout's build (`ARCHER_PAGE`,
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

async function open(browser: Browser, options: BrowserContextOptions, path: string): Promise<Page> {
  project = await sharedTsProject({ files: corpus("pageturner"), beforeAttach: commit });
  const page = await (await opened(browser, options)).newPage();
  await page.goto((await project.issueAccess("round1-f18")).url);
  const origin = new URL(project.url).origin;
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  await page.goto(`${origin}/projects/${slug}/${path}`);
  return page;
}
const phone = (width: number, height: number): BrowserContextOptions => ({
  viewport: { width, height },
  hasTouch: true,
  isMobile: true,
});

/** The focused element's name, and whether all 25 points of a 5×5 grid over it lie under `panel`. */
function focusUnder(panel: string): { name: string; hidden: boolean } {
  const active = document.activeElement;
  const cover = document.querySelector(panel);
  if (active === null || active === document.body || cover === null || cover.contains(active))
    return { name: active?.getAttribute("aria-label") ?? "", hidden: false };
  const box = active.getBoundingClientRect();
  let under = 0;
  for (let i = 0; i < 5; i++)
    for (let j = 0; j < 5; j++) {
      const hit = document.elementFromPoint(
        box.left + (box.width * (i + 0.5)) / 5,
        box.top + (box.height * (j + 0.5)) / 5,
      );
      if (hit !== null && cover.contains(hit)) under++;
    }
  return {
    name: active.getAttribute("aria-label") ?? active.textContent?.trim().slice(0, 40) ?? active.tagName,
    hidden: under === 25,
  };
}

for (const [label, options] of [
  ["1500", { viewport: { width: 1500, height: 900 } }],
  ["1000", { viewport: { width: 1000, height: 800 } }],
  ["320", phone(320, 640)],
] as const) {
  for (const [launcher, panel] of [
    ["Check diagram accuracy", "#archer-accuracy-panel"],
    ["Export diagram", "#archer-export-panel"],
    ["Compare revisions", "#archer-comparison-panel"],
  ] as const) {
    test(`R4-01 / R4-claude-07: at ${label}, Tab never lands wholly under ${panel}`, async ({ browser }) => {
      const page = await open(browser, options, "diagrams/containers.mmd");
      // The launcher swapped mid-click while the drawing loaded drops the click (O266); that race has its own test.
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      await page.getByRole("button", { name: /Export, compare/ }).click();
      await page.getByRole("button", { name: launcher, exact: true }).click();
      await expect(page.locator(panel)).toBeVisible();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const hidden: string[] = [];
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press("Tab");
        // A stop is judged once settled: the inert marks land on the frame after the panel arrives, and the canvas
        // pans a focused node out from under the panel after focus lands (RevealCamera, DiagramCanvas.tsx). One read
        // straight after Tab could come before that pan under load (O50); a stop still under the panel is the failure.
        const stop = await page.evaluate(focusUnder, panel);
        if (
          stop.hidden &&
          (await expect
            .poll(async () => (await page.evaluate(focusUnder, panel)).hidden)
            .toBe(false)
            .then(
              () => false,
              () => true,
            ))
        )
          hidden.push(stop.name);
      }
      expect(hidden).toEqual([]);
    });
  }
}

test("R4-04 / R4-claude-02: on a touch screen the walkthrough transport, tabs and picker are 44px targets", async ({
  browser,
}) => {
  const page = await open(browser, phone(390, 844), "diagrams/containers.mmd?walkthrough=checkout-tour&step=1");
  const sizes = (selector: string) => async () =>
    page.locator(selector).evaluateAll((all) =>
      all
        .map((element) => element.getBoundingClientRect())
        .filter((box) => box.width > 0)
        .map((box) => Math.min(Math.round(box.width), Math.round(box.height))),
    );
  await expect.poll(sizes(".archer-walk-transport .archer-walk-icon")).not.toEqual([]);
  await expect
    .poll(async () => Math.min(...(await sizes(".archer-walk-transport .archer-walk-icon")())))
    .toBeGreaterThanOrEqual(44);
  await expect
    .poll(async () =>
      Math.min(
        ...(await page
          .locator(".archer-walk-tabs button, .archer-walk-pick")
          .evaluateAll((all) =>
            all.map((element) => element.getBoundingClientRect().height).filter((height) => height > 0),
          )),
      ),
    )
    .toBeGreaterThanOrEqual(44);
});

// The highlights One/All sizes need the sandbox's emphasis (.devkit/emphasis.json); round1-f18.test.tsx pins their CSS.

for (const width of [1500, 320]) {
  test(`R4-claude-01: at ${width} the walkthrough picker and meta fit the panel, nothing scrolls sideways`, async ({
    browser,
  }) => {
    const page = await open(
      browser,
      width === 320 ? phone(320, 640) : { viewport: { width, height: 900 } },
      "diagrams/containers.mmd?walkthrough=checkout-tour&step=1",
    );
    await expect(page.locator(".archer-walk-pick")).toBeVisible();
    await expect
      .poll(() =>
        page.locator(".archer-walk").evaluate((panel) => {
          const outer = panel.getBoundingClientRect();
          const inner = [...panel.querySelectorAll(".archer-walk-pick, .archer-walk-meta")].map((element) =>
            element.getBoundingClientRect(),
          );
          return {
            scrolls: panel.scrollWidth > panel.clientWidth,
            outside: inner.some((box) => box.right > outer.right + 0.5),
          };
        }),
      )
      .toEqual({ scrolls: false, outside: false });
  });
}
