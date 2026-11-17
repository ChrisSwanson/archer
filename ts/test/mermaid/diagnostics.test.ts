// Each construct the profile refuses gives its code, at the place it is
// written, with a fix an agent can act on; where the fix is a rewrite, the
// hint is the whole line rewritten, and applying it makes that problem go.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { applyHints, errorsOf, located } from "./support/compile-helpers.ts";

interface Refusal {
  name: string;
  source: string;
  /** Every error, as `code@line:column`, in report order. */
  errors: string[];
  /** The hint of the first error: the line to write instead. */
  hint?: string;
  /** Words the first error's message must contain. */
  says?: string;
  /** Replacing each line by its hint leaves no error. */
  fixedByHints?: boolean;
}

const F = (body: string) => `flowchart LR\n${body}\n`;
const S = (body: string) => `sequenceDiagram\n    participant a as A\n    participant b as B\n${body}\n`;

const flowchart: Refusal[] = [
  {
    name: "an edge with no ID",
    source: F("  a[A]\n  b[B]\n  a --> b"),
    errors: ["unsupported_construct@4:5"],
    hint: "  a a_b@--> b",
    says: "`a a_b@--> b`",
    fixedByHints: true,
  },
  {
    name: "a suggested edge ID that would collide is numbered",
    source: F("  a[A]\n  b[B]\n  a a_b@--> b\n  b --> a\n  a -.-> b"),
    errors: ["unsupported_construct@5:5", "unsupported_construct@6:5"],
    hint: "  b b_a@--> a",
    fixedByHints: true,
  },
  {
    name: "an unquoted label holding parentheses",
    source: F("  bare[API (v2)]"),
    errors: ["legacy_syntax@2:8"],
    hint: '  bare["API (v2)"]',
    says: "quoted",
    fixedByHints: true,
  },
  {
    name: "an unquoted label holding nested brackets",
    source: F("  x[Bracket [inner]]"),
    errors: ["legacy_syntax@2:5"],
    hint: '  x["Bracket [inner]"]',
    fixedByHints: true,
  },
  {
    name: "a cylinder label holding parentheses",
    source: F("  store[(Orders (primary))]"),
    errors: ["legacy_syntax@2:10"],
    hint: '  store[("Orders (primary)")]',
    fixedByHints: true,
  },
  {
    name: "an unquoted edge label holding parentheses",
    source: F("  a[A]\n  b[B]\n  a e1@-->|reads (c)| b"),
    errors: ["legacy_syntax@4:12"],
    hint: '  a e1@-->|"reads (c)"| b',
    fixedByHints: true,
  },
  {
    name: "an unquoted subgraph label holding parentheses",
    source: F("  subgraph backend[Backend (core)]\n    a[A]\n  end"),
    errors: ["legacy_syntax@2:20"],
    hint: '  subgraph backend["Backend (core)"]',
    fixedByHints: true,
  },
  {
    name: "a comment after a statement",
    source: F("  a[A] %% a note"),
    errors: ["legacy_syntax@2:8"],
    hint: "  %% a note\n  a[A]",
    fixedByHints: true,
  },
  {
    name: "a node that is never given a label",
    source: F("  a[A] e1@--> b"),
    errors: ["undeclared_node@2:15"],
    says: "`b[Label]`",
  },
  {
    name: "a typo'd node ID",
    source: F("  service[Service]\n  api[API]\n  api e1@--> serivce"),
    errors: ["undeclared_node@4:14"],
  },
  {
    name: "an edge ID used twice",
    source: F("  a[A]\n  b[B]\n  a e1@--> b\n  b e1@--> a"),
    errors: ["duplicate_edge@5:5"],
  },
  { name: "a node labelled twice", source: F("  a[A]\n  a[Again]"), errors: ["duplicate_node@3:3"] },
  {
    name: "a subgraph ID used twice",
    source: F("  a[A]\n  subgraph g[G]\n    a\n  end\n  subgraph g[H]\n  end"),
    errors: ["duplicate_subgraph@6:12"],
  },
  {
    name: "a header with no direction",
    source: "flowchart\n  a[A]\n",
    errors: ["expected_direction@1:10"],
    hint: "flowchart TB",
    fixedByHints: true,
  },
  { name: "a source with no header", source: "classDiagram\n  class A\n", errors: ["expected_flowchart@1:1"] },
  { name: "`&` chaining", source: F("  a[A] & b[B] e1@--> c[C]"), errors: ["unsupported_construct@2:8"] },
  {
    name: "a `;` separator",
    source: F("  a[A]; b[B]"),
    errors: ["unsupported_construct@2:7"],
    hint: "  a[A]\n  b[B]",
    fixedByHints: true,
  },
  {
    name: "a trailing `;`",
    source: F("  a[A];"),
    errors: ["unsupported_construct@2:7"],
    hint: "  a[A]",
    fixedByHints: true,
  },
  { name: "chained edges", source: F("  a[A] e1@--> b[B] e2@--> c[C]"), errors: ["unsupported_construct@2:23"] },
  {
    name: "link text inside the link",
    source: F("  a[A] e1@-- text --> b[B]"),
    errors: ["unsupported_construct@2:11"],
    hint: "  a[A] e1@-->|text| b[B]",
    fixedByHints: true,
  },
  {
    name: "an open link",
    source: F("  a[A] e1@--- b[B]"),
    errors: ["unsupported_construct@2:11"],
    hint: "  a[A] e1@--> b[B]",
    fixedByHints: true,
  },
  {
    name: "a cross link end",
    source: F("  a[A] e1@--x b[B]"),
    errors: ["unsupported_construct@2:11"],
    hint: "  a[A] e1@--> b[B]",
    fixedByHints: true,
  },
  {
    name: "a circle link end",
    source: F("  a[A] e1@-.-o b[B]"),
    errors: ["unsupported_construct@2:11"],
    hint: "  a[A] e1@-.-> b[B]",
    fixedByHints: true,
  },
  {
    name: "a two-way link with a cross end",
    source: F("  a[A] e1@<--x b[B]"),
    errors: ["unsupported_construct@2:11"],
    hint: "  a[A] e1@<--> b[B]",
    says: "arrowhead at each end",
    fixedByHints: true,
  },
  { name: "an invisible link", source: F("  a[A] e1@~~~ b[B]"), errors: ["unsupported_construct@2:11"] },
  { name: "a double circle", source: F("  g(((G)))"), errors: ["unsupported_construct@2:4"] },
  { name: "an asymmetric shape", source: F("  h>H]"), errors: ["unsupported_construct@2:4"] },
  { name: "a parallelogram", source: F("  p[/P/]"), errors: ["unsupported_construct@2:4"] },
  { name: "node metadata", source: F("  j@{ shape: rect }"), errors: ["unsupported_construct@2:4"] },
  { name: "a markdown string label", source: F('  a["`md`"]'), errors: ["unsupported_construct@2:3"] },
  {
    name: "two classes on one node",
    source: F("  a[A]:::person\n  class a system"),
    errors: ["unsupported_construct@2:3"],
    says: "one class",
  },
  {
    name: "an edge to a subgraph",
    source: F("  subgraph g\n  end\n  a[A] e1@--> g"),
    errors: ["unsupported_construct@4:15"],
  },
  {
    name: "a subgraph with a title and no ID",
    source: F("  subgraph Backend Services\n    a[A]\n  end"),
    errors: ["unsupported_construct@2:12"],
    hint: '  subgraph backend_services["Backend Services"]',
    fixedByHints: true,
  },
  {
    name: "a node shape as a subgraph label",
    source: F("  subgraph g[(Store)]\n  end"),
    errors: ["unsupported_construct@2:13"],
  },
  {
    name: "`direction` inside a subgraph",
    source: F("  a[A]\n  subgraph g[G]\n    direction TB\n    a\n  end"),
    errors: ["unsupported_construct@4:5"],
  },
  { name: "an accessibility title", source: F("  accTitle: Hello\n  a[A]"), errors: ["unsupported_construct@2:3"] },
  { name: "a subgraph never closed", source: F("  a[A]\n  subgraph g[G]\n    a"), errors: ["unclosed_subgraph@3:3"] },
  { name: "an `end` with nothing open", source: F("  a[A]\n  end"), errors: ["unexpected_token@3:3"] },
  {
    name: "a link with no target on its line",
    source: F("  a[A] e1@-->\n  b[B]"),
    errors: ["expected_target_node@2:11"],
  },
  { name: "an empty edge label", source: F("  a[A]\n  b[B]\n  a e1@-->|  | b"), errors: ["expected_label@4:11"] },
  { name: "a node ID outside the stable-ID grammar", source: F("  a.b[A]"), errors: ["invalid_id@2:3"] },
  {
    name: "YAML frontmatter",
    source: "---\ntitle: x\n---\nflowchart LR\n  a[A]\n",
    errors: ["unsupported_construct@1:1"],
  },
  {
    name: "a label left open, reported where it opened",
    source: F("  a[A]\n  b("),
    errors: ["unexpected_end@3:3"],
    says: "line 3",
  },
  {
    name: "a Mermaid parse error, at its line past comments and blank lines",
    source: "%% leading comment\n\nflowchart LR\n  a[A]\n  %% comment\n  b[B]]\n",
    errors: ["unexpected_token@6:6"],
  },
];

const sequence: Refusal[] = [
  {
    name: "a participant never declared",
    source: S("    a->>c: hi\n    a->>c: again"),
    errors: ["undeclared_participant@4:9"],
  },
  {
    name: "a participant declared twice",
    source: S("    participant a as Again"),
    errors: ["duplicate_participant@4:17"],
  },
  { name: "a `deactivate` with nothing open", source: S("    deactivate a"), errors: ["unmatched_deactivate@4:5"] },
  { name: "a `-` with nothing open", source: S("    b-->>-a: x"), errors: ["unmatched_deactivate@4:10"] },
  {
    name: "an open arrow",
    source: S("    a->b: open"),
    errors: ["unsupported_construct@4:6"],
    hint: "    a->>b: open",
    fixedByHints: true,
  },
  {
    name: "a dotted open arrow",
    source: S("    a-->b: x"),
    errors: ["unsupported_construct@4:6"],
    hint: "    a-->>b: x",
    fixedByHints: true,
  },
  {
    name: "a cross arrow",
    source: S("    a-xb: x"),
    errors: ["unsupported_construct@4:6"],
    hint: "    a->>b: x",
    fixedByHints: true,
  },
  {
    name: "a dotted async arrow",
    source: S("    a--)b: x"),
    errors: ["unsupported_construct@4:6"],
    hint: "    a-)b: x",
    fixedByHints: true,
  },
  {
    name: "a comment after a message, which Mermaid would draw",
    source: S("    a->>b: hi %% a note"),
    errors: ["legacy_syntax@4:15"],
    hint: "    %% a note\n    a->>b: hi",
    fixedByHints: true,
  },
  {
    name: "a quoted alias, whose quotes Mermaid would draw",
    source: 'sequenceDiagram\n    participant a as "Web (EU)"\n',
    errors: ["legacy_syntax@2:22"],
    hint: "    participant a as Web (EU)",
    fixedByHints: true,
  },
  {
    name: "a participant named after a keyword",
    source: "sequenceDiagram\n    participant actor as A\n    actor->>actor: x\n",
    errors: ["legacy_syntax@2:17", "legacy_syntax@3:5", "legacy_syntax@3:13"],
    hint: "    participant actor1 as A",
    fixedByHints: true,
  },
  { name: "`rect`", source: S("    rect rgb(1,2,3)\n      a->>b: y\n    end"), errors: ["unsupported_construct@4:5"] },
  {
    name: "`box`",
    source: S("    box Aqua G\n      participant c as C\n    end"),
    errors: ["unsupported_construct@4:5"],
  },
  {
    name: "`critical` and its `option`",
    source: S("    critical c\n      a->>b: x\n    option o\n      a->>b: y\n    end"),
    errors: ["unsupported_construct@4:5"],
  },
  { name: "`break`", source: S("    break b\n      a->>b: x\n    end"), errors: ["unsupported_construct@4:5"] },
  {
    name: "`create`",
    source: S("    create participant c as C\n    a->>c: hi"),
    errors: ["unsupported_construct@4:5", "undeclared_participant@5:9"],
  },
  {
    name: "`autonumber` with a start",
    source: S("    autonumber 10 5"),
    errors: ["unsupported_construct@4:5"],
    hint: "    autonumber",
    fixedByHints: true,
  },
  { name: "`autonumber off`", source: S("    autonumber off"), errors: ["unsupported_construct@4:5"] },
  {
    name: "`else` inside `par`",
    source: S("    par p\n      a->>b: x\n    else e\n      a->>b: y\n    end"),
    errors: ["unsupported_construct@6:5"],
    hint: "    and e",
    fixedByHints: true,
  },
  {
    name: "`and` inside `alt`",
    source: S("    alt p\n      a->>b: x\n    and e\n      a->>b: y\n    end"),
    errors: ["unsupported_construct@6:5"],
    hint: "    else e",
    fixedByHints: true,
  },
  { name: "a fragment with no label", source: S("    loop\n      a->>b: x\n    end"), errors: ["expected_label@4:5"] },
  { name: "a fragment never closed", source: S("    loop l\n      a->>b: x"), errors: ["unclosed_fragment@4:5"] },
  { name: "a note beside two participants", source: S("    Note left of a,b: x"), errors: ["invalid_note@4:5"] },
  { name: "a note with no colon", source: S("    Note over a"), errors: ["expected_colon@4:16"] },
  { name: "a message with no colon", source: S("    a->>b"), errors: ["expected_colon@4:10"] },
  { name: "a title", source: S("    title T"), errors: ["unsupported_construct@4:5"] },
  {
    name: "a participant ID outside the stable-ID grammar",
    source: "sequenceDiagram\n    participant a.b as A\n    a.b->>a.b: x\n",
    errors: ["invalid_id@2:17"],
  },
];

describe.each([
  ["flowchart", flowchart],
  ["sequence", sequence],
] as const)("%s refusals", (_family, table) => {
  test.each(table)("$name", async ({ source, errors, hint, says, fixedByHints }) => {
    const result = await compile(source);
    expect(result.model).toBeNull();
    const found = errorsOf(result.diagnostics);
    expect(located(found)).toEqual(errors);
    const first = found[0];
    if (hint !== undefined) expect(first?.hint).toBe(hint);
    if (says !== undefined) expect(first?.message).toContain(says);
    for (const diagnostic of found) {
      expect(diagnostic.message.length).toBeGreaterThan(20);
      expect(diagnostic.span.end.line * 1e6 + diagnostic.span.end.column).toBeGreaterThan(
        diagnostic.span.start.line * 1e6 + diagnostic.span.start.column,
      );
    }
    if (fixedByHints) {
      const fixed = await compile(applyHints(source, found));
      expect(errorsOf(fixed.diagnostics)).toEqual([]);
      expect(fixed.model).not.toBeNull();
    }
  });
});

describe("notes and warnings leave the diagram valid", () => {
  test("styling is accepted, left out of the model, and named in one note per kind", async () => {
    const source = F(
      '  a[A]\n  b[B]\n  a e1@--> b\n  style a fill:#f9f\n  style b fill:#f9f\n  linkStyle 0 stroke:#ff3\n  click a "https://example.com"\n  classDef default fill:#fff',
    );
    const result = await compile(`%%{init: {"theme": "dark"}}%%\n${source}`);
    expect(result.model).toEqual({
      type: "freeform-graph",
      direction: "lr",
      nodes: [
        { id: "a", label: "A", shape: "rectangle" },
        { id: "b", label: "B", shape: "rectangle" },
      ],
      edges: [{ id: "e1", source: "a", target: "b" }],
      groups: [],
    });
    expect(result.diagnostics.every((diagnostic) => diagnostic.severity === "info")).toBe(true);
    expect(located(result.diagnostics)).toEqual([
      "ignored_styling@1:1",
      "ignored_styling@6:3",
      "ignored_styling@8:3",
      "ignored_styling@9:3",
      "ignored_styling@10:3",
    ]);
    expect(result.diagnostics[1]?.message).toContain("2 `style` statements");
  });

  test("`class` gives a node its kind, as `:::` does", async () => {
    const result = await compile(F("  a[A]\n  b[B]\n  a e1@--> b\n  class a,b person"));
    expect(result.model).toMatchObject({
      nodes: [
        { id: "a", classes: ["person"] },
        { id: "b", classes: ["person"] },
      ],
    });
  });

  test("a `classDef` defines a category beyond the six kinds", async () => {
    const result = await compile(F("  a[A]:::queue\n  classDef queue fill:#f00,stroke:#0f0"));
    expect(result.diagnostics).toEqual([]);
    expect(result.model).toMatchObject({ nodes: [{ id: "a", classes: ["queue"] }] });
  });

  test("an unknown class is a warning at the class", async () => {
    const result = await compile(F("  a[A]:::unknownthing"));
    expect(result.model).not.toBeNull();
    expect(located(result.diagnostics)).toEqual(["unknown_class@2:10"]);
    expect(result.diagnostics[0]?.severity).toBe("warning");
  });

  test("a node with no edge in a diagram with edges is a warning at its declaration", async () => {
    const result = await compile(F("  a[A]\n  b[B]\n  a e1@--> b\n  c[C]"));
    expect(result.model).not.toBeNull();
    expect(located(result.diagnostics)).toEqual(["unconnected_node@5:3"]);
  });

  test("inline declarations in an edge are accepted", async () => {
    const result = await compile(F("  a[Client] e1@--> b[API]"));
    expect(result.diagnostics).toEqual([]);
    expect(result.model).toMatchObject({
      nodes: [
        { id: "a", label: "Client" },
        { id: "b", label: "API" },
      ],
      edges: [{ id: "e1" }],
    });
  });

  test("a node may be declared below its first use", async () => {
    const result = await compile(F("  a e1@--> b\n  a[A]\n  b[B]"));
    expect(result.diagnostics).toEqual([]);
  });
});

test("every problem is reported in one pass, in source order", async () => {
  const result = await compile(F("  a[A]\n  b[B]\n  a --> b\n  a e1@--- b\n  c[C] e2@--> d\n  a.b[X]"));
  expect(located(errorsOf(result.diagnostics))).toEqual([
    "unsupported_construct@4:5",
    "unsupported_construct@5:8",
    "undeclared_node@6:15",
    "invalid_id@7:3",
  ]);
});

test("a long report stops at twenty errors and says where the rest begin", async () => {
  const lines = Array.from({ length: 30 }, (_, index) => `  n${index}[N] --> m${index}[M]`);
  const result = await compile(F(lines.join("\n")));
  expect(result.diagnostics).toHaveLength(21);
  expect(result.diagnostics.slice(0, 20).every((diagnostic) => diagnostic.code === "unsupported_construct")).toBe(true);
  expect(located(result.diagnostics.slice(20))).toEqual(["too_many_diagnostics@22:10"]);
});
