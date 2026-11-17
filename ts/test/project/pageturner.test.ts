// Pageturner is a test corpus covering every diagram family. Every view must
// load and compile without diagnostics, every note must name existing diagrams,
// and a diagram's own title must agree with its registered view.
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { compileDiagram, findProject, listDiagrams, listNotes } from "../../src/project/index.ts";

const PAGETURNER = resolve(import.meta.dirname, "../fixtures/pageturner");
const project = findProject(PAGETURNER);
const diagrams = listDiagrams(project);
const notes = listNotes(project);

test("the corpus is its own project, with every view loading", () => {
  expect(project.root).toBe(PAGETURNER);
  expect(project.problems).toEqual([]);
  expect(project.views.length).toBeGreaterThanOrEqual(7);
});

test("every diagram file is a view in archer.toml, and every view has its file", () => {
  expect(diagrams.filter((diagram) => diagram.view === undefined).map((diagram) => diagram.path)).toEqual([]);
  expect(project.views.map((view) => view.source).sort()).toEqual(diagrams.map((diagram) => diagram.path));
});

test("the views cover all seven diagram types", async () => {
  const types = new Set<string>();
  for (const diagram of diagrams) {
    const { envelope } = await compileDiagram(project, diagram);
    if (envelope !== null) types.add(envelope.model.type === "architecture-graph" ? "flowchart" : envelope.model.type);
  }
  expect([...types].sort()).toEqual(
    [
      "c4-model",
      "entity-relationship",
      "flowchart",
      "sequence-trace",
      "service-architecture",
      "state-machine",
      "user-journey",
    ].sort(),
  );
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

test("there are three or four notes", () => {
  expect(notes.length).toBeGreaterThanOrEqual(3);
  expect(notes.length).toBeLessThanOrEqual(4);
});

describe.each(notes.map((note) => [note.path, note] as const))("%s", (_path, note) => {
  test("has a type and names the diagrams it is about, all of which exist", () => {
    expect(note.problems).toEqual([]);
    expect(note.type).toBeDefined();
    expect(note.diagrams.length).toBeGreaterThan(0);
    for (const path of note.diagrams) expect(diagrams.map((diagram) => diagram.path)).toContain(path);
  });
});
