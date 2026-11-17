/**
 * The sidebar, the project page and the search page (projects-and-search.md)
 * against two real projects in one service: names in the sidebar, recent
 * files across projects, the project browser's Folders tree across projects and by content,
 * its address as a link Back returns to, and the right project's context
 * for a file whose id another project shares.
 */
import { commentOperation } from "../support/comment-operations";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { apiBaseOf, fetchAsOwner, signInCookie } from "../support/ts-service";
import { placeOf, projectPath, routeOf, searchOf } from "./support/address";
import { readSearchState } from "../../src/app/file-index";
import { sharedTsProject } from "./support/shared-service";

const source = resolve(import.meta.dirname, "../../../ts/src");
const load = async (path: string) => import(/* @vite-ignore */ pathToFileURL(join(source, path)).href);

async function revealProjects(page: Page): Promise<void> {
  const heading = page.getByRole("heading", { name: "Projects", exact: true });
  if ((await page.locator(".primary-navigation").getAttribute("data-expanded")) !== "true") {
    const menu = page.getByRole("button", { name: "Menu", exact: true });
    if (await menu.isVisible()) await menu.click();
    else {
      const width = await page.evaluate(() => innerWidth);
      await page.mouse.move(width - 1, 1);
      await page.getByRole("button", { name: "Archer contents", exact: true }).hover();
    }
  }
  await expect(heading).toBeVisible();
}

/** The most a fixture may take on a loaded host, Git's creation dates included, before the test's own budget starts. */
const FIXTURE_ALLOWANCE_MS = 60_000;

async function fixture(
  options: {
    extraFiles?: number;
    readme?: boolean;
    dates?: boolean;
    largeProjectFiles?: Record<string, string>;
    smallProjectFiles?: Record<string, string>;
  } = {},
) {
  // Setting up two Git repositories and a service has taken 13 to 29 s on a loaded CI host, all
  // charged to the test's 45 s. The fixture gets its own allowance and the test keeps its full
  // budget for what it asserts.
  const info = test.info();
  const budget = info.timeout;
  const started = Date.now();
  info.setTimeout(budget + FIXTURE_ALLOWANCE_MS);
  const { startService } = await load("service/service.ts");
  const { connectService } = await load("service/client.ts");
  const directory = mkdtempSync(join(tmpdir(), "archer-project-directory-"));
  const stateDir = join(directory, "state");
  const roots = ["Pageturner", "Courierdesk"].map((name) => join(directory, name));
  for (const [index, root] of roots.entries()) {
    mkdirSync(join(root, ".archer", "notes"), { recursive: true });
    const projectFiles = index === 0 ? options.largeProjectFiles : options.smallProjectFiles;
    if (projectFiles !== undefined) {
      for (const [path, contents] of Object.entries(projectFiles)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), contents);
      }
    } else {
      writeFileSync(
        join(root, "archer.toml"),
        `version = 1\nname = "${index === 0 ? "Pageturner" : "Courierdesk"}"\n[[views]]\nid = "checkout"\nkind = "freeform"\ntitle = "Checkout"\nsource = ".archer/checkout-flow.mmd"\n[[views]]\nid = "standby"\nkind = "freeform"\ntitle = "Standby"\nsource = ".archer/standby.mmd"\n`,
      );
      writeFileSync(
        join(root, ".archer", "checkout-flow.mmd"),
        `flowchart LR\n a[${index === 0 ? "Reader" : "Courier"}] link@--> b[Dispatch]\n`,
      );
      writeFileSync(
        join(root, ".archer", "standby.mmd"),
        "flowchart LR\n old[Standing presentation] link@--> waiting[Waiting]\n",
      );
      writeFileSync(
        join(root, ".archer", "notes", "operations.md"),
        `---\ndescription: How ${index === 0 ? "books" : "parcels"} move\n---\n# Operations\n\n${index === 0 ? "Book inventory" : "Quasar parcel pickup"}.\n`,
      );
    }
    for (let extra = 1; extra <= (options.extraFiles ?? 0); extra++)
      writeFileSync(join(root, ".archer", `extra-${extra}.mmd`), `flowchart LR\n item[Extra ${extra}]\n`);
    if (options.readme) {
      writeFileSync(
        join(root, "README.md"),
        `# ${index === 0 ? "Pageturner" : "Courierdesk"}\n\n${index === 0 ? "A library for curious readers." : "A dispatch desk for everyday parcels."}\n`,
      );
      appendFileSync(join(root, "archer.toml"), '\n[discovery]\nroots = [".archer", "README.md"]\n');
    }
    // A creation date is only known from an unambiguous birth time or Git.
    // Give this fixture a real Git fallback instead of relying on filesystem
    // timestamps differing when a file is created in one write.
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Archer test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "Add sample files",
    ]);
  }
  const service = await startService({
    stateDir,
    env: { HOME: directory, XDG_CONFIG_HOME: join(directory, "config") },
    forceHttp: true,
    socketPath: join(stateDir, "archer.sock"),
    log: () => {},
  });
  const client = await connectService(service.socketPath);
  const urls: string[] = [];
  for (const root of roots) urls.push((await client.call("attach", { root })).url);
  const cookie = await signInCookie(urls[0]!);
  const ownerFetch = (index: number, path: string, init?: RequestInit): Promise<Response> =>
    fetchAsOwner(new URL(path, apiBaseOf(urls[index]!)).href, cookie, init);
  // Creation dates come from Git in the background; a loaded CI host can take over 10s.
  // A test that never reads a creation date does not wait for Git (`dates: false`).
  if (options.dates !== false)
    await expect
      .poll(
        async () => {
          const catalog = await (await ownerFetch(0, "api/projects")).json();
          return catalog.projects.every(
            (project: { views: { createdAt?: string }[]; notes: { createdAt?: string }[] }) =>
              [...project.views, ...project.notes].every((file) => file.createdAt !== undefined),
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
  info.setTimeout(budget + (Date.now() - started));
  return {
    urls,
    fetch: ownerFetch,
    roots,
    call: (index: number, method: string, args: object = {}) => client.call(method, { root: roots[index], ...args }),
    async stop() {
      client.close();
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function allDiagramTypesFiles(options: { extraNotes?: number; description?: string } = {}): Record<string, string> {
  const families = [
    ["freeform", "flowchart"],
    ["sequence", "sequence"],
    ["state", "state"],
    ["entity-relationship", "er"],
    ["c4", "c4"],
    ["architecture", "architecture"],
    ["journey", "journey"],
  ] as const;
  return {
    "archer.toml": `version = 1\n${families.map(([kind, id]) => `[[views]]\nid = "${id}"\nkind = "${kind}"\ntitle = "${id}"\nsource = ".archer/${id}.mmd"\n`).join("\n")}`,
    ...Object.fromEntries(
      families.map(([, id]) => [
        `.archer/${id}.mmd`,
        readFileSync(resolve(import.meta.dirname, `../../../ts/test/fixtures/${id}/widened.mmd`), "utf8"),
      ]),
    ),
    ".archer/notes/operations.md": "# Operations\n\nRunning the service.\n",
    ...Object.fromEntries(
      Array.from({ length: options.extraNotes ?? 0 }, (_, index) => {
        const number = String(index + 1).padStart(2, "0");
        return [
          `.archer/notes/scroll-${number}.md`,
          `---\ntype: runbook\ndescription: ${options.description ?? "Instructions for operating the service."}\n---\n# Scroll document ${number}\n\nDetailed operating instructions for document ${number}.\n`,
        ];
      }),
    ),
  };
}

async function allDiagramTypesProject(options: { extraNotes?: number; description?: string } = {}) {
  return sharedTsProject({ files: allDiagramTypesFiles(options) });
}

const searchBox = (page: Page) => page.getByRole("searchbox", { name: "Search projects and files" });
const searchButton = (page: Page) =>
  page.locator(".archer-search-bar").getByRole("button", { name: "Search", exact: true });
const results = (page: Page) => page.getByRole("region", { name: "Project documents", exact: true });
/** The file rows of the Folders tree (every folder starts open). */
const rows = (page: Page) => results(page).locator("[data-browser-row]");
/** Each file row's open control: its title. */
const titles = (page: Page) => results(page).locator("[data-browser-row] .archer-folder-tree-open");
const projectRoot = (page: Page, name: string) =>
  results(page)
    .locator("[data-project-root]")
    .filter({ has: page.locator(".archer-folder-tree-folder-link", { hasText: new RegExp(`^${name}$`) }) });
const filters = (page: Page) => page.getByRole("button", { name: /^Filters(?: \(\d+\))?$/ });
const slugOf = (url: string): string => new URL(url).pathname.split("/").at(-2)!;

async function expectSearchToolbar(page: Page, viewportWidth: number): Promise<void> {
  const input = searchBox(page),
    search = searchButton(page),
    filter = filters(page);
  const fields = page.locator(".archer-search-bar").getByRole("button", { name: /^(?:Table Columns|Card Details)$/ });
  await expect(search).toBeVisible();
  await expect(filter).toBeVisible();
  await expect(fields).toHaveCount(0);
  const barBox = (await page.locator(".archer-search-bar").boundingBox())!;
  const fieldBox = (await page.locator(".archer-browser-search-field").boundingBox())!;
  const inputBox = (await input.boundingBox())!;
  const searchRect = (await search.boundingBox())!;
  const filterBox = (await filter.boundingBox())!;
  const centerY = (box: { y: number; height: number }): number => box.y + box.height / 2;
  expect(Math.abs(barBox.height - fieldBox.height), "the toolbar remains one row tall").toBeLessThanOrEqual(1);
  expect(fieldBox.height).toBeLessThanOrEqual(56);
  // Search then Filters, both at the field's trailing end, inside it (round 1 pass 5 O1).
  expect(searchRect.x).toBeGreaterThan(inputBox.x + inputBox.width / 2);
  expect(filterBox.x).toBeGreaterThanOrEqual(searchRect.x + searchRect.width);
  expect(filterBox.x - searchRect.x - searchRect.width).toBeLessThanOrEqual(16);
  expect(filterBox.x + filterBox.width).toBeLessThanOrEqual(inputBox.x + inputBox.width);
  expect(inputBox.x + inputBox.width - filterBox.x - filterBox.width).toBeLessThanOrEqual(8);
  const actionSize = await page.evaluate(() => (matchMedia("(pointer: coarse)").matches ? 44 : 36));
  for (const control of [searchRect, filterBox]) {
    expect(control.width).toBe(actionSize);
    expect(control.height).toBe(control.width);
    expect(
      Math.abs(centerY(control) - centerY(inputBox)),
      "every toolbar action shares the field's vertical center",
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(centerY(control) - centerY(searchRect)),
      "Search, Filters and fields share one row",
    ).toBeLessThanOrEqual(1);
    expect(control.x).toBeGreaterThanOrEqual(0);
    expect(control.x + control.width).toBeLessThanOrEqual(viewportWidth);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const placeholder = await input.evaluate((element) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text-dim)";
    probe.hidden = true;
    element.parentElement!.append(probe);
    const dim = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(element, "::placeholder");
    return { color: style.color, opacity: style.opacity, dim };
  });
  expect(placeholder.color).toBe(placeholder.dim);
  expect(placeholder.opacity).toBe("1");
  expect(
    (await new AxeBuilder({ page }).include(".archer-search-input").withRules(["color-contrast"]).analyze()).violations,
  ).toEqual([]);
  await input.focus();
  await page.keyboard.press("Tab");
  await expect(search).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(filter).toBeFocused();
}

test("filters open a keyboard modal above the retained project tree", async ({ page }) => {
  const server = await fixture({ dates: false });
  try {
    await page.goto(`${server.urls[0]!}&q=`);
    const launcher = page.getByRole("button", { name: /^Filters(?: \(\d+\))?$/ });
    await expect(launcher).toBeVisible();
    await launcher.click();
    const dialog = page.getByRole("dialog", { name: "Project Filters" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close filters" })).toBeFocused();
    // The trap wraps between the close button and the last focusable control in the panel.
    const last = dialog
      .locator(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])",
      )
      .last();
    await page.keyboard.press("Shift+Tab");
    await expect(last).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close filters" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(launcher).toBeFocused();
    const address = page.url();
    await launcher.click();
    await expect(dialog).toBeVisible();
    // The backdrop receives the pointer; the sidebar behind it stays inert.
    await page.mouse.click(1, 1);
    await expect(dialog).toHaveCount(0);
    await expect(launcher).toBeFocused();
    expect(page.url()).toBe(address);
  } finally {
    await server.stop();
  }
});

test("the project browser retains its field and tree while source-only search becomes a shared address", async ({
  page,
}) => {
  const server = await sharedTsProject({
    files: {
      ".archer/checkout.mmd": "flowchart LR\n a[Reader] link@--> b[Dispatch]\n",
      ".archer/standby.mmd": "flowchart LR\n old[Standing presentation] link@--> waiting[Waiting]\n",
      ".archer/notes/operations.md": "# Operations\n\nRunning the service.\n",
    },
  });
  try {
    await page.goto(server.url); // Nothing presented: the follow page is the all-projects overview.
    const input = searchBox(page);
    const gallery = results(page);
    // The rail widens under a resting mouse, and Chromium can report the untouched pointer at
    // (0, 0), over the rail, once the page lays out; the widened rail then covers the rows.
    // Rest the pointer clear of the rail, as a reader's would be, before anything is clicked.
    await page.mouse.move(1439, 899);
    await expect(page.locator(".primary-navigation")).toHaveAttribute("data-expanded", "false");
    await expect(rows(page)).toHaveCount(3);
    await expect(page.locator(".archer-search-summary")).not.toContainText(/listing|searching/);
    const before = {
      input: await input.boundingBox(),
      gallery: await gallery.boundingBox(),
      filters: await filters(page).boundingBox(),
    };
    await input.evaluate((element) => element.setAttribute("data-retained-field", "yes"));
    await gallery.evaluate((element) => element.setAttribute("data-retained-gallery", "yes"));
    const length = await page.evaluate(() => history.length);
    let releaseSearch!: () => void;
    let receivedSearch!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });
    const received = new Promise<void>((resolve) => {
      receivedSearch = resolve;
    });
    await page.route("**/api/browser-search?*", async (route) => {
      const response = await route.fetch();
      receivedSearch();
      await held;
      await route.fulfill({ response });
    });
    await input.fill("Dispatch");
    await input.press("Enter");
    try {
      await received;
      await expect(page.locator(".archer-search-summary")).toContainText("searching");
      await expect(gallery).toHaveAttribute("data-retained-gallery", "yes");
      await expect(input).toBeFocused();
      expect(await input.boundingBox()).toEqual(before.input);
      expect(await filters(page).boundingBox()).toEqual(before.filters);
    } finally {
      releaseSearch();
    }
    await expect(rows(page)).toHaveCount(1);
    await expect(page.locator(".archer-search-summary")).not.toContainText(/listing|searching/);
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("data-retained-field", "yes");
    await expect(gallery).toHaveAttribute("data-retained-gallery", "yes");
    expect(await input.boundingBox()).toEqual(before.input);
    const afterGallery = await gallery.boundingBox();
    expect({ x: afterGallery?.x, width: afterGallery?.width }).toEqual({
      x: before.gallery?.x,
      width: before.gallery?.width,
    });
    const address = page.url();
    expect(new URL(address).searchParams.get("q")).toBe("Dispatch");
    expect(new URL(address).searchParams.get("project")).toBeNull();
    expect(await page.evaluate(() => history.length)).toBe(length + 1);
    await gallery.getByRole("button", { name: "Node · Dispatch", exact: true }).click();
    await expect(page.locator('.react-flow__node[data-id="b"]')).toHaveClass(/selected/);
    await page.goBack();
    await expect(input).toHaveValue("Dispatch");
    expect(page.url()).toBe(address);
    await page.reload();
    await expect(input).toHaveValue("Dispatch");
    await expect(rows(page)).toHaveCount(1);
    expect(new URL(page.url()).searchParams.get("project")).toBeNull();
  } finally {
    await server.stop();
  }
});

test("G opens and refocuses search on a notes-only project", async ({ page }) => {
  const server = await sharedTsProject({
    files: { ".archer/runbook.md": "# Runbook\n\nOperating the service.\n" },
  });
  try {
    await page.goto(server.url);
    await expect(results(page)).toBeVisible();
    await page.keyboard.press("g");
    await expect(searchBox(page)).toBeFocused();
    await expect(results(page).getByRole("button", { name: "Runbook", exact: true })).toBeVisible();
    await searchButton(page).focus();
    await page.keyboard.press("Shift+G");
    await expect(searchBox(page)).toBeFocused();
  } finally {
    await server.stop();
  }
});

// O33: the catalog read missing its 10 s deadline on a loaded CI host left the project's own page
// at "0 files" until the next poll, though its own notes had answered.
test("a project page lists its own files when the project catalog cannot be read", async ({ page }) => {
  const server = await sharedTsProject({
    files: { ".archer/runbook.md": "# Runbook\n\nOperating the service.\n" },
  });
  try {
    await page.route("**/api/browser-projects", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: "{}" }),
    );
    await page.goto(server.url);
    const summary = page.getByRole("status").filter({ hasText: "other projects could not be listed" });
    await expect(results(page).getByRole("button", { name: "Runbook", exact: true })).toBeVisible();
    // Unverified by the catalog, so not claimed complete (ADR 0017).
    await expect(summary).toContainText("1 file");
    await expect(summary).toContainText("Documentation listing incomplete");
  } finally {
    await server.stop();
  }
});

test("the sidebar names the attached projects, and a name opens that project's page", async ({ page }) => {
  const server = await fixture();
  try {
    await page.goto(server.urls[0]!);
    await revealProjects(page);
    const projectNavigation = page.getByRole("navigation", { name: "Projects" });
    const names = projectNavigation.getByRole("button");
    await expect(names).toHaveText(["Overview", "Pageturner", "Courierdesk"]);
    // Names only: no paths in the sidebar.
    await expect(page.locator(".primary-navigation")).not.toContainText(".mmd");
    const contents = page.getByRole("button", { name: "Archer contents", exact: true });
    await contents.focus();
    await expect(contents).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(contents).toBeFocused();
    await revealProjects(page);
    await names.filter({ hasText: "Courierdesk" }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(projectPath(server.urls[1]!));
    expect(searchOf(page.url())).toMatchObject({ query: "", projects: [slugOf(server.urls[1]!)] });
    // That project's own page: its title section and its Folders tree.
    await expect(
      page.locator(".archer-project-title").getByRole("heading", { level: 1, name: "Courierdesk", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Project settings", exact: true })).toBeVisible();
    const project = results(page);
    await expect(project.getByRole("button", { name: "Operations", exact: true })).toBeVisible();
    await expect(
      rows(page).filter({ has: page.getByRole("button", { name: "Operations", exact: true }) }),
    ).toContainText("operations.md");
  } finally {
    await server.stop();
  }
});

for (const width of [1440, 1024]) {
  test(`the Folders tree shows its columns and every project without page overflow at ${width}`, async ({ page }) => {
    const server = await fixture();
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${server.urls[0]!}&q=`);
      const tree = page.getByRole("treegrid", { name: "Project files", exact: true });
      await expect(tree).toHaveCount(1);
      await expect(tree.getByRole("columnheader")).toHaveText([
        "Name",
        "Title",
        "Kind",
        "Threads",
        "Edited",
        "Created",
      ]);
      await expect(projectRoot(page, "Pageturner")).toHaveCount(1);
      await expect(projectRoot(page, "Courierdesk")).toHaveCount(1);
      await expect(rows(page)).toHaveCount(6);
      // The tree's title column is aligned: every title starts at the same x, whatever its depth.
      const starts = await titles(page).evaluateAll((elements) =>
        elements.map((element) => Math.round(element.getBoundingClientRect().left)),
      );
      expect(new Set(starts).size).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await server.stop();
    }
  });
}

test("a true coarse pointer keeps the toolbar reachable and the tree inside its own scrolling frame", async ({
  browser,
}) => {
  const server = await allDiagramTypesProject({ extraNotes: 16 });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  try {
    const page = await context.newPage();
    await page.goto(server.url); // Nothing presented: the follow page is the all-projects overview.
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await expectSearchToolbar(page, 390);
    await expect(rows(page)).toHaveCount(24);
    const box = (await filters(page).boundingBox())!;
    expect(box.width, "coarse-pointer actions have a 44px target width").toBeGreaterThanOrEqual(44);
    expect(box.height, "coarse-pointer actions have a 44px target height").toBeGreaterThanOrEqual(44);
    await expect(titles(page).first()).toBeVisible();
    // On a phone the tree reads as names with titles beneath: it fits its frame, and the page never scrolls sideways.
    const frame = page.locator(".archer-folder-tree-frame").first();
    expect(await frame.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await server.selection()).toBeNull();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  } finally {
    await context.close();
    await server.stop();
  }
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`grouped filter controls stay usable beside all diagram types at ${viewport.width}`, async ({ page }) => {
    const server = await allDiagramTypesProject();
    try {
      await page.setViewportSize(viewport);
      await page.goto(server.url); // Nothing presented: the follow page is the all-projects overview.
      await filters(page).click();
      const dialog = page.getByRole("dialog", { name: "Project Filters" });
      const files = dialog
        .locator("section.archer-filter-section")
        .filter({ has: page.getByText("Files", { exact: true }) });
      const discussions = dialog
        .locator("section.archer-filter-section")
        .filter({ has: page.getByText("Discussions", { exact: true }) });
      const dates = dialog
        .locator("section.archer-filter-section")
        .filter({ has: page.getByText("Dates", { exact: true }) });
      await expect(files).toBeVisible();
      await expect(discussions).toBeVisible();
      await expect(dates).toBeVisible();
      await expect(files.getByRole("group", { name: "Kind", exact: true }).getByRole("checkbox")).toHaveCount(2);
      await expect(files.getByRole("group", { name: "Diagram type", exact: true }).getByRole("checkbox")).toHaveCount(
        7,
      );

      await expect(dialog.locator("summary")).toHaveCount(0);
      const totalCondition = discussions.getByRole("combobox", { name: "Total threads condition" });
      const unresolvedCondition = discussions.getByRole("combobox", { name: "Unresolved threads condition" });
      for (const condition of [totalCondition, unresolvedCondition]) {
        await expect(condition.locator("option")).toHaveText(["Any", "Equals", "At least", "At most", "Between"]);
      }

      const edited = dates.getByRole("group", { name: "Edited", exact: true }).getByRole("combobox");
      const created = dates.getByRole("group", { name: "Created", exact: true }).getByRole("combobox");
      const commented = dates.getByRole("group", { name: "Commented", exact: true }).getByRole("combobox");
      for (const date of [edited, created, commented]) {
        await expect
          .poll(() =>
            date
              .locator("option")
              .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
          )
          .toEqual(["", "1d", "7d", "30d", "365d", "after", "before", "between"]);
        await expect
          .poll(() =>
            date
              .locator("option")
              .evaluateAll((options) => options.map((option) => option.textContent!.replace(/ \(\d+\)$/u, ""))),
          )
          .toEqual([
            "Any time",
            "Past day",
            "Past week",
            "Past month",
            "Past year",
            "On or after…",
            "On or before…",
            "Between dates…",
          ]);
      }
      for (const select of [totalCondition, unresolvedCondition, edited, created, commented]) {
        await expect(select).toBeVisible();
        const height = await select.evaluate((element) => element.getBoundingClientRect().height);
        expect(
          height,
          "native selects retain a control height beside the tall diagram type list",
        ).toBeGreaterThanOrEqual(34);
        expect(height, "native selects do not stretch with their grid row").toBeLessThanOrEqual(44);
      }
    } finally {
      await server.stop();
    }
  });

  test(`the tree opens a note without a selection, and a diagram's title opens it with one reader selection, at ${viewport.width}`, async ({
    page,
  }) => {
    const server = await allDiagramTypesProject({ extraNotes: 16 });
    try {
      const comment = await server.fetch("api/comments", {
        method: "POST",
        headers: { "content-type": "application/json", origin: new URL(server.url).origin },
        body: JSON.stringify(
          commentOperation.create({
            target: "note:notes/scroll-16.md",
            anchor: { kind: "view" },
            body: "Discuss recovery ownership.",
          }),
        ),
      });
      expect(comment.ok).toBe(true);
      const selectionWrites: unknown[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/api/selection"))
          selectionWrites.push(request.postDataJSON());
      });
      await page.setViewportSize(viewport);
      await page.goto(server.url); // Nothing presented: the follow page is the all-projects overview.
      await expect(rows(page)).toHaveCount(24);
      const tree = page.getByRole("treegrid", { name: "Project files", exact: true });
      // The column headers are a desktop affordance; a phone's tree has none (names with titles beneath).
      if (viewport.width > 640) {
        const titleHeader = tree.getByRole("columnheader", { name: /^Title/ });
        await titleHeader.getByRole("button", { name: "Title", exact: true }).click();
        await expect(titleHeader).toHaveAttribute("aria-sort", "ascending");
      }
      const noteRow = rows(page).filter({ has: page.getByRole("button", { name: "Scroll document 16", exact: true }) });
      await expect(noteRow.locator('[data-column="kind"]')).toHaveText("runbook");
      await expect(noteRow.locator('[data-column="threads"]')).toContainText("1 open");
      await expect(noteRow.locator(".archer-folder-tree-file")).toHaveAttribute("title", ".archer/notes/scroll-16.md");
      // The notes folder is a real disclosure button.
      const notes = tree.getByRole("button", { name: /^(Expand|Collapse) notes$/ });
      await expect(notes).toHaveAttribute("aria-expanded", "true");
      await notes.focus();
      await page.keyboard.press("Enter");
      await expect(notes).toHaveAttribute("aria-expanded", "false");
      await expect(noteRow).toHaveCount(0);
      await page.keyboard.press("Space");
      await expect(notes).toHaveAttribute("aria-expanded", "true");
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await noteRow.getByRole("button", { name: "Scroll document 16", exact: true }).click();
      await expect(page.getByRole("article", { name: "Reading Scroll document 16" })).toContainText(
        "Detailed operating instructions for document 16.",
      );
      expect(placeOf(page.url())).toEqual({ kind: "note", path: "notes/scroll-16.md" });
      expect(await server.selection()).toBeNull();
      expect(selectionWrites).toEqual([]);
      await page.goBack();
      await expect(rows(page)).toHaveCount(24);
      await rows(page)
        .filter({ has: page.getByRole("button", { name: "flowchart", exact: true }) })
        .getByRole("button", { name: "flowchart", exact: true })
        .click();
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
      expect(routeOf(page.url())).toMatchObject({ kind: "file", path: "flowchart.mmd" });
      expect(await server.selection()).toMatchObject({
        viewId: "flowchart",
        presentationId: "reader:flowchart",
        nodes: [],
        edges: [],
      });
      expect(selectionWrites).toMatchObject([
        {
          schemaVersion: 1,
          viewId: "flowchart",
          presentationId: "reader:flowchart",
          selectionRevision: 0,
          nodes: [],
          edges: [],
        },
      ]);
    } finally {
      await server.stop();
    }
  });

  test(`the filter panel preserves its frame while only content scrolls at ${viewport.width}`, async ({ page }) => {
    const server = await allDiagramTypesProject();
    try {
      // A short window makes the real seven-family filter content scroll at both widths.
      await page.setViewportSize({ width: viewport.width, height: 600 });
      await page.goto(server.address(`q=&edited=2000-01-01..2100-12-31&created=2000-01-01..2100-12-31`));
      const launcher = filters(page);
      await launcher.click();
      const dialog = page.getByRole("dialog", { name: "Project Filters" });
      // Filters are the dialog's only content: no section navigation since the cards and tables went.
      await expect(dialog.locator(".archer-browser-panels")).toHaveCount(0);
      const content = dialog.locator(".archer-browser-content");
      const filesSection = dialog
        .locator("section.archer-filter-section")
        .filter({ has: page.getByText("Files", { exact: true }) });
      const discussionsSection = dialog
        .locator("section.archer-filter-section")
        .filter({ has: page.getByText("Discussions", { exact: true }) });
      const datesSection = dialog
        .locator("section.archer-filter-section")
        .filter({ has: page.getByText("Dates", { exact: true }) });
      await expect(filesSection).toBeVisible();
      await expect(discussionsSection).toBeVisible();
      await expect(datesSection).toBeVisible();
      await expect(
        filesSection.getByRole("group", { name: "Diagram type", exact: true }).getByRole("checkbox"),
      ).toHaveCount(7);
      for (const name of ["Edited", "Created", "Commented"])
        await expect(datesSection.getByRole("group", { name, exact: true }).getByRole("combobox")).toBeVisible();
      await expect(dialog.getByRole("group", { name: "Card Details", exact: true })).toHaveCount(0);
      const bounds = async () => ({
        dialog: await dialog.boundingBox(),
        header: await dialog.locator(".archer-browser-dialog-heading").boundingBox(),
        close: await dialog.getByRole("button", { name: "Close filters" }).boundingBox(),
      });
      const before = await bounds();
      expect(before.dialog!.y).toBeGreaterThanOrEqual(0);
      expect(before.dialog!.y + before.dialog!.height).toBeLessThanOrEqual(600);
      const contentBox = (await content.boundingBox())!;
      expect(await content.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      await page.mouse.move(contentBox.x + contentBox.width - 8, contentBox.y + contentBox.height / 2);
      await page.mouse.wheel(0, 10000);
      await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await expect(
        datesSection.getByRole("group", { name: "Created", exact: true }).getByLabel("To", { exact: true }),
      ).toBeInViewport();
      expect(await dialog.evaluate((element) => element.scrollTop)).toBe(0);
      expect(await page.evaluate(() => scrollY)).toBe(0);
      expect(await bounds(), "scrolling filter contents leaves the frame and fixed controls still").toEqual(before);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(launcher).toBeFocused();
    } finally {
      await server.stop();
    }
  });

  test(`live search retains every filter and Enter or Search never opens a result at ${viewport.width}`, async ({
    page,
  }) => {
    const server = await fixture();
    try {
      const comment = await server.fetch(1, "api/comments", {
        method: "POST",
        headers: { "content-type": "application/json", origin: new URL(server.urls[1]!).origin },
        body: JSON.stringify(
          commentOperation.create({
            target: "view:checkout",
            anchor: { kind: "view" },
            body: "Discuss the dispatch flow.",
          }),
        ),
      });
      expect(comment.ok).toBe(true);
      const address = new URL(server.urls[0]!);
      const retained = new URLSearchParams({
        project: slugOf(server.urls[1]!),
        kind: "diagram",
        type: "freeform",
        under: "",
        status: "comments",
        edited: "2000-01-01..2100-12-31",
        created: "2000-01-01..2100-12-31",
        sort: "name",
      });
      const token = address.searchParams.get("token")!;
      address.search = `follow&${retained}`;
      address.searchParams.set("q", "checkout");
      address.searchParams.set("token", token);
      const searchRequests: string[] = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/api/browser-search")) searchRequests.push(url.searchParams.get("q") ?? "");
      });
      // The address keeps every filter; on the clean address the project and folder are its path.
      const assertFilters = (): void => {
        const current = searchOf(page.url())!;
        const wanted = readSearchState(`?${new URLSearchParams({ ...Object.fromEntries(retained), q: "" })}`)!;
        for (const key of ["projects", "kinds", "types", "folder", "status", "edited", "created", "sort"] as const)
          expect(
            key === "folder" ? current.folder || null : current[key],
            `the ${key} filter survives submission`,
          ).toEqual(key === "folder" ? wanted.folder || null : wanted[key]);
      };
      await page.setViewportSize(viewport);
      await page.goto(address.href);
      const input = searchBox(page);
      const submit = searchButton(page);
      await expect(rows(page)).toHaveCount(1);
      await expect(titles(page)).toHaveText(["Checkout"]);
      await expect(page.locator(".archer-search-summary")).not.toContainText(/listing|searching/);
      const sent = searchRequests.length;
      const liveRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname.endsWith("/api/browser-search") && url.searchParams.get("q")?.toLowerCase() === "dispatch";
      });
      await input.fill("Dispatch");
      await liveRequest;
      await expect(page.locator(".archer-search-summary")).not.toContainText(/listing|searching/);
      await expect(input).toBeFocused();
      expect(searchOf(page.url())?.query).toBe("Dispatch");
      expect(searchRequests.length).toBeGreaterThan(sent);
      const projectScope = page.getByRole("button", { name: "Clear project filter", exact: true });
      await expect(projectScope).toContainText("Courierdesk");
      await filters(page).click();
      const dialog = page.getByRole("dialog", { name: "Project Filters" });
      await expect(dialog.getByRole("checkbox", { name: /Courierdesk/ })).toHaveCount(0);
      for (const name of [/Diagrams/, /Flowchart/, /Has open threads/])
        await expect(dialog.getByRole("checkbox", { name })).toBeChecked();
      await page.keyboard.press("Escape");
      await expect(input).toHaveValue("Dispatch");
      await expect(titles(page)).toHaveText(["Checkout"]);
      expect(searchOf(page.url())?.query).toBe("Dispatch");
      // Filter edits preserve the live query and all other restrictions.
      await filters(page).click();
      await page
        .getByRole("dialog", { name: "Project Filters" })
        .getByRole("combobox", { name: "Sort by" })
        .selectOption("name:desc");
      retained.set("sort", "-name");
      await page.keyboard.press("Escape");
      expect(searchOf(page.url())?.query).toBe("Dispatch");
      await expect(input).toHaveValue("Dispatch");
      assertFilters();
      await input.press("Enter");
      await expect(rows(page)).toHaveCount(1);
      await expect(page.locator(".archer-search-summary")).not.toContainText(/listing|searching/);
      await expect(input).toBeFocused();
      await expect(results(page)).toBeVisible();
      await expect(page.locator(".react-flow")).toHaveCount(0);
      expect(searchOf(page.url())?.query).toBe("Dispatch");
      expect(placeOf(page.url())?.kind).toBe("search");
      assertFilters();

      const buttonRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname.endsWith("/api/browser-search") && url.searchParams.get("q") === "zebra";
      });
      await input.fill("zebra");
      await buttonRequest;
      await expect(page.locator(".archer-search-summary")).not.toContainText(/listing|searching/);
      await expect(rows(page)).toHaveCount(0);
      expect(searchOf(page.url())?.query).toBe("zebra");
      assertFilters();
      const submittedAddress = page.url();
      await submit.click();
      expect(page.url()).toBe(submittedAddress);
      await expect(page.locator(".react-flow")).toHaveCount(0);
      await input.fill("");
      await expect(rows(page)).toHaveCount(1);
      expect(searchOf(page.url())?.query).toBe("");
      assertFilters();
      expect((await server.call(0, "getContext")).selection).toBeNull();
      expect((await server.call(1, "getContext")).selection).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test(`the overview introduces each project and a project root closes and opens its files at ${viewport.width}`, async ({
    page,
  }) => {
    const server = await fixture({ extraFiles: 6, readme: true });
    try {
      await page.setViewportSize(viewport);
      await page.goto(`${server.urls[0]!}&q=`);
      const first = projectRoot(page, "Pageturner");
      const second = projectRoot(page, "Courierdesk");
      await expect(first).toBeVisible();
      await expect(second).toBeVisible();
      await expect(rows(page)).toHaveCount(20);
      await expect(first.locator(".archer-folder-tree-description")).toHaveText("A library for curious readers.");
      await expect(second.locator(".archer-folder-tree-description")).toHaveText(
        "A dispatch desk for everyday parcels.",
      );

      // The project root's disclosure owns its files.
      const disclosure = first.getByRole("button", { name: /^(Expand|Collapse) Pageturner$/ });
      await expect(disclosure).toHaveAttribute("aria-expanded", "true");
      await disclosure.click();
      await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      await expect(rows(page)).toHaveCount(10);
      // The choice follows the project across tabs.
      await page.getByRole("tab", { name: /^Notes/ }).click();
      await page.getByRole("tab", { name: /^Folders/ }).click();
      await expect(first.getByRole("button", { name: /^(Expand|Collapse) Pageturner$/ })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await first.getByRole("button", { name: /^(Expand|Collapse) Pageturner$/ }).click();
      await expect(rows(page)).toHaveCount(20);
      expect((await new AxeBuilder({ page }).analyze()).violations.map((violation) => violation.id)).toEqual([]);

      await first.getByRole("link", { name: "Pageturner", exact: true }).click();
      await expect(second).toHaveCount(0);
      expect(searchOf(page.url())?.projects).toEqual([slugOf(server.urls[0]!)]);
      await expect(
        page.locator(".archer-project-title").getByRole("heading", { level: 1, name: "Pageturner", exact: true }),
      ).toBeVisible();
      await searchBox(page).fill("extra");
      await searchBox(page).press("Enter");
      await expect(page.locator(".archer-search-summary")).not.toContainText(/listing|searching/);
      const address = page.url();
      await expect(rows(page)).toHaveCount(6);
      await expect(page.getByRole("combobox", { name: "Sort by" })).toHaveCount(0);
      await page.reload();
      await expect(rows(page)).toHaveCount(6);
      await expect(searchBox(page)).toHaveValue("extra");
      expect(page.url()).toBe(address);
    } finally {
      await server.stop();
    }
  });

  test(`the filter dialog is centred over an inert tree and returns focus at ${viewport.width}`, async ({ page }) => {
    const server = await fixture();
    try {
      await page.setViewportSize(viewport);
      await page.goto(`${server.urls[0]!}&q=`);
      await expect(projectRoot(page, "Courierdesk")).toBeVisible();
      await expect(rows(page)).toHaveCount(6);
      await expectSearchToolbar(page, viewport.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      const before = page.url();
      await filters(page).click();
      const dialog = page.getByRole("dialog", { name: "Project Filters" });
      await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThan(1);
      expect(await results(page).evaluate((element) => element.closest("[inert]") !== null)).toBe(true);
      await dialog.getByRole("button", { name: "Close filters", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(filters(page)).toBeFocused();
      expect(page.url()).toBe(before);
      expect(await results(page).evaluate((element) => element.closest("[inert]") !== null)).toBe(false);
    } finally {
      await server.stop();
    }
  });

  test(`the search page finds files across projects and by content, and Back returns to it, at ${viewport.width}`, async ({
    page,
  }) => {
    const server = await fixture();
    try {
      await page.setViewportSize(viewport);
      await page.goto(`${server.urls[0]!}&q=`);
      await page.getByRole("region", { name: "Search projects and files", exact: true }).waitFor();
      await page.keyboard.press("/");
      await expect(searchBox(page)).toBeFocused();
      await searchBox(page).fill("checkout-flow");
      await searchBox(page).press("Enter");
      await expect(results(page).getByRole("button", { name: "Checkout", exact: true })).toHaveCount(2);
      await searchBox(page).fill("Courierdesk");
      await searchBox(page).press("Enter");
      await expect(page.locator(".archer-search-summary")).not.toContainText(/listing|searching/);
      await expect(rows(page)).toHaveCount(3);
      await searchBox(page).fill("quasar");
      await searchBox(page).press("Enter");
      const finding = results(page).getByRole("button", { name: "Operations", exact: true });
      await expect(finding).toHaveCount(1);
      const row = rows(page).filter({ has: page.getByRole("button", { name: "Operations", exact: true }) });
      await expect(row).toContainText("operations.md");
      // The match is the Courierdesk project's own file.
      expect((await row.getAttribute("data-browser-row"))?.startsWith(`${slugOf(server.urls[1]!)}\0`)).toBe(true);
      expect(searchOf(page.url())?.query).toBe("quasar");
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      await finding.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(`${projectPath(server.urls[1]!)}notes/operations.md`);
      expect(placeOf(page.url())).toEqual({ kind: "note", path: "notes/operations.md" });
      await expect(page.getByRole("article", { name: "Reading Operations" })).toContainText("Quasar parcel pickup");
      // The search page is a link: Back is the same search.
      await page.goBack();
      await expect(searchBox(page)).toHaveValue("quasar");
      await expect(results(page).getByRole("button", { name: "Operations", exact: true })).toHaveCount(1);
    } finally {
      await server.stop();
    }
  });

  test(`a file whose id another project shares opens in its own project's context at ${viewport.width}`, async ({
    page,
  }) => {
    const server = await fixture();
    try {
      await server.call(1, "present", { viewId: "standby" });
      await page.setViewportSize(viewport);
      await page.goto(`${server.urls[0]!}&q=${encodeURIComponent("Courierdesk checkout")}`);
      const file = results(page).getByRole("button", { name: "Checkout", exact: true });
      await expect(file).toHaveCount(1);
      await file.focus();
      await page.keyboard.press("Enter");
      const courier = page.locator('.react-flow__node[data-id="a"]');
      await expect(courier).toContainText("Courier");
      await expect(page.locator(".primary-document-identity h1")).toHaveText("Checkout");
      await page.getByRole("button", { name: "Select mode", exact: true }).click();
      await courier.click();
      await expect
        .poll(async () =>
          ((await server.call(1, "getContext")).selection?.nodes ?? []).map((node: { id: string }) => node.id),
        )
        .toEqual(["a"]);
      expect((await server.call(0, "getContext")).selection).toBeNull();
      expect((await server.call(1, "getContext")).presentation.viewId).toBe("standby");
      expect((await server.call(1, "getContext")).selection.viewId).toBe("checkout");
    } finally {
      await server.stop();
    }
  });
}

test("the filters and sort are the address: a filtered view is a link, and an explicit change adds an entry", async ({
  page,
}) => {
  const server = await fixture();
  try {
    const courier = slugOf(server.urls[1]!);
    await page.goto(`${server.urls[0]!}&q=checkout&project=${courier}&kind=diagram`);
    await expect(rows(page)).toHaveCount(1);
    await expect(results(page).getByRole("button", { name: "Checkout", exact: true })).toBeVisible();
    const projectScope = page.getByRole("button", { name: "Clear project filter", exact: true });
    await expect(projectScope).toContainText("Courierdesk");
    // A filter to another project is this page's search: the page stays on its own project's address.
    expect(new URL(page.url()).pathname).toBe(`/projects/${slugOf(server.urls[0]!)}/`);
    expect(new URL(page.url()).searchParams.get("project")).toBe(courier);
    await filters(page).click();
    const dialog = page.getByRole("dialog", { name: "Project Filters" });
    await expect(dialog.getByRole("checkbox", { name: /Courierdesk/ })).toHaveCount(0);
    await expect(dialog.getByRole("checkbox", { name: /Diagrams/ })).toBeChecked();
    const length = await page.evaluate(() => history.length);
    const sort = dialog.getByRole("combobox", { name: "Sort by" });
    await sort.selectOption("name:desc");
    expect(searchOf(page.url())?.sort).toEqual({ key: "name", dir: "desc" });
    expect(await page.evaluate(() => history.length)).toBe(length + 1);
    await dialog.getByRole("button", { name: "Close filters" }).click();

    await projectScope.click();
    await expect(projectScope).toHaveCount(0);
    await expect(rows(page)).toHaveCount(2);
    await expect(titles(page)).toHaveText(["Checkout", "Checkout"]);
    expect(searchOf(page.url())).toMatchObject({
      projects: [],
      query: "checkout",
      kinds: ["diagram"],
      sort: { key: "name", dir: "desc" },
    });
    await expect(searchBox(page)).toHaveValue("checkout");

    await searchBox(page).fill("");
    await searchBox(page).press("Enter");
    await expect(rows(page)).toHaveCount(4);
    await filters(page).click();
    await dialog.getByRole("checkbox", { name: /Diagrams/ }).uncheck();
    await dialog.getByRole("button", { name: "Close filters", exact: true }).click();
    await expect(rows(page)).toHaveCount(6);
    expect(searchOf(page.url())?.kinds).toEqual([]);
    // Created says where its date came from.
    await expect(results(page).locator("time[title^='Created ']").first()).toHaveAttribute(
      "title",
      /^Created .*from (the file system's creation time|Git: the commit that first added the file)$/,
    );
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([]);
  } finally {
    await server.stop();
  }
});

test("Recent lists the files opened in any project, newest first, and opens one in its project", async ({ page }) => {
  const server = await fixture();
  try {
    await page.goto(`${server.urls[1]!}&note=notes/operations.md`);
    await expect(page.getByRole("article", { name: "Reading Operations" })).toBeVisible();
    await page.goto(`${server.urls[0]!}&view=checkout`);
    await expect(page.locator(".primary-document-identity h1")).toHaveText("Checkout");
    await revealProjects(page);
    const recent = page.getByRole("navigation", { name: "Recent" }).getByRole("button");
    await expect(recent.nth(0)).toHaveAttribute("aria-current", "page");
    await expect(recent.nth(0)).toContainText("Checkout");
    await expect(recent.nth(1).locator(".primary-place-name")).toHaveText("Operations");
    await expect(recent.nth(1)).toHaveText("Operations, note");
    await expect(recent.nth(1)).toHaveAccessibleName("Operations, note, Courierdesk");
    await expect(recent.nth(1)).toHaveAttribute("title", "notes/operations.md · Courierdesk");
    await recent.nth(1).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe(`${projectPath(server.urls[1]!)}notes/operations.md`);
    await expect(page.getByRole("article", { name: "Reading Operations" })).toContainText("Quasar parcel pickup");
  } finally {
    await server.stop();
  }
});
