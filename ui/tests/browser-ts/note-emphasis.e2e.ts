import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { files as projectPage } from "./support/primary-navigation";
import { startTsProject } from "../support/ts-service";
import { testPage } from "./support/page-path";
import { caretToLineEnd } from "./support/keys";

async function selectPhrase(page: Page, body: Locator, phrase: string): Promise<void> {
  await body.evaluate((root, wanted) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let start: { node: Text; offset: number } | undefined;
    let end: { node: Text; offset: number } | undefined;
    const text = root.textContent ?? "";
    const from = text.indexOf(wanted);
    if (from < 0) throw new Error(`phrase not found: ${wanted}`);
    const to = from + wanted.length;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const next = offset + node.data.length;
      if (start === undefined && from >= offset && from <= next) start = { node, offset: from - offset };
      if (to >= offset && to <= next) {
        end = { node, offset: to - offset };
        break;
      }
      offset = next;
    }
    if (start === undefined || end === undefined) throw new Error("selection endpoints were not rendered text");
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, phrase);
  await expect(page.getByRole("button", { name: "Highlight selection" })).toBeVisible();
}

test("agent and reader passage highlights persist, overlap discussions, and recover from conflicts and drift", async ({
  page,
  browser,
}) => {
  const markdown = "# Context\n\nThe **client** sends café 😀 token to the API. Later prose remains selectable.\n";
  const project = await startTsProject({
    pagePath: testPage(),
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/system.mmd"\n',
      ".archer/system.mmd": "flowchart LR\n web[Web] e1@--> api[API]\n",
      ".archer/notes/context.md": markdown,
    },
  });
  try {
    await page.goto(project.url);
    await (await projectPage(page)).getByRole("button", { name: "Context", exact: true }).click();
    const note = page.getByRole("article", { name: "Reading Context" });
    const body = note.getByRole("document", { name: "Note: Context" });
    await expect(body).toContainText("Later prose remains selectable.");

    const agent = await project.agentSetNoteEmphasis({
      notePath: "notes/context.md",
      id: "design-review",
      title: "Design review changes",
      expectedRevision: 0,
      groups: [
        {
          id: "boundary",
          label: "Trust boundary",
          description: "Confirm the handoff",
          passages: [{ kind: "passage", quote: "client sends café 😀 token", prefix: "The ", suffix: " to the API." }],
        },
      ],
    });
    expect(agent.snapshot.emphases[0]).toMatchObject({ author: "agent", id: "design-review" });
    const legend = note.getByRole("region", { name: "Note highlights" });
    const agentSetButton = legend.getByRole("button", { name: /Design review changes Agent/ });
    await expect(agentSetButton).toBeVisible();
    await expect(legend).toContainText("Trust boundary");
    const dockBefore = await legend.boundingBox();
    await note.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const dockAfter = await legend.boundingBox();
    expect(dockAfter?.x).toBeCloseTo(dockBefore!.x, 0);
    expect(dockAfter?.y).toBeCloseTo(dockBefore!.y, 0);
    const bodyAtEnd = await body.boundingBox();
    expect(bodyAtEnd!.y + bodyAtEnd!.height).toBeLessThanOrEqual(dockAfter!.y - 8);
    const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const touchPage = await touchContext.newPage();
    await touchPage.goto(project.url);
    await (await projectPage(touchPage)).getByRole("button", { name: "Context", exact: true }).click();
    const touchSetButton = touchPage
      .getByRole("article", { name: "Reading Context" })
      .getByRole("button", { name: /Design review changes Agent/ });
    await expect(touchSetButton).toBeVisible();
    expect((await touchSetButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await touchContext.close();
    const agentMarks = note.locator('mark[data-emphasis-id="design-review"]');
    await expect(agentMarks).toHaveCount(2);
    for (const mark of await agentMarks.all()) {
      const box = await mark.boundingBox();
      expect(box?.width).toBeGreaterThan(0);
      expect(box?.height).toBeGreaterThan(0);
      expect(await mark.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    }
    const boundaryRow = legend.getByRole("button", { name: /Trust boundary/ });
    await boundaryRow.hover();
    await expect(body).toHaveAttribute("data-highlight-focus", "true");
    await expect(agentMarks.first()).toHaveAttribute("data-highlight-focused", "true");
    await body.getByText(/Later prose remains selectable/).hover();
    await expect(body).not.toHaveAttribute("data-highlight-focus");
    await boundaryRow.click();
    await body.getByText(/Later prose remains selectable/).hover();
    await expect(body).toHaveAttribute("data-highlight-focus", "true");
    await page.mouse.click(8, 8);
    await expect(body).toHaveAttribute("data-highlight-focus", "true");
    await boundaryRow.focus();
    await page.keyboard.press("Enter");
    await expect(body).not.toHaveAttribute("data-highlight-focus");
    await page.keyboard.press("Tab");

    await selectPhrase(page, body, "Later prose remains selectable.");
    await expect(page.getByRole("button", { name: "Comment on selection" })).toBeVisible();
    await page.getByRole("button", { name: "Highlight selection" }).click();
    const editor = page.getByRole("form", { name: "Highlight selection" });
    const label = editor.getByRole("textbox", { name: "Group label" });
    await expect(label).toBeFocused();
    // No colour to choose (ADR 0030): the label is followed by Save.
    await expect(editor.getByRole("combobox", { name: "Color" })).toHaveCount(0);
    await label.fill("Follow up");
    await page.keyboard.press("Tab");
    await expect(editor.getByRole("button", { name: "Save" })).toBeFocused();
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(legend.getByRole("button", { name: /Reader highlights You/ })).toHaveAttribute("aria-pressed", "true");
    await expect(note.locator('mark[data-emphasis-id="reader-highlights"]')).toContainText(
      "Later prose remains selectable.",
    );
    // The set's first group takes the first colour.
    await expect(note.locator('mark[data-emphasis-id="reader-highlights"]').first()).toHaveClass(
      /archer-emph-palette-teal/,
    );

    await page.reload();
    await expect(note).toBeVisible();
    await expect(
      note.getByRole("region", { name: "Note highlights" }).getByRole("button", { name: /Reader highlights You/ }),
    ).toBeVisible();
    await expect(note.locator('mark[data-emphasis-id="reader-highlights"]')).toContainText(
      "Later prose remains selectable.",
    );
    await selectPhrase(page, body, "Later prose remains selectable.");

    const beforeConflict = await (
      await page.request.get(project.api("api/note-emphases?path=notes%2Fcontext.md"))
    ).json();
    let intercepted = false;
    await page.route("**/api/note-emphases?*", async (route) => {
      if (route.request().method() !== "POST" || intercepted) {
        await route.continue();
        return;
      }
      intercepted = true;
      await project.agentSetNoteEmphasis({
        notePath: "notes/context.md",
        id: "concurrent-agent",
        title: "Concurrent agent review",
        expectedRevision: beforeConflict.snapshot.revision,
        groups: [
          {
            id: "client",
            label: "Client",
            passages: [{ kind: "passage", quote: "client", prefix: "The ", suffix: " sends" }],
          },
        ],
      });
      await route.continue();
    });
    await page.getByRole("button", { name: "Highlight selection" }).click();
    await editor.getByRole("textbox", { name: "Group label" }).fill("Conflict check");
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor.getByRole("alert")).toContainText("server did not save this highlight");
    await expect(legend.getByRole("alert")).toContainText("revision");
    await expect(editor.getByRole("textbox", { name: "Group label" })).toHaveValue("Conflict check");
    expect(intercepted).toBe(true);
    await page.unroute("**/api/note-emphases?*");
    await editor.getByRole("button", { name: "Cancel" }).click();

    await selectPhrase(page, body, "Later prose remains selectable.");
    await page.getByRole("button", { name: "Comment on selection" }).click();
    const comment = page.getByRole("form", { name: "New comment" });
    await comment.getByRole("textbox", { name: "Comment", exact: true }).fill("Keep this explanation concrete");
    await comment.getByRole("button", { name: "Add comment" }).click();
    const commentMark = note.getByRole("button", { name: "Open discussion on this passage" });
    await expect(commentMark.locator(".archer-note-highlight")).toContainText("Later prose remains selectable.");
    const threadId = await commentMark.getAttribute("data-thread-id");
    expect(threadId).not.toBeNull();
    const discussion = note
      .getByRole("complementary", { name: "Note discussions" })
      .locator(`[data-thread-id="${threadId}"]`);
    const discussionHeader = discussion.locator(".primary-note-discussion-bubble");
    await expect(discussion).toContainText("Keep this explanation concrete");
    await discussion.getByRole("textbox", { name: "Your reply" }).focus();
    await page.keyboard.press("Escape");
    await expect(discussionHeader).toHaveAttribute("aria-expanded", "false");
    await expect(discussionHeader).toBeFocused();
    await commentMark.focus();
    await page.keyboard.press("Enter");
    await expect(discussionHeader).toHaveAttribute("aria-expanded", "true");
    await expect(discussion).toContainText("Keep this explanation concrete");
    await page.keyboard.press("Escape");
    await expect(discussionHeader).toHaveAttribute("aria-expanded", "false");

    await legend.getByRole("button", { name: /Reader highlights You/ }).click();
    writeFileSync(
      resolve(project.root, ".archer/notes/context.md"),
      markdown.replace("Later prose remains selectable.", "Changed prose remains selectable."),
    );
    await expect(body).toContainText("Changed prose remains selectable.");
    await expect(legend).toContainText("1 unavailable");
    await expect(note.locator('mark[data-emphasis-id="reader-highlights"]')).toHaveCount(0);
  } finally {
    await project.stop();
  }
});

// O40: a re-read of the note's highlights that leaves the shown set as it was (here another agent's set
// arriving) laid the note down again, which took the reader's selection out of the document while
// "Comment on selection" stayed up, so the click opened nothing.
test("a highlights re-read that leaves the shown set alone keeps the reader's selection for Comment on selection", async ({
  page,
}) => {
  const project = await startTsProject({
    pagePath: testPage(),
    files: {
      "archer.toml": "version = 1\n",
      ".archer/notes/context.md":
        "# Context\n\nThe **client** sends a token to the API. Later prose remains selectable.\n",
    },
  });
  try {
    const first = await project.agentSetNoteEmphasis({
      notePath: "notes/context.md",
      id: "design-review",
      title: "Design review changes",
      expectedRevision: 0,
      groups: [
        {
          id: "boundary",
          label: "Trust boundary",
          passages: [{ kind: "passage", quote: "client", prefix: "The ", suffix: " sends" }],
        },
      ],
    });
    await page.goto(project.url);
    await (await projectPage(page)).getByRole("button", { name: "Context", exact: true }).click();
    const note = page.getByRole("article", { name: "Reading Context" });
    const body = note.getByRole("document", { name: "Note: Context" });
    const legend = note.getByRole("region", { name: "Note highlights" });
    await expect(legend.getByRole("button", { name: /Design review changes Agent/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(note.locator('mark[data-emphasis-id="design-review"]')).toHaveText("client");

    await selectPhrase(page, body, "Later prose remains selectable.");
    const reread = page.waitForResponse(
      (response) => response.url().includes("api/note-emphases?") && response.request().method() === "GET",
    );
    await project.agentSetNoteEmphasis({
      notePath: "notes/context.md",
      id: "second-review",
      title: "Second review",
      expectedRevision: first.snapshot.revision,
      groups: [
        { id: "api", label: "API", passages: [{ kind: "passage", quote: "API", prefix: "to the ", suffix: "." }] },
      ],
    });
    await reread;
    await expect(legend.getByRole("button", { name: /Second review Agent/ })).toBeVisible();
    await expect(legend.getByRole("button", { name: /Design review changes Agent/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("Later prose remains selectable.");

    await page.getByRole("button", { name: "Comment on selection" }).click();
    await expect(
      page.getByRole("form", { name: "New comment" }).getByRole("textbox", { name: "Comment", exact: true }),
    ).toBeVisible();
  } finally {
    await project.stop();
  }
});

// O207 (codex-1301): Save took the label at the click and, once the write answered, the note closed the form, so
// characters typed into the still-editable label while the save waited were gone without a word. The POST is held
// only to fix the order. Like O189's comments, the form now stays open with the newer label after the answer.
test("a highlight label typed on while Save waits stays in the open form after the save", async ({ page }) => {
  const project = await startTsProject({
    pagePath: resolve("dist/index.html"),
    files: {
      "archer.toml": "version = 1\n",
      ".archer/notes/context.md":
        "# Context\n\nThe **client** sends a token to the API. Later prose remains selectable.\n",
    },
  });
  try {
    await page.goto(project.url);
    await (await projectPage(page)).getByRole("button", { name: "Context", exact: true }).click();
    const note = page.getByRole("article", { name: "Reading Context" });
    const body = note.getByRole("document", { name: "Note: Context" });
    await expect(body).toContainText("Later prose remains selectable.");
    await selectPhrase(page, body, "Later prose remains selectable.");
    await page.getByRole("button", { name: "Highlight selection" }).click();
    const editor = page.getByRole("form", { name: "Highlight selection" });
    const label = editor.getByRole("textbox", { name: "Group label" });
    await label.fill("R13 label");

    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let posted!: (body: string) => void;
    const sent = new Promise<string>((done) => {
      posted = done;
    });
    await page.route("**/api/note-emphases*", async (route) => {
      if (route.request().method() === "GET") {
        await route.continue();
        return;
      }
      posted(route.request().postData() ?? "");
      await gate;
      await route.continue();
    });
    const answered = page.waitForResponse(
      (response) => response.url().includes("api/note-emphases") && response.request().method() !== "GET",
    );
    await editor.getByRole("button", { name: "Save" }).click();
    expect(await sent).toContain("R13 label");
    await caretToLineEnd(label);
    await page.keyboard.type(" UNIQUE LATER");
    await expect(label).toHaveValue("R13 label UNIQUE LATER");
    release();
    await answered;
    await expect(note.locator('mark[data-emphasis-id="reader-highlights"]')).toContainText(
      "Later prose remains selectable.",
    );
    // The save carried the label at the click; the words typed since stay in the open form, and it says why.
    await expect(editor.getByRole("textbox", { name: "Group label" })).toHaveValue("R13 label UNIQUE LATER");
    await expect(editor).toContainText("R13 label");
    await page.unroute("**/api/note-emphases*");
  } finally {
    await project.stop();
  }
});
