// Round 1 (UI/UX) fixes, pass 8, batch F30: no stray fits (R6-claude-07). A Fit (`1`) is queued only while a
// drawing is opening on this page, and it belongs to that drawing: a Fit pressed on the project page is not
// carried into the diagram opened next, and one pressed while A opens is dropped when the reader moves on to B.
// The V7 rule still holds (`]` then `1` fits B, the drawing that was opening). The built page, on a fresh project
// of this worker's shared TypeScript service for each test.
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { containersSource } from "../support/walkthrough-project";
import { sharedTsProject } from "./support/shared-service";

test.describe.configure({ timeout: 90_000 });

// Two copies of the same drawing (so both open at the same framing and fit to the same zoom), and one that has
// never compiled.
const FILES = {
  "archer.toml":
    "version = 1\n" +
    '[[views]]\nid = "alpha"\nkind = "c4"\ntitle = "Alpha containers"\nsource = ".archer/alpha.mmd"\n' +
    '[[views]]\nid = "beta"\nkind = "c4"\ntitle = "Beta containers"\nsource = ".archer/beta.mmd"\n' +
    '[[views]]\nid = "broken"\nkind = "flowchart"\ntitle = "Broken flow"\nsource = ".archer/broken.mmd"\n',
  ".archer/alpha.mmd": containersSource(),
  ".archer/beta.mmd": containersSource(),
  ".archer/broken.mmd": "flowchart LR\n  A[Start --> \n  ((((\n",
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
  await page.goto((await project.issueAuthoringAccess("round1-f30")).url);
  await page.waitForLoadState("networkidle");
}
/** The project page with its files listed, ready for a click on a diagram. */
async function projectFiles(page: Page): Promise<void> {
  await page.goto(`${base}/`);
  const documents = page.getByRole("region", { name: "Project documents", exact: true });
  // The project page always lists its files: wait for them. ("Archer contents" is drawn at once, and a press on it
  // here leaves for /projects/ by a document load; a one-shot check that chose it under load did so, O49.)
  await expect(documents).toBeVisible();
  await page.waitForLoadState("networkidle");
}
const open = (page: Page, title: string | RegExp) =>
  page
    .getByRole("region", { name: "Project documents", exact: true })
    .getByRole("button", { name: title, exact: true })
    .click();
const zoom = (page: Page): Promise<number | null> =>
  page.evaluate(() => {
    const viewport = document.querySelector(".react-flow__viewport");
    return viewport === null ? null : Math.round(new DOMMatrix(getComputedStyle(viewport).transform).a * 1e4) / 1e4;
  });
/** The drawing's scale once it holds still for half a second. */
async function settled(page: Page): Promise<number> {
  let last: number | null = null;
  await expect
    .poll(
      async () => {
        const now = await zoom(page);
        const still = now !== null && now === last;
        last = now;
        return still;
      },
      { intervals: [500], timeout: 15_000 },
    )
    .toBe(true);
  return last!;
}
/**
 * Holds every request to `url` until `release()`. A key pressed in between lands while that drawing is opening, on
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
/** The layout worker's script: a drawing (its model read) waits on it, and a fresh document fetches it again. */
const LAYOUT_WORKER = /elk-layout-worker/;
/** A diagram's model: an in-app move to it, the worker already running, waits on that. */
const model = (id: string) => new RegExp(`/api/diagrams/${id}(?:\\?.*)?$`);
const drawn = (page: Page) => expect(page.locator(".react-flow__node").first()).toBeVisible();
/** The page is on `id`'s address, and draws it. */
async function on(page: Page, id: string): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`${id}(?:\\.mmd)?/?(?:[?#].*)?$`));
  await drawn(page);
}

/** The opening framing and the fit differ on this drawing at this size, or the trials below prove nothing. */
async function frames(page: Page): Promise<{ opening: number; fit: number }> {
  await projectFiles(page);
  await open(page, "Alpha containers");
  await on(page, "alpha");
  const opening = await settled(page);
  await page.keyboard.press("1");
  const fit = await settled(page);
  expect(Math.abs(opening - fit)).toBeGreaterThan(0.01);
  return { opening, fit };
}

for (const gap of [300, 1500])
  test(`1 on the project page is not carried into a diagram opened ${gap}ms later`, async ({ page }) => {
    await login(page);
    const { opening } = await frames(page);
    await projectFiles(page);
    await page.keyboard.press("1");
    await page.waitForTimeout(gap);
    await open(page, "Alpha containers");
    await on(page, "alpha");
    expect(await settled(page)).toBeCloseTo(opening, 3);
  });

test("1 while A opens, then ] at 40ms: B opens at its own framing, unfitted", async ({ page }) => {
  await login(page);
  const { opening } = await frames(page);
  await projectFiles(page);
  const alpha = await hold(page, LAYOUT_WORKER);
  await open(page, "Alpha containers");
  await page.keyboard.press("1");
  await page.waitForTimeout(40);
  await page.keyboard.press("]");
  // The window this tests: both keys came while A was still opening, nothing of it drawn.
  expect(await page.locator(".react-flow__node").count()).toBe(0);
  alpha.release();
  expect(alpha.held()).toBeGreaterThan(0);
  await on(page, "beta");
  expect(await settled(page)).toBeCloseTo(opening, 3);
});

test("a settled 1, then ]: the next diagram opens unfitted", async ({ page }) => {
  await login(page);
  const { opening } = await frames(page);
  // `frames` left Alpha fitted; the Fit it took must not linger for Beta.
  await page.keyboard.press("]");
  await on(page, "beta");
  expect(await settled(page)).toBeCloseTo(opening, 3);
});

test("] then 1 at once: the diagram that was opening (B) is the one fitted", async ({ page }) => {
  await login(page);
  const { opening, fit } = await frames(page);
  // Back to Alpha's opening framing, settled, then `]` and `1` back to back.
  await projectFiles(page);
  await open(page, "Alpha containers");
  await on(page, "alpha");
  expect(await settled(page)).toBeCloseTo(opening, 3);
  const beta = await hold(page, model("beta"));
  await page.keyboard.press("]");
  await page.keyboard.press("1");
  // The window this tests: `1` came while B was opening (its model not yet answered), with A drawn and settled.
  beta.release();
  await on(page, "beta");
  expect(beta.held()).toBeGreaterThan(0);
  expect(await settled(page)).toBeCloseTo(fit, 3);
});

test("1 on a diagram that never compiled does not fit the diagram opened next", async ({ page }) => {
  await login(page);
  const { opening } = await frames(page);
  await projectFiles(page);
  // A diagram that never compiled is listed by its id, with "Does not compile".
  await open(page, /^broken/);
  await expect(page.locator(".react-flow__node")).toHaveCount(0);
  await page.keyboard.press("1");
  await page.waitForTimeout(200);
  await page.keyboard.press("[");
  await on(page, "beta");
  expect(await settled(page)).toBeCloseTo(opening, 3);
});

// A queued Fit has no clock: it waits for its drawing however slow the open. A 3 s life dropped it whenever an open
// took longer, as under load (O59); only the page moving on drops it (the tests above).
test("a diagram slower than 3 s to open still fits once it is drawn", async ({ page }) => {
  await login(page);
  const { fit } = await frames(page);
  await projectFiles(page);
  let delayed = 0;
  await page.route(/\/api\/diagrams\/beta(?:\?.*)?$/, async (route) => {
    delayed += 1;
    await new Promise((done) => setTimeout(done, 3_600));
    await route.continue();
  });
  await open(page, "Beta containers");
  await page.keyboard.press("1");
  await on(page, "beta");
  expect(delayed).toBeGreaterThan(0);
  expect(await settled(page)).toBeCloseTo(fit, 3);
});

// R6-claude-09: the pointer resting on the rail opens it over the canvas' left edge; keyboard focus moving on to a
// control there (Zoom in) folds it, so the focused control is not covered.
test("R6-claude-09: Tab to Zoom in while the pointer rests on the rail: the rail folds and Zoom in is not covered", async ({
  page,
}) => {
  await login(page);
  await projectFiles(page);
  await open(page, "Alpha containers");
  await on(page, "alpha");
  await settled(page);
  const rail = page.locator("aside.primary-navigation");
  await page.mouse.move(700, 450);
  await page.mouse.move(30, 600, { steps: 5 });
  await expect(rail).toHaveAttribute("data-expanded", "true");
  const zoomIn = page.getByRole("button", { name: "Zoom in", exact: true });
  let reached = false;
  for (let i = 0; i < 80 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await zoomIn.evaluate((button) => button === document.activeElement);
  }
  expect(reached).toBe(true);
  await expect(rail).toHaveAttribute("data-expanded", "false");
  // Once the fold has finished, what is at Zoom in's centre is Zoom in.
  await expect
    .poll(() =>
      zoomIn.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return at !== null && button.contains(at);
      }),
    )
    .toBe(true);
  // The pointer has not moved: the rail stays folded.
  await page.waitForTimeout(800);
  await expect(rail).toHaveAttribute("data-expanded", "false");
});
