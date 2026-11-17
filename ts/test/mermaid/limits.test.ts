// Rust 0.3.0's input bounds hold with the same numbers and codes (ticket 06):
// 256 KiB of source, 512-character labels, 24 levels of nesting, 128-character
// IDs. Each is tested at the bound and one past it.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import {
  MAX_LABEL_CHARS,
  MAX_LINE_CHARS,
  MAX_NESTING_DEPTH,
  MAX_SCANNED_DEPTH,
  MAX_SOURCE_BYTES,
} from "../../src/mermaid/limits.ts";
import { errorsOf, located } from "./support/compile-helpers.ts";

test("the bounds are Rust's numbers", () => {
  expect([MAX_SOURCE_BYTES, MAX_LABEL_CHARS, MAX_NESTING_DEPTH]).toEqual([262_144, 512, 24]);
});

describe("source size", () => {
  const head = "flowchart LR\n  a[A]\n";
  /** A valid flowchart padded with one comment line to exactly `bytes` bytes of UTF-8. */
  const ofBytes = (bytes: number, fill = "x") => {
    const room = bytes - Buffer.byteLength(head + "%% \n");
    const unit = Buffer.byteLength(fill);
    return `${head}%% ${fill.repeat(Math.floor(room / unit))}${"y".repeat(room % unit)}\n`;
  };

  test("a source of exactly 256 KiB is read", async () => {
    const source = ofBytes(MAX_SOURCE_BYTES);
    expect(Buffer.byteLength(source)).toBe(MAX_SOURCE_BYTES);
    const result = await compile(source);
    expect(result.diagnostics).toEqual([]);
    expect(result.model).not.toBeNull();
  });

  test("one byte more is refused unread, as the only problem, at the first line", async () => {
    const source = ofBytes(MAX_SOURCE_BYTES - 2).replace("a[A]", "a --> b");
    expect(Buffer.byteLength(source)).toBe(MAX_SOURCE_BYTES + 1);
    const result = await compile(source);
    expect(result.model).toBeNull();
    expect(located(result.diagnostics)).toEqual(["source_too_large@1:1"]);
    expect(result.diagnostics[0]?.message).toContain(`${MAX_SOURCE_BYTES + 1} bytes`);
  });

  test("the bound counts UTF-8 bytes, not characters", async () => {
    const source = ofBytes(MAX_SOURCE_BYTES + 2, "é");
    expect(source.length).toBeLessThan(MAX_SOURCE_BYTES);
    const result = await compile(source);
    expect(located(result.diagnostics)).toEqual(["source_too_large@1:1"]);
  });

  test("a caller measuring the compiler may lift the bound", async () => {
    const result = await compile(ofBytes(MAX_SOURCE_BYTES + 10), { maxSourceBytes: MAX_SOURCE_BYTES * 2 });
    expect(result.diagnostics).toEqual([]);
  });
});

describe("label length", () => {
  const PLACES: { kind: string; source: (label: string) => string; at: string }[] = [
    { kind: "node label", source: (label) => `flowchart LR\n  a[${label}]\n`, at: "2:3" },
    { kind: "edge label", source: (label) => `flowchart LR\n  a[A]\n  b[B]\n  a e1@-->|${label}| b\n`, at: "4:5" },
    {
      kind: "subgraph label",
      source: (label) => `flowchart LR\n  a[A]\n  subgraph g[${label}]\n    a\n  end\n`,
      at: "3:12",
    },
    { kind: "participant alias", source: (label) => `sequenceDiagram\n  participant a as ${label}\n`, at: "2:20" },
    {
      kind: "message text",
      source: (label) => `sequenceDiagram\n  participant a as A\n  a->>a: ${label}\n`,
      at: "3:10",
    },
    {
      kind: "note text",
      source: (label) => `sequenceDiagram\n  participant a as A\n  Note over a: ${label}\n`,
      at: "3:16",
    },
    {
      kind: "fragment label",
      source: (label) => `sequenceDiagram\n  participant a as A\n  opt ${label}\n    a->>a: x\n  end\n`,
      at: "3:7",
    },
  ];

  describe.each(PLACES)("$kind", ({ source, at }) => {
    test("512 characters fit", async () => {
      const result = await compile(source("w".repeat(MAX_LABEL_CHARS)));
      expect(errorsOf(result.diagnostics)).toEqual([]);
    });

    test("512 characters of a script outside ASCII fit", async () => {
      const result = await compile(source("日".repeat(MAX_LABEL_CHARS)));
      expect(errorsOf(result.diagnostics)).toEqual([]);
    });

    test("513 characters are refused at the label", async () => {
      const result = await compile(source("w".repeat(MAX_LABEL_CHARS + 1)));
      expect(result.model).toBeNull();
      expect(located(errorsOf(result.diagnostics))).toEqual([`label_too_long@${at}`]);
      expect(result.diagnostics[0]?.message).toContain("513 characters");
    });
  });
});

describe("nesting", () => {
  const subgraphs = (depth: number) => {
    const open = Array.from({ length: depth }, (_, level) => `${"  ".repeat(level + 1)}subgraph g${level}[G${level}]`);
    const close = Array.from({ length: depth }, (_, level) => `${"  ".repeat(depth - level)}end`);
    return ["flowchart LR", "  a[A]", ...open, `${"  ".repeat(depth + 1)}a`, ...close, "  a e1@--> b"].join("\n");
  };
  const fragments = (depth: number) => {
    const open = Array.from({ length: depth }, (_, level) => `${"  ".repeat(level + 1)}loop l${level}`);
    const close = Array.from({ length: depth }, (_, level) => `${"  ".repeat(depth - level)}end`);
    return [
      "sequenceDiagram",
      "  participant a as A",
      ...open,
      `${"  ".repeat(depth + 1)}a->>a: x`,
      ...close,
      "  a->>z: undeclared",
    ].join("\n");
  };

  test("24 levels of subgraphs are read", async () => {
    const result = await compile(subgraphs(MAX_NESTING_DEPTH).replace("  a e1@--> b", ""));
    expect(errorsOf(result.diagnostics)).toEqual([]);
    expect(result.model).toMatchObject({
      groups: expect.arrayContaining([{ id: "g23", label: "G23", parentId: "g22" }]),
    });
  });

  test("a 25th is refused at its keyword, and nothing after it is checked", async () => {
    const result = await compile(subgraphs(MAX_NESTING_DEPTH + 1));
    expect(result.model).toBeNull();
    expect(located(result.diagnostics)).toEqual(["subgraph_nesting_too_deep@27:51"]);
  });

  const groups = (depth: number) =>
    [
      "architecture-beta",
      ...Array.from(
        { length: depth },
        (_, level) => `    group g${level}(cloud)[G${level}]${level === 0 ? "" : ` in g${level - 1}`}`,
      ),
      `    service a(server)[A] in g${depth - 1}`,
      "    service b(server)[B]",
      "    a:R --> L:b",
    ].join("\n");

  test("24 levels of architecture groups are read", async () => {
    const result = await compile(groups(MAX_NESTING_DEPTH));
    expect(errorsOf(result.diagnostics)).toEqual([]);
    expect(result.model).toMatchObject({
      groups: expect.arrayContaining([{ id: "g23", label: "G23", icon: "cloud", parentId: "g22" }]),
    });
  });

  test("a 25th architecture group is refused at its statement", async () => {
    const result = await compile(groups(MAX_NESTING_DEPTH + 1));
    expect(result.model).toBeNull();
    expect(errorsOf(result.diagnostics).map((d) => [d.code, d.span.start.line])).toEqual([["nesting_too_deep", 26]]);
  });

  test("24 levels of fragments are read", async () => {
    const result = await compile(fragments(MAX_NESTING_DEPTH).replace("  a->>z: undeclared", ""));
    expect(errorsOf(result.diagnostics)).toEqual([]);
  });

  test("a 25th fragment is refused at its keyword, and nothing after it is checked", async () => {
    const result = await compile(fragments(MAX_NESTING_DEPTH + 1));
    expect(result.model).toBeNull();
    expect(located(result.diagnostics)).toEqual(["fragment_nesting_too_deep@27:51"]);
  });
});

describe("ID length", () => {
  const PLACES: { kind: string; source: (id: string) => string; at: string }[] = [
    { kind: "node", source: (id) => `flowchart LR\n  ${id}[A]\n`, at: "2:3" },
    { kind: "edge", source: (id) => `flowchart LR\n  a[A]\n  b[B]\n  a ${id}@--> b\n`, at: "4:5" },
    { kind: "subgraph", source: (id) => `flowchart LR\n  a[A]\n  subgraph ${id}[G]\n    a\n  end\n`, at: "3:12" },
    {
      kind: "participant",
      source: (id) => `sequenceDiagram\n  participant ${id} as A\n  ${id}->>${id}: x\n`,
      at: "2:15",
    },
  ];

  describe.each(PLACES)("$kind", ({ source, at }) => {
    test("128 characters fit", async () => {
      const result = await compile(source("i".repeat(128)));
      expect(errorsOf(result.diagnostics)).toEqual([]);
    });

    test("129 are refused at the ID", async () => {
      const result = await compile(source("i".repeat(129)));
      expect(located(errorsOf(result.diagnostics))).toEqual([`invalid_id@${at}`]);
    });
  });
});

// Server review S1: Mermaid's parsers are superlinear on some long lines (200 000 commas in one
// C4 call took minutes) and on deep nesting, so these bounds are checked before Mermaid reads
// the source. Real diagrams stay far below them (the repo's longest line is 210 characters).
describe("bounds checked before Mermaid parses", () => {
  test("a statement line of 4096 characters is read", async () => {
    const source = `flowchart LR\n  a[A]\n  b[B]\n  a e1@--> b\n  linkStyle 0 stroke:#000${" ".repeat(MAX_LINE_CHARS - 25)}\n`;
    expect(source.split("\n")[4]).toHaveLength(MAX_LINE_CHARS);
    const result = await compile(source);
    expect(result.diagnostics.map((d) => d.code)).not.toContain("line_too_long");
  });

  test("one character more is refused, as the only problem, before Mermaid reads it", async () => {
    const source = `flowchart LR\n  a[A]\n  ${"a & ".repeat(MAX_LINE_CHARS / 4 - 1)}bbb\n`;
    expect(source.split("\n")[2]).toHaveLength(MAX_LINE_CHARS + 1);
    const result = await compile(source);
    expect(result.model).toBeNull();
    expect(located(result.diagnostics)).toEqual(["line_too_long@3:1"]);
    expect(result.diagnostics[0]?.message).toContain(`${MAX_LINE_CHARS + 1} characters`);
  });

  test("a comment line is not bounded: Mermaid never reads it", async () => {
    const result = await compile(`flowchart LR\n  a[A]\n  %% ${"x".repeat(MAX_LINE_CHARS * 4)}\n`);
    expect(result.diagnostics).toEqual([]);
  });

  test("blocks nested far past the bound are refused at the first one past the pre-check, before Mermaid reads them", async () => {
    // Duplicate IDs keep the scan from counting these subgraphs, so only the pre-check refuses them.
    const result = await compile(
      `flowchart LR\n${"subgraph s\n".repeat(MAX_SCANNED_DEPTH + 1)}  x\n${"end\n".repeat(MAX_SCANNED_DEPTH + 1)}`,
    );
    expect(located(result.diagnostics)).toEqual([`subgraph_nesting_too_deep@${MAX_SCANNED_DEPTH + 2}:1`]);
  });

  test("blocks opened several to a line are each counted", async () => {
    const deep = MAX_SCANNED_DEPTH * 2;
    const inputs = [
      // Flowchart and sequence statements joined with `;`, and braces several to a line, quoted text skipped.
      `flowchart LR\n${Array.from({ length: deep }, (_, i) => `subgraph s${i}`).join(";")}\n  x\n${"end\n".repeat(deep)}`,
      `sequenceDiagram\n${Array.from({ length: deep }, () => "loop l").join(";")}\n  a->>b: x\n${"end\n".repeat(deep)}`,
      `stateDiagram-v2\n${Array.from({ length: deep }, (_, i) => `state s${i} {`).join(" ")}\n  b\n${"}\n".repeat(deep)}`,
      `C4Context\n${Array.from({ length: deep }, (_, i) => `Boundary(b${i}, "B") {`).join(" ")}\n${"}\n".repeat(deep)}`,
    ];
    for (const source of inputs) {
      const started = performance.now();
      const result = await compile(source);
      expect(result.model).toBeNull();
      expect(result.diagnostics.map((d) => d.code)).toEqual([expect.stringMatching(/nesting_too_deep$/)]);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });

  test("entity codes are not statement separators (Codex review: `#59;loop` in a label)", async () => {
    const result = await compile(
      `sequenceDiagram\n  participant a\n  a->>a: x${"#59;loop x".repeat(MAX_SCANNED_DEPTH + 1)}\n`,
    );
    expect(result.diagnostics.map((d) => d.code)).not.toContain("fragment_nesting_too_deep");
  });

  test("the pre-check reads entity codes as Mermaid does: `subgraph a#b_c;subgraph …` is one statement to both", async () => {
    // Mermaid encodes every #\w+; before it parses, so these `;` separate nothing for its parser either.
    const line = Array.from({ length: MAX_SCANNED_DEPTH * 2 }, (_, i) => `subgraph s${i}#b_${i};`).join("");
    const started = performance.now();
    const result = await compile(`flowchart LR\n${line}\n  x\nend\n`);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(result.diagnostics.map((d) => d.code)).not.toContain("subgraph_nesting_too_deep");
    // Without the entity codes the same line nests, and is refused before Mermaid.
    const nested = await compile(
      `flowchart LR\n${line.replaceAll(/#b_\d+/g, "")}\n  x\n${"end\n".repeat(MAX_SCANNED_DEPTH * 2)}`,
    );
    expect(nested.diagnostics.map((d) => d.code)).toEqual(["subgraph_nesting_too_deep"]);
  });

  test("an entity code with an underscore is one too, as Mermaid's #\\w+; reads it", async () => {
    const result = await compile(
      `sequenceDiagram\n  participant a\n  a->>a: x${"#a_b;loop x".repeat(MAX_SCANNED_DEPTH + 1)}\n`,
    );
    expect(result.diagnostics.map((d) => d.code)).not.toContain("fragment_nesting_too_deep");
  });

  test("braces inside quoted text are not blocks", async () => {
    const result = await compile(`stateDiagram-v2\n  a : "${"{".repeat(MAX_SCANNED_DEPTH * 2)}"\n`);
    expect(result.diagnostics.map((d) => d.code)).not.toContain("nesting_too_deep");
  });

  test("the inputs that stalled the service are refused in well under a second", async () => {
    const inputs = [
      `C4Context\n  Person(a${",".repeat(200_000)})\n`,
      `flowchart LR\n  ${Array.from({ length: 3000 }, (_, i) => `k${i}`).join(" --> ")}\n`,
      `flowchart LR\n  a-->b\n  style a ${Array.from({ length: 4000 }, () => "fill:#fff").join(",")}\n`,
      `flowchart LR\n${"subgraph s\n".repeat(5000)}  x\n${"end\n".repeat(5000)}`,
      `stateDiagram-v2\n${"state a {\n".repeat(2000)}  b\n${"}\n".repeat(2000)}`,
      `sequenceDiagram\n${"loop l\n".repeat(5000)}  a->>b: x\n${"end\n".repeat(5000)}`,
    ];
    for (const source of inputs) {
      const started = performance.now();
      const result = await compile(source);
      expect(result.model).toBeNull();
      expect(performance.now() - started, result.diagnostics[0]?.code).toBeLessThan(1500);
    }
  });
});
