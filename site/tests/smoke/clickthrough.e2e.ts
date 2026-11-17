import { resolve } from "node:path";
import { type ConsoleMessage, expect, type Page, test } from "@playwright/test";
import { type StaticServer, serveStatic } from "../serve-static.ts";

// The built site as a person uses it: every internal link CLICKED (so VitePress's client router handles it, as it
// does for a reader), the theme switch, the landing film's Pause and Play, and the Playground's Play. A direct page load does not
// exercise the router: on 2026-11-14 every page loaded fine while "Open Playground" led to VitePress's 404.
// Run after docs:build.
const root = resolve(process.env.ARCHER_DOCS_DIST ?? "site/.vitepress/dist");
const base = process.env.ARCHER_DOCS_BASE ?? "/archer/";
const FILE = /\.(txt|sh|svg|png|webp|md|json)$/u;
let server: StaticServer;
let origin: string;
test.beforeAll(async () => {
  server = await serveStatic(root, base);
  origin = server.origin;
});
test.afterAll(() => server.close());

/** Collects every 4xx/5xx response, page error and console error. */
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 400) problems.push(`${response.status()} ${response.url()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror ${error.message}`));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") problems.push(`console ${message.text()}`);
  });
  return problems;
}

const isApp = (path: string) => /\/playground\/app\//u.test(path);
const UNKNOWN = "Cannot tell what Archer is showing.";
/** A heading's text without VitePress's anchor (a trailing zero-width space). */
const heading = (text: string | null) => (text ?? "").replace(/[\s​]+$/u, "");

/** A link and the pages that have it: one for a content link; every page for the chrome's (any may show it). */
type Link = { readonly key: string; readonly from: string[] };
type Crawl = { readonly titles: Map<string, string>; readonly links: Link[] };

/**
 * Every docs page from the landing: its own heading, and each same-site link on it (path, query and a hash into
 * another page). A link in a page's own content counts once per page that has it; the chrome's links (nav,
 * sidebar, footer), repeated on every page, once.
 */
async function crawl(page: Page): Promise<Crawl> {
  const titles = new Map<string, string>();
  const links: Link[] = [];
  const chrome = new Map<string, Link>();
  const queue = [base];
  while (queue.length) {
    const path = queue.shift() as string;
    if (titles.has(path)) continue;
    await page.goto(origin + path);
    titles.set(path, heading(await page.locator("h1").first().textContent()));
    const found = await page
      .locator("a[href]")
      .evaluateAll((anchors) =>
        anchors.map((a) => ({ href: (a as HTMLAnchorElement).href, content: a.closest(".vp-doc") !== null })),
      );
    for (const { href, content } of found) {
      const url = new URL(href);
      if (url.origin !== origin || !url.pathname.startsWith(base) || FILE.test(url.pathname)) continue;
      if (url.pathname === path) continue; // an anchor on this page (the skip link, the outline), or itself
      const key = url.pathname + url.search + url.hash;
      if (content) {
        if (!links.some((link) => link.key === key && link.from[0] === path)) links.push({ key, from: [path] });
      } else {
        const known = chrome.get(key);
        if (!known) {
          const link = { key, from: [path] };
          chrome.set(key, link);
          links.push(link);
        } else if (!known.from.includes(path)) known.from.push(path);
      }
      if (!isApp(url.pathname)) queue.push(url.pathname);
    }
  }
  return { titles, links };
}

/** The page reached is the link's own address (the Playground's canonical document form) with its content. */
async function arrived(page: Page, key: string, titles: Map<string, string>, what: string) {
  await page.waitForLoadState("load");
  await expect(page.getByText("PAGE NOT FOUND"), `${what} shows VitePress's 404`).toHaveCount(0);
  const wanted = new URL(key, origin);
  if (isApp(wanted.pathname)) {
    wanted.pathname = wanted.pathname.replace(/\/$/u, "/index.html");
    await expect(page, what).toHaveURL(new RegExp(`^${wanted.href.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
    await expect(page.getByText(UNKNOWN), what).toHaveCount(0);
    await expect(page.locator(".archer-web-shell, .playground").first(), `${what}: the Playground`).toBeVisible();
    return;
  }
  await expect(page, what).toHaveURL(wanted.href);
  const title = titles.get(wanted.pathname);
  expect(title, `${what}: a page the crawl read`).toBeTruthy();
  await expect(page.locator("h1").first(), `${what}: its heading`).toHaveText(
    new RegExp(`^${title!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"),
  );
  if (wanted.hash) {
    const id = decodeURIComponent(wanted.hash.slice(1));
    await expect(page.locator(`[id="${id.replace(/"/gu, '\\"')}"]`), `${what}: its anchor`).toHaveCount(1);
  }
}

test("every internal link on every docs page, clicked, arrives at its own address and content", async ({ page }) => {
  test.setTimeout(480_000);
  const problems = watch(page);
  const { titles, links } = await crawl(page);
  expect(titles.size).toBeGreaterThan(10);
  expect(links.length).toBeGreaterThan(40);
  const unclicked: string[] = [];
  for (const link of links) {
    // The first page that shows it (a sidebar group is open only on its own pages).
    let from: string | undefined;
    let index = -1;
    for (const source of link.from) {
      await page.goto(origin + source);
      index = await page.locator("a[href]:visible").evaluateAll(
        (anchors, wanted) =>
          anchors.findIndex((a) => {
            const url = new URL((a as HTMLAnchorElement).href);
            return url.pathname + url.search + url.hash === wanted;
          }),
        link.key,
      );
      if (index !== -1) {
        from = source;
        break;
      }
    }
    // Not silently: a link no page shows at this width is reported (a phone's menu is the keyboard journey's).
    if (from === undefined) {
      unclicked.push(`${link.key} on ${link.from.join(", ")}`);
      continue;
    }
    const visible = page.locator("a[href]:visible");
    const what = `${link.key} (clicked on ${from})`;
    await visible
      .nth(index)
      .click({ timeout: 10_000 })
      .catch((error: Error) => {
        throw new Error(`clicking ${what}: ${error.message.split("\n")[0]}`);
      });
    await arrived(page, link.key, titles, what);
  }
  expect(unclicked).toEqual([]);
  expect(problems).toEqual([]);
});

test("the theme switch, the film's Pause and Play, and the Playground's Play work", async ({ page }) => {
  const problems = watch(page);
  await page.goto(origin + base);
  const dark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
  const before = await dark();
  await page.locator(".VPNavBar .VPSwitchAppearance").first().click();
  await expect.poll(dark).toBe(!before);

  await page.locator(".film").getByRole("button", { name: "Pause" }).click();
  await expect(page.locator(".film").getByRole("button", { name: "Play" })).toBeVisible();
  await page.locator(".film").getByRole("button", { name: "Play" }).click();
  await expect(page.locator(".film").getByRole("button", { name: "Pause" })).toBeVisible();

  await page.getByRole("link", { name: "Try the playground" }).click();
  // The app opens on its first diagram, which it names in the address.
  await expect(page).toHaveURL(new RegExp(`^${origin}${base}playground/app/index\\.html\\?route=`, "u"));
  await expect(page.locator(".react-flow__node").first(), "Try the playground draws").toBeVisible();
  const play = page.getByRole("button", { name: "Play", exact: true });
  if (await play.count()) {
    const step = page.getByRole("slider", { name: "Step" }).first();
    const at = await step.inputValue();
    await play.first().click();
    await expect(step).not.toHaveValue(at, { timeout: 15_000 });
  }
  expect(problems).toEqual([]);
});
