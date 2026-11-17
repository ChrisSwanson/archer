/// <reference lib="dom" />
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  generatePlaygroundSnapshot,
  PLAYGROUND_PROJECTS,
  serializePlaygroundSnapshot,
} from "../../../site/scripts/playground-snapshot.mts";
import type { PlaygroundSnapshot } from "../../../shared/playground-snapshot.mts";

// The browser uses bundler module resolution; load its production parsers at runtime
// without applying the backend's NodeNext compiler settings to the UI source tree.
const inventoryModule = "../../../ui/src/app/inventory.ts";
const commentsModule = "../../../ui/src/comments/parse.ts";
const walkthroughsModule = "../../../ui/src/walkthroughs/parse.ts";
const validatorModule = "../../../ui/src/protocol/validate.ts";
const { parseInventory } = await import(new URL(inventoryModule, import.meta.url).href);
const { parseNoteContent, parseEmbeddedDiagram, parseThreadList } = await import(
  new URL(commentsModule, import.meta.url).href
);
const { parseWalkthroughs } = await import(new URL(walkthroughsModule, import.meta.url).href);
const { validateEnvelope } = await import(new URL(validatorModule, import.meta.url).href);

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
let snapshot: PlaygroundSnapshot;
const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(scratch.map((path) => rm(path, { recursive: true, force: true })));
});
beforeAll(async () => {
  snapshot = await generatePlaygroundSnapshot({ repoRoot, examplesRoot: join(repoRoot, "examples") });
}, 60_000);

it("generates the three allowlisted real projects through the production readers and compilers", () => {
  expect(snapshot.projects.map((project) => project.slug)).toEqual(PLAYGROUND_PROJECTS);
  for (const project of snapshot.projects) {
    const inventory = parseInventory(project.responses["api/diagrams"]);
    expect(inventory?.length, project.slug).toBeGreaterThan(0);
    for (const view of inventory!) {
      expect(validateEnvelope(project.responses[`api/diagrams/${encodeURIComponent(view.id)}`]).ok, view.id).toBe(true);
      const walks = parseWalkthroughs(
        project.responses[`api/walkthroughs?${new URLSearchParams({ viewId: view.id })}`],
      );
      expect(walks, view.id).toBeDefined();
      expect(
        parseThreadList(project.responses[`api/comments?${new URLSearchParams({ target: `view:${view.id}` })}`]),
      ).toBeDefined();
    }
    for (const [url, body] of Object.entries(project.responses)) {
      if (url.startsWith("api/notes/content?")) expect(parseNoteContent(body), url).toBeDefined();
      if (url.startsWith("api/notes/diagram?")) {
        expect(parseEmbeddedDiagram(body), url).toBeDefined();
        expect(validateEnvelope((body as { envelope: unknown }).envelope).ok, url).toBe(true);
      }
    }
  }
});

it("includes exact RFC and font notices, version provenance and source digests without private roots", () => {
  expect(snapshot.fontLicense).toContain("SIL OPEN FONT LICENSE");
  expect(snapshot.projects.find((p) => p.slug === "rfc-2324-htcpcp")?.notice).toContain("Copyright");
  expect(snapshot.projects.find((p) => p.slug === "rfc-1149-ipoac")?.notice).toContain("Copyright");
  expect(snapshot.manifest.appVersion).toMatch(/^\d+\.\d+\.\d+/);
  // No commit: the public site is exported from another repository, where the builder's commit names nothing.
  expect(snapshot.manifest).not.toHaveProperty("appCommit");
  expect(snapshot.manifest.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(Object.keys(snapshot.manifest.sourceDigests)).toContain("archer-tour/archer.toml");
  expect(JSON.stringify(snapshot)).not.toContain(repoRoot);
  for (const [path, digest] of Object.entries(snapshot.manifest.sourceDigests)) {
    expect(path).not.toMatch(/^\/|\.\./);
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  }
});

it("safely serializes script terminators, angle brackets and JS line separators with exact round trips", () => {
  const value = { text: "</script><script>alert('example')</script>\u2028\u2029<&" };
  const serialized = serializePlaygroundSnapshot(value);
  expect(serialized).not.toMatch(/[<\u2028\u2029]/);
  expect(JSON.parse(serialized)).toEqual(value);
});

async function copiedCorpus(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "archer-playground-snapshot-"));
  scratch.push(root);
  for (const slug of PLAYGROUND_PROJECTS)
    await cp(join(repoRoot, "examples", slug), join(root, slug), { recursive: true });
  return root;
}

it("excludes unapproved projects and unrelated files while retaining source-qualified embedded diagrams", async () => {
  const examplesRoot = await copiedCorpus();
  await mkdir(join(examplesRoot, "private-project"));
  await writeFile(join(examplesRoot, "private-project/archer.toml"), 'version = 1\nname = "Private"\n');
  await writeFile(join(examplesRoot, "archer-tour/private-token.txt"), "private-token-sentinel");
  await writeFile(
    join(examplesRoot, "archer-tour/.archer/notes/inline.md"),
    "# An Embedded Diagram\n\n```mermaid\n%% archer-id: local-flow\nflowchart LR\n  item[Item]\n```\n",
  );
  const built = await generatePlaygroundSnapshot({ repoRoot, examplesRoot });
  expect(built.projects.map((p) => p.slug)).toEqual(PLAYGROUND_PROJECTS);
  expect(JSON.stringify(built)).not.toContain("private-token-sentinel");
  const tour = built.projects[0]!;
  const address = "notes/inline.md#local-flow";
  const content = parseEmbeddedDiagram(tour.responses[`api/notes/diagram?${new URLSearchParams({ address })}`]);
  expect(content?.address).toBe(address);
  expect(content?.envelope?.view.id).toBe(address);
  expect(validateEnvelope(content?.envelope).ok).toBe(true);
});

it("changes the digest after a source edit and fails publication on malformed sidecars and missing anchors", async () => {
  const examplesRoot = await copiedCorpus();
  const before = await generatePlaygroundSnapshot({ repoRoot, examplesRoot });
  const readme = join(examplesRoot, "archer-tour/README.md");
  await writeFile(readme, `${await readFile(readme, "utf8")}\nAn additional public explanation.\n`);
  const after = await generatePlaygroundSnapshot({ repoRoot, examplesRoot });
  expect(after.manifest.digest).not.toBe(before.manifest.digest);
  const sidecar = join(examplesRoot, "archer-tour/.archer/diagrams/containers.walkthroughs.json");
  const original = await readFile(sidecar, "utf8");
  await writeFile(sidecar, "{invalid json");
  await expect(generatePlaygroundSnapshot({ repoRoot, examplesRoot })).rejects.toThrow(/walkthrough/i);
  await writeFile(sidecar, original.replace('"id": "coding_agent"', '"id": "missing_node"'));
  await expect(generatePlaygroundSnapshot({ repoRoot, examplesRoot })).rejects.toThrow(/walkthrough references/);
});

it("names each example's folder as an example's, never the builder's, and carries no builder Git facts", () => {
  const serialized = JSON.stringify(snapshot);
  expect(serialized).not.toContain(repoRoot.replace(/\/$/u, ""));
  for (const project of snapshot.projects)
    for (const catalog of ["api/projects", "api/browser-projects"]) {
      const entries = (project.responses[catalog] as { projects: { slug: string; facts?: Record<string, unknown> }[] })
        .projects;
      for (const entry of entries) {
        expect(entry.facts?.projectFolder, `${catalog} ${entry.slug}`).toBe(`~/code/${entry.slug}`);
        expect(entry.facts?.git, `${catalog} ${entry.slug}`).toBeUndefined();
      }
    }
});

it("carries no Git object id anywhere: not the builder's HEAD, nor a walkthrough's recorded commit", () => {
  expect(JSON.stringify(snapshot).match(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/giu) ?? []).toEqual([]);
});

it("catalogs each RFC example's NOTICE.md, which its README and casebook link to, with its content", () => {
  for (const slug of ["rfc-1149-ipoac", "rfc-2324-htcpcp"]) {
    const project = snapshot.projects.find((candidate) => candidate.slug === slug)!;
    const catalog = project.responses["api/documents"] as { documents: { source: { path: string }; kind: string }[] };
    expect(
      catalog.documents.find((document) => document.source.path === "NOTICE.md"),
      slug,
    ).toMatchObject({ kind: "markdown" });
    const content = project.responses["api/documents/content?path=NOTICE.md"] as { markdown: string };
    expect(content.markdown, slug).toBe(project.notice);
  }
});
