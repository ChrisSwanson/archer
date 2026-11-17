import { expect, test } from "@playwright/test";
import { files as projectPage } from "./support/primary-navigation";
import { sharedTsProject } from "./support/shared-service";

test("named note highlights explain cross-markup Unicode passages by pointer and keyboard", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "system"\nkind = "freeform"\ntitle = "System"\nsource = ".archer/system.mmd"\n',
      ".archer/system.mmd": "flowchart LR\n web[Web] e1@--> api[API]\n",
      ".archer/notes/context.md": "# Context\n\nThe **client sends** café 😀 token to the API.\n",
    },
  });
  try {
    await page.goto(project.url);
    await (await projectPage(page)).getByRole("button", { name: "Context", exact: true }).click();
    await project.agentSetNoteEmphasis({
      notePath: "notes/context.md",
      id: "design-review",
      title: "Design review",
      expectedRevision: 0,
      groups: [
        {
          id: "boundary",
          // The longest legend text ADR 0030 allows: a 32-character label and a 90-character description.
          label: `<Trust boundary>${"L".repeat(16)}`,
          description: `Confirm café 😀 stays literal & safe. ${"D".repeat(53)}`,
          passages: [{ kind: "passage", quote: "client sends café 😀 token", prefix: "The ", suffix: " to the API." }],
        },
      ],
    });

    const marks = page.locator('mark[data-emphasis-id="design-review"]');
    await expect(marks).toHaveCount(2);
    const firstThread = await project.agentCreateComment(
      "note:notes/context.md",
      { kind: "passage", quote: "client sends café 😀 token", prefix: "The ", suffix: " to the API." },
      "Check this boundary",
    );
    const secondThread = await project.agentCreateComment(
      "note:notes/context.md",
      { kind: "passage", quote: "client sends café 😀 token", prefix: "The ", suffix: " to the API." },
      "Check this boundary too",
    );
    const discussions = page.getByRole("button", { name: "Open discussion on this passage" });
    const groupedDiscussion = page.getByRole("button", { name: "Open 2 discussions on this passage" });
    await expect(discussions).toHaveCount(0);
    await expect(groupedDiscussion).toHaveCount(1);
    await expect(groupedDiscussion).toHaveAttribute("data-thread-ids", `${firstThread.id} ${secondThread.id}`);
    const darkTreatment = await marks.first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, edge: style.boxShadow, border: style.borderBottomWidth };
    });
    expect(darkTreatment.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(darkTreatment.edge).toBe("none");
    expect(darkTreatment.border).toBe("0px");
    expect(await groupedDiscussion.evaluate((element) => getComputedStyle(element).textDecorationStyle)).toBe("dashed");

    await marks.last().hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText("<Trust boundary>");
    await expect(tooltip).toContainText("Confirm café 😀 stays literal & safe.");
    await expect(tooltip).toContainText("2 discussions");
    await expect(tooltip).toContainText("Open discussions on this passage");
    await expect(tooltip.locator("script, b")).toHaveCount(0);
    await tooltip.hover();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tooltip).toHaveCount(0);

    await groupedDiscussion.focus();
    await expect(page.getByRole("tooltip")).toBeVisible();
    await expect
      .poll(() => marks.evaluateAll((elements) => elements.map((element) => element.getAttribute("tabindex"))))
      .toEqual([null, null]);
    await marks.last().click();
    const rail = page.getByRole("complementary", { name: "Note discussions" });
    await expect(rail.getByRole("status")).toHaveText("2 discussions on this passage. Choose one.");
    await expect(rail.locator(".primary-note-discussion-bubble")).toHaveCount(2);

    await page.setViewportSize({ width: 320, height: 180 });
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await marks.last().hover();
    const box = await page.getByRole("tooltip").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(11);
    expect(box!.x + box!.width).toBeLessThanOrEqual(309);
    expect(box!.y).toBeGreaterThanOrEqual(11);
    expect(box!.y + box!.height).toBeLessThanOrEqual(169);
    expect(box!.height).toBeLessThanOrEqual(156);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    await page.getByRole("tooltip").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll", { bubbles: false }));
    });
    await expect(page.getByRole("tooltip")).toContainText("Confirm café 😀 stays literal & safe.");

    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const lightTreatment = await marks.first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, edge: style.boxShadow };
    });
    expect(lightTreatment.background).not.toBe(darkTreatment.background);
    expect(lightTreatment.edge).toBe("none");
  } finally {
    await project.stop();
  }
});
