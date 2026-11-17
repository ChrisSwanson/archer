/**
 * The page's address follows every place the reader goes in a project,
 * against the real service: a diagram opened from the project page, a note, a
 * diagram drawn in a note, a folder. Each is a history entry, so a reload
 * opens the place on screen and Back walks back through the places, ending on
 * the page the reader opened, never off it. The agent presenting moves the
 * address in place, with no entry of its own.
 */
import { files as projectPage } from "./support/primary-navigation";
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { placeOf } from "./support/address";
import { sharedTsProject } from "./support/shared-service";

const ADDRESS = "notes/auth.md#login-flow";
const NOTE = '# Auth design\n\n## Login flow\n\n```mermaid\nflowchart LR\n  user["User"] e1@--> api["API"]\n```\n';
const TOML =
  [
    "version = 1",
    '[[views]]\nid = "system-context"\nkind = "freeform"\ntitle = "System context"\nsource = ".archer/system-context.mmd"',
    '[[views]]\nid = "delivery-handoff"\nkind = "freeform"\ntitle = "Delivery handoff"\nsource = ".archer/diagrams/delivery-handoff.mmd"',
    '[[views]]\nid = "billing"\nkind = "freeform"\ntitle = "Billing"\nsource = ".archer/billing.mmd"',
  ].join("\n") + "\n";

let server: TsProject | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const crumbs = (page: Page) => page.getByRole("navigation", { name: "Breadcrumb" });
const here = (page: Page) => crumbs(page).locator('[aria-current="page"]');
const search = (page: Page): string => new URL(page.url()).search;
/** The diagram the address names: a diagram in a note by its view id, a standalone one by its file. */
const view = (page: Page): string | null => {
  const place = placeOf(page.url());
  return place?.kind === "view" ? place.viewId : place?.kind === "file" ? place.path : null;
};

async function openFromFiles(page: Page, title: string): Promise<void> {
  await (await projectPage(page)).getByRole("button", { name: title, exact: true }).click();
}

test("every diagram, note and folder the reader opens is in the address, and Back walks them back to the page they opened", async ({
  page,
}) => {
  // About forty steps, a third of them whole-page loads: 15 s here, 30-47 s
  // on a loaded CI host, where it ran out of the 45 s default with no single
  // wait failing. Under pr-check --stress (2x throttle, load 24) it ran out of 90 s three steps from the
  // end, every step passing: ten page loads at 2-9 s each (O265).
  test.setTimeout(150_000);
  server = await sharedTsProject({
    files: {
      "archer.toml": TOML,
      ".archer/system-context.mmd": "flowchart LR\n sys[System] e1@--> ext[Partner]\n",
      ".archer/diagrams/delivery-handoff.mmd": "flowchart LR\n courier[Courier] e1@--> hub[Hub]\n",
      ".archer/billing.mmd": "flowchart LR\n inv[Invoice] e1@--> pay[Payment]\n",
      ".archer/notes/auth.md": NOTE,
    },
  });
  // What the agent was presenting when the page opened: the bare address stays bare.
  await server.present("billing");
  await page.goto(server.url);
  await expect(page.locator('.react-flow__node[data-id="inv"]')).toBeVisible();
  // The agent's link lands on the follow address.
  expect(search(page)).toBe("?follow");

  await openFromFiles(page, "System context");
  await expect(page.locator('.react-flow__node[data-id="sys"]')).toBeVisible();
  await expect.poll(() => view(page)).toBe("system-context.mmd");

  await openFromFiles(page, "Delivery handoff");
  await expect(here(page)).toHaveText("Delivery handoff");
  await expect(page.locator('.react-flow__node[data-id="courier"]')).toBeVisible();
  await expect.poll(() => view(page)).toBe("diagrams/delivery-handoff.mmd");

  // A reload opens what was on screen, not the diagram before it.
  await page.reload();
  await expect(page.locator('.react-flow__node[data-id="courier"]')).toBeVisible();
  await expect(here(page)).toHaveText("Delivery handoff");

  await crumbs(page).getByRole("button", { name: "diagrams", exact: true }).click();
  await expect(page.getByRole("region", { name: "diagrams", exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/projects\/[^/]+\/diagrams\/$/);
  await expect(page.getByRole("button", { name: "Clear project filter" })).toHaveCount(0); // the page names its own project
  await expect(page.getByRole("searchbox", { name: "Search projects and files" })).toHaveValue("");

  // A folder's page lists that folder; the project's other files are a step up, at Archer contents.
  await page.getByRole("button", { name: "Archer contents", exact: true }).click();
  await openFromFiles(page, "Auth design");
  const figure = page.getByRole("link", { name: "Open login-flow, Flowchart" });
  await expect(figure).toBeVisible();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/projects\/[^/]+\/notes\/auth\.md$/);
  expect(search(page)).toBe("");
  await figure.click();
  await expect(page.locator('.react-flow__node[data-id="user"]')).toBeVisible();
  await expect.poll(() => view(page)).toBe(ADDRESS);

  // The agent presenting takes the page and the address, in place.
  const entries = await page.evaluate(() => window.history.length);
  await server.present("system-context");
  await expect(page.locator('.react-flow__node[data-id="sys"]')).toBeVisible();
  await expect.poll(() => view(page)).toBe("system-context.mmd");
  expect(await page.evaluate(() => window.history.length)).toBe(entries);

  // Back: the note, the project page it was opened from, the folder,
  // Delivery handoff, the project page, System context, the project page, and
  // the page as opened -- still in the app.
  const projectPageShown = async (): Promise<void> => {
    await expect(page.getByRole("region", { name: "Project documents", exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toMatch(/\/projects\/$/);
    expect(search(page)).toBe("");
  };
  await page.goBack();
  await expect(page.getByRole("link", { name: "Open login-flow, Flowchart" })).toBeVisible();
  await page.goBack();
  await projectPageShown();
  await page.goBack();
  await expect(page.getByRole("region", { name: "diagrams", exact: true })).toBeVisible();
  await page.goBack();
  await expect(here(page)).toHaveText("Delivery handoff");
  await expect(page.locator('.react-flow__node[data-id="courier"]')).toBeVisible();
  await page.goBack();
  await projectPageShown();
  await page.goBack();
  await expect(here(page)).toHaveText("System context");
  await expect(page.locator('.react-flow__node[data-id="sys"]')).toBeVisible();
  await page.goBack();
  await projectPageShown();
  await page.goBack();
  expect(search(page)).toBe("?follow");
  await expect(page.locator(".react-flow__node").first()).toBeVisible();

  await page.goForward();
  await projectPageShown();
  await page.goForward();
  await expect(here(page)).toHaveText("System context");
  await page.goForward();
  await projectPageShown();
  await page.goForward();
  await expect(here(page)).toHaveText("Delivery handoff");
  expect(view(page)).toBe("diagrams/delivery-handoff.mmd");
});
