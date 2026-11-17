// Archer's validator is the policy half of label safety (research 12): with
// Mermaid's sanitizer stubbed out, HTML and control characters are refused in
// every kind of label of every diagram type, and ordinary text that merely
// looks like markup is kept exactly as written.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { errorsOf, located } from "./support/compile-helpers.ts";

/** Each kind of label, with the text placed in it, and where that label starts. */
const PLACES: { kind: string; source: (text: string) => string; at: string }[] = [
  { kind: "node label", source: (text) => `flowchart LR\n  a["${text}"]\n`, at: "2:3" },
  { kind: "edge label", source: (text) => `flowchart LR\n  a[A]\n  b[B]\n  a e1@-->|"${text}"| b\n`, at: "4:5" },
  {
    kind: "subgraph label",
    source: (text) => `flowchart LR\n  a[A]\n  subgraph g["${text}"]\n    a\n  end\n`,
    at: "3:12",
  },
  { kind: "participant alias", source: (text) => `sequenceDiagram\n  participant a as ${text}\n`, at: "2:20" },
  { kind: "message text", source: (text) => `sequenceDiagram\n  participant a as A\n  a->>a: ${text}\n`, at: "3:10" },
  {
    kind: "note text",
    source: (text) => `sequenceDiagram\n  participant a as A\n  Note over a: ${text}\n`,
    at: "3:16",
  },
  {
    kind: "fragment label",
    source: (text) => `sequenceDiagram\n  participant a as A\n  loop ${text}\n    a->>a: x\n  end\n`,
    at: "3:8",
  },
  {
    kind: "section label",
    source: (text) =>
      `sequenceDiagram\n  participant a as A\n  alt ok\n    a->>a: x\n  else ${text}\n    a->>a: y\n  end\n`,
    at: "5:8",
  },
  { kind: "state label", source: (text) => `stateDiagram-v2\n  state "${text}" as A\n`, at: "2:10" },
  { kind: "state description", source: (text) => `stateDiagram-v2\n  A : ${text}\n`, at: "2:7" },
  {
    kind: "transition label",
    source: (text) => `stateDiagram-v2\n  A : A\n  B : B\n  A --> B : ${text}\n`,
    at: "4:13",
  },
  { kind: "state note", source: (text) => `stateDiagram-v2\n  A : A\n  note left of A : ${text}\n`, at: "3:20" },
  { kind: "entity label", source: (text) => `erDiagram\n  A["${text}"]\n`, at: "2:6" },
  { kind: "relationship label", source: (text) => `erDiagram\n  A\n  B\n  A ||--o{ B : "${text}"\n`, at: "4:16" },
  { kind: "attribute comment", source: (text) => `erDiagram\n  A {\n    int x "${text}"\n  }\n`, at: "3:12" },
  { kind: "C4 title", source: (text) => `C4Context\n  title ${text}\n  Person(p, "P")\n`, at: "2:9" },
  { kind: "C4 element label", source: (text) => `C4Context\n  Person(p, "${text}")\n`, at: "2:14" },
  { kind: "C4 description", source: (text) => `C4Context\n  Person(p, "P", "${text}")\n`, at: "2:19" },
  { kind: "C4 technology", source: (text) => `C4Container\n  Container(c, "C", "${text}")\n`, at: "2:22" },
  {
    kind: "C4 boundary label",
    source: (text) => `C4Context\n  Boundary(b, "${text}") {\n    Person(p, "P")\n  }\n`,
    at: "2:16",
  },
  {
    kind: "C4 relationship label",
    source: (text) => `C4Context\n  Person(p, "P")\n  Rel(p, p, "${text}")\n`,
    at: "3:14",
  },
  {
    kind: "architecture title",
    source: (text) => `architecture-beta\n  title ${text}\n  service a(server)[A]\n`,
    at: "2:9",
  },
  { kind: "service label", source: (text) => `architecture-beta\n  service a(server)[${text}]\n`, at: "2:21" },
  { kind: "group label", source: (text) => `architecture-beta\n  group g(cloud)[${text}]\n`, at: "2:18" },
  {
    kind: "architecture edge label",
    source: (text) => `architecture-beta\n  service a(server)[A]\n  service b(server)[B]\n  a:R -[${text}]- L:b\n`,
    at: "4:9",
  },
  { kind: "journey title", source: (text) => `journey\n  title ${text}\n  section S\n    t: 3\n`, at: "2:9" },
  { kind: "journey section", source: (text) => `journey\n  section x ${text}\n    t: 3\n`, at: "2:11" },
  { kind: "journey task", source: (text) => `journey\n  section S\n    x ${text}: 3\n`, at: "3:5" },
  { kind: "journey actor", source: (text) => `journey\n  section S\n    t: 3: ${text}\n`, at: "3:11" },
];

const HTML = [
  "x <b>bold</b>",
  "<p>para</p>",
  "<br clear=all>",
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "</div>",
];
const CONTROLS: [string, string][] = [
  ["ESC", "\u001b[31mred"],
  ["BEL", "ring\u0007"],
  ["NUL", "a\u0000b"],
  ["DEL", "a\u007fb"],
  ["C1 CSI", "a\u009bb"],
];

describe.each(PLACES)("$kind", ({ source, at }) => {
  test.each(HTML)("refuses HTML: %s", async (html) => {
    const result = await compile(source(html));
    expect(result.model).toBeNull();
    expect(located(errorsOf(result.diagnostics))).toEqual([`unsupported_construct@${at}`]);
    expect(result.diagnostics[0]?.message).toContain("HTML");
  });

  test.each(CONTROLS)("refuses the control character %s", async (_name, text) => {
    const result = await compile(source(text));
    expect(result.model).toBeNull();
    const errors = errorsOf(result.diagnostics);
    expect(errors.map((diagnostic) => diagnostic.code)).toEqual(["control_character"]);
    expect(errors[0]?.span.start.line).toBe(Number(at.split(":")[0]));
  });

  test.each(["a < b", "latency < 5ms & p > 1", "R&D", "x<y", "tab\there"])("keeps %s exactly", async (text) => {
    const result = await compile(source(text));
    expect(errorsOf(result.diagnostics)).toEqual([]);
    expect(JSON.stringify(result.model)).toContain(JSON.stringify(text).slice(1, -1));
  });

  test("holds the characters entity codes stand for, as Mermaid draws them", async () => {
    const result = await compile(source("say #quot;hi#quot; #35;1 #59; #9829; #lt;5ms #amp; caf#233;"));
    expect(errorsOf(result.diagnostics)).toEqual([]);
    expect(JSON.stringify(result.model)).toContain(JSON.stringify('say "hi" #1 ; ♥ <5ms & café').slice(1, -1));
  });

  test("refuses HTML written with entity codes, as it refuses HTML", async () => {
    const result = await compile(source("#lt;script#gt;alert(1)#lt;/script#gt;"));
    expect(result.model).toBeNull();
    expect(located(errorsOf(result.diagnostics))).toEqual([`unsupported_construct@${at}`]);
    expect(result.diagnostics[0]?.message).toContain("HTML");
  });

  test.each([
    ["one<br/>two", "one\ntwo"],
    ["one<br>two", "one\ntwo"],
    ["one<br />two", "one\ntwo"],
    ["one<BR>two<Br/>three", "one\ntwo\nthree"],
  ])("reads the line break %s as a new line, as Mermaid draws it", async (text, label) => {
    const result = await compile(source(text));
    expect(errorsOf(result.diagnostics)).toEqual([]);
    expect(JSON.stringify(result.model)).toContain(JSON.stringify(label).slice(1, -1));
  });

  test("refuses other HTML beside a line break, and says what is allowed", async () => {
    const result = await compile(source("one<br/><b>two</b>"));
    expect(result.model).toBeNull();
    expect(located(errorsOf(result.diagnostics))).toEqual([`unsupported_construct@${at}`]);
    expect(result.diagnostics[0]?.message).toContain("use `<br/>` for a line break; other HTML isn't supported");
  });

  test("refuses a line break spelled with entity codes: Mermaid shows it as text", async () => {
    const result = await compile(source("one#lt;br/#gt;two"));
    expect(result.model).toBeNull();
    expect(located(errorsOf(result.diagnostics))).toEqual([`unsupported_construct@${at}`]);
  });

  test.each(["a#27;[31mred", "a#10;b", "a#127;b", "#8238;evil", "a#0;b#7;"])(
    "refuses a control character written as an entity code: %s",
    async (text) => {
      const result = await compile(source(text));
      expect(result.model).toBeNull();
      const errors = errorsOf(result.diagnostics);
      expect(errors.map((diagnostic) => diagnostic.code)).toEqual(["control_character"]);
      expect(errors[0]?.span.start.line).toBe(Number(at.split(":")[0]));
      expect(errors[0]?.message).toContain("entity code");
    },
  );
});
