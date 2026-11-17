// The page's first read and its event stream (ADR 0010, "Reconnection"): under load the stream
// opens seconds after the page read the standing state, and the page used to ask it all again: the
// registry, the presentation, what compiles and the emphasis on screen (O1 in the wave's known failures,
// seen as a doubled `api/emphasis/{seq,flow}` in the harness). The service numbers what it publishes, so
// the late stream keeps the read unless something was published after it. An isolated project.
import { expect, test, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { startTsProject, type TsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";

const FILES = {
  "archer.toml":
    'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n',
  ".archer/flow.mmd": "flowchart LR\n a[Client] e1@--> b[API]\n",
};
const STANDING = ["api/diagrams", "api/compile", "api/bootstrap", "api/emphasis/flow"];

/** The page with its event stream held back past the old one-second adoption window; `whileHeld` runs once the first
 * read is drawn, before the stream is let through. */
async function openLate(page: Page, server: TsProject, whileHeld?: () => Promise<void>): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname.replace(/^.*?\/(api\/)/, "$1");
    if (STANDING.includes(path)) counts.set(path, (counts.get(path) ?? 0) + 1);
  });
  let opened = false;
  await page.route("**/api/events", async (route) => {
    await new Promise((done) => setTimeout(done, 1500));
    opened = true;
    await route.continue();
  });
  await page.goto(server.url);
  await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
  await whileHeld?.();
  await expect.poll(() => opened).toBe(true);
  return counts;
}

test("a stream that opens late keeps the page's first read: nothing standing is asked twice", async ({ page }) => {
  const server = await startTsProject({ pagePath: testPage(), files: FILES });
  try {
    await server.present("flow");
    const counts = await openLate(page, server);
    // Long enough for the late stream's reads to have gone out, were they going to.
    await page.waitForTimeout(800);
    expect(Object.fromEntries(STANDING.map((path) => [path, counts.get(path) ?? 0]))).toEqual(
      Object.fromEntries(STANDING.map((path) => [path, 1])),
    );
  } finally {
    await server.stop();
  }
});

test("a stream that opens late after the agent published reads again and shows it", async ({ page }) => {
  const server = await startTsProject({ pagePath: testPage(), files: FILES });
  try {
    await server.present("flow");
    // Published while the stream is held back: the stream will never say it. The publish waits inside `openLate` for
    // the first draw; a wait of its own here started its clock before the page was opened, and at 2x throttle under
    // load the first draw took longer than that (O263).
    await openLate(page, server, () =>
      server.setEmphasis("flow", [
        {
          id: "late",
          title: "Late",
          groups: [{ id: "g", label: "late", style: "highlight", nodes: ["b"], edges: [] }],
        },
      ]),
    );
    await expect(page.locator('.react-flow__node[data-id="b"].archer-emph')).toBeVisible();
  } finally {
    await server.stop();
  }
});

// Leaving a project while its emphasis read is out cancels the read (the bridge disconnects): that is the page tidying
// up, not a failed load, and is not logged as one (O211, codex-1402). A read that fails while its view is on screen is.
test("an emphasis read cancelled by leaving the project is not logged as an error; a failed one is", async ({
  page,
}) => {
  const files = {
    ...FILES,
    "archer.toml": `version = 1\nname = "Cancel sample"\n${FILES["archer.toml"].slice("version = 1\n".length)}[[views]]\nid = "other"\nkind = "freeform"\ntitle = "Other"\nsource = ".archer/other.mmd"\n`,
    ".archer/other.mmd": "flowchart LR\n x[Queue] e1@--> y[Worker]\n",
  };
  const server = await startTsProject({ pagePath: resolve(import.meta.dirname, "../../dist/index.html"), files });
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("loading emphasis")) errors.push(message.text());
  });
  try {
    // Into the project from Projects and back out, inside one document, as a person browsing does.
    await page.goto(server.url);
    await expect(page.getByRole("button", { name: "Other", exact: true })).toBeVisible();
    await page.goto(`${new URL(server.url).origin}/projects/`);
    await page.getByRole("link", { name: "Cancel sample", exact: true }).click();
    await expect(page.getByRole("button", { name: "Other", exact: true })).toBeVisible();
    let release: () => void = () => {};
    let held = false;
    await page.route("**/api/emphasis/other", async (route) => {
      held = true;
      await new Promise<void>((done) => {
        release = done;
      });
      await route.continue().catch(() => {});
    });
    await page.getByRole("button", { name: "Other", exact: true }).click();
    await expect(page.locator('.react-flow__node[data-id="x"]')).toBeVisible();
    await expect.poll(() => held).toBe(true);
    await page.goBack();
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Projects", exact: true })).toBeVisible();
    release();
    // Long enough for the cancelled read's rejection to have been handled, were it going to be logged.
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);

    // The same view's read failing while it is on screen is still reported.
    await page.unroute("**/api/emphasis/other");
    await page.route("**/api/emphasis/other", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: '{"error":{"code":"internal","message":"seeded"}}',
      }),
    );
    await server.present("other");
    await page.goto(server.url);
    await expect(page.locator('.react-flow__node[data-id="x"]')).toBeVisible();
    await expect.poll(() => errors.length).toBeGreaterThan(0);
  } finally {
    await server.stop();
  }
});
