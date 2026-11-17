// Round 1 (UI/UX) fixes, pass 5, batch F19: app focus and editor leftovers, in a real browser. Each test names its row
// in the fifth fixes list and the finding it answers. The built page, on a fresh project of this worker's shared
// TypeScript service for each test: never the live service.
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { containersSource, containersWalkthroughs } from "../support/walkthrough-project";
import { sharedTsProject } from "./support/shared-service";

test.describe.configure({ timeout: 90_000 });

const FILES = {
  "archer.toml":
    'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Request flow"\nsource = ".archer/flow.mmd"\n' +
    '[[views]]\nid = "containers"\nkind = "c4"\ntitle = "Pageturner containers"\nsource = ".archer/containers.mmd"\n',
  ".archer/flow.mmd": "flowchart LR\n  a[Alpha]\n  b[Beta]\n  c[Gamma]\n  a e1@--> b\n",
  ".archer/containers.mmd": containersSource(),
  ".archer/containers.walkthroughs.json": containersWalkthroughs(),
  ".archer/notes/guide.md": "# Guide\n\nAmira has two books in her basket and checks out.\n\nThe second paragraph.\n",
};

let project: TsProject;
let base: string;

test.beforeEach(async () => {
  project = await sharedTsProject({ files: FILES });
  // The populated containers diagram: it has discussions, so its review opens in the diagram panel.
  await project.agentCreateComment("view:containers", { kind: "view" }, "Is the gateway still in front of the shop?");
  const link = new URL(project.url);
  base = `${link.origin}/projects/${link.pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!}`;
});
test.afterEach(async () => {
  await project.stop();
});

async function login(page: Page, authoring = false): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 900 });
  const access = authoring ? await project.issueAuthoringAccess("round1-f19") : await project.issueAccess("round1-f19");
  await page.goto(access.url);
  await page.waitForLoadState("networkidle");
}
/** A file opened as a person does, from the project's files. */
async function openFile(page: Page, name: string): Promise<void> {
  await page.goto(`${base}/`);
  const documents = page.getByRole("region", { name: "Project documents", exact: true });
  // The project page always lists its files: wait for them. ("Archer contents" is drawn at once, and a press on it
  // here leaves for /projects/ by a document load; a one-shot check that chose it under load did so, O49.)
  await expect(documents).toBeVisible();
  await page.waitForLoadState("networkidle");
  await documents.getByRole("button", { name, exact: true }).click();
}
/** What has keyboard focus: a canvas node's id, a named element's role and name, or the tag. */
const focused = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return "body";
    const n = active.closest<HTMLElement>(".react-flow__node");
    if (n && n === active) return `node:${n.dataset.id}`;
    const role = active.getAttribute("role") ?? active.tagName.toLowerCase();
    const name = active.getAttribute("aria-label") ?? active.textContent?.trim() ?? "";
    return `${role}:${name}`;
  });

test("R4-02: Notifications on the populated containers diagram opens the review in the panel with focus on its Show tab; Escape closes it to the bell", async ({
  page,
}) => {
  await login(page);
  await openFile(page, "Pageturner containers");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  const bell = page.getByRole("button", { name: /Notifications/ });
  await bell.click();
  const review = page.getByRole("region", { name: "Project Review" });
  await expect(review).toBeVisible();
  await expect(review).toHaveAttribute("data-in-panel", "true");
  await expect(review.getByRole("tablist", { name: "Show" }).getByRole("tab", { selected: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(review).toBeHidden();
  await expect(bell).toBeFocused();
});

test("R4-claude-05: Escape from a passage's New comment returns focus to the note, with the passage still selected", async ({
  page,
}) => {
  await login(page);
  await openFile(page, "Guide");
  const body = page.locator(".archer-note-body");
  await expect(body).toContainText("Amira has two books");
  // A pointer selection of the passage, then C.
  const words = body.getByText("Amira has two books", { exact: false });
  const box = (await words.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString() ?? "")).not.toBe("");
  const quote = await page.evaluate(() => document.getSelection()!.toString());
  await page.keyboard.press("c");
  const form = page.getByRole("form", { name: "New comment" });
  await expect(form.getByRole("textbox").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe("document:Note: Guide");
  expect(await page.evaluate(() => document.getSelection()?.toString() ?? "")).toBe(quote);
});

test("R4-claude-05: Escape from Comment on selection's New comment returns to the note too", async ({ page }) => {
  await login(page);
  await openFile(page, "Guide");
  const body = page.locator(".archer-note-body");
  await expect(body).toContainText("Amira has two books");
  await body.focus();
  await page.evaluate(() => {
    const text = [...document.querySelectorAll(".archer-note-body p")].find((p) => p.textContent?.startsWith("Amira"))!
      .firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 15);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  });
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: "Comment on selection" }).click();
  const form = page.getByRole("form", { name: "New comment" });
  await expect(form.getByRole("textbox").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
  await expect.poll(() => focused(page)).toBe("document:Note: Guide");
});

test("R4-claude S4: a click on the panel divider steps the width and keeps focus on the divider", async ({ page }) => {
  await login(page);
  await openFile(page, "Pageturner containers");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  // The diagram panel, opened from its key.
  const divider = page.getByRole("separator", { name: "Resize diagram panel" });
  if (!(await divider.isVisible())) await page.locator(".archer-walk-open").click();
  await expect(divider).toBeVisible();
  const before = Number(await divider.getAttribute("aria-valuenow"));
  await divider.click();
  await expect(divider).not.toHaveAttribute("aria-valuenow", String(before));
  await expect(divider).toBeFocused();
  const stepped = Number(await divider.getAttribute("aria-valuenow"));
  await page.keyboard.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", String(Math.min(640, stepped + 24)));
});

// A guard, not a red test: the release after a cancelled drag lands on the pane, but in the editor's marquee mode React
// Flow takes a pane click only from a press that began on the pane, so the selection was already kept. (A drag never
// selects a shape here, cancelled or not; the re-score's "selected 0" was a shape never selected.)
test("F12 S4: after Escape cancels a node drag, the release keeps the shape selected", async ({ page }) => {
  await login(page, true);
  await openFile(page, "Request flow");
  await page.locator(".archer-diagram-edit").getByRole("button", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("region", { name: "Diagram Editor" });
  await expect(editor).toBeVisible();
  await expect(page.getByText("Checking preview…")).toHaveCount(0);
  const node = page.locator('.authoring-workspace .react-flow__node[data-id="a"]');
  await expect(node).toBeVisible();
  await node.click();
  await expect(node).toHaveClass(/selected/);
  const start = (await node.boundingBox())!;
  const x = start.x + start.width / 2,
    y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 90, { steps: 10 });
  await page.keyboard.press("Escape");
  await expect.poll(async () => Math.round((await node.boundingBox())!.x)).toBe(Math.round(start.x));
  await page.mouse.up();
  await page.waitForTimeout(150);
  await expect(node).toHaveClass(/selected/);
  // The next ordinary click on the pane still clears it.
  await page.mouse.click(x + 120, y + 200);
  await expect(node).not.toHaveClass(/selected/);
});

test("R4-claude-05 (F54): a passage comment sent with Ctrl+Enter lands on its new thread, and Escape then returns to its passage, never the bell", async ({
  page,
}) => {
  await login(page);
  await openFile(page, "Guide");
  const body = page.locator(".archer-note-body");
  await expect(body).toContainText("Amira has two books");
  await body.focus();
  await page.evaluate(() => {
    const text = [...document.querySelectorAll(".archer-note-body p")].find((p) =>
      p.textContent?.startsWith("The second"),
    )!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 10);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  });
  await page.keyboard.press("c");
  const form = page.getByRole("form", { name: "New comment" });
  await expect(form.getByRole("textbox").first()).toBeFocused();
  await page.keyboard.type("About the second paragraph.");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".archer-note-body .archer-passage")).toHaveText("The second");
  // The new thread's card (its first control).
  await expect.poll(() => focused(page)).toBe("button:Show full quoted passage “The second”");
  await page.keyboard.press("Escape");
  // Its passage's discussion (the margin bubble or the mark), at the reader's place in the note.
  await expect.poll(() => focused(page)).toMatch(/^button:Open discussion on/);
});
