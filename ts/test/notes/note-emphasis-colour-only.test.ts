// ADR 0030 for note passages: at most three groups, coloured by position
// (teal, violet, coral), legend text bounded, no palette from the caller, and
// stored emphases from before the change migrated rather than refused.
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { passageAnchor } from "../../../shared/note-markdown.mts";
import { NOTE_EMPHASIS_TEXT_LIMITS, validateNoteEmphasisSnapshot } from "../../../shared/note-emphasis.mts";
import { TEXT_LIMITS } from "../../src/service/emphasis.ts";
import { renderedNoteText } from "../../src/comments/note-text.ts";
import { NoteEmphasisError, NoteEmphasisStore, readUpsertNoteEmphasis } from "../../src/notes/emphasis.ts";
import { TOOLS } from "../../src/application/tools.ts";
import { findProject } from "../../src/project/index.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

const SOURCE = "alpha beta gamma delta";
const passage = (quote: string) => {
  const text = renderedNoteText(SOURCE);
  const at = text.indexOf(quote);
  return passageAnchor(text, at, at + quote.length);
};
const group = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: `Group ${id}`,
  passages: [passage(id)],
  ...extra,
});
const request = (groups: unknown[], extra: Record<string, unknown> = {}) => ({
  notePath: "note.md",
  id: "set",
  groups,
  expectedRevision: 0,
  ...extra,
});

function refusal(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(NoteEmphasisError);
    expect(error).toMatchObject({ code: "invalid_note_emphasis" });
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

test("the legend bounds match diagram emphasis", () => {
  expect(NOTE_EMPHASIS_TEXT_LIMITS).toEqual(TEXT_LIMITS);
});

test("a palette, a fourth group and over-long legend text are refused together, each with its fix", () => {
  const message = refusal(() =>
    readUpsertNoteEmphasis(
      request(
        [
          group("alpha", { palette: "amber" }),
          group("beta", { label: "A label of far too many words" }),
          group("gamma", { description: "d".repeat(91) }),
          group("delta"),
        ],
        { title: "A title that has six words" },
      ),
    ),
  );
  expect(message).toContain("5 problems");
  expect(message).toContain("Colours follow group order (1 teal, 2 violet, 3 coral). Remove `palette`");
  expect(message).toContain("4 groups, more than the limit of 3");
  expect(message).toContain("groups[1].label has 7 words, more than the limit of 4");
  expect(message).toContain("groups[2].description has 91 characters, more than the limit of 90");
  expect(message).toContain("title has 6 words, more than the limit of 5");
  expect(refusal(() => readUpsertNoteEmphasis(request([group("alpha", { label: "x".repeat(33) })])))).toContain(
    "more than the limit of 32",
  );
});

test("groups are written with palettes derived from their order, never chosen", () => {
  const root = tempDir({ ".archer/note.md": SOURCE });
  const store = new NoteEmphasisStore(findProject(root));
  const written = store.upsert(request([group("alpha"), group("beta"), group("gamma")]), "agent");
  expect(written.snapshot.emphases[0]!.groups.map((entry) => entry.palette)).toEqual(["teal", "violet", "coral"]);
  const file = JSON.parse(readFileSync(`${root}/.archer/note.md.emphases.json`, "utf8"));
  expect(file.emphases[0].groups.map((entry: { palette: string }) => entry.palette)).toEqual([
    "teal",
    "violet",
    "coral",
  ]);
});

test("a stored file holding amber, four groups or text past the legend's bounds is malformed, not migrated", () => {
  const stored = (groups: Record<string, unknown>[]) => ({
    schemaVersion: 1,
    notePath: "note.md",
    revision: 4,
    emphases: [{ id: "set", author: "agent", groups }],
  });
  const fine = (id: string) => ({ id, label: `Group ${id}`, palette: "teal", passages: [passage(id)] });
  expect(validateNoteEmphasisSnapshot(stored([fine("alpha"), fine("beta")]))).toMatchObject({ ok: true });
  for (const groups of [
    [{ ...fine("alpha"), palette: "amber" }],
    ["alpha", "beta", "gamma", "delta"].map(fine),
    [{ ...fine("alpha"), label: "A label longer than thirty-two characters" }],
  ])
    expect(validateNoteEmphasisSnapshot(stored(groups))).toMatchObject({ ok: false });
});

test("set_note_emphasis advertises no palette, three groups and the legend bounds", () => {
  const tool = TOOLS.find((entry) => entry.name === "set_note_emphasis")!;
  const groups = (tool.inputSchema.properties as Record<string, any>)["groups"];
  expect(groups.maxItems).toBe(3);
  expect(Object.keys(groups.items.properties)).not.toContain("palette");
  expect(groups.items.required).toEqual(["id", "label", "passages"]);
  expect(groups.items.properties.label.maxLength).toBe(32);
  expect(groups.items.properties.description.maxLength).toBe(90);
  expect(tool.description).toContain("teal, violet, coral");
  expect(tool.description).not.toMatch(/amber/i);
});

test("a stored set with four groups refuses the file, and nothing overwrites it", () => {
  const legacyGroup = (id: string) => ({ id, label: id, palette: "teal", passages: [passage(id)] });
  const groups = ["alpha", "beta", "gamma", "delta"].map(legacyGroup);
  for (const broken of [
    { id: "", author: "agent", groups },
    { id: "x", author: "agent", title: 7, groups },
  ]) {
    expect(
      validateNoteEmphasisSnapshot({ schemaVersion: 1, notePath: "note.md", revision: 1, emphases: [broken] }),
    ).toMatchObject({ ok: false });
  }
  const root = tempDir({ ".archer/note.md": SOURCE });
  const file = JSON.stringify({
    schemaVersion: 1,
    notePath: "note.md",
    revision: 1,
    emphases: [{ id: "", author: "agent", groups }],
  });
  writeFileSync(`${root}/.archer/note.md.emphases.json`, file);
  const store = new NoteEmphasisStore(findProject(root));
  expect(() => store.upsert(request([group("alpha")], { expectedRevision: 1 }), "agent")).toThrow(
    expect.objectContaining({ code: "malformed_note_emphasis_file" }),
  );
  expect(readFileSync(`${root}/.archer/note.md.emphases.json`, "utf8")).toBe(file);
});
