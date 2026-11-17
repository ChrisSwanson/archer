import { afterEach, expect, test } from "vitest";
import { ProjectState } from "../../src/service/project-state.ts";
import { cleanUp, tempDir, write } from "./support.ts";
afterEach(cleanUp);
test("browser search finds external body-only words with source targets and excludes unadmitted documents", async () => {
  const root = tempDir();
  write(root, "archer.toml", 'version=1\n[discovery]\nroots=["docs"]\nexclude=["docs/private/**"]\n');
  write(root, "docs/guide.md", "# Guide\n\nOverview words.\n\n## Details\n\nExternal zeppelin payload.");
  write(root, "docs/private/hidden.md", "# Hidden\n\nzeppelin");
  write(root, "outside.md", "# Outside\n\nzeppelin");
  write(root, ".archer/hidden.md", "# Legacy\n\nzeppelin");
  const state = await ProjectState.open(root, (slug) => `http://example/${slug}/`);
  try {
    expect(state.browserSearch("zeppelin").results).toEqual([
      expect.objectContaining({
        target: "source:docs/guide.md",
        title: "Guide",
        where: ["note"],
        matches: expect.arrayContaining([
          expect.objectContaining({ field: "note", text: expect.stringContaining("zeppelin") }),
        ]),
      }),
    ]);
    expect(state.browserSearch("guide payload").results).toHaveLength(1);
    expect(state.browserSearch("guide nonexistent").results).toHaveLength(0);
    expect(state.search("zeppelin").results).toEqual([expect.objectContaining({ target: "note:hidden.md" })]);
  } finally {
    state.close();
  }
});
