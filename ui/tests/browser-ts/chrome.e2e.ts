import { files as projectFiles, expectCurrentFile } from "./support/primary-navigation";
import { revealProjects } from "./support/sidebar";
/**
 * The page's chrome in a real browser against the TypeScript service: the
 * sidebar and its phone drawer, the project and search pages' galleries, the
 * type ramp and its face, the cheat sheet, and the phone bar -- at 1440x900
 * and at 390x844, the two windows the second design review was read at.
 *
 * jsdom proves the switcher's keys and names (`diagram-switcher.test.tsx`);
 * only a browser can say whether a title is clipped, whether a fade is drawn
 * where a tab is cut, whether the face is the one the stylesheet names, and
 * whether a 200% root really makes the chrome bigger.
 */
import AxeBuilder from "@axe-core/playwright";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";
import { sharedTsProject } from "./support/shared-service";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = testPage();
const FIXTURES = resolve(HERE, "../../../ts/test/fixtures");
/** Where the screenshots a reviewer reads are left, when the run names one. */
const SHOTS = process.env.ARCHER_CHROME_SHOTS;

/** Seven diagrams with the demo's titles, long enough that a 1440 bar cannot hold every tab. */
const VIEWS = [
  { id: "compile", title: "Compile pipeline", kind: "freeform", type: "flowchart" },
  { id: "auth", title: "Auth flow", kind: "sequence", type: "sequence" },
  { id: "orders", title: "Order lifecycle", kind: "state", type: "state" },
  { id: "data", title: "Data model", kind: "entity-relationship", type: "er" },
  { id: "shop", title: "Web shop containers", kind: "c4", type: "c4" },
  { id: "infra", title: "Infrastructure and deployment topology", kind: "architecture", type: "architecture" },
  { id: "checkout", title: "Checkout journey for a returning customer", kind: "journey", type: "journey" },
] as const;

function files(): Record<string, string> {
  const manifest = VIEWS.map(
    (view) =>
      `[[views]]\nid = "${view.id}"\nkind = "${view.kind}"\ntitle = "${view.title}"\nsource = ".archer/${view.id}.mmd"\n`,
  ).join("\n");
  const sources = Object.fromEntries(
    VIEWS.map((view) => [`.archer/${view.id}.mmd`, readFileSync(resolve(FIXTURES, view.type, "widened.mmd"), "utf8")]),
  );
  return { "archer.toml": `version = 1\n\n${manifest}`, ...sources };
}

let project: TsProject | undefined;
let problems: string[];

test.beforeAll(() => {
  if (!existsSync(PAGE)) throw new Error(`no page at ${PAGE}; run: npm --workspace ui run build`);
  if (SHOTS !== undefined) mkdirSync(SHOTS, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`uncaught: ${error.message}`));
});

test.afterEach(async ({ page }) => {
  // Disconnect the client before shutting down its fixture server; retain every
  // console error observed during the actual interaction and page cleanup.
  await page.close();
  await project?.stop();
  project = undefined;
  expect(problems, "the page logged errors or warnings").toEqual([]);
});

type Options = { width?: number; height?: number; scheme?: "light" | "dark"; design?: "current"; touch?: boolean };

const PHONE = { width: 390, height: 844, touch: true } as const;

/** The project open with `viewId` presented by the agent and drawn. */
async function open(page: Page, viewId: string, options: Options = {}): Promise<void> {
  project = await sharedTsProject({ files: files() });
  await page.setViewportSize({ width: options.width ?? 1440, height: options.height ?? 900 });
  await page.emulateMedia({ colorScheme: options.scheme ?? "light" });
  // Present before the page opens: on a loaded CI host one present (it reloads
  // the project) held the service for 10 s, and the page's first reads, sent
  // during it, hit their 10 s deadline and logged errors.
  await project.present(viewId);
  await page.goto(project.url);
  await expect(page.locator(".archer-stage")).toBeVisible();
  await expect(page.locator(".react-flow__node, .archer-seq-participant, .archer-journey-task").first()).toBeVisible();
}

const menu = (page: Page): Locator => page.getByRole("button", { name: "Menu", exact: true });
const gallery = (page: Page): Locator => page.getByRole("region", { name: "Project documents", exact: true });
const searchBox = (page: Page): Locator => page.getByRole("searchbox", { name: "Search projects and files" });

/** Whether an element's text overflows its own box: what "clipped" means for a label. */
async function clipped(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await locator.boundingBox();
  expect(found, "drawn").not.toBeNull();
  return found!;
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS !== undefined) await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

async function violations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.passes.length).toBeGreaterThan(0);
  return results.violations.flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(" ")}`));
}

test.describe("at 1440x900", () => {
  test("the project page lists every diagram with its full title and type, and the search page finds and opens one", async ({
    page,
  }) => {
    await open(page, "shop");
    await expect(
      page
        .getByRole("navigation", { name: "Breadcrumb" })
        .locator("button, [aria-current]")
        .filter({ hasNotText: /^Projects$/ })
        .first(),
    ).toHaveText(/^archer-ui-proj-/);
    const files = await projectFiles(page);
    const titles = files.locator(".archer-folder-tree-open");
    await expect(titles).toHaveCount(VIEWS.length);
    for (const view of VIEWS) {
      const title = files.getByRole("button", { name: view.title, exact: true });
      await expect(title).toBeVisible();
      expect(await clipped(title), `${view.title} is shown whole`).toBe(false);
    }
    await shot(page, "1440-project-page");

    await page.keyboard.press("/");
    await expect(searchBox(page)).toBeFocused();
    await searchBox(page).fill("checkout ret");
    await searchBox(page).press("Enter");
    const results = gallery(page).locator(".archer-folder-tree-open");
    await expect(results).toHaveCount(1);
    await results.first().click();
    await expect(searchBox(page)).toBeHidden();
    await expectCurrentFile(page, { name: "Checkout journey for a returning customer" });
  });

  test("[ and ] step through the diagrams and G opens the search page", async ({ page }) => {
    await open(page, "shop");
    const stage = page.locator(".archer-stage");
    const stageBounds = await stage.boundingBox();
    await stage.click({ position: { x: stageBounds!.width / 2, y: 12 } });
    await page.keyboard.press("]");
    await expectCurrentFile(page, { name: "Infrastructure and deployment topology" });
    await page.locator(".archer-stage").click({ position: { x: stageBounds!.width / 2, y: 12 } });
    await page.keyboard.press("[");
    await page.keyboard.press("[");
    await expectCurrentFile(page, { name: "Data model" });
    await page.locator(".archer-stage").click({ position: { x: stageBounds!.width / 2, y: 12 } });
    await page.keyboard.press("g");
    await expect(searchBox(page)).toBeFocused();
  });

  test("the sidebar holds the projects and recent files without scrolling, and nothing overflows the page", async ({
    page,
  }) => {
    // Five real navigations plus the gallery: ~15s on an idle runner, 44s when two
    // browser jobs share the host. Layout is under test, not speed.
    test.slow();
    await open(page, "infra");
    await projectFiles(page);
    for (const view of VIEWS.slice(0, 5)) {
      await (await projectFiles(page)).getByRole("button", { name: view.title, exact: true }).click();
      await expect(page.locator(".primary-document-identity h1")).toHaveText(view.title);
    }
    await revealProjects(page);
    const recent = page.getByRole("navigation", { name: "Recent" }).getByRole("button");
    await expect(recent).toHaveCount(5);
    const recentRows = await recent.evaluateAll((items) =>
      items.map((item) => {
        const name = item.querySelector<HTMLElement>(".primary-place-name");
        return {
          text: item.textContent ?? "recent",
          clientWidth: name?.clientWidth ?? 0,
          scrollWidth: name?.scrollWidth ?? 0,
        };
      }),
    );
    expect(recentRows).toHaveLength(5);
    for (const row of recentRows) {
      expect(row.clientWidth, `${row.text} has readable geometry`).toBeGreaterThan(0);
      expect(row.scrollWidth > row.clientWidth + 1, row.text).toBe(false);
    }
    // Short enough not to scroll: the rail's sections fit its height.
    const sections = page.locator(".primary-sections");
    expect(await sections.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await shot(page, "1440-sidebar");
    await page.keyboard.press("Escape");
    await projectFiles(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await page.keyboard.press("/");
    await expect(gallery(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    // The last column is present on every row and fits the page's width.
    const created = gallery(page).locator('[data-browser-row] [data-column="created"]');
    await expect(created).toHaveCount(VIEWS.length);
    for (const field of await created.all()) {
      const bounds = await box(field);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(1440);
    }
  });

  test("the Current design draws in the embedded Fira Sans, on the ramp", async ({ page }) => {
    await open(page, "shop");
    await page.evaluate(() => document.fonts.ready);
    const fira = await page.evaluate(() =>
      [...document.fonts].filter((face) => face.family.replace(/"/g, "") === "Fira Sans").map((face) => face.status),
    );
    expect(fira, "Fira Sans is declared, and loaded because the page uses it").toContain("loaded");
    await projectFiles(page);
    const sizes = await page.evaluate(() => {
      const size = (selector: string): string => getComputedStyle(document.querySelector(selector)!).fontSize;
      return {
        title: size(".archer-folder-tree-open"),
        path: size(".archer-folder-tree-file"),
        mark: size(".primary-brand span"),
      };
    });
    expect(sizes).toEqual({ title: "12px", path: "14px", mark: "14px" });
  });

  test("a 200% root text size doubles the chrome", async ({ page }) => {
    await open(page, "shop");
    await projectFiles(page);
    const measure = () =>
      page.evaluate(() => ({
        bar: document.querySelector(".primary-document-bar")!.getBoundingClientRect().height,
        tab: Number.parseFloat(getComputedStyle(document.querySelector(".archer-folder-tree-open")!).fontSize),
        panel: Number.parseFloat(getComputedStyle(document.querySelector(".primary-navigation")!).fontSize),
      }));
    const before = await measure();
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "200%";
    });
    const after = await measure();
    expect(after.tab).toBeCloseTo(before.tab * 2, 1);
    expect(after.panel).toBeCloseTo(before.panel * 2, 1);
    // Not exactly double: the hairline rule under the bar stays a hairline.
    expect(after.bar).toBeGreaterThanOrEqual(before.bar * 1.9);
    await shot(page, "1440-root-200");
  });

  test("the cheat sheet has a Commenting section, in two wide columns", async ({ page }) => {
    await open(page, "shop");
    await page.keyboard.press("?");
    const sheet = page.getByRole("dialog", { name: "Keyboard & Pointer" });
    await expect(sheet.getByRole("heading", { name: "Commenting" })).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Diagrams" })).toBeVisible();
    await expect
      .poll(
        () =>
          sheet
            .locator(".help-cols section")
            .evaluateAll((sections) => [
              ...new Set(sections.map((section) => Math.round(section.getBoundingClientRect().left))),
            ]),
        { message: "the sections flow down two columns" },
      )
      .toHaveLength(2);
    // Every meaning has room: none wraps past three lines.
    await expect
      .poll(() =>
        sheet
          .locator("dd")
          .evaluateAll((dds) =>
            Math.max(
              ...dds.map(
                (dd) => dd.getBoundingClientRect().height / Number.parseFloat(getComputedStyle(dd).lineHeight || "19"),
              ),
            ),
          ),
      )
      .toBeLessThanOrEqual(3.2);
    await shot(page, "1440-help");
  });
});

test.describe("at 390x844", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("the sidebar is a drawer, the project page a list, and the diagram on screen is named in full", async ({
    page,
  }) => {
    await open(page, "shop", PHONE);
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(page.locator(".primary-document-identity h1")).toHaveText("Web shop containers");
    // The drawer is closed: nothing of it is on screen, and the page starts at the left edge.
    await expect(page.getByRole("button", { name: "Archer contents" })).toBeHidden();
    expect((await box(page.locator(".primary-document-bar"))).x).toBe(0);
    await shot(page, "390-bar");

    await menu(page).tap();
    await expect(page.getByRole("button", { name: "Archer contents" })).toBeFocused();
    // It slides in: measured once it has arrived.
    await expect.poll(async () => (await box(page.locator(".primary-rail"))).x).toBe(0);
    expect((await box(page.locator(".primary-rail"))).width).toBeLessThan(390);
    await page.getByRole("button", { name: "Archer contents" }).tap();
    const files = gallery(page);
    await expect(files).toBeVisible();
    await expect(page.getByRole("button", { name: "Archer contents" })).toBeHidden();
    for (const view of VIEWS) {
      const title = files.getByRole("button", { name: view.title, exact: true });
      expect(await clipped(title), `${view.title} is shown whole`).toBe(false);
      const bounds = await box(title);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await shot(page, "390-project-page");
    await files.getByRole("button", { name: "Checkout journey for a returning customer" }).tap();
    await expect(page.locator(".primary-document-identity h1")).toContainText(
      "Checkout journey for a returning customer",
    );
  });

  test("the search page is a list with its filters behind one button, and nothing scrolls sideways", async ({
    page,
  }) => {
    await open(page, "shop", PHONE);
    await page.goto(`${project!.url}&q=`);
    await expect(gallery(page)).toBeVisible();
    const dialog = page.getByRole("dialog", { name: "Project Filters" });
    await expect(dialog).toHaveCount(0);
    const toggle = page.getByRole("button", { name: /^Filters/ });
    expect((await box(toggle)).height).toBeGreaterThanOrEqual(44);
    await toggle.tap();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("checkbox", { name: /Journey/ }).tap();
    await expect(dialog.getByRole("button", { name: "Close filters", exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.getAll("type")).toEqual(["journey"]);
    for (const control of await dialog.locator("label.archer-search-choice, select").all())
      expect((await box(control)).height, "a filter a thumb presses").toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await dialog.getByRole("button", { name: "Close filters", exact: true }).tap();
    await expect(dialog).toHaveCount(0);
    await expect(gallery(page).locator(".archer-folder-tree-open")).toHaveCount(1);
    await shot(page, "390-search");
  });

  test("every control a thumb presses in the bar is at least 44px", async ({ page }) => {
    await open(page, "shop", PHONE);
    const controls = {
      menu: menu(page),
      panel: page.locator(".archer-review-toggle"),
      theme: page.locator(".archer-theme-toggle"),
    };
    for (const [name, control] of Object.entries(controls)) {
      const found = await box(control);
      expect(found.height, `${name} height`).toBeGreaterThanOrEqual(44);
      expect(found.width, `${name} width`).toBeGreaterThanOrEqual(44);
    }
    // Apart: a thumb aimed at one does not land on its neighbour.
    const row = [await box(controls.panel), await box(controls.theme)];
    for (let at = 1; at < row.length; at += 1) {
      expect(row[at]!.x - (row[at - 1]!.x + row[at - 1]!.width), `gap before control ${at}`).toBeGreaterThanOrEqual(6);
    }
    // Inside the window: nothing in the bar is pushed off the right edge.
    for (const [name, control] of Object.entries(controls)) {
      const found = await box(control);
      expect(found.x + found.width, `${name} is on screen`).toBeLessThanOrEqual(390);
    }
  });

  test("the panel's hint names no key and no right-click on a touch screen", async ({ page }) => {
    await open(page, "shop", PHONE);
    await page.locator(".archer-review-toggle").tap();
    const hint = page.locator(".primary-inbox-explanation");
    await expect(hint).toBeVisible();
    await expect(hint).not.toContainText("press C");
    await expect(hint).not.toContainText("right-click");
  });
});

test.describe("axe", () => {
  // One design since phase 3b; the row keeps its name.
  for (const design of ["current"] as const) {
    for (const scheme of ["light", "dark"] as const) {
      test(`${design}, ${scheme}: the bar, the sidebar and the sheet are accessible`, async ({ page }) => {
        await open(page, "shop", { design, scheme });
        expect(await violations(page), "1440").toEqual([]);
        await revealProjects(page);
        expect(await violations(page), "1440, projects open").toEqual([]);
        await page.keyboard.press("Escape");
        await page.keyboard.press("?");
        expect(await violations(page), "1440, sheet open").toEqual([]);
      });

      test(`${design}, ${scheme}: the project and search pages are accessible`, async ({ page }) => {
        await open(page, "shop", { design, scheme });
        await page.keyboard.press("?");
        const sheet = page.getByRole("dialog", { name: "Keyboard & Pointer" });
        await expect(sheet).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(sheet).toBeHidden();
        await projectFiles(page);
        expect(await violations(page), "1440, project page").toEqual([]);
        await page.goto(`${project!.url}&q=a&sort=name`);
        await expect(gallery(page)).toBeVisible();
        expect(await violations(page), "1440, search page").toEqual([]);
      });

      test(`${design}, ${scheme}: the search, filters, project and drawer are accessible on a phone`, async ({
        page,
      }) => {
        await open(page, "shop", { design, scheme });
        await page.goto(`${project!.url}&q=a&sort=name`);
        await expect(gallery(page)).toBeVisible();
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.getByRole("tablist", { name: "Diagrams" })).toHaveCount(0);
        expect(await violations(page), "390, search page").toEqual([]);
        await page.getByRole("button", { name: /^Filters/ }).click();
        expect(await violations(page), "390, search filters").toEqual([]);
        await page.goto(`${project!.url}&overview=1`);
        // The legacy overview link opens the project page: the project browser at its folders.
        await expect(page.getByRole("region", { name: "Project documents", exact: true })).toBeVisible();
        expect(await violations(page), "390, project page").toEqual([]);
        await revealProjects(page);
        expect(await violations(page), "390, drawer open").toEqual([]);
        if (design === "current") await shot(page, `390-${scheme}-drawer`);
      });
    }
  }
});
