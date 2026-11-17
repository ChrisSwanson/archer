import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { diagramDescription } from "../../src/project/describe.ts";
import { compileEmbedded, readEmbeddedIn } from "../../src/notes/embedded.ts";
import { compileDiagram, findProject, listDiagrams } from "../../src/project/index.ts";
import { addressable, parseEmphasis } from "../../src/service/emphasis.ts";
import { resolveWalkthrough } from "../../src/walkthroughs/resolve.ts";
import { validateWalkthroughsFile } from "../../src/walkthroughs/store.ts";

const ROOT = resolve(import.meta.dirname, "../../../examples/rfc-2324-htcpcp");
const FOLDER = join(ROOT, ".archer");
const project = findProject(ROOT);
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const guide = () => read(".archer/notes/reading-guide.md");

test("RFC 2324's source and official note remain byte-for-byte unchanged", () => {
  for (const [path, hash] of [
    ["sources/rfc2324.txt", "b11329c3fd6dbe9dddcb8dd90f18a4bf441858a6b5bfaccae5f91e5c7d2b3596"],
    [".archer/notes/rfc2324.md", "0dedf221f8bf0c03f3834b6bd66e65a8276455e9372e50974e76057885f5f999"],
  ] as const)
    expect(
      createHash("sha256")
        .update(readFileSync(join(ROOT, path)))
        .digest("hex"),
    ).toBe(hash);
});

test("the coffee casebook leads with two questions, evidence, gaps and real challenges", () => {
  const text = guide();
  for (const phrase of [
    "## What does this request name?",
    "## Which additions can the pot refuse?",
    "Agent interpretation:",
    "Gap:",
    "Challenge your agent",
    "Try the interaction",
    "§3",
    "§2.2.2.1",
    "§2.3.1",
  ])
    expect(text).toContain(phrase);
  const source = read(".archer/notes/rfc2324.md");
  const excerpts = [...text.matchAll(/```text\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  expect(excerpts.length).toBeGreaterThanOrEqual(4);
  for (const excerpt of excerpts) expect(source).toContain(excerpt);
});

test("every derivative note and front door carries the full applicable notice", () => {
  const source = read(".archer/notes/rfc2324.md");
  const notice = source.split("## 11.  Full Copyright Statement\n\n")[1]!.trim();
  // Exact notice from the preserved guide, including permissions and warranty, not just a link.
  expect(notice).toContain("MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.");
  for (const file of [
    "README.md",
    "NOTICE.md",
    ...readdirSync(join(FOLDER, "notes"))
      .filter((f) => f.endsWith(".md") && f !== "rfc2324.md")
      .map((f) => `.archer/notes/${f}`),
  ])
    expect(read(file), file).toContain(notice);
});

test("named casebook figures compile through the production note compiler", async () => {
  const fences = readEmbeddedIn(project, "notes/reading-guide.md");
  expect(fences.map((f) => f.name)).toEqual(["coffee-uri-slots", "coffee-command-body"]);
  for (const fence of fences) {
    const compiled = await compileEmbedded(fence);
    expect(compiled.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    expect(compiled.envelope).not.toBeNull();
  }
});

test("the saved graph walkthrough resolves every step against today's brew decisions", async () => {
  const parsed = validateWalkthroughsFile(JSON.parse(read(".archer/diagrams/brew-decisions.walkthroughs.json")));
  if (!parsed.ok) throw new Error(parsed.problem);
  expect(parsed.file.target).toBe("view:brew-decisions");
  expect(parsed.file.walkthroughs).toHaveLength(1);
  const diagram = listDiagrams(project).find((d) => d.view?.id === "brew-decisions");
  expect(diagram).toBeDefined();
  const { envelope } = await compileDiagram(project, diagram!);
  expect(envelope).not.toBeNull();
  for (const route of parsed.file.walkthroughs) {
    expect(route.steps.length).toBeGreaterThanOrEqual(3);
    expect(resolveWalkthrough(route, envelope!.model)).toMatchObject({ status: "current", changed: [] });
  }
});

test("recipes parse against production models and still point at the intended 406 message", async () => {
  const recipes = ["optional-refusal.json", "refusal-exchange.json"];
  for (const file of recipes) {
    const recipe = JSON.parse(read(`demo/emphasis/${file}`));
    expect(guide()).toContain(`archer emphasis set --file demo/emphasis/${file}`);
    const diagram = listDiagrams(project).find((d) => d.view?.id === recipe.viewId);
    expect(diagram).toBeDefined();
    const { envelope } = await compileDiagram(project, diagram!);
    expect(envelope).not.toBeNull();
    const known = addressable(envelope!.model);
    const parsed = parseEmphasis(recipe, recipe.viewId, known);
    expect(parsed).toMatchObject({ ok: true });
    if (file === "refusal-exchange.json") {
      expect(recipe.groups.flatMap((g: { edges: string[] }) => g.edges)).toEqual(["msg-2", "msg-3"]);
      expect(known.anchors.get("msg-2")).toBe(
        '["message","client","coffee_pot","sync","BREW with Accept-Additions"]#0',
      );
      expect(known.anchors.get("msg-3")).toBe('["message","coffee_pot","client","reply","406 Not Acceptable"]#0');
    }
  }
});

test("casebook links and the front door resolve to real project files", () => {
  for (const file of ["README.md", ".archer/notes/reading-guide.md"]) {
    const text = read(file);
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const link = match[1]!;
      if (/^[a-z]+:/.test(link)) continue;
      expect(existsSync(resolve(ROOT, dirname(file), link.split("#")[0]!)), link).toBe(true);
    }
  }
  expect(read("README.md")).toContain("walkthrough");
  expect(read("README.md")).toContain("comment");
});

test("the saved refusal explanation scopes the additions list to a 406 response", () => {
  const route = JSON.parse(read(".archer/diagrams/brew-decisions.walkthroughs.json")).walkthroughs[0];
  expect(route.steps.find((step: { id: string }) => step.id === "may-refuse").what).toContain(
    "For a 406 response to a non-HEAD request, the response SHOULD list available additions.",
  );
});

test("the URI drawing branches to independent optional slots, without a prerequisite chain", async () => {
  const fence = readEmbeddedIn(project, "notes/reading-guide.md").find((f) => f.name === "coffee-uri-slots")!;
  const { envelope } = await compileEmbedded(fence);
  if (envelope?.model.type !== "freeform-graph") throw new Error("expected URI graph");
  const slots = ["coffee_host", "coffee_pot", "coffee_additions"];
  expect(envelope.model.edges.filter((edge) => slots.includes(edge.source))).toEqual([]);
  for (const slot of slots) {
    expect(envelope.model.edges.filter((edge) => edge.target === slot)).toEqual([
      expect.objectContaining({ source: "coffee_scheme", target: slot, label: "optional", line: "dotted" }),
    ]);
  }
  expect(envelope.model.lineKey).toContainEqual({ pattern: "dotted", meaning: "Independent optional slot" });
});

test("the unavailable-additions outcome permits 406 and explicitly leaves other behaviour unspecified", async () => {
  const diagram = listDiagrams(project).find((d) => d.view?.id === "brew-decisions")!;
  const { envelope } = await compileDiagram(project, diagram);
  if (envelope?.model.type !== "freeform-graph") throw new Error("expected brew graph");
  expect(envelope.model.edges.find((edge) => edge.id === "additions_refusal")).toMatchObject({
    source: "unavailable",
    target: "error406",
    label: "MAY return",
    line: "dashed",
  });
  const unspecified = envelope.model.nodes.find((node) => node.id === "unspecified");
  expect(unspecified?.label).toBe("Other Behaviour Unspecified");
  expect(envelope.model.edges.find((edge) => edge.target === "unspecified")).toMatchObject({
    source: "unavailable",
    label: "Otherwise unspecified",
    line: "dotted",
  });
  expect(
    envelope.model.edges
      .filter((edge) => edge.source === "unavailable")
      .map((edge) => edge.target)
      .sort(),
  ).toEqual(["error406", "unspecified"]);
  expect(envelope.model.lineKey).toContainEqual({ pattern: "dashed", meaning: "Permitted response" });
});

test("reader instructions explain the action without test-harness commentary", () => {
  expect(guide()).not.toMatch(/example tests|endpoints and wording|as well as their IDs/);
  expect(guide()).toContain("archer emphasis set --file demo/emphasis/refusal-exchange.json");
});

test("each canonical figure declares a purpose beyond its title", () => {
  for (const entry of listDiagrams(project)) {
    const description = diagramDescription(read(`.archer/${entry.path}`));
    expect(description?.descriptionFrom, entry.path).toBe("comment");
    expect(description?.description, entry.path).not.toBe(entry.view?.title);
    expect(description?.description.split(" ").length, entry.path).toBeGreaterThan(8);
  }
});
