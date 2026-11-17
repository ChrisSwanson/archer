import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { type StaticServer, serveStatic } from "../../../site/tests/serve-static.ts";
let server: StaticServer, origin: string;
const root = resolve(process.env.ARCHER_PLAYGROUND_PUBLIC ?? "../site/public");
test.beforeAll(async () => {
  server = await serveStatic(root, ["/", "/archer/"]);
  origin = server.origin;
});
test.afterAll(() => server?.close());
for (const base of ["/", "/archer/"])
  test(`Pages directory URL opens and canonicalizes at ${base}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}${base}playground/app/`);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${base}playground/app/index.html\\?route=`));
    await expect(page.getByText(/Changed on disk/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "New", exact: true })).toHaveCount(0);
    const copied = page.url();
    await page.goto(copied.replace("app/index.html", "app/"));
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    // Every copied directory route becomes the one fixed document, including query and fragment.
    await expect(page).toHaveURL(copied);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.getByText("Editing is on desktop")).toHaveCount(0);
      const bar = page.getByRole("region", { name: "Example playground" });
      await expect(bar).toBeVisible();
      expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(160);
      const select = page.getByRole("combobox", { name: "Project" });
      expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.getByText("About this demo", { exact: true }).click();
      await expect(page.getByText(/Agent chat and delivery/)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.getByText("About this demo", { exact: true }).click();
    }
    expect(errors).toEqual([]);
  });
for (const base of ["/", "/archer/"])
  test(`static App comments, playback and copied routes at ${base}`, async ({ page }) => {
    const unexpected: string[] = [];
    const documentPath = `${base}playground/app/index.html`;
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (
        url.origin === origin &&
        // Only the document's own published files (chunks, data, worker) and the docs site's shared fonts.
        (url.pathname.startsWith(`${base}playground/app/`) || url.pathname.startsWith(`${base}fonts/`))
      )
        return route.continue();
      unexpected.push(url.href);
      return route.abort();
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}${documentPath}`);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(page.getByText("Example · Changes stay in this browser · No agent connected.")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Project" })).toHaveValue("archer-tour");
    // After the view and ELK are loaded, all graph interaction is independent of the asset server too.
    await page.route("**/*", (route) => {
      unexpected.push(route.request().url());
      return route.abort();
    });
    await page.keyboard.press("c");
    await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Browser-local example comment");
    await page.getByRole("button", { name: "Save comment", exact: true }).click();
    await expect(page.getByText("Browser-local example comment", { exact: true })).toBeVisible();
    await expect(page.getByText("Saved locally", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /send.*agent|send queued/i })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /^Walkthroughs/ }).click();
    await page.getByRole("group", { name: "Walkthroughs on this diagram" }).getByRole("button").first().click();
    await expect(page.getByRole("slider", { name: "Step" })).toHaveValue("1");
    await page.getByRole("button", { name: "Next step", exact: true }).click();
    await expect(page.getByRole("slider", { name: "Step" })).toHaveValue("2");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
    await page.unrouteAll();
    await page.reload();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await expect(page).toHaveURL(new RegExp(documentPath.replaceAll("/", "\\/") + "\\?route="));
    await page.getByRole("combobox", { name: "Project" }).selectOption("rfc-2324-htcpcp");
    await expect(page.getByRole("combobox", { name: "Project" })).toHaveValue("rfc-2324-htcpcp");
    await page.goBack();
    await expect(page.getByRole("combobox", { name: "Project" })).toHaveValue("archer-tour");
    await page.evaluate(() => localStorage.setItem("ordinary-docs-pref", "preserved"));
    await page.getByRole("button", { name: "Reset demo", exact: true }).click();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).filter((k) => k.startsWith("archer:playground:") && k.endsWith(":comments")),
      ),
    ).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem("ordinary-docs-pref"))).toBe("preserved");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.getByRole("combobox", { name: "Project" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
  });
for (const base of ["/", "/archer/"])
  test(`the bar leads back to the docs at ${base}, from any route the Playground shows`, async ({ page }) => {
    await page.goto(`${origin}${base}playground/app/`);
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    const docs = page.getByRole("link", { name: "Archer docs", exact: true });
    await expect(docs).toBeVisible();
    const resolved = () => docs.evaluate((link: HTMLAnchorElement) => link.href);
    expect(await resolved()).toBe(`${origin}${base}using-the-playground`);
    await page.getByRole("combobox", { name: "Project" }).selectOption({ index: 1 });
    await expect(page).toHaveURL(/route=/);
    expect(await resolved()).toBe(`${origin}${base}using-the-playground`);
  });
/**
 * The canvas's control column is the app's: the same stylesheets win over React Flow's defaults. The Playground loads
 * its view's chunk after its entry's stylesheet, which put React Flow's own button fill, separators and ink after the
 * page's overrides, and the phone-only fold (O95) after the rule that hides it everywhere else (owner, 2026-11-15).
 */
test("the canvas controls are drawn and offered as the app's are", async ({ page }) => {
  await page.goto(`${origin}/archer/playground/app/`);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  const column = page.locator(".react-flow__controls");
  const zoomIn = column.getByRole("button", { name: "Zoom in", exact: true });
  await expect(zoomIn).toBeVisible();
  // Folding is for a phone with a sheet open; on a desktop every control is in the column and no fold is drawn.
  await expect(column.locator(".archer-controls-fold")).toBeHidden();
  // A static host offers none of export, compare or accuracy (each needs the service): no launcher for an empty menu.
  await expect(column.getByRole("button", { name: "Export, compare and more" })).toHaveCount(0);
  const drawn = await zoomIn.evaluate((button) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text-dim)";
    button.parentElement!.append(probe);
    const textDim = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(button);
    return {
      background: style.backgroundColor,
      separator: style.borderBottomStyle,
      ink: style.color === textDim,
      shadow: getComputedStyle(button.parentElement!).boxShadow.includes("2px 10px"),
    };
  });
  expect(drawn).toEqual({ background: "rgba(0, 0, 0, 0)", separator: "none", ink: true, shadow: true });
});
/**
 * On a phone the example bar is one row, the drawing keeps the screen: provenance, the project and the About
 * disclosure; the way back to the docs and Reset wait inside About (owner, 2026-11-15: it wrapped to ~126px).
 * The desktop bar keeps every control in view.
 */
test("the example bar is one short row on a phone and keeps its controls one tap away", async ({ page }) => {
  await page.goto(`${origin}/archer/playground/app/`);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  const bar = page.getByRole("region", { name: "Example playground" });
  const docs = page.getByRole("link", { name: "Archer docs", exact: true });
  const reset = page.getByRole("button", { name: "Reset demo", exact: true });
  const about = bar.locator("summary").filter({ hasText: "About" });
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByText("Example · Changes stay in this browser · No agent connected.")).toBeVisible();
    await expect(docs).toBeVisible();
    await expect(reset).toBeVisible();
    expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(56);
  }
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const box = (await bar.boundingBox())!;
    expect(box.height, `the bar at ${width}px`).toBeGreaterThanOrEqual(44);
    expect(box.height, `the bar at ${width}px`).toBeLessThanOrEqual(50);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await expect(bar.getByText(/^Example/u).filter({ visible: true })).toHaveCount(1);
    const select = page.getByRole("combobox", { name: "Project" });
    await expect(select).toBeVisible();
    expect((await select.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(about).toBeVisible();
    expect((await about.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // Nothing in the row spills out of the bar or off the screen.
    for (const control of [select, about]) {
      const own = (await control.boundingBox())!;
      expect(own.x).toBeGreaterThanOrEqual(0);
      expect(own.x + own.width).toBeLessThanOrEqual(width);
      expect(own.y + own.height).toBeLessThanOrEqual(box.y + box.height + 0.5);
    }
    await expect(docs).toBeHidden();
    await expect(reset).toBeHidden();
    await about.click();
    await expect(docs).toBeVisible();
    await expect(reset).toBeVisible();
    await expect(page.getByText(/stay in this browser/u).filter({ visible: true })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await about.click();
    await expect(docs).toBeHidden();
  }
});

/**
 * On a phone About opens over the app: while it is open, the keyboard stays in it (Tab cannot reach the covered
 * controls) and Escape closes it, back on its toggle, without reaching the app's own shortcuts.
 */
test("the phone's About overlay holds the keyboard and Escape closes it back on its toggle", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/archer/playground/app/`);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  const bar = page.getByRole("region", { name: "Example playground" });
  const about = bar.locator("summary").filter({ hasText: "About" });
  const panel = bar.locator(".playground-about");
  await about.focus();
  await page.keyboard.press("Enter");
  await expect(panel).toHaveAttribute("open", "");
  // The app it covers is out of reach while it is open.
  await expect(page.locator(".playground-workspace")).toHaveJSProperty("inert", true);
  // Tab through everything About holds and past it: focus never lands in the covered workspace.
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press("Tab");
    const inWorkspace = await page.evaluate(
      () => document.activeElement?.closest(".playground-workspace") !== null && document.activeElement !== null,
    );
    expect(inWorkspace, `Tab ${step + 1} stays out of the covered app`).toBe(false);
  }
  await page.keyboard.press("Escape");
  await expect(panel).not.toHaveAttribute("open", "");
  await expect(about).toBeFocused();
  await expect(page.locator(".playground-workspace")).toHaveJSProperty("inert", false);
  // Nothing the Escape could have reached in the app opened or changed.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // Closed, the app is reachable again.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement?.closest(".playground-workspace") !== null)).toBe(true);
});

test("Escape from the Project selector closes the phone's About too; an open Help closes first", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/archer/playground/app/`);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  const bar = page.getByRole("region", { name: "Example playground" });
  const about = bar.locator("summary").filter({ hasText: "About" });
  const panel = bar.locator(".playground-about");
  // From the selector, still reachable beside About.
  await about.click();
  await expect(panel).toHaveAttribute("open", "");
  await page.getByRole("combobox", { name: "Project" }).focus();
  await page.keyboard.press("Escape");
  await expect(panel).not.toHaveAttribute("open", "");
  await expect(about).toBeFocused();
  // Help opened over About: the first Escape closes Help, the next About.
  await about.click();
  await expect(panel).toHaveAttribute("open", "");
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard & Pointer" });
  await expect(help).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
  await expect(panel).toHaveAttribute("open", "");
  await about.focus();
  await page.keyboard.press("Escape");
  await expect(panel).not.toHaveAttribute("open", "");
});

test("narrowing to a phone while About is open moves focus out of the app it now covers", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${origin}/archer/playground/app/`);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  const bar = page.getByRole("region", { name: "Example playground" });
  const about = bar.locator("summary").filter({ hasText: "About" });
  await about.click();
  const workspaceControl = page.locator(".playground-workspace").getByRole("button", { name: "Keyboard shortcuts" });
  await workspaceControl.focus();
  await expect(workspaceControl).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".playground-workspace")).toHaveJSProperty("inert", true);
  await expect(about).toBeFocused();
  // Escape works from there: About closes and the app is reachable again.
  await page.keyboard.press("Escape");
  await expect(bar.locator(".playground-about")).not.toHaveAttribute("open", "");
  await expect(page.locator(".playground-workspace")).toHaveJSProperty("inert", false);
});
