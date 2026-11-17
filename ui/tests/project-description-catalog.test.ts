import { expect, test } from "vitest";
import { parseProjectCatalog } from "../src/app/project-directory";

const project = { slug: "billing", name: "Billing", views: [], notes: [] };
const catalog = (entry: Record<string, unknown>) => parseProjectCatalog({ schemaVersion: 1, projects: [entry] });

test("project catalog accepts an optional bounded description without inheriting it from child files", () => {
  expect(catalog(project)?.[0]).toMatchObject({ slug: "billing", name: "Billing" });
  expect(catalog({ ...project, description: "Tracks settlement batches." })?.[0]?.description).toBe(
    "Tracks settlement batches.",
  );
  expect(catalog({ ...project, description: "x".repeat(501) })).toEqual([]);
  expect(catalog({ ...project, description: { text: "invalid" } })).toEqual([]);
});

test.each([false, true])("project catalog accepts 500 Unicode code points in %s document metadata", (document) => {
  const entry = (description: string) =>
    document
      ? {
          ...project,
          documents: [
            {
              source: { path: ".archer/README.md" },
              kind: "markdown",
              title: "Context",
              description,
              capabilities: { read: true, sourceWrite: false, comments: true, emphasis: true },
            },
          ],
        }
      : { ...project, description };
  const description = "🚀".repeat(500);
  expect(catalog(entry(description))).toHaveLength(1);
  expect(catalog(entry(description + "a"))).toEqual([]);
  expect(catalog(entry("a".repeat(100_000)))).toEqual([]);
});
