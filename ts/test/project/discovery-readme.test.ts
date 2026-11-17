// The project's root README.md is discovered by default, read-only, beside the
// Archer folder; it is the only file outside that folder admitted by default.
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { findProject } from "../../src/project/project.ts";
import { discoverAuthoringDocuments, discoverDocuments, readDiscoveredDocument } from "../../src/project/discovery.ts";
import { removeTempDirs, tempDir } from "./support.ts";
afterEach(removeTempDirs);

const READ_ONLY = { read: true, sourceWrite: false, comments: false, emphasis: false };

test("the root README is discovered by default, read-only, and nothing else outside the folder is", () => {
  const project = findProject(
    tempDir({
      ".archer/notes/a.md": "# A",
      "README.md": "# Root\n\nAbout.\n",
      "docs/b.md": "# B",
      "CHANGELOG.md": "# Log",
    }),
  );
  const catalog = discoverDocuments(project);
  expect(catalog.documents.map((entry) => entry.source.path)).toEqual([".archer/notes/a.md", "README.md"]);
  expect(catalog.documents[1]).toEqual({ source: { path: "README.md" }, kind: "markdown", capabilities: READ_ONLY });
  expect(catalog.complete).toBe(true);
  expect(readDiscoveredDocument(project, catalog, "README.md")?.text).toBe("# Root\n\nAbout.\n");
});

test("a missing, symlinked, directory or differently cased README adds nothing and no diagnostic", () => {
  const missing = findProject(tempDir({ ".archer/a.md": "# A" }));
  expect(discoverDocuments(missing)).toMatchObject({ complete: true, diagnostics: [] });
  expect(discoverDocuments(missing).documents.map((entry) => entry.source.path)).toEqual([".archer/a.md"]);

  const outside = tempDir({ "README.md": "private" });
  const linked = tempDir({ ".archer/a.md": "# A" });
  symlinkSync(join(outside, "README.md"), join(linked, "README.md"));
  const linkedCatalog = discoverDocuments(findProject(linked));
  expect(linkedCatalog.documents.map((entry) => entry.source.path)).toEqual([".archer/a.md"]);
  expect(readDiscoveredDocument(findProject(linked), linkedCatalog, "README.md")).toBeNull();

  const directory = tempDir({ ".archer/a.md": "# A" });
  mkdirSync(join(directory, "README.md"));
  writeFileSync(join(directory, "README.md", "inner.md"), "# Inner");
  expect(discoverDocuments(findProject(directory)).documents.map((entry) => entry.source.path)).toEqual([
    ".archer/a.md",
  ]);

  const cased = findProject(tempDir({ ".archer/a.md": "# A", "readme.md": "# lower" }));
  expect(discoverDocuments(cased).documents.map((entry) => entry.source.path)).toEqual([".archer/a.md"]);
});

test("explicit roots keep the README unless an exclusion names it", () => {
  const project = findProject(tempDir({ ".archer/a.md": "# A", "README.md": "# Root", "docs/b.md": "# B" }));
  expect(discoverDocuments(project, { roots: ["docs"] }).documents.map((entry) => entry.source.path)).toEqual([
    "README.md",
    "docs/b.md",
  ]);
  expect(discoverDocuments(project, { roots: [] }).documents.map((entry) => entry.source.path)).toEqual(["README.md"]);
  expect(discoverDocuments(project, { roots: [".", ".archer"] }).documents.map((entry) => entry.source.path)).toEqual([
    ".archer/a.md",
    "README.md",
    "docs/b.md",
  ]);
  expect(discoverDocuments(project, { exclude: ["README.md"] }).documents.map((entry) => entry.source.path)).toEqual([
    ".archer/a.md",
  ]);
  expect(
    discoverDocuments(project, { roots: ["."], exclude: ["*.md"] }).documents.map((entry) => entry.source.path),
  ).toEqual([".archer/a.md", "docs/b.md"]);
});

test("the authoring scope never includes the root README", () => {
  const project = findProject(tempDir({ ".archer/a.md": "# A", "README.md": "# Root" }));
  expect(discoverAuthoringDocuments(project).documents.map((entry) => entry.source.path)).toEqual([".archer/a.md"]);
});

test("an oversized README is left out without making the catalog incomplete", () => {
  const project = findProject(tempDir({ ".archer/a.md": "# A" }));
  writeFileSync(join(project.root, "README.md"), "x".repeat(1024 * 1024 + 1));
  expect(discoverDocuments(project)).toMatchObject({
    complete: true,
    documents: [{ source: { path: ".archer/a.md" } }],
  });
});
