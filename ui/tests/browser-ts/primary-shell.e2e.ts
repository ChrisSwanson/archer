import { expect, test } from "@playwright/test";
import { graphToolsTrigger } from "./support/primary-navigation";
import { sharedTsProject } from "./support/shared-service";

test("the project page opens actual notes with breadcrumbs, and the shortcuts still reach the search page and the sheet", async ({
  page,
}) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "pipeline"\nkind = "freeform"\ntitle = "Compile pipeline"\nsource = ".archer/pipeline.mmd"\n',
      ".archer/pipeline.mmd": "flowchart LR\nlexer[Lexer] e1@--> parser[Parser]\n",
      ".archer/notes/parsing.md":
        "---\ndiagrams: [../pipeline.mmd]\n---\n# Parsing\n\nThe tokenizer hands tokens to the parser.\n\n[Compile pipeline](../pipeline.mmd)\n",
    },
  });
  try {
    await page.goto(project.url);
    const files = page.getByRole("region", { name: "Project documents", exact: true });
    await expect(files).toBeVisible();
    await files.getByRole("button", { name: "Parsing", exact: true }).click();
    await expect(page.getByRole("article", { name: "Reading Parsing" })).toContainText("The tokenizer hands tokens");
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Parsing");
    // The folder segment walks to the folder: its notes on the page, not the search.
    await page
      .getByRole("navigation", { name: "Breadcrumb" })
      .getByRole("button", { name: "notes", exact: true })
      .click();
    const folder = page.getByRole("region", { name: "notes", exact: true });
    await expect(folder).toBeVisible();
    // The folder's page is the project page scoped to the folder: its list holds only the folder's files.
    await expect(files.getByRole("button", { name: "Parsing", exact: true })).toBeVisible();
    await expect(files.getByRole("button", { name: "Compile pipeline", exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("notes");
    await folder.getByRole("button", { name: /^Parsing/ }).click();
    await expect(page.getByRole("article", { name: "Reading Parsing" })).toBeVisible();
    await page
      .getByRole("article", { name: "Reading Parsing" })
      .getByRole("link", { name: "Compile pipeline", exact: true })
      .click();
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await graphToolsTrigger(page).click();
    await expect(page.getByRole("button", { name: "Compare revisions" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("g");
    const search = page.getByRole("searchbox", { name: "Search projects and files" });
    await expect(search).toBeFocused();
    await search.blur();
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog")).toBeVisible();
  } finally {
    await project.stop();
  }
});

test("primary shell keeps collapsed rail labels hidden and phone actions inside the viewport", async ({ page }) => {
  const project = await sharedTsProject({
    files: {
      "archer.toml":
        'version = 1\n[[views]]\nid = "pipeline"\nkind = "freeform"\ntitle = "Compile pipeline for the project"\nsource = ".archer/pipeline.mmd"\n',
      ".archer/pipeline.mmd": "flowchart LR\nlexer[Lexer] e1@--> parser[Parser]\n",
    },
  });
  try {
    await page.goto(project.url);
    await project.present("pipeline");
    await expect(page.locator(".react-flow__node").first()).toBeVisible();
    await page.mouse.move(700, 400);
    await expect(page.locator(".primary-navigation")).toHaveAttribute("data-expanded", "false");
    // The shortcuts glyph is visible ink, not one of the labels revealed by hover.
    await expect(page.locator(".primary-help-glyph")).toBeVisible();
    await expect
      .poll(
        () =>
          page
            .locator(".primary-rail button span:not(.primary-help-glyph)")
            .evaluateAll((labels) => labels.every((label) => getComputedStyle(label).visibility === "hidden")),
        { message: "collapsed labels are hidden" },
      )
      .toBe(true);
    await page.getByRole("button", { name: "Archer contents", exact: true }).hover();
    await expect(page.locator(".primary-brand span")).toHaveCSS("visibility", "visible");
    await page.mouse.move(700, 500);
    await page.setViewportSize({ width: 390, height: 844 });
    for (const control of [page.locator(".archer-theme-toggle"), page.locator(".archer-review-toggle")]) {
      await expect(control).toBeVisible();
      const bounds = await control.boundingBox();
      // The sidebar is a drawer on a phone: the bar starts at the edge, and nothing is under a rail.
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.locator(".primary-document-identity h1")).toContainText("Compile pipeline for the project");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  } finally {
    await project.stop();
  }
});
