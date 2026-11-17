import { commentOperation } from "../support/comment-operations";
import { files as projectPage } from "./support/primary-navigation";
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { MAX_PASSAGE_QUOTE_CHARS } from "../../src/comments/contract";
import { sharedTsProject } from "./support/shared-service";
const files = {
  "archer.toml": 'version = 1\n[[views]]\nid="system"\nkind="freeform"\ntitle="System"\nsource=".archer/system.mmd"\n',
  ".archer/system.mmd": "flowchart LR\n web[Web] e1@--> api[API]\n",
  ".archer/notes/auth.md":
    "---\ndiagrams: [../system.mmd]\n---\n# Auth\n\nTokens expire after an hour.\n\n[External](https://example.com)\n",
};
async function note(page: Page) {
  await (await projectPage(page)).getByRole("button", { name: "Auth", exact: true }).click();
  return page.getByRole("document", { name: "Note: Auth" });
}
for (const target of [
  { kind: "node", id: "web", pin: '.react-flow__node[data-id="web"] .archer-pin' },
  { kind: "edge", id: "e1", pin: '.archer-edge-pins[data-edge-pins="e1"] [data-pin-thread]' },
] as const) {
  test(`pointer-opened ${target.kind} discussion stays plain and retains keyboard focus outline`, async ({ page }) => {
    const project = await sharedTsProject({ files });
    try {
      await project.present("system");
      const origin = new URL(project.url).origin;
      const response = await project.fetch("api/comments", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(
          commentOperation.create({
            target: "view:system",
            anchor: { kind: target.kind, id: target.id, label: target.id },
            body: "Saved discussion",
          }),
        ),
      });
      expect(response.ok).toBe(true);
      await page.goto(project.url);
      const pin = page.locator(target.pin);
      // Detached edge pins inherit Chromium's keyboard focus heuristic on focus transfer.
      await page.keyboard.press("Tab");
      await pin.click();
      const card = page.getByRole("region", { name: "Contextual discussion" }).getByRole("article");
      await expect(card).toBeFocused();
      expect(
        await card.evaluate((element) => ({
          shadow: getComputedStyle(element).boxShadow,
          border: getComputedStyle(element).borderWidth,
          outline: getComputedStyle(element).outlineStyle,
        })),
      ).toEqual({ shadow: "none", border: "0px", outline: "none" });
      await page.keyboard.press("Tab");
      await card.focus();
      expect(
        await card.evaluate((element) => ({
          visible: element.matches(":focus-visible"),
          style: getComputedStyle(element).outlineStyle,
          width: getComputedStyle(element).outlineWidth,
        })),
      ).toEqual({ visible: true, style: "solid", width: "2px" });
      await card.getByRole("textbox", { name: "Your reply" }).fill("Unsent reply");
      await pin.click();
      await expect(card).toBeFocused();
      expect(await card.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
    } finally {
      await project.stop();
    }
  });
}
test("right-clicking selected Markdown persists an exact passage, reopens and edits its durable discussion", async ({
  page,
}) => {
  const project = await sharedTsProject({ files });
  try {
    await project.present("system");
    await page.goto(project.url);
    await expect(page.locator('.react-flow__node[data-id="web"]')).toBeVisible();
    const body = await note(page);
    await expect(page.locator(".primary-note-reader .archer-note-tools")).toHaveCount(0);
    const quote = "expire after an hour";
    const point = await body
      .locator("p")
      .filter({ hasText: "Tokens expire after an hour." })
      .evaluate((paragraph, quote) => {
        const text = paragraph.firstChild!;
        const start = text.textContent!.indexOf(quote);
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + quote.length);
        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        const rect = range.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }, quote);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.keyboard.press("ControlOrMeta+c");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(quote);
    await page.mouse.click(point.x, point.y, { button: "right" });
    await page.getByRole("menuitem", { name: "Comment on selection" }).click();
    const composer = page.getByRole("region", { name: "Contextual discussion" });
    await composer.getByRole("textbox", { name: "Comment", exact: true }).fill("Clarify this exact passage");
    await page.keyboard.press("Control+Enter");
    await expect(body.locator("mark.archer-passage")).toHaveText(quote);
    const persisted = JSON.parse(readFileSync(join(project.root, ".archer/notes/auth.comments.json"), "utf8"));
    expect(persisted.threads[0].anchor).toMatchObject({ kind: "passage", quote, prefix: "Tokens ", suffix: "." });
    await page.reload();
    const reopened = await note(page);
    const mark = reopened.getByRole("button", { name: "Open discussion on this passage" });
    await expect(mark).toHaveText(quote);
    const threadId = await mark.getAttribute("data-thread-id");
    expect(threadId).not.toBeNull();
    await mark.click();
    const rail = page.getByRole("complementary", { name: "Note discussions" });
    const discussion = rail.locator(`.primary-note-discussion[data-thread-id="${threadId}"]`);
    await expect(discussion).toContainText("Clarify this exact passage");
    await discussion.getByRole("button", { name: "Edit", exact: true }).click();
    await discussion.getByRole("textbox", { name: "Edit your comment" }).fill("Edited durable passage");
    await page.keyboard.press("Control+Enter");
    await expect(discussion).toContainText("Edited durable passage");
    expect(
      JSON.parse(readFileSync(join(project.root, ".archer/notes/auth.comments.json"), "utf8")).threads[0].anchor,
    ).toEqual(persisted.threads[0].anchor);
    await reopened.evaluate(() => {
      document.getSelection()!.removeAllRanges();
      document.addEventListener(
        "contextmenu",
        (event) => {
          document.documentElement.dataset.nativeContext = String(event.defaultPrevented);
        },
        { once: true },
      );
    });
    await reopened.getByRole("link", { name: "External", exact: true }).click({ button: "right" });
    await expect(page.locator("html")).toHaveAttribute("data-native-context", "false");
    await expect(page.getByRole("menu", { name: "Note comment actions" })).toHaveCount(0);
  } finally {
    await project.stop();
  }
});

test("phone selection warning stays in viewport and keyboard context menu is accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  const project = await sharedTsProject({
    files: { ...files, ".archer/notes/auth.md": "# Auth\n\n" + "word ".repeat(MAX_PASSAGE_QUOTE_CHARS) + "\n" },
  });
  try {
    await project.present("system");
    await page.goto(project.url);
    await expect(page.locator('.react-flow__node[data-id="web"]')).toBeVisible();
    const body = await note(page);
    await body.locator("p").evaluate((paragraph) => {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const action = page.locator(".primary-note-comment-action");
    await expect(action.getByRole("button", { name: "Comment on selection" })).toBeDisabled();
    const bounds = await action.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(700);
    await body.evaluate((root) => {
      document.getSelection()!.removeAllRanges();
      (root as HTMLElement).focus();
    });
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", { name: "Note selection actions" });
    await expect(menu.getByRole("menuitem", { name: "Comment on note" })).toBeFocused();
    expect((await new AxeBuilder({ page }).include(".primary-note-comment-action").analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(body).toBeFocused();
  } finally {
    await project.stop();
  }
});

test("Escape from the hosted review inbox closes it without clearing graph selection", async ({ page }) => {
  const project = await sharedTsProject({ files });
  try {
    await project.present("system");
    await page.goto(project.url);
    const node = page.locator('.react-flow__node[data-id="web"]');
    await page.getByRole("button", { name: "Select mode", exact: true }).click();
    await node.click();
    await expect(node).toHaveClass(/selected/);
    const review = page.getByRole("button", { name: /^Notifications/ });
    await review.click();
    const inbox = page.getByRole("region", { name: "Project Review" });
    await inbox.getByRole("button", { name: "Close project review" }).focus();
    await page.keyboard.press("Escape");
    await expect(inbox).toBeHidden();
    await expect(node).toHaveClass(/selected/);
    await expect(review).toBeFocused();
  } finally {
    await project.stop();
  }
});
