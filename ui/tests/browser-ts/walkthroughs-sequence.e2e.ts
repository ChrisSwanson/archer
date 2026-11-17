// The walkthroughs' Sequence tab in a real browser (ADR 0034 §6; the approved prototype is the look):
// the steps drawn as a sequence, the current message lit and moving, stepping by wheel and keys over
// the tab, a press on a message seeking to its step, the current message scrolled into view, the tab
// remembered, and the phone's sheet. An isolated project holding slice 1's fixture; never the live service.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { TsProject } from "../support/ts-service";
import { walkthroughFiles } from "../support/walkthrough-project";
import { sharedTsProject } from "./support/shared-service";

const SHOTS = process.env["WALK_SHOTS"];
const project = (): Promise<TsProject> => sharedTsProject({ files: walkthroughFiles() });

async function open(page: Page, server: TsProject): Promise<void> {
  await server.present("containers");
  await page.goto(server.url);
  await expect(page.locator(".react-flow__node[data-id='api']")).toBeVisible();
}

const panel = (page: Page) => page.getByRole("region", { name: "Walkthrough", exact: true });
const step = (page: Page) => page.getByRole("slider", { name: "Step" });
const messages = (page: Page) => page.locator(".archer-walk-seq .archer-seq-message");

async function startDeclined(
  page: Page,
  scope: "desktop" | "phone" = "desktop",
  which: RegExp = /Declined card/,
): Promise<void> {
  const tap = scope === "phone";
  const press = async (locator: ReturnType<Page["locator"]>) => (tap ? locator.tap() : locator.click());
  // On a phone the walkthroughs are listed in the panel's sheet, behind its chip (D5).
  await press(page.locator(tap ? ".archer-dock-chip--panel" : ".archer-walk-open"));
  await press(page.getByRole("group", { name: "Walkthroughs on this diagram" }).getByRole("button", { name: which }));
  await expect(step(page)).toHaveValue("1");
  await press(page.getByRole("tab", { name: "Sequence" }));
  await expect(messages(page).first()).toBeVisible();
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

test("the tab draws every message, lights the current one and steps by wheel, keys and a press", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await startDeclined(page);
    await expect(messages(page)).toHaveCount(7);
    await expect(page.locator(".archer-walk-seq .archer-seq-participant")).toHaveCount(5);
    await expect(messages(page).nth(0)).toHaveAttribute("data-state", "active");
    await expect(messages(page).nth(0)).toHaveClass(/archer-emph-style-flow/);
    await expect(messages(page).nth(0).locator("animateMotion").first()).toBeAttached();
    await expect(messages(page).nth(2)).toHaveAttribute("data-state", "future");
    // The graph shows the same step, through the same emphasis.
    await expect(page.locator(".react-flow__edge.archer-emph-style-flow")).not.toHaveCount(0);

    const wrap = (await page.locator(".archer-walk-seq-wrap").boundingBox())!;
    await page.mouse.move(wrap.x + wrap.width / 2, wrap.y + wrap.height / 2);
    await page.mouse.wheel(0, 100);
    await expect(step(page)).toHaveValue("2");
    await expect(messages(page).nth(0)).toHaveAttribute("data-state", "done");
    await expect(messages(page).nth(2)).toHaveAttribute("data-state", "active");
    await expect(messages(page).nth(0)).toHaveClass(/archer-emph--walked/);
    await page.waitForTimeout(700);
    await page.keyboard.press("ArrowDown");
    await expect(step(page)).toHaveValue("3");
    await expect(panel(page).locator(".archer-walk-seq-card")).toContainText("The card is declined");

    // A press on a message seeks to its step.
    await page.getByRole("button", { name: /^Step 5: .*/ }).click();
    await expect(step(page)).toHaveValue("5");
    await page
      .getByRole("button", { name: /^Step 1: .*/ })
      .first()
      .focus();
    await page.keyboard.press("Enter");
    await expect(step(page)).toHaveValue("1");
    // Step 1 has two messages, both current.
    await expect(page.locator("[role='button'][aria-current='step']")).toHaveCount(2);
  } finally {
    await server.stop();
  }
});

test("a sequence wider than the panel scrolls sideways to the current message, and a sideways wheel scrolls it", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    // The narrowest panel: six participants no longer fit it.
    await page.locator(".archer-walk-open").click();
    const divider = page.getByRole("separator", { name: "Resize diagram panel" });
    await divider.focus();
    for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
    await page
      .getByRole("group", { name: "Walkthroughs on this diagram" })
      .getByRole("button", { name: /Checkout and payment/ })
      .click();
    await page.getByRole("tab", { name: "Sequence" }).click();
    const wrap = page.locator(".archer-walk-seq-wrap");
    expect(await wrap.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    const inside = async () =>
      page
        .locator(".archer-walk-seq .archer-seq-message[data-state='active']")
        .first()
        .evaluate((el) => {
          const box = el.getBoundingClientRect();
          const at = el.closest(".archer-walk-seq-wrap")!.getBoundingClientRect();
          const middle = (box.left + box.right) / 2;
          return middle >= at.left && middle <= at.right;
        });
    await page.getByRole("button", { name: "Last step" }).click();
    await expect(step(page)).toHaveValue("8");
    await expect.poll(inside).toBe(true);
    await expect.poll(() => wrap.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await page.getByRole("button", { name: "First step" }).click();
    await expect.poll(inside).toBe(true);
    await expect.poll(() => wrap.evaluate((el) => el.scrollLeft)).toBe(0);
    const box = (await wrap.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(120, 0);
    await expect.poll(() => wrap.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await expect(step(page)).toHaveValue("1");
  } finally {
    await server.stop();
  }
});

test("the tab is remembered, and the Steps tab is as it was", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await startDeclined(page);
    await page.getByRole("tab", { name: "Steps" }).click();
    await expect(panel(page).locator(".archer-walk-head[aria-expanded='true']")).toHaveCount(1);
    await page.getByRole("tab", { name: "Sequence" }).click();
    await page.reload();
    await expect(page.locator(".react-flow__node[data-id='api']")).toBeVisible();
    // The address brings the walkthrough back open, on the tab the person left.
    await expect(page.getByRole("tab", { name: "Sequence" })).toHaveAttribute("aria-selected", "true");
    await expect(messages(page).first()).toBeVisible();
  } finally {
    await server.stop();
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`mid-walkthrough on a desktop: axe, and a shot: ${scheme}`, async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    const server = await project();
    try {
      await open(page, server);
      await startDeclined(page);
      await page.getByRole("button", { name: "Next step" }).click();
      await page.getByRole("button", { name: "Next step" }).click();
      await expect(step(page)).toHaveValue("3");
      await page.waitForTimeout(500);
      await shot(page, `s6-desktop-${scheme}-sequence`);
      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`))).toEqual([]);
    } finally {
      await server.stop();
      await context.close();
    }
  });

  test(`on a phone the tab is in the sheet: ${scheme}`, async ({ browser }: { browser: Browser }) => {
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
      await startDeclined(page, "phone");
      const sheet = page.locator(".archer-dock-sheet");
      await sheet.getByRole("button", { name: "Next step" }).tap();
      await sheet.getByRole("button", { name: "Next step" }).tap();
      await expect(step(page)).toHaveValue("3");
      await expect(sheet.locator(".archer-seq-message[data-state='active']")).toHaveCount(1);
      // The sheet's settle before a picture; a normal run has no picture to wait for.
      if (SHOTS !== undefined) await page.waitForTimeout(500);
      await shot(page, `s6-phone-${scheme}-sequence`);
      await sheet.getByRole("button", { name: /^Step 5: .*/ }).tap();
      await expect(step(page)).toHaveValue("5");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await server.stop();
      await context.close();
    }
  });
}
