/**
 * D3 settled once per visit (perf pass 2): a project crossing 200 files while
 * its Folders tree is on screen (an agent writing notes, picked up by the
 * catalog's poll) leaves its folders as they were, and the file the reader
 * had focused keeps focus.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { sharedTsProject } from "./support/shared-service";

test("a project crossing 200 files while on screen keeps its folders open and the focused file focused", async ({
  page,
}) => {
  const files: Record<string, string> = { "archer.toml": "version = 1\n" };
  for (let i = 0; i < 200; i++)
    files[`.archer/notes/${i % 2 === 0 ? "a" : "b"}/n${String(i).padStart(3, "0")}.md`] = `# Note ${i}\n`;
  const project = await sharedTsProject({ files });
  try {
    await page.goto(project.url);
    const grid = page.getByRole("treegrid").first();
    const notes = grid.getByRole("button", { name: /^(Expand|Collapse) notes$/ });
    await expect(notes).toHaveAttribute("aria-expanded", "true");
    const focused = grid.getByRole("button", { name: "Note 7", exact: true });
    await focused.focus();
    await expect(focused).toBeFocused();

    writeFileSync(join(project.root, ".archer/notes/b/z-new.md"), "# Note new\n");
    writeFileSync(join(project.root, ".archer/notes/b/z-newer.md"), "# Note newer\n");
    // The catalog's next read (its poll, or the page coming back into view) brings the 202 files.
    await expect
      .poll(
        async () => {
          await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
          return await grid.locator('[data-folder="notes"] .archer-folder-tree-count').textContent();
        },
        { timeout: 20_000, intervals: [500] },
      )
      .toBe("202");

    await expect(notes).toHaveAttribute("aria-expanded", "true");
    await expect(grid.getByRole("button", { name: /^(Expand|Collapse) b$/ })).toHaveAttribute("aria-expanded", "true");
    await expect(focused).toBeFocused();

    // A fresh visit to the larger project starts with its folders closed (D3).
    await page.reload();
    await expect(notes).toHaveAttribute("aria-expanded", "false");
  } finally {
    await project.stop();
  }
});
