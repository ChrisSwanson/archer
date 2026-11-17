// The diagram side panel (0.6.4, D5): one panel on the right of the drawing. Its top holds the surface the
// mode is on (the walkthrough's steps and transport, the Highlights groups, or in Explore the walkthroughs to
// start and the agent's highlights); its bottom holds the Diagram key, which pops out as the floating box and
// docks back. It collapses to a rail, remembered per viewer; on a phone it is the dock's sheet. A sequence
// diagram has no walkthroughs. An isolated project; never the live service.
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TsProject } from "../support/ts-service";
import { nestedWalkthroughFiles } from "../support/nested-walkthrough-project";
import { walkthroughFiles } from "../support/walkthrough-project";
import { sharedTsProject } from "./support/shared-service";

/** Screenshots for the hand-off, when asked for (`PANEL_SHOTS=<dir>`). */
const SHOTS = process.env["PANEL_SHOTS"];
const SEQUENCE = readFileSync(resolve(import.meta.dirname, "../../../ts/test/fixtures/sequence/minimal.mmd"), "utf8");
const files = (): Record<string, string> =>
  walkthroughFiles({
    "archer.toml":
      'version = 1\n[[views]]\nid = "containers"\nkind = "c4"\ntitle = "Pageturner containers"\nsource = ".archer/containers.mmd"\n[[views]]\nid = "seq"\nkind = "sequence"\ntitle = "Seq"\nsource = ".archer/seq.mmd"\n',
    ".archer/seq.mmd": SEQUENCE,
  });
const project = (): Promise<TsProject> => sharedTsProject({ files: files() });
const HIGHLIGHTS = [
  {
    id: "focus",
    title: "Checkout path",
    groups: [{ id: "a", style: "highlight", label: "Shop API", description: "Takes the order.", nodes: ["api"] }],
  },
];

async function open(page: Page, server: TsProject, view = "containers"): Promise<void> {
  await server.present(view);
  await page.goto(server.url);
  await expect(page.locator(view === "seq" ? ".archer-seq-canvas" : ".react-flow__node[data-id='api']")).toBeVisible();
  // Off the sidebar's hover edge (archer-ui-verification, class 3).
  await page.mouse.move(700, 450);
}
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}
type Box = { x: number; y: number; width: number; height: number };
const box = async (loc: Locator): Promise<Box> => (await loc.boundingBox())!;
const overlap = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

const panel = (page: Page) => page.getByRole("complementary", { name: "Diagram panel" });
const content = (page: Page) => page.locator(".archer-diagram-content");
const walkList = (page: Page) => panel(page).getByRole("region", { name: "Walkthroughs", exact: true });
const walking = (page: Page) => panel(page).getByRole("region", { name: "Walkthrough", exact: true });
const legend = (page: Page) => page.getByRole("region", { name: "Highlights", exact: true });
const key = (page: Page) => page.getByRole("region", { name: "Diagram Key", exact: true });
const step = (page: Page) => page.getByRole("slider", { name: "Step" });
const noPageScroll = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth,
  );

test("Explore: the panel sits right of the drawing with the walkthroughs to start and the key below", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    await expect(panel(page)).toBeVisible();
    const drawing = await box(content(page));
    const side = await box(panel(page));
    expect(side.x).toBeGreaterThanOrEqual(drawing.x + drawing.width - 1);
    expect(side.x + side.width).toBeLessThanOrEqual(1440);
    await expect(walkList(page).getByRole("heading", { name: "Walkthroughs" })).toBeVisible();
    await expect(walkList(page).getByRole("button", { name: /Checkout and payment/ })).toBeVisible();
    // The key is the panel's bottom section, not a box over the drawing.
    await expect(panel(page).getByRole("region", { name: "Diagram Key", exact: true })).toBeVisible();
    await expect(content(page).locator(".archer-diagram-key")).toHaveCount(0);
    const k = await box(key(page));
    const list = await box(walkList(page));
    expect(k.y).toBeGreaterThanOrEqual(list.y + list.height - 1);
    // The mode switcher is the panel's, at its top, and nowhere on the drawing.
    await expect(page.locator(".archer-diagram-modes")).toHaveCount(1);
    await expect(
      panel(page).getByRole("group", { name: "Show on the diagram" }).getByRole("button", { name: "Walkthroughs · 4" }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(content(page).getByRole("button", { name: /^Walkthroughs · / })).toHaveCount(0);
    expect(await noPageScroll(page)).toBe(true);
    await shot(page, "1440-explore");
  } finally {
    await server.stop();
  }
});

test("Walkthrough: choosing one puts its steps and transport in the panel; the ✕ goes back to Explore", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    await walkList(page)
      .getByRole("button", { name: /Checkout and payment/ })
      .click();
    await expect(walking(page)).toBeVisible();
    await expect(step(page)).toHaveValue("1");
    // The transport is in the panel, and nowhere else.
    await expect(walking(page).getByRole("group", { name: "Step controls" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Step controls" })).toHaveCount(1);
    await expect(walkList(page)).toHaveCount(0);
    await walking(page).getByRole("button", { name: "Next step" }).click();
    await expect(step(page)).toHaveValue("2");
    expect(await noPageScroll(page)).toBe(true);
    await shot(page, "1440-walkthrough");
    const close = walking(page).getByRole("button", { name: "Close walkthrough", exact: true });
    await close.click();
    await expect(walking(page)).toHaveCount(0);
    await expect(walkList(page)).toBeVisible();
    await expect.poll(() => page.evaluate(() => new URL(location.href).searchParams.has("walkthrough"))).toBe(false);
    // Focus stays in the panel, on the list it came back to.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest("[aria-label='Diagram panel']") !== null))
      .toBe(true);
  } finally {
    await server.stop();
  }
});

test("Highlights: the agent's groups are the panel's top section; hiding them gives an entry back", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    await server.setEmphasis("containers", HIGHLIGHTS);
    await expect(panel(page).getByRole("region", { name: "Highlights", exact: true })).toBeVisible();
    await expect(content(page).locator(".archer-emph-legend")).toHaveCount(0);
    await expect(legend(page).getByRole("button", { name: /Shop API/ })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: /^Move Highlights/ })).toHaveCount(0);
    expect(await noPageScroll(page)).toBe(true);
    await shot(page, "1440-highlights");
    await legend(page).getByRole("button", { name: "Hide highlights" }).click();
    await expect(legend(page)).toHaveCount(0);
    const entry = panel(page)
      .getByRole("group", { name: "Show on the diagram" })
      .getByRole("button", { name: "Highlights · 1" });
    await expect(entry).toHaveAttribute("aria-pressed", "false");
    await expect(walkList(page)).toBeVisible();
    await entry.click();
    await expect(legend(page)).toBeVisible();
    await expect(entry).toHaveAttribute("aria-pressed", "true");
  } finally {
    await server.stop();
  }
});

test("Show highlights: the agent's highlights arriving during a walkthrough are offered, not switched to", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    await walkList(page)
      .getByRole("button", { name: /Checkout and payment/ })
      .click();
    await expect(step(page)).toHaveValue("1");
    await server.setEmphasis("containers", HIGHLIGHTS);
    const offer = panel(page).getByRole("button", { name: "Show highlights", exact: true });
    await expect(offer).toBeVisible();
    await expect(walking(page)).toBeVisible();
    await expect(legend(page)).toHaveCount(0);
    await offer.click();
    await expect(walking(page)).toHaveCount(0);
    await expect(legend(page)).toBeVisible();
  } finally {
    await server.stop();
  }
});

test("» collapses the panel to a rail, focus held and the choice kept across a reload; « brings it back", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    const drawing = await box(content(page));
    await panel(page).getByRole("button", { name: "Collapse diagram panel" }).click();
    const expand = panel(page).getByRole("button", { name: "Expand diagram panel" });
    await expect(expand).toBeFocused();
    await expect(walkList(page)).toHaveCount(0);
    await expect(key(page)).toHaveCount(0);
    for (const name of ["Expand to walkthroughs", "Expand to the diagram key"])
      await expect(panel(page).getByRole("button", { name })).toBeVisible();
    expect((await box(panel(page))).width).toBeLessThanOrEqual(56);
    await expect.poll(async () => (await box(content(page))).width).toBeGreaterThan(drawing.width);
    expect(await page.evaluate(() => localStorage.getItem("archer.diagram-panel.collapsed"))).toBe("true");
    await shot(page, "1440-collapsed");
    await page.reload();
    await expect(page.locator(".react-flow__node[data-id='api']")).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Expand diagram panel" })).toBeVisible();
    await panel(page).getByRole("button", { name: "Expand diagram panel" }).click();
    await expect(panel(page).getByRole("button", { name: "Collapse diagram panel" })).toBeFocused();
    await expect(walkList(page)).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("archer.diagram-panel.collapsed"))).toBe("false");
    // A rail icon opens the panel on its section.
    await panel(page).getByRole("button", { name: "Collapse diagram panel" }).click();
    await panel(page).getByRole("button", { name: "Expand to the diagram key" }).click();
    await expect(key(page).getByRole("button", { name: "Diagram Key", exact: true })).toBeFocused();
  } finally {
    await server.stop();
  }
});

test("↗ pops the key out as the floating, movable box at its stored place; docking puts it back in the panel", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    await panel(page).getByRole("button", { name: "Pop out diagram key" }).click();
    await expect(panel(page).getByRole("region", { name: "Diagram Key", exact: true })).toHaveCount(0);
    await expect(key(page)).toBeVisible();
    // Focus goes with it, to the button that docks it again.
    await expect(key(page).getByRole("button", { name: "Dock diagram key" })).toBeFocused();
    const grip = key(page).getByRole("button", { name: "Move Diagram Key" });
    await expect(grip).toBeVisible();
    // Over the drawing, in its lower-left corner, as before.
    const drawing = await box(content(page));
    const floating = await box(key(page));
    expect(floating.x).toBeGreaterThanOrEqual(drawing.x);
    expect(floating.x + floating.width).toBeLessThanOrEqual(drawing.x + drawing.width);
    expect(overlap(floating, await box(page.locator(".react-flow__controls")))).toBe(false);
    await shot(page, "1440-key-popped");
    await grip.focus();
    await page.keyboard.press("Shift+ArrowRight");
    const moved = await box(key(page));
    expect(moved.x).toBeGreaterThan(floating.x + 40);
    expect(await page.evaluate(() => localStorage.getItem("archer.diagram-key.position"))).not.toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("archer.diagram-key.popped"))).toBe("true");
    await key(page).getByRole("button", { name: "Dock diagram key" }).click();
    await expect(panel(page).getByRole("region", { name: "Diagram Key", exact: true })).toBeVisible();
    await expect(panel(page).getByRole("button", { name: "Pop out diagram key" })).toBeFocused();
    // Out again: where the person left it.
    await panel(page).getByRole("button", { name: "Pop out diagram key" }).click();
    expect(Math.abs((await box(key(page))).x - moved.x)).toBeLessThanOrEqual(1);
  } finally {
    await server.stop();
  }
});

test("a sequence diagram has no walkthroughs: the panel holds Highlights and the key only", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server, "seq");
    await expect(panel(page)).toBeVisible();
    await expect(walkList(page).getByRole("button", { name: /Checkout/ })).toHaveCount(0);
    await expect(key(page)).toBeVisible();
    await server.setEmphasis("seq", [
      {
        id: "hi",
        title: "The greeting",
        groups: [{ id: "g", style: "highlight", label: "Hello", nodes: ["B"], edges: ["msg-0"] }],
      },
    ]);
    await expect(panel(page).getByRole("region", { name: "Highlights", exact: true })).toBeVisible();
    await expect(content(page).locator(".archer-emph-legend")).toHaveCount(0);
  } finally {
    await server.stop();
  }
});

test.describe("phone", () => {
  test("390 px: the same sections in the dock's sheet, one sheet at a time, nothing beside the drawing", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const server = await project();
    try {
      await server.present("containers");
      await page.goto(server.url);
      await expect(page.locator(".react-flow__node[data-id='api']")).toBeVisible();
      await expect(panel(page)).toHaveCount(0);
      const chip = page.locator(".archer-stage-dock .archer-dock-chip--panel");
      await expect(chip).toHaveCount(1);
      await chip.tap();
      const sheet = page.locator(".archer-dock-sheet");
      await expect(sheet.getByRole("region", { name: "Walkthroughs", exact: true })).toBeVisible();
      await expect(sheet.getByRole("region", { name: "Diagram Key", exact: true })).toBeVisible();
      await sheet.getByRole("button", { name: /Checkout and payment/ }).tap();
      await expect(step(page)).toHaveValue("1");
      await expect(sheet.getByRole("region", { name: "Walkthrough", exact: true })).toBeVisible();
      await expect(page.locator(".archer-dock-sheet")).toHaveCount(1);
      expect(await noPageScroll(page)).toBe(true);
      // The canvas toolbar stays reachable above the open sheet: its Select / Hand switch is uncovered and works
      // without folding the sheet (coordinator, 2026-10-26).
      for (const name of ["Select mode", "Hand mode"]) {
        const button = page.getByRole("button", { name, exact: true });
        await expect(button).toBeInViewport();
        expect(
          await button.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          }),
        ).toBe(true);
      }
      const bar = (await page.locator(".react-flow__controls").boundingBox())!;
      const top = (await sheet.boundingBox())!;
      expect(bar.y + bar.height).toBeLessThanOrEqual(top.y);
      const hand = page.getByRole("button", { name: "Hand mode", exact: true });
      await hand.tap();
      await expect(hand).toHaveAttribute("aria-pressed", "true");
      await expect(sheet).toHaveCount(1);
      await page.getByRole("button", { name: "Select mode", exact: true }).tap();
      await shot(page, "390-walkthrough");
    } finally {
      await server.stop();
      await context.close();
    }
  });
});

// Chrome never overlaps or clips, at both widths and in both themes (archer-ui-verification, class 3).
for (const scheme of ["light", "dark"] as const)
  for (const width of [1440, 390] as const)
    test(`chrome: nothing overlaps the panel or leaves the window, ${width} px, ${scheme}`, async ({
      browser,
    }: {
      browser: Browser;
    }) => {
      const phone = width < 600;
      const context = await browser.newContext({
        viewport: { width, height: phone ? 844 : 900 },
        colorScheme: scheme,
        ...(phone ? { hasTouch: true, isMobile: true } : {}),
      });
      const page = await context.newPage();
      const server = await project();
      try {
        await open(page, server);
        await server.setEmphasis("containers", HIGHLIGHTS);
        const chrome = [
          ".react-flow__controls",
          "[aria-label^='Chat with the agent']",
          ".archer-diagram-panel",
          ".archer-stage-dock",
        ];
        const boxes = await page.evaluate(
          (selectors) =>
            selectors.map((s) =>
              [...document.querySelectorAll(s)]
                .map((e) => e.getBoundingClientRect())
                .filter((r) => r.width > 0)
                .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height })),
            ),
          chrome,
        );
        const flat = boxes.flatMap((list, i) => list.map((b) => ({ i, b })));
        for (const a of flat) {
          expect(a.b.x).toBeGreaterThanOrEqual(0);
          expect(a.b.x + a.b.width).toBeLessThanOrEqual(width + 0.5);
          for (const b of flat)
            if (a.i < b.i && !(a.i === 2 && b.i === 3))
              expect(overlap(a.b, b.b), `${chrome[a.i]} over ${chrome[b.i]}`).toBe(false);
        }
        expect(await noPageScroll(page)).toBe(true);
        await shot(page, `${width}-${scheme}-highlights`);
      } finally {
        await server.stop();
        await context.close();
      }
    });

// The hand-off's screenshots (`PANEL_SHOTS=<dir>`): every state at both widths, in both themes. A phone has no
// collapsed rail or popped-out key (the sheet is its panel), so it shows the sheet open on each surface instead.
for (const scheme of ["light", "dark"] as const)
  for (const width of [1440, 390] as const)
    test(`shots: every state, ${width} px, ${scheme}`, async ({ browser }: { browser: Browser }) => {
      test.skip(SHOTS === undefined, "only when asked for");
      const phone = width < 600;
      const context = await browser.newContext({
        viewport: { width, height: phone ? 844 : 900 },
        colorScheme: scheme,
        ...(phone ? { hasTouch: true, isMobile: true } : {}),
      });
      const page = await context.newPage();
      const server = await project();
      const at = `${width}-${scheme}`;
      const sheet = async (): Promise<void> => {
        if (phone && (await page.locator(".archer-dock-sheet").count()) === 0)
          await page.locator(".archer-dock-chip--panel").tap();
      };
      try {
        await open(page, server);
        await sheet();
        await shot(page, `${at}-1-explore`);
        await server.setEmphasis("containers", HIGHLIGHTS);
        await expect(page.locator(".archer-diagram-modes button[aria-pressed='true']")).toHaveCount(1);
        await sheet();
        await expect(legend(page)).toBeVisible();
        await shot(page, `${at}-2-highlights`);
        await page.locator(".archer-walk-open").first().click();
        await sheet();
        await page
          .getByRole("group", { name: "Walkthroughs on this diagram" })
          .getByRole("button", { name: /Checkout and payment/ })
          .click();
        await expect(step(page)).toHaveValue("1");
        await sheet();
        await shot(page, `${at}-3-walkthrough`);
        if (phone) return;
        await panel(page).getByRole("button", { name: "Close walkthrough", exact: true }).click();
        await panel(page).getByRole("button", { name: "Pop out diagram key" }).click();
        await expect(key(page).getByRole("button", { name: "Dock diagram key" })).toBeVisible();
        await shot(page, `${at}-4-key-popped`);
        await panel(page).getByRole("button", { name: "Collapse diagram panel" }).click();
        await shot(page, `${at}-5-collapsed`);
      } finally {
        await server.stop();
        await context.close();
      }
    });

// Review fixes (0.6.4 review, findings 1–6 and 8). Each failed before its fix.
const WALK = { id: "checkout-and-payment", step: 2 } as const;
const WALKS_JSON = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../ts/test/fixtures/walkthroughs/containers.walkthroughs.json"),
    "utf8",
  ),
) as { walkthroughs: { id: string; steps: { edges?: { source: string; target: string }[] }[] }[] };
const live = (page: Page) => page.locator("[aria-live='polite']").filter({ hasText: /Step \d+ of \d+/ });
const focusIn = (page: Page, selector: string) =>
  page.evaluate((s) => document.activeElement?.closest(s) != null, selector);
const focusOnBody = (page: Page) =>
  page.evaluate(() => document.activeElement === null || document.activeElement === document.body);
/** The camera once it stops moving: the same transform for a few polls running. */
async function settled(page: Page): Promise<void> {
  let last = "";
  let still = 0;
  await expect
    .poll(
      async () => {
        const now = await page.evaluate(
          () => getComputedStyle(document.querySelector(".react-flow__viewport")!).transform,
        );
        still = now === last ? still + 1 : 0;
        last = now;
        return still;
      },
      { timeout: 8000, intervals: [80] },
    )
    .toBeGreaterThan(4);
}

test.describe("a walkthrough is never hidden in a collapsed panel (review F1)", () => {
  test("the agent's walkthrough expands a collapsed panel once; a collapse during it holds until it ends", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await project();
    try {
      await open(page, server);
      await panel(page).getByRole("button", { name: "Collapse diagram panel" }).click();
      await server.present("containers", undefined, WALK);
      await expect(walking(page)).toBeVisible();
      await expect(step(page)).toHaveValue("2");
      await expect(walking(page).getByRole("button", { name: "Close walkthrough", exact: true })).toBeVisible();
      // Collapsed by the person during the walkthrough: the next step the agent sends keeps it collapsed.
      await panel(page).getByRole("button", { name: "Collapse diagram panel" }).click();
      await server.present("containers", undefined, { id: WALK.id, step: 3 });
      await expect(panel(page).getByRole("button", { name: "Expand diagram panel" })).toBeVisible();
      await expect(walking(page)).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect.poll(() => page.evaluate(() => new URL(location.href).searchParams.has("walkthrough"))).toBe(false);
      // A new walkthrough is a new entry: it opens the panel again; leaving it puts the rail back.
      await panel(page).getByRole("button", { name: "Expand to walkthroughs" }).click();
      await walkList(page)
        .getByRole("button", { name: /Declined card/ })
        .click();
      await expect(walking(page)).toBeVisible();
      await walking(page).getByRole("button", { name: "Close walkthrough", exact: true }).click();
      await expect(walkList(page)).toBeVisible();
    } finally {
      await server.stop();
    }
  });

  test("below 1000 px the panel opens over the drawing for the walkthrough, and goes back to the rail after", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    const server = await project();
    try {
      await open(page, server);
      await expect(panel(page).getByRole("button", { name: "Expand diagram panel" })).toBeVisible();
      const drawing = await box(content(page));
      await server.present("containers", undefined, WALK);
      await expect(walking(page)).toBeVisible();
      await expect(walking(page).getByRole("button", { name: "Close walkthrough", exact: true })).toBeVisible();
      const side = await box(panel(page));
      expect(side.x + side.width).toBeLessThanOrEqual(900);
      // Over the drawing, not beside it: the drawing keeps its width.
      expect(Math.abs((await box(content(page))).width - drawing.width)).toBeLessThanOrEqual(2);
      expect(await noPageScroll(page)).toBe(true);
      // The chat's launcher moves out from under it.
      await expect
        .poll(async () =>
          overlap(await box(page.getByRole("button", { name: /^Chat with the agent/ })), await box(panel(page))),
        )
        .toBe(false);
      await shot(page, "900-walkthrough-overlay");
      await walking(page).getByRole("button", { name: "Close walkthrough", exact: true }).click();
      await expect(panel(page).getByRole("button", { name: "Expand diagram panel" })).toBeVisible();
      await expect(panel(page).getByRole("button", { name: "Expand diagram panel" })).toBeFocused();
    } finally {
      await server.stop();
    }
  });
});

test.describe("step keys and the step announcement do not depend on the panel being open (review F2)", () => {
  test("desktop: with the panel collapsed, → and End still step, and each step is said once", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const server = await project();
    try {
      await open(page, server);
      await walkList(page)
        .getByRole("button", { name: /Checkout and payment/ })
        .click();
      await expect(step(page)).toHaveValue("1");
      await expect(live(page)).toHaveCount(1);
      await panel(page).getByRole("button", { name: "Collapse diagram panel" }).click();
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("ArrowRight");
      await expect(live(page)).toHaveCount(1);
      await expect(live(page)).toContainText("Step 2 of 8");
      await page.keyboard.press("End");
      await expect(live(page)).toContainText("Step 8 of 8");
      await panel(page).getByRole("button", { name: "Expand diagram panel" }).click();
      await expect(step(page)).toHaveValue("8");
      await expect(live(page)).toHaveCount(1);
    } finally {
      await server.stop();
    }
  });

  test("phone: with the sheet folded, Next under the drawing is announced", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const server = await project();
    try {
      await server.present("containers", undefined, { id: WALK.id, step: 1 });
      await page.goto(server.url);
      await expect(page.locator(".archer-dock-sheet")).toHaveCount(1);
      await expect(live(page)).toContainText("Step 1 of 8");
      const pane = await box(page.locator(".react-flow__pane"));
      await page.touchscreen.tap(pane.x + pane.width - 20, pane.y + 80);
      await expect(page.locator(".archer-dock-sheet")).toHaveCount(0);
      await page.locator(".archer-walk-transport").getByRole("button", { name: "Next step" }).tap();
      await expect(live(page)).toHaveCount(1);
      await expect(live(page)).toContainText("Step 2 of 8");
    } finally {
      await server.stop();
      await context.close();
    }
  });
});

test.describe("focus has one owner in the panel (review F3, F4)", () => {
  test("popping the key out of a panel with nothing else in it takes focus to the floating key's Dock", async ({
    page,
  }) => {
    const server = await project();
    try {
      await open(page, server, "seq");
      await panel(page).getByRole("button", { name: "Pop out diagram key" }).click();
      await expect(key(page).getByRole("button", { name: "Dock diagram key" })).toBeFocused();
    } finally {
      await server.stop();
    }
  });

  test("hiding the agent's highlights from the keyboard keeps focus in the panel", async ({ page }) => {
    const server = await project();
    try {
      await open(page, server);
      await server.setEmphasis("containers", HIGHLIGHTS);
      const hide = legend(page).getByRole("button", { name: "Hide highlights" });
      await hide.focus();
      await page.keyboard.press("Enter");
      await expect(legend(page)).toHaveCount(0);
      await expect.poll(() => focusIn(page, "[aria-label='Diagram panel']")).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("Show highlights takes focus to the highlights it shows", async ({ page }) => {
    const server = await project();
    try {
      await open(page, server);
      await walkList(page)
        .getByRole("button", { name: /Checkout and payment/ })
        .click();
      await expect(step(page)).toHaveValue("1");
      await server.setEmphasis("containers", HIGHLIGHTS);
      await panel(page).getByRole("button", { name: "Show highlights", exact: true }).click();
      await expect(legend(page)).toBeVisible();
      // On the first group, not the ✕ that would hide them again.
      await expect(legend(page).getByRole("button", { name: /Shop API/ })).toBeFocused();
    } finally {
      await server.stop();
    }
  });

  // Superseded review F3/F4 rule ("without pulling focus into the panel"): Escape with nothing focused now
  // lands on Walkthroughs, so the next Tab does not start from the top of the page (R4-claude F30).
  test("Escape from outside the panel leaves the walkthrough and lands on Walkthroughs, not pressed", async ({
    page,
  }) => {
    const server = await project();
    try {
      await open(page, server);
      await walkList(page)
        .getByRole("button", { name: /Checkout and payment/ })
        .click();
      await expect(step(page)).toHaveValue("1");
      // Focus leaves the panel for the page (a press on the drawing).
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press("Escape");
      await expect(walking(page)).toHaveCount(0);
      const walks = panel(page).getByRole("button", { name: /^Walkthroughs/ });
      await expect(walks).toHaveAttribute("aria-pressed", "false");
      await expect(walks).toBeFocused();
    } finally {
      await server.stop();
    }
  });

  test("the rail's walkthroughs icon, with highlights up, opens the walkthrough list", async ({ page }) => {
    const server = await project();
    try {
      await open(page, server);
      await server.setEmphasis("containers", HIGHLIGHTS);
      await expect(legend(page)).toBeVisible();
      await panel(page).getByRole("button", { name: "Collapse diagram panel" }).click();
      await panel(page).getByRole("button", { name: "Expand to walkthroughs" }).click();
      await expect(page.getByRole("group", { name: "Walkthroughs on this diagram" })).toBeVisible();
      await expect(legend(page)).toHaveCount(0);
      await expect.poll(() => focusIn(page, "[aria-label='Walkthroughs on this diagram']")).toBe(true);
    } finally {
      await server.stop();
    }
  });
});

test.describe("phone toolbar (review F4/F12, F11)", () => {
  // The nested diagram: its toolbar has every button (the nest switch too).
  const nested = (): Promise<TsProject> => sharedTsProject({ nestedView: true, files: nestedWalkthroughFiles() });
  const NESTED_STEPS = (
    JSON.parse(nestedWalkthroughFiles()[".archer/shop.walkthroughs.json"]!) as {
      walkthroughs: { steps: { edges: { source: string; target: string }[] }[] }[];
    }
  ).walkthroughs[0]!.steps;

  // flows-r1 claude-06 (O95): at 320 px the lifted toolbar wrapped to two rows, 82 of the drawing's 204 px.
  for (const scheme of ["light", "dark"] as const)
    test(`320×640 ${scheme}: with a sheet open the toolbar folds to one row, and unfolds in place`, async ({
      browser,
    }: {
      browser: Browser;
    }) => {
      const context = await browser.newContext({
        viewport: { width: 320, height: 640 },
        hasTouch: true,
        isMobile: true,
        colorScheme: scheme,
      });
      const page = await context.newPage();
      const server = await nested();
      try {
        await server.present("shop", undefined, { id: "order", step: 1 });
        await page.goto(server.url);
        await expect(page.locator(".archer-dock-sheet")).toHaveCount(1);
        await expect(page.locator(".react-flow__node").first()).toBeAttached();
        const fold = page.getByRole("button", { name: "More canvas controls" });
        await expect(fold).toHaveAttribute("aria-expanded", "false");
        const bar = await box(page.locator(".react-flow__controls"));
        expect(bar.height, "one row of 44 px buttons").toBeLessThanOrEqual(52);
        expect(overlap(bar, await box(page.locator(".archer-chat-fab"))), "the row clear of the chat button").toBe(
          false,
        );
        // Select / Hand, Fit and Follow stay one press away (0.6.4 D5); zoom waits behind the fold.
        for (const name of ["Select mode", "Hand mode", "Fit view", "Follow steps"])
          await expect(page.getByRole("button", { name, exact: true })).toBeInViewport();
        await expect(page.getByRole("button", { name: "Zoom in" })).toBeHidden();
        await fold.tap();
        await expect(fold).toHaveAttribute("aria-expanded", "true");
        await expect(page.getByRole("button", { name: "Zoom in" })).toBeInViewport();
        await expect(page.getByRole("button", { name: "Export, compare and more" })).toBeInViewport();
        const open = await box(page.locator(".react-flow__controls"));
        expect(open.y + open.height).toBeLessThanOrEqual((await box(page.locator(".archer-dock-sheet"))).y);
        await expect(page.locator(".archer-dock-sheet")).toHaveCount(1);
        await shot(page, `320-toolbar-fold-${scheme}`);
        // The sheet folded: the toolbar is the ordinary column again, no fold button.
        await page.locator(".archer-dock-sheet-close").first().tap();
        await expect(page.locator(".archer-dock-sheet")).toHaveCount(0);
        await expect(fold).toBeHidden();
        await expect(page.getByRole("button", { name: "Zoom in" })).toBeVisible();
      } finally {
        await server.stop();
        await context.close();
      }
    });

  test("390×844: the lifted toolbar fits the width, and the followed step is framed clear of it", async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const server = await nested();
    try {
      await server.present("shop", undefined, { id: "order", step: 1 });
      await page.goto(server.url);
      await expect(page.locator(".archer-dock-sheet")).toHaveCount(1);
      await expect(page.locator(".react-flow__node").first()).toBeAttached();
      for (let n = 1; n <= NESTED_STEPS.length; n++) {
        if (n > 1) await page.locator(".archer-dock-sheet").getByRole("button", { name: "Next step" }).tap();
        await expect(step(page)).toHaveValue(String(n));
        await settled(page);
        const bar = await box(page.locator(".react-flow__controls"));
        expect(bar.x).toBeGreaterThanOrEqual(0);
        expect(bar.x + bar.width, "toolbar inside the window").toBeLessThanOrEqual(390);
        for (const id of new Set(NESTED_STEPS[n - 1]!.edges.flatMap((e) => [e.source, e.target]))) {
          const node = page.locator(`.react-flow__node[data-id='${id}']`);
          if ((await node.count()) === 0) continue;
          expect(overlap(await box(node), bar), `step ${n}: ${id} under the toolbar`).toBe(false);
        }
      }
      await shot(page, "390-toolbar-follow");
    } finally {
      await server.stop();
      await context.close();
    }
  });

  for (const chips of [1, 5])
    test(`390×667: the folded vertical toolbar fits under the header (${chips} highlight chips)`, async ({
      browser,
    }: {
      browser: Browser;
    }) => {
      const context = await browser.newContext({
        viewport: { width: 390, height: 667 },
        hasTouch: true,
        isMobile: true,
      });
      const page = await context.newPage();
      const server = await nested();
      try {
        await server.present("shop");
        await server.setEmphasis(
          "shop",
          Array.from({ length: chips }, (_, i) => ({
            id: `path${i}`,
            title: `Order path ${i + 1}`,
            groups: [{ id: "a", style: "highlight", label: "Web app", nodes: ["web"] }],
          })),
        );
        await server.present("shop", undefined, { id: "order", step: 1 });
        await page.goto(server.url);
        await expect(page.locator(".archer-dock-sheet")).toHaveCount(1);
        const pane = await box(page.locator(".react-flow__pane"));
        // Above the toolbar riding over the sheet: with five chips little of the drawing shows.
        await page.touchscreen.tap(pane.x + pane.width - 20, pane.y + 20);
        await expect(page.locator(".archer-dock-sheet")).toHaveCount(0);
        const flow = await box(page.locator(".react-flow"));
        const bar = await box(page.locator(".react-flow__controls"));
        expect(bar.y, "toolbar top inside the drawing").toBeGreaterThanOrEqual(flow.y);
        const caption = page.locator(".archer-canvas-heading").first();
        if ((await caption.count()) > 0)
          expect(overlap(await box(caption), bar), "the drawing's heading over the toolbar").toBe(false);
        expect(bar.y + bar.height).toBeLessThanOrEqual(flow.y + flow.height);
        const zoomIn = page.locator(".react-flow__controls-zoomin");
        expect(
          await zoomIn.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          }),
        ).toBe(true);
        await shot(page, `390x667-toolbar-${chips}`);
        // The tools menu still opens beside the toolbar, inside the window, and its items take a press.
        await page.getByRole("button", { name: "Export, compare and more" }).tap();
        const menu = page.getByRole("group", { name: "Export, compare and more" });
        await expect(menu).toBeVisible();
        const m = await box(menu);
        expect(m.x).toBeGreaterThanOrEqual(bar.x + bar.width);
        expect(m.x + m.width).toBeLessThanOrEqual(390);
        expect(m.y).toBeGreaterThanOrEqual(flow.y);
        const item = menu.getByRole("button").first();
        expect(
          await item.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          }),
        ).toBe(true);
      } finally {
        await server.stop();
        await context.close();
      }
    });

  test("a tap that folds the sheet leaves Follow on", async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const server = await project();
    try {
      await server.present("containers", undefined, { id: WALK.id, step: 1 });
      await page.goto(server.url);
      await expect(page.locator(".archer-dock-sheet")).toHaveCount(1);
      const follow = page.getByRole("button", { name: "Follow steps" });
      await expect(follow).toHaveAttribute("aria-pressed", "true");
      const pane = await box(page.locator(".react-flow__pane"));
      await page.touchscreen.tap(pane.x + pane.width - 20, pane.y + 80);
      await expect(page.locator(".archer-dock-sheet")).toHaveCount(0);
      await expect(follow).toHaveAttribute("aria-pressed", "true");
      // A real drag of the drawing still takes the camera (once the step is framed for the folded sheet).
      await settled(page);
      await page.mouse.move(pane.x + pane.width - 20, pane.y + 80);
      await page.mouse.down();
      await page.mouse.move(pane.x + pane.width - 80, pane.y + 120, { steps: 6 });
      await page.mouse.up();
      await expect(follow).toHaveAttribute("aria-pressed", "false");
    } finally {
      await server.stop();
      await context.close();
    }
  });
});

test("the walkthrough's Sequence tab scrolls sideways in the panel's width (review: unverified)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const server = await project();
  try {
    await open(page, server);
    await walkList(page)
      .getByRole("button", { name: /Checkout and payment/ })
      .click();
    await walking(page).getByRole("tab", { name: "Sequence" }).click();
    const wrap = page.locator(".archer-walk-seq-wrap");
    await expect(wrap).toBeVisible();
    const sizes = await wrap.evaluate((el) => ({
      scroll: el.scrollWidth,
      client: el.clientWidth,
      overflow: getComputedStyle(el).overflowX,
    }));
    expect(sizes.scroll).toBeGreaterThan(sizes.client);
    expect(sizes.overflow).toBe("auto");
    const at = await box(wrap);
    await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
    await page.mouse.wheel(400, 0);
    await expect.poll(() => wrap.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await expect(step(page)).toHaveValue("1");
  } finally {
    await server.stop();
  }
});
