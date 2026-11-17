/** The TypeScript commenting sheet promises real controls and publication outcomes. */
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { chooseComment } from "./support/element-menu";
import { sharedTsProject } from "./support/shared-service";
const files = {
  "archer.toml": 'version=1\n[[views]]\nid="system"\nkind="freeform"\ntitle="System"\nsource=".archer/system.mmd"\n',
  ".archer/system.mmd": "flowchart LR\n web[Web] e1@--> api[API]\n",
};
const rows = [
  "C",
  "Right-click",
  "New comment",
  "⌘/Ctrl Enter",
  "Send queued comments",
  "A numbered pin",
  "Edit / Delete",
];
// Right-click and ⌘/Ctrl Enter are still listed and checked in the sheet, but get no test of their own: Send queued
// comments, A numbered pin and Edit / Delete each run both, with the same assertions, before they diverge.
const exercised = rows.filter((row) => row !== "Right-click" && row !== "⌘/Ctrl Enter");
for (const row of exercised)
  test(`Commenting sheet: ${row}`, async ({ page }) => {
    // The sheet's rows walk the queued workflow, so this project asks for it (immediate is the default).
    const project = await sharedTsProject({ files, commentSubmission: "queued" });
    try {
      await project.present("system");
      await page.goto(project.url);
      // `?` is heard once the page is drawn: pressed earlier, under load, it can land before the shell listens (O178).
      await expect(page.locator('.react-flow__node[data-id="web"]')).toBeVisible();
      await page.keyboard.press("?");
      const section = page.getByRole("heading", { name: "Commenting", exact: true }).locator("..");
      await expect(section.locator("dt")).toHaveText(rows);
      await expect(section).not.toContainText("Nothing reaches the agent yet");
      await page.keyboard.press("Escape");
      const node = page.locator('.react-flow__node[data-id="web"]');
      const discussion = page.getByRole("region", { name: "Contextual discussion" });
      if (row === "C") {
        await page.getByRole("button", { name: "Select mode", exact: true }).click();
        await node.click();
        await page.keyboard.press("c");
        await expect(discussion.getByRole("textbox", { name: "Comment", exact: true })).toBeFocused();
        return;
      }
      if (row === "New comment") {
        await page.getByRole("button", { name: /^Notifications/ }).click();
        await page
          .getByRole("region", { name: "Project Review" })
          .getByRole("button", { name: "New comment", exact: true })
          .click();
        await expect(discussion.getByRole("textbox", { name: "Comment", exact: true })).toBeFocused();
        return;
      }
      // A box's menu (ADR 0036 A9): Comment first, then Expand.
      await node.click({ button: "right" });
      await chooseComment(page);
      const editor = discussion.getByRole("textbox", { name: "Comment", exact: true });
      await expect(editor).toBeFocused();
      await editor.fill("Question from the sheet");
      await page.keyboard.press("Control+Enter");
      const persisted = () =>
        JSON.parse(readFileSync(join(project.root, ".archer/system.comments.json"), "utf8")).threads as {
          status: string;
          comments: { body: string }[];
        }[];
      // Submitting holds the comment as a draft; nothing reaches the agent yet.
      await expect.poll(() => persisted()[0]?.status).toBe("draft");
      expect(await project.agentInbox()).toHaveLength(0);
      if (row === "Send queued comments") {
        await discussion.getByRole("button", { name: "Send queued comments (1)", exact: true }).click();
        await expect.poll(() => persisted()[0]?.status).toBe("sent");
        return;
      }
      if (row === "A numbered pin") {
        await discussion.getByRole("button", { name: "Close discussion", exact: true }).click();
        const pin = node.locator(".archer-pin");
        await expect(pin).toHaveText("1");
        await pin.click();
        await expect(discussion.getByRole("article")).toBeFocused();
        await expect(discussion.locator(".archer-thread-head .archer-pin")).toHaveText("1");
        return;
      }
      const thread = discussion.getByRole("article");
      await thread.getByRole("button", { name: "Edit", exact: true }).click();
      await thread.getByRole("textbox", { name: "Edit your comment" }).fill("Edited from the sheet");
      await thread.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(() => persisted()[0]?.comments[0]?.body).toBe("Edited from the sheet");
      await thread.getByRole("button", { name: "Delete", exact: true }).click();
      await thread
        .getByRole("group", { name: "Delete this comment?" })
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      // The thread goes; the file stays as a receipt-only file (ADR 0016: deleting the last thread keeps its receipts).
      await expect.poll(() => persisted().length).toBe(0);
      expect(
        JSON.parse(readFileSync(join(project.root, ".archer/system.comments.json"), "utf8")).receipts,
      ).toBeDefined();
      expect(await project.agentInbox()).toHaveLength(0);
    } finally {
      await project.stop();
    }
  });
