/**
 * Screenshots of the Pageturner test corpus (`ts/test/fixtures/pageturner`) for review, taken
 * only when asked for:
 *
 *   ARCHER_SHOTS=<dir> [ARCHER_SHOTS_PREFIX=before] [ARCHER_SHOTS_PAGE=<page.html>] \
 *     npm --workspace ui run test:browser:ts -- shots
 *
 * The contents page, a graph, ER, sequence, journey, the C4 containers, the
 * order lifecycle and the comments drawer, at 1440 and 390, light and dark.
 * `ARCHER_SHOTS_PAGE` draws them with another build of the page (a web build
 * of an earlier commit's `ui/dist/index.html`, for a "before").
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { startTsProject, type TsProject } from "../support/ts-service";
import { files as projectFiles } from "./support/primary-navigation";
import { testPage } from "./support/page-path";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = resolve(HERE, "../../../ts/test/fixtures/pageturner");
const SHOTS = process.env.ARCHER_SHOTS;
const PREFIX = process.env.ARCHER_SHOTS_PREFIX ?? "after";
const PAGE = process.env.ARCHER_SHOTS_PAGE ?? testPage();

function corpusFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files[relative(DEMO, path)] = readFileSync(path, "utf8");
    }
  };
  walk(DEMO);
  return files;
}

let project: TsProject | undefined;
test.afterEach(async () => {
  await project?.stop();
  project = undefined;
});

const VIEWS = [
  ["graph", "deployment"],
  ["er", "data-model"],
  ["sequence", "checkout"],
  ["journey", "buying-a-book"],
  ["c4-containers", "containers"],
  ["state-order-lifecycle", "order-lifecycle"],
] as const;

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  // Two frames for the camera to land; screenshots are for eyes, not assertions.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.waitForTimeout(400);
}

for (const width of [1440, 390] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`corpus screenshots · ${width} ${scheme}`, async ({ page }) => {
      test.skip(SHOTS === undefined, "set ARCHER_SHOTS to a directory to save screenshots");
      test.setTimeout(120_000);
      const at = (name: string): string => `${SHOTS}/${PREFIX}-${name}-${width}-${scheme}.png`;
      project = await startTsProject({ files: corpusFiles(), pagePath: PAGE });
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(project.url);
      await expect(page.locator(".archer-contents, .archer-stage").first()).toBeVisible();
      await settle(page);
      await page.screenshot({ path: at("contents") });
      for (const [name, viewId] of VIEWS) {
        await project.present(viewId);
        await expect(
          page.locator(".react-flow__node, .archer-seq-participant, .archer-journey-task").first(),
        ).toBeVisible();
        await settle(page);
        await page.screenshot({ path: at(name) });
      }
      // The contents page again: each diagram drawn above now has its sketch.
      const home = page.getByRole("button", { name: "Archer contents", exact: true });
      if (!(await home.isVisible())) await page.getByRole("button", { name: "Menu", exact: true }).click();
      await home.click();
      await expect(page.getByRole("region", { name: "Project documents", exact: true })).toBeVisible();
      await projectFiles(page);
      await settle(page);
      await page.screenshot({ path: at("contents-sketches") });
      // The comments drawer, open on the containers view.
      await project.present("containers");
      await settle(page);
      const toggle = page.getByRole("button", { name: /^Notes and comments/ }).first();
      if ((await toggle.count()) > 0) {
        await toggle.click();
        await settle(page);
        await page.screenshot({ path: at("comments-drawer") });
      }
    });
  }
}
