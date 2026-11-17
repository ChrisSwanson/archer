// compile() stays a trust boundary for the state, ER, C4, architecture and
// journey profiles: text built from each profile's own vocabulary, and each
// type's golden fixtures with that vocabulary spliced in, are refused (no
// model, a located error) or give a model that is sound and conforms to the
// envelope schema. Seeded, so a failure reproduces. (never-throws.test.ts
// covers arbitrary text and the flowchart and sequence vocabularies; its
// fixture edits run over these types' fixtures too.)

import { describe, expect, test } from "vitest";
import { compile, type CompileResult } from "../../src/mermaid/index.ts";
import { validateModel } from "../../src/mermaid/validate.ts";
import { loadFixtures } from "./support/fixtures.ts";
import { checkAgainst } from "./support/schema.ts";

// Seeded property runs: a few seconds alone, more on a loaded machine or
// beside tests that start a service. Generous, so load does not fail them.
const TIMEOUT = 60_000;

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMMON = [
  "\n",
  "\n",
  "  ",
  " ",
  ":",
  ";",
  "#",
  "#quot;",
  "%%",
  '"',
  "<b>",
  "\u001b",
  "‮",
  "é",
  "日",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  ",",
];

const TYPES: { family: string; header: string; words: string[] }[] = [
  {
    family: "state",
    header: "stateDiagram-v2\n",
    words: [
      "state",
      "A",
      "B",
      "C",
      "[*]",
      "-->",
      "as",
      '"L"',
      "<<choice>>",
      "<<fork>>",
      "note",
      "left of",
      "right of",
      "end note",
      "--",
      "direction LR",
      "classDef",
      ":::",
      "root_start",
    ],
  },
  {
    family: "er",
    header: "erDiagram\n",
    words: [
      "A",
      "B",
      "LINE-ITEM",
      "||--o{",
      "}|..|{",
      "|o--||",
      "o{",
      "|{",
      "--",
      "..",
      "string",
      "int",
      "PK",
      "FK",
      "UK",
      '"label"',
      "one",
      "to",
      "direction TB",
    ],
  },
  {
    family: "c4",
    header: "C4Container\n",
    words: [
      "Person",
      "System_Ext",
      "ContainerDb",
      "Component",
      "System_Boundary",
      "Boundary",
      "Rel",
      "BiRel",
      "Rel_D",
      "Rel_Back",
      "a",
      "b",
      '"L"',
      "$tags=",
      "title",
      "UpdateLayoutConfig",
    ],
  },
  {
    family: "architecture",
    header: "architecture-beta\n",
    words: [
      "group",
      "service",
      "junction",
      "a",
      "b",
      "g",
      "(server)",
      "(cloud)",
      "(logos:x)",
      "[Label]",
      "in",
      ":L",
      ":R",
      "T:",
      "B:",
      "--",
      "-->",
      "<-->",
      "-[x]-",
      "{group}",
      "title",
    ],
  },
  {
    family: "journey",
    header: "journey\n",
    words: ["title", "section", "Task", "Make tea", ": 3", ": 5", ": 9", ": Me", ", Cat", "Me", "x"],
  },
];

function check(result: CompileResult, source: string): void {
  if (result.model === null) {
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
      source,
    ).toBe(true);
  } else {
    expect(
      result.diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
      source,
    ).toBe(true);
    expect(validateModel(result.model), source).toEqual([]);
    expect(checkAgainst("DiagramModel", result.model), source).toEqual([]);
  }
  for (const diagnostic of result.diagnostics) {
    expect(diagnostic.span.start.line, source).toBeGreaterThanOrEqual(1);
    expect(diagnostic.span.start.column, source).toBeGreaterThanOrEqual(1);
  }
}

describe.each(TYPES)("$family", ({ family, header, words }) => {
  const vocabulary = [...words, ...COMMON];
  const pick = (next: () => number) => vocabulary[Math.floor(next() * vocabulary.length)] ?? "";

  test(
    "text from the profile's own vocabulary is refused or valid",
    async () => {
      const next = random(family.length * 101);
      for (let round = 0; round < 150; round += 1) {
        const words = Array.from({ length: Math.floor(next() * 40) }, () => pick(next));
        const source = header + words.join(next() < 0.5 ? " " : "");
        check(await compile(source), source);
      }
    },
    TIMEOUT,
  );

  test(
    "its golden fixtures with small edits are refused or valid",
    async () => {
      const next = random(family.length * 977);
      const fixtures = loadFixtures().filter((fixture) => fixture.name.startsWith(`${family}/`));
      expect(fixtures.length).toBeGreaterThan(0);
      for (let round = 0; round < 150; round += 1) {
        const fixture = fixtures[Math.floor(next() * fixtures.length)];
        if (!fixture) continue;
        const at = Math.floor(next() * fixture.source.length);
        const cut = Math.floor(next() * 4);
        const source = fixture.source.slice(0, at) + (next() < 0.7 ? pick(next) : "") + fixture.source.slice(at + cut);
        check(await compile(source), source);
      }
    },
    TIMEOUT,
  );
});
