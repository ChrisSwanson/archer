// The in-place diagram editor end to end: the real page against the TypeScript service, real files on disk.
// Selectors are roles, accessible names and visible text (what a person or screen reader meets), never layout classes,
// except React Flow's own node/edge/handle classes, which are the canvas's public structure.
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { startTsProject, type TsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";

const PAGE = testPage();
const original = "flowchart LR\n  a[Client]\n  b[API]\n  a calls@-->|HTTP| b\n";
const files = {
  "archer.toml":
    'version = 1\n\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Request flow"\nsource = ".archer/flow.mmd"\n',
  ".archer/flow.mmd": original,
};
let project: TsProject;
const slug = () => new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
const origin = () => new URL(project.url).origin;
/** The diagram's own address with ?edit (the editor opens in place); '' is the New diagram editor. */
const editUrl = (file: string | null = "flow.mmd") =>
  file === null ? `${origin()}/projects/${slug()}/-/edit/` : `${origin()}/projects/${slug()}/${file}?edit`;
const disk = (rel = ".archer/flow.mmd") => readFileSync(join(project.root, rel), "utf8");
// Editor journeys with several axe passes: under four parallel workers one can take most of a minute.
test.describe.configure({ timeout: 90_000 });
test.beforeEach(async () => {
  project = await startTsProject({ files, pagePath: PAGE });
});
test.afterEach(async ({ page }) => {
  await page.close();
  await project.stop();
});

const editor = (page: Page) => page.getByRole("region", { name: "Diagram Editor" });
const tools = (page: Page) => page.getByRole("toolbar", { name: "Editing tools" });
const parts = (page: Page) => page.getByRole("toolbar", { name: "Flowchart parts" });
const button = (scope: Page | Locator, name: string) => scope.getByRole("button", { name, exact: true });
const save = (page: Page) => button(page.getByRole("banner"), "Save");
const cancel = (page: Page) => button(page.getByRole("banner"), "Cancel");
/** The reading page's Edit, at the drawing's top right. */
const readerEdit = (page: Page) => button(page.locator(".archer-diagram-edit"), "Edit");
const panel = (page: Page) => page.getByRole("complementary", { name: "Structure and properties" });
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const status = (page: Page) => editor(page).getByRole("status").first();
/** The editor's Mermaid source box: a textarea, or the CodeMirror editor that replaces it (its text box keeps the id). */
const sourceBox = (page: Page) =>
  page
    .getByRole("textbox", { name: /^Mermaid source/ })
    .or(page.locator("#authoring-source"))
    .first();
/** Its text: the textarea's value, or CodeMirror's document (it renders only the lines in view). */
const sourceOf = (page: Page) =>
  sourceBox(page).evaluate((el) => {
    if (el instanceof HTMLTextAreaElement) return el.value;
    const content = (el.closest(".cm-content") ?? el) as HTMLElement & {
      cmTile?: { view?: { state: { doc: { toString(): string } } } };
    };
    return (
      content.cmTile?.view?.state.doc.toString() ??
      [...content.querySelectorAll(".cm-line")].map((line) => line.textContent).join("\n")
    );
  });
const settled = async (page: Page) => {
  await expect(page.getByText("Checking preview…")).toHaveCount(0);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
};

async function login(page: Page, label = "Browser authoring acceptance") {
  const access = await project.issueAuthoringAccess(label);
  await page.goto(access.url);
}
async function author(page: Page, file: string | null = "flow.mmd") {
  await login(page);
  await page.goto(editUrl(file));
  await expect(editor(page)).toBeVisible();
  await expect(tools(page)).toBeVisible();
  if (file !== null) await expect(node(page, "a")).toBeVisible();
  await settled(page);
}
/** Save in place: the file is written and the page goes back to reading the diagram. */
async function saveAndExit(page: Page) {
  await settled(page);
  await expect(save(page)).toBeEnabled();
  await save(page).click();
  await expect(editor(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(readerEdit(page)).toBeVisible();
}
async function dragBy(page: Page, target: Locator, dx: number, dy: number) {
  const b = (await target.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 12 });
  await page.mouse.up();
}
/** No axe violations. `known` names a rule already reported as an app bug: it is left out of this one check and
 * recorded as a test annotation, so the report shows it while every other rule still fails the test. */
async function axe(page: Page, known?: { rule: string; issue: string }) {
  const violations = (await new AxeBuilder({ page }).analyze()).violations;
  if (known && violations.some((v) => v.id === known.rule))
    test.info().annotations.push({ type: "known a11y issue", description: `${known.rule}: ${known.issue}` });
  expect(violations.filter((v) => v.id !== known?.rule)).toEqual([]);
}
async function shot(page: Page, name: string) {
  if (!process.env.ARCHER_AUTHORING_SHOTS) return;
  mkdirSync(process.env.ARCHER_AUTHORING_SHOTS, { recursive: true });
  await page.screenshot({ path: join(process.env.ARCHER_AUTHORING_SHOTS, name + ".png"), fullPage: true });
}

test("an ordinary reading link opens the editor, and so does the owner signed in by the token address; a browser that may not edit is told so", async ({
  page,
}) => {
  // The owner's sign-in (the token address, exchanged for an owner session) edits like any link (security round 1, G3).
  await page.goto(project.url);
  await page.goto(editUrl());
  await expect(editor(page)).toBeVisible();
  await expect(save(page)).toBeVisible();
  expect(disk()).toBe(original);
  // A credential the service refuses for authoring (stubbed: no browser sign-in gets this answer now) sees why, and no Save.
  await page.route(
    (url) => url.pathname.endsWith("/api/authoring"),
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 200, contentType: "application/json", body: '{"authorized":false}' })
        : route.continue(),
  );
  await page.goto(editUrl());
  await expect(page.getByText(/Editing is unavailable on this access link/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  expect(disk()).toBe(original);
  await axe(page);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const reader = await project.issueAccess("Ordinary reader");
  await page.goto(reader.url);
  await page.goto(editUrl());
  await expect(editor(page)).toBeVisible();
  await expect(save(page)).toBeVisible();
});

test("New ends the tab row on every tab and opens Diagram; a diagram page offers Edit on the drawing and New in its header", async ({
  page,
}) => {
  await login(page, "Browser authoring entry");
  await page.goto(`${origin()}/projects/${slug()}/`);
  const tabs = page.getByRole("tablist", { name: "Project content" });
  await expect(tabs).toBeVisible();
  const newButton = page.getByRole("button", { name: "New", exact: true });
  for (const tab of [/^Folders/, /^Diagrams/, /^Notes/]) {
    await tabs.getByRole("tab", { name: tab }).click();
    await expect(newButton).toBeVisible();
    await expect(page.getByRole("tabpanel").getByRole("button", { name: "New", exact: true })).toHaveCount(0);
  }
  const t = (await tabs.boundingBox())!,
    b = (await newButton.boundingBox())!;
  expect(b.x).toBeGreaterThanOrEqual(t.x + t.width - 1);
  await newButton.click();
  const menu = page.getByRole("menu", { name: "New" });
  await expect(menu).toBeVisible();
  const entry = menu.getByRole("menuitem", { name: "Diagram", exact: true });
  await expect(entry).toBeFocused();
  expect(new URL((await entry.getAttribute("href")) ?? "", page.url()).pathname).toBe(`/projects/${slug()}/-/edit/`);
  await expect(page.getByText("Nothing is written to the repository until you Save.")).toBeVisible();
  await axe(page);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(newButton).toBeFocused();
  await newButton.click();
  await expect(menu).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(menu).toHaveCount(0);
  await tabs.getByRole("tab", { name: /^Diagrams/ }).click();
  await page.getByRole("button", { name: "Request flow", exact: true }).click();
  const edit = readerEdit(page);
  await expect(edit).toBeVisible();
  await expect(page.getByRole("banner").getByRole("button", { name: "New", exact: true })).toBeVisible();
  await edit.click();
  await expect(editor(page)).toBeVisible();
  const target = new URL(page.url());
  expect(target.pathname).toBe(`/projects/${slug()}/flow.mmd`);
  expect(target.searchParams.has("edit")).toBe(true);
  await cancel(page).click();
  await expect(editor(page)).toHaveCount(0);
  await page.goto(`${origin()}/projects/${slug()}/`);
  await expect(newButton).toBeVisible();
  // The editor's own page carries the shell's shared breadcrumb, not a bare link (G5).
  await page.goto(`${origin()}/projects/${slug()}/-/edit/`);
  await expect(
    page
      .getByRole("banner")
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("button", { name: "Projects", exact: true }),
  ).toBeVisible();
  await page.goto(`${origin()}/projects/${slug()}/`);
  await expect(newButton).toBeVisible();
  // A phone's editor is read-only, so New is not offered there (G5); a note says editing is on desktop (D6).
  await page.setViewportSize({ width: 375, height: 720 });
  await expect(tabs).toBeVisible();
  await expect(newButton).toHaveCount(0);
  await expect(page.getByText("Editing is on desktop", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
});

test("a sidebar pencil keyboard edit saves a private proposal, survives a reload and Save writes the real bytes", async ({
  page,
}) => {
  await author(page);
  await button(tools(page), "Structure and properties").click();
  await expect(panel(page)).toBeVisible();
  await button(panel(page), "Client").click();
  const pencil = button(panel(page), "Edit Client label"),
    value = button(panel(page), "Client");
  const p = (await pencil.boundingBox())!,
    v = (await value.boundingBox())!;
  expect(p.x + p.width).toBeLessThanOrEqual(v.x + 1);
  await pencil.focus();
  await pencil.press("Enter");
  const field = panel(page).getByRole("textbox", { name: "Client label", exact: true });
  await expect(field).toBeFocused();
  await field.fill("Changed Client");
  await field.press("Escape");
  await expect(button(panel(page), "Client")).toBeVisible();
  await pencil.press("Enter");
  await field.fill("Browser Client");
  await field.press("Enter");
  await expect(button(panel(page), "Browser Client")).toBeVisible();
  await expect(node(page, "a")).toContainText("Browser Client");
  await settled(page);
  await expect(save(page)).toBeEnabled();
  await shot(page, "desktop");
  await axe(page);
  await panel(page).getByText("Draft and proposal tools", { exact: true }).click();
  await button(panel(page), "Save proposal privately").click();
  await expect(panel(page).getByRole("link", { name: /revision 1/ })).toBeVisible();
  expect(disk()).toBe(original);
  await page.reload();
  await expect(editor(page)).toBeVisible();
  await expect(node(page, "a")).toContainText("Browser Client");
  await expect(save(page)).toBeEnabled();
  await saveAndExit(page);
  await expect.poll(() => disk()).toContain("Browser Client");
  await axe(page);
});

test("a change outside the editor keeps the working copy, refuses Save, and a phone is review only", async ({
  page,
}) => {
  await author(page);
  await node(page, "a").dblclick();
  const field = page.getByRole("textbox", { name: "a label", exact: true });
  await field.fill("Proposal Client");
  await field.press("Enter");
  await expect(node(page, "a")).toContainText("Proposal Client");
  writeFileSync(join(project.root, ".archer/flow.mmd"), original.replace("Client", "External Client"));
  const banner = editor(page)
    .getByRole("alert")
    .filter({ hasText: /changed outside the editor/ });
  await expect(banner).toBeVisible();
  await expect(button(banner, "Copy my Mermaid")).toBeVisible();
  await expect(banner.getByRole("link", { name: "Reopen the current original" })).toBeVisible();
  if (await save(page).isEnabled()) await save(page).click();
  await expect(editor(page).getByText(/Save is blocked: the original changed while you edited/)).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await expect(node(page, "a")).toContainText("Proposal Client");
  expect(disk()).toContain("External Client");
  await shot(page, "conflict");
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText(/Review only on this screen/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "Editing tools" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, "phone");
  await axe(page);
});

test("a new diagram saves a private draft, then Save as writes it where asked and it edits again in place", async ({
  page,
}) => {
  await author(page, null);
  await expect(status(page)).toContainText("nothing is written to the repository until you Save");
  await button(parts(page), "Process").click();
  const label = page.getByRole("textbox", { name: /^n[0-9]+ label$/ });
  await expect(label).toBeFocused();
  await label.fill("First step");
  await label.press("Enter");
  await settled(page);
  await button(tools(page), "Structure and properties").click();
  await panel(page).getByText("Draft and proposal tools", { exact: true }).click();
  await button(panel(page), "Save draft privately").click();
  await expect(panel(page).getByRole("link", { name: /revision 1/ })).toBeVisible();
  await editor(page).getByRole("textbox", { name: "Save as", exact: true }).fill("diagrams/published.mmd");
  await saveAndExit(page);
  expect(new URL(page.url()).pathname).toBe(`/projects/${slug()}/diagrams/published.mmd`);
  expect(disk(".archer/diagrams/published.mmd")).toMatch(/^flowchart/);
  expect(disk(".archer/diagrams/published.mmd")).toContain("First step");
  await readerEdit(page).click();
  await expect(editor(page)).toBeVisible();
  const first = page.locator(".react-flow__node").first();
  await expect(first).toBeVisible();
  await first.dblclick();
  const again = page.getByRole("textbox", { name: / label$/ });
  await expect(again).toBeFocused();
  await again.fill("Saved again");
  await again.press("Enter");
  await saveAndExit(page);
  await expect.poll(() => disk(".archer/diagrams/published.mmd")).toContain("Saved again");
  await axe(page);
});

test("drawing gestures move, label, add, connect and label a connection through the lossless engine", async ({
  page,
}) => {
  await author(page);
  const client = node(page, "a");
  await expect(client).toHaveClass(/\bdraggable\b/);
  const before = (await client.boundingBox())!;
  await dragBy(page, client, 85, 75);
  await expect.poll(async () => (await client.boundingBox())!.x).toBeGreaterThan(before.x + 50);
  expect(disk()).toBe(original);
  await client.dblclick();
  const aLabel = page.getByRole("textbox", { name: "a label", exact: true });
  await expect(aLabel).toBeFocused();
  await aLabel.fill("Drawn client");
  await aLabel.press("Enter");
  await expect(client).toContainText("Drawn client");
  await expect(save(page)).toBeEnabled();
  await button(parts(page), "Decision").click();
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  const placedInput = page.getByRole("textbox", { name: /^n[0-9]+ label$/ });
  await expect(placedInput).toBeFocused();
  const newId = (await placedInput.getAttribute("aria-label"))!.replace(/ label$/, "");
  await placedInput.fill("Decision");
  await placedInput.press("Enter");
  await expect(node(page, newId)).toContainText("Decision");
  await expect(button(page, "Select mode")).toHaveAttribute("aria-pressed", "true");
  await settled(page);
  const from = (await node(page, newId).locator(".react-flow__handle.source").boundingBox())!,
    to = (await node(page, "b").locator(".react-flow__handle.target").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  const edge = page.locator('.react-flow__edge[data-id="e1"]');
  await expect(edge).toBeVisible();
  await settled(page);
  await edge.focus();
  await edge.press("Enter");
  const edgeLabel = page.getByRole("textbox", { name: "e1 connection label" });
  await expect(edgeLabel).toBeFocused();
  await edgeLabel.fill("Approved");
  await edgeLabel.press("Enter");
  await settled(page);
  const source = button(page, "Mermaid source");
  await expect(source).toHaveText("Source");
  await source.click();
  await expect(source).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => sourceOf(page)).toMatch(/Decision/);
  await expect.poll(() => sourceOf(page)).toMatch(/Approved/);
  expect(disk()).toBe(original);
  await shot(page, "drawing");
  await axe(page);
  await saveAndExit(page);
  await expect.poll(() => disk()).toContain("Approved");
  expect(disk()).toContain("Drawn client");
});

test("Save persists moved positions for a fresh browser visitor; a deleted new part leaves none behind", async ({
  page,
  browser,
}) => {
  await author(page);
  const a = node(page, "a");
  await dragBy(page, a, 130, 95);
  await settled(page);
  // Where a sits relative to b: a fresh visitor's view is fitted again, so absolute screen positions differ.
  const offset = async (p: Page) => {
    const x = (await node(p, "a").boundingBox())!,
      y = (await node(p, "b").boundingBox())!;
    return { dx: x.x - y.x, dy: x.y - y.y };
  };
  const moved = await offset(page);
  await button(parts(page), "Process").click();
  const input = page.getByRole("textbox", { name: /^n[0-9]+ label$/ });
  await expect(input).toBeFocused();
  const id = (await input.getAttribute("aria-label"))!.replace(/ label$/, "");
  await input.press("Escape");
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  await node(page, id).click();
  await button(tools(page), "Delete selected").click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await saveAndExit(page);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const fresh = await context.newPage(),
      access = await project.issueAuthoringAccess("Fresh position visitor");
    await fresh.goto(access.url);
    await fresh.goto(editUrl());
    const reopened = node(fresh, "a");
    await expect(reopened).toBeVisible();
    await expect.poll(async () => Math.abs((await offset(fresh)).dx - moved.dx)).toBeLessThan(2);
    await expect.poll(async () => Math.abs((await offset(fresh)).dy - moved.dy)).toBeLessThan(2);
    await expect(fresh.locator(".react-flow__node")).toHaveCount(2);
  } finally {
    await context.close();
  }
});

test("canvas label editing, Direction, one-step placement, Undo and Cancel discard use direct interactions", async ({
  page,
}) => {
  await author(page);
  const structure = button(tools(page), "Structure and properties");
  await expect(structure).toHaveAttribute("aria-pressed", "false");
  await node(page, "a").dblclick();
  const label = page.getByRole("textbox", { name: "a label", exact: true });
  await expect(label).toBeFocused();
  await expect(structure).toHaveAttribute("aria-pressed", "false");
  const fieldBox = (await label.boundingBox())!,
    nodeBox = (await node(page, "a").boundingBox())!;
  expect(Math.abs(fieldBox.x + fieldBox.width / 2 - nodeBox.x - nodeBox.width / 2)).toBeLessThan(2);
  await label.fill("Discarded label");
  await shot(page, "inline-label");
  await axe(page);
  await label.press("Escape");
  await expect(node(page, "a")).toContainText("Client");
  await expect(status(page)).toContainText("no changes yet");
  await structure.click();
  await expect(panel(page)).toBeVisible();
  await button(panel(page), "Edit Direction").click();
  const direction = panel(page).getByRole("combobox", { name: "Direction", exact: true });
  await direction.selectOption("Top to bottom");
  await direction.press("Enter");
  await expect(save(page)).toBeEnabled();
  await expect
    .poll(async () => {
      const a = (await node(page, "a").boundingBox())!,
        b = (await node(page, "b").boundingBox())!;
      return b.y - a.y;
    })
    .toBeGreaterThan(60);
  await structure.click();
  await button(page, "Hand mode").click();
  await expect(button(page, "Hand mode")).toHaveAttribute("aria-pressed", "true");
  // A part is added from the bar in one click even while Hand mode is on; its name editor opens at once.
  // (Hand mode stays on afterwards: reported to the canvas owners, not asserted either way here.)
  await button(parts(page), "Decision").click();
  const placed = page.getByRole("textbox", { name: /^n[0-9]+ label$/ });
  await expect(placed).toBeFocused();
  const id = (await placed.getAttribute("aria-label"))!.replace(/ label$/, "");
  await placed.press("Escape");
  await expect(node(page, id)).toBeVisible();
  await settled(page);
  await button(page, "Select mode").click();
  await expect(button(page, "Select mode")).toHaveAttribute("aria-pressed", "true");
  await button(tools(page), "Undo").click();
  await expect(node(page, id)).toHaveCount(0);
  await node(page, "a").dblclick();
  await label.fill("Unsaved label");
  await label.press("Enter");
  await expect(node(page, "a")).toContainText("Unsaved label");
  await cancel(page).click();
  const dialog = page.getByRole("alertdialog", { name: "Discard your changes?" });
  await expect(dialog).toBeVisible();
  await axe(page);
  await button(dialog, "Keep editing").click();
  await expect(node(page, "a")).toContainText("Unsaved label");
  await cancel(page).click();
  await button(dialog, "Discard").click();
  await expect(editor(page)).toHaveCount(0);
  await expect(page.locator('.react-flow__node[data-id="a"]')).toContainText("Client");
  expect(new URL(page.url()).searchParams.has("edit")).toBe(false);
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("archer.authoring.v1:"))),
  ).toEqual([]);
  expect(disk()).toBe(original);
  await axe(page);
  await shot(page, "direct-label");
});

test("an unfinished save from an earlier service is recoverable in a fresh browser without local pending data", async ({
  page,
}) => {
  await project.stop();
  const operationId = "7".repeat(32);
  project = await startTsProject({
    files,
    pagePath: PAGE,
    beforeService: async (stateDir, projectRoot) => {
      const { AuthoringStore } = (await import(
        /* @vite-ignore */ pathToFileURL(resolve(import.meta.dirname, "../../../ts/src/authoring/store.ts")).href
      )) as {
        AuthoringStore: new (
          options: unknown,
        ) => {
          putSnapshot(bytes: Uint8Array): { revision: string; bytes: number };
          beginOperation(input: unknown): unknown;
        };
      };
      const store = new AuthoringStore({ stateDir, serviceName: "default", assertOwner() {} }),
        base = store.putSnapshot(Buffer.from(original)),
        candidate = store.putSnapshot(Buffer.from(original.replace("Client", "Uncertain client")));
      store.beginOperation({
        operationId,
        payloadDigest: "sha256:" + "8".repeat(64),
        op: "document.apply",
        projectRoot,
        authority: { grantId: "fixture-grant", entitlementId: "fixture-entitlement" },
        feedback: { changes: "on_save", delivery: "next_call", effectiveRevision: "sha256:" + "9".repeat(64) },
        target: { kind: "document", path: ".archer/flow.mmd" },
        expected: { sourceRevision: base.revision },
        base,
        candidate,
      });
    },
  });
  await login(page);
  await page.goto(editUrl());
  await expect(editor(page)).toBeVisible();
  await expect(status(page)).toContainText(/uncertain|unresolved/);
  await expect(save(page)).toBeDisabled();
  await expect(button(page, "Abandon uncertain operation")).toHaveCount(0);
  await button(page, "Check status").click();
  await expect(button(page, "Abandon uncertain operation")).toBeVisible();
  await button(page, "Abandon uncertain operation").click();
  await expect(button(page, "Abandon uncertain operation")).toHaveCount(0);
  await expect(button(page, "Check status")).toHaveCount(0);
  expect(disk()).toBe(original);
  await axe(page);
});

test("the shared navigation overlay dismisses without clipping the idle desktop editor", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await author(page);
  const navigation = page
    .getByRole("complementary")
    .filter({ has: page.getByRole("navigation", { name: "Workspace" }) });
  const rail0 = (await navigation.boundingBox())!;
  await page.mouse.move(rail0.x + rail0.width / 2, 110);
  await expect.poll(async () => (await navigation.boundingBox())!.width).toBeGreaterThan(rail0.width + 100);
  await page.mouse.move(1200, 500);
  await expect.poll(async () => (await navigation.boundingBox())!.width).toBe(rail0.width);
  await button(page, "Mermaid source").click();
  const sourceText = sourceBox(page);
  await expect(sourceText).toBeVisible();
  const rail = (await navigation.boundingBox())!;
  for (const region of [
    page.getByRole("heading", { level: 1, name: "Request flow" }),
    status(page),
    sourceText,
    tools(page),
    parts(page),
  ]) {
    const box = (await region.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(rail.x + rail.width);
    expect(box.x + box.width).toBeLessThanOrEqual(1440);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, "navigation-dismissed");
  await axe(page);
});

test("Save of a new diagram without a private draft reopens from the saved file, and Cancel never restores the empty starter", async ({
  page,
}) => {
  await author(page, null);
  await button(parts(page), "Process").click();
  const label = page.getByRole("textbox", { name: /^n[0-9]+ label$/ });
  await expect(label).toBeFocused();
  const id = (await label.getAttribute("aria-label"))!.replace(/ label$/, "");
  await label.fill("Published checkpoint");
  await label.press("Enter");
  await editor(page).getByRole("textbox", { name: "Save as", exact: true }).fill("diagrams/direct.mmd");
  await saveAndExit(page);
  const saved = disk(".archer/diagrams/direct.mmd");
  expect(saved).toContain("Published checkpoint");
  await page.reload();
  await expect(node(page, id)).toContainText("Published checkpoint");
  await readerEdit(page).click();
  await expect(editor(page)).toBeVisible();
  await expect(cancel(page)).toBeEnabled();
  await node(page, id).dblclick();
  const again = page.getByRole("textbox", { name: `${id} label`, exact: true });
  await again.fill("Discard this");
  await again.press("Enter");
  await expect(node(page, id)).toContainText("Discard this");
  await cancel(page).click();
  await button(page.getByRole("alertdialog", { name: "Discard your changes?" }), "Discard").click();
  await expect(editor(page)).toHaveCount(0);
  await expect(node(page, id)).toContainText("Published checkpoint");
  await page.reload();
  await expect(node(page, id)).toContainText("Published checkpoint");
  expect(disk(".archer/diagrams/direct.mmd")).toBe(saved);
  await axe(page);
});

async function savePrivateThenCanonical(page: Page) {
  await author(page);
  await button(page, "Mermaid source").click();
  const source = sourceBox(page);
  await source.fill(original.replace("Client", "Private checkpoint"));
  await expect(node(page, "a")).toContainText("Private checkpoint");
  await settled(page);
  await button(tools(page), "Structure and properties").click();
  await panel(page).getByText("Draft and proposal tools", { exact: true }).click();
  await button(panel(page), "Save proposal privately").click();
  await expect(panel(page).getByRole("link", { name: /revision 1/ })).toBeVisible();
  expect(disk()).toBe(original);
  await source.fill(original.replace("Client", "Canonical checkpoint"));
  await expect(node(page, "a")).toContainText("Canonical checkpoint");
  await saveAndExit(page);
  expect(disk()).toContain("Canonical checkpoint");
}
test("a private proposal then a canonical Save survive Cancel and a second reload", async ({ page }) => {
  await savePrivateThenCanonical(page);
  await readerEdit(page).click();
  await expect(editor(page)).toBeVisible();
  await expect(node(page, "a")).toContainText("Canonical checkpoint");
  await node(page, "a").dblclick();
  const label = page.getByRole("textbox", { name: "a label", exact: true });
  await label.fill("Discard this");
  await label.press("Enter");
  await expect(node(page, "a")).toContainText("Discard this");
  await cancel(page).click();
  await button(page.getByRole("alertdialog", { name: "Discard your changes?" }), "Discard").click();
  await expect(editor(page)).toHaveCount(0);
  await expect(node(page, "a")).toContainText("Canonical checkpoint");
  await page.reload();
  await expect(node(page, "a")).toContainText("Canonical checkpoint");
  expect(disk()).toContain("Canonical checkpoint");
});
test("the saved diagram address opens the latest file in a fresh browser without recovery storage", async ({
  page,
  browser,
}) => {
  await savePrivateThenCanonical(page);
  const savedUrl = page.url(),
    context = await browser.newContext();
  try {
    const fresh = await context.newPage(),
      access = await project.issueAuthoringAccess("Copied address visitor");
    await fresh.goto(access.url);
    await fresh.goto(savedUrl);
    await expect(node(fresh, "a")).toContainText("Canonical checkpoint");
    await readerEdit(fresh).click();
    await expect(editor(fresh)).toBeVisible();
    await expect(node(fresh, "a")).toContainText("Canonical checkpoint");
    await expect(status(fresh)).toContainText("no changes yet");
  } finally {
    await context.close();
  }
});

// Regression: a Save click that landed while the preview's background layout settled was lost, because
// the button went disabled for one layout pass between press and release.
test("Save stays mounted and enabled while preview and layout land; Save right after typing is kept", async ({
  page,
}) => {
  await author(page);
  await button(page, "Mermaid source").click();
  const source = sourceBox(page);
  await button(tools(page), "Structure and properties").click();
  await panel(page).getByText("Draft and proposal tools", { exact: true }).click();
  const privately = button(panel(page), "Save proposal privately");
  await expect(privately).toBeEnabled();
  await settled(page);
  await page.evaluate(() => {
    const w = window as unknown as { saveFlips: Record<string, string[]>; saveButtons: Record<string, Element> };
    w.saveFlips = {};
    w.saveButtons = {};
    for (const button of document.querySelectorAll("button")) {
      const name = button.textContent ?? "";
      if (name === "Save" || name === "Save proposal privately") {
        w.saveButtons[name] = button;
        w.saveFlips[name] = [];
      }
    }
    new MutationObserver((records) => {
      for (const record of records) {
        const button = record.target as HTMLButtonElement,
          name = button.textContent ?? "";
        if (name in w.saveFlips) w.saveFlips[name]!.push(String(button.disabled));
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["disabled"] });
  });
  await source.fill(original.replace("Client", "Typed then saved"));
  await privately.click();
  await expect(panel(page).getByRole("link", { name: /revision 1/ })).toBeVisible();
  // The private save answers before the typed text's preview (120 ms debounce, then a request) does: Save is still held
  // ("Checking the Mermaid…"). Count flips from a settled, enabled Save, or the count starts mid-preview.
  await settled(page);
  await expect(save(page)).toBeEnabled();
  await page.evaluate(() => {
    const w = window as unknown as { saveFlips: Record<string, string[]> };
    for (const name of Object.keys(w.saveFlips)) w.saveFlips[name] = [];
  });
  await source.fill(original.replace("Client", "Settled preview"));
  await expect(node(page, "a")).toContainText("Settled preview");
  await settled(page);
  await expect(save(page)).toBeEnabled();
  const observed = await page.evaluate(() => {
    const w = window as unknown as { saveFlips: Record<string, string[]>; saveButtons: Record<string, Element> };
    return { flips: w.saveFlips, connected: Object.values(w.saveButtons).map((button) => button.isConnected) };
  });
  expect(observed.connected).toEqual([true, true]);
  // The private save never depends on the preview; the canonical Save waits for a valid preview once and then stays enabled.
  expect(observed.flips["Save proposal privately"]).toEqual([]);
  expect(observed.flips.Save!.join(",")).toMatch(/^(true(,false)?)?$/);
  await saveAndExit(page);
  expect(disk()).toContain("Settled preview");
});

test("while the preview is pending, Save is visibly held with its reason and a private save still works", async ({
  page,
}) => {
  await author(page);
  await button(page, "Mermaid source").click();
  const source = sourceBox(page);
  await button(tools(page), "Structure and properties").click();
  await panel(page).getByText("Draft and proposal tools", { exact: true }).click();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/authoring/preview", async (route) => {
    await held;
    await route.continue();
  });
  await source.fill(original.replace("Client", "Pending preview"));
  await expect(page.getByText("Checking preview…")).toBeVisible();
  await expect(save(page)).toBeDisabled();
  await expect(save(page)).toHaveAccessibleDescription(/Checking the Mermaid/);
  await button(panel(page), "Save proposal privately").click();
  await expect(panel(page).getByRole("link", { name: /revision 1/ })).toBeVisible();
  release();
  await expect(node(page, "a")).toContainText("Pending preview");
  await saveAndExit(page);
  expect(disk()).toContain("Pending preview");
});

test("the old editor address with ?viewId= opens the diagram in place in the same page load, reading once", async ({
  page,
}) => {
  // It redirected by loading the page again: the first load had already asked for the diagrams, compile, bootstrap and
  // authoring reads (and the event stream) before it left, so each was read twice (smoke-c-session-transport).
  await login(page);
  const documents: string[] = [],
    bootstraps: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents.push(request.url());
    else if (/\/api\/bootstrap(?:\?|$)/.test(request.url())) bootstraps.push(request.url());
  });
  await page.goto(`${origin()}/projects/${slug()}/-/edit/?viewId=flow.mmd`);
  await expect(editor(page)).toBeVisible();
  await expect(node(page, "a")).toBeVisible();
  await settled(page);
  const landed = new URL(page.url());
  expect(landed.pathname).toBe(`/projects/${slug()}/flow.mmd`);
  expect(landed.searchParams.has("edit")).toBe(true);
  expect(documents).toHaveLength(1);
  expect(bootstraps).toHaveLength(1);
});
// O17: a part click that landed while an edit was checked, or while a fresh preview's layout settled, was dropped
// without a word (the parts went disabled for that moment, or the controller ignored a second edit while busy).
test("a part clicked while the previous edit is still being checked is added after it, not dropped", async ({
  page,
}) => {
  await author(page, null);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let edits = 0;
  await page.route("**/api/authoring/edit", async (route) => {
    edits += 1;
    if (edits === 1) await held;
    await route.continue();
  });
  await button(parts(page), "Process").click();
  await expect.poll(() => edits).toBe(1);
  // The click is taken, and the parts bar says it is busy until the edit it waits for is checked.
  await button(parts(page), "Decision").click({ timeout: 3000 });
  await expect(parts(page)).toHaveAttribute("aria-busy", "true");
  release();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await settled(page);
  expect(edits).toBe(2);
  await expect(parts(page)).not.toHaveAttribute("aria-busy", "true");
});
test("the parts of a type just switched to stay enabled while its preview and layout land; the first part click adds it", async ({
  page,
}) => {
  await author(page, null);
  await page.evaluate(() => {
    const w = window as unknown as { partDisabled: boolean[] };
    w.partDisabled = [];
    const look = () => {
      for (const b of document.querySelectorAll<HTMLButtonElement>(".authoring-parts button"))
        if (b.textContent === "State") w.partDisabled.push(b.disabled);
    };
    new MutationObserver(look).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });
  });
  await editor(page).getByRole("combobox", { name: "Type" }).selectOption({ label: "State" });
  const stateParts = page.getByRole("toolbar", { name: "State parts" });
  await expect(stateParts).toBeVisible();
  await settled(page);
  const seen = () => page.evaluate(() => (window as unknown as { partDisabled: boolean[] }).partDisabled);
  // The type's own preview and layout landed: the part was never disabled meanwhile, so no click on it could be lost.
  const landing = await seen();
  expect(landing.length).toBeGreaterThan(0);
  expect(landing.filter(Boolean)).toEqual([]);
  await button(stateParts, "State").click();
  await expect(page.getByRole("textbox", { name: /^s[0-9]+ (label|name)$/ })).toBeVisible();
  await settled(page);
  expect((await seen()).filter(Boolean)).toEqual([]);
});
