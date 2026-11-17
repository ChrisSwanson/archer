import { expect, test } from "@playwright/test";
import { files as projectPage } from "./support/primary-navigation";
import { sharedTsProject } from "./support/shared-service";

test("passage discussions track the note, pack without overlap, focus their quote, and resolve inline", async ({
  page,
}) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/system.mmd"\n',
      ".archer/system.mmd": "flowchart LR\n web[Web] edge@--> api[API]\n",
      ".archer/notes/margin.md": `# Discussion margin

${"Lead-in text keeps the target below the fold.\n\n".repeat(64)}
The parser accepts nearby tokens.

The renderer keeps the next line close.

${"Trailing text keeps the page scrollable.\n\n".repeat(64)}`,
    },
  });
  try {
    await page.goto(project.url);
    await (await projectPage(page)).getByRole("button", { name: "Discussion margin", exact: true }).click();
    const noteColumn = page.locator(".primary-note-document-column");
    const widthWithoutComments = (await noteColumn.boundingBox())!.width;
    const first = await project.agentCreateComment(
      "note:notes/margin.md",
      {
        kind: "passage",
        quote: "parser accepts nearby tokens",
        prefix: "The ",
        suffix: ".",
      },
      "Check the parser explanation.",
    );
    const second = await project.agentCreateComment(
      "note:notes/margin.md",
      {
        kind: "passage",
        quote: "parser accepts nearby tokens",
        prefix: "The ",
        suffix: ".",
      },
      "A second discussion on the same passage.",
    );

    const reader = page.getByRole("article", { name: "Reading Discussion margin" });
    const rail = reader.getByRole("complementary", { name: "Note discussions" });
    const bubbles = rail.locator(".primary-note-discussion-bubble");
    await expect(bubbles).toHaveCount(2);
    expect((await noteColumn.boundingBox())!.width).toBe(widthWithoutComments);
    const notifications = page.getByRole("button", { name: /^Notifications/ });
    const review = page.getByRole("region", { name: "Project Review" });
    await notifications.click();
    await expect(review).toBeVisible();
    expect((await noteColumn.boundingBox())!.width).toBe(widthWithoutComments);
    await notifications.click();
    await expect(review).toBeHidden();

    // The gap between the first two bubbles, polled: the margin repacks once the review panel has gone.
    await expect
      .poll(async () => {
        const packed = await bubbles.evaluateAll((elements) =>
          elements
            .map((element) => element.getBoundingClientRect())
            .map((rect) => ({ top: rect.top, bottom: rect.bottom }))
            .sort((a, b) => a.top - b.top),
        );
        return packed[1]!.top - packed[0]!.bottom;
      })
      .toBeGreaterThanOrEqual(0);
    const colors = await bubbles.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).backgroundColor),
    );
    expect(new Set(colors).size).toBe(1);

    const parserBubble = rail.locator(`[data-thread-id="${first.id}"] .primary-note-discussion-bubble`);
    const parserMark = reader.locator(`mark[data-thread-id="${first.id}"]`);
    await parserBubble.hover();
    await expect(parserMark).toHaveAttribute("data-active-discussion", "true");
    await parserBubble.focus();
    await expect(parserBubble).toBeFocused();
    const contrast = await reader.locator(".archer-note-body").evaluate((body, markSelector) => {
      const mark = body.querySelector(markSelector as string)!;
      return { surrounding: getComputedStyle(body).color, quote: getComputedStyle(mark).color };
    }, `mark[data-thread-id="${first.id}"]`);
    expect(contrast.quote).not.toBe(contrast.surrounding);

    const beforeScroll = await parserBubble.boundingBox();
    await reader.evaluate((element) => {
      element.scrollTop += 240;
    });
    await expect.poll(async () => (await parserBubble.boundingBox())?.y).toBeLessThan(beforeScroll!.y);
    const anchorBox = (await parserMark.boundingBox())!;
    const packedBoxes = await bubbles.evaluateAll((elements) =>
      elements.map((element) => ({ y: element.getBoundingClientRect().y })),
    );
    expect(Math.min(...packedBoxes.map((box) => Math.abs(anchorBox.y - box.y)))).toBeLessThanOrEqual(16);

    await parserBubble.click();
    const panel = rail.locator(`[data-thread-id="${first.id}"]`);
    await expect(panel).toContainText("Check the parser explanation.");
    const initiallyAttached = await Promise.all([parserMark.boundingBox(), panel.boundingBox()]);
    expect(Math.abs(initiallyAttached[0]!.y - initiallyAttached[1]!.y)).toBeLessThanOrEqual(16);
    const reply = panel.getByRole("textbox", { name: "Your reply" });
    await reply.fill("Draft stays while reading more context");
    await reply.focus();
    await page.mouse.move(8, 8);
    await expect(parserMark).toHaveAttribute("data-active-discussion", "true");
    const [passageBox, readerBox] = await Promise.all([parserMark.boundingBox(), reader.boundingBox()]);
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
        const anchor = await parserMark.boundingBox();
        return anchor!.y + anchor!.height < visibleTop;
      })
      .toBe(true);
    await expect(reply).toBeFocused();
    await expect(reply).toHaveValue("Draft stays while reading more context");
    const fixed = await panel.boundingBox();
    expect(fixed!.y).toBeGreaterThanOrEqual(64);
    expect(fixed!.y + fixed!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await expect(panel).toContainText("Original passage above");
    await reader.evaluate((element) => {
      element.scrollTop = 0;
    });
    const visibleBottom = Math.min(readerBox!.y + readerBox!.height, page.viewportSize()!.height);
    await expect
      .poll(async () => {
        const anchor = await parserMark.boundingBox();
        return anchor!.y > visibleBottom;
      })
      .toBe(true);
    await expect(panel).toContainText("Original passage below");
    const clampedBelow = await panel.boundingBox();
    expect(clampedBelow!.y + clampedBelow!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await expect(reply).toHaveValue("Draft stays while reading more context");
    await notifications.click();
    await expect(review).toBeVisible();
    for (let request = 0; request < 2; request++) {
      // The inbox press closes the margin first; requesting the same thread again
      // must bring keyboard focus back to its margin header on every request.
      await review.locator(`#primary-inbox-entry-${first.id}`).click();
      await review.getByRole("button", { name: "Show in note" }).click();
      await expect(parserBubble).toBeFocused();
      await expect(reply).toHaveValue("Draft stays while reading more context");
    }
    await notifications.click();
    await expect(review).toBeHidden();
    // The outside press also collapses the discussion; reopen it to resolve.
    await parserBubble.click();
    await expect(reply).toBeVisible();
    await expect(reply).toHaveValue("Draft stays while reading more context");
    await panel.getByRole("button", { name: "Resolve" }).click();
    await expect(bubbles).toHaveCount(1);
    await expect(parserMark).toHaveCount(0);
    await rail.locator(`[data-thread-id="${second.id}"] .primary-note-discussion-bubble`).click();
    await expect(rail.locator(`[data-thread-id="${second.id}"]`)).toContainText(
      "A second discussion on the same passage.",
    );
  } finally {
    await project.stop();
  }
});
