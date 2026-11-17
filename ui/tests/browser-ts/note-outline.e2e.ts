import { expect, test } from "@playwright/test";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startTsProject } from "../support/ts-service";
import { files as projectPage } from "./support/primary-navigation";
import { testPage } from "./support/page-path";

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`note outline jumps to topics and tracks scroll (${reducedMotion})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ reducedMotion });
    const project = await startTsProject({
      pagePath: process.env.ARCHER_NOTE_OUTLINE_PAGE ?? testPage(),
      files: {
        "archer.toml": "version = 1\n",
        ".archer/notes/topics.md": `# Topics\n\n## Introduction\n\n${"Introductory passage.\n\n".repeat(45)}### Café details\n\n${"Detail passage.\n\n".repeat(45)}## Conclusion\n\n${"Closing passage.\n\n".repeat(25)}`,
      },
    });
    try {
      await page.goto(project.url);
      await (await projectPage(page)).getByRole("button", { name: "Topics", exact: true }).click();
      const reader = page.getByRole("article", { name: "Reading Topics" });
      const outline = reader.getByRole("navigation", { name: "Table of contents" });
      // The page heading already names the note; the outline lists only the topics under it (G6).
      await expect(outline.getByRole("link")).toHaveText(["Introduction", "Café details", "Conclusion"]);
      const outlineBox = (await outline.boundingBox())!;
      const documentBox = (await reader.locator(".archer-note-body").boundingBox())!;
      expect(outlineBox.x + outlineBox.width).toBeLessThan(documentBox.x);
      const widthBefore = documentBox.width;
      const thread = await project.agentCreateComment(
        "note:notes/topics.md",
        { kind: "passage", quote: "Introductory passage", prefix: "", suffix: "." },
        "Discuss the introduction.",
      );
      const rail = reader.getByRole("complementary", { name: "Note discussions" });
      await expect(rail.locator(`[data-thread-id="${thread.id}"]`)).toBeVisible();
      await expect
        .poll(async () => {
          const [nav, document] = await Promise.all([
            outline.boundingBox(),
            reader.locator(".archer-note-body").boundingBox(),
          ]);
          return nav!.x + nav!.width <= document!.x;
        })
        .toBe(true);
      expect((await reader.locator(".archer-note-body").boundingBox())!.width).toBe(widthBefore);
      expect((await rail.boundingBox())!.x).toBeGreaterThan(
        (await reader.locator(".archer-note-body").boundingBox())!.x,
      );
      if (process.env.ARCHER_NOTE_OUTLINE_CAPTURE)
        await page.screenshot({ path: `/tmp/note-outline-desktop-${reducedMotion}.png` });
      const details = outline.getByRole("link", { name: "Café details" });
      const addressBeforeJump = page.url();
      await details.focus();
      await page.keyboard.press("Enter");
      const heading = reader.getByRole("heading", { name: "Café details" });
      await expect(heading).toBeFocused();
      expect(page.url()).toBe(addressBeforeJump);
      await expect
        .poll(async () => {
          const [head, root] = await Promise.all([heading.boundingBox(), reader.boundingBox()]);
          return Math.abs(head!.y - root!.y - 48);
        })
        .toBeLessThan(2);
      await expect(details).toHaveAttribute("aria-current", "location");
      await reader.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(outline.getByRole("link", { name: "Conclusion" })).toHaveAttribute("aria-current", "location");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await project.stop();
    }
  });
}

test("phone outline collapses, retains touch targets, and leaves discussions usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const project = await startTsProject({
    pagePath: process.env.ARCHER_NOTE_OUTLINE_PAGE ?? testPage(),
    files: {
      "archer.toml": "version = 1\n",
      ".archer/notes/topics.md": `# Topics\n\n## Introduction\n\n${"Introductory passage.\n\n".repeat(32)}## Conclusion\n\nClosing passage.`,
    },
  });
  try {
    await page.goto(project.url);
    await (await projectPage(page)).getByRole("button", { name: "Topics", exact: true }).click();
    const reader = page.getByRole("article", { name: "Reading Topics" });
    const nav = reader.getByRole("navigation", { name: "Table of contents" });
    // Phone reading starts with content; opening the outline is an explicit action.
    await expect(nav).toBeHidden();
    if (process.env.ARCHER_NOTE_OUTLINE_CAPTURE) await page.screenshot({ path: "/tmp/note-outline-phone.png" });
    const disclosure = reader.locator(".primary-note-outline summary");
    expect((await disclosure.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await disclosure.click();
    await expect(nav).toBeVisible();
    expect((await nav.getByRole("link", { name: "Conclusion" }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await disclosure.click();
    await expect(nav).toBeHidden();
    await disclosure.click();
    const addressBeforeJump = page.url();
    await nav.getByRole("link", { name: "Conclusion" }).click();
    expect(page.url()).toBe(addressBeforeJump);
    await expect(reader.getByRole("heading", { name: "Conclusion" })).toBeFocused();
    const thread = await project.agentCreateComment(
      "note:notes/topics.md",
      { kind: "passage", quote: "Closing passage", prefix: "", suffix: "." },
      "Review this conclusion.",
    );
    await expect(reader.locator(`[data-thread-id="${thread.id}"] .primary-note-discussion-bubble`)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await project.stop();
  }
});

test("Coffee casebook opens with readable content and keyboard/touch outline navigation on a phone", async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  const root = resolve(import.meta.dirname, "../../..");
  const source = join(root, "examples/rfc-2324-htcpcp");
  const files: Record<string, string> = {};
  const read = (directory: string): void => {
    for (const entry of readdirSync(join(source, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) read(path);
      else if (entry.isFile()) files[path] = readFileSync(join(source, path), "utf8");
    }
  };
  read("");
  const project = await startTsProject({ pagePath: testPage(), files });
  try {
    await page.goto(project.address("note=notes/reading-guide.md"));
    const reader = page.getByRole("article", { name: "Reading Protocol Casebook: Coffee" });
    const outline = reader.locator(".primary-note-outline-disclosure");
    const disclosure = outline.locator("summary");
    const nav = outline.getByRole("navigation", { name: "Table of contents" });
    await expect(disclosure).toBeVisible();
    await expect(outline).not.toHaveAttribute("open");
    const title = reader.getByRole("heading", { name: "Protocol Casebook: Coffee", exact: true });
    const opening = reader.getByText(/A request can name a pot and ask for milk\./);
    await expect(title).toBeInViewport({ ratio: 1 });
    await expect(opening).toBeInViewport({ ratio: 1 });
    mkdirSync(join(root, ".shots"), { recursive: true });
    await page.screenshot({ path: join(root, ".shots/fixB-phone-outline-collapsed.png") });
    await disclosure.focus();
    await page.keyboard.press("Enter");
    await expect(nav).toBeVisible();
    await page.keyboard.press("Space");
    await expect(nav).toBeHidden();
    await disclosure.tap();
    await expect(nav).toBeVisible();
    const topic = nav.getByRole("link", { name: "What does this request name?", exact: true });
    expect((await topic.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: join(root, ".shots/fixB-phone-outline-expanded.png") });
    await topic.tap();
    await expect(reader.getByRole("heading", { name: "What does this request name?", exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await page.close();
    await context.close();
    await project.stop();
  }
});
