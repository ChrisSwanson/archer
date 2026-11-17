/** Independent acceptance checks the key's place (the side panel, beside the drawing; 0.6.4 D5) and disclosure. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";
const HERE = dirname(fileURLToPath(import.meta.url));
let project: TsProject | undefined;
test.afterEach(async () => {
  await project?.stop();
  project = undefined;
});
for (const width of [1440, 390, 420])
  for (const theme of ["light", "dark"] as const)
    for (const [id, kind] of [
      ["containers", "c4"],
      ["deployment", "architecture"],
      ["buying-a-book", "journey"],
    ] as const) {
      test(`${id} ${width}px ${theme}: the key beside the drawing preserves its full viewport and disclosure camera`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        project = await sharedTsProject({
          files: {
            "archer.toml": `version = 1\n[[views]]\nid = "drawing"\nkind = "${kind}"\ntitle = "Drawing"\nsource = ".archer/drawing.mmd"\n`,
            ".archer/drawing.mmd": readFileSync(
              resolve(HERE, `../../../ts/test/fixtures/pageturner/.archer/diagrams/${id}.mmd`),
              "utf8",
            ),
          },
        });
        await page.goto(project.url);
        await project.present("drawing");
        const key = page.getByRole("region", { name: "Diagram Key", exact: true });
        const button = page.getByRole("button", { name: "Diagram Key", exact: true });
        // A phone docks the panel, key and all, as a chip under the drawing (G1); elsewhere the key is the side
        // panel's bottom section, beside the drawing and never over it.
        const docked = width < 600;
        const chip = page.locator(".archer-stage-dock .archer-dock-chip--panel");
        await expect(docked ? chip : button).toBeVisible();
        const content = await page.locator(".archer-diagram-content").boundingBox();
        if (docked) expect((await chip.boundingBox())!.y).toBeGreaterThanOrEqual(content!.y + content!.height - 1);
        else {
          await expect(key).toBeVisible();
          const box = await key.boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(content!.x + content!.width - 1);
          expect(box!.y + box!.height).toBeLessThanOrEqual(content!.y + content!.height + 1);
          // Start from the closed header, whatever this stage's default was.
          if ((await button.getAttribute("aria-expanded")) === "true") await button.click();
          await expect(button).toHaveAttribute("aria-expanded", "false");
        }
        if (id !== "buying-a-book") {
          const show = page.getByRole("button", { name: /Show all/ });
          if (await show.count()) await show.click();
          const canvas = await page.locator(".react-flow").boundingBox();
          await page.mouse.move(canvas!.x + 8, canvas!.y + canvas!.height / 2);
          await page.mouse.down();
          await page.mouse.move(canvas!.x + 48, canvas!.y + canvas!.height / 2 + 20, { steps: 4 });
          await page.mouse.up();
        } else {
          const board = page.locator(".archer-journey-board");
          const range = await board.evaluate((e) => ({
            vertical: e.scrollHeight - e.clientHeight,
            horizontal: e.scrollWidth - e.clientWidth,
          }));
          if (width < 720) expect(range.vertical).toBeGreaterThan(0);
          for (const fraction of [0.5, 1]) {
            await board.evaluate((e, f) => {
              e.scrollTop = (e.scrollHeight - e.clientHeight) * f;
            }, fraction);
            await expect
              .poll(async () => Math.abs((await board.evaluate((e) => e.scrollTop)) - range.vertical * fraction))
              .toBeLessThanOrEqual(1);
            if (range.vertical > 0) expect(await board.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
          }
          // Exercise horizontal overflow when present; phones deliberately stack cards.
          await board.evaluate((e) => {
            e.scrollLeft = e.scrollWidth - e.clientWidth;
          });
          await expect
            .poll(async () => Math.abs((await board.evaluate((e) => e.scrollLeft)) - range.horizontal))
            .toBeLessThanOrEqual(1);
          if (width < 720) expect(range.horizontal).toBe(0);
        }
        const viewport = page.locator(".react-flow__viewport"),
          camera = (await viewport.count()) ? await viewport.getAttribute("style") : null;
        if (docked) await chip.click();
        else {
          await button.click();
          await expect(button).toHaveAttribute("aria-expanded", "true");
        }
        expect(await page.locator(".archer-diagram-content").boundingBox()).toEqual(content);
        if (camera !== null) expect(await viewport.getAttribute("style")).toEqual(camera);
        await expect(key.locator("dd").first()).toBeVisible();
      });
    }
test("legend explanations can be scrolled with the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "drawing"\nkind = "c4"\ntitle = "Drawing"\nsource = ".archer/drawing.mmd"\n',
      ".archer/drawing.mmd": readFileSync(
        resolve(HERE, "../../../ts/test/fixtures/pageturner/.archer/diagrams/containers.mmd"),
        "utf8",
      ),
    },
  });
  await page.goto(project.url);
  await project.present("drawing");
  // On a phone the panel opens as a sheet (G1, D5): focus starts on its Close, and Tab reaches the scrolling body.
  await page.locator(".archer-stage-dock .archer-dock-chip--panel").click();
  const sheet = page.getByRole("dialog", { name: "Diagram Key", exact: true });
  await expect(sheet.getByRole("button", { name: "Close Diagram Key", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  const symbols = sheet.locator(".archer-dock-sheet-body");
  await expect(symbols).toBeFocused();
  expect(await symbols.evaluate((e) => e.scrollHeight - e.clientHeight)).toBeGreaterThan(0);
  await page.keyboard.press("End");
  await expect.poll(() => symbols.evaluate((e) => e.scrollTop)).toBeGreaterThan(0);
});
