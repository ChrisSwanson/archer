// The C4 profile: what it reads, and each construct it refuses, at the place
// it is written, with what to write instead. Mermaid's C4 grammar accepts much
// it then reads otherwise; each such case is a row here.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { located } from "./support/compile-helpers.ts";
import { refusals } from "./support/refusals.ts";

const C = (body: string) => `C4Context\n  Person(p, "P")\n  System(s, "S")\n${body}\n`;

describe("refused", () => {
  refusals([
    {
      name: "a relationship with no label, which Mermaid reads into the next line",
      source: C('  Rel(p, s)\n  Rel(s, p, "back")'),
      errors: ["expected_label@4:3"],
      says: "next line",
    },
    {
      name: "an unquoted label",
      source: C("  Person(q, Q)"),
      errors: ["unquoted_argument@4:13"],
      hint: '  Person(q, "Q")',
      fixedByHints: true,
    },
    {
      name: "a second element with an alias, which Mermaid moves",
      source: C('  Person(p, "Again")'),
      errors: ["duplicate_id@4:10"],
    },
    {
      name: "a relationship to an alias never declared",
      source: C('  Rel(p, q, "x")'),
      errors: ["undeclared_element@4:10"],
    },
    {
      name: "a relationship to a boundary",
      source: C('  System_Boundary(b, "B") {\n    System(t, "T")\n  }\n  Rel(p, b, "x")'),
      errors: ["unsupported_construct@7:10"],
    },
    {
      name: "a named argument, which Mermaid drops a relationship for",
      source: C('  Rel(p, s, "x", $tags="v1")'),
      errors: ["unsupported_construct@4:18"],
    },
    {
      name: "an empty boundary, which Mermaid cannot read",
      source: C('  System_Boundary(b, "B") {\n  }'),
      errors: ["empty_boundary@4:19", "unexpected_token@5:1"],
    },
    {
      name: "a boundary never closed",
      source: C('  System_Boundary(b, "B") {\n    System(t, "T")'),
      errors: ["unclosed_block@4:19"],
    },
    { name: "a boundary with no body", source: C('  System_Boundary(b, "B")'), errors: ["expected_block@4:3"] },
    { name: "a statement never closed", source: C('  Person(q, "Q"'), errors: ["unexpected_end@4:3"] },
    {
      name: "Rel_Back",
      source: C('  Rel_Back(p, s, "x")'),
      errors: ["unsupported_construct@4:3"],
      says: "`Rel(s, p, ...)`",
    },
    { name: "a dynamic diagram", source: 'C4Dynamic\n  Person(p, "P")\n', errors: ["unsupported_construct@1:1"] },
    {
      name: "a deployment node",
      source: C('  Deployment_Node(n, "N") {\n    System(t, "T")\n  }'),
      errors: ["unsupported_construct@4:3"],
    },
    { name: "an alias outside the ID grammar", source: C('  Person(p.q, "PQ")'), errors: ["invalid_id@4:10"] },
    {
      name: "HTML in a label",
      source: C('  Person(q, "<b>Q</b>")'),
      errors: ["unsupported_construct@4:14"],
      says: "HTML",
    },
    {
      name: "too many arguments",
      source: C('  Person(q, "Q", "d", "sprite")'),
      errors: ["unsupported_construct@4:23"],
    },
    {
      name: "a comment after a statement",
      source: C('  Rel(p, s, "x") %% why'),
      errors: ["unsupported_construct@4:18"],
      hint: '  %% why\n  Rel(p, s, "x")',
    },
  ]);
});

describe("read", () => {
  test("a direction on a relationship is read as Rel, and the hint noted", async () => {
    const result = await compile(C('  Rel_U(p, s, "x")\n  Rel_Left(s, p, "y")'));
    expect(result.model).toMatchObject({ relationships: [{ id: "p--s" }, { id: "s--p" }] });
    expect(located(result.diagnostics)).toEqual(["ignored_layout_hint@4:3"]);
  });

  test("styling statements are accepted and noted once", async () => {
    const result = await compile(
      C('  UpdateElementStyle(p, $fontColor="red")\n  UpdateLayoutConfig($c4ShapeInRow="3")'),
    );
    expect(result.model).not.toBeNull();
    expect(located(result.diagnostics)).toEqual(["ignored_styling@4:3"]);
  });

  test("a component diagram is read at its level", async () => {
    const result = await compile('C4Component\n  Component(c, "Parser", "TypeScript")\n');
    expect(result.model).toEqual({
      type: "c4-model",
      level: "component",
      elements: [{ id: "c", kind: "component", label: "Parser", technology: "TypeScript" }],
      boundaries: [],
      relationships: [],
    });
  });

  test("a title is read without the spaces around it", async () => {
    const result = await compile('C4Context\n  title  My system \n  Person(p, "P")\n');
    expect(result.model).toMatchObject({ title: "My system" });
  });

  test("entity codes are decoded into the characters Mermaid draws", async () => {
    const result = await compile(C('  Rel(p, s, "says #quot;hi#quot;")'));
    expect(result.model).toMatchObject({ relationships: [{ label: 'says "hi"' }] });
  });
});
