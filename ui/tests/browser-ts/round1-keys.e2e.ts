/** F4: the built page on a fresh project of this worker's shared TypeScript service for each test. */
import { expect, test } from "@playwright/test";
import type { TsProject } from "../support/ts-service";
import { sharedTsProject } from "./support/shared-service";

test.describe.configure({ timeout: 90_000 });

let project: TsProject;
let url: string;

test.beforeEach(async () => {
  project = await sharedTsProject({
    files: {
      "archer.toml":
        'version=1\n[[views]]\nid="system"\nkind="freeform"\ntitle="System"\nsource=".archer/system.mmd"\n[[views]]\nid="other"\nkind="freeform"\ntitle="Other"\nsource=".archer/other.mmd"\n',
      ".archer/system.mmd": "flowchart LR\nweb[Web] e1@--> api[API]\n",
      ".archer/other.mmd": "flowchart LR\nother[Other]\n",
    },
  });
  url = project.url;
});
test.afterEach(async () => {
  await project.stop();
});

for (const width of [1500, 390])
  test(`#9/#24 Settings keyboard switch persists and preserves focus at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    // The service's token entry establishes access.
    await project.present("system");
    await page.request.get(project.url);
    await page.goto(url);
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    if (width === 390) await page.getByRole("button", { name: "Menu", exact: true }).click();
    const settings = page.getByRole("button", { name: "Archer settings" });
    await settings.click();
    const dialog = page.getByRole("dialog", { name: "Archer Settings" });
    await expect(dialog).toBeFocused();
    await expect(dialog.getByRole("button", { name: /close/i })).toHaveCount(1);
    const toggle = dialog.getByRole("checkbox", { name: "Single-character shortcuts" });
    if (width === 390) expect((await toggle.locator("..").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await toggle.uncheck();
    await expect(toggle).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("keyboard-settings.png") });
    // Tab moves to the next preference (Curved lines, the last control), then wraps back to the header close.
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("checkbox", { name: "Curved lines" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close settings" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(settings).toBeFocused();
    if (width === 390) await page.keyboard.press("Escape");
    const theme = page.locator(".archer-theme-toggle");
    // Focus outside the canvas matches the original repro. Off includes Help and comment/chat.
    if (width === 1500) await theme.focus();
    await page.keyboard.press("?");
    await page.keyboard.press("c");
    await page.keyboard.press("]");
    await expect(page.locator('.react-flow__node[data-id="web"]')).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Keyboard & Pointer" })).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Message to the agent", exact: true })).toHaveCount(0);
    await page.reload();
    if (width === 390) await page.getByRole("button", { name: "Menu", exact: true }).click();
    await settings.click();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await page.keyboard.press("Escape");
    if (width === 390) await page.keyboard.press("Escape");
    if (width === 1500) await theme.focus();
    await page.keyboard.press("?");
    const help = page.getByRole("dialog", { name: "Keyboard & Pointer" });
    await expect(help).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).toHaveCount(0);
    await page.keyboard.press("]");
    await expect(page.locator('.react-flow__node[data-id="other"]')).toBeVisible();
    await page.keyboard.press("c");
    await expect(page.getByRole("textbox", { name: "Message to the agent", exact: true })).toBeVisible();
  });
