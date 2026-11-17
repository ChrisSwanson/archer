// The Archer Tour in examples/archer-tour explains Archer in Archer's own format. It ships in the
// package and is rendered on the docs site, so it must be clean: every view loads and compiles with
// no error or warning, every diagram is a view, every note names diagrams that exist and links only
// to files that exist, and every walkthrough parses and still matches its diagram.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { compileDiagram, findProject, listDiagrams, listNotes } from "../../src/project/index.ts";
import { addressable, parseEmphasis } from "../../src/service/emphasis.ts";
import { resolveWalkthrough } from "../../src/walkthroughs/resolve.ts";
import { validateWalkthroughsFile } from "../../src/walkthroughs/store.ts";

const TOUR = resolve(import.meta.dirname, "../../../examples/archer-tour");
const FOLDER = join(TOUR, ".archer");
const project = findProject(TOUR);
const diagrams = listDiagrams(project);
const notes = listNotes(project);

test("the first-open README offers a question, a saved route and a concrete review action", () => {
  const path = join(TOUR, "README.md");
  expect(existsSync(path), "the tour needs a front door outside Archer").toBe(true);
  const readme = readFileSync(path, "utf8");
  expect(readme).toContain("How does a question become a shared picture?");
  expect(readme).toContain("One Turn of the Heartbeat");
  expect(readme).toContain("Select");
  expect(readme).toContain("comment");
  for (const match of readme.matchAll(/\]\(([^)\s]+)\)/g)) {
    const link = match[1] as string;
    if (!/^[a-z]+:/.test(link)) expect(existsSync(resolve(TOUR, link.split("#")[0] as string)), link).toBe(true);
  }
});

test("the live feedback recipe parses and still points at the same exchanges", async () => {
  const path = join(TOUR, "demo/emphasis/feedback-loop.json");
  expect(existsSync(path), "ship the runnable live emphasis recipe").toBe(true);
  const recipe: unknown = JSON.parse(readFileSync(path, "utf8"));
  const diagram = diagrams.find((candidate) => candidate.view?.id === "feedback-loop");
  expect(diagram).toBeDefined();
  const compiled = await compileDiagram(project, diagram as (typeof diagrams)[number]);
  expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity !== "info")).toEqual([]);
  expect(compiled.envelope).not.toBeNull();
  if (compiled.envelope === null) throw new Error("feedback-loop did not compile");
  const known = addressable(compiled.envelope.model);
  const parsed = parseEmphasis(recipe, "feedback-loop", known);
  expect(parsed.ok ? [] : parsed.issues).toEqual([]);
  if (!parsed.ok) throw new Error("feedback-loop recipe was refused");
  expect(parsed.emphasis.id).toBe("feedback-round");
  expect(parsed.emphasis.groups.map((group) => [group.id, group.edges])).toEqual([
    ["send-feedback", ["msg-8", "msg-9", "msg-10", "msg-11", "msg-12"]],
    ["revise-and-answer", ["msg-13", "msg-14", "msg-15", "msg-16"]],
  ]);
  const exchanges = [
    ["msg-8", "developer", "web_page", "Send to agent"],
    ["msg-9", "web_page", "archer", "Sent comments"],
    ["msg-10", "archer", "coding_agent", "archer wait ends with them"],
    ["msg-11", "coding_agent", "archer", "get_comments"],
    ["msg-12", "archer", "coding_agent", "Threads with their anchors"],
    ["msg-13", "coding_agent", "archer", "write_diagram with expectedRevision"],
    ["msg-14", "archer", "web_page", "Redraw and name the change"],
    ["msg-15", "coding_agent", "archer", "reply_comment, resolve_comment"],
    ["msg-16", "archer", "web_page", "The agent's answer"],
  ];
  for (const [id, from, to, label] of exchanges) {
    const anchor = known.anchors.get(id as string);
    expect(anchor, `${id} must keep its sender, receiver and text`).toBeDefined();
    const identity = JSON.parse((anchor as string).replace(/#\d+$/, "")) as unknown[];
    expect([identity[0], identity[1], identity[2], identity[4]]).toEqual(["message", from, to, label]);
  }
  for (const document of ["README.md", ".archer/notes/what-is-archer.md"]) {
    const copy = readFileSync(join(TOUR, document), "utf8");
    expect(copy).toContain("Try the interaction");
    expect(copy).toContain("archer emphasis set --file demo/emphasis/feedback-loop.json");
    expect(copy).toContain("archer emphasis clear feedback-loop feedback-round");
    expect(copy).toContain("ask your agent to");
  }
});

test("the tour is its own project, with every view loading", () => {
  expect(project.root).toBe(TOUR);
  expect(project.problems).toEqual([]);
  expect(project.views.length).toBeGreaterThanOrEqual(5);
  expect(project.views.length).toBeLessThanOrEqual(8);
});

test("every diagram file is a view in archer.toml, and every view has its file", () => {
  expect(diagrams.filter((diagram) => diagram.view === undefined).map((diagram) => diagram.path)).toEqual([]);
  expect(project.views.map((view) => view.source).sort()).toEqual(diagrams.map((diagram) => diagram.path).sort());
});

test("the views use at least five diagram families", async () => {
  const types = new Set<string>();
  for (const diagram of diagrams) {
    const { envelope } = await compileDiagram(project, diagram);
    if (envelope !== null) types.add(envelope.model.type);
  }
  expect(types.size).toBeGreaterThanOrEqual(5);
});

describe.each(diagrams.map((diagram) => [diagram.path, diagram] as const))("%s", (_path, diagram) => {
  test("compiles with no error and no warning", async () => {
    const compiled = await compileDiagram(project, diagram);
    expect(compiled.diagnostics.filter((d) => d.severity !== "info")).toEqual([]);
    expect(compiled.envelope).not.toBeNull();
  });

  test("has the title its view gives it, when it has one", async () => {
    const { envelope } = await compileDiagram(project, diagram);
    const model = envelope?.model as { title?: string } | undefined;
    if (model?.title !== undefined) expect(model.title).toBe(diagram.view?.title);
  });
});

test("there are the two notes: the front door and the user stories", () => {
  expect(notes.map((note) => note.path).sort()).toEqual(["notes/user-stories.md", "notes/what-is-archer.md"]);
});

describe.each(notes.map((note) => [note.path, note] as const))("%s", (path, note) => {
  test("has a type and names the diagrams it is about, all of which exist", () => {
    expect(note.problems).toEqual([]);
    expect(note.type).toBeDefined();
    expect(note.diagrams.length).toBeGreaterThan(0);
    for (const diagram of note.diagrams) expect(diagrams.map((d) => d.path)).toContain(diagram);
  });

  test("links only to files inside the tour that exist", () => {
    const file = join(FOLDER, path);
    const links = [...readFileSync(file, "utf8").matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] as string);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links.filter((target) => !/^[a-z]+:/.test(target))) {
      const target = resolve(dirname(file), link.split("#")[0] as string);
      expect(target.startsWith(`${TOUR}/`), `${link} leaves the tour`).toBe(true);
      expect(existsSync(target), `${link} does not exist`).toBe(true);
    }
  });
});

const walkthroughFiles = readdirSync(join(FOLDER, "diagrams")).filter((name) => name.endsWith(".walkthroughs.json"));

test("the tour has walkthroughs to replay", () => {
  expect(walkthroughFiles.length).toBeGreaterThanOrEqual(1);
});

describe.each(walkthroughFiles)("%s", (name) => {
  test("parses, targets a view, and every step still matches its diagram", async () => {
    const parsed = validateWalkthroughsFile(JSON.parse(readFileSync(join(FOLDER, "diagrams", name), "utf8")));
    if (!parsed.ok) throw new Error(parsed.problem);
    const viewId = parsed.file.target.slice("view:".length);
    const diagram = diagrams.find((d) => d.view?.id === viewId);
    expect(diagram, `no view ${viewId}`).toBeDefined();
    const { envelope } = await compileDiagram(project, diagram as (typeof diagrams)[number]);
    expect(envelope).not.toBeNull();
    expect(parsed.file.walkthroughs.length).toBeGreaterThan(0);
    for (const walkthrough of parsed.file.walkthroughs) {
      const resolution = resolveWalkthrough(walkthrough, envelope?.model as Parameters<typeof resolveWalkthrough>[1]);
      expect({ id: walkthrough.id, status: resolution.status, changed: resolution.changed }).toEqual({
        id: walkthrough.id,
        status: "current",
        changed: [],
      });
    }
  });
});
