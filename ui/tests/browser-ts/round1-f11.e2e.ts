// Round 1 (UI/UX) fixes, pass 4, batch F11: the app's focus lifecycle. Each test names its M2 checkpoint
// (docs/quality/rubrics/ui-ux-v1.1-lists.md) and the destination it names. The built page, on a fresh project of
// this worker's shared TypeScript service for each test: never the live service.
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { containersSource, containersWalkthroughs } from "../support/walkthrough-project";
import { sharedTsProject } from "./support/shared-service";

test.describe.configure({ timeout: 90_000 });

const FILES = {
  "archer.toml":
    'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Request flow"\nsource = ".archer/flow.mmd"\n' +
    '[[views]]\nid = "containers"\nkind = "c4"\ntitle = "Pageturner containers"\nsource = ".archer/containers.mmd"\n',
  ".archer/flow.mmd": "flowchart LR\n  a[Client]\n  b[API]\n  a calls@-->|HTTP| b\n",
  ".archer/containers.mmd": containersSource(),
  ".archer/containers.walkthroughs.json": containersWalkthroughs(),
  ".archer/notes/guide.md": "# Guide\n\nAmira has two books in her basket and checks out.\n\nThe second paragraph.\n",
};

let project: TsProject;
/** The clean project address, without a trailing slash: the legacy token page signs in with its path, which may not edit. */
let base: string;

test.beforeEach(async () => {
  project = await sharedTsProject({ files: FILES });
  const link = new URL(project.url);
  base = `${link.origin}/projects/${link.pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!}`;
});
test.afterEach(async () => {
  await project.stop();
});

/** Access for this browser: the sign-in link redeemed, which sets the access cookie. */
async function login(page: Page, authoring = false): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 900 });
  const access = authoring ? await project.issueAuthoringAccess("round1-f11") : await project.issueAccess("round1-f11");
  await page.goto(access.url);
  await page.waitForLoadState("networkidle");
}
/** A file opened as a person does, from the project's files: the in-app navigation the checkpoints name. */
async function openFile(page: Page, name: string): Promise<void> {
  const documents = await projectPage(page);
  await documents.getByRole("button", { name, exact: true }).click();
}
const focusedTag = (page: Page): Promise<string> => page.evaluate(() => document.activeElement?.tagName ?? "none");
const button = (scope: Page | Locator, name: string): Locator => scope.getByRole("button", { name, exact: true });
const readerEdit = (page: Page): Locator => button(page.locator(".archer-diagram-edit"), "Edit");
const editor = (page: Page): Locator => page.getByRole("region", { name: "Diagram Editor" });
const settled = async (page: Page): Promise<void> => {
  await expect(page.getByText("Checking preview…")).toHaveCount(0);
  await expect(page.locator(".authoring-workspace [aria-busy='true']")).toHaveCount(0);
};

async function projectPage(page: Page): Promise<Locator> {
  await page.goto(`${base}/`);
  const documents = page.getByRole("region", { name: "Project documents", exact: true });
  // The project page always lists its files: wait for them. ("Archer contents" is drawn at once, and a press on it
  // here leaves for /projects/ by a document load; a one-shot check that chose it under load did so, O49.)
  await expect(documents).toBeVisible();
  // Settled, so opening a file is the in-app navigation the checkpoints name, not a document load.
  await page.waitForLoadState("networkidle");
  expect(new URL(page.url()).pathname).toBe(new URL(`${base}/`).pathname);
  return documents;
}

test("F10: Enter on a note's title in the project's files lands on the note's h1", async ({ page }) => {
  await login(page);
  const documents = await projectPage(page);
  await documents.getByRole("button", { name: "Guide", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Guide" })).toBeFocused();
});

test("F14: Enter on a diagram's title in the project's files lands on the diagram's h1", async ({ page }) => {
  await login(page);
  const documents = await projectPage(page);
  await documents.getByRole("button", { name: "Request flow", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Request flow" })).toBeFocused();
});

test("F37/F40/F36: Cancel, Discard and Save in the editor return focus to Edit", async ({ page }) => {
  await login(page, true);
  await openFile(page, "Request flow");
  await expect(readerEdit(page)).toBeVisible();
  // F37: Cancel with nothing changed.
  await readerEdit(page).click();
  await expect(editor(page)).toBeVisible();
  await settled(page);
  await button(page.getByRole("banner"), "Cancel").click();
  await expect(editor(page)).toHaveCount(0);
  await expect(readerEdit(page)).toBeFocused();
  // F40: Cancel with a change, then Discard.
  await readerEdit(page).click();
  await expect(editor(page)).toBeVisible();
  await settled(page);
  await button(page.getByRole("toolbar", { name: "Flowchart parts" }), "Process").click();
  const label = page.getByRole("textbox", { name: /^n[0-9]+ label$/ });
  await expect(label).toBeFocused();
  await label.fill("Thrown away");
  await label.press("Enter");
  await button(page.getByRole("banner"), "Cancel").click();
  await button(page.getByRole("alertdialog", { name: "Discard your changes?" }), "Discard").click();
  await expect(editor(page)).toHaveCount(0);
  await expect(readerEdit(page)).toBeFocused();
  // F36: a successful Save ends editing; focus goes back to Edit.
  await readerEdit(page).click();
  await expect(editor(page)).toBeVisible();
  await settled(page);
  await button(page.getByRole("toolbar", { name: "Flowchart parts" }), "Process").click();
  await expect(label).toBeFocused();
  await label.fill("Kept");
  await label.press("Enter");
  await settled(page);
  const save = button(page.getByRole("banner"), "Save");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(editor(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(readerEdit(page)).toBeFocused();
});

test("F41: New → Diagram opens the editor with focus inside it, not on the page body", async ({ page }) => {
  await login(page, true);
  await page.goto(`${base}/-/edit/`);
  await expect(editor(page)).toBeVisible();
  await settled(page);
  // The editor's named entry (fixer B's F31 target, `[data-archer-editor-entry]`): the group named "Drawing".
  await expect(editor(page).locator("[data-archer-editor-entry]")).toBeFocused();
  await expect(editor(page).getByRole("group", { name: "Drawing" })).toBeFocused();
});

test("F48: Close source returns focus to Source", async ({ page }) => {
  await login(page);
  await openFile(page, "Request flow");
  const source = page.getByRole("button", { name: "Source", exact: true });
  await source.click();
  await expect(source).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close source" }).click();
  await expect(source).toHaveAttribute("aria-pressed", "false");
  await expect(source).toBeFocused();
});

// O55: while a diagram loads, Source is in a toolbar of its own; the drawing's arrival moves it into the canvas' cluster.
// Focus on it, or put back on it by Close source, used to be dropped to the page when that happened.
test("F48: Source keeps focus when the drawing arrives and moves it into the canvas toolbar", async ({ page }) => {
  await login(page);
  // The drawing waits on the layout worker: holding its script keeps the page loading.
  let held = 0;
  await page.route(/elk-layout-worker/, async (route) => {
    held += 1;
    await new Promise((done) => setTimeout(done, 3_000));
    await route.continue();
  });
  await openFile(page, "Request flow");
  const source = page.getByRole("button", { name: "Source", exact: true });
  await source.click();
  await expect(source).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Close source" }).click();
  await expect(source).toBeFocused();
  // Still loading: this Source is the loading page's own toolbar's.
  await expect(page.locator(".react-flow .archer-source-tool")).toHaveCount(0);
  await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
  expect(held).toBeGreaterThan(0);
  await expect(page.locator(".react-flow .archer-source-tool")).toBeFocused();
});

test("F30: every way out of a walkthrough returns focus to Walkthroughs, not pressed", async ({ page }) => {
  await login(page);
  await openFile(page, "Pageturner containers");
  const walks = page.locator(".archer-walk-open");
  const start = async (): Promise<void> => {
    await walks.click();
    await page
      .getByRole("group", { name: "Walkthroughs on this diagram" })
      .getByRole("button", { name: /Checkout and payment/ })
      .click();
    await expect(page.getByRole("slider", { name: "Step" })).toHaveValue("1");
  };
  // Close walkthrough.
  await start();
  await page.getByRole("button", { name: "Close walkthrough" }).click();
  await expect(walks).toHaveAttribute("aria-pressed", "false");
  await expect(walks).toBeFocused();
  // Escape from inside the panel.
  await start();
  await page.getByRole("button", { name: "Next step" }).first().focus();
  await page.keyboard.press("Escape");
  await expect(walks).toHaveAttribute("aria-pressed", "false");
  await expect(walks).toBeFocused();
  // Escape from Follow steps, beside the canvas's zoom controls.
  await start();
  await page.getByRole("button", { name: "Follow steps" }).focus();
  await page.keyboard.press("Escape");
  await expect(walks).toHaveAttribute("aria-pressed", "false");
  await expect(walks).toBeFocused();
  // With the agent's highlights under the walkthrough, Close still lands on Walkthroughs, not a highlight row.
  await project.setEmphasis("containers", [
    {
      id: "request-path",
      title: "Request path",
      groups: [{ id: "req", label: "request", style: "flow", nodes: ["web"], edges: [] }],
    },
  ]);
  await start();
  await page.getByRole("button", { name: "Close walkthrough" }).click();
  await expect(walks).toBeFocused();
});

test("F71: opening the project review focuses the selected Show tab", async ({ page }) => {
  await login(page);
  await projectPage(page);
  await page.getByRole("button", { name: /Notifications/ }).click();
  const review = page.getByRole("region", { name: "Project Review" });
  await expect(review).toBeVisible();
  await expect(review.getByRole("tablist", { name: "Show" }).getByRole("tab", { selected: true })).toBeFocused();
});

test("F11: C with a passage selected by keys opens the passage's New comment form", async ({ page }) => {
  await login(page);
  await openFile(page, "Guide");
  const body = page.locator(".archer-note-body");
  await expect(body).toContainText("Amira has two books");
  await body.focus();
  // A passage selected as caret browsing selects it (Shift+Arrow), as a selection the document fires selectionchange for.
  await page.evaluate(() => {
    const text = [...document.querySelectorAll(".archer-note-body p")].find((p) => p.textContent?.startsWith("Amira"))!
      .firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 15);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.press("c");
  const form = page.getByRole("form", { name: "New comment" });
  await expect(form).toBeVisible();
  await expect(form.getByRole("textbox").first()).toBeFocused();
  // The comment is about the passage, not the whole note: sent, it marks those words in the note.
  await form.getByRole("textbox").first().fill("About this passage.");
  await form.getByRole("button", { name: "Add comment" }).click();
  await expect(page.locator(".archer-note-body .archer-passage")).toHaveText("Amira has two b");
  await expect(page.getByRole("textbox", { name: "Message to the agent", exact: true })).toHaveCount(0);
});

test("F58: ? opened from the page body returns to the Keyboard shortcuts launcher, not the body", async ({ page }) => {
  await login(page);
  await openFile(page, "Request flow");
  await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await focusedTag(page)).toBe("BODY");
  await page.keyboard.press("?");
  await expect(page.getByRole("dialog", { name: "Keyboard & Pointer" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Keyboard & Pointer" })).toHaveCount(0);
  await expect(page.locator(".primary-help")).toBeFocused();
});
