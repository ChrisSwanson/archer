import { commentOperation } from "../support/comment-operations";
import { files as projectPage } from "./support/primary-navigation";
import { expect, test } from "@playwright/test";
import { chooseComment } from "./support/element-menu";
import { sharedTsProject } from "./support/shared-service";
test("opening an anchored comment preserves drawing size and camera", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/system.mmd"\n',
      ".archer/system.mmd": "flowchart LR\n web[Web] e1@--> api[API]\n",
    },
  });
  try {
    await project.present("system");
    await page.addInitScript(() => localStorage.setItem(`archer-comments:${location.pathname}:hold`, "true"));
    await page.goto(project.url);
    const canvas = page.locator(".react-flow").first();
    const node = page.locator('.react-flow__node[data-id="web"]');
    await expect(node).toBeVisible();
    const box = await canvas.boundingBox();
    const camera = await page.locator(".react-flow__viewport").getAttribute("style");
    await node.click({ button: "right" });
    await chooseComment(page);
    await expect(page.getByRole("textbox", { name: /comment/i })).toBeVisible();
    await expect.poll(() => canvas.boundingBox()).toEqual(box);
    expect(await page.locator(".react-flow__viewport").getAttribute("style")).toBe(camera);
  } finally {
    await project.stop();
  }
});
test("durable server threads keep node and edge anchors, edits, and project-wide send", async ({ page }) => {
  const project = await sharedTsProject({
    commentSubmission: "queued",
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/system.mmd"\n',
      ".archer/system.mmd": "flowchart LR\n web[Web] e1@-->|calls| api[API]\n",
    },
  });
  try {
    await project.present("system");
    const origin = new URL(project.url).origin;
    for (const anchor of [
      { kind: "node", id: "web", label: "Web" },
      { kind: "edge", id: "e1", label: "calls" },
    ]) {
      const result = await project.fetch("api/comments", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify(
          commentOperation.create({ target: "view:system", anchor, body: `Saved ${anchor.kind} thread` }),
        ),
      });
      expect(result.ok).toBe(true);
    }
    await page.addInitScript(() => localStorage.setItem(`archer-comments:${location.pathname}:hold`, "true"));
    await page.goto(project.url);
    await expect(page.locator('.react-flow__node[data-id="web"]')).toBeVisible();
    await page.getByRole("button", { name: /^Notifications/ }).click();
    await expect(page.getByRole("region", { name: "Project Review" })).toContainText("Saved node thread");
    // A review entry opens in place; Show on diagram opens the discussion at its anchor.
    const review = page.getByRole("region", { name: "Project Review" });
    await review.getByRole("button", { name: /Node: Web/ }).click();
    await review.getByRole("button", { name: "Show on diagram" }).click();
    const discussion = page.getByRole("region", { name: "Contextual discussion" });
    await expect(discussion).toContainText("Saved node thread");
    await expect(page.locator('.react-flow__node[data-id="web"]')).toHaveClass(/selected/);
    const handle = discussion.getByRole("button", { name: "Move discussion" });
    await handle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(discussion).toHaveAttribute("data-detached", "true");
    await discussion.getByRole("button", { name: "Reattach" }).click();
    await expect(discussion).toHaveAttribute("data-detached", "false");
    await discussion.getByRole("button", { name: "Edit", exact: true }).click();
    await discussion.getByRole("textbox", { name: "Edit your comment" }).fill("Edited durable node thread");
    await discussion.getByRole("button", { name: "Save", exact: true }).click();
    await expect(discussion).toContainText("Edited durable node thread");
    const bell = page.getByRole("button", { name: /^Notifications/ });
    if ((await bell.getAttribute("aria-expanded")) === "false") await bell.click();
    await expect(page.getByRole("region", { name: "Project Review" })).toBeVisible();
    await page
      .getByRole("region", { name: "Project Review" })
      .getByRole("button", { name: "Send queued comments (2)" })
      .click();
    const inbox = await project.agentInbox();
    expect(inbox).toHaveLength(2);
    await page
      .getByRole("region", { name: "Project Review" })
      .getByRole("button", { name: /Edge: calls/ })
      .click();
    await page.getByRole("region", { name: "Project Review" }).getByRole("button", { name: "Show on diagram" }).click();
    await expect(page.locator('.react-flow__edge[data-id="e1"]')).toHaveClass(/selected/);
  } finally {
    await project.stop();
  }
});

test("direct notes preserve passage comments across reopening and keyboard access", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/system.mmd"\n',
      ".archer/system.mmd": "flowchart LR\n web[Web] e1@--> api[API]\n",
      ".archer/notes/parsing.md": "# Parsing\n\nThe parser accepts tokens.\n",
    },
  });
  try {
    await page.goto(project.url);
    await (await projectPage(page)).getByRole("button", { name: "Parsing", exact: true }).click();
    const note = page.getByRole("article", { name: "Reading Parsing" });
    await expect(note).toContainText("The parser accepts tokens.");
    await note.locator(".archer-note-body").evaluate((root) => {
      const paragraph = root.querySelector("p")!;
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.getByRole("button", { name: "Comment on selection" }).click();
    const draft = page.getByRole("form", { name: "New comment" });
    await draft.getByRole("textbox", { name: "Comment", exact: true }).fill("Preserve the parsing explanation");
    await draft.getByRole("button", { name: "Add comment" }).click();
    await expect(note.locator("mark[data-thread-id]")).toContainText("The parser accepts tokens.");
    const rail = note.getByRole("complementary", { name: "Note discussions" });
    const header = rail.locator(".primary-note-discussion-bubble");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(header).toHaveAttribute("aria-expanded", "false");
    const mark = note.getByRole("button", { name: "Open discussion on this passage" });
    await mark.focus();
    await page.keyboard.press("Enter");
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(rail.locator(".primary-note-discussion")).toContainText("Preserve the parsing explanation");
    const response = await page.request.get(project.api("api/comments?target=note%3Anotes%2Fparsing.md"));
    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(data.threads[0].anchor).toMatchObject({ kind: "passage", quote: "The parser accepts tokens." });
  } finally {
    await project.stop();
  }
});

test("an agent-opened passage keeps its voice through a person reply and preserves note selection", async ({
  page,
}) => {
  const project = await sharedTsProject({
    commentSubmission: "queued",
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/system.mmd"\n',
      ".archer/system.mmd": "flowchart LR\n web[Web] e1@--> api[API]\n",
      ".archer/notes/context.md":
        "# Context\n\nThe client sends a token to the API. Readers can select this surrounding prose.\n",
    },
  });
  try {
    await page.goto(project.url);
    await (await projectPage(page)).getByRole("button", { name: "Context", exact: true }).click();
    const note = page.getByRole("article", { name: "Reading Context" });
    await expect(note).toContainText("Readers can select this surrounding prose.");
    const body = `Please review this passage and tell me whether the boundary remains clear when the discussion contains a long agent message. ${"boundary-context ".repeat(80)}`;
    const opened = await project.agentCreateComment(
      "note:notes/context.md",
      { kind: "passage", quote: "sends a token", prefix: "The client ", suffix: " to the API" },
      body,
    );
    expect(opened).toMatchObject({ status: "answered", comments: [{ author: "agent", body }] });
    await expect(page.locator(".archer-review-announcer")).toHaveText("Agent opened Passage: “sends a token”.");
    const mark = note.getByRole("button", { name: "Open discussion on this passage" });
    await expect(mark).toHaveClass(/archer-passage--agent/);
    const markBox = await mark.boundingBox();
    expect(markBox?.width).toBeGreaterThan(0);
    expect(markBox?.height).toBeGreaterThan(0);
    const colours = await mark.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--agent)";
      document.body.append(probe);
      const result = { mark: getComputedStyle(element).textDecorationColor, agent: getComputedStyle(probe).color };
      probe.remove();
      return result;
    });
    expect(colours.mark).toBe(colours.agent);

    await mark.focus();
    await expect(mark).toBeFocused();
    await page.keyboard.press("Enter");
    const discussion = note
      .getByRole("complementary", { name: "Note discussions" })
      .locator(`.primary-note-discussion[data-thread-id="${opened.id}"]`);
    const thread = discussion.getByRole("article");
    await expect(mark).toBeFocused();
    await expect(thread).toBeVisible();
    await expect(thread).toContainText("Agent opened");
    await expect(thread).toContainText(body);
    const longBody = thread.locator(".archer-comment-body").first();
    expect(await longBody.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const reply = discussion.getByRole("textbox", { name: "Your reply" });
    await expect(reply).toHaveJSProperty("tagName", "TEXTAREA");
    await reply.fill("I will tighten that explanation.");
    await discussion.getByRole("button", { name: "Reply", exact: true }).click();
    await expect(thread).toContainText("Draft");
    await expect(mark).toHaveClass(/archer-passage--agent/);
    await page.keyboard.press("Escape");
    await expect(discussion.locator(".primary-note-discussion-bubble")).toHaveAttribute("aria-expanded", "false");

    await note.locator(".archer-note-body").evaluate((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Text | null = null;
      while (walker.nextNode()) {
        const candidate = walker.currentNode as Text;
        if (candidate.data.includes("Readers can select this surrounding prose.")) {
          node = candidate;
          break;
        }
      }
      if (!node) throw new Error("selection text not found");
      const start = node.data.indexOf("Readers");
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, node.data.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await expect(page.getByRole("button", { name: "Comment on selection" })).toBeVisible();
  } finally {
    await project.stop();
  }
});

for (const kind of ["sequence", "journey"] as const) {
  test(`${kind} comments reattach to production anchors and pins focus their thread`, async ({ page }) => {
    const source =
      kind === "sequence"
        ? "sequenceDiagram\n participant web as Web\n participant api as API\n web->>api: calls\n"
        : "journey\n title Working day\n section Work\n Do work: 2: Me\n";
    const project = await sharedTsProject({
      files: {
        "archer.toml": `version = 1\n[[views]]\nid = "system"\nkind = "${kind}"\ntitle = "System"\nsource = ".archer/system.mmd"\n`,
        ".archer/system.mmd": source,
      },
    });
    try {
      await project.present("system");
      await page.goto(project.url);
      const target =
        kind === "sequence"
          ? page.locator('[data-seq-channel="participants"][data-seq-id="api"][role="button"]')
          : page.locator('[data-journey-id="do-work"]');
      await expect(target).toBeVisible();
      await target.click({ button: "right" });
      const draft = page.getByRole("form", { name: "New comment" });
      await draft.getByRole("textbox", { name: "Comment", exact: true }).fill(`Durable ${kind} comment`);
      await draft.getByRole("button", { name: "Add comment" }).click();
      const discussion = page.getByRole("region", { name: "Contextual discussion" });
      await expect(discussion).toContainText(`Durable ${kind} comment`);
      await expect(discussion).not.toContainText("Original location is unavailable");
      await discussion.getByRole("button", { name: "Close discussion" }).click();
      await (kind === "sequence"
        ? page.locator(".archer-svg-pin[data-pin-thread]")
        : target.locator("[data-pin-thread]")
      ).click();
      await expect(discussion.getByRole("article")).toBeFocused();
      await expect(discussion).not.toContainText("Original location is unavailable");
    } finally {
      await project.stop();
    }
  });
}
