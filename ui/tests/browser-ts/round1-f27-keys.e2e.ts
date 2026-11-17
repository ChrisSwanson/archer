// Round 1 (UI/UX) fixes, pass 7, batch F27: keys during a transition (V7-1, V7-2). Fit (`1`) pressed while a
// diagram is opening, or while Edit is opening, is kept until the drawing is ready and then fits once. The built
// page, on a fresh project of this worker's shared TypeScript service for each test.
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { containersSource } from "../support/walkthrough-project";
import { sharedTsProject } from "./support/shared-service";

test.describe.configure({ timeout: 90_000 });

const FILES = {
  "archer.toml":
    'version = 1\n[[views]]\nid = "containers"\nkind = "c4"\ntitle = "Pageturner containers"\nsource = ".archer/containers.mmd"\n',
  ".archer/containers.mmd": containersSource(),
};

let project: TsProject;
let base: string;

test.beforeEach(async () => {
  project = await sharedTsProject({ files: FILES });
  const link = new URL(project.url);
  base = `${link.origin}/projects/${link.pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!}`;
});
test.afterEach(async () => {
  await project.stop();
});

async function login(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto((await project.issueAuthoringAccess("round1-f27")).url);
  await page.waitForLoadState("networkidle");
}
/** The project page with its files listed, ready for a click on the diagram. */
async function projectFiles(page: Page): Promise<void> {
  await page.goto(`${base}/`);
  const documents = page.getByRole("region", { name: "Project documents", exact: true });
  // The project page always lists its files: wait for them. ("Archer contents" is drawn at once, and a press on it
  // here leaves for /projects/ by a document load; a one-shot check that chose it under load did so, O49.)
  await expect(documents).toBeVisible();
  await page.waitForLoadState("networkidle");
}
const openDiagram = (page: Page) =>
  page
    .getByRole("region", { name: "Project documents", exact: true })
    .getByRole("button", { name: "Pageturner containers", exact: true })
    .click();
const zoom = (page: Page, scope: string): Promise<number | null> =>
  page.evaluate((scope) => {
    const viewport = document.querySelector(`${scope} .react-flow__viewport`);
    return viewport === null ? null : Math.round(new DOMMatrix(getComputedStyle(viewport).transform).a * 1e4) / 1e4;
  }, scope);
/** The drawing's scale once it holds still for half a second. */
async function settled(page: Page, scope: string): Promise<number> {
  let last: number | null = null;
  await expect
    .poll(
      async () => {
        const now = await zoom(page, scope);
        const still = now !== null && now === last;
        last = now;
        return still;
      },
      { intervals: [500], timeout: 15_000 },
    )
    .toBe(true);
  return last!;
}
const EDITOR = ".authoring-workspace";

/**
 * Holds every request to `url` until `release()`. A key pressed in between lands while the drawing is opening, on
 * any host: the built page opens a diagram in a few hundred milliseconds, where the race windows below were once
 * left to how slowly the dev server served it. `held()` counts the requests held, to show the drawing waited on one.
 */
async function hold(page: Page, url: RegExp): Promise<{ held(): number; release(): void }> {
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  let held = 0;
  await page.route(url, async (route) => {
    held += 1;
    await gate;
    await route.continue();
  });
  return { held: () => held, release };
}
/** The reader's drawing waits on the layout worker, fetched again by each fresh document; the editor's on the
 * authoring session it opens (the worker is running by then). */
const LAYOUT_WORKER = /elk-layout-worker/;
const AUTHORING_OPEN = /\/api\/authoring\/open(?:\?.*)?$/;
const editButton = (page: Page) =>
  page.locator(".archer-diagram-edit").getByRole("button", { name: "Edit", exact: true });

/** The opening framing and the fit differ on this drawing at this size, or the trials below prove nothing. */
async function readerFrames(page: Page): Promise<{ opening: number; fit: number }> {
  await projectFiles(page);
  await openDiagram(page);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  const opening = await settled(page, "");
  await page.keyboard.press("1");
  const fit = await settled(page, "");
  expect(Math.abs(opening - fit)).toBeGreaterThan(0.01);
  return { opening, fit };
}

for (const delay of [0, 50])
  test(`V7-1: 1 pressed ${delay}ms after opening a diagram fits it once it is drawn`, async ({ page }) => {
    await login(page);
    const { fit } = await readerFrames(page);
    await projectFiles(page);
    const opening = await hold(page, LAYOUT_WORKER);
    await openDiagram(page);
    if (delay > 0) await page.waitForTimeout(delay);
    await page.keyboard.press("1");
    // The window this tests: the key came while the diagram was still opening, nothing of it drawn yet.
    expect(await page.locator(".react-flow__node").count()).toBe(0);
    opening.release();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    expect(opening.held()).toBeGreaterThan(0);
    expect(await settled(page, "")).toBeCloseTo(fit, 3);
  });

for (const delay of [0, 150])
  test(`V7-2: 1 pressed ${delay}ms after Edit fits the editor's drawing once it is drawn`, async ({ page }) => {
    await login(page);
    await readerFrames(page);
    // The editor's own fit, asked for once it has settled.
    await editButton(page).click();
    await expect(page.locator(`${EDITOR} .react-flow__node`).first()).toBeVisible();
    const opening = await settled(page, EDITOR);
    await page.keyboard.press("1");
    const fit = await settled(page, EDITOR);
    expect(Math.abs(opening - fit)).toBeGreaterThan(0.01);
    // Fresh: the reader again, then Edit with `1` straight after.
    await readerFrames(page);
    const editing = await hold(page, AUTHORING_OPEN);
    await editButton(page).click();
    if (delay > 0) await page.waitForTimeout(delay);
    await page.keyboard.press("1");
    // The window this tests: the key came while Edit was still opening, nothing of its drawing there yet.
    expect(await page.locator(`${EDITOR} .react-flow__node`).count()).toBe(0);
    editing.release();
    await expect(page.locator(`${EDITOR} .react-flow__node`).first()).toBeVisible();
    expect(editing.held()).toBeGreaterThan(0);
    expect(await settled(page, EDITOR)).toBeCloseTo(fit, 3);
  });
