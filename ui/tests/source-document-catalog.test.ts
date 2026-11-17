import { expect, it } from "vitest";
import { parseProjectCatalog } from "../src/app/project-directory";
import { fileRows } from "../src/app/file-index";
it("retains configured source documents and deduplicates legacy aliases", () => {
  const documents = [
    {
      source: { path: ".archer/notes/a.md" },
      kind: "markdown",
      legacy: { notePath: "notes/a.md" },
      title: "A",
      capabilities: { read: true, sourceWrite: false, comments: true, emphasis: true },
    },
    {
      source: { path: "docs/guide.md" },
      kind: "markdown",
      title: "Guide",
      capabilities: { read: true, sourceWrite: false, comments: false, emphasis: false },
    },
  ];
  const catalog = parseProjectCatalog({
    schemaVersion: 1,
    projects: [
      { slug: "a-12345678", name: "A", views: [], notes: [{ path: "notes/a.md", title: "A", viewIds: [] }], documents },
    ],
  });
  expect(catalog?.[0]?.documents).toEqual(documents);
  const rows = fileRows({ ...catalog![0]!, current: true });
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.title === "A")?.sourcePath).toBe(".archer/notes/a.md");
  expect(rows.find((row) => row.title === "Guide")?.sourceDocumentPath).toBe("docs/guide.md");
});
it("treats configured coverage as authoritative while retaining alias IDs and discovery completeness", () => {
  const documents = {
    documents: [
      {
        source: { path: ".archer/notes/a.md" },
        kind: "markdown",
        legacy: { notePath: "notes/a.md" },
        title: "A",
        capabilities: { read: true, sourceWrite: false, comments: true, emphasis: true },
      },
    ],
    complete: false,
    diagnostics: [{ code: "file_limit", path: ".archer", message: "Too many files" }],
  };
  const catalog = parseProjectCatalog({
    schemaVersion: 1,
    projects: [
      {
        slug: "a-12345678",
        name: "A",
        views: [],
        notes: [
          { path: "notes/a.md", title: "A", viewIds: [] },
          { path: "notes/excluded.md", title: "Excluded", viewIds: [] },
        ],
        documents,
      },
    ],
  });
  expect(fileRows({ ...catalog![0]!, current: true }).map((row) => row.id)).toEqual(["notes/a.md"]);
  expect(catalog![0]?.discoveryComplete).toBe(false);
});
