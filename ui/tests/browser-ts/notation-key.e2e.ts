/** Reader-facing notation, through the real Mermaid/service/page pipeline. */
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO = resolve(HERE, "../../../ts/test/fixtures/pageturner/.archer/diagrams");
let project: TsProject | undefined;
test.afterEach(async () => {
  await project?.stop();
  project = undefined;
});
async function open(page: Page, id: string, kind: string): Promise<void> {
  project = await sharedTsProject({
    files: {
      "archer.toml": `version = 1\n[[views]]\nid = "drawing"\nkind = "${kind}"\ntitle = "Drawing"\nsource = ".archer/drawing.mmd"\n`,
      ".archer/drawing.mmd":
        id === "flowchart"
          ? "flowchart LR\n  input[Request]:::external e1@--> gate{Valid?}\n"
          : readFileSync(resolve(DEMO, `${id}.mmd`), "utf8"),
    },
  });
  await page.goto(project.url);
  await project.present("drawing");
  // A phone has the key in the panel's sheet, behind its chip (D5).
  await expect(
    page
      .getByRole("button", { name: "Diagram Key", exact: true })
      .or(page.locator(".archer-stage-dock .archer-dock-chip--panel")),
  ).toBeVisible();
}

test("journey key explains the score and rail without resizing the drawing", async ({ page }) => {
  // In the side panel the key takes none of the drawing's room (D5), so it starts open even on a small stage;
  // closing and opening it leaves the drawing as it was.
  await page.setViewportSize({ width: 1024, height: 768 });
  await open(page, "buying-a-book", "journey");
  const button = page.getByRole("button", { name: "Diagram Key", exact: true });
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  const before = await page.locator(".archer-diagram-content").boundingBox();
  await expect(page.getByRole("region", { name: "Diagram Key" })).toBeVisible();
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Enter");
  const key = page.getByRole("region", { name: "Diagram Key" });
  await expect(key).toContainText("1 is least satisfied; 5 is most satisfied");
  await expect(key).toContainText("left rail");
  expect((await new AxeBuilder({ page }).include(".archer-diagram-key").analyze()).violations).toEqual([]);
  const content = await page.locator(".archer-diagram-content").boundingBox();
  const panel = await key.boundingBox();
  expect(content).toEqual(before);
  expect(panel!.y).toBeGreaterThanOrEqual(content!.y);
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(content!.y + content!.height + 1);
  await button.focus();
  await page.keyboard.press("Escape");
  await expect(key).toBeVisible();
  await expect(button).toBeFocused();
});

for (const width of [390, 420])
  for (const theme of ["light", "dark"] as const)
    test(`${width}px ${theme} C4 heading and truthful overflow cue keep separate space`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await open(page, "containers", "c4");
      const heading = page.locator(".archer-canvas-heading");
      const cue = page.locator(".archer-offscreen-cue");
      await expect(heading).toBeVisible();
      await expect(cue).toBeVisible();
      await expect
        .poll(async () => {
          const h = await heading.boundingBox();
          const c = await cue.boundingBox();
          return h!.x < c!.x + c!.width && h!.x + h!.width > c!.x && h!.y < c!.y + c!.height && h!.y + h!.height > c!.y;
        })
        .toBe(false);
      await expect(cue).toContainText("Show all");
    });

const TYPES = [
  ["flowchart", "freeform", "External"],
  ["system-context", "c4-context", "Person"],
  ["containers", "c4", "Queue"],
  ["checkout", "sequence", "Reply"],
  ["order-lifecycle", "state", "Composite state"],
  ["data-model", "entity-relationship", "PK"],
  ["deployment", "architecture", "Architecture group"],
  ["buying-a-book", "journey", "Score rail"],
] as const;
// The theme sets colours only (styles.css: its light and dark blocks hold custom properties), so the footprint
// is the same in both: each type is measured in one theme at each width, the two alternating so every width and
// every type meets both.
for (const [w, width] of [1440, 390, 420].entries())
  for (const [t, [id, kind, meaning]] of TYPES.entries()) {
    const theme = (["light", "dark"] as const)[(w + t) % 2]!;
    test(`${id}: ${width}px ${theme} key stays within its corner footprint`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await open(page, id, kind);
      if (id === "flowchart" || id === "system-context")
        await expect(page.locator('[data-notation="flowchart"]')).toBeVisible();
      const button = page.getByRole("button", { name: "Diagram Key", exact: true });
      const before = await page.locator(".archer-diagram-content").boundingBox();
      const docked = width < 600;
      const chip = page.locator(".archer-stage-dock .archer-dock-chip--panel");
      if (docked) await chip.click();
      else {
        await expect(page.getByRole("region", { name: "Diagram Key" })).toBeVisible();
        if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
      }
      const key = page.getByRole("region", { name: "Diagram Key" });
      await expect(key).toContainText(meaning);
      const content = await page.locator(".archer-diagram-content").boundingBox();
      expect(content).toEqual(before);
      if (docked) {
        // A phone: the panel is a chip under the drawing, and its sheet stays on screen (G1, D5).
        expect((await chip.boundingBox())!.y).toBeGreaterThanOrEqual(content!.y + content!.height - 1);
        const sheet = (await page.getByRole("dialog", { name: "Diagram Key" }).boundingBox())!;
        expect(sheet.x).toBeGreaterThanOrEqual(0);
        expect(sheet.x + sheet.width).toBeLessThanOrEqual(width + 1);
        expect(sheet.y + sheet.height).toBeLessThanOrEqual(844 + 1);
      } else {
        // Beside the drawing, in the side panel (D5), not over it.
        const panel = await key.boundingBox();
        expect(panel!.y).toBeGreaterThanOrEqual(content!.y);
        expect(panel!.y + panel!.height).toBeLessThanOrEqual(content!.y + content!.height + 1);
        expect(panel!.x).toBeGreaterThanOrEqual(content!.x + content!.width - 1);
        expect(panel!.x + panel!.width).toBeLessThanOrEqual(width);
        const toggle = await button.boundingBox();
        expect(toggle!.y + toggle!.height).toBeLessThanOrEqual(844);
      }
      if (process.env.ARCHER_SHOTS)
        await page.screenshot({ path: `${process.env.ARCHER_SHOTS}/key-${id}-${width}-${theme}.png` });
    });
  }

// The key is beside the drawing (D5): nothing covers the drawing's right or bottom strips.
for (const width of [1440, 390])
  for (const [id, kind] of TYPES) {
    test(`${id}: ${width}px full canvas remains usable outside corner key`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await open(page, id, kind);
      const key = page.getByRole("region", { name: "Diagram Key", exact: true });
      // A phone docks the panel as a chip under the drawing (G1); elsewhere the key is in the side panel.
      if (width < 600) await expect(page.locator(".archer-stage-dock .archer-dock-chip--panel")).toBeVisible();
      else await expect(key).toBeVisible();
      const content = page.locator(".archer-diagram-content");
      await expect
        .poll(() =>
          content.evaluate((element) => {
            const style = getComputedStyle(element);
            return [style.paddingRight, style.paddingBottom];
          }),
        )
        .toEqual(["0px", "0px"]);
      // Probe the former dead right/bottom strips away from the actual key.
      // These points must land inside the drawing, not on its empty wrapper.
      const hits = await content.evaluate((element) => {
        const r = element.getBoundingClientRect();
        // Above the key, which may be open to its rows on a roomy stage.
        const keyTop =
          document.querySelector(".archer-stage > .archer-diagram-key")?.getBoundingClientRect().top ?? r.bottom;
        // The key rests at the bottom left, so the bottom probe is the right: clear of the chat bubble's corner.
        return [
          [r.right - 20, Math.min(r.top + r.height / 2, keyTop - 20)],
          [r.right - 100, r.bottom - 20],
        ].map(([x, y]) => {
          const hit = document.elementFromPoint(x!, y!);
          return hit !== element && hit !== null && element.contains(hit);
        });
      });
      expect(hits).toEqual([true, true]);
      if (id === "checkout") {
        const viewport = page.locator(".archer-seq-viewport");
        const before = await viewport.getAttribute("transform");
        const r = (await content.boundingBox())!;
        // Above the key, which may be open to its rows on a roomy stage.
        const keyTop = await page.evaluate(
          (bottom) =>
            document.querySelector(".archer-stage > .archer-diagram-key")?.getBoundingClientRect().top ?? bottom,
          r.y + r.height,
        );
        const start =
          width < 720
            ? { x: r.x + 90, y: r.y + r.height - 20 }
            : { x: r.x + r.width - 20, y: Math.min(r.y + r.height / 2, keyTop - 20) };
        expect(
          await page.evaluate(({ x, y }) => {
            const hit = document.elementFromPoint(x, y);
            return (
              hit?.closest(".archer-seq-canvas") !== null &&
              hit?.closest(".archer-canvas-controls, .archer-diagram-key") === null
            );
          }, start),
        ).toBe(true);
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        await page.mouse.move(start.x + (width < 720 ? 40 : -40), start.y - 40, { steps: 4 });
        await page.mouse.up();
        await expect.poll(() => viewport.getAttribute("transform")).not.toBe(before);
        const moved = await viewport.getAttribute("transform");
        await (width < 600
          ? page.locator(".archer-stage-dock .archer-dock-chip--panel")
          : page.getByRole("button", { name: "Diagram Key", exact: true })
        ).click();
        expect(await viewport.getAttribute("transform")).toBe(moved);
      }
    });
  }
