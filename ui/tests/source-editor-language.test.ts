// The Mermaid colouring: which pieces of a line are which (a tokenizer, not a parser).
import { StringStream } from "@codemirror/language";
import { expect, it } from "vitest";
import { mermaidStreamParser, type MermaidState } from "../src/source-editor/mermaid-language";

/** Each line's non-space tokens as `style:text`, the state carried across lines. */
function tokens(source: string): string[][] {
  const state = mermaidStreamParser.startState!(4) as MermaidState;
  return source.split("\n").map((line) => {
    const out: string[] = [];
    if (line === "") {
      mermaidStreamParser.blankLine?.(state, 4);
      return out;
    }
    const stream = new StringStream(line, 4, 4);
    while (!stream.eol()) {
      const style = mermaidStreamParser.token(stream, state);
      const text = stream.current();
      if (stream.pos === stream.start) throw new Error(`no progress at ${stream.pos} in ${line}`);
      if (style !== null && text.trim()) out.push(`${style}:${text}`);
      stream.start = stream.pos;
    }
    return out;
  });
}

it("colours a flowchart: header, ids, shapes, labels, arrows, edge ids and comments", () => {
  const [header, node, edge, comment, directive, linkText] = tokens(
    [
      "flowchart LR",
      "  api-gateway[(Orders DB)]",
      "  a e1@--> |reads| b",
      "  %% a note to self",
      "%% archer-id: checkout",
      "  a -- uses --> b",
    ].join("\n"),
  );
  expect(header).toEqual(["heading:flowchart", "keyword:LR"]);
  expect(node).toEqual(["variableName:api-gateway", "bracket:[(", "string:Orders DB", "bracket:)]"]);
  expect(edge).toEqual([
    "variableName:a",
    "labelName:e1",
    "punctuation:@",
    "operator:-->",
    "bracket:|",
    "string:reads",
    "bracket:|",
    "variableName:b",
  ]);
  expect(comment).toEqual(["comment:%% a note to self"]);
  expect(directive).toEqual(["meta:%% archer-id: checkout"]);
  expect(linkText).toEqual(["variableName:a", "operator:--", "string:uses", "operator:-->", "variableName:b"]);
});

it("keeps A-->B apart: an arrow is not part of an ID", () => {
  expect(tokens("graph TD\nA-->B\nA---B\nA-.->B\nA==>B\nA<-->B")).toEqual([
    ["heading:graph", "keyword:TD"],
    ["variableName:A", "operator:-->", "variableName:B"],
    ["variableName:A", "operator:---", "variableName:B"],
    ["variableName:A", "operator:-.->", "variableName:B"],
    ["variableName:A", "operator:==>", "variableName:B"],
    ["variableName:A", "operator:<-->", "variableName:B"],
  ]);
});

it("colours a sequence: keywords, message arrows and message text", () => {
  const lines = tokens(
    "sequenceDiagram\n  participant A as Alice\n  A->>B: Hello there\n  B-->>A: ok\n  loop Every minute\n  end",
  );
  expect(lines[1]).toEqual(["keyword:participant", "variableName:A", "keyword:as", "variableName:Alice"]);
  expect(lines[2]).toEqual(["variableName:A", "operator:->>", "variableName:B", "punctuation::", "string:Hello there"]);
  expect(lines[3]).toEqual(["variableName:B", "operator:-->>", "variableName:A", "punctuation::", "string:ok"]);
  expect(lines[4][0]).toBe("keyword:loop");
  expect(lines[5]).toEqual(["keyword:end"]);
});

it("a keyword of one family is an ID in another", () => {
  expect(tokens("flowchart LR\n  loop --> participant")[1]).toEqual([
    "variableName:loop",
    "operator:-->",
    "variableName:participant",
  ]);
});

it("colours C4 macros (brackets are arguments there), ER cardinalities and state starts", () => {
  expect(tokens('C4Context\n  Rel(web, api, "Uses", "HTTPS")')[1]).toEqual([
    "keyword:Rel",
    "punctuation:(",
    "variableName:web",
    "punctuation:,",
    "variableName:api",
    "punctuation:,",
    'string:"Uses"',
    "punctuation:,",
    'string:"HTTPS"',
    "punctuation:)",
  ]);
  expect(tokens("erDiagram\n  CUSTOMER ||--o{ ORDER : places")[1]).toEqual([
    "variableName:CUSTOMER",
    "operator:||--o{",
    "variableName:ORDER",
    "punctuation::",
    "string:places",
  ]);
  expect(tokens("stateDiagram-v2\n  [*] --> Idle")).toEqual([
    ["heading:stateDiagram-v2"],
    ["atom:[*]", "operator:-->", "variableName:Idle"],
  ]);
});

it("an unclosed quote carries to the next line; an unclosed bracket does not", () => {
  const lines = tokens('flowchart LR\n  a["one\ntwo"] --> b\n  c[open\n  d --> e');
  expect(lines[1]).toEqual(["variableName:a", "bracket:[", 'string:"one']);
  expect(lines[2]).toEqual(['string:two"', "bracket:]", "operator:-->", "variableName:b"]);
  expect(lines[4]).toEqual(["variableName:d", "operator:-->", "variableName:e"]);
});
