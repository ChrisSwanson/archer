// Round 1 (UI/UX) fixes, pass 4, batch F14: shell, settings and service. Each test names its row in the round's
// fourth fixes list and the finding it answers. The Pageturner corpus, served from this checkout's build
// (`ARCHER_PAGE`, else ui/dist).
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

type Opened = { readonly page: Page; readonly at: (path: string) => string; readonly origin: string };
async function open(browser: Browser, width = 1440, height = 900): Promise<Opened> {
  project = await sharedTsProject({ files: corpus("pageturner"), beforeAttach: commit });
  const context = await opened(browser, { viewport: { width, height } });
  const page = await context.newPage();
  await page.goto((await project.issueAccess("round1-f14")).url);
  const origin = new URL(project.url).origin;
  const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
  return { page, at: (path) => `${origin}/projects/${slug}/${path}`, origin };
}

test("row 1 (R3-14, D9): a click steps the panel's width; Escape during a drag puts it back", async ({ browser }) => {
  const { page, at } = await open(browser, 1500, 900);
  await page.goto(at("diagrams/order-lifecycle.mmd"));
  const divider = page.getByRole("separator", { name: "Resize diagram panel" });
  await expect(divider).toBeVisible();
  const width = async (): Promise<number> => Number(await divider.getAttribute("aria-valuenow"));
  const panel = page.locator(".archer-diagram-panel");
  const before = await width();
  const box = (await divider.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const stepped = await width();
  expect(stepped).toBeGreaterThan(before);
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBeGreaterThan(before);

  const at2 = (await divider.boundingBox())!;
  await page.mouse.move(at2.x + at2.width / 2, at2.y + at2.height / 2);
  await page.mouse.down();
  await page.mouse.move(at2.x - 92, at2.y + at2.height / 2, { steps: 4 });
  const dx = at2.width / 2 + 92;
  expect(Math.abs((await width()) - (stepped + dx))).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  expect(await width()).toBe(stepped);
  await page.mouse.move(at2.x - 200, at2.y + at2.height / 2, { steps: 3 });
  await page.mouse.up();
  expect(await width()).toBe(stepped);
  // The page's own Escape did not also run: the diagram is still here, its panel open.
  await expect(divider).toBeVisible();
});

test("row 2 (D8): a column moves with clicks only", async ({ browser }) => {
  const { page, at } = await open(browser);
  await page.goto(at(""));
  await page.getByRole("tab", { name: /^Folders/ }).click();
  const headers = (): Promise<string[]> =>
    page
      .locator(".archer-folder-tree-head [role=columnheader]")
      .evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-column") ?? ""));
  const start = await headers();
  const kind = page.locator('.archer-folder-tree-heading[data-column="kind"]');
  await kind.hover();
  await page.getByRole("button", { name: "Move Kind column" }).click();
  await page.getByRole("group", { name: "Move Kind" }).getByRole("button", { name: "Move right" }).click();
  const from = start.indexOf("kind");
  await expect.poll(async () => (await headers()).indexOf("kind")).toBe(from + 1);
  await expect(
    page.getByRole("group", { name: "Move Kind" }).getByRole("button", { name: "Move right" }),
  ).toBeFocused();
  // A press elsewhere puts the choice away.
  await page.mouse.click(5, 5);
  await expect(page.getByRole("group", { name: "Move Kind" })).toHaveCount(0);
});

async function openSettings(page: Page, at: (path: string) => string): Promise<ReturnType<Page["getByRole"]>> {
  await page.goto(at(""));
  await page.getByRole("button", { name: "Project settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /Project Settings/ });
  await expect(dialog.getByLabel("Name", { exact: true })).toBeVisible();
  return dialog;
}

test("row 3 (R3-03, F83–F89): a nav section takes focus to its heading and keeps the marker", async ({ browser }) => {
  const { page, at } = await open(browser);
  const dialog = await openSettings(page, at);
  const nav = dialog.getByRole("navigation", { name: "Settings sections" });
  for (const name of ["Discovery", "Feedback", "Visibility", "archer.toml", "Diagrams", "General"]) {
    await nav.getByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}`) }).click();
    const heading = dialog.getByRole("heading", { level: 3, name: new RegExp(`^${name.replace(".", "\\.")}`) });
    await expect(heading).toBeFocused();
    // Let any smooth scroll finish, then the marker is still on the section asked for, and only there.
    await page.waitForTimeout(700);
    await expect(nav.getByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}`) })).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(nav.locator("[aria-current]")).toHaveCount(1);
  }
});

test("row 4 (D3, F90, R3-11): every unsaved change is guarded on Escape, and Keep editing returns to Close settings", async ({
  browser,
}) => {
  const { page, at } = await open(browser);
  let dialog = await openSettings(page, at);
  // D3's repro: typing into Name changes nothing (it is read-only), so Escape closes with nothing to lose.
  await dialog.getByLabel("Name", { exact: true }).click();
  await page.keyboard.type("Renamed");
  await expect(dialog.getByLabel("Name", { exact: true })).not.toHaveValue(/Renamed/);
  await expect(dialog.getByText("0 unsaved changes")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  for (const option of ["Always show", "Archive"]) {
    dialog = await openSettings(page, at);
    await dialog.getByRole("radio", { name: option }).check();
    await expect(dialog.getByText("1 unsaved change", { exact: true })).toBeVisible();
    for (const focus of [
      () => dialog.getByRole("radio", { name: option }).focus(),
      () => dialog.getByLabel("Description", { exact: true }).focus(),
      () =>
        dialog.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Feedback" }).focus(),
      () => dialog.getByLabel("archer.toml contents").focus(),
    ]) {
      await focus();
      await page.keyboard.press("Escape");
      await expect(dialog.getByText("Discard 1 unsaved change?")).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Keep editing" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(dialog.getByRole("button", { name: "Close settings" })).toBeFocused();
      await expect(dialog.getByText("1 unsaved change", { exact: true })).toBeVisible();
    }
    // The change dot's tooltip takes the first Escape, the dialog the second.
    await dialog.getByRole("button", { name: /^Visibility changed/ }).focus();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(dialog.getByText("Discard 1 unsaved change?")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog.getByRole("button", { name: "Close settings" })).toBeFocused();
    await page.keyboard.press("Enter");
    await dialog.getByRole("button", { name: "Discard" }).click();
    await expect(dialog).toBeHidden();
  }
});

test("row 5 (R3-15): at 320 CSS px the project tabs and the Settings sections wrap, every control in view", async ({
  browser,
}) => {
  const { page, at } = await open(browser, 320, 720);
  await page.goto(at(""));
  const outside = (selector: string): Promise<string[]> =>
    page.locator(selector).evaluateAll((elements) =>
      elements.flatMap((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && (box.left < -0.5 || box.right > window.innerWidth + 0.5)
          ? [`${element.textContent?.trim()} ${Math.round(box.left)}–${Math.round(box.right)}`]
          : [];
      }),
    );
  await expect(page.getByRole("tab", { name: /^Folders/ })).toBeVisible();
  await expect.poll(() => outside('[role="tab"]')).toEqual([]);
  const dialog = await openSettings(page, at);
  const nav = dialog.getByRole("navigation", { name: "Settings sections" });
  await expect(nav).toBeVisible();
  await expect.poll(() => outside(".archer-project-settings-nav button")).toEqual([]);
  await expect.poll(() => outside('.archer-project-settings :is(button, a, input, [role="radio"])')).toEqual([]);
  await expect.poll(() => nav.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
});

test("row 7 (D12): with text at 200% the Folders headings stay in their own columns", async ({ browser }) => {
  const { page, at } = await open(browser);
  await page.goto(at(""));
  await page.getByRole("tab", { name: /^Folders/ }).click();
  await expect(page.locator(".archer-folder-tree-head")).toBeVisible();
  // The rescore's fallback for text-only zoom: every element's computed font size, frozen, then doubled.
  await page.evaluate(() => {
    const all = [...document.querySelectorAll<HTMLElement>("body, body *")];
    const sizes = all.map((element) => parseFloat(getComputedStyle(element).fontSize));
    all.forEach((element, index) => {
      element.style.fontSize = `${sizes[index]! * 2}px`;
    });
  });
  const problems = (): Promise<string[]> =>
    page.locator(".archer-folder-tree-heading").evaluateAll((cells) => {
      const found: string[] = [];
      const boxes = cells.map((cell) => {
        const label = cell.querySelector(".archer-files-sort")!;
        const range = document.createRange();
        range.selectNodeContents(label);
        return {
          column: cell.getAttribute("data-column")!,
          cell: cell.getBoundingClientRect(),
          text: range.getBoundingClientRect(),
          frame: cell.closest(".archer-folder-tree")!.getBoundingClientRect(),
        };
      });
      boxes.forEach((box, index) => {
        if (box.text.right > box.frame.right + 0.5) found.push(`${box.column} runs past the tree`);
        const next = boxes[index + 1];
        if (next !== undefined && box.text.right > next.text.left + 0.5)
          found.push(`${box.column} overlaps ${next.column}`);
      });
      return found;
    });
  await expect.poll(problems).toEqual([]);
});
