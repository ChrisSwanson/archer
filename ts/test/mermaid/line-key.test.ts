// Line patterns and the Key (ADR 0030): a pattern only where it means
// something, its meaning in the author's words, and Mermaid kept to spec.
import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/compile.ts";
import { lint } from "../../src/mermaid/lint.ts";

const codes = async (source: string) => (await compile(source)).diagnostics.map((d) => [d.code, d.severity]);
const edgesOf = (model: unknown) => {
  const m = model as { edges?: unknown[]; relationships?: unknown[]; transitions?: unknown[] };
  return (m.edges ?? m.relationships ?? m.transitions ?? []) as { id: string; line?: string }[];
};

describe("a flowchart uses Mermaid's own syntax", () => {
  const DASHED =
    "flowchart LR\n  %% archer-key dashed: Person to system\n  a[A] e1@--> b[B]\n  b e2@--> a\n  classDef dashed stroke-dasharray: 6 4\n  class e1 dashed\n";

  test("`class e1 dashed` with the canonical classDef dashes the edge, and the key is the author's", async () => {
    const { model, diagnostics } = await compile(DASHED);
    expect(diagnostics).toEqual([]);
    expect(edgesOf(model).map((e) => [e.id, e.line])).toEqual([
      ["e1", "dashed"],
      ["e2", undefined],
    ]);
    expect((model as { lineKey?: unknown }).lineKey).toEqual([{ pattern: "dashed", meaning: "Person to system" }]);
    expect(lint(DASHED, model!)).toEqual([]);
  });

  test("a classDef whose dash differs from Archer's is refused, so plain Mermaid draws what Archer draws", async () => {
    expect(await codes(DASHED.replace("6 4", "0"))).toContainEqual(["line_class_mismatch", "error"]);
  });

  test("a pattern class on a `-.->` or `==>` edge is refused as a conflict", async () => {
    expect(await codes(DASHED.replace("a[A] e1@--> b[B]", "a[A] e1@==> b[B]"))).toContainEqual([
      "line_pattern_conflict",
      "error",
    ]);
  });

  test("any other class on an edge is reported, never dropped silently", async () => {
    const source = "flowchart LR\n  a[A] e1@--> b[B]\n  classDef hot fill:#f00\n  class e1 hot\n";
    expect(await codes(source)).toContainEqual(["edge_class_ignored", "info"]);
  });

  test("`archer-line` is refused in a flowchart, with the Mermaid spelling as the fix", async () => {
    const { diagnostics } = await compile("flowchart LR\n  %% archer-line dashed: e1\n  a[A] e1@--> b[B]\n");
    expect(diagnostics[0]).toMatchObject({ code: "line_directive_unsupported" });
    expect(diagnostics[0]!.message).toContain("class <edge ids> dashed");
  });

  test("a thick line is valid Mermaid and is explained through the key like any pattern", async () => {
    const source = "flowchart LR\n  %% archer-key thick: Main path\n  a[A] e1@==> b[B]\n  b e2@--> a\n";
    const { model } = await compile(source);
    expect(edgesOf(model).find((e) => e.id === "e1")?.line).toBe("thick");
    expect(lint(source, model!)).toEqual([]);
  });
});

describe("C4, architecture and state diagrams name their lines", () => {
  test.each([
    [
      "C4",
      'C4Context\n  %% archer-key dashed: Person to system\n  %% archer-line dashed: a--b\n  Person(a, "A")\n  System(b, "B")\n  System(c, "C")\n  Rel(a, b, "Uses")\n  Rel(b, c, "Calls")\n',
      "a--b",
    ],
    [
      "state",
      "stateDiagram-v2\n  %% archer-key dotted: Timer\n  %% archer-line dotted: Idle--Busy\n  state Idle\n  state Busy\n  [*] --> Idle\n  Idle --> Busy\n  Busy --> Idle\n",
      "Idle--Busy",
    ],
    [
      "architecture",
      "architecture-beta\n  %% archer-key dashed: Async\n  %% archer-line dashed: a--b\n  service a(server)[A]\n  service b(database)[B]\n  service c(disk)[C]\n  a:R --> L:b\n  b:R --> L:c\n",
      "a--b",
    ],
  ])("%s", async (_name, source, id) => {
    const { model, diagnostics } = await compile(source);
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const line = (model as { lineKey?: { pattern: string }[] }).lineKey?.[0]?.pattern;
    expect(edgesOf(model).find((e) => e.id === id)?.line).toBe(line);
    expect(edgesOf(model).filter((e) => e.line !== undefined)).toHaveLength(1);
  });

  test("an edge the diagram does not have is refused, with the nearest one", async () => {
    const { diagnostics } = await compile(
      'C4Context\n  %% archer-line dashed: a--x\n  Person(a, "A")\n  System(b, "B")\n  Rel(a, b, "Uses")\n',
    );
    expect(diagnostics[0]).toMatchObject({ code: "line_target_unknown" });
    expect(diagnostics[0]!.message).toContain("did you mean 'a--b'");
  });

  test.each([
    ["an unknown pattern", "%% archer-line wavy: a--b", "line_pattern_unknown"],
    ["no targets", "%% archer-line dashed:", "line_directive_malformed"],
    ["an empty target", "%% archer-line dashed: a--b, ", "line_directive_malformed"],
    ["a malformed key", "%% archer-key dashed", "line_directive_malformed"],
    ["a meaning of 5 words", "%% archer-key dashed: one two three four five", "line_meaning_text"],
  ])("refuses %s", async (_name, directive, code) => {
    const { diagnostics } = await compile(
      `C4Context\n  ${directive}\n  Person(a, "A")\n  System(b, "B")\n  Rel(a, b, "Uses")\n`,
    );
    expect(diagnostics.map((d) => d.code)).toContain(code);
  });

  test("a second key for one pattern is refused", async () => {
    const { diagnostics } = await compile(
      'C4Context\n  %% archer-key dashed: One\n  %% archer-key dashed: Two\n  Person(a, "A")\n  System(b, "B")\n  Rel(a, b, "Uses")\n',
    );
    expect(diagnostics.map((d) => d.code)).toContain("line_key_repeated");
  });
});

describe("notations that already give their dashes a meaning", () => {
  test.each([
    ["sequence", "sequenceDiagram\n  %% archer-key dashed: Async\n  participant A\n  participant B\n  A->>B: hi\n"],
    ["ER", "erDiagram\n  %% archer-line dashed: A--B\n  A ||--o{ B : has\n"],
  ])("%s refuses an author's pattern", async (_name, source) => {
    expect(await codes(source)).toContainEqual(["line_pattern_by_notation", "error"]);
  });
});

describe("the reading rules (warnings)", () => {
  const C4 = (directives: string, rels: string) =>
    `C4Context\n${directives}  Person(a, "A")\n  System(b, "B")\n  System(c, "C")\n${rels}`;
  const ids = async (source: string) => {
    const { model } = await compile(source);
    return lint(source, model!).map((f) => f.identity);
  };

  test("a pattern with no stated meaning", async () => {
    expect(await ids(C4("  %% archer-line dashed: a--b\n", '  Rel(a, b, "Uses")\n  Rel(b, c, "Calls")\n'))).toEqual([
      "line_meaning_missing:dashed:a--b",
    ]);
  });

  test("a key no line uses", async () => {
    expect(await ids(C4("  %% archer-key dotted: Async\n", '  Rel(a, b, "Uses")\n'))).toEqual([
      "line_key_unused:dotted",
    ]);
  });

  test("every line the same pattern distinguishes nothing", async () => {
    expect(
      await ids(
        C4(
          "  %% archer-key dashed: Async\n  %% archer-line dashed: a--b, b--c\n",
          '  Rel(a, b, "Uses")\n  Rel(b, c, "Calls")\n',
        ),
      ),
    ).toEqual(["line_pattern_everywhere:dashed"]);
  });

  test("dash-dot while dotted or dashed is free", async () => {
    expect(
      await ids(
        C4(
          "  %% archer-key dashdot: Batch\n  %% archer-line dashdot: a--b\n",
          '  Rel(a, b, "Uses")\n  Rel(b, c, "Calls")\n',
        ),
      ),
    ).toEqual(["line_pattern_last_resort:dashdot"]);
  });
});

describe("a pathological directive line (security review)", () => {
  test("a ~100k-character archer-key line is refused quickly, unread", async () => {
    const long = `flowchart LR\n  %% archer-key dashed: ${" ".repeat(100_000)}x\n  a[A] e1@--> b[B]\n`;
    const started = performance.now();
    const { diagnostics } = await compile(long);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(diagnostics.map((d) => d.code)).toContain("line_directive_malformed");
  });

  test("a meaning padded with spaces is still read, trimmed", async () => {
    const { model } = await compile(
      "flowchart LR\n  %% archer-key dotted:    Asynchronous    \n  a[A] e1@-.-> b[B]\n  b e2@--> a\n",
    );
    expect((model as { lineKey?: unknown }).lineKey).toEqual([{ pattern: "dotted", meaning: "Asynchronous" }]);
  });
});

describe("C7 review regressions", () => {
  test("a dotted class is refused: Mermaid's dotted line is -.->", async () => {
    expect(await codes("flowchart LR\n  a[A] e1@--> b[B]\n  class e1 dotted\n")).toContainEqual([
      "line_class_mismatch",
      "error",
    ]);
  });

  test("a near miss of archer-key is a typo, reported; other archer- words are left alone", async () => {
    expect(await codes("flowchart LR\n  %% archer-keey dashed: Async\n  a[A] e1@--> b[B]\n")).toContainEqual([
      "line_directive_unknown",
      "error",
    ]);
    expect(await codes("flowchart LR\n  %% archer-describe a: Something\n  a[A] e1@--> b[B]\n")).toEqual([]);
  });

  test("making one more edge dotted without a meaning is introduced, though another already was", async () => {
    const { introducedBy } = await import("../../src/mermaid/lint.ts");
    const before = "flowchart LR\n  a[A] e1@-.-> b[B]\n  b e2@--> c[C]\n  c e3@--> a\n";
    const after = before.replace("b e2@--> c[C]", "b e2@-.-> c[C]");
    expect((await introducedBy(before, after)).map((d) => d.code)).toEqual(["line_meaning_missing"]);
  });
});

describe("C8 review regressions", () => {
  test("a trailing ';' after a pattern class is refused, as the profile refuses statement ends", async () => {
    expect(
      await codes("flowchart LR\n  a[A] e1@--> b[B]\n  classDef dashed stroke-dasharray: 6 4\n  class e1 dashed;\n"),
    ).toContainEqual(["unsupported_construct", "error"]);
  });

  test.each(["archer-KEY", "archer-Line"])("%s is reported, not silently read or dropped", async (word) => {
    expect(await codes(`flowchart LR\n  %% ${word} dotted: Async\n  a[A] e1@-.-> b[B]\n`)).toContainEqual([
      "line_directive_unknown",
      "error",
    ]);
  });
});
