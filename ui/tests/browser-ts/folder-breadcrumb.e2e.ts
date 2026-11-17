import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { placeOf } from "./support/address";
import { sharedTsProject } from "./support/shared-service";

const crumbs = (page: Page) => page.getByRole("navigation", { name: "Breadcrumb" });

test("a folder segment shows the folder's diagrams, notes and subfolders as a tree; a root diagram has no Files segment", async ({
  page,
}) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml": "version = 1\n",
      ".archer/architecture.mmd": "flowchart LR\nweb[Web] e1@--> api[API]\n",
      ".archer/diagrams/checkout.mmd": "flowchart LR\ncart[Cart] e1@--> pay[Pay]\n",
      ".archer/diagrams/payments/refunds.mmd": "flowchart LR\nask[Ask] e1@--> refund[Refund]\n",
      ".archer/diagrams/why.md": "# Why checkout\n\nOne page.\n",
    },
  });
  try {
    await page.goto(project.url);
    await project.present("architecture");
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(crumbs(page).getByRole("button")).toHaveText(["Projects", /./]);
    await expect(crumbs(page)).not.toContainText(/files/i);
    await expect(crumbs(page).locator('[aria-current="page"]')).toHaveText("architecture");

    await project.present("refunds");
    await expect(crumbs(page).getByRole("button")).toHaveText(["Projects", /./, "diagrams", "payments"]);
    await crumbs(page).getByRole("button", { name: "diagrams", exact: true }).click();

    const folder = page.getByRole("region", { name: "diagrams", exact: true });
    await expect(folder).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("diagrams");
    const search = folder.getByRole("searchbox", { name: "Search projects and files" });
    await expect(search).toHaveValue("");
    await expect(folder.getByRole("button", { name: "Clear folder filter" })).toHaveText("diagrams");
    // Pin sibling order: default Edited sorting follows fixture filesystem timestamps.
    await folder.getByRole("button", { name: /^Filters(?: \(\d+\))?$/ }).click();
    await page
      .getByRole("dialog", { name: "Project Filters" })
      .getByRole("combobox", { name: "Sort by", exact: true })
      .selectOption("name:asc");
    await page.keyboard.press("Escape");
    // Its own files first, then each subfolder, open, with its files beneath it.
    await expect(folder.locator(".archer-folder-tree-open")).toHaveText(["checkout", "Why checkout", "refunds"]);
    const subfolder = folder.getByRole("button", { name: /^(Expand|Collapse) payments$/ });
    await expect(subfolder).toHaveAttribute("aria-expanded", "true");
    await expect(folder.locator('.archer-folder-tree-file[title=".archer/diagrams/checkout.mmd"]')).toHaveText(
      "checkout.mmd",
    );

    // The common search remains reachable by its shortcut and normal tab order.
    await page.keyboard.press("/");
    await expect(search).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(folder.getByRole("button", { name: "Search", exact: true })).toBeFocused();
    // A subfolder is opened by its name (a link) and closed and opened in place by Space on it, or by its arrow.
    await folder.getByRole("link", { name: "payments/" }).focus();
    await page.keyboard.press("Space");
    await expect(subfolder).toHaveAttribute("aria-expanded", "false");
    await expect(folder.getByRole("button", { name: /^refunds/ })).toHaveCount(0);
    await page.keyboard.press("Space");
    await expect(subfolder).toHaveAttribute("aria-expanded", "true");
    await expect(crumbs(page).getByRole("button")).toHaveText(["Projects", /./]);
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);

    await page.setViewportSize({ width: 390, height: 844 });
    // Anywhere on a file's row opens it, not only its title.
    const row = folder.locator("[data-browser-row]").filter({ has: page.getByRole("button", { name: /^refunds/ }) });
    await row.locator(".archer-folder-tree-file").click();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(folder).toHaveCount(0);
    await expect(crumbs(page).locator('[aria-current="page"]')).toHaveText("refunds");
  } finally {
    await project.stop();
  }
});

test("?folder= opens the folder page, and back and forward walk the folder and the diagram opened from its tree", async ({
  page,
}) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml": "version = 1\n",
      ".archer/diagrams/checkout.mmd": "flowchart LR\ncart[Cart] e1@--> pay[Pay]\n",
      ".archer/diagrams/payments/refunds.mmd": "flowchart LR\nask[Ask] e1@--> refund[Refund]\n",
      ".archer/notes/why.md": "# Why checkout\n\nOne page.\n",
    },
  });
  // The folder the address names: the folder in a clean address's path, or a legacy ?folder=.
  const folder = (): string | null => {
    const place = placeOf(page.url());
    return place?.kind === "search" ? place.state.folder || null : place?.kind === "folder" ? place.path : null;
  };
  try {
    await page.goto(project.address(`folder=diagrams`));
    const diagrams = page.getByRole("region", { name: "diagrams", exact: true });
    await expect(diagrams).toBeVisible();
    await expect(crumbs(page).locator('[aria-current="page"]')).toHaveText("diagrams");

    await expect(diagrams.getByRole("button", { name: /^(Expand|Collapse) payments$/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await diagrams.getByRole("button", { name: /^refunds/ }).click();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(crumbs(page).locator('[aria-current="page"]')).toHaveText("refunds");
    expect(folder()).toBeNull();

    await page.goBack();
    await expect(diagrams).toBeVisible();
    expect(folder()).toBe("diagrams");
    await page.goForward();
    await expect(diagrams).toHaveCount(0);
    await expect(crumbs(page).locator('[aria-current="page"]')).toHaveText("refunds");

    // A reload keeps the folder; one that leaves the Archer folder is a folder that is not there.
    await page.goto(project.address(`folder=..%2F..%2Fetc`));
    const unknown = page.getByRole("region", { name: "Unknown folder", exact: true });
    await expect(unknown.getByRole("status")).toContainText("moved or deleted");
    await expect(crumbs(page)).not.toContainText("etc");
    await crumbs(page)
      .getByRole("button")
      .filter({ hasNotText: /^Projects$/ })
      .first()
      .click();
    await expect(page.getByRole("region", { name: "Project files", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear project filter" })).toHaveCount(0); // the page names its own project
    expect(folder()).toBeNull();
  } finally {
    await project.stop();
  }
});

// ---------------------------------------------------------------- the projects tree: arrow toggles, name navigates
// The projects tree's acceptance checks 1-18.

const TREE_FILES: Record<string, string> = {
  "archer.toml": 'version = 1\n[discovery]\nroots = [".archer", "docs"]\nexclude = ["docs/draft/**"]\n',
  ".archer/diagrams/checkout.mmd": "flowchart LR\ncart[Cart] e1@--> pay[Pay]\n",
  ".archer/diagrams/payments/refunds.mmd": "flowchart LR\nask[Ask] e1@--> refund[Refund]\n",
  ".archer/diagrams/payments/deep/ledger.mmd": "flowchart LR\na[A] e1@--> b[B]\n",
  ".archer/notes/why.md": "# Why checkout\n\nOne page about checkout.\n",
  "docs/guide.md": "# Guide\n\nAn admitted document.\n",
  "docs/draft/wip.md": "# Draft\n\nExcluded.\n",
  "private/secret.md": "# Secret\n\nNot a root.\n",
};
const treeOf = (page: Page) => page.getByRole("treegrid", { name: "Project files" });
const arrow = (page: Page, name: string) =>
  treeOf(page).getByRole("button", { name: new RegExp(`^(Expand|Collapse) ${name}$`) });
const nameOf = (page: Page, name: string) => treeOf(page).getByRole("link", { name: `${name}/` });
/** The project page with its tree on screen. */
async function openTree(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(treeOf(page)).toBeVisible();
}
const searchBoxOf = (page: Page) => page.getByRole("searchbox", { name: "Search projects and files" });

test("the arrow only opens and closes; the name is a link to the folder page that clears the query, and Back returns to the row", async ({
  page,
}) => {
  const project = await sharedTsProject({ files: TREE_FILES });
  try {
    await openTree(page, project.url);
    const root = new URL(page.url()).pathname;
    // 1. The arrow toggles and nothing else: same address, same search box.
    await arrow(page, "payments").click();
    await expect(arrow(page, "payments")).toHaveAttribute("aria-expanded", "false");
    await expect(treeOf(page).getByRole("button", { name: "refunds", exact: true })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe(root);
    await arrow(page, "payments").click();
    await expect(treeOf(page).getByRole("button", { name: "refunds", exact: true })).toBeVisible();
    // 4. The name is a real link with the canonical address.
    const payments = nameOf(page, "payments");
    await expect(payments).toHaveAttribute("href", `${root}diagrams/payments/`);
    // The new tab's own page request, not the context's "page" event: on a loaded CI runner
    // the tab opened and loaded but that event never came (O22). That it was a new
    // tab, not this one, is the check on page.url() below.
    const opened = page
      .context()
      .waitForEvent(
        "request",
        (request) => request.isNavigationRequest() && new URL(request.url()).pathname === `${root}diagrams/payments/`,
      );
    await payments.click({ modifiers: ["ControlOrMeta"] });
    await opened;
    expect(new URL(page.url()).pathname).toBe(root);
    // 5-6. A name click is explicit navigation: the typed query goes, the folder is the scope.
    await searchBoxOf(page).fill("checkout");
    await expect(treeOf(page).getByRole("button", { name: "Why checkout", exact: true })).toBeVisible();
    await nameOf(page, "diagrams").click();
    await expect(page).toHaveURL(new RegExp(`${root}diagrams/$`));
    await expect(searchBoxOf(page)).toHaveValue("");
    await expect(page.getByRole("button", { name: "Clear folder filter" })).toHaveText("diagrams");
    // 2. The tree re-roots at the destination: `diagrams` is not a row of its own page.
    await expect(nameOf(page, "diagrams")).toHaveCount(0);
    await expect(nameOf(page, "payments")).toBeVisible();
    // 7. Two levels in order, then Back through them with the focused row restored.
    await nameOf(page, "payments").click();
    await expect(page).toHaveURL(new RegExp(`${root}diagrams/payments/$`));
    await expect(nameOf(page, "deep")).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${root}diagrams/$`));
    await expect(nameOf(page, "payments")).toBeFocused();
    await page.goBack();
    expect(new URL(page.url()).pathname).toBe(root);
    // Back restores the context that was left: the typed query, and the row the reader clicked.
    await expect(searchBoxOf(page)).toHaveValue("checkout");
    await expect(nameOf(page, "diagrams")).toBeFocused();
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`${root}diagrams/$`));
    // 8. (The page's own folder is never a row of its tree, so there is nothing to click twice; the root
    // name's no-op at the page it names is in folder-tree.test.tsx.)
    expect((await new AxeBuilder({ page }).analyze()).violations.map((violation) => violation.id)).toEqual([]);
  } finally {
    await project.stop();
  }
});

test("the tree is one tab stop with the treegrid keys; Enter follows a name, Space toggles it, Right and Left walk the levels", async ({
  page,
}) => {
  const project = await sharedTsProject({ files: TREE_FILES });
  try {
    await openTree(page, project.url);
    const stops = treeOf(page).locator("[data-tree-primary]");
    // 9. A single tab stop; the second Tab leaves the grid.
    await expect(treeOf(page).locator('[data-tree-primary][tabindex="0"]')).toHaveCount(1);
    await expect(treeOf(page).locator("button.archer-folder-tree-disclose:not([tabindex='-1'])")).toHaveCount(0);
    await nameOf(page, "diagrams").focus();
    await page.keyboard.press("ArrowDown");
    await expect(stops.nth(2)).toBeFocused();
    await page.keyboard.press("End");
    await expect(stops.last()).toBeFocused();
    await page.keyboard.press("Home");
    await expect(stops.first()).toBeFocused();
    await expect(treeOf(page).locator('[data-tree-primary][tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest('[role="treegrid"]') === null)).toBe(true);
    // 10-11. Right on an open folder enters it; Left on a file goes to its parent; Left on an open folder closes it.
    await nameOf(page, "payments").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(arrow(page, "payments")).toHaveAttribute("aria-expanded", "false");
    await expect(nameOf(page, "payments")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(nameOf(page, "diagrams")).toBeFocused();
    await nameOf(page, "payments").focus();
    await page.keyboard.press("ArrowRight");
    await expect(arrow(page, "payments")).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowRight");
    await expect(treeOf(page).getByRole("button", { name: "refunds", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(nameOf(page, "payments")).toBeFocused();
    // 12. Space toggles without scrolling; on a file it does nothing; Enter opens a file and follows a name.
    await page.keyboard.press("Space");
    await expect(arrow(page, "payments")).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Space");
    const file = treeOf(page).getByRole("button", { name: "checkout", exact: true });
    await file.focus();
    const before = page.url();
    await page.keyboard.press("Space");
    expect(page.url()).toBe(before);
    await nameOf(page, "payments").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/diagrams\/payments\/$/);
    // 13 (wave 2 review): the folder followed takes the focus, so the keyboard carries on from its page.
    await expect(page.getByRole("region", { name: "payments", exact: true })).toBeFocused();
    await treeOf(page).getByRole("button", { name: "refunds", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
  } finally {
    await project.stop();
  }
});

test("a closed folder stays closed per project after a reload, a typed query opens it without forgetting, and only represented folders are rows", async ({
  page,
}) => {
  const project = await sharedTsProject({ files: TREE_FILES });
  try {
    await openTree(page, project.url);
    // 15-16. Folders of admitted files only: not the unadmitted private/, not the excluded docs/draft/.
    const folderNames = async (): Promise<string[]> =>
      treeOf(page)
        .locator("[data-folder]:not([data-project-root])")
        .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.folder ?? ""));
    // Polled: the tree is visible before the catalog has filled its rows (a one-shot read saw []).
    await expect
      .poll(folderNames)
      .toEqual(["diagrams", "diagrams/payments", "diagrams/payments/deep", "docs", "notes"]);
    // flake-check: ok — read after the rows were polled into place just above
    const links = await treeOf(page)
      .locator("[data-folder]:not([data-project-root]) a.archer-folder-tree-folder-link")
      .evaluateAll((anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).pathname));
    expect(links).toHaveLength(5);
    // 13. Close, reload: still closed, stored per project and path; navigating by name does not rewrite it.
    await arrow(page, "payments").click();
    const stored = async () =>
      page.evaluate(() => JSON.parse(window.localStorage.getItem("archer.folderTree.v1") ?? "{}"));
    const slug = Object.keys(await stored())[0]!;
    expect((await stored())[slug]).toEqual({ "diagrams/payments": false });
    await page.reload();
    await expect(arrow(page, "payments")).toHaveAttribute("aria-expanded", "false");
    await nameOf(page, "docs").click();
    await expect(page).toHaveURL(/\/docs\/$/);
    await page.goBack();
    await expect(arrow(page, "payments")).toHaveAttribute("aria-expanded", "false");
    expect((await stored())[slug]).toEqual({ "diagrams/payments": false });
    // 14. A match opens the remembered-closed folder; clearing the query returns to the remembered state.
    await searchBoxOf(page).fill("refund");
    await expect(treeOf(page).getByRole("button", { name: "refunds", exact: true })).toBeVisible();
    expect((await stored())[slug]).toEqual({ "diagrams/payments": false });
    await searchBoxOf(page).fill("");
    await expect(arrow(page, "payments")).toHaveAttribute("aria-expanded", "false");
    // 15. With a query, folders with no match disappear.
    await searchBoxOf(page).fill("Guide");
    await expect(nameOf(page, "docs")).toBeVisible();
    await expect(nameOf(page, "diagrams")).toHaveCount(0);
    // 16. Every folder row's link lists at least one item.
    await searchBoxOf(page).fill("");
    for (const href of await treeOf(page)
      .locator("a.archer-folder-tree-folder-link")
      .evaluateAll((anchors) => anchors.map((anchor) => (anchor as HTMLAnchorElement).pathname))) {
      await page.goto(new URL(href, page.url()).href);
      await expect(
        treeOf(page).locator("[data-browser-row]:not([data-folder]), [data-folder]").first(),
        href,
      ).toBeVisible();
    }
  } finally {
    await project.stop();
  }
});

test("on a phone the arrow and the name are separate targets of at least 24 px and nothing scrolls sideways", async ({
  page,
}) => {
  const project = await sharedTsProject({ files: TREE_FILES });
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openTree(page, project.url);
    for (const target of [arrow(page, "payments"), nameOf(page, "payments")]) {
      const box = (await target.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(24);
      expect(box.height).toBeGreaterThanOrEqual(24);
    }
    const a = (await arrow(page, "payments").boundingBox())!;
    const n = (await nameOf(page, "payments").boundingBox())!;
    expect(a.x + a.width).toBeLessThanOrEqual(n.x + 0.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect((await new AxeBuilder({ page }).analyze()).violations.map((violation) => violation.id)).toEqual([]);
  } finally {
    await project.stop();
  }
});

// Check 19 (performance plan D3): past about 200 files a project's folders start closed; a choice still wins.
test("a project past 200 files opens with its folders closed, and an opened folder is remembered across a reload", async ({
  page,
}) => {
  const files: Record<string, string> = { "archer.toml": "version = 1\n" };
  for (let i = 0; i < 201; i++)
    files[`.archer/notes/${i % 2 === 0 ? "a" : "b"}/n${i}.md`] = `# Note ${i}\n\nBody ${i}.\n`;
  const project = await sharedTsProject({ files });
  try {
    await openTree(page, project.url);
    await expect(arrow(page, "notes")).toHaveAttribute("aria-expanded", "false");
    await expect(treeOf(page).locator("[data-browser-row]")).toHaveCount(0);
    await arrow(page, "notes").click();
    await expect(arrow(page, "a")).toHaveAttribute("aria-expanded", "false");
    await arrow(page, "a").click();
    await expect(treeOf(page).locator("[data-browser-row]")).toHaveCount(101);
    expect(
      (await new AxeBuilder({ page }).include(".archer-folder-tree").analyze()).violations.map(
        (violation) => violation.id,
      ),
    ).toEqual([]);
    await page.reload();
    await expect(arrow(page, "a")).toHaveAttribute("aria-expanded", "true");
    await expect(arrow(page, "b")).toHaveAttribute("aria-expanded", "false");
  } finally {
    await project.stop();
  }
});
