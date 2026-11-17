import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type StaticServer, serveStatic } from "../serve-static.ts";

// The docs by keyboard alone, at a desktop and a phone width: search, the phone menu, the sidebar's sections, and a
// lost address back home. Run after docs:build.
const root = resolve(process.env.ARCHER_DOCS_DIST ?? "site/.vitepress/dist");
const base = process.env.ARCHER_DOCS_BASE ?? "/archer/";
let server: StaticServer;
let origin: string;
test.beforeAll(async () => {
  server = await serveStatic(root, base);
  origin = server.origin;
});
test.afterAll(() => server.close());

const heading = (page: Page) => page.locator(".vp-doc h1, h1").first();

/** Tab until the focused element matches, as a person would; fails rather than looping forever. */
async function tabTo(page: Page, matches: (element: Element) => boolean, limit = 60) {
  for (let step = 0; step < limit; step++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(`(${matches.toString()})(document.activeElement)`)) return;
  }
  throw new Error("never reached by Tab");
}

test("search by keyboard opens the result it names, at its section", async ({ page }) => {
  await page.goto(`${origin}${base}install`);
  // The shortcut is the theme's, attached when Vue mounts the app: a key pressed before that does nothing (O301).
  await page.waitForFunction(() =>
    Boolean((document.querySelector("#app") as { __vue_app__?: unknown } | null)?.__vue_app__),
  );
  await page.keyboard.press("ControlOrMeta+k");
  const box = page.getByRole("searchbox");
  await expect(box).toBeFocused();
  await page.keyboard.type("certificate");
  const first = page.getByRole("option").first();
  await expect(first).toHaveAttribute("aria-selected", "true");
  const href = await first.getByRole("link").getAttribute("href");
  expect(href).toMatch(/#/u);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(origin + href);
  await expect(heading(page)).toHaveText(/HTTPS & Browser Trust/u);
  const id = decodeURIComponent(new URL(origin + href).hash.slice(1));
  await expect(page.locator(`[id="${id}"]`)).toBeInViewport();
});

test("a collapsed sidebar section opens and closes by keyboard, and a child page opens from it", async ({ page }) => {
  await page.goto(`${origin}${base}install`);
  const sidebar = page.getByRole("navigation", { name: "Sidebar Navigation" });
  // Supported Mermaid's pages are folded away outside that section.
  const toggle = sidebar.getByRole("button", { name: "toggle section" });
  const child = sidebar.getByRole("link", { name: "Shared rules" });
  await expect(child).toBeHidden();
  await tabTo(page, (element) => element.getAttribute("aria-label") === "toggle section");
  await page.keyboard.press("Enter");
  await expect(child).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(child).toBeHidden();
  await toggle.press("Enter");
  await expect(child).toBeVisible();
  await tabTo(page, (element) => element.textContent?.trim() === "Shared rules");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${origin}${base}supported-mermaid/rules`);
  await expect(heading(page)).toHaveText(/rules/iu);
});

test("on a phone the menu opens by keyboard and takes the reader to its page", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + base);
  const menu = page.getByRole("button", { name: "mobile navigation" });
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await tabTo(page, (element) => element.tagName === "A" && element.textContent?.trim() === "Playground");
  await page.keyboard.press("Enter");
  // The nav's Playground opens the app itself.
  // The app opens on its first diagram, which it names in the address.
  await expect(page).toHaveURL(new RegExp(`^${origin}${base}playground/app/index\\.html\\?route=`, "u"));
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
});

for (const width of [1440, 390])
  test(`a lost address at ${width}px says so, in English, and the way home works by keyboard`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const response = await page.goto(`${origin}${base}no-such-page`);
    expect(response?.status()).toBe(404);
    await expect(page.getByText("PAGE NOT FOUND")).toBeVisible();
    // "Take me home", named "go to home" for assistive technology.
    const home = page.locator(".NotFound").getByRole("link", { name: "go to home" });
    await expect(home).toHaveText("Take me home");
    await home.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(origin + base);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect(page.getByText("PAGE NOT FOUND")).toHaveCount(0);
  });
