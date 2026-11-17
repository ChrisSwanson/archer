// Out of date, archived and old-version walkthroughs in a real browser (ADR 0034 §3, slice 7b; the approved
// prototype is the look). An isolated temporary Git project holding slice 1's fixture, whose history has the
// August and 2 October diagrams, so the old version is really found; never the live service.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { TsProject } from "../support/ts-service";
import { commitHistoryAt } from "../support/walkthrough-history";
import { walkthroughFiles } from "../support/walkthrough-project";
import { sharedTsProject } from "./support/shared-service";

const SHOTS = process.env["WALK_SHOTS"];
const project = (history = true): Promise<TsProject> =>
  sharedTsProject({ files: walkthroughFiles(), ...(history ? { beforeAttach: commitHistoryAt } : {}) });

async function open(page: Page, server: TsProject): Promise<void> {
  await server.present("containers");
  await page.goto(server.url);
  await expect(page.locator(".react-flow__node[data-id='api']")).toBeVisible();
}

const panel = (page: Page) => page.getByRole("region", { name: "Walkthrough", exact: true });
const step = (page: Page) => page.getByRole("slider", { name: "Step" });
const note = (page: Page) => panel(page).getByRole("note");

async function choose(page: Page, which: RegExp, scope: "desktop" | "phone" = "desktop"): Promise<void> {
  const press = async (locator: ReturnType<Page["locator"]>) => (scope === "phone" ? locator.tap() : locator.click());
  // On a phone the walkthroughs are listed in the panel's sheet, behind its chip (D5).
  await press(page.locator(scope === "phone" ? ".archer-dock-chip--panel" : ".archer-walk-open"));
  await press(page.getByRole("group", { name: "Walkthroughs on this diagram" }).getByRole("button", { name: which }));
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(SHOTS, `${name}.png`) });
}

test("a partly out-of-date walkthrough plays, with its broken step greyed and explained", async ({ page }) => {
  const server = await project();
  try {
    await open(page, server);
    await choose(page, /Order shipped/);
    await expect(note(page)).toContainText(/Archer flagged this to the agent: \d+ steps? out of date\./);
    await expect(note(page)).toContainText(/The diagram changed( on [^;]+)?; the other \d+ steps? still match?e?s?\./);
    const stale = panel(page).locator(".archer-walk-step.stale");
    await expect(stale.first()).toBeVisible();
    await expect(stale.first().locator(".archer-walk-ood")).toHaveText("Out of date");
    // Grey, never teal.
    const colour = await stale
      .first()
      .locator(".archer-walk-num")
      .evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(colour).not.toMatch(/^rgb\(\s*(?:\d+),\s*(?:1[5-9]\d|2\d\d),\s*(?:1[5-9]\d|2\d\d)\)$/);
    // Stepping reaches it: its body says what it was, and the canvas says it is out of date.
    const number = Number(await stale.first().locator(".archer-walk-num").textContent());
    await page.getByRole("slider", { name: "Step" }).fill(String(number));
    await expect(stale.first()).toContainText(/Was .+, which is no longer in this diagram\./);
    await expect(page.locator(".archer-walk-canvas-note")).toHaveText(
      new RegExp(`Step ${number} is out of date\\. (Its line|What it points at) is no longer in this diagram\\.`),
    );
    await page.getByRole("tab", { name: "Sequence" }).click();
    await expect(page.locator(".archer-walk-seq .archer-seq-message[data-state='stale']").first()).toBeVisible();
    await page.getByRole("tab", { name: "Steps" }).click();
    await shot(page, "s7b-desktop-stale-step");
  } finally {
    await server.stop();
  }
});

test("an archived walkthrough opens on the version it was written for, plays there, and goes back", async ({
  page,
}) => {
  const server = await project();
  try {
    await open(page, server);
    await page.locator(".archer-walk-open").click();
    const list = page.getByRole("group", { name: "Walkthroughs on this diagram" });
    await expect(list.getByRole("heading")).toHaveText(["On This Diagram", "Archived"]);
    await expect(list.getByRole("button", { name: /Pay with the card form/ })).toHaveClass(/archived/);
    await expect(list.getByRole("button", { name: /Pay with the card form/ })).toContainText("written for");
    await shot(page, "s7b-desktop-archived-picker");
    await list.getByRole("button", { name: /Pay with the card form/ }).click();
    await expect(note(page)).toContainText("Archived. None of its 4 steps match this diagram any more.");
    await expect(page.locator(".archer-walk-old")).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("walkthrough")).toBe("pay-with-card-form");
    expect(new URL(page.url()).searchParams.has("step")).toBe(false);
    await shot(page, "s7b-desktop-archived-notice");

    await panel(page).getByRole("button", { name: "Open on the version it was written for" }).click();
    const old = page.locator(".archer-walk-old");
    await expect(old).toBeVisible();
    await expect(old.locator(".archer-walk-old-mark")).toHaveText(/^Old version · 12 Aug/i);
    await expect(old.locator(".react-flow__node[data-id='gateway']")).toBeVisible();
    await expect(old.locator(".react-flow__node[data-id='payments']")).toHaveCount(0);
    await expect(note(page)).toContainText(/Old version: 12 Aug/);
    await expect(panel(page).getByRole("button", { name: "Back to the current diagram" })).toBeFocused();
    expect(new URL(page.url()).searchParams.has("step")).toBe(false);
    // It plays there: the first step lights its line, the next moves on, and nothing is greyed.
    await expect(step(page)).toHaveValue("1");
    await expect(old.locator(".react-flow__edge.archer-emph-style-flow")).not.toHaveCount(0);
    await expect(panel(page).locator(".archer-walk-step.stale")).toHaveCount(0);
    await page.getByRole("button", { name: "Next step" }).click();
    await expect(step(page)).toHaveValue("2");
    await expect(page.locator(".archer-walk-canvas-note")).toHaveCount(0);
    // The live canvas under it cannot be reached.
    expect(
      await page
        .locator(".archer-diagram-content > :not(.archer-walk-old)")
        .first()
        .evaluate((el) => el.hasAttribute("inert")),
    ).toBe(true);
    await shot(page, "s7b-desktop-old-version");

    await panel(page).getByRole("button", { name: "Back to the current diagram" }).click();
    await expect(old).toHaveCount(0);
    await expect(page.locator(".react-flow__node[data-id='payments']")).toBeVisible();
    await expect(note(page)).toContainText("Archived.");
    await expect(panel(page).getByRole("button", { name: "Open on the version it was written for" })).toBeFocused();
  } finally {
    await server.stop();
  }
});

test("a project with no Git history says so, and keeps the text", async ({ page }) => {
  const server = await project(false);
  try {
    await open(page, server);
    await choose(page, /Pay with the card form/);
    await panel(page).getByRole("button", { name: "Open on the version it was written for" }).click();
    await expect(note(page)).toContainText("not in this project's Git history");
    await expect(page.locator(".archer-walk-old")).toHaveCount(0);
    await expect(panel(page).locator(".archer-walk-step").first()).toContainText("Out of date");
  } finally {
    await server.stop();
  }
});

for (const scheme of ["light", "dark"] as const) {
  test(`desktop ${scheme}: the old version, axe and shots`, async ({ browser }: { browser: Browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    const server = await project();
    try {
      await open(page, server);
      await choose(page, /Order shipped/);
      await page.getByRole("slider", { name: "Step" }).fill("3");
      await shot(page, `s7b-desktop-${scheme}-stale`);
      await panel(page)
        .getByRole("button", { name: /Walkthrough/ })
        .first()
        .click();
      await panel(page)
        .getByRole("group", { name: "Walkthroughs on this diagram" })
        .getByRole("button", { name: /Pay with the card form/ })
        .click();
      await shot(page, `s7b-desktop-${scheme}-archived`);
      await panel(page).getByRole("button", { name: "Open on the version it was written for" }).click();
      await expect(page.locator(".archer-walk-old .react-flow__node[data-id='gateway']")).toBeVisible();
      await shot(page, `s7b-desktop-${scheme}-oldversion`);
      const axe = await new AxeBuilder({ page }).analyze();
      expect(axe.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`))).toEqual([]);
    } finally {
      await server.stop();
      await context.close();
    }
  });

  test(`phone ${scheme}: stale step, archived notice and the old version in the sheet`, async ({
    browser,
  }: {
    browser: Browser;
  }) => {
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
      await choose(page, /Order shipped/, "phone");
      const sheet = page.locator(".archer-dock-sheet");
      await expect(sheet.getByRole("note")).toContainText("Archer flagged this to the agent");
      await sheet.getByRole("slider", { name: "Step" }).fill("3");
      await shot(page, `s7b-phone-${scheme}-stale`);
      await sheet.getByRole("button", { name: /Walkthrough Order shipped/ }).tap();
      await sheet
        .getByRole("group", { name: "Walkthroughs on this diagram" })
        .getByRole("button", { name: /Pay with the card form/ })
        .tap();
      await shot(page, `s7b-phone-${scheme}-archived`);
      await sheet.getByRole("button", { name: "Open on the version it was written for" }).tap();
      await expect(page.locator(".archer-walk-old")).toBeVisible();
      await expect(page.locator(".archer-walk-old-mark")).toBeVisible();
      await shot(page, `s7b-phone-${scheme}-oldversion`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await server.stop();
      await context.close();
    }
  });
}
