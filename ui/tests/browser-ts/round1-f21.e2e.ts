// Round 1 (UI/UX) fixes, pass 6, batch F21: the shell. Each test names its row in the pass's
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
  await page.goto((await project.issueAccess("round1-f21")).url);
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

/** The focused element's name, whether it is in the Chat sheet, and whether all 25 points of a 5×5 grid over it lie under the sheet. */
function stop(): { name: string; inSheet: boolean; hidden: boolean } {
  const active = document.activeElement;
  const sheet = document.querySelector(".archer-chat[data-mode='sheet']");
  const name = active?.getAttribute("aria-label") ?? active?.textContent?.trim().slice(0, 40) ?? "";
  if (active === null || active === document.body || sheet === null) return { name, inSheet: false, hidden: false };
  if (sheet.contains(active)) return { name, inSheet: true, hidden: false };
  const box = active.getBoundingClientRect();
  let under = 0;
  for (let i = 0; i < 5; i++)
    for (let j = 0; j < 5; j++) {
      const hit = document.elementFromPoint(
        box.left + (box.width * (i + 0.5)) / 5,
        box.top + (box.height * (j + 0.5)) / 5,
      );
      if (hit !== null && sheet.contains(hit)) under++;
    }
  return { name, inSheet: false, hidden: under === 25 };
}

for (const [width, height] of [
  [390, 844],
  [320, 640],
] as const) {
  test(`F21 row 1 / R5-claude-01: at ${width}, with the Chat sheet open Tab never lands wholly under it; Escape gives Chat back`, async ({
    browser,
  }) => {
    const page = await open(browser, phone(width, height), "diagrams/containers.mmd");
    const chat = page.locator(".archer-chat-fab");
    await chat.click();
    const sheet = page.locator(".archer-chat[data-mode='sheet']");
    await expect(sheet).toBeVisible();
    // The marks land on the frame after the sheet arrives.
    await expect.poll(() => chat.getAttribute("inert")).toBe("");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const hidden: string[] = [];
    let inSheet = 0;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      // Judged once settled: the canvas pans a focused node or line out from under the sheet after focus lands
      // (RevealCamera, DiagramCanvas.tsx), so one read straight after Tab could come before it (O50).
      const at = await page.evaluate(stop);
      if (
        at.hidden &&
        (await expect
          .poll(async () => (await page.evaluate(stop)).hidden)
          .toBe(false)
          .then(
            () => false,
            () => true,
          ))
      )
        hidden.push(at.name);
      if (at.inSheet) inSheet++;
    }
    expect(hidden).toEqual([]);
    // The sheet itself stays usable.
    expect(inSheet).toBeGreaterThan(0);
    await sheet.locator("textarea").focus();
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.classList.contains("archer-chat-fab") ?? false))
      .toBe(true);
    await expect(chat).not.toHaveAttribute("inert");
  });
}

test("F21 row 3 / R5-claude-08: a missing file's breadcrumb names the project as the other pages do", async ({
  browser,
}) => {
  const page = await open(browser, { viewport: { width: 1000, height: 700 } }, "notes/does-not-exist.md");
  await expect(page.getByRole("alert")).toContainText("moved or deleted");
  const trail = page.getByRole("navigation", { name: "Breadcrumb" });
  await expect(trail.getByRole("button", { name: "Pageturner", exact: true })).toBeVisible();
});
