// Plain Mermaid that the profile cannot read, pasted from elsewhere: each is
// reported where it is written, with a message that names the fix, rather
// than as Mermaid's own parser complaint.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { applyHints, errorsOf, located } from "./support/compile-helpers.ts";

const F = (body: string) => `flowchart LR\n${body}\n`;

async function errors(source: string) {
  return errorsOf((await compile(source)).diagnostics);
}

describe("flowchart", () => {
  test("`end` as a node ID is named as a reserved word, with another ID to use", async () => {
    const found = await errors(F("  a[A]\n  a e1@--> end\n  end[Finish]"));
    expect(located(found)).toEqual(["invalid_id@3:12", "invalid_id@4:3"]);
    for (const diagnostic of found) {
      expect(diagnostic.message).toContain("`end` is a reserved word");
      expect(diagnostic.message).toContain("another ID");
    }
  });

  test("a label starting with a slash is reported at its line, with the label quoted as the fix", async () => {
    const source = F("  a[A]\n  c[/slash]");
    const found = await errors(source);
    expect(located(found)).toEqual(["unexpected_token@3:4"]);
    expect(found[0]?.message).toContain("quote");
    expect(found[0]?.hint).toBe('  c["/slash"]');
    expect(await errors(applyHints(source, found))).toEqual([]);
  });

  test("text Mermaid's lexer does not recognize is reported at its line and column, not the header", async () => {
    // A stray `~` is not a form the scan names; Mermaid's lexer stops at it.
    const found = await errors(F("  a[A]\n  b[B] e1@--> a ~"));
    expect(located(found)).toEqual(["unexpected_token@3:17"]);
    expect(found[0]?.message).toContain("line 3");
  });

  test("a label mixing a markdown string and text gets the markdown refusal, as a pure one does", async () => {
    const mixed = await errors(F('  a[A]\n  b["`code` span"]'));
    const pure = await errors(F('  a[A]\n  b["`code`"]'));
    expect(located(mixed)).toEqual(["unsupported_construct@3:3"]);
    expect(located(pure)).toEqual(["unsupported_construct@3:3"]);
    expect(mixed[0]?.message).toBe(pure[0]?.message);
    expect(mixed[0]?.message).toContain("markdown string labels are not supported");
  });

  test("an empty label is `expected_label`, as the guide says", async () => {
    const found = await errors(F("  a[A]\n  b[]"));
    expect(located(found)).toEqual(["expected_label@3:4"]);
    expect(found[0]?.message).toContain("`b[Label]`");
  });

  test("another diagram's header pasted into a flowchart is named as a different diagram type", async () => {
    const found = await errors(F("  a[A]\n  classDiagram"));
    expect(located(found)).toEqual(["unsupported_construct@3:3"]);
    expect(found[0]?.message).toContain("different diagram type");
    expect(found[0]?.message).not.toContain("classDiagram[Label]");
  });

  test("a reserved word Mermaid reads as an ID is not refused", async () => {
    expect(await errors(F("  a[A]\n  endpoint[End]\n  a e1@--> endpoint"))).toEqual([]);
  });
});

describe("state diagram", () => {
  test("`state B` beside a composite with transitions both ways names the declaration to write", async () => {
    const source =
      "stateDiagram-v2\n  state B\n  state Comp {\n    state X\n    [*] --> X\n  }\n  Comp --> B\n  B --> Comp\n";
    const found = await errors(source);
    expect(located(found)).toEqual(["unexpected_token@2:3"]);
    expect(found[0]?.message).toContain('`state "B" as B`');
    expect(found[0]?.message).toContain("`B : Label`");
    expect(found[0]?.message).not.toContain("State name must be a single word");
    expect(found[0]?.hint).toBe('  state "B" as B');
    expect(await errors(applyHints(source, found))).toEqual([]);
  });

  test("a fork used before its declaration says to declare it first", async () => {
    const found = await errors(
      "stateDiagram-v2\n  state A\n  state B\n  [*] --> F\n  state F <<fork>>\n  F --> A\n  F --> B\n",
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("declare `state F <<fork>>` before its first use");
  });
});

describe("sequence diagram", () => {
  const S = (body: string) => `sequenceDiagram\n  participant x as X\n  participant y as Y\n${body}\n`;

  test("`option` outside `critical` is refused once, with no second error for its `end`", async () => {
    const found = await errors(S("  option y\n    x->>y: hi\n  end"));
    expect(located(found)).toEqual(["unsupported_construct@4:3"]);
    expect(found[0]?.message).toContain("`opt label`");
  });

  test("`option` inside `alt` still leaves the `alt` to its own `end`", async () => {
    const found = await errors(S("  alt a\n    x->>y: hi\n  option y\n    x->>y: again\n  end"));
    expect(located(found)).toEqual(["unsupported_construct@6:3"]);
  });

  test("`x--y` gets the supported arrows and the line to write, as `x-xy` does", async () => {
    const source = S("  x--y: hi");
    const found = await errors(source);
    expect(located(found)).toEqual(["unsupported_construct@4:4"]);
    expect(found[0]?.message).toContain("messages use `->>`");
    expect(found[0]?.hint).toBe("  x-->>y: hi");
    expect(await errors(applyHints(source, found))).toEqual([]);
  });
});

describe("ER diagram", () => {
  const E = (body: string) => `erDiagram\n  A {\n    int id\n  }\n  B {\n    int id\n  }\n${body}\n`;

  test('a relationship with no label shows `: ""` as the form for none', async () => {
    const found = await errors(E("  A ||--o{ B"));
    expect(located(found)).toEqual(["unsupported_construct@8:3"]);
    expect(found[0]?.message).toContain('`A ||--o{ B : ""`');
  });

  test("an attribute with a key but no type is named, as a bare name is", async () => {
    const found = await errors("erDiagram\n  A {\n    id PK\n  }\n");
    expect(located(found)).toEqual(["unsupported_construct@3:5"]);
    expect(found[0]?.message).toContain("no type");
    expect(found[0]?.message).toContain("`int id PK`");
  });
});
