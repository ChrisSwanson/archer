// What is in the Archer folder: diagrams (.mmd), with the view each one is,
// and notes (.md), with their front matter and the diagrams they are about
// (ticket 09).
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { findProject, listDiagrams, listNotes, readFrontMatter } from "../../src/project/index.ts";
import { FLOW, removeTempDirs, SEQ, tempDir } from "./support.ts";

afterEach(removeTempDirs);

test("diagrams are every .mmd in the folder, sorted, with their view when archer.toml names one", () => {
  const outside = tempDir({ "x.mmd": FLOW });
  const dir = tempDir({
    "archer.toml":
      'version = 1\n[[views]]\nid = "auth"\nkind = "sequence"\ntitle = "Auth"\nsource = ".archer/flows/auth.mmd"\n',
    ".archer/flows/auth.mmd": SEQ,
    ".archer/system.mmd": FLOW,
    ".archer/.hidden/skip.mmd": FLOW,
    ".archer/readme.md": "",
    "outside.mmd": FLOW,
  });
  symlinkSync(join(outside, "x.mmd"), join(dir, ".archer", "escape.mmd"));
  symlinkSync(outside, join(dir, ".archer", "linked-dir"));
  expect(listDiagrams(findProject(dir))).toEqual([
    { path: "flows/auth.mmd", view: { id: "auth", kind: "sequence", title: "Auth", source: "flows/auth.mmd" } },
    { path: "system.mmd" },
  ]);
});

test("a project with no Archer folder yet has nothing in it", () => {
  const project = findProject(tempDir());
  expect(listDiagrams(project)).toEqual([]);
  expect(listNotes(project)).toEqual([]);
});

test("front matter: type, status and diagrams, as scalars, inline or block lists", () => {
  expect(
    readFrontMatter('---\ntype: user story\nstatus: "draft"\ndiagrams: [a.mmd, "b c.mmd"]\nother: x\n---\nbody'),
  ).toEqual({
    fields: { type: "user story", status: "draft", diagrams: ["a.mmd", "b c.mmd"] },
    problems: [],
  });
  expect(readFrontMatter("---\r\ndiagrams:\r\n  - a.mmd\r\n  - 'b.mmd'\r\n---\r\n").fields).toEqual({
    diagrams: ["a.mmd", "b.mmd"],
  });
  expect(readFrontMatter("---\ndiagrams: one.mmd\n---\n").fields).toEqual({ diagrams: ["one.mmd"] });
  expect(readFrontMatter("# no front matter\n")).toEqual({ fields: {}, problems: [] });
});

test("front matter keeps based-on, the copy's origin (ADR 0036 A1)", () => {
  expect(readFrontMatter("---\nauthor: agent\nbased-on: checkout@sha256:ab12\n---\nbody").fields).toEqual({
    author: "agent",
    basedOn: "checkout@sha256:ab12",
  });
  expect(readFrontMatter("---\nbased-on: [a, b]\n---\n").problems[0]).toMatch(/based-on/);
});

test("front matter that cannot be read is reported, not guessed at", () => {
  expect(readFrontMatter("---\ntype: decision\n").problems[0]).toMatch(/closing ---/);
  expect(readFrontMatter("---\n  - stray\n---\n").problems[0]).toMatch(/line 2/);
  expect(readFrontMatter("---\nstatus: [a, b]\n---\n").problems[0]).toMatch(/status/);
});

test("a note's diagrams: its front matter, else its own folder's, plus the .mmd files it links to", () => {
  const dir = tempDir({
    ".archer/auth/login.mmd": FLOW,
    ".archer/auth/logout.mmd": FLOW,
    ".archer/auth/deep/token.mmd": FLOW,
    ".archer/system.mmd": FLOW,
    ".archer/auth/story.md": "---\ntype: user story\nstatus: draft\n---\nSee [the system](../system.mmd).\n",
    ".archer/auth/decision.md":
      "---\ntype: decision\ndiagrams: [login.mmd, ../system.mmd]\n---\n[ref]: deep/token.mmd#x\n[web](https://example.com/a.mmd)\n",
    ".archer/auth/broken.md": "---\ndiagrams: [../../escape.mmd, gone.mmd]\n---\n[up](../../../etc.mmd)\n",
    ".archer/top.md": "Nothing linked.\n",
  });
  const notes = listNotes(findProject(dir));
  expect(notes).toEqual([
    {
      path: "auth/broken.md",
      diagrams: [],
      problems: [
        "diagram ../../escape.mmd is outside the Archer folder",
        "diagram gone.mmd does not exist",
        "link ../../../etc.mmd is outside the Archer folder",
      ],
    },
    {
      path: "auth/decision.md",
      type: "decision",
      diagrams: ["auth/deep/token.mmd", "auth/login.mmd", "system.mmd"],
      problems: [],
    },
    {
      path: "auth/story.md",
      type: "user story",
      status: "draft",
      diagrams: ["auth/login.mmd", "auth/logout.mmd", "system.mmd"],
      problems: [],
    },
    { path: "top.md", diagrams: ["system.mmd"], problems: [] },
  ]);
});

// Note bodies and front matter are untrusted text: reading them takes time in
// proportion to their length, whatever they hold.
test.each([
  ["link openers", "](".repeat(100_000)],
  ["an unclosed link of spaces", "](" + " ".repeat(200_000)],
  ["reference definitions", "[a]:" + " ".repeat(200_000)],
  ["a link with an unclosed title", '](x.mmd "' + " ".repeat(200_000)],
])("a note of adversarial %s is read in well under a second", (_, body) => {
  const dir = tempDir({
    ".archer/n.md": body,
    ".archer/f.md": `---\ntype: a${" ".repeat(200_000)}b\ndiagrams: [${" ".repeat(200_000)}]\n---\n`,
  });
  const started = performance.now();
  listNotes(findProject(dir));
  expect(performance.now() - started).toBeLessThan(500);
});

// Agents and people name diagrams the way Archer shows them: by name, without
// `.mmd`, and from anywhere in the folder. A note in a subfolder that says
// `diagrams: [pipeline]` is about `pipeline.mmd` wherever its unique match is.
test("a note's diagrams may be named without .mmd, from a subfolder", () => {
  const dir = tempDir({
    "archer.toml": "version = 1\n",
    ".archer/pipeline.mmd": FLOW,
    ".archer/notes/about.md": "---\ndiagrams: [pipeline]\n---\n# About\n",
  });
  const notes = listNotes(findProject(dir));
  expect(notes[0]?.diagrams).toEqual(["pipeline.mmd"]);
  expect(notes[0]?.problems).toEqual([]);
});
