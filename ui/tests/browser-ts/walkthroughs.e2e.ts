// Walkthroughs in a real browser (ADR 0034, slice 3; the approved prototype is the look): the entry in
// the graph tools, the panel and picker, stepping by wheel, keys, transport and by pressing the diagram,
// the step drawn through emphasis (current flows, earlier steps are quiet), closing back to the plain
// diagram, the phone's sheet, axe, and the walked tone's contrast in both themes. An isolated project
// holding slice 1's fixture; never the live service.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { TsProject } from "../support/ts-service";
import { walkthroughFiles } from "../support/walkthrough-project";
import { sharedTsProject } from "./support/shared-service";

/** Screenshots for the hand-off, when asked for (`WALK_SHOTS=<dir>`). */
const SHOTS = process.env["WALK_SHOTS"];

const project = (): Promise<TsProject> => sharedTsProject({ files: walkthroughFiles() });

async function open(page: Page, server: TsProject): Promise<void> {
  await server.present("containers");
  await page.goto(server.url);
  await expect(page.locator(".react-flow__node[data-id='api']")).toBeVisible();
}

const panel = (page: Page) => page.getByRole("region", { name: "Walkthrough", exact: true });
const step = (page: Page) => page.getByRole("slider", { name: "Step" });

async function openPicker(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Walkthroughs · 4/ }).click();
  await expect(panel(page)).toBeVisible();
}

async function startCheckout(page: Page): Promise<void> {
  await openPicker(page);
  await page
    .getByRole("group", { name: "Walkthroughs on this diagram" })
    .getByRole("button", { name: /Checkout and payment/ })
    .click();
  await expect(step(page)).toHaveValue("1");
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

const emphasised = (page: Page) => page.locator(".archer-emph");

test("the entry opens the list with nothing emphasised; choosing starts at step 1", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await expect(emphasised(page)).toHaveCount(0);
    await openPicker(page);
    await expect(emphasised(page)).toHaveCount(0);
    // The mode switcher stays, pressed: pressing it again leaves (0.6.4, D3).
    await expect(page.locator(".archer-walk-open")).toHaveAttribute("aria-pressed", "true");
    const list = page.getByRole("group", { name: "Walkthroughs on this diagram" });
    await expect(list.getByRole("button")).toHaveCount(4);
    await list.getByRole("button", { name: /Checkout and payment/ }).click();
    await expect(step(page)).toHaveValue("1");
    await expect(panel(page).locator('[aria-current="step"]')).toContainText("Check out");
    await expect(page.locator(".react-flow__edge[data-id='customer--web']")).toHaveClass(/archer-emph-style-flow/);
    // The rest of the diagram steps back: its shape fades (colour), its words keep their contrast (full opacity).
    const back = page.locator(".react-flow__node[data-id='backoffice']");
    await expect(back).toHaveAttribute("style", /opacity: 0\.25/);
    await expect(back).toHaveCSS("opacity", "1");
    // Read once the box's 120 ms colour fade has finished: mid-fade the alpha is on its way down (0.26...).
    await expect.poll(() => back.evaluate((box) => getComputedStyle(box).backgroundColor)).toMatch(/0\.25|\/ 25%/);
    await expect(page.locator(".archer-emph-legend")).toHaveCount(0);
  } finally {
    await server.stop();
  }
});

test("the entry is a visible button in the side panel's bar, and the panel lists the walkthroughs", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    const side = page.getByRole("complementary", { name: "Diagram panel" });
    const button = side.getByRole("button", { name: /^Walkthroughs · 4/ });
    await expect(button).toBeVisible();
    const stage = (await page.locator(".archer-diagram-content").boundingBox())!;
    const at = (await button.boundingBox())!;
    // In the panel beside the drawing (0.6.4 D5), not over it; one entry, not a second in the graph tools.
    expect(at.x).toBeGreaterThanOrEqual(stage.x + stage.width - 1);
    await expect(side.getByRole("group", { name: "Walkthroughs on this diagram" })).toBeVisible();
    await shot(page, "desktop-button");
    await page.getByRole("button", { name: "Export, compare and more" }).click();
    await expect(
      page.getByRole("group", { name: "Export, compare and more" }).getByRole("button", { name: /^Walkthroughs · 4/ }),
    ).toHaveCount(0);
  } finally {
    await server.stop();
  }
});

test("the Diagram key gives the canvas back while the panel is open, and is as the person left it after", async ({
  page,
}) => {
  const server = await project();
  try {
    await page.addInitScript(() => localStorage.setItem("archer.diagram-key.open", "true"));
    await open(page, server);
    const key = page.getByRole("region", { name: "Diagram Key" });
    await expect(key).toHaveAttribute("data-open", "true");
    await openPicker(page);
    await expect(key).toHaveAttribute("data-open", "false");
    await page.getByRole("button", { name: "Close walkthrough" }).click();
    await expect(key).toHaveAttribute("data-open", "true");
  } finally {
    await server.stop();
  }
});

test("the agent opens a walkthrough at a step with 'Presented by the agent'; the link remembers it; the host hears the step", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    const pushed = await page.evaluate(() => history.length);
    await server.present("containers", "The declined card reaches the Shop API here.", {
      id: "declined-card",
      step: 3,
    });
    await expect(panel(page)).toBeVisible();
    await expect(step(page)).toHaveValue("3");
    await expect(panel(page).locator(".archer-walk-presented")).toContainText(
      "Presented by the agent · just now — The declined card reaches the Shop API here.",
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            `${new URL(location.href).searchParams.get("walkthrough")}.${new URL(location.href).searchParams.get("step")}`,
        ),
      )
      .toBe("declined-card.3");
    await shot(page, "desktop-agent-presented");
    // Stepping updates the address in place (no history entries) and tells the host.
    await page.getByRole("button", { name: "Next step" }).click();
    await expect.poll(() => page.evaluate(() => new URL(location.href).searchParams.get("step"))).toBe("4");
    await expect.poll(() => server.reading()).toEqual({ viewId: "containers", id: "declined-card", step: 4 });
    expect(await page.evaluate(() => history.length)).toBe(pushed);
    // A copied link opens the same step in a fresh page.
    const link = page.url();
    await page.goto("about:blank");
    await page.goto(link);
    await expect(step(page)).toHaveValue("4");
    await expect(panel(page).locator(".archer-walk-pick-title")).toContainText(/Declined card/);
    // The agent moves it again; closing clears the address and the host's idea of where the reader is.
    await server.present("containers", undefined, { id: "declined-card", step: 1 });
    await expect(step(page)).toHaveValue("1");
    await page.getByRole("button", { name: "Close walkthrough" }).click();
    await expect.poll(() => page.evaluate(() => new URL(location.href).searchParams.has("walkthrough"))).toBe(false);
    await expect.poll(() => server.reading()).toBeNull();
    // An agent present with no walkthrough while it is open takes the panel down.
    await openPicker(page);
    await server.present("containers", "Back to the plain picture.");
    await expect(panel(page)).toHaveCount(0);
  } finally {
    await server.stop();
  }
});

test("a wheel notch over the panel is one step; keys and the transport bar step too", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await startCheckout(page);
    const box = (await panel(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 100);
    await expect(step(page)).toHaveValue("2");
    // A fling is one step, not a run through the walkthrough.
    await page.waitForTimeout(700);
    await expect(step(page)).toHaveValue("2");
    await page.keyboard.press("ArrowDown");
    await expect(step(page)).toHaveValue("3");
    await page.keyboard.press("ArrowLeft");
    await expect(step(page)).toHaveValue("2");
    await page.keyboard.press("End");
    await expect(step(page)).toHaveValue("8");
    await page.keyboard.press("Home");
    await expect(step(page)).toHaveValue("1");
    await page.getByRole("button", { name: "Next step" }).click();
    await expect(step(page)).toHaveValue("2");
    await page.getByRole("button", { name: "Last step" }).click();
    await expect(step(page)).toHaveValue("8");
    await expect(page.getByRole("button", { name: "Next step" })).toBeDisabled();
    // Only the current step's details are open.
    await expect(panel(page).locator(".archer-walk-head[aria-expanded='true']")).toHaveCount(1);
    await expect(panel(page).getByText("Queue the side effects").first()).toBeVisible();
    await expect(panel(page).locator(".archer-walk-more:not([inert]) .archer-walk-body")).toHaveCount(1);
    // The announcement says it.
    // The one spoken step: the mode's, outside the panel so that it outlives a collapse (0.6.4 review F2).
    await expect(page.locator(".archer-visually-hidden[aria-live]").filter({ hasText: /Step \d+ of/ })).toHaveText(
      /Step 8 of 8: Queue the side effects/,
    );
  } finally {
    await server.stop();
  }
});

test("Play advances on its own and stops at the end", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await openPicker(page);
    await page
      .getByRole("group", { name: "Walkthroughs on this diagram" })
      .getByRole("button", { name: /Declined card/ })
      .click();
    await expect(step(page)).toHaveValue("1");
    await page.getByRole("button", { name: "Play" }).click();
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(step(page)).toHaveValue("5", { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
  } finally {
    await server.stop();
  }
});

test("Space plays, pauses and plays again from the start, with focus on a step row or a box", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await startCheckout(page);
    // Choosing put focus on the current step's row: Space plays rather than pressing it.
    await expect(page.locator(".archer-walk-head[aria-current='step']")).toBeFocused();
    await page.keyboard.press(" ");
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
    await page.keyboard.press(" ");
    await expect(page.getByRole("button", { name: "Play" })).toBeVisible();
    const paused = await step(page).inputValue();
    await page.waitForTimeout(1_800);
    await expect(step(page)).toHaveValue(paused);
    // At the last step, from a box on the diagram, it plays again from the first.
    await page.keyboard.press("End");
    await page.locator(".react-flow__node[data-id='api']").focus();
    await page.keyboard.press(" ");
    await expect(step(page)).toHaveValue("1");
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  } finally {
    await server.stop();
  }
});

test("pressing a graph element jumps to its step; closing restores the plain diagram", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await startCheckout(page);
    // The camera follows the step, so the provider box is off screen: stop following and fit the whole diagram to press it where it is.
    await page.getByRole("button", { name: "Follow steps" }).click();
    await page.getByRole("button", { name: "Fit view" }).click();
    // The hand is the default pointer: a press follows the step there too.
    await page.locator(".react-flow__node[data-id='payments']").click();
    // The first step that names the provider box is step 4: its line ends there.
    await expect(step(page)).toHaveValue("4");
    await expect(page.locator(".react-flow__node[data-id='payments']")).toHaveClass(/archer-emph-style-flow/);
    // Earlier steps are on the diagram, quieter: their lines and the boxes at their ends.
    await expect(page.locator(".react-flow__edge[data-id='customer--web']")).toHaveClass(/archer-emph--walked/);
    await expect(page.locator(".react-flow__node[data-id='customer']")).toHaveClass(/archer-emph--walked/);
    await page.getByRole("button", { name: "Close walkthrough" }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(emphasised(page)).toHaveCount(0);
    await expect(page.locator(".react-flow__node[data-id='backoffice']")).toHaveCSS("opacity", "1");
    // Focus stays in the side panel, on the Explore section that took the walkthrough's place (D5).
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest(".archer-diagram-panel") !== null))
      .toBe(true);
  } finally {
    await server.stop();
  }
});

test("the divider resizes by keyboard and the width is remembered", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await openPicker(page);
    const divider = page.getByRole("separator", { name: "Resize diagram panel" });
    await divider.focus();
    const before = (await panel(page).boundingBox())!.width;
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await panel(page).boundingBox())!.width).toBe(before + 24);
    await page.reload();
    await expect(page.locator(".react-flow__node[data-id='api']")).toBeVisible();
    await openPicker(page);
    expect((await panel(page).boundingBox())!.width).toBe(before + 24);
  } finally {
    await server.stop();
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe passes on the open panel mid-walkthrough, and the walked tone clears 3:1: ${scheme}`, async ({
    browser,
  }: {
    browser: Browser;
  }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    const server = await project();
    try {
      await open(page, server);
      await startCheckout(page);
      await page.getByRole("button", { name: "Next step" }).click({ clickCount: 1 });
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect(step(page)).toHaveValue("4");
      await expect(page.locator(".react-flow__edge[data-id='api--payments']")).toHaveClass(/archer-emph-style-flow/);
      await page.waitForTimeout(400);
      await shot(page, `desktop-${scheme}-step4`);
      // What is off the path steps back by its shapes; every word, on the path or off it, keeps AA, and axe checks them all.
      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`))).toEqual([]);
      const contrast = await page.evaluate(() => {
        const lin = (c: number) => {
          const v = c / 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        const lum = (css: string) => {
          const [r, g, b] = (css.match(/[\d.]+/g) ?? []).map(Number);
          return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
        };
        const ratio = (a: string, b: string) => {
          const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
          return (x! + 0.05) / (y! + 0.05);
        };
        const stroke = getComputedStyle(
          document.querySelector(".react-flow__edge[data-id='customer--web'] .react-flow__edge-path")!,
        ).stroke;
        const border = getComputedStyle(
          document.querySelector(".react-flow__node.archer-emph--walked")!,
        ).borderTopColor;
        const canvas = getComputedStyle(document.querySelector(".react-flow")!).backgroundColor;
        const bg = canvas === "rgba(0, 0, 0, 0)" ? getComputedStyle(document.body).backgroundColor : canvas;
        // What the eye gets: the element's colour over what is under it, through every opacity up to the canvas.
        const rgba = (css: string): number[] => {
          const n = (css.match(/[\d.]+/g) ?? []).map(Number);
          const k = css.startsWith("color(") ? 255 : 1;
          return [n[0]! * k, n[1]! * k, n[2]! * k, n.length > 3 ? n[3]! : 1];
        };
        const seen = (el: Element): number => {
          let o = 1;
          for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
          return o;
        };
        const over = (fg: number[], a: number, under: number[]) =>
          [0, 1, 2].map((i) => fg[i]! * a + under[i]! * (1 - a));
        const css = (c: number[]) => `rgb(${c.join(",")})`;
        const ground = rgba(bg);
        const wordsOn = (el: Element, plate: Element) => {
          const o = seen(el);
          const p = rgba(getComputedStyle(plate).backgroundColor);
          const under = over(p, p[3]! * o, ground);
          const c = rgba(getComputedStyle(el).color);
          return ratio(css(over(c, c[3]! * o, under)), css(under));
        };
        const offBox =
          document.querySelector(".react-flow__node.archer-dimmed .archer-node") ??
          document.querySelector(".react-flow__node.archer-dimmed")!;
        const offEdge = document.querySelector(".react-flow__edge.archer-dimmed")!.getAttribute("data-id");
        const caption = document.querySelector(`.archer-edge-label[data-edge-id="${offEdge}"]`)!;
        const onBox = document.querySelector(".react-flow__node.archer-emph--walked")!;
        return {
          line: ratio(stroke, bg),
          box: ratio(border, bg),
          on: wordsOn(onBox, onBox),
          off: wordsOn(offBox, offBox),
          caption: wordsOn(caption, caption),
          quieter: getComputedStyle(offBox).color !== getComputedStyle(onBox).color,
        };
      });
      expect(contrast.line).toBeGreaterThanOrEqual(3);
      expect(contrast.box).toBeGreaterThanOrEqual(3);
      expect(contrast.on, "a walked box's words keep AA").toBeGreaterThanOrEqual(4.5);
      expect(contrast.off, "an off-path box's words keep AA (C-07)").toBeGreaterThanOrEqual(4.5);
      expect(contrast.caption, "an off-path line's caption keeps AA (C-07)").toBeGreaterThanOrEqual(4.5);
      expect(contrast.quieter, "off-path words are still a step quieter than the path's").toBe(true);
    } finally {
      await server.stop();
      await context.close();
    }
  });

  test(`on a phone the panel is a sheet in the stage's dock: ${scheme}`, async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({
      viewport: { width: 400, height: 860 },
      hasTouch: true,
      isMobile: true,
      colorScheme: scheme,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const server = await project();
    try {
      await open(page, server);
      // No side panel on a phone: a chip under the drawing opens it as a sheet, with the walkthroughs listed.
      await expect(page.locator(".archer-walk-divider")).toHaveCount(0);
      const chip = page.locator(".archer-dock-chip--panel");
      await expect(chip).toBeVisible();
      await chip.tap();
      const sheet = page.locator(".archer-dock-sheet");
      await expect(sheet).toBeVisible();
      await sheet.getByRole("button", { name: /Checkout and payment/ }).tap();
      await expect(step(page)).toHaveValue("1");
      // The sheet covers the bar under the graph, so it carries the controls: one set at a time.
      await expect(page.getByRole("button", { name: "Next step" })).toHaveCount(1);
      await sheet.getByRole("button", { name: "Next step" }).tap();
      await sheet.getByRole("button", { name: "Next step" }).tap();
      await expect(step(page)).toHaveValue("3");
      await expect(sheet.locator(".archer-walk-head[aria-expanded='true']")).toContainText("Reserve the stock");
      await page.waitForTimeout(300);
      await shot(page, `phone-${scheme}-step3`);
      // Off-path words keep AA too, so axe checks the whole page (C-07).
      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`))).toEqual([]);
      // Nothing scrolls sideways.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await server.stop();
      await context.close();
    }
  });
}

test("a diagram with no walkthroughs is as it was", async ({ page }) => {
  const server = await sharedTsProject({
    files: {
      ...walkthroughFiles(),
      ".archer/containers.walkthroughs.json": '{"schemaVersion":1,"target":"view:containers","walkthroughs":[]}\n',
    },
  });
  try {
    await open(page, server);
    await page.getByRole("button", { name: "Export, compare and more" }).click();
    await expect(page.getByRole("button", { name: /Walkthroughs/ })).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
  } finally {
    await server.stop();
  }
});

test("15 (wave 2 review): on a phone, Highlights stays one press away while a walkthrough is open, and pressing it closes the walkthrough", async ({
  browser,
}: {
  browser: Browser;
}) => {
  const context = await browser.newContext({ viewport: { width: 400, height: 860 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const server = await project();
  try {
    await open(page, server);
    await server.setEmphasis("containers", [
      {
        id: "focus",
        title: "Checkout path",
        groups: [{ id: "a", style: "highlight", label: "Shop API", nodes: ["api"] }],
      },
    ]);
    // On a phone the switcher is in the panel's sheet (D5), not over the drawing's caption.
    const chip = page.locator(".archer-dock-chip--panel");
    const sheet = page.locator(".archer-dock-sheet");
    const highlights = sheet.getByRole("button", { name: /^Highlights · 1/ });
    await chip.tap();
    await expect(highlights).toBeVisible();
    await sheet.getByRole("button", { name: /^Walkthroughs · 4/ }).tap();
    await sheet.getByRole("button", { name: /Checkout and payment/ }).tap();
    await expect(step(page)).toHaveValue("1");
    // Folded to its chip (a press outside the sheet), the walkthrough stays open; the sheet's ✕ or Escape would leave it.
    await page.locator(".react-flow__pane").tap({ position: { x: 8, y: 8 } });
    await expect(sheet).toHaveCount(0);
    await expect(step(page)).toHaveValue("1");
    await chip.tap();
    await expect(highlights).toBeVisible();
    await expect(highlights).toHaveAttribute("aria-pressed", "false");
    await highlights.tap();
    await expect(step(page)).toHaveCount(0);
    await expect(highlights).toHaveAttribute("aria-pressed", "true");
    await expect(sheet.getByRole("region", { name: "Highlights", exact: true })).toBeVisible();
  } finally {
    await server.stop();
    await context.close();
  }
});
