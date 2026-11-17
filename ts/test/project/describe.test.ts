// What a diagram or note is about (ts/src/project/describe.ts): declared
// first, then derived from the text, and bounded whatever the file holds.
import { describe, expect, test } from "vitest";
import {
  clip,
  DESCRIPTION_CHARS,
  diagramDescription,
  MAX_DESCRIPTION_CHARS,
  noteDescription,
} from "../../src/project/describe.ts";

describe("diagramDescription", () => {
  test.each([
    [
      "a `%% description:` line before the header",
      "%% description: How a request reaches the database.\nflowchart LR\n  a[A]\n",
      { description: "How a request reaches the database.", descriptionFrom: "comment" },
    ],
    [
      "the declared line wins over other comments, wherever it is among them",
      "%% Owned by the platform team\n%% Description: The checkout path\nflowchart LR\n",
      { description: "The checkout path", descriptionFrom: "comment" },
    ],
    [
      "other leading comments, joined, when nothing is declared",
      "%% The sign-in flow,\n%%   from the browser's side\nsequenceDiagram\n",
      { description: "The sign-in flow, from the browser's side", descriptionFrom: "derived" },
    ],
    [
      "an init directive is not prose",
      '%%{init: {"theme": "dark"}}%%\n%% Data model\nerDiagram\n',
      { description: "Data model", descriptionFrom: "derived" },
    ],
    [
      "Archer's own `%% archer-id:` line is not prose",
      "%% archer-id: login-flow\n%% How a session starts\nsequenceDiagram\n",
      { description: "How a session starts", descriptionFrom: "derived" },
    ],
    [
      "blank lines before the header are passed over",
      "\n\n%% Context\n\nflowchart LR\n",
      { description: "Context", descriptionFrom: "derived" },
    ],
  ])("%s", (_, source, expected) => {
    expect(diagramDescription(source)).toEqual(expected);
  });

  test.each([
    ["no comments at all", "flowchart LR\n  a[A]\n"],
    [
      "a comment after the header is the diagram's, not a description",
      "flowchart LR\n  %% description: not this\n  a[A]\n",
    ],
    ["an empty declared line and nothing else", "%% description:\nflowchart LR\n"],
    ["only an embedded diagram's name", "%% archer-id: envelope\nflowchart LR\n"],
    ["an empty file", ""],
  ])("none: %s", (_, source) => {
    expect(diagramDescription(source)).toBeNull();
  });

  test("a derived description is cut at a word near DESCRIPTION_CHARS; a declared one only at the maximum", () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const derived = diagramDescription(`%% ${words}\nflowchart LR\n`)!;
    expect([...derived.description].length).toBeLessThanOrEqual(DESCRIPTION_CHARS);
    expect(derived.description).toMatch(/word\d+…$/);
    const declared = diagramDescription(`%% description: ${words}\nflowchart LR\n`)!;
    expect([...declared.description].length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    expect([...declared.description].length).toBeGreaterThan(DESCRIPTION_CHARS);
  });
});

describe("noteDescription", () => {
  test.each([
    [
      "`description:` front matter",
      "---\ndescription: Why tokens rotate\ndiagrams: [auth.mmd]\n---\n# Auth\n\nLong prose.\n",
      { description: "Why tokens rotate", descriptionFrom: "frontmatter" },
    ],
    [
      "quoted front matter keeps its colon",
      '---\ndescription: "Auth: why tokens rotate"\n---\nBody.\n',
      { description: "Auth: why tokens rotate", descriptionFrom: "frontmatter" },
    ],
    [
      "the first paragraph after the title",
      "# Auth\n\nTokens are short-lived\nand rotated hourly.\n\nSecond paragraph.\n",
      { description: "Tokens are short-lived and rotated hourly.", descriptionFrom: "derived" },
    ],
    [
      "inline marks are dropped, link text kept, snake_case kept",
      "# T\n\nSee **the** [flow](flow.mmd) and `make_token` in _this_ file.\n",
      { description: "See the flow and make_token in this file.", descriptionFrom: "derived" },
    ],
    [
      "fences, tables, rules and HTML are not prose",
      "# T\n\n```mermaid\nflowchart LR\n```\n\n| a | b |\n---\n<div>x</div>\n\nThe prose.\n",
      { description: "The prose.", descriptionFrom: "derived" },
    ],
    [
      "a complete HTML block is skipped",
      "<div>\nHTML-only content.\n</div>\n\nReal prose.",
      { description: "Real prose.", descriptionFrom: "derived" },
    ],
    [
      "a four-backtick fence contains triple backticks",
      "````text\n```\nCode-only content.\n````\n\nReal prose.",
      { description: "Real prose.", descriptionFrom: "derived" },
    ],
    [
      "a table needs no leading pipe",
      "Name | Value\n--- | ---\nA | B\n\nReal prose.",
      { description: "Real prose.", descriptionFrom: "derived" },
    ],
    [
      "reference links retain only visible text",
      "See [the flow][flow] here.\n\n[flow]: flow.mmd",
      { description: "See the flow here.", descriptionFrom: "derived" },
    ],
    [
      "a list item is prose",
      "# Steps\n\n- Build the page first\n",
      { description: "Build the page first", descriptionFrom: "derived" },
    ],
  ])("%s", (_, text, expected) => {
    expect(noteDescription(text)).toEqual(expected);
  });

  test.each([
    ["only a heading", "# Title\n"],
    ["only a diagram", "```mermaid\nflowchart LR\n  a[A]\n```\n"],
    ["empty", ""],
  ])("none: %s", (_, text) => {
    expect(noteDescription(text)).toBeNull();
  });
});

describe("clip", () => {
  test("short text is only flattened; long text is cut at a word with an ellipsis", () => {
    expect(clip("  a\n b  ", 10)).toBe("a b");
    expect(clip("alpha beta gamma delta", 12)).toBe("alpha beta…");
  });

  test("a single long word is cut inside it rather than dropped", () => {
    expect(clip("x".repeat(50), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("bounded on hostile input", () => {
  test("a megabyte of brackets, marks and comment lines answers quickly and within the limits", () => {
    const hostile = "[".repeat(200_000) + "](".repeat(200_000) + "*_`".repeat(100_000);
    const started = performance.now();
    const note = noteDescription(`# T\n\n${hostile}\n`);
    const diagram = diagramDescription(`${"%% x\n".repeat(100_000)}flowchart LR\n`);
    expect(performance.now() - started).toBeLessThan(2000);
    expect([...(note?.description ?? "")].length).toBeLessThanOrEqual(DESCRIPTION_CHARS);
    expect([...(diagram?.description ?? "")].length).toBeLessThanOrEqual(DESCRIPTION_CHARS);
  });
});

test("Markdown descriptions never throw on arbitrary, vocabulary and lightly edited input on a small stack", async () => {
  const { build } = await import("esbuild");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const scratch = mkdtempSync(join(tmpdir(), "archer-description-property-"));
  const output = join(scratch, "description.cjs");
  try {
    await build({
      stdin: {
        contents: `
        import { noteDescription, projectDescription, DESCRIPTION_CHARS, MAX_DESCRIPTION_CHARS } from ${JSON.stringify(resolve("src/project/describe.ts"))};
        let state = 13;
        const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
        const words = ["\\n", "\\n\\n", "# Title", "## Overview", "<div>", "</div>", "**", "_", "[text][ref]", "[ref]: flow.mmd", "\\n--- | ---\\n", "|", "~~~", "\\n\\x60\\x60\\x60\\x60\\n", "> ", "- ", "Real prose."];
        const check = (source) => {
          const description = noteDescription(source);
          if (description !== null && (description.descriptionFrom !== "derived" || [...description.description].length > DESCRIPTION_CHARS)) throw new Error("invalid description");
        };
        const checkProject = (source) => {
          const description = projectDescription(source);
          if (description !== undefined && (typeof description !== "string" || [...description].length > MAX_DESCRIPTION_CHARS)) throw new Error("invalid project description");
        };
        for (let round = 0; round < 150; round++) {
          const arbitrary = Array.from({ length: next() % 300 }, () => String.fromCharCode(next() % 65536)).join("");
          check(arbitrary); checkProject(arbitrary);
          const vocabulary = Array.from({ length: next() % 60 }, () => words[next() % words.length]).join("");
          check(vocabulary); checkProject(vocabulary);
          const valid = "# Title\\n\\nSee **the flow** here.\\n\\n[ref]: flow.mmd";
          const at = next() % valid.length;
          const edited = valid.slice(0, at) + words[next() % words.length] + valid.slice(at + next() % 4);
          check(edited); checkProject(edited);
        }
        console.log("descriptions valid");
      `,
        resolveDir: process.cwd(),
        sourcefile: "description-property.ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: output,
      logLevel: "silent",
    });
    expect(
      execFileSync(process.execPath, ["--stack_size=128", output], { encoding: "utf8", timeout: 10_000 }),
    ).toContain("descriptions valid");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 30_000);
