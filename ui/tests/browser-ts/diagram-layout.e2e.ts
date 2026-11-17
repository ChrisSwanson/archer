// The diagram page's layout (decided 2026-10-25; side panel 0.6.4 D5): the toolbar at the far bottom left
// with Source inside it, the Diagram key and the Highlights legend in the side panel on the right (the key
// pops out as a box movable like the chat bubble), Highlights and Walkthroughs both one press away in the
// panel's bar, and the bubble clear of all of them.
// An isolated project; never the live service.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { TsProject } from "../support/ts-service";
import { walkthroughFiles } from "../support/walkthrough-project";
import { sharedTsProject } from "./support/shared-service";

const SHOTS = process.env["LAYOUT_SHOTS"];
const project = (files: Record<string, string> = walkthroughFiles()): Promise<TsProject> => sharedTsProject({ files });
const HIGHLIGHTS = [
  {
    id: "who",
    title: "Who handles what",
    groups: [
      {
        id: "front",
        label: "Storefront",
        description: "Pages the shopper sees.",
        style: "highlight",
        nodes: ["web"],
        edges: [],
      },
      {
        id: "orders",
        label: "Orders",
        description: "Takes and stores orders.",
        style: "highlight",
        nodes: ["api", "db"],
        edges: [],
      },
    ],
  },
];

async function open(page: Page, server: TsProject, view = "containers", node = "api"): Promise<void> {
  await server.present(view);
  await page.goto(server.url);
  await expect(page.locator(`.react-flow__node[data-id='${node}']`)).toBeVisible();
}
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `layout-${name}.png`) });
}
type Box = { x: number; y: number; width: number; height: number };
const box = async (loc: Locator): Promise<Box> => (await loc.boundingBox())!;
const overlap = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const toolbar = (page: Page) => page.locator(".react-flow__controls");
const key = (page: Page) => page.getByRole("region", { name: "Diagram Key", exact: true });
const legend = (page: Page) => page.getByRole("region", { name: "Highlights", exact: true });
const fab = (page: Page) => page.getByRole("button", { name: /^Chat with the agent about/ });
const source = (page: Page) => page.getByRole("button", { name: "Source", exact: true });
const grip = (panel: Locator, what: string) => panel.getByRole("button", { name: `Move ${what}` });
const sidePanel = (page: Page) => page.getByRole("complementary", { name: "Diagram panel" });
async function popOut(page: Page): Promise<void> {
  await key(page).getByRole("button", { name: "Pop out diagram key" }).click();
  await expect(key(page)).toHaveAttribute("data-placement", "floating");
}
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}
const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

test("the toolbar is at the far bottom left of the drawing and Source is in it, not in the header", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    const stage = await box(page.locator(".archer-diagram-content"));
    const bar = await box(toolbar(page));
    expect(bar.x - stage.x).toBeLessThanOrEqual(20);
    expect(stage.y + stage.height - (bar.y + bar.height)).toBeLessThanOrEqual(20);
    await expect(toolbar(page).getByRole("button", { name: "Source", exact: true })).toBeVisible();
    await expect(page.getByRole("banner").getByRole("button", { name: "Source" })).toHaveCount(0);
    await source(page).click();
    await expect(page.getByRole("region", { name: "Mermaid Source" })).toBeVisible();
    await expect(source(page)).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "Mermaid Source" })).toHaveCount(0);
    await shot(page, "desktop-default");
  } finally {
    await server.stop();
  }
});

test("Source is in the toolbar of a sequence diagram and a journey too", async ({ page }) => {
  const server = await project({
    "archer.toml":
      'version = 1\n[[views]]\nid = "seq"\nkind = "sequence"\ntitle = "Seq"\nsource = ".archer/seq.mmd"\n[[views]]\nid = "trip"\nkind = "journey"\ntitle = "Trip"\nsource = ".archer/trip.mmd"\n',
    ".archer/seq.mmd": readFileSync(
      resolve(import.meta.dirname, "../../../ts/test/fixtures/sequence/minimal.mmd"),
      "utf8",
    ),
    ".archer/trip.mmd": readFileSync(
      resolve(import.meta.dirname, "../../../ts/test/fixtures/journey/minimal.mmd"),
      "utf8",
    ),
  });
  try {
    await server.present("seq");
    await page.goto(server.url);
    await expect(page.locator(".archer-seq-canvas")).toBeVisible();
    await expect(
      page.locator(".archer-canvas-controls").getByRole("button", { name: "Source", exact: true }),
    ).toBeVisible();
    await server.present("trip");
    await expect(page.locator(".archer-journey-board")).toBeVisible();
    const bar = page.locator(".archer-canvas-controls");
    await expect(bar.getByRole("button", { name: "Source", exact: true })).toBeVisible();
    const stage = await box(page.locator(".archer-diagram-content"));
    const b = await box(bar);
    expect(b.x - stage.x).toBeLessThanOrEqual(20);
    expect(stage.y + stage.height - (b.y + b.height)).toBeLessThanOrEqual(20);
  } finally {
    await server.stop();
  }
});

test("a diagram that fails to draw still has Source in a bottom-left toolbar", async ({ page }) => {
  const server = await project({
    "archer.toml":
      'version = 1\n[[views]]\nid = "broken"\nkind = "freeform"\ntitle = "Broken"\nsource = ".archer/broken.mmd"\n',
    ".archer/broken.mmd": "flowchart LR\n  a[[[ --> ???\n",
  });
  try {
    await page.goto(server.address(`view=broken`));
    await expect(page.getByText("has not compiled yet")).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
    await expect(source(page)).toBeVisible();
    const stage = await box(page.locator(".archer-diagram-content"));
    const b = await box(source(page));
    expect(b.x - stage.x).toBeLessThanOrEqual(30);
    expect(stage.y + stage.height - (b.y + b.height)).toBeLessThanOrEqual(30);
    await expect(page.getByRole("banner").getByRole("button", { name: "Source" })).toHaveCount(0);
    await source(page).click();
    await expect(page.getByRole("region", { name: "Mermaid Source" })).toBeVisible();
    await shot(page, "failed-diagram");
  } finally {
    await server.stop();
  }
});

test("the key and the legend sit in the side panel, clear of the toolbar, and the bubble clears all of them", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    await server.setEmphasis("containers", HIGHLIGHTS);
    await expect(legend(page)).toBeVisible();
    await expect(key(page)).toBeVisible();
    const bar = await box(toolbar(page));
    const p = await box(sidePanel(page));
    const k = await box(key(page));
    const l = await box(legend(page));
    const b = await box(fab(page));
    const stage = await box(page.locator(".archer-diagram-content"));
    for (const inside of [k, l]) {
      expect(inside.x).toBeGreaterThanOrEqual(p.x - 1);
      expect(inside.x + inside.width).toBeLessThanOrEqual(p.x + p.width + 1);
    }
    // The panel is beside the drawing, not over it; the key keeps the panel's bottom, the legend above it.
    expect(p.x).toBeGreaterThanOrEqual(stage.x + stage.width - 1);
    expect(l.y + l.height).toBeLessThanOrEqual(k.y + 1);
    expect(overlap(k, l)).toBe(false);
    for (const other of [bar, p]) expect(overlap(b, other)).toBe(false);
    expect(b.x).toBeGreaterThan(stage.x + stage.width / 2);
    await shot(page, "desktop-key-and-highlights");
  } finally {
    await server.stop();
  }
});

test("the bubble clears the toolbar and the panel's rail on a narrower window", async ({ page }) => {
  const server = await project();
  try {
    await page.setViewportSize({ width: 760, height: 700 });
    await open(page, server);
    const b = await box(fab(page));
    for (const other of [toolbar(page), sidePanel(page)]) expect(overlap(b, await box(other))).toBe(false);
  } finally {
    await server.stop();
  }
});

test("the popped-out key moves like the bubble: drag, reload, resize clamp, arrow keys, Home and Reset", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    await popOut(page);
    const panel = key(page);
    const handle = grip(panel, "Diagram Key");
    await expect(handle).toBeVisible();
    await expect(page.getByRole("button", { name: "Reset Diagram Key position" })).toHaveCount(0);
    const start = await box(panel);
    await drag(page, centre(await box(handle)), { x: 700, y: 300 });
    const dropped = await box(panel);
    expect(Math.abs(dropped.x - (700 - (centre(await box(handle)).x - dropped.x)))).toBeLessThanOrEqual(3);
    expect(dropped.y).toBeLessThan(start.y - 100);
    expect(await page.evaluate(() => localStorage.getItem("archer.diagram-key.position"))).not.toBeNull();
    // A drag is not a toggle.
    await expect(panel.getByRole("button", { name: "Diagram Key", exact: true })).toBeVisible();
    await page.reload();
    await expect(panel).toBeVisible();
    const after = await box(panel);
    expect(Math.abs(after.x - dropped.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(after.y - dropped.y)).toBeLessThanOrEqual(3);
    // Past every edge: held fully inside the window.
    await drag(page, centre(await box(handle)), { x: 1439, y: 899 });
    const corner = await box(panel);
    expect(corner.x + corner.width).toBeLessThanOrEqual(1440);
    expect(corner.y + corner.height).toBeLessThanOrEqual(900);
    await page.setViewportSize({ width: 800, height: 600 });
    await expect
      .poll(async () => {
        const b = await box(panel);
        return b.x + b.width <= 800 && b.y + b.height <= 600;
      })
      .toBe(true);
    // Arrow keys from the handle: 10 px, 50 px with Shift; they do not reach the canvas.
    await handle.focus();
    const before = await box(panel);
    await page.keyboard.press("ArrowLeft");
    expect(Math.round(before.x - (await box(panel)).x)).toBe(10);
    await page.keyboard.press("Shift+ArrowUp");
    expect(Math.round(before.y - (await box(panel)).y)).toBe(50);
    // Home, and the visible Reset, return it to where it popped out.
    await page.keyboard.press("Home");
    await expect(page.getByRole("button", { name: "Reset Diagram Key position" })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("archer.diagram-key.position"))).toBeNull();
    await page.setViewportSize({ width: 1440, height: 900 });
    const home = await box(panel);
    expect(Math.abs(home.x - start.x)).toBeLessThanOrEqual(3);
    expect(Math.abs(home.y - start.y)).toBeLessThanOrEqual(3);
    await handle.focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("button", { name: "Reset Diagram Key position" }).click();
    await expect(handle).toBeFocused();
    expect(Math.abs((await box(panel)).x - start.x)).toBeLessThanOrEqual(3);
  } finally {
    await server.stop();
  }
});

test("the Highlights legend is a panel section: no move handle, rows still toggle, and the key stays put", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    await server.setEmphasis("containers", HIGHLIGHTS);
    const panel = legend(page);
    await expect(panel).toBeVisible();
    await expect(grip(panel, "Highlights")).toHaveCount(0);
    const k0 = await box(key(page));
    await panel.getByRole("button", { name: /^Orders/ }).click();
    await expect(panel.getByRole("button", { name: /^Orders/ })).toHaveAttribute("aria-pressed", "false");
    expect(Math.abs((await box(key(page))).y - k0.y)).toBeLessThanOrEqual(1);
  } finally {
    await server.stop();
  }
});

test("Highlights and Walkthroughs are both one press away, and opening one closes the other", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await server.setEmphasis("containers", HIGHLIGHTS);
    await expect(legend(page)).toBeVisible();
    const modes = page.getByRole("group", { name: "Show on the diagram" });
    const highlights = modes.getByRole("button", { name: /^Highlights · 1/ });
    const walks = modes.getByRole("button", { name: /^Walkthroughs · 4/ });
    await expect(highlights).toBeVisible();
    await expect(walks).toBeVisible();
    await expect(highlights).toHaveAttribute("aria-pressed", "true");
    const bar = await box(toolbar(page));
    for (const b of [await box(highlights), await box(walks), await box(key(page))])
      expect(overlap(b, bar)).toBe(false);
    // Walkthroughs: the walkthrough takes the panel's top section and the legend gives way.
    await walks.click();
    await expect(page.getByRole("region", { name: "Walkthrough", exact: true })).toBeVisible();
    await expect(legend(page)).toHaveCount(0);
    await expect(highlights).toHaveAttribute("aria-pressed", "false");
    // Highlights: the walkthrough closes and the agent's highlights are back.
    await highlights.click();
    await expect(page.getByRole("region", { name: "Walkthrough", exact: true })).toHaveCount(0);
    await expect(legend(page)).toBeVisible();
    await expect(highlights).toHaveAttribute("aria-pressed", "true");
    // Pressing it again puts them away without deleting them.
    await highlights.click();
    await expect(legend(page)).toHaveCount(0);
    await expect(highlights).toHaveAttribute("aria-pressed", "false");
    await highlights.click();
    await expect(legend(page)).toBeVisible();
    await shot(page, "desktop-modes");
  } finally {
    await server.stop();
  }
});

test("an open walkthrough keeps the toolbar, Source and the key reachable, with the chat docked beside it", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    await page.getByRole("button", { name: /^Walkthroughs · 4/ }).click();
    await expect(page.getByRole("region", { name: "Walkthrough", exact: true })).toBeVisible();
    const content = await box(page.locator(".archer-diagram-content"));
    const bar = await box(toolbar(page));
    expect(bar.x + bar.width).toBeLessThanOrEqual(content.x + content.width);
    expect(bar.y + bar.height).toBeLessThanOrEqual(content.y + content.height);
    await source(page).click();
    await expect(page.getByRole("region", { name: "Mermaid Source" })).toBeVisible();
    const b = await box(fab(page));
    for (const other of [toolbar(page), key(page)]) expect(overlap(b, await box(other))).toBe(false);
    await shot(page, "desktop-walkthrough");
  } finally {
    await server.stop();
  }
});

test.describe("phone", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("a phone keeps the dock: Source in the toolbar, the panel as one chip, no handles, no sideways scroll", async ({
    page,
  }) => {
    const server = await project();
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, server);
      await server.setEmphasis("containers", HIGHLIGHTS);
      const dock = page.locator(".archer-stage-dock");
      const chip = dock.locator(".archer-dock-chip--panel");
      await expect(chip).toBeVisible();
      await expect(page.getByRole("button", { name: /^Move / })).toHaveCount(0);
      // The switcher, the legend and the key are in the chip's sheet, not over the drawing or its caption.
      await expect(page.getByRole("button", { name: /^Walkthroughs · 4/ })).toHaveCount(0);
      await chip.click();
      const sheet = page.locator(".archer-diagram-panel--sheet");
      await expect(sheet.getByRole("button", { name: /^Walkthroughs · 4/ })).toBeVisible();
      await expect(sheet.getByRole("button", { name: /^Highlights · / })).toBeVisible();
      await expect(sheet.getByRole("region", { name: "Highlights", exact: true })).toBeVisible();
      await expect(sheet.getByRole("region", { name: "Diagram Key", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      await expect(source(page)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(overlap(await box(source(page)), await box(fab(page)))).toBe(false);
      await source(page).click();
      await expect(page.getByRole("region", { name: "Mermaid Source" })).toBeVisible();
      await shot(page, "phone");
    } finally {
      await server.stop();
    }
  });
});

for (const scheme of ["light", "dark"] as const)
  test(`axe finds nothing on the layout: panel, collapsed, key popped out and moved, ${scheme}`, async ({ page }) => {
    const server = await project();
    try {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await open(page, server);
      await server.setEmphasis("containers", HIGHLIGHTS);
      await expect(legend(page)).toBeVisible();
      const scan = async (): Promise<unknown[]> =>
        (await new AxeBuilder({ page }).analyze()).violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        }));
      expect(await scan()).toEqual([]);
      await page.getByRole("button", { name: "Collapse diagram panel" }).click();
      expect(await scan()).toEqual([]);
      await page.getByRole("button", { name: "Expand diagram panel" }).click();
      await popOut(page);
      await drag(page, centre(await box(grip(key(page), "Diagram Key"))), { x: 900, y: 300 });
      expect(await scan()).toEqual([]);
    } finally {
      await server.stop();
    }
  });

test("the page says Highlights, never Emphasis, in these states", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await server.setEmphasis("containers", HIGHLIGHTS);
    await expect(legend(page)).toBeVisible();
    await key(page).getByRole("button", { name: "Diagram Key", exact: true }).click();
    const words = async (): Promise<string[]> =>
      page.evaluate(() =>
        [...document.querySelectorAll("*")]
          .filter((el) => !/^(SCRIPT|STYLE)$/.test(el.tagName))
          .flatMap((el) => [
            el.getAttribute("aria-label"),
            el.getAttribute("title"),
            el.children.length === 0 ? el.textContent : null,
          ])
          .filter((t): t is string => typeof t === "string" && /\bemphasis\b/i.test(t)),
      );
    expect(await words()).toEqual([]);
    await page.keyboard.press("?");
    expect(await words()).toEqual([]);
  } finally {
    await server.stop();
  }
});
