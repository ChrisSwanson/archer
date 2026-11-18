import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { type StaticServer, serveStatic } from "../serve-static.ts";

// One top bar on every page (owner, 2026-11-18): the landing's blue, with the title, search, nav and theme switch
// in the same place and size on the landing and on every docs page, in both themes, at desktop and phone widths.
const root = resolve(process.env.ARCHER_DOCS_DIST ?? "site/.vitepress/dist");
const base = process.env.ARCHER_DOCS_BASE ?? "/archer/";
let server: StaticServer;
test.beforeAll(async () => {
  server = await serveStatic(root, base);
});
test.afterAll(() => server.close());

const BAR = "rgb(52, 73, 158)"; // #34499e, the landing's stage
const PAGES = ["", "install", "supported-mermaid/flowchart"];
const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
const SCHEMES = ["light", "dark"] as const;

async function prepare(page: Page, scheme: (typeof SCHEMES)[number], size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
  await page.addInitScript((value) => localStorage.setItem("vitepress-theme-appearance", value), scheme);
}

async function visit(page: Page, path: string) {
  await page.goto(`${server.origin}${base}${path}`);
  await page.locator(".VPNavBar").waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/** The bar's painted colour at several points along it, and the box of every visible piece of its chrome. */
const measure = (page: Page) =>
  page.evaluate(() => {
    // VitePress makes the bar's empty space click-through (pointer-events: none); hit-test what is painted there.
    const hit = document.head.appendChild(document.createElement("style"));
    hit.textContent = ".VPNav, .VPNav * { pointer-events: auto !important; }";
    const painted = (x: number, y: number) => {
      for (let at = document.elementFromPoint(x, y); at; at = at.parentElement) {
        const fill = getComputedStyle(at).backgroundColor;
        if (fill !== "transparent" && !/rgba\(.*,\s*0\)$/u.test(fill)) return fill;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const box = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 2) / 2);
    };
    const bar = document.querySelector(".VPNavBar")!;
    const width = innerWidth;
    const fill = [4, 140, Math.round(width / 2), width - 4].map((x) => painted(x, 2));
    hit.remove();
    return {
      fill,
      bar: box(bar),
      title: box(bar.querySelector(".VPNavBarTitle .title")),
      search: box(bar.querySelector(".VPNavBarSearch button")),
      links: [...bar.querySelectorAll(".VPNavBarMenuLink")].map((link) => [link.textContent?.trim(), box(link)]),
      appearance: box(bar.querySelector(".VPNavBarAppearance .VPSwitchAppearance")),
      hamburger: box(bar.querySelector(".VPNavBarHamburger")),
    };
  });

for (const scheme of SCHEMES)
  for (const size of SIZES)
    test(`${size.width}px ${scheme}: the top bar is the same blue, with its chrome in the same place, on the landing and the docs`, async ({
      page,
    }) => {
      await prepare(page, scheme, size);
      const seen: Record<string, Awaited<ReturnType<typeof measure>>> = {};
      for (const path of PAGES) {
        await visit(page, path);
        seen[path || "/"] = await measure(page);
      }
      const landing = seen["/"]!;
      for (const [path, now] of Object.entries(seen)) {
        expect(now.fill, `${path}: the bar is the stage blue end to end`).toEqual(now.fill.map(() => BAR));
        const { fill: _fill, ...geometry } = now;
        const { fill: _landingFill, ...landingGeometry } = landing;
        expect(geometry, `${path}: the bar's chrome sits where the landing's does`).toEqual(landingGeometry);
      }
      expect(landing.title, "the title is drawn").not.toBeNull();
      expect(landing.search, "the search is drawn").not.toBeNull();
    });

test("going landing → docs → landing, the bar keeps its colour, height and chrome in place", async ({ page }) => {
  await prepare(page, "light", { width: 1440, height: 900 });
  await visit(page, "");
  const first = await measure(page);
  await page.locator(".VPNavBar").getByRole("link", { name: "Docs" }).click();
  await expect(page).toHaveURL(new RegExp(`${base}install$`, "u"));
  expect(await measure(page)).toEqual(first);
  await page.locator(".VPNavBar .VPNavBarTitle a").click();
  await expect(page).toHaveURL(new RegExp(`${base}$`, "u"));
  expect(await measure(page)).toEqual(first);
});

test("the landing's bar keeps its blue after the reader scrolls past the stage", async ({ page }) => {
  await prepare(page, "light", { width: 1440, height: 900 });
  await visit(page, "");
  const top = await measure(page);
  await page.evaluate(() => window.scrollTo(0, 1600));
  await page.waitForTimeout(400); // longer than any colour transition on the bar
  const scrolled = await measure(page);
  expect(scrolled.fill).toEqual(top.fill.map(() => BAR));
  expect(scrolled.bar).toEqual(top.bar);
});

/** WCAG contrast of each of the bar's texts against the bar, from computed colours. */
const contrasts = (page: Page) =>
  page.evaluate(() => {
    const channels = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) =>
      [r!, g!, b!]
        .map((c) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
    const over = (fg: number[], bg: number[]) => {
      const alpha = fg[3] ?? 1;
      return [0, 1, 2].map((i) => fg[i]! * alpha + bg[i]! * (1 - alpha));
    };
    const bar = channels(getComputedStyle(document.querySelector(".VPNavBar .content-body")!).backgroundColor);
    const ratio = (colour: string) => {
      const [a, b] = [lum(over(channels(colour), bar)), lum(bar)];
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    const visible = (element: Element) => element.getBoundingClientRect().width > 0;
    const texts = [...document.querySelectorAll(".VPNavBar .VPNavBarTitle .title, .VPNavBar .VPNavBarMenuLink")].filter(
      visible,
    );
    const active = document.querySelector(".VPNavBar .VPNavBarMenuLink.active");
    const activeStyle = active ? getComputedStyle(active) : null;
    return {
      texts: texts.map((element) => [element.textContent?.trim(), ratio(getComputedStyle(element).color)]),
      active: active
        ? {
            ratio: ratio(activeStyle!.color),
            marked:
              activeStyle!.textDecorationLine.includes("underline") ||
              Number(activeStyle!.fontWeight) >
                Number(
                  getComputedStyle(document.querySelector(".VPNavBar .VPNavBarMenuLink:not(.active)")!).fontWeight,
                ),
          }
        : null,
    };
  });

for (const scheme of SCHEMES)
  test(`${scheme}: the bar's title, nav links and active link read at 4.5:1 on the blue, and the active link is marked by more than colour`, async ({
    page,
  }) => {
    await prepare(page, scheme, { width: 1440, height: 900 });
    for (const path of PAGES) {
      await visit(page, path);
      const now = await contrasts(page);
      for (const [text, ratio] of now.texts) expect(ratio, `${path || "/"}: ${text}`).toBeGreaterThanOrEqual(4.5);
      if (path) {
        expect(now.active, `${path}: Docs is the active link`).not.toBeNull();
        expect(now.active!.ratio, `${path}: the active link`).toBeGreaterThanOrEqual(4.5);
        expect(now.active!.marked, `${path}: the active link is underlined or heavier, not only coloured`).toBe(true);
      }
    }
  });

test("a keyboard focus ring in the bar shows at 3:1 against the blue", async ({ page }) => {
  await prepare(page, "light", { width: 1440, height: 900 });
  await visit(page, "install");
  const link = page.locator(".VPNavBar .VPNavBarMenuLink").first();
  await page.locator(".VPNavBar .VPNavBarTitle a").focus();
  for (let tries = 0; tries < 10 && !(await link.evaluate((el) => el === document.activeElement)); tries += 1)
    await page.keyboard.press("Tab");
  const ring = await link.evaluate((element) => {
    const style = getComputedStyle(element);
    return { visible: element.matches(":focus-visible"), colour: style.outlineColor, width: style.outlineWidth };
  });
  expect(ring.visible).toBe(true);
  expect(Number.parseFloat(ring.width)).toBeGreaterThanOrEqual(2);
  const ratio = await page.evaluate(
    ([colour, bar]) => {
      const lum = (value: string) =>
        (value.match(/[\d.]+/g) ?? [])
          .slice(0, 3)
          .map(Number)
          .map((c) => {
            const s = c / 255;
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          })
          .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
      const [a, b] = [lum(colour!), lum(bar!)];
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    },
    [ring.colour, BAR],
  );
  expect(ratio).toBeGreaterThanOrEqual(3);
});

for (const scheme of SCHEMES)
  for (const size of SIZES)
    test(`${size.width}px ${scheme}: docs pages under the bar have no axe violations, and search is named by what it shows`, async ({
      page,
    }) => {
      await prepare(page, scheme, size);
      for (const path of PAGES.filter(Boolean)) {
        await visit(page, path);
        const search = page.locator(".VPNavBarSearch button");
        await expect(search).toHaveAccessibleName(size.width < 768 ? "Search" : /^Search\b.*K$/u);
        expect((await new AxeBuilder({ page }).analyze()).violations, path).toEqual([]);
      }
    });
