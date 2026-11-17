import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type StaticServer, serveStatic } from "../serve-static.ts";

// Everything a person can reach by clicking inside the built Playground leads somewhere with content. The docs
// crawl (clickthrough.e2e.ts) stops at the Playground's door and checks only that the app opens; inside, a link
// could leave the app for the server's 404 (a README's relative link), land on "unavailable", or a rail button
// could retry a service that does not exist, while every request the page made still answered 200 (owner,
// 2026-11-15). Run after docs:build.
const root = resolve(process.env.ARCHER_DOCS_DIST ?? "site/.vitepress/dist");
const base = process.env.ARCHER_DOCS_BASE ?? "/archer/";
const app = `${base}playground/app/index.html`;
let server: StaticServer;
let origin: string;
test.beforeAll(async () => {
  server = await serveStatic(root, base);
  origin = server.origin;
});
test.afterAll(() => server.close());

/** What a dead end says, on any of the app's pages, once it has given up. */
const DEAD =
  /Cannot tell what Archer is showing|is not a registered diagram or note|This document is unavailable|This document address is unavailable|could not be loaded|is unavailable in the example|This example project is unavailable|Retry settings|Settings are unavailable/u;

const routeOf = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};
const appRoute = (logical: string): string => `${app}?route=${encodeURIComponent(logical)}`;

/** The page is the app's document, showing something real, with nothing saying it could not. */
async function landed(page: Page, what: string): Promise<void> {
  await page.waitForLoadState("load");
  expect(new URL(page.url()).pathname, `${what}: still the Playground's document`).toBe(app);
  // A drawing (a graph, a sequence or a journey), a note or document with words in it, or a listing of files.
  const content = page
    .locator(
      '.react-flow__node, [aria-label="Sequence diagram canvas"], .archer-journey, .primary-note-reader .archer-note-body > *, .archer-folder-tree-file-row',
    )
    .first();
  await expect(content, `${what}: shows content`).toBeVisible({ timeout: 15_000 });
  // A failure can arrive after the content: a link's catalog answer, a document's own request.
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(DEAD), `${what}: says it could not`).toHaveCount(0);
}

async function open(page: Page, route: string): Promise<void> {
  await page.goto(`${origin}${route}`);
  await landed(page, decodeURIComponent(route));
}

test("every file, link and folder in the Playground, clicked, shows its content", async ({ page }) => {
  test.setTimeout(900_000);
  const failures: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });
  page.on("pageerror", (error) => failures.push(`pageerror ${error.message}`));

  // Every file the overview lists, opened from its row.
  const overview = appRoute("/projects/");
  await open(page, overview);
  const rows = () => page.locator(".archer-folder-tree-file-row [data-tree-primary]");
  const count = await rows().count();
  expect(count, "the overview lists every example file").toBeGreaterThan(30);
  const files: string[] = [];
  for (let index = 0; index < count; index += 1) {
    await open(page, overview);
    const row = rows().nth(index);
    const name = (await row.textContent())?.trim() ?? `row ${index}`;
    await row.click();
    await expect(page, `${name} opens its own address`).not.toHaveURL(`${origin}${overview}`);
    await landed(page, `the overview's ${name}`);
    files.push(routeOf(page.url()));
  }

  // The places beside the files: each project and its folders.
  await open(page, overview);
  const places = (
    await page
      .locator(".playground-workspace main a[href]")
      .evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).href))
  ).map(routeOf);
  expect(places.length, "the overview links each project and folder").toBeGreaterThan(5);

  // Every link on every page reached, clicked where it is.
  const clicked = new Set<string>();
  for (const from of new Set([...places, ...files])) {
    await open(page, from);
    const hrefs = await page
      .locator(".playground-workspace a[href]:visible")
      .evaluateAll((anchors) =>
        anchors
          .map((a) => a.getAttribute("href") ?? "")
          .filter((href) => href !== "" && !href.startsWith("#") && !/^[a-z][a-z\d+.-]*:/iu.test(href)),
      );
    for (const href of new Set(hrefs)) {
      const key = `${from} ${href}`;
      if (clicked.has(key)) continue;
      clicked.add(key);
      await open(page, from);
      const link = page.locator(`.playground-workspace a[href="${href.replaceAll('"', '\\"')}"]:visible`).first();
      await link.scrollIntoViewIfNeeded();
      await link.click();
      // Every link here leads elsewhere (anchors are not followed): one that leaves the page where it was did nothing.
      await expect(page, `${href} clicked on ${decodeURIComponent(from)} leaves it`).not.toHaveURL(`${origin}${from}`);
      await landed(page, `${href} clicked on ${decodeURIComponent(from)}`);
    }
  }
  expect(clicked.size, "the pages hold links to follow").toBeGreaterThan(40);
  expect(failures).toEqual([]);
});

test("the breadcrumb and the settings gear lead somewhere from every kind of page", async ({ page }) => {
  test.setTimeout(180_000);
  const diagram = appRoute("/projects/archer-tour/diagrams/deployment.mmd");
  for (const name of ["Projects", "Archer Tour", "diagrams"]) {
    await open(page, diagram);
    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("button", { name, exact: true }).click();
    await landed(page, `the breadcrumb's ${name}`);
  }
  // The gear is on every page kind, and opens settings with something in them.
  for (const route of [
    appRoute("/projects/"),
    appRoute("/projects/archer-tour/"),
    diagram,
    appRoute("/projects/archer-tour/notes/what-is-archer.md"),
    appRoute("/projects/rfc-1149-ipoac/README.md"),
  ]) {
    await open(page, route);
    await page.getByRole("button", { name: "Archer settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Archer Settings" });
    await expect(dialog, `settings from ${route}`).toBeVisible();
    await expect(dialog.getByRole("listitem", { name: "Listen address" }), `settings from ${route}`).toBeVisible();
    await expect(page.getByText(DEAD)).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close settings" }).click();
    await expect(dialog).toHaveCount(0);
  }
});

// Named links whose destination is known, followed to it: the address the page reaches and words only that
// destination holds. (A link that does nothing, or a failure that arrives after the click, cannot pass these.)
const DESTINATIONS = [
  {
    from: "/projects/rfc-1149-ipoac/notes/reading-guide.md",
    link: "the project notice",
    to: "/projects/rfc-1149-ipoac/NOTICE.md",
    shows: "IP over Avian Carriers example notices",
  },
  {
    from: "/projects/rfc-2324-htcpcp/notes/reading-guide.md",
    link: "distribution notice",
    to: "/projects/rfc-2324-htcpcp/NOTICE.md",
    shows: "RFC 2324 Example: Distribution Notice",
  },
  {
    from: "/projects/rfc-1149-ipoac/README.md",
    link: "NOTICE.md",
    to: "/projects/rfc-1149-ipoac/NOTICE.md",
    shows: "IP over Avian Carriers example notices",
  },
] as const;

for (const { from, link, to, shows } of DESTINATIONS)
  test(`${link} on ${from} opens ${to}`, async ({ page }) => {
    await open(page, appRoute(from));
    const anchor = page.locator(".playground-workspace").getByRole("link", { name: link, exact: true }).first();
    await anchor.scrollIntoViewIfNeeded();
    await anchor.click();
    await expect(page).toHaveURL(`${origin}${appRoute(to)}`, { timeout: 15_000 });
    await expect(page.getByText(shows, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(DEAD)).toHaveCount(0);
  });
