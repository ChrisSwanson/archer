// The nested view in a real browser (ADR 0029; plan T8, T10, T11; lab bug round): "+" opens one
// level, "−" closes it, the controls keep their size and tap area at any zoom, frames are drawn
// as ordinary frames, a press never touches the address or history, and the address
// can ask for the full view or for boxes already open.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const SOURCE = readFileSync(resolve(import.meta.dirname, "../../../ts/test/fixtures/c4/nested.mmd"), "utf8");
const VIEWS = '[[views]]\nid = "shop"\nkind = "c4"\ntitle = "Shop"\nsource = ".archer/shop.mmd"\n';
/** Screenshots for the hand-off, when asked for (`NEST_SHOTS=<dir>`). */
const SHOTS = process.env["NEST_SHOTS"];

async function project(extra = ""): Promise<TsProject> {
  return sharedTsProject({
    nestedView: true,
    files: { "archer.toml": `version = 1\n${extra}${VIEWS}`, ".archer/shop.mmd": SOURCE },
  });
}

async function open(page: Page, server: TsProject, query = ""): Promise<void> {
  await server.present("shop");
  // The agent's link already carries a query (?follow&token=…): a destination is added to it, not glued on.
  await page.goto(query === "" ? server.url : server.address(query));
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
}

/** Every press's motion is over: nothing on the canvas is still moving. */
async function settled(page: Page): Promise<void> {
  await expect(page.locator(".archer-nest-moving")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length))
    .toBe(0);
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

test("+ opens one level, − closes it, focus stays on the control, the address never moves", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await project();
  try {
    await open(page, server);
    const before = await page.evaluate(() => ({ href: location.href, length: history.length }));
    const plus = page.getByRole("button", { name: "Open Web shop" });
    await expect(plus).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".archer-nest-closed")).toHaveCount(1);
    // Default pointer mode is the hand: the press must work there.
    await expect(page.locator(".react-flow.archer-pan-hand")).toHaveCount(1);
    await plus.click();
    const minus = page.getByRole("button", { name: "Close Web shop" });
    await expect(minus).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: "Open API" })).toBeVisible();
    await settled(page);
    // Nothing selected by the press.
    await expect(page.locator(".react-flow__node.selected")).toHaveCount(0);
    // Keyboard: Enter on the focused control toggles and keeps focus on the same container's control.
    await page.getByRole("button", { name: "Open API" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Close API" })).toBeFocused();
    await settled(page);
    await page.keyboard.press(" ");
    await expect(page.getByRole("button", { name: "Open API" })).toBeFocused();
    await settled(page);
    await minus.click();
    await expect(page.getByRole("button", { name: "Open Web shop" })).toBeVisible();
    expect(await page.evaluate(() => ({ href: location.href, length: history.length }))).toEqual(before);
  } finally {
    await server.stop();
  }
});

test("the address asks for the full view, or for boxes already open", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await project();
  try {
    await open(page, server, "?zoom=full");
    await expect(page.locator("[data-nest-toggle]")).toHaveCount(0);
    await expect(page.locator(".react-flow__node[data-id='checkout']")).toBeVisible();
    await open(page, server, "?open=api,shop");
    await expect(page.getByRole("button", { name: "Close API" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close Web shop" })).toBeVisible();
    // The switch in the control cluster goes to the full view and back.
    const mode = page.getByRole("button", { name: "Nested view" });
    await expect(mode).toHaveAttribute("aria-pressed", "true");
    await mode.click();
    await expect(page.locator("[data-nest-toggle]")).toHaveCount(0);
    await mode.click();
    await expect(page.getByRole("button", { name: "Close API" })).toBeVisible();
  } finally {
    await server.stop();
  }
});

test("nested_view = false in archer.toml draws the diagram as written", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await project("nested_view = false\n");
  try {
    await open(page, server);
    await expect(page.locator(".react-flow__node[data-id='checkout']")).toBeVisible();
    await expect(page.locator("[data-nest-toggle]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Nested view" })).toHaveCount(0);
  } finally {
    await server.stop();
  }
});

for (const device of [
  { name: "desktop", width: 1440, height: 900, touch: false, hit: 28 },
  { name: "phone", width: 390, height: 844, touch: true, hit: 44 },
] as const) {
  for (const scheme of ["light", "dark"] as const) {
    test(`controls keep their size at any zoom, frames stay ordinary frames: ${device.name}, ${scheme}`, async ({
      browser,
    }: {
      browser: Browser;
    }) => {
      const context = await browser.newContext({
        viewport: { width: device.width, height: device.height },
        hasTouch: device.touch,
        isMobile: device.touch,
        colorScheme: scheme,
      });
      const page = await context.newPage();
      const server = await project();
      try {
        await open(page, server);
        await shot(page, `${device.name}-${scheme}-closed`);
        const plus = page.getByRole("button", { name: "Open Web shop" });
        if (device.touch) await plus.tap();
        else await plus.click();
        await expect(page.getByRole("button", { name: "Open API" })).toBeVisible();
        await settled(page);
        // The press moved the camera: no "Show all" cue left over from the first framing.
        await expect(page.getByRole("button", { name: /Show all$/ })).toHaveCount(0);
        // The opened frame's "−" is on screen, even where the frame is wider than a phone.
        const minus = await page.getByRole("button", { name: "Close Web shop" }).boundingBox();
        expect(minus!.x + minus!.width).toBeLessThanOrEqual(device.width);
        await page.getByRole("button", { name: "Open API" }).click();
        await expect(page.getByRole("button", { name: "Close API" })).toBeVisible();
        await settled(page);
        // A second press inside the open frame keeps the outer frame's "−" on screen as well.
        for (const name of ["Close API", "Close Web shop"]) {
          const at = (await page.getByRole("button", { name }).boundingBox())!;
          expect(at.x, name).toBeGreaterThanOrEqual(0);
          expect(at.x + at.width, name).toBeLessThanOrEqual(device.width);
          expect(at.y, name).toBeGreaterThanOrEqual(0);
        }
        await shot(page, `${device.name}-${scheme}-open`);
        // An emphasised open frame wears the emphasis hue on its border, as any frame does (ADR 0030).
        await server.setEmphasis("shop", [
          { id: "e", groups: [{ id: "g", label: "Ordering", style: "highlight", nodes: ["api"] }] },
        ]);
        await expect(page.locator(".react-flow__node[data-id='api'].archer-emph")).toHaveCount(1);
        await shot(page, `${device.name}-${scheme}-emphasised`);
        // axe on the nested state (plan T15): the controls and the frames pass.
        const axe = await new AxeBuilder({ page }).analyze();
        expect(axe.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`))).toEqual([]);
        // The frames are ordinary frames: the open one's border is the group's own, the emphasised one's the hue.
        const frames = await page.evaluate(() => {
          const resolve = (at: Element, value: string) => {
            const probe = document.createElement("span");
            probe.style.color = value;
            at.append(probe);
            const colour = getComputedStyle(probe).color;
            probe.remove();
            return colour;
          };
          const shop = document.querySelector<HTMLElement>(".react-flow__node[data-id='shop']")!;
          const api = document.querySelector<HTMLElement>(".react-flow__node[data-id='api']")!;
          return {
            shop: getComputedStyle(shop).borderTopColor,
            group: resolve(shop, "var(--group-border)"),
            api: getComputedStyle(api).borderTopColor,
            hue: resolve(api, "var(--emph-hue)"),
          };
        });
        expect(frames.shop).toBe(frames.group);
        expect(frames.api).toBe(frames.hue);
        const measure = () =>
          page.evaluate(() => {
            const zoom = new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a;
            const control = document.querySelector<HTMLElement>("[data-nest-toggle='shop']")!;
            const mark = control.querySelector(".archer-nest-toggle-mark")!.getBoundingClientRect();
            const hit = control.getBoundingClientRect();
            return { zoom, mark: [mark.width, mark.height], hit: [hit.width, hit.height] };
          });
        const near = await measure();
        // Zoom out by hand (the zoom-out control), as far as the controls still show.
        for (let i = 0; i < 2; i++) await page.locator(".react-flow__controls-zoomout").click();
        await expect.poll(async () => (await measure()).zoom).toBeLessThan(near.zoom * 0.75);
        const far = await measure();
        for (const at of [near, far]) {
          expect(at.mark).toEqual([20, 20]);
          expect(at.hit).toEqual([device.hit, device.hit]);
        }
      } finally {
        await server.stop();
        await context.close();
      }
    });
  }
}

test("a closed box's label never runs under its +, which sits the same distance from the top and the right (decided 2026-10-29)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // The box it was seen on: a long title that wrapped under the + at the size a diagram is read at.
  const flow =
    'flowchart TB\n  web[Web app]\n  subgraph backend["Backend (core): API, worker"]\n    api("API (v2)")\n    worker([Worker])\n  end\n  db[(Orders)]\n  web wa@--> api\n  worker wd@--> db\n';
  const server = await sharedTsProject({
    nestedView: true,
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n',
      ".archer/flow.mmd": flow,
    },
  });
  try {
    await server.present("flow");
    await page.goto(server.url);
    await expect(page.locator(".archer-nest-toggle").first()).toBeVisible();
    await page.getByRole("button", { name: "Fit view" }).click();
    for (const zoom of ["fit", "in"] as const) {
      if (zoom === "in") {
        await page.getByRole("button", { name: "Zoom in" }).click();
        await settled(page);
      }
      const report = await page.evaluate(() =>
        [...document.querySelectorAll(".archer-nest-toggle:not(.archer-nest-toggle-open)")].map((toggle) => {
          const mark = toggle.querySelector("svg")!.getBoundingClientRect();
          const box =
            document.querySelector(
              `.react-flow__node[data-id="${CSS.escape(toggle.getAttribute("data-nest-toggle")!)}"]`,
            ) ??
            [...document.querySelectorAll(".react-flow__node")].find((n) => {
              const r = n.getBoundingClientRect();
              return mark.left > r.left && mark.right < r.right + 1 && mark.top > r.top && mark.bottom < r.bottom;
            });
          const r = box!.getBoundingClientRect();
          const under = [...box!.querySelectorAll("span, text, tspan")]
            .filter(
              (t) =>
                t.children.length === 0 && t.textContent!.trim() !== "" && !t.classList.contains("archer-nest-inside"),
            )
            .some((t) => {
              const b = t.getBoundingClientRect();
              return b.right > mark.left && b.left < mark.right && b.bottom > mark.top && b.top < mark.bottom;
            });
          return { under, top: mark.top - r.top, right: r.right - mark.right };
        }),
      );
      expect(report.length).toBeGreaterThan(0);
      for (const control of report) {
        expect(control.under).toBe(false);
        expect(Math.abs(control.top - control.right)).toBeLessThanOrEqual(1);
      }
    }
  } finally {
    await server.stop();
  }
});
