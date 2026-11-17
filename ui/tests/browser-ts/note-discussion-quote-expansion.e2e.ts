import { expect, test } from "@playwright/test";
import { files as projectPage } from "./support/primary-navigation";
import { sharedTsProject } from "./support/shared-service";

test("a discussion header expands its plain quote and re-clamps without losing the reply", async ({ page }) => {
  const quote =
    "The parser accepts nearby tokens while preserving the exact surrounding passage for careful review across each supported format. "
      .repeat(9)
      .slice(0, 1000);
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/system.mmd"\n',
      ".archer/system.mmd": "flowchart LR\n web[Web] edge@--> api[API]\n",
      ".archer/notes/quote.md": `# Quote expansion\n\n${"Lead-in keeps the passage below the fold.\n\n".repeat(16)}${quote}\n\n${"Trailing text keeps the reader scrollable.\n\n".repeat(64)}`,
    },
  });
  try {
    await page.setViewportSize({ width: 390, height: 740 });
    await page.goto(project.url);
    await (await projectPage(page)).getByRole("button", { name: "Quote expansion", exact: true }).click();
    const created = await project.agentCreateComment(
      "note:notes/quote.md",
      {
        kind: "passage",
        quote,
        prefix: "",
        suffix: "",
      },
      "Review the full wording.",
    );
    const reader = page.getByRole("article", { name: "Reading Quote expansion" });
    const discussion = reader.locator(`.primary-note-discussion[data-thread-id="${created.id}"]`);
    const header = discussion.locator(".primary-note-discussion-bubble");
    await header.click();
    const reply = discussion.getByRole("textbox", { name: "Your reply" });
    await reply.fill("Draft survives quote inspection");
    const compactHeight = (await header.boundingBox())!.height;
    await expect(header.locator(".primary-note-discussion-quote-bridge")).toHaveText("...");
    await expect(header.locator(".primary-note-discussion-quote-start")).toHaveText(quote.slice(0, 48).trimEnd());
    await expect(header.locator(".primary-note-discussion-quote-end")).toHaveText(quote.slice(-24).trimStart());

    await header.click();
    await expect(header).toHaveAccessibleName(`Collapse quoted passage “${quote}”`);
    expect((await header.boundingBox())!.height).toBeGreaterThan(compactHeight);
    await expect(discussion.locator(".primary-note-discussion-quote")).toHaveText(quote);
    await expect(discussion.locator(".primary-note-discussion-quote mark")).toHaveCount(0);
    await expect(reply).toHaveValue("Draft survives quote inspection");
    await expect
      .poll(async () => {
        const box = (await discussion.boundingBox())!;
        return box.y >= 0 && box.y + box.height <= page.viewportSize()!.height;
      })
      .toBe(true);
    await discussion.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(reply).toBeInViewport();
    await discussion.evaluate((element) => {
      element.scrollTop = 0;
    });

    const passage = reader.locator(`mark[data-thread-id="${created.id}"]`);
    const [passageBox, readerBox] = await Promise.all([passage.boundingBox(), reader.boundingBox()]);
    const barBottom = await page
      .locator("html")
      .evaluate(
        (element) => Number.parseFloat(getComputedStyle(element).getPropertyValue("--primary-bar-bottom")) || 0,
      );
    const visibleTop = Math.max(readerBox!.y, barBottom);
    await reader.evaluate(
      (element, distance) => {
        element.scrollTop += distance;
      },
      passageBox!.y + passageBox!.height - visibleTop + 1,
    );
    await expect
      .poll(async () => {
        const anchor = await passage.boundingBox();
        return anchor!.y + anchor!.height < visibleTop;
      })
      .toBe(true);
    await expect(discussion).toContainText("Original passage above");
    await header.click();
    await expect(header).toHaveAccessibleName(`Show full quoted passage “${quote}”`);
    await expect(discussion).toContainText("Original passage above");
    await expect(reply).toHaveValue("Draft survives quote inspection");
  } finally {
    await project.stop();
  }
});
