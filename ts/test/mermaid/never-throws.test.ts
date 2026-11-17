// compile() is a trust boundary: whatever the source, it resolves, and the
// result is either refused (no model, at least one located error) or a model
// that is sound and conforms to the envelope schema. Inputs are arbitrary
// text, text built from the profile's own vocabulary, and the golden fixtures
// with small edits, from a fixed seed so a failure reproduces.

import { expect, test } from "vitest";

// Seeded property runs: a few seconds alone, more on a loaded machine or
// beside tests that start a service. Generous, so load does not fail them.
const TIMEOUT = 30_000;
import { addMissingEdgeIds, compile, type CompileResult } from "../../src/mermaid/index.ts";
import { validateModel } from "../../src/mermaid/validate.ts";
import { loadFixtures } from "./support/fixtures.ts";
import { checkAgainst } from "./support/schema.ts";

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

const VOCABULARY = [
  "flowchart LR",
  "graph TD",
  "sequenceDiagram",
  "\n",
  "\n",
  "  ",
  "a",
  "b",
  "e1@",
  "-->",
  "-.->",
  "==>",
  "---",
  "--x",
  "[",
  "]",
  "(",
  ")",
  "{",
  "}",
  "((",
  "))",
  "[(",
  ")]",
  "|",
  '"',
  ":::",
  "person",
  "subgraph",
  "end",
  "class",
  "classDef",
  "style",
  "%%",
  "%%{init: {}}%%",
  "participant",
  "actor",
  "as",
  "->>",
  "-->>",
  "-)",
  ":",
  "loop",
  "alt",
  "else",
  "par",
  "and",
  "opt",
  "Note over",
  "activate",
  "deactivate",
  "+",
  "-",
  ";",
  "&",
  "#",
  "#quot;",
  "<b>",
  "\u001b",
  "‮",
  "é",
  "日",
  "<-->",
  "<-.->",
  "<==>",
  "<<->>",
  "<<-->>",
  "<br/>",
  "<br>",
  "\r\n",
  // ADR 0030 line patterns and their key.
  "%% archer-key ",
  "%% archer-line ",
  "dashed",
  "dashdot",
  "dotted",
  "thick",
  ",",
  "C4Context",
  "stateDiagram-v2",
  "stroke-dasharray: 6 4",
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

test(
  "arbitrary text is refused or valid",
  async () => {
    const next = random(1);
    for (let round = 0; round < 150; round += 1) {
      const length = Math.floor(next() * 120);
      const source = Array.from({ length }, () => String.fromCharCode(Math.floor(next() * 0x2100))).join("");
      check(await compile(source), source);
    }
  },
  TIMEOUT,
);

test(
  "text from the profile's own vocabulary is refused or valid",
  async () => {
    const next = random(2);
    for (let round = 0; round < 300; round += 1) {
      const header = next() < 0.5 ? "flowchart LR\n" : "sequenceDiagram\n";
      const words = Array.from(
        { length: Math.floor(next() * 40) },
        () => VOCABULARY[Math.floor(next() * VOCABULARY.length)],
      );
      const source = header + words.join(next() < 0.5 ? " " : "");
      check(await compile(source), source);
    }
  },
  TIMEOUT,
);

test(
  "golden fixtures with small edits are refused or valid",
  async () => {
    const next = random(3);
    const fixtures = loadFixtures();
    for (let round = 0; round < 300; round += 1) {
      const fixture = fixtures[Math.floor(next() * fixtures.length)];
      if (!fixture) continue;
      const at = Math.floor(next() * fixture.source.length);
      const word = VOCABULARY[Math.floor(next() * VOCABULARY.length)] ?? "";
      const cut = Math.floor(next() * 4);
      const source = fixture.source.slice(0, at) + (next() < 0.7 ? word : "") + fixture.source.slice(at + cut);
      check(await compile(source), source);
    }
  },
  TIMEOUT,
);

test(
  "add-edge-ids on any text only inserts, and its result has no edge left without an ID that it could name",
  async () => {
    const next = random(7);
    for (let round = 0; round < 300; round += 1) {
      const length = 1 + Math.floor(next() * 30);
      const source =
        "flowchart LR\n" + Array.from({ length }, () => VOCABULARY[Math.floor(next() * VOCABULARY.length)]).join(" ");
      const fixed = addMissingEdgeIds(source);
      // Every byte of the source survives, in order: the fix only inserts.
      let at = 0;
      for (const character of source) {
        at = fixed.source.indexOf(character, at);
        expect(at, source).toBeGreaterThanOrEqual(0);
        at += character.length;
      }
      expect(addMissingEdgeIds(fixed.source).added, source).toEqual([]);
      check(await compile(fixed.source), fixed.source);
    }
  },
  TIMEOUT,
);
