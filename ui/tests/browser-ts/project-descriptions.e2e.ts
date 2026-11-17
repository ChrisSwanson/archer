import { test, expect } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

test("a Unicode project and README description at the limit keeps the complete catalog usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const summary = "🚀".repeat(500);
  const project = await sharedTsProject({
    files: {
      "archer.toml": `version = 1\nname = "Unicode pageturner"\ndescription = ${JSON.stringify(summary)}\n`,
      "README.md": `---\ndescription: ${summary}\n---\n# Context\n\nLedger context.\n`,
    },
  });
  try {
    await page.goto(project.url); // Nothing presented: the follow page is the all-projects overview.
    await expect(page.locator("[data-project-root] .archer-folder-tree-description")).toHaveText(summary);
    await expect(
      page.getByRole("treegrid", { name: "Project files" }).getByRole("link", { name: /^Unicode pageturner/ }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  } finally {
    await project.stop();
  }
});

for (const width of [1440, 390]) {
  test(`overview prefers plain manifest description to README text at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const summary = "<b>Shared project context</b>";
    const project = await sharedTsProject({
      files: {
        "archer.toml": `version = 1\nname = "Explicit pageturner"\ndescription = ${JSON.stringify(summary)}\n`,
        "README.md": "# Pageturner\n\nFallback project context.\n",
      },
    });
    try {
      await page.goto(project.url); // Nothing presented: the follow page is the all-projects overview.
      await expect(page.locator("[data-project-root] .archer-folder-tree-description")).toHaveText(summary);
      await expect(page.locator("[data-project-root] .archer-folder-tree-description" + " b")).toHaveCount(0);
    } finally {
      await project.stop();
    }
  });
  test(`overview shows the root README blurb beside its name at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const summary = "A compact reader for following serialised novels.";
    const project = await sharedTsProject({
      files: {
        "archer.toml": 'version = 1\nname = "Pageturner"\n',
        "README.md": `# Pageturner reader\n\n${summary}\n`,
        // The Archer folder's README is an ordinary note, never the project description.
        ".archer/README.md": "# Archer folder\n\nNot the project description.\n",
        ".archer/notes/planning/overview.md": "# Planning\n\nA planning note belongs to the same project.\n",
      },
    });
    try {
      await page.goto(project.url); // Nothing presented: the follow page is the all-projects overview.
      const blurb = page.locator("[data-project-root] .archer-folder-tree-description");
      await expect(blurb).toHaveText(summary);
      // The project's root row: its name, and the blurb in the aligned Title column beside it;
      // on a phone the tree reads as names with whole titles beneath.
      const name = page
        .getByRole("region", { name: "Project documents", exact: true })
        .getByRole("link", { name: "Pageturner", exact: true });
      await expect(name).toBeVisible();
      const nameBox = await name.boundingBox(),
        descriptionBox = await blurb.boundingBox();
      if (width > 640) {
        expect(descriptionBox!.x).toBeGreaterThanOrEqual(nameBox!.x + nameBox!.width);
        expect(
          Math.abs(descriptionBox!.y + descriptionBox!.height / 2 - (nameBox!.y + nameBox!.height / 2)),
        ).toBeLessThan(nameBox!.height);
      } else {
        expect(descriptionBox!.y).toBeGreaterThanOrEqual(nameBox!.y + nameBox!.height - 1);
        expect(descriptionBox!.x + descriptionBox!.width).toBeLessThanOrEqual(width);
      }
      await expect(page.getByText("Not the project description.", { exact: true })).toHaveCount(0);
      await page.screenshot({ path: `/tmp/archer-project-description-${width}.png`, fullPage: true });
    } finally {
      await project.stop();
    }
  });
}
