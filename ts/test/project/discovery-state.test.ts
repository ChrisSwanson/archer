import { afterEach, expect, test } from "vitest";
import { ProjectState } from "../../src/service/project-state.ts";
import { removeTempDirs, tempDir, FLOW } from "./support.ts";
afterEach(removeTempDirs);
test("project state catalogs configured external docs and preserves legacy aliases", async () => {
  const root = tempDir({
    "archer.toml": 'version=1\n[discovery]\nroots=[".archer", "docs"]\n',
    ".archer/a.md": "# Old",
    "docs/a.md": "# New\n\nOverview details.",
    "docs/a.mmd": FLOW,
  });
  const state = await ProjectState.open(root, (slug) => `http://example/${slug}/`);
  try {
    expect(state.documentCatalog().documents).toHaveLength(3);
  } finally {
    state.close();
  }
});

test("external document reads compile production models and keep embedded diagrams local", async () => {
  const root = tempDir({
    "archer.toml": 'version=1\n[discovery]\nroots=["docs"]\n',
    "docs/a.md": "# A\n\n```mermaid\n" + FLOW + "```\n",
    "docs/a.mmd": FLOW,
  });
  const state = await ProjectState.open(root, (slug) => `http://example/${slug}/`);
  try {
    const content = await state.readDocument("docs/a.md");
    expect(content).toMatchObject({
      kind: "markdown",
      embedded: [{ name: expect.any(String), model: { type: "freeform-graph" } }],
    });
    expect(await state.readDocument("docs/a.mmd")).toMatchObject({
      kind: "mermaid",
      model: { type: "freeform-graph" },
      diagnostics: [],
    });
    expect(state.inventory().views).toHaveLength(0);
    expect(await state.readDocument("../secret.md")).toBeNull();
  } finally {
    state.close();
  }
});
