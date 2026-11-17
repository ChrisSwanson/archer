import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type StaticServer, serveStatic } from "../serve-static.ts";

// Every docs page warms the Playground's HTTP cache once it is idle, so a click into it draws from cache.
// Served with GitHub Pages' caching headers (max-age=600), as the published site is. Run after docs:build.
const root = resolve(process.env.ARCHER_DOCS_DIST ?? "site/.vitepress/dist");
const base = process.env.ARCHER_DOCS_BASE ?? "/archer/";
let server: StaticServer;
let origin: string;
let warm: string[];
test.beforeAll(async () => {
  server = await serveStatic(root, base, { pagesCache: true });
  origin = server.origin;
  warm = (JSON.parse(await readFile(join(root, "playground/app/warm.json"), "utf8")) as { files: string[] }).files;
});
test.afterAll(() => server.close());

const prefetches = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLLinkElement>('link[rel="prefetch"]')]
      .map((link) => new URL(link.href).pathname)
      .filter((path) => path.includes("/playground/app/")),
  );

for (const path of ["", "install"])
  test(`/${path} prefetches the Playground's first view once idle, and only once per session`, async ({ page }) => {
    const fetched = new Set<string>();
    page.on("request", (request) => {
      if (request.headers()["sec-purpose"]?.includes("prefetch")) fetched.add(new URL(request.url()).pathname);
    });
    await page.goto(`${origin}${base}${path}`);
    const expected = warm.map((file) => `${base}playground/app/${file}`);
    await expect.poll(() => prefetches(page), { timeout: 15_000 }).toEqual(expected);
    await expect.poll(() => expected.filter((file) => !fetched.has(file)), { timeout: 20_000 }).toEqual([]);
    // Another page of the same visit, through the client router: no second warm-up.
    await page.locator(`a[href="${base}usage"]:visible`).first().click();
    await expect(page).toHaveURL(/usage$/u);
    expect(await prefetches(page)).toEqual(expected);
  });

test("a reader who asked to save data gets no warm-up", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "connection", { value: { saveData: true, effectiveType: "4g" } }),
  );
  const prefetched: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/playground/app/")) prefetched.push(request.url());
  });
  await page.goto(`${origin}${base}install`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(2_500); // past the idle callback's 5 s ceiling is not needed: idle comes at once here
  expect(await prefetches(page)).toEqual([]);
  expect(prefetched).toEqual([]);
});

test("after a docs visit has warmed it, the Playground draws its first node quickly on a slow link", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  // A modest connection: uncached, this click took 2.4 s to the first node (site/scripts/measure-playground-warm.mts).
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 40,
    downloadThroughput: 20_000_000 / 8,
    uploadThroughput: 20_000_000 / 8,
  });
  await page.goto(`${origin}${base}`);
  await expect.poll(() => prefetches(page), { timeout: 15_000 }).toHaveLength(warm.length);
  await page.waitForLoadState("networkidle");
  const route = `${base}playground/app/index.html?route=%2Fprojects%2Farcher-tour%2Fdiagrams%2Fheartbeat.mmd&walkthrough=one-turn&step=5`;
  await page.evaluate((href) => {
    const link = document.createElement("a");
    link.href = href;
    link.id = "warm-check";
    link.textContent = "Playground";
    link.style.cssText = "position:fixed;top:0;left:0;z-index:99999";
    document.body.append(link);
  }, route);
  const start = Date.now();
  await page.click("#warm-check");
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
  // About 0.3 s measured; generous so a busy machine does not flake, and still well under the cold 2.4 s.
  expect(Date.now() - start).toBeLessThan(1_500);
});
