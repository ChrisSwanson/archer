import { symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { findProject } from "../../src/project/project.ts";
import {
  DISCOVERY_LIMITS,
  parseDiscoverySettings,
  readDiscoveredDocument,
  resolveDiscoverySettings,
  discoverDocuments,
} from "../../src/project/discovery.ts";
import { removeTempDirs, tempDir } from "./support.ts";
afterEach(removeTempDirs);
test("defaults to the legacy folder and preserves note aliases", () => {
  const project = findProject(tempDir({ ".archer/notes/a.md": "# Legacy", "docs/a.md": "# Outside" }));
  expect(discoverDocuments(project).documents).toEqual([
    {
      source: { path: ".archer/notes/a.md" },
      kind: "markdown",
      legacy: { notePath: "notes/a.md" },
      capabilities: { read: true, sourceWrite: false, comments: true, emphasis: true },
    },
  ]);
});

test("expanded roots keep colliding names distinct and external entries read-only", () => {
  const project = findProject(
    tempDir({ ".archer/docs/a.md": "legacy", "docs/a.md": "external", "docs/z.mmd": "flowchart TD" }),
  );
  const catalog = discoverDocuments(project, { roots: [".", "docs", ".archer"] });
  expect(catalog.documents.map((entry) => entry.source.path)).toEqual([".archer/docs/a.md", "docs/a.md", "docs/z.mmd"]);
  expect(catalog.documents[0]?.legacy).toEqual({ notePath: "docs/a.md" });
  for (const entry of catalog.documents.slice(1)) {
    expect(entry.legacy).toBeUndefined();
    expect(entry.capabilities).toEqual({ read: true, sourceWrite: false, comments: false, emphasis: false });
  }
});

test("legacy custom folder and explicit registered view IDs stay unchanged", () => {
  const project = findProject(
    tempDir({
      "archer.toml":
        'version=1\nfolder="documentation"\n[[views]]\nid="custom-id"\nkind="freeform"\ntitle="Custom"\nsource="documentation/a.mmd"\n',
      "documentation/a.mmd": "flowchart TD",
    }),
  );
  expect(discoverDocuments(project).documents[0]?.legacy).toEqual({ viewId: "custom-id" });
  expect(resolveDiscoverySettings(project).roots).toEqual(["documentation"]);
});

test("configuration inherits per field and empty lists replace defaults", () => {
  const project = findProject(tempDir());
  expect(
    resolveDiscoverySettings(project, {
      system: { roots: ["docs"], exclude: ["**/old/**"] },
      user: { exclude: [] },
      project: { roots: [] },
    }),
  ).toEqual({ roots: [], exclude: [] });
  expect(discoverDocuments(project).complete).toBe(true);
  expect(discoverDocuments(project, { roots: ["missing"] })).toMatchObject({
    complete: false,
    diagnostics: [{ code: "root_unavailable" }],
  });
});

test.each([
  null,
  [],
  { unknown: 1 },
  { roots: "docs" },
  { roots: ["../escape"] },
  { roots: ["/tmp"] },
  { roots: ["a\\b"] },
  { roots: ["C:drive"] },
  { roots: ["docs/**"] },
  { exclude: ["!docs"] },
  { exclude: ["[abc]"] },
  { exclude: ["a/**b"] },
])("unsafe configuration is refused: %j", (raw) => {
  expect(() => parseDiscoverySettings(raw)).toThrow(/discovery/);
});

test("excluded, generated and hidden descendants are omitted; explicit roots opt in", () => {
  const project = findProject(
    tempDir({
      "docs/a.md": "a",
      "docs/deep/skip.md": "skip",
      "docs/.secret.md": "hidden",
      "node_modules/lib/a.md": "dependency",
      ".hidden/yes.md": "explicit",
    }),
  );
  const catalog = discoverDocuments(project, {
    roots: [".", "node_modules/lib", ".hidden"],
    exclude: ["docs/**/skip.md"],
  });
  expect(catalog.documents.map((entry) => entry.source.path)).toEqual([
    ".hidden/yes.md",
    "docs/a.md",
    "node_modules/lib/a.md",
  ]);
  expect(catalog.complete).toBe(true);
});

test("symlinks cannot admit outside content, including symlink ancestors", () => {
  const outside = tempDir({ "secret.md": "private" });
  const root = tempDir({ ".archer/a.md": "inside" });
  symlinkSync(join(outside, "secret.md"), join(root, ".archer/escape.md"));
  symlinkSync(outside, join(root, "linked"));
  const project = findProject(root);
  const catalog = discoverDocuments(project, { roots: [".archer", "linked/secret.md"] });
  expect(catalog.documents.map((entry) => entry.source.path)).toEqual([".archer/a.md"]);
  expect(catalog.complete).toBe(false);
  expect(readDiscoveredDocument(project, catalog, "linked/secret.md")).toBeNull();
});

test("content reads require authentic admission and recheck replacement symlinks", () => {
  const root = tempDir({ ".archer/a.md": "inside", "private.md": "private" }),
    outside = tempDir({ "a.md": "outside" });
  const project = findProject(root),
    catalog = discoverDocuments(project);
  expect(readDiscoveredDocument(project, catalog, ".archer/a.md")?.text).toBe("inside");
  expect(readDiscoveredDocument(project, catalog, "private.md")).toBeNull();
  expect(readDiscoveredDocument(project, { ...catalog }, ".archer/a.md")).toBeNull();
  unlinkSync(join(root, ".archer/a.md"));
  symlinkSync(join(outside, "a.md"), join(root, ".archer/a.md"));
  expect(readDiscoveredDocument(project, catalog, ".archer/a.md")).toBeNull();
});

test("regular descriptor reads reject FIFOs and invalid UTF-8", () => {
  const root = tempDir({ ".archer/a.md": "good" });
  const project = findProject(root),
    catalog = discoverDocuments(project);
  writeFileSync(join(root, ".archer/a.md"), Buffer.from([0xff, 0xfe]));
  expect(readDiscoveredDocument(project, catalog, ".archer/a.md")).toBeNull();
  unlinkSync(join(root, ".archer/a.md"));
  if (process.platform !== "win32") {
    const result = spawnSync("mkfifo", [join(root, ".archer/a.md")]);
    expect(result.status).toBe(0);
    expect(readDiscoveredDocument(project, catalog, ".archer/a.md")).toBeNull();
  }
});

test.each([
  [{ directories: 0 }, "directory_limit"],
  [{ entries: 0 }, "entry_limit"],
  [{ documents: 0 }, "catalog_limit"],
  [{ bytes: 0 }, "catalog_limit"],
  [{ matchWork: 0 }, "match_limit"],
] as const)("limits produce explicit incomplete coverage %j", (limits, code) => {
  const project = findProject(tempDir({ ".archer/a.md": "a" }));
  const catalog = discoverDocuments(project, { exclude: ["**/absent.md"] }, limits);
  expect(catalog.complete).toBe(false);
  expect(catalog.diagnostics.some((entry) => entry.code === code)).toBe(true);
});

test("depth compiles at the exact bound and refuses deeper recursion by name", () => {
  const root = tempDir({ ".archer/a/b/yes.md": "yes" });
  const project = findProject(root);
  expect(discoverDocuments(project, {}, { depth: 2 }).documents).toHaveLength(1);
  const catalog = discoverDocuments(project, {}, { depth: 1 });
  expect(catalog.documents).toHaveLength(0);
  expect(catalog.diagnostics).toMatchObject([{ code: "depth_limit" }]);
});

test("document count and byte budget accept the exact limit", () => {
  const project = findProject(tempDir({ ".archer/a.md": "abc" }));
  expect(discoverDocuments(project, {}, { documents: 1, bytes: 3 }).complete).toBe(true);
  expect(discoverDocuments(project, {}, { bytes: 2 }).complete).toBe(false);
  expect(() => discoverDocuments(project, {}, { depth: DISCOVERY_LIMITS.depth + 1 })).toThrow(/limit/);
});

test("arbitrary, vocabulary and edited-valid configuration is refused or valid on a small stack", () => {
  const module = fileURLToPath(new URL("../../src/project/discovery.ts", import.meta.url));
  const script = `import {parseDiscoverySettings} from ${JSON.stringify(module)};
    let seed=17; const next=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const chars=".archer/docsREADME.md/*?[]{}!\\\\:\\u0000\\n";
    for(let i=0;i<3000;i++){
      let value=""; for(let j=0,n=next()%180;j<n;j++) value+=chars[next()%chars.length];
      const raw=i%3===0?{roots:[value]}:i%3===1?{exclude:[value]}:{roots:["docs".slice(0,next()%5)+value]};
      try {const result=parseDiscoverySettings(raw); if(!Array.isArray(result.roots??result.exclude))throw new Error("invalid success");}
      catch(error){if(error?.name!=="ProjectError")throw error;}
    }
    console.log("3000 refused or valid");`;
  const result = spawnSync(
    process.execPath,
    ["--stack_size=256", "--import", "tsx", "--input-type=module", "-e", script],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("3000 refused or valid");
}, 15_000);

test("hidden opt-in and duplicate basename never impersonate legacy targets", () => {
  const project = findProject(
    tempDir({ ".archer/a/flow.mmd": "a", ".archer/b/flow.mmd": "b", ".archer/.hidden.md": "hidden" }),
  );
  const catalog = discoverDocuments(project, { roots: [".archer", ".archer/.hidden.md"] });
  expect(catalog.documents.find((entry) => entry.source.path === ".archer/a/flow.mmd")?.legacy).toEqual({
    viewId: "flow",
  });
  expect(catalog.documents.find((entry) => entry.source.path === ".archer/b/flow.mmd")?.legacy).toBeUndefined();
  expect(catalog.documents.find((entry) => entry.source.path === ".archer/.hidden.md")?.legacy).toBeUndefined();
});

test("sparse arrays cannot bypass strict path validation", () => {
  expect(() => parseDiscoverySettings({ roots: new Array(1) })).toThrow(/discovery/);
  expect(() => parseDiscoverySettings({ exclude: new Array(1) })).toThrow(/discovery/);
});
