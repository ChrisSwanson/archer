import { resolve } from "node:path";
import { type ConsoleMessage, expect, type Page, test } from "@playwright/test";
import { type StaticServer, serveStatic } from "../serve-static.ts";

// Addresses a person may hold: folder addresses typed without their slash, retired Examples addresses (and their
// visible fallback link, for a reader whose browser does not follow the refresh). Run after docs:build.
const root = resolve(process.env.ARCHER_DOCS_DIST ?? "site/.vitepress/dist");
const base = process.env.ARCHER_DOCS_BASE ?? "/archer/";
let server: StaticServer;
let origin: string;
test.beforeAll(async () => {
  server = await serveStatic(root, base);
  origin = server.origin;
});
test.afterAll(() => server.close());

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
const UNKNOWN = "Cannot tell what Archer is showing.";
const route = (logical: string) => `route=${encodeURIComponent(logical)}`;

test("the test server keeps the query string when it redirects a folder to its slash, as Pages does", async ({
  request,
}) => {
  const response = await request.get(`${origin}${base}playground/app?${route("/projects/")}`, { maxRedirects: 0 });
  expect(response.status()).toBe(301);
  expect(response.headers().location).toBe(`${base}playground/app/?${route("/projects/")}`);
});

test("folder addresses typed without their slash arrive at the folder's page", async ({ page }) => {
  const problems = watch(page);
  // The Playground's old folder page now forwards into the app itself.
  await page.goto(`${origin}${base}playground`);
  await expect(page).toHaveURL(new RegExp(`^${origin}${base}playground/app/index\\.html(\\?route=.*)?$`, "u"));
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.goto(`${origin}${base}supported-mermaid`);
  await expect(page).toHaveURL(`${origin}${base}supported-mermaid/`);
  await expect(page.locator("h1").first()).toContainText(/Mermaid/u);
  const diagram = route("/projects/rfc-2324-htcpcp/diagrams/coffee-controls.mmd");
  await page.goto(`${origin}${base}playground/app?${diagram}`);
  await expect(page).toHaveURL(`${origin}${base}playground/app/index.html?${diagram}`);
  await expect(page.getByRole("heading", { level: 1, name: "Coffee Controls" })).toBeVisible();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  expect(problems).toEqual([]);
});

test("every retired Examples address's visible link, clicked, opens its place in the Playground", async ({ page }) => {
  test.setTimeout(240_000);
  const problems = watch(page);
  const bridges = (await import("node:fs"))
    .readdirSync(resolve(root, "generated/examples"), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".html") && file.includes("/") && !file.endsWith("notice.html"))
    .map((file) => file.replace(/\.html$/u, ""));
  expect(bridges.length).toBeGreaterThan(20);
  // A reader whose browser does not follow the refresh: the page without it.
  await page.route(/\/generated\/examples\/.+/u, async (handled) => {
    const response = await handled.fetch();
    const body = (await response.text()).replace(/<meta http-equiv="refresh"[^>]*>/u, "");
    await handled.fulfill({ response, body });
  });
  for (const bridge of bridges) {
    const what = `generated/examples/${bridge}`;
    await page.goto(`${origin}${base}${what}`);
    // Without the heading's anchor (a zero-width space VitePress appends).
    const title = ((await page.locator("h1").first().textContent()) ?? "").replace(/[\s\u200b]+$/u, "");
    const link = page.getByRole("link", { name: "Open in Playground", exact: true });
    const href = await link.getAttribute("href");
    expect(href, what).toMatch(new RegExp(`^${base}playground/app/index\\.html\\?route=`, "u"));
    await link.click();
    await expect(page, what).toHaveURL(origin + href);
    await expect(page.getByText(UNKNOWN), what).toHaveCount(0);
    // The place itself: its title on the page (a diagram's or note's heading, a project's name).
    await expect(
      page.getByText(title, { exact: true }).filter({ visible: true }).first(),
      `${what}: ${title}`,
    ).toBeVisible();
  }
  expect(problems).toEqual([]);
});
