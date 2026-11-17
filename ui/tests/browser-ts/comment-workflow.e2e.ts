import { commentOperation } from "../support/comment-operations";
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { chooseComment } from "./support/element-menu";
import { sharedTsProject } from "./support/shared-service";
const files = {
  "archer.toml": 'version = 1\n[[views]]\nid="system"\nkind="freeform"\ntitle="System"\nsource=".archer/system.mmd"\n',
  ".archer/system.mmd": "flowchart LR\n web[Web] e1@--> api[API]\n",
  ".archer/notes/auth.md": "---\ndiagrams: [../system.mmd]\n---\n# Auth\n\nTokens expire after an hour.\n",
};
test("opening another document closes a graph discussion", async ({ page }) => {
  const project = await sharedTsProject({ files });
  try {
    await project.present("system");
    const response = await project.fetch("api/comments", {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(project.url).origin },
      body: JSON.stringify(
        commentOperation.create({
          target: "view:system",
          anchor: { kind: "node", id: "web", label: "Web" },
          body: "Graph discussion",
        }),
      ),
    });
    expect(response.ok).toBe(true);
    await page.goto(project.url);
    await page.locator('.react-flow__node[data-id="web"] .archer-pin').click();
    await expect(page.getByRole("region", { name: "Contextual discussion" })).toBeVisible();
    await page.getByRole("button", { name: "Archer contents", exact: true }).click();
    const gallery = page.getByRole("region", { name: "Project documents", exact: true });
    await expect(gallery).toBeVisible();
    await gallery.getByRole("button", { name: "Auth", exact: true }).click();
    await expect(page.getByRole("document", { name: "Note: Auth" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Contextual discussion" })).toHaveCount(0);
  } finally {
    await project.stop();
  }
});

test("submitting holds comments as drafts until they are published together", async ({ page }) => {
  const project = await sharedTsProject({ files, commentSubmission: "queued" });
  const persisted = () =>
    JSON.parse(readFileSync(join(project.root, ".archer/system.comments.json"), "utf8")).threads as {
      id: string;
      status: string;
      comments: { body: string }[];
    }[];
  try {
    await project.present("system");
    await page.goto(project.url);
    const node = page.locator('.react-flow__node[data-id="web"]');
    const create = async (body: string) => {
      await node.click({ button: "right" });
      await chooseComment(page);
      const discussion = page.getByRole("region", { name: "Contextual discussion" });
      await discussion.getByRole("textbox", { name: "Comment", exact: true }).fill(body);
      await discussion.getByRole("button", { name: "Add comment", exact: true }).click();
      return discussion;
    };
    let discussion = await create("Held on submission");
    await expect.poll(() => persisted()[0].status).toBe("draft");
    await expect(discussion.getByRole("checkbox")).toHaveCount(0);
    await expect(discussion.getByRole("combobox")).toHaveCount(0);
    await discussion.getByRole("button", { name: "Close discussion" }).click();
    discussion = await create("Held as well");
    await expect.poll(() => persisted().find((t) => t.comments[0].body === "Held as well")?.status).toBe("draft");
    expect(await project.agentInbox()).toHaveLength(0);
    await discussion.getByRole("textbox", { name: "Your reply" }).fill("A held reply");
    await discussion.locator(".archer-thread-form").getByRole("button", { name: "Reply", exact: true }).click();
    await expect.poll(() => persisted().find((t) => t.comments[0].body === "Held as well")?.comments.length).toBe(2);
    expect(persisted().every((t) => t.status === "draft")).toBe(true);
    await discussion.getByRole("button", { name: "Send queued comments (2)" }).click();
    await expect.poll(() => persisted().some((t) => t.status === "draft")).toBe(false);
    expect(await project.agentInbox()).toHaveLength(2);
  } finally {
    await project.stop();
  }
});

for (const origin of ["inbox", "pin"] as const)
  test(`opening a current-document ${origin} thread does not keep it on contents`, async ({ page }) => {
    const project = await sharedTsProject({ files });
    try {
      await project.present("system");
      const response = await project.fetch("api/comments", {
        method: "POST",
        headers: { "content-type": "application/json", origin: new URL(project.url).origin },
        body: JSON.stringify(
          commentOperation.create({
            target: "view:system",
            anchor: { kind: "node", id: "web", label: "Web" },
            body: "Current document thread",
          }),
        ),
      });
      expect(response.ok).toBe(true);
      await page.goto(project.url);
      if (origin === "inbox") {
        await page.getByRole("button", { name: /^Notifications/ }).click();
        const review = page.getByRole("region", { name: "Project Review" });
        await review.getByRole("button", { name: /Current document thread/ }).click();
        await review.getByRole("button", { name: "Show on diagram" }).click();
      } else await page.locator('.react-flow__node[data-id="web"] .archer-pin').click();
      await expect(page.getByRole("region", { name: "Contextual discussion" })).toBeVisible();
      await page.getByRole("button", { name: "Archer contents", exact: true }).click();
      await expect(page.getByRole("region", { name: "Contextual discussion" })).toHaveCount(0);
    } finally {
      await project.stop();
    }
  });

test("notifications count unread agent answers and remember reading across reload", async ({ page }) => {
  const project = await sharedTsProject({ files });
  try {
    await project.present("system");
    await page.goto(project.url);
    const node = page.locator('.react-flow__node[data-id="web"]');
    await node.click({ button: "right" });
    await chooseComment(page);
    const discussion = page.getByRole("region", { name: "Contextual discussion" });
    await discussion.getByRole("textbox", { name: "Comment", exact: true }).fill("Question for the agent");
    await discussion.getByRole("button", { name: "Add comment", exact: true }).click();
    // Sent on submission by default (decided 2026-10-29): no draft, nothing to send afterwards.
    await expect(discussion.getByText("Sent", { exact: true })).toBeVisible();
    await expect(discussion.getByRole("button", { name: /^Send queued comments/ })).toHaveCount(0);
    await discussion.getByRole("button", { name: "Close discussion" }).click();
    const [thread] = (await project.agentInbox()) as { id: string; revision: number }[];
    await project.agentReply(thread.id, "First answer", thread.revision);
    const bell = page.locator(".archer-review-toggle");
    await expect(bell).toHaveAccessibleName("Notifications, 1 unread agent answer");
    const badge = bell.locator(".archer-review-toggle-count");
    await expect(badge).toHaveText("1");
    const buttonBox = await bell.boundingBox(),
      badgeBox = await badge.boundingBox();
    expect(badgeBox!.height).toBe(18);
    expect(badgeBox!.y).toBe(buttonBox!.y - 2);
    expect(badgeBox!.x + badgeBox!.width).toBe(buttonBox!.x + buttonBox!.width + 4);
    const badgeStyle = await badge.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        background: style.backgroundColor,
        ink: style.color,
        size: style.fontSize,
        weight: style.fontWeight,
        numerals: style.fontVariantNumeric,
      };
    });
    expect(badgeStyle.size).toBe("11px");
    expect(badgeStyle.weight).toBe("600");
    expect(badgeStyle.numerals).toBe("tabular-nums");
    expect(badgeStyle.background).not.toBe(badgeStyle.ink);
    await page.reload();
    await expect(bell).toHaveAccessibleName("Notifications, 1 unread agent answer");
    await node.locator(".archer-pin").click();
    await expect(discussion).toContainText("First answer");
    await expect(bell).toHaveAccessibleName("Notifications");
    await page.reload();
    await expect(bell).toHaveAccessibleName("Notifications");
    const latest = JSON.parse(readFileSync(join(project.root, ".archer/system.comments.json"), "utf8")).threads.find(
      (item: { id: string }) => item.id === thread.id,
    ) as { revision: number };
    await project.agentReply(thread.id, "A later answer", latest.revision);
    await expect(bell).toHaveAccessibleName("Notifications, 1 unread agent answer");
  } finally {
    await project.stop();
  }
});

test("a review entry opens in place, takes a held reply, and gives focus back on Escape, with the drawing unmoved", async ({
  page,
}) => {
  const project = await sharedTsProject({ files, commentSubmission: "queued" });
  const persisted = () =>
    JSON.parse(readFileSync(join(project.root, ".archer/system.comments.json"), "utf8")).threads as {
      status: string;
      comments: { body: string }[];
    }[];
  try {
    await project.present("system");
    for (const body of ["Older thread", "Newer thread"]) {
      const response = await project.fetch("api/comments", {
        method: "POST",
        headers: { "content-type": "application/json", origin: new URL(project.url).origin },
        body: JSON.stringify(
          commentOperation.create({ target: "view:system", anchor: { kind: "node", id: "web", label: "Web" }, body }),
        ),
      });
      expect(response.ok).toBe(true);
    }
    await page.goto(project.url);
    await expect(page.locator('.react-flow__node[data-id="web"]')).toBeVisible();
    await expect(page.locator(".primary-document-trail")).toContainText("System");
    const stage = await page.locator(".archer-stage").boundingBox();
    await page.getByRole("button", { name: /^Notifications/ }).click();
    const review = page.getByRole("region", { name: "Project Review" });
    await expect(review).toBeVisible();
    expect(await page.locator(".archer-stage").boundingBox()).toEqual(stage);
    const entries = review.locator(".primary-inbox-thread");
    await expect(entries.first()).toContainText("Newer thread");
    await entries.first().focus();
    await page.keyboard.press("Enter");
    await expect(entries.first()).toHaveAttribute("aria-expanded", "true");
    const card = review.getByRole("article");
    await card.getByRole("textbox", { name: "Your reply" }).fill("Answered from the sidebar");
    await page.keyboard.press("Control+Enter");
    await expect.poll(() => persisted().find((t) => t.comments[0].body === "Newer thread")?.comments.length).toBe(2);
    expect(persisted().every((t) => t.status === "draft")).toBe(true);
    // The persistent reply field clears after saving; move focus back to the
    // review entry before testing its Escape-to-collapse behavior.
    await expect(card.getByRole("textbox", { name: "Your reply" })).toHaveValue("");
    await entries.first().focus();
    await page.keyboard.press("Escape");
    await expect(entries.first()).toHaveAttribute("aria-expanded", "false");
    await expect(entries.first()).toBeFocused();
    await expect(review).toBeVisible();
    await expect(page.getByRole("region", { name: "Contextual discussion" })).toHaveCount(0);
  } finally {
    await project.stop();
  }
});
