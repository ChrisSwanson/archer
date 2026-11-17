// Where an agent puts a new diagram or note in the Archer folder. Every place
// an agent is told how to start one says the same thing: a new diagram in
// `diagrams/`, a new note in `notes/`, and existing files left where they are
// (their comments file, archer.toml entry and links follow the path). Without
// it agents put diagrams anywhere in the folder and projects drift apart.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { TOOLS } from "../../src/application/tools.ts";
import { pointerSection } from "../../src/project/init.ts";
import { connect, removeTempDirs, tempDir } from "./support.ts";

afterEach(removeTempDirs);

const SKILL = resolve(import.meta.dirname, "../../plugin/skills/archer/SKILL.md");

async function instructions(): Promise<string> {
  const { client, close } = await connect({ cwd: tempDir({}) });
  const text = client.getInstructions() ?? "";
  await close();
  return text;
}

const PLACES: readonly (readonly [string, () => Promise<string> | string])[] = [
  ["the MCP server's instructions", instructions],
  ["the archer skill", () => readFileSync(SKILL, "utf8")],
  ["register_diagram's description", () => TOOLS.find((tool) => tool.name === "register_diagram")!.description],
  ["the pointer archer init adds to AGENTS.md", () => pointerSection(".archer")],
];

describe.each(PLACES)("%s", (_place, read) => {
  test("puts a new diagram in diagrams/ and a new note in notes/", async () => {
    const text = await read();
    expect(text).toMatch(/new diagram[^.]*\bdiagrams\//i);
    expect(text).toMatch(/notes?[^.]*\bnotes\//i);
  });
});

test("the skill and the instructions say to leave existing files where they are", async () => {
  for (const text of [await instructions(), readFileSync(SKILL, "utf8")])
    expect(text).toMatch(/do not move|leave existing/i);
});

// docs/proposals/notes-with-embedded-diagrams.md: a new diagram is embedded in
// the note it belongs to by default, a standalone file only when it deserves
// one, and an embedded diagram is read and written by its note address.
const EMBEDDING: readonly (readonly [string, () => Promise<string> | string])[] = [
  ["the MCP server's instructions", instructions],
  ["the archer skill", () => readFileSync(SKILL, "utf8")],
  ["the pointer archer init adds to AGENTS.md", () => pointerSection(".archer")],
];

describe.each(EMBEDDING)("%s", (_place, read) => {
  test("embeds a new diagram in its note by default, and keeps a file for one that deserves it", async () => {
    const text = await read();
    expect(text).toMatch(/embed/i);
    expect(text).toMatch(/```mermaid/);
    expect(text).toMatch(/#<name>/);
    expect(text).toMatch(/own file/i);
  });
});

test.each(["read_diagram", "write_diagram", "validate_diagram"])(
  "%s's description says it takes an embedded diagram's address",
  (name) => {
    expect(TOOLS.find((tool) => tool.name === name)!.description).toMatch(/<note path>#<name>/);
  },
);

// A block nested in a list or blockquote is the person's structure: the agent
// moves it out only in its own note (author: agent) or when the person asks.
describe.each([
  ["the MCP server's instructions", instructions],
  ["the archer skill", () => readFileSync(SKILL, "utf8")],
] as const)("%s", (_place, read) => {
  test("keeps nested blocks where the person put them unless the note is the agent's or the person asks", async () => {
    const text = await read();
    expect(text).toMatch(/author: agent/);
    expect(text).toMatch(/relocate/);
    expect(text).toMatch(/personRequested/);
  });
});

// The projects-and-search design: the page lists and
// searches by description, so the agent writes one for what it creates, and
// offers -- never adds unasked -- one for existing files that lack it.
describe.each([
  ["the MCP server's instructions", instructions],
  ["the archer skill", () => readFileSync(SKILL, "utf8")],
] as const)("%s", (_place, read) => {
  test("describes new notes and diagrams, and offers descriptions for existing files", async () => {
    const text = await read();
    expect(text).toMatch(/description: /);
    expect(text).toMatch(/%% description:/);
    expect(text).toMatch(/offer/i);
    expect(text).toMatch(/unasked/i);
  });
});

// Haiku changed existing diagrams with its file tools, then validated them, in most edit runs of
// the evals (docs/evaluations/eval-baseline.md): validate_diagram called itself "the check for a
// diagram you just wrote with file tools". An existing diagram is changed with write_diagram.
test("an existing diagram is changed with write_diagram, not file edits; file tools are for new ones", async () => {
  for (const text of [await instructions(), readFileSync(SKILL, "utf8")])
    expect(text).toMatch(/existing diagram[^.]*write_diagram[^.]*not (with )?(your )?file (edits|tools)/i);
  expect(TOOLS.find((tool) => tool.name === "validate_diagram")!.description).toMatch(
    /new diagram you just wrote with file tools/,
  );
});

// Haiku (without the skill) and luna added a missing edge before emphasising containers.
test("the skill and the instructions say to offer, not make, a change emphasis lacks", async () => {
  for (const text of [await instructions(), readFileSync(SKILL, "utf8")])
    expect(text).toMatch(/lacks[^.]*say so and offer the change/i);
});

// PRODUCT.md principle 2: "how does X work" is answered from the documented diagram with emphasis,
// more detail goes in a derived copy in scratch, and only an uncovered question gets a new diagram.
describe.each([
  ["the MCP server's instructions", instructions],
  ["the archer skill", () => readFileSync(SKILL, "utf8")],
] as const)("%s", (_place, read) => {
  test("answers how something works from the existing diagram, and elaborates in a derived copy", async () => {
    const text = await read();
    // Presenting and pointing in one call: Haiku presented without emphasis in 5 of 6 runs when they were two.
    expect(text).toMatch(/how [^.]*works?[^.]*present_diagram[^.]*emphasis[^.]*one call/i);
    expect(text).toMatch(/set_emphasis[^.]*later/i);
    expect(text).toMatch(/based-on: <view id>@<sourceRevision>/);
    expect(text).toMatch(/notes\/scratch\//);
  });
});

test("the skill loads for a question about how a feature works", () => {
  const description = /^description: (.*)$/m.exec(readFileSync(SKILL, "utf8"))?.[1] ?? "";
  expect(description).toMatch(/how [^.]*works/i);
});

// The pilot rules (2026-10-22): show a change before coding it, mark guesses "(assumed)",
// and after a code change offer, never make unasked, the updates to the diagrams it made stale.
describe.each([
  ["the MCP server's instructions", instructions],
  ["the archer skill", () => readFileSync(SKILL, "utf8")],
] as const)("%s", (_place, read) => {
  test("shows a change before coding it and offers doc updates after", async () => {
    const text = await read();
    expect(text).toMatch(/before[^.]*code change[^.]*show it first|show it first/i);
    expect(text).toMatch(/go-ahead/);
    expect(text).toMatch(/\(assumed\)/);
    expect(text).toMatch(/list_stale_diagrams[^.]*offer[^.]*never[^.]*unasked/);
  });
});

test("the AGENTS.md pointer offers updates to stale docs rather than making them", () => {
  expect(pointerSection(".archer")).toMatch(/offer to update/);
});
