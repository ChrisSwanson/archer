// Editing reach (0.6.4 D6; decided 2026-10-28): New, and Edit on a diagram, are always visible on desktop.
// Any browser admitted with a link may edit; `edit = false` in archer.toml (the project's, else the
// account's) greys them out, names the setting and says where to change it; a page whose credential is not
// the browser cookie (a legacy token address) explains how to get a link; a phone says editing is on desktop.
// Nothing offers New as working where the service would refuse it.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startTsProject, type TsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";

const PAGE = testPage();
const manifest = (extra = "") =>
  `version = 1\nname = "Bookshop"\n${extra}\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Request flow"\nsource = ".archer/flow.mmd"\n`;
const files = (extra = "") => ({
  "archer.toml": manifest(extra),
  ".archer/flow.mmd": "flowchart LR\n  a[Client]\n  b[API]\n  a calls@-->|HTTP| b\n",
  ".archer/notes/guide.md":
    "---\ntitle: Ordering guide\nauthor: agent\n---\n\n# Ordering guide\n\nHow an order moves.\n",
});
let project: TsProject;
test.describe.configure({ timeout: 90_000 });
test.afterEach(async ({ page }) => {
  await page.close();
  await project?.stop();
});

const slug = () => new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
const origin = () => new URL(project.url).origin;
const PAGES = {
  project: () => `${origin()}/projects/${slug()}/`,
  folder: () => `${origin()}/projects/${slug()}/notes/`,
  diagram: () => `${origin()}/projects/${slug()}/flow.mmd`,
  note: () => `${origin()}/projects/${slug()}/notes/guide.md`,
} as const;
type Where = keyof typeof PAGES;
const ALL: readonly Where[] = ["project", "folder", "diagram", "note"];
const newButton = (page: Page) => page.getByRole("button", { name: "New", exact: true });
const editButton = (page: Page) =>
  page.locator(".archer-diagram-edit").getByRole("button", { name: "Edit", exact: true });
const request = (page: Page) => page.getByRole("dialog", { name: "Editing needs a sign-in link" });
const turnedOff = (page: Page) => page.getByRole("dialog", { name: "Editing is turned off" });
async function open(page: Page, where: Where) {
  await page.goto(PAGES[where]());
  await page.mouse.move(700, 450);
  if (where === "diagram") await expect(page.locator('.react-flow__node[data-id="a"]')).toBeVisible();
  else if (where === "note") await expect(page.getByRole("heading", { name: "Ordering guide" }).first()).toBeVisible();
  else await expect(page.getByRole("tablist", { name: "Project content" })).toBeVisible();
}
const noSideScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );

test("with a reading link or an editing link, New works on project, folder, diagram and note pages, and Edit on a diagram", async ({
  page,
}) => {
  project = await startTsProject({ files: files(), pagePath: PAGE });
  for (const link of [
    await project.issueAccess("Edit reach reader"),
    await project.issueAuthoringAccess("Edit reach grant"),
  ]) {
    await page.goto(link.url);
    for (const where of ALL) {
      await open(page, where);
      await expect(newButton(page)).toBeVisible();
      await newButton(page).click();
      const entry = page.getByRole("menu", { name: "New" }).getByRole("menuitem", { name: "Diagram", exact: true });
      await expect(entry).toBeFocused();
      expect(new URL((await entry.getAttribute("href")) ?? "", page.url()).pathname).toBe(
        `/projects/${slug()}/-/edit/`,
      );
      await page.keyboard.press("Escape");
      await expect(newButton(page)).toBeFocused();
      await expect(request(page)).toHaveCount(0);
      await expect(newButton(page)).not.toHaveAttribute("aria-disabled", "true");
      await expect(editButton(page)).toHaveCount(where === "diagram" ? 1 : 0);
      if (where === "diagram") await expect(editButton(page)).toHaveAttribute("title", "Edit this diagram here");
    }
  }
});

test("from a reading link, New then Diagram on the project page saves a new .mmd file", async ({ page }) => {
  project = await startTsProject({ files: files(), pagePath: PAGE });
  await page.goto((await project.issueAccess("Edit reach new diagram")).url);
  await open(page, "project");
  await newButton(page).click();
  await page.getByRole("menuitem", { name: "Diagram", exact: true }).click();
  const editor = page.getByRole("region", { name: "Diagram Editor" });
  await expect(editor).toBeVisible();
  await page
    .getByRole("toolbar", { name: "Flowchart parts" })
    .getByRole("button", { name: "Process", exact: true })
    .click();
  const label = page.getByRole("textbox", { name: /^n[0-9]+ label$/ });
  await expect(label).toBeFocused();
  await label.fill("Take order");
  await label.press("Enter");
  await expect(page.getByText("Checking preview…")).toHaveCount(0);
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await editor.getByRole("textbox", { name: "Save as", exact: true }).fill("diagrams/orders.mmd");
  await page.getByRole("banner").getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0, { timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe(`/projects/${slug()}/diagrams/orders.mmd`);
  await expect
    .poll(() => readFileSync(join(project.root, ".archer/diagrams/orders.mmd"), "utf8"))
    .toContain("Take order");
});

test("the owner signed in by the token address is offered Edit and New, which open the editor (G3)", async ({
  page,
}) => {
  project = await startTsProject({ files: files(), pagePath: PAGE });
  await page.goto(project.url);
  await open(page, "diagram");
  await expect(editButton(page)).toBeVisible();
  await editButton(page).click();
  await expect(page.getByRole("region", { name: "Diagram Editor" })).toBeVisible();
  await expect(request(page)).toHaveCount(0);
});

test("a browser that may not edit is told how to get a link, and can copy the request for the agent", async ({
  page,
}) => {
  project = await startTsProject({ files: files(), pagePath: PAGE });
  // No browser sign-in is refused authoring now (the owner edits too); the service's refusal is stubbed.
  await page.route(
    (url) => url.pathname.endsWith("/api/authoring"),
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 200, contentType: "application/json", body: '{"authorized":false}' })
        : route.continue(),
  );
  await page.goto(project.url);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  for (const where of ["project", "diagram"] as const) {
    await open(page, where);
    const triggers = where === "diagram" ? [newButton(page), editButton(page)] : [newButton(page)];
    for (const trigger of triggers) {
      await expect(trigger).toBeVisible();
      await trigger.click();
      const dialog = request(page);
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("can read and comment but not edit");
      await expect(dialog).toContainText("Please give me a new Archer link for Bookshop.");
      await expect(dialog.getByRole("link", { name: "How editing works" })).toHaveAttribute(
        "href",
        /#editing-diagrams-in-the-browser$/,
      );
      await expect(page.getByRole("menu", { name: "New" })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Diagram Editor" })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  }
  // The copy button puts the ready sentence on the clipboard and says so.
  await open(page, "project");
  await newButton(page).click();
  const copy = request(page).getByRole("button", { name: "Copy request", exact: true });
  await copy.click();
  await expect(request(page).getByRole("status")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Please give me a new Archer link for Bookshop.",
  );
  await page.mouse.click(5, 5);
  await expect(request(page)).toHaveCount(0);
  await noSideScroll(page);
});

test("with edit = false in the project, New and Edit are greyed out, name the setting and never open the editor", async ({
  page,
}) => {
  project = await startTsProject({ files: files("edit = false\n"), pagePath: PAGE });
  await page.goto((await project.issueAccess("Edit reach switched off")).url);
  const tip = "Editing is off: edit = false in this project's archer.toml";
  for (const where of ALL) {
    await open(page, where);
    const triggers = where === "diagram" ? [newButton(page), editButton(page)] : [newButton(page)];
    await expect(editButton(page)).toHaveCount(where === "diagram" ? 1 : 0);
    for (const trigger of triggers) {
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveAttribute("aria-disabled", "true");
      await expect(trigger).toHaveAttribute("data-off", "");
      await expect(trigger).toHaveAttribute("title", tip);
      // Playwright's click waits for aria-disabled to clear; a person's click and Enter both open the explanation.
      if (where === "diagram") await trigger.press("Enter");
      else await trigger.click({ force: true });
      const dialog = turnedOff(page);
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("This project's archer.toml sets edit = false");
      await expect(dialog).toContainText("Your agent can still change diagrams.");
      await expect(page.getByRole("menu", { name: "New" })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Diagram Editor" })).toHaveCount(0);
      expect(new URL(page.url()).searchParams.has("edit")).toBe(false);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
    }
  }
});

test("the account's edit = false turns editing off where the project says nothing, and the project's edit = true wins", async ({
  page,
}) => {
  project = await startTsProject({ files: files(), pagePath: PAGE });
  writeFileSync(project.configPath, "version = 1\nedit = false\n", { mode: 0o600 });
  await page.goto((await project.issueAccess("Edit reach account off")).url);
  await open(page, "diagram");
  await expect(newButton(page)).toHaveAttribute("title", "Editing is off: edit = false in your account's archer.toml");
  await expect(editButton(page)).toHaveAttribute("aria-disabled", "true");
  await editButton(page).press("Enter");
  await expect(turnedOff(page)).toContainText("Your account's archer.toml sets edit = false");
  await page.keyboard.press("Escape");
  // The project's own setting wins over the account's.
  writeFileSync(join(project.root, "archer.toml"), manifest("edit = true\n"));
  await expect
    .poll(
      async () => {
        await page.reload();
        await open(page, "diagram");
        return await editButton(page).getAttribute("title");
      },
      { timeout: 30_000 },
    )
    .toBe("Edit this diagram here");
  await expect(newButton(page)).not.toHaveAttribute("aria-disabled", "true");
});

test("a phone stays view-only and says editing is on desktop, from a reading link or an editing link", async ({
  page,
}) => {
  project = await startTsProject({ files: files(), pagePath: PAGE });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const link of [
    await project.issueAuthoringAccess("Edit reach phone grant"),
    await project.issueAccess("Edit reach phone reader"),
  ]) {
    await page.goto(link.url);
    for (const where of ALL) {
      await open(page, where);
      await expect(page.getByText("Editing is on desktop", { exact: true })).toBeVisible();
      await expect(newButton(page)).toHaveCount(0);
      await expect(editButton(page)).toBeHidden();
      await noSideScroll(page);
    }
  }
});

test("when the editing status cannot be read, New and Edit stay, say so, and try again (review F7)", async ({
  page,
}) => {
  project = await startTsProject({ files: files(), pagePath: PAGE });
  await page.goto((await project.issueAuthoringAccess("Edit reach status down")).url);
  const status = (url: URL) => url.pathname.endsWith("/api/authoring");
  await page.route(status, (route) => route.abort("connectionrefused"));
  await open(page, "diagram");
  await expect(newButton(page)).toBeVisible();
  await expect(editButton(page)).toBeVisible();
  await newButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Editing is unavailable right now" });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("menu", { name: "New" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Diagram Editor" })).toHaveCount(0);
  // Still down: it says so and stays.
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog.getByRole("status")).toHaveText(/Still unavailable/);
  await page.unroute(status);
  await dialog.getByRole("button", { name: "Try again" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(newButton(page)).toHaveAttribute("aria-haspopup", "menu");
  await expect(newButton(page)).toBeFocused();
  await expect(editButton(page)).toHaveAttribute("title", "Edit this diagram here");
});
