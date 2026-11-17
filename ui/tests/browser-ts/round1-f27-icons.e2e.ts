// Round 1 (UI/UX) fixes, pass 7, batch F27: the off-scale glyphs of the V3 census, on the icon scale (styles.css
// `--icon` 20, `--icon-indicator` 14, a true `--icon-stroke` 1.5). The Archer mark is exempt (AM-R1-04); the edge
// More mark is part of the drawing and follows its zoom. The built page, on a fresh copy of the Pageturner corpus
// attached to this worker's shared TypeScript service for each test.
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

test.describe.configure({ timeout: 90_000 });

const CORPUS = resolve(import.meta.dirname, "../../../tools/devkit/corpus/pageturner");
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
  return out;
}
const commit = (root: string): void => {
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

let project: TsProject;
let origin: string;
let base: string;

test.beforeEach(async () => {
  project = await sharedTsProject({ files: corpus(), beforeAttach: commit });
  await project.setEmphasis("containers", [JSON.parse(readFileSync(join(CORPUS, ".devkit/emphasis.json"), "utf8"))]);
  await project.agentCreateComment("view:containers", { kind: "view" }, "Is the gateway still in front of the shop?");
  const link = new URL(project.url);
  origin = link.origin;
  base = `${origin}/projects/${link.pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!}`;
});
test.afterEach(async () => {
  await project.stop();
});

async function login(page: Page, width = 1500, height = 900): Promise<void> {
  await page.setViewportSize({ width, height });
  // Measured at rest: an opening panel's scale animation would shrink every glyph in it.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto((await project.issueAuthoringAccess("round1-f27")).url);
  await page.waitForLoadState("networkidle");
}
async function openContainers(page: Page, name = "Pageturner Containers"): Promise<void> {
  await page.goto(`${base}/`);
  const documents = page.getByRole("region", { name: "Project documents", exact: true });
  await expect(documents).toBeVisible();
  await documents.getByRole("button", { name, exact: true }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
}

/** A mode of the diagram panel, switched on (a press on a pressed mode would switch it off). */
async function showMode(page: Page, name: RegExp): Promise<void> {
  const mode = page.getByRole("complementary", { name: "Diagram panel" }).getByRole("button", { name });
  if ((await mode.getAttribute("aria-pressed")) !== "true") await mode.click();
}
type Drawn = { box: number; height: number; stroke: string | null; effect: string | null };
/** A glyph's box and the stroke of its first stroked shape, as computed. */
const drawn = (page: Page, selector: string): Promise<Drawn> =>
  page
    .locator(selector)
    .first()
    .evaluate((svg: Element): Drawn => {
      const rect = svg.getBoundingClientRect();
      const shape =
        [...svg.querySelectorAll("path, rect, circle, line, polyline")].find(
          (part) => getComputedStyle(part).stroke !== "none",
        ) ?? null;
      const style = shape === null ? null : getComputedStyle(shape);
      return {
        box: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
        stroke: style?.strokeWidth ?? null,
        effect: style?.vectorEffect ?? null,
      };
    });
/** On the scale: the token's box and, when it is drawn in line, a true 1.5px line. */
async function onScale(page: Page, selector: string, box: 14 | 16 | 20, stroked = true): Promise<void> {
  await expect.poll(async () => (await drawn(page, selector)).box, { message: selector }).toBe(box);
  const glyph = await drawn(page, selector);
  expect(glyph.height, selector).toBe(box);
  if (!stroked) return;
  expect(glyph.stroke, selector).toBe("1.5px");
  expect(glyph.effect, selector).toBe("non-scaling-stroke");
}

test("V3-02/16/18/19/28: projects, project page, folder filter and Project settings glyphs are on the scale", async ({
  page,
}) => {
  await login(page);
  await page.goto(`${origin}/projects/`);
  await expect(page.locator("h2.primary-projects-heading svg.archer-files-glyph")).toBeAttached();
  await onScale(page, "h2.primary-projects-heading svg.archer-files-glyph", 20);

  await page.goto(`${base}/`);
  await expect(page.locator(".archer-folder-tree-file svg.archer-files-glyph:visible").first()).toBeVisible();
  await onScale(page, ".archer-folder-tree-file svg.archer-files-glyph:visible", 14);
  await onScale(page, ".archer-project-fact-code svg", 14);

  await page.getByRole("button", { name: "Project settings", exact: true }).click();
  await expect(page.locator(".archer-project-settings-close svg")).toBeVisible();
  await onScale(page, ".archer-project-settings-close svg", 20);
  await page.keyboard.press("Escape");

  // Clear folder filter: the shared close glyph, not a typed ×.
  await page.goto(`${base}/diagrams/`);
  const clear = page.getByRole("button", { name: "Clear folder filter" });
  await expect(clear).toBeVisible();
  expect(await clear.textContent()).not.toContain("×");
  await onScale(page, ".archer-search-project-scope svg", 14);
});

test("V3-17: a thread's disclosure in Notifications draws a true 1.5px line", async ({ page }) => {
  await login(page);
  await openContainers(page);
  await page.locator(".primary-document-actions .archer-notification-toggle").click();
  await expect(page.locator("svg.primary-inbox-chevron").first()).toBeVisible();
  await onScale(page, "svg.primary-inbox-chevron", 14);
});

test("V3-23/24/25/26/27/39: Highlights, walkthrough and nest toggle glyphs are on the scale", async ({ page }) => {
  await login(page);
  await openContainers(page);
  // The nest toggle on a node: drawn at 20 without a viewBox, in the scale's line.
  await expect(page.locator("svg.archer-nest-toggle-mark").first()).toBeVisible();
  const nest = await drawn(page, "svg.archer-nest-toggle-mark");
  expect(nest.stroke).toBe("1.5px");

  await showMode(page, /^Highlights · /);
  await expect(page.locator(".archer-emph-members-chevron").first()).toBeVisible();
  await onScale(page, ".archer-emph-members-chevron", 14);
  await onScale(page, ".archer-emph-swatch-check", 14);

  await showMode(page, /^Walkthroughs · /);
  await page.getByRole("button", { name: /^Checkout from Basket to Dispatch/ }).click();
  await expect(page.locator(".archer-walk-pick svg").first()).toBeVisible();
  await onScale(page, ".archer-walk-pick svg", 14);
  await expect(page.locator(".archer-walk-close svg")).toBeVisible();
  await onScale(page, ".archer-walk-close svg", 20);
  await expect(page.locator(".archer-walk-icon:not(.archer-walk-close) svg").first()).toBeVisible();
  await onScale(page, ".archer-walk-icon:not(.archer-walk-close) svg", 20, false);
});

test("V3-35/36/37/38: the chat window's Expand, Collapse, grip and Send are on the scale", async ({ page }) => {
  await login(page);
  await openContainers(page);
  await page.locator(".archer-chat-fab").first().click();
  await expect(page.locator(".archer-chat-send svg")).toBeVisible();
  for (const name of ["Expand into a sidebar", "Collapse to the bubble"]) {
    const selector = `.archer-chat-acts button[aria-label="${name}"] svg`;
    if ((await page.locator(selector).count()) > 0) await onScale(page, selector, 20);
  }
  await onScale(page, '.archer-chat-acts button[aria-label="Collapse to the bubble"] svg', 20);
  await onScale(page, ".archer-chat-grip svg", 14);
  await onScale(page, ".archer-chat-send svg", 20, false);
});

test("V3-41: the editor's pencil draws a true 1.5px line", async ({ page }) => {
  await login(page);
  // A flowchart: its structure list carries the pencils.
  await openContainers(page, "Order Fulfilment");
  await page.locator(".archer-diagram-edit").getByRole("button", { name: "Edit", exact: true }).click();
  const structure = page.getByRole("button", { name: "Structure and properties" });
  await expect(structure).toBeVisible();
  if ((await structure.getAttribute("aria-pressed")) !== "true") await structure.click();
  await expect(page.locator(".authoring-pencil svg").first()).toBeAttached();
  await onScale(page, ".authoring-pencil svg", 14);
});

test("V3-34: the phone sheet's Close is an icon-only control's glyph", async ({ page }) => {
  await login(page, 390, 844);
  await openContainers(page);
  await page
    .getByRole("button", { name: /^Highlights/ })
    .first()
    .click();
  await expect(page.locator(".archer-dock-sheet-close svg")).toBeVisible();
  await onScale(page, ".archer-dock-sheet-close svg", 20);
});
