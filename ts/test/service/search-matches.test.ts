// Search match fields (phase3-front-door.md, "Match fields"): which field of a
// card each match was in, and for an element, which element of the COMPILED
// model -- not a reading of the source text.
import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import type { DiagramModel } from "../../src/model/index.ts";
import {
  elementCandidates,
  excerpt,
  fieldMatches,
  MATCH_FIELDS,
  MAX_EXCERPT_CHARS,
  MAX_MATCHES_PER_RESULT,
  type Candidate,
} from "../../src/service/front-door.ts";

async function model(source: string): Promise<DiagramModel> {
  const { model } = await compile(source);
  if (model === null) throw new Error(`does not compile: ${source}`);
  return model;
}

const PIPELINE = [
  "flowchart LR",
  "  %% the token stream feeds the parser",
  "  subgraph front[Front end]",
  "    lex[Lexer]",
  "    parse[Parser]",
  "  end",
  "  lex e1@-->|token stream| parse",
  "  parse e2@--> out[Output]",
  "",
].join("\n");

const CHAT = [
  "sequenceDiagram",
  "  participant A as Alice",
  "  participant B as Bob",
  "  A->>B: hello there",
  "  loop Retry until done",
  "    B->>A: ack",
  "  end",
  "  Note over A,B: handshake complete",
  "",
].join("\n");

describe("elementCandidates", () => {
  test("a flowchart's nodes, edges and groups, by id and label", async () => {
    const found = elementCandidates(await model(PIPELINE));
    expect(found).toContainEqual({ field: "node", texts: ["Lexer", "lex"], shown: "Lexer", elementId: "lex" });
    expect(found).toContainEqual({
      field: "edge",
      texts: ["token stream", "e1"],
      shown: "token stream",
      elementId: "e1",
    });
    // An edge without a label is shown by its ends' labels, and found by its own id only.
    expect(found).toContainEqual({ field: "edge", texts: ["e2"], shown: "Parser → Output", elementId: "e2" });
    expect(found).toContainEqual({
      field: "group",
      texts: ["Front end", "front"],
      shown: "Front end",
      elementId: "front",
    });
  });

  test("a sequence diagram's participants, messages and fragments", async () => {
    const found = elementCandidates(await model(CHAT));
    expect(found.filter((c) => c.field === "participant").map((c) => c.elementId)).toEqual(["A", "B"]);
    expect(found).toContainEqual(expect.objectContaining({ field: "participant", shown: "Alice", elementId: "A" }));
    expect(found).toContainEqual(expect.objectContaining({ field: "message", shown: "hello there" }));
    expect(found).toContainEqual(expect.objectContaining({ field: "message", shown: "ack" }));
    expect(found).toContainEqual(expect.objectContaining({ field: "group", shown: "Retry until done" }));
    // Every candidate names its element.
    for (const c of found) expect(c.elementId).toBeTypeOf("string");
  });
});

describe("fieldMatches", () => {
  test("a node by its label, an edge by its label; source words no element holds fall to 'source'", async () => {
    const elements = elementCandidates(await model(PIPELINE));
    const { matches, more } = fieldMatches(["lexer"], elements, PIPELINE);
    expect(matches).toEqual([{ field: "node", text: "Lexer", elementId: "lex" }]);
    expect(more).toBe(0);
    expect(fieldMatches(["stream"], elements, PIPELINE).matches).toEqual([
      { field: "edge", text: "token stream", elementId: "e1" },
    ]);
    // "feeds" is only in a Mermaid comment: in the source, in no element.
    expect(fieldMatches(["feeds"], elements, PIPELINE).matches).toEqual([
      { field: "source", text: "%% the token stream feeds the parser" },
    ]);
  });

  test("a sequence participant and message from the compiled model; a sequence note is source", async () => {
    const elements = elementCandidates(await model(CHAT));
    expect(fieldMatches(["alice"], elements, CHAT).matches).toEqual([
      { field: "participant", text: "Alice", elementId: "A" },
    ]);
    const hello = fieldMatches(["hello"], elements, CHAT).matches;
    expect(hello).toHaveLength(1);
    expect(hello[0]).toMatchObject({ field: "message", text: "hello there" });
    expect(hello[0]?.elementId).toBeTypeOf("string");
    expect(fieldMatches(["handshake"], elements, CHAT).matches).toEqual([
      { field: "source", text: "Note over A,B: handshake complete" },
    ]);
  });

  test("title, path, note and comment candidates carry what locates them, in field order", () => {
    const candidates: Candidate[] = [
      { field: "comment", texts: ["Retry the lexer?"], threadId: "t1" },
      { field: "note", texts: ["# Lexer notes\n\nThe lexer is hand-written."], notePath: "docs/lexer.md" },
      { field: "path", texts: [".archer/lexer.mmd"] },
      { field: "title", texts: ["Lexer design"] },
    ];
    expect(fieldMatches(["lexer"], candidates, "").matches).toEqual([
      { field: "title", text: "Lexer design" },
      { field: "path", text: ".archer/lexer.mmd" },
      { field: "note", text: "# Lexer notes The lexer is hand-written.", notePath: "docs/lexer.md" },
      { field: "comment", text: "Retry the lexer?", threadId: "t1" },
    ]);
  });

  test("a source word an element (or the title) already holds is not repeated as source", async () => {
    const elements = elementCandidates(await model(PIPELINE));
    expect(fieldMatches(["parser"], elements, PIPELINE).matches.map((m) => m.field)).toEqual(["node"]);
  });

  test("capped, with how many more", () => {
    const many: Candidate[] = Array.from({ length: MAX_MATCHES_PER_RESULT + 3 }, (_, i) => ({
      field: "node",
      texts: [`needle ${i}`],
      elementId: `n${i}`,
    }));
    const { matches, more } = fieldMatches(["needle"], many, "");
    expect(matches).toHaveLength(MAX_MATCHES_PER_RESULT);
    expect(more).toBe(3);
  });

  test("the same text in one field is one match", () => {
    const twice: Candidate[] = [
      { field: "title", texts: ["flow"] },
      { field: "title", texts: ["flow"] },
    ];
    expect(fieldMatches(["flow"], twice, "").matches).toEqual([{ field: "title", text: "flow" }]);
  });

  test("the field list is the documented one", () => {
    expect(MATCH_FIELDS).toEqual([
      "title",
      "path",
      "node",
      "participant",
      "edge",
      "message",
      "group",
      "source",
      "note",
      "comment",
    ]);
  });
});

describe("excerpt", () => {
  test("short text is kept, whitespace folded", () => {
    expect(excerpt("a  b\n\nc", "b")).toBe("a b c");
  });

  test("long text is cut around the first word, and marked where cut", () => {
    const text = `${"x ".repeat(100)}needle${" y".repeat(100)}`;
    const cut = excerpt(text, "needle");
    expect([...cut].length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS + 2);
    expect(cut).toContain("needle");
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.endsWith("…")).toBe(true);
  });
});
