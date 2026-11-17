/**
 * The project page frame in a real browser (project-page-redesign spec, 2026-10-18): the
 * title section with its gear at the right, the Folders/Diagrams/Notes tabs as part of the
 * address through reload and Back, and the Folders tree's disclosure, remembered per project.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

let server: TsProject | undefined;
test.afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function projectPage(page: Page, extra: Record<string, string> = {}): Promise<string> {
  server = await sharedTsProject({
    files: {
      ...extra,
      "archer.toml": 'version = 1\nname = "Shop"\ndescription = "An online shop."\n',
      ".archer/diagrams/flows/checkout.mmd": "flowchart LR\n basket[Basket] e1@--> pay[Payment]\n",
      ".archer/diagrams/context.mmd": "flowchart LR\n shop[Shop] e1@--> bank[Bank]\n",
      ".archer/notes/operations.md": "# Operations\n\nRunning the shop.\n",
    },
  });
  await page.goto(server.agentUrl);
  const name = new URL(server.agentUrl).pathname.split("/")[2]!;
  const url = new URL(`/projects/${name}/`, server.agentUrl).href;
  await page.goto(url);
  return url;
}
const tab = (page: Page, name: string) =>
  page.getByRole("tablist", { name: "Project content" }).getByRole("tab", { name: new RegExp(`^${name}`) });

test("the title section leads the project page, its gear at the right and no Archive project", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await projectPage(page);
  const title = page.getByRole("main").getByRole("heading", { level: 1, name: "Shop" });
  await expect(title).toBeVisible();
  await expect(page.getByText("An online shop.")).toBeVisible();
  await expect(page.getByLabel("Project facts")).toContainText("2 diagrams");
  await expect(page.getByLabel("Project facts")).toContainText("1 note");
  const gear = page.getByRole("button", { name: "Project settings", exact: true });
  const [titleBox, gearBox] = [await title.boundingBox(), await gear.boundingBox()];
  expect(gearBox!.x).toBeGreaterThan(titleBox!.x + titleBox!.width);
  await expect(page.getByRole("button", { name: "Archive project" })).toHaveCount(0);
  // The title section is the page's one h1; the shell header keeps only its breadcrumb.
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.locator(".primary-document-identity .primary-document-title")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Shop");
  expect(
    (await new AxeBuilder({ page }).include("main").analyze()).violations.map((violation) => violation.id),
  ).toEqual([]);
  expect((await new AxeBuilder({ page }).analyze()).violations.map((violation) => violation.id)).toEqual([]);
});

test("the tab is part of the address: it survives reload, and Back returns to Folders", async ({ page }) => {
  const url = await projectPage(page);
  await expect(tab(page, "Folders")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "Diagrams")).toContainText("2");
  await tab(page, "Diagrams").click();
  await expect.poll(() => new URL(page.url()).searchParams.get("tab")).toBe("diagrams");
  await expect(tab(page, "Diagrams")).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(tab(page, "Diagrams")).toHaveAttribute("aria-selected", "true");
  await page.goBack();
  await expect.poll(() => page.url()).toBe(url);
  await expect(tab(page, "Folders")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("treegrid", { name: "Project files" })).toBeVisible();
});

test("a folder closes by its disclosure, the arrow turning, and stays closed after reload; a phone does not scroll sideways", async ({
  page,
}) => {
  await projectPage(page);
  const tree = page.getByRole("treegrid", { name: "Project files" });
  const flows = tree.getByRole("button", { name: /^(Expand|Collapse) flows$/ });
  await expect(flows).toHaveAttribute("aria-expanded", "true");
  await expect(tree.getByRole("button", { name: "checkout", exact: true })).toBeVisible();
  const chevron = flows.locator(".archer-folder-tree-chevron");
  const turned = await chevron.evaluate((node) => getComputedStyle(node).transform);
  await flows.click();
  await expect(flows).toHaveAttribute("aria-expanded", "false");
  await expect(tree.getByRole("button", { name: "checkout", exact: true })).toHaveCount(0);
  await expect.poll(() => chevron.evaluate((node) => getComputedStyle(node).transform)).not.toBe(turned);
  await page.reload();
  await expect(
    page.getByRole("treegrid", { name: "Project files" }).getByRole("button", { name: /^(Expand|Collapse) flows$/ }),
  ).toHaveAttribute("aria-expanded", "false");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(0);
});

test("the root README is a read-only document in the Folders tree, and its card shows on the page", async ({
  page,
}) => {
  await projectPage(page, { "README.md": "# Shop\n\nThe shop's own readme.\n\nMore detail here.\n" });
  await expect(page.getByRole("region", { name: /README/ })).toBeVisible();
  const tree = page.getByRole("treegrid", { name: "Project files" });
  const row = tree.locator("[data-browser-row]").filter({ hasText: "README.md" });
  await expect(row).toHaveCount(1);
  await row.getByRole("button").first().click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/projects\/[^/]+\/README\.md$/);
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
});
