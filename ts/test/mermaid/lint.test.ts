// Archer's reading rules (ADR 0030): an edge caption that would need a third
// line at the 14-character wrap hides its own line, and a writer may not
// introduce one. Existing findings stay warnings.
import { afterEach, describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/compile.ts";
import { captionLines, introducedBy, lint, LABEL_MAX_LINES } from "../../src/mermaid/lint.ts";
import { revisionOf } from "../../src/project/index.ts";
import {
  call,
  connect,
  refusal,
  removeSocketDirs,
  removeTempDirs,
  structured,
  tempDir,
  write,
} from "../mcp/support.ts";

afterEach(() => {
  removeSocketDirs();
  removeTempDirs();
});

describe("how many lines a caption takes", () => {
  test.each<[string, number]>([
    // At 24 characters a line (ADR 0030, amended 2026-11-12; was 14).
    ["Places order", 1],
    ["Reads and writes", 1],
    ["Charges the customer card", 2],
    ["Charges the customer card now and emails the receipt", 3],
    ["authentication-service-gateway", 2],
    ["https://orders.example.com/api/v2/refunds/pending/all", 3],
    ["one\ntwo\nthree", 3],
  ])("%j takes %i", (text, lines) => {
    expect(captionLines(text)).toBe(lines);
  });
});

describe("lint", () => {
  test("names an edge whose label needs more than two lines, and nothing else", async () => {
    const source =
      "flowchart LR\n  a[A] e1@-->|Reads and writes| b[B]\n  b e2@-->|Page and live events out to the browser, and every reply back| c[C]\n";
    const { model } = await compile(source);
    const found = lint(source, model!);
    expect(found.map((f) => [f.identity, f.diagnostic.severity, f.diagnostic.span.start.line])).toEqual([
      ["edge_label_too_long:e2", "warning", 3],
    ]);
    expect(found[0]!.diagnostic.message).toContain(`${LABEL_MAX_LINES} short lines`);
  });

  test("counts a C4 relationship's label, not its technology", async () => {
    const source =
      'C4Context\n  Person(a, "A")\n  System(b, "B")\n  Rel(a, b, "Uses", "HTTPS, JSON over a very long protocol name")\n';
    const { model } = await compile(source);
    expect(lint(source, model!)).toEqual([]);
  });

  test("leaves sequence messages alone: their text sits above the arrow", async () => {
    const source =
      "sequenceDiagram\n  participant A\n  participant B\n  A->>B: a message much longer than any caption could be on a graph\n";
    const { model } = await compile(source);
    expect(lint(source, model!)).toEqual([]);
  });

  test("a write introduces only what the file did not already have", async () => {
    const before = "flowchart LR\n  a[A] e1@-->|Page and live events out to the browser, and every reply back| b[B]\n";
    const moved =
      "flowchart LR\n  %% moved down a line\n  a[A] e1@-->|Page and live events out to the browser, and every reply back| b[B]\n";
    expect(await introducedBy(before, moved)).toEqual([]);
    const added = `${moved}  b e2@-->|Another very long label for the second edge, past two lines| a\n`;
    expect((await introducedBy(before, added)).map((d) => d.code)).toEqual(["edge_label_too_long"]);
    expect((await introducedBy(null, before)).map((d) => d.code)).toEqual(["edge_label_too_long"]);
    // Repairing a file that did not compile is not held against what it already said.
    const broken =
      "flowchart LR\n  a[A] e1@-->|Page and live events out to the browser, and every reply back| missing\n  missing2 --> a\n";
    expect(await introducedBy(broken, before)).toEqual([]);
    // ...but a new long caption in the repair still is.
    expect(
      (
        await introducedBy(
          broken,
          `${before}  b e2@-->|Another very long label for the second edge, past two lines| a\n`,
        )
      ).map((d) => d.code),
    ).toEqual(["edge_label_too_long"]);
  });
});

describe("the tools", () => {
  const LONG = "flowchart LR\n  a[A] e1@-->|Page and live events out to the browser, and every reply back| b[B]\n";
  const SHORT = "flowchart LR\n  a[A] e1@-->|Live events| b[B]\n";
  const MANIFEST =
    'version = 1\n[[views]]\nid = "arch"\nkind = "freeform"\ntitle = "Arch"\nsource = ".archer/arch.mmd"\n';

  test("write_diagram refuses a source that introduces a long label, with the fix, and writes nothing", async () => {
    const dir = tempDir({ "archer.toml": MANIFEST, ".archer/arch.mmd": SHORT });
    const { client, close } = await connect({ cwd: dir });
    try {
      const error = await refusal(client, "write_diagram", {
        viewId: "arch",
        source: LONG,
        expectedRevision: revisionOf(Buffer.from(SHORT)),
      });
      expect(error.data.code).toBe("invalid_source");
      expect(error.message).toContain("edge_label_too_long");
      expect(error.message).toContain("Nothing was written");
      const { readFileSync } = await import("node:fs");
      expect(readFileSync(`${dir}/.archer/arch.mmd`, "utf8")).toBe(SHORT);
    } finally {
      await close();
    }
  });

  test("write_diagram still writes a file that already had the long label", async () => {
    const dir = tempDir({ "archer.toml": MANIFEST, ".archer/arch.mmd": LONG });
    const { client, close } = await connect({ cwd: dir });
    try {
      const next = `${LONG}  b e2@-->|Short| a\n`;
      const written = structured(
        await call(client, "write_diagram", {
          viewId: "arch",
          source: next,
          expectedRevision: revisionOf(Buffer.from(LONG)),
        }),
      );
      expect(written["status"]).toBe("compiled");
    } finally {
      await close();
    }
  });

  test("validate_diagram reports a long label the write would introduce as the error write_diagram refuses", async () => {
    const dir = tempDir({ "archer.toml": MANIFEST, ".archer/arch.mmd": SHORT });
    const { client, close } = await connect({ cwd: dir });
    try {
      const checked = structured(await call(client, "validate_diagram", { viewId: "arch", source: LONG }));
      expect(checked["valid"]).toBe(false);
      expect((checked["diagnostics"] as { code: string; severity: string }[]).map((d) => [d.code, d.severity])).toEqual(
        [["edge_label_too_long", "error"]],
      );
    } finally {
      await close();
    }
  });
});
void write;
