// The icon scale (styles.css `--icon*`): every chrome control draws one apparent glyph size, one stroke
// and one button, on the graph, sequence and journey canvases, in the editor, the side panel and the
// dialogs, at desktop, touch and phone sizes. Geometry needs Chromium: jsdom lays out no SVG.
//
// ARCHER_ICON_AUDIT_LOGIN (a sign-in link) and ARCHER_ICON_AUDIT_PROJECT (that project's page, ending
// in "/") point an audit at an already running page whose project holds state-composite.mmd,
// seq-awkward.mmd and journey-awkward.mmd. An ordinary run serves its own project from this checkout's
// build (ui/dist).
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const login = process.env.ARCHER_ICON_AUDIT_LOGIN;
const auditProject = process.env.ARCHER_ICON_AUDIT_PROJECT;
type Which = "flow" | "seq" | "journey";
const AUDIT_FILES: Record<Which, string> = {
  flow: "state-composite.mmd",
  seq: "seq-awkward.mmd",
  journey: "journey-awkward.mmd",
};

let project: TsProject | undefined;
test.afterEach(async () => {
  await project?.stop();
  project = undefined;
});

async function open(page: Page, which: Which): Promise<void> {
  if (login !== undefined && auditProject !== undefined) {
    if (!page.url().startsWith(new URL(auditProject).origin)) await page.goto(login);
    await page.goto(`${auditProject}diagrams/${AUDIT_FILES[which]}`);
  } else {
    project ??= await sharedTsProject({
      files: {
        "archer.toml":
          'version = 1\n[[views]]\nid = "flow"\nkind = "freeform"\ntitle = "Flow"\nsource = ".archer/flow.mmd"\n' +
          '[[views]]\nid = "seq"\nkind = "sequence"\ntitle = "Chat"\nsource = ".archer/seq.mmd"\n' +
          '[[views]]\nid = "journey"\nkind = "journey"\ntitle = "Trip"\nsource = ".archer/journey.mmd"\n',
        ".archer/flow.mmd":
          "flowchart LR\n  a[Client] e1@--> b[API]\n  subgraph s[Box]\n    c[Inner]\n  end\n  b e2@--> c\n",
        ".archer/seq.mmd":
          "sequenceDiagram\n  participant A as Customer\n  participant B as Shop\n  A->>B: Order\n  B-->>A: Receipt\n",
        ".archer/journey.mmd":
          "journey\n  title Buying a book\n  section Find\n    Search the shop: 3: Reader\n    Pick a book: 5: Reader\n",
      },
    });
    // A sign-in link, not the legacy token address: only a signed-in browser may edit.
    if (!page.url().startsWith(new URL(project.url).origin))
      await page.goto((await project.issueAccess("Icon audit")).url);
    const slug = new URL(project.url).pathname.split(/\/(?:p|projects)\//)[1]!.split("/")[0]!;
    await page.goto(`${new URL(project.url).origin}/projects/${slug}/${which}.mmd`);
  }
  await expect(
    page
      .locator(which === "journey" ? ".archer-journey-tools" : ".react-flow__controls, .archer-canvas-controls")
      .first(),
  ).toBeVisible();
}

/** What the eye sees of a control's glyph: its drawing's bounds (in px) plus the stroke. */
async function glyph(control: Locator): Promise<{ box: number; apparent: number; stroke: string; effect: string }> {
  return control
    .locator("svg")
    .first()
    .evaluate((svg: SVGSVGElement) => {
      const rect = svg.getBoundingClientRect();
      const scale = svg.viewBox.baseVal?.width ? rect.width / svg.viewBox.baseVal.width : 1;
      const bounds = svg.getBBox();
      const shape = [...svg.querySelectorAll("path, rect, circle, line")].find(
        (part) => getComputedStyle(part).stroke !== "none",
      )!;
      const style = getComputedStyle(shape);
      return {
        box: rect.width,
        apparent: Math.max(bounds.width, bounds.height) * scale + parseFloat(style.strokeWidth),
        stroke: style.strokeWidth,
        effect: style.vectorEffect,
      };
    });
}

/** An icon-only control: a 20px glyph box drawing 12.5–17px, in a true 1.5px stroke. */
async function onScale(control: Locator, box = 20): Promise<void> {
  const drawn = await glyph(control);
  expect(drawn.box, (await control.getAttribute("aria-label")) ?? "").toBe(box);
  expect(drawn.stroke).toBe("1.5px");
  expect(drawn.effect).toBe("non-scaling-stroke");
  expect(drawn.apparent).toBeGreaterThanOrEqual(box === 20 ? 11 : 8);
  expect(drawn.apparent).toBeLessThanOrEqual(box === 20 ? 17 : 14);
}

/** Every control a selector finds, after at least `least` of them have drawn. */
async function each(locator: Locator, least: number): Promise<Locator[]> {
  await expect.poll(() => locator.count()).toBeGreaterThanOrEqual(least);
  return locator.all();
}

/**
 * The canvas column's buttons. "More canvas controls" (`archer-controls-fold`, O95) is drawn only on a phone with a
 * sheet open, and none is open here: it must stay hidden, and it is left out of the buttons measured.
 */
const SHOWN = ":scope > button:not(.archer-controls-fold), :scope .archer-canvas-tools-trigger";

async function size(locator: Locator): Promise<{ width: number; height: number }> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { width: Math.round(box!.width), height: Math.round(box!.height) };
}

/** A menu row is the icon beside its word, the icon at the inline size. */
async function menuRows(page: Page): Promise<void> {
  await page.locator(".archer-canvas-tools-trigger").click();
  for (const row of await each(page.locator(".archer-canvas-tools-menu > button"), 1)) {
    const parts = await row.evaluate((button) => {
      const icon = button.querySelector("svg")!.getBoundingClientRect();
      const range = document.createRange();
      const text =
        [...button.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== "") ??
        button.querySelector("span")!;
      range.selectNodeContents(text);
      const word = range.getBoundingClientRect();
      return {
        iconRight: icon.right,
        iconMiddle: icon.top + icon.height / 2,
        wordLeft: word.left,
        wordMiddle: word.top + word.height / 2,
        icon: icon.width,
      };
    });
    expect(parts.icon).toBe(16);
    expect(parts.wordLeft).toBeGreaterThanOrEqual(parts.iconRight);
    expect(Math.abs(parts.iconMiddle - parts.wordMiddle)).toBeLessThan(3);
  }
  await page.keyboard.press("Escape");
}

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme}: the canvas column, the editor cluster and the bar share one scale`, async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await open(page, "flow");
    const column = page.locator(".react-flow__controls");
    await expect(column).toHaveCSS("gap", "2px");
    await expect(column).toHaveCSS("padding", "3px");
    await expect(column.locator(".archer-controls-fold")).toBeHidden();
    for (const button of await each(column.locator(SHOWN), 7)) {
      expect(await size(button)).toEqual({ width: 44, height: 36 });
      await onScale(button);
    }
    // Every glyph in the cluster is an outline: React Flow's fill never reaches it.
    for (const name of ["Zoom in", "Fit view", "Nested view", "Source"]) {
      const control = column.getByRole("button", { name, exact: true });
      if ((await control.count()) === 0) continue;
      expect(await control.locator("svg").evaluate((svg) => getComputedStyle(svg).fill)).toBe("none");
    }
    // The theme toggle's sun and moon are both on the scale.
    const theme = page.locator(".primary-document-actions .archer-theme-toggle");
    expect(await size(theme)).toEqual({ width: 36, height: 36 });
    await onScale(theme);
    expect(await size(page.locator(".primary-document-actions .archer-notification-toggle"))).toEqual({
      width: 36,
      height: 36,
    });
    await expect(page.locator(".primary-document-actions")).toHaveCSS("column-gap", "12px");
    // The side panel: one 36px button, its glyph on the scale.
    for (const button of await each(page.locator(".archer-panel-collapse, .archer-diagram-key-action"), 2)) {
      expect(await size(button)).toEqual({ width: 36, height: 36 });
      await onScale(button);
    }
    await page.getByRole("button", { name: "Collapse diagram panel" }).click();
    for (const button of await each(page.locator(".archer-diagram-panel[data-collapsed] button"), 2)) {
      expect(await size(button)).toEqual({ width: 36, height: 36 });
      await onScale(button);
    }
    await page.locator(".archer-panel-expand").click();
    await menuRows(page);

    await page.locator(".archer-diagram-edit button").click();
    const editor = page.getByRole("toolbar", { name: "Editing tools" });
    await expect(editor).toBeVisible();
    await expect(editor).toHaveCSS("gap", "2px");
    for (const button of await each(editor.locator("button"), 5)) {
      expect(await size(button)).toEqual({ width: 36, height: 36 });
      await onScale(button);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`${scheme}: sequence and journey wear the same tools`, async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await open(page, "seq");
    for (const button of await each(
      page.locator(".archer-canvas-controls > button, .archer-canvas-controls .archer-canvas-tools-trigger"),
      6,
    )) {
      expect(await size(button)).toEqual({ width: 44, height: 36 });
      await onScale(button);
    }
    await menuRows(page);
    await open(page, "journey");
    const trigger = page.locator(".archer-journey-tools .archer-canvas-tools-trigger");
    expect(await size(trigger)).toEqual({ width: 44, height: 36 });
    await onScale(trigger);
    await menuRows(page);
  });
}

test("the dialogs' Close and the review's Close are on the scale", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await open(page, "flow");
  // The review takes the side panel's place once the panel is there; pressed before it mounts, the review
  // opens as its own sidebar and then moves into the panel, and the Close measured first is replaced.
  await expect(page.locator(".archer-diagram-panel")).toBeVisible();
  await page.locator(".primary-document-actions .archer-notification-toggle").click();
  const close = page.locator(".primary-icon-close").first();
  await expect(close).toBeVisible();
  expect(await size(close)).toEqual({ width: 36, height: 36 });
  await onScale(close);
  await page.keyboard.press("Escape");
  await page.locator(".archer-settings-launcher").first().click();
  const settings = page.locator(".archer-settings-close");
  await expect(settings).toBeVisible();
  expect(await size(settings)).toEqual({ width: 36, height: 36 });
  await onScale(settings);
});

test.describe("touch", () => {
  test.use({ hasTouch: true });
  test("every control is at least 44px; the glyphs keep the scale", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    await open(page, "flow");
    for (const selector of [
      ".primary-document-actions .archer-theme-toggle",
      ".primary-document-actions .archer-notification-toggle",
      ".archer-panel-collapse",
      ".archer-diagram-key-action",
    ]) {
      const target = await size(page.locator(selector).first());
      expect(target.width, selector).toBeGreaterThanOrEqual(44);
      expect(target.height, selector).toBeGreaterThanOrEqual(44);
      await onScale(page.locator(selector).first());
    }
    for (const button of await each(
      page.locator(".react-flow__controls").locator(":scope > button:not(.archer-controls-fold)"),
      6,
    )) {
      expect((await size(button)).height).toBe(44);
      await onScale(button);
    }
  });

  test("a short phone keeps every canvas control in the drawing", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 460 });
    await open(page, "flow");
    const column = page.locator(".react-flow__controls");
    await expect(column.locator(".archer-controls-fold")).toBeHidden();
    const bottom = (await column.boundingBox())!.y + (await column.boundingBox())!.height;
    for (const button of await each(column.locator(SHOWN), 7)) {
      const box = (await button.boundingBox())!;
      expect(box.y + box.height, (await button.getAttribute("aria-label")) ?? "").toBeLessThanOrEqual(bottom);
      expect(box.height).toBeGreaterThanOrEqual(24);
      await onScale(button);
    }
  });
});
