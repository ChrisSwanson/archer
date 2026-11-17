// Slice A: a note's mermaid fences, named with no setup, with their ranges.
import { describe, expect, it, test } from "vitest";
import {
  diagramAddress,
  MAX_NOTE_DIAGRAMS,
  noteDiagrams,
  parseDiagramAddress,
  relocateDiagram,
  replaceDiagramBody,
  slugOf,
} from "../../../shared/note-diagrams.mts";

const note = [
  "# Auth design", // 1
  "", // 2
  "## Login flow", // 3
  "", // 4
  "```mermaid", // 5
  "flowchart LR", // 6
  '  a["A"] e1@--> b["B"]', // 7
  "```", // 8
  "", // 9
  "```mermaid", // 10
  "flowchart LR", // 11
  '  c["C"]', // 12
  "```", // 13
  "", // 14
  "```ts", // 15
  "const x = 1;", // 16
  "```", // 17
  "", // 18
  "## Tokens", // 19
  "```mermaid", // 20
  "%% archer-id: refresh", // 21
  "sequenceDiagram", // 22
  "```", // 23
].join("\n");

describe("noteDiagrams", () => {
  it("finds only mermaid fences, names them from the nearest heading, and keeps an explicit id", () => {
    const { diagrams, problems } = noteDiagrams(note);
    expect(problems).toEqual([]);
    expect(diagrams.map((d) => [d.name, d.explicit, d.ordinal, d.heading])).toEqual([
      ["login-flow", false, 1, "Login flow"],
      ["login-flow-2", false, 2, "Login flow"],
      ["refresh", true, 3, "Tokens"],
    ]);
  });

  it("records where each fence and its body are, 1-based, and its body text", () => {
    const [first, , third] = noteDiagrams(note).diagrams;
    expect(first).toMatchObject({ fenceLine: 5, bodyLine: 6, bodyLineCount: 2, closed: true, writable: true });
    expect(first?.source).toBe('flowchart LR\n  a["A"] e1@--> b["B"]\n');
    expect(third).toMatchObject({ fenceLine: 20, bodyLine: 21, bodyLineCount: 2 });
  });

  it("names a fence under no heading by its position", () => {
    const { diagrams } = noteDiagrams("Intro\n\n```mermaid\nflowchart LR\n```\n\n```mermaid\nflowchart TB\n```\n");
    expect(diagrams.map((d) => d.name)).toEqual(["diagram-1", "diagram-2"]);
  });

  it("never lets a derived name take an explicit one, wherever the explicit one is", () => {
    const { diagrams } = noteDiagrams(
      "## Login flow\n```mermaid\nflowchart LR\n```\n```mermaid\n%% archer-id: login-flow\nflowchart LR\n```\n",
    );
    expect(diagrams.map((d) => d.name)).toEqual(["login-flow-2", "login-flow"]);
  });

  it("keeps a repeated explicit name on the first fence only, and says so", () => {
    const { diagrams, problems } = noteDiagrams(
      "```mermaid\n%% archer-id: x\nflowchart LR\n```\n```mermaid\n%% archer-id: x\nflowchart LR\n```\n",
    );
    expect(diagrams.map((d) => [d.name, d.explicit])).toEqual([
      ["x", true],
      ["diagram-2", false],
    ]);
    expect(problems).toEqual([expect.stringContaining('line 5: "x" already names the diagram at line 1')]);
  });

  it("refuses an archer-id that is not a stable ID and derives a name instead", () => {
    const { diagrams, problems } = noteDiagrams("```mermaid\n%% archer-id: no/slash\nflowchart LR\n```\n");
    expect(diagrams[0]).toMatchObject({ name: "diagram-1", explicit: false });
    expect(problems[0]).toContain("is not a diagram name");
  });

  it("reads a fence nested in a list or blockquote but does not offer it for writing", () => {
    const { diagrams } = noteDiagrams(
      "- item\n\n  ```mermaid\n  flowchart LR\n  ```\n\n> ```mermaid\n> flowchart TB\n> ```\n",
    );
    expect(diagrams.map((d) => [d.source, d.writable])).toEqual([
      ["flowchart LR\n", false],
      ["flowchart TB\n", false],
    ]);
  });

  it("does not offer an unclosed fence for writing", () => {
    const { diagrams } = noteDiagrams("```mermaid\nflowchart LR\n");
    expect(diagrams[0]).toMatchObject({ closed: false, writable: false });
  });

  it("accepts the tilde fence and an info string with more words", () => {
    const { diagrams } = noteDiagrams("~~~mermaid title\nflowchart LR\n~~~\n");
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0]?.writable).toBe(true);
  });

  it("never throws, and every name is a stable ID, on arbitrary and vocabulary-built input", () => {
    const vocabulary = [
      "```mermaid\n",
      "```\n",
      "~~~\n",
      "# H\n",
      "## Login flow\n",
      "%% archer-id: a\n",
      "> ",
      "- ",
      "  ",
      "flowchart LR\n",
      "\n",
      "`",
      "é",
      "\r\n",
    ];
    let seed = 7;
    const next = (n: number): number => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    for (let i = 0; i < 400; i++) {
      const text = Array.from({ length: next(40) }, () =>
        next(5) === 0 ? String.fromCharCode(next(0x2fff)) : vocabulary[next(vocabulary.length)],
      ).join("");
      const { diagrams } = noteDiagrams(text);
      const names = new Set<string>();
      for (const d of diagrams) {
        expect(d.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
        expect(names.has(d.name)).toBe(false);
        names.add(d.name);
      }
    }
  });
});

describe("slugOf", () => {
  it.each([
    ["Login flow", "login-flow"],
    ["  Café & Co.  ", "cafe-co"],
    ["C# / .NET", "c-net"],
    ["***", null],
    ["x".repeat(300), "x".repeat(100)],
  ])("%s -> %s", (heading, slug) => expect(slugOf(heading)).toBe(slug));
});

describe("addresses", () => {
  it("is the note path and the name", () => {
    expect(diagramAddress("notes/auth.md", "login-flow")).toBe("notes/auth.md#login-flow");
    expect(parseDiagramAddress("notes/auth.md#login-flow")).toEqual({ notePath: "notes/auth.md", name: "login-flow" });
  });

  it.each([
    "login-flow",
    "notes/auth.mmd#x",
    "notes/auth.md#",
    "notes/auth.md#a/b",
    "../x.md#a",
    "/x.md#a",
    "a\\b.md#x",
    "notes/auth.md",
  ])("refuses %s", (raw) => expect(parseDiagramAddress(raw)).toBeNull());
});

describe("replaceDiagramBody", () => {
  it("replaces only the body, pins the name, and keeps the prose and the line endings", () => {
    const crlf = note.replace(/\n/g, "\r\n");
    const target = noteDiagrams(crlf).diagrams[1]!;
    const next = replaceDiagramBody(crlf, target, 'flowchart LR\n  c["C2"]\n');
    expect(next.split("\r\n").slice(8, 15)).toEqual([
      "",
      "```mermaid",
      "%% archer-id: login-flow-2",
      "flowchart LR",
      '  c["C2"]',
      "```",
      "",
    ]);
    expect(next.includes("\n") && !/[^\r]\n/.test(next)).toBe(true);
    expect(noteDiagrams(next).diagrams[1]).toMatchObject({
      name: "login-flow-2",
      explicit: true,
      source: '%% archer-id: login-flow-2\nflowchart LR\n  c["C2"]\n',
    });
  });

  it("does not add the id line twice, and keeps the one the new source carries", () => {
    const target = noteDiagrams(note).diagrams[2]!;
    const next = replaceDiagramBody(note, target, "%% archer-id: refresh\nsequenceDiagram\n  participant a as A\n");
    expect(next.match(/archer-id/g)).toHaveLength(1);
    const again = replaceDiagramBody(note, target, "sequenceDiagram\n");
    expect(again.match(/archer-id: refresh/g)).toHaveLength(1);
  });

  it("pins a name with no other change", () => {
    const target = noteDiagrams(note).diagrams[0]!;
    const next = replaceDiagramBody(note, target, target.source);
    expect(next.split("\n").slice(4, 9)).toEqual([
      "```mermaid",
      "%% archer-id: login-flow",
      "flowchart LR",
      '  a["A"] e1@--> b["B"]',
      "```",
    ]);
  });

  it("refuses a fence it cannot write back", () => {
    const nested = "- item\n\n  ```mermaid\n  flowchart LR\n  ```\n";
    expect(() => replaceDiagramBody(nested, noteDiagrams(nested).diagrams[0]!, "flowchart TB\n")).toThrow(/nested/);
  });
});

// A note is untrusted input parsed on the service's event loop: none of these
// may take more than a moment, and none may offer more diagrams than the cap.
describe("adversarial notes", () => {
  const fast = (markdown: string): ReturnType<typeof noteDiagrams> => {
    const started = performance.now();
    const found = noteDiagrams(markdown);
    expect(performance.now() - started).toBeLessThan(500);
    return found;
  };

  test("many fences under one heading are named in well under a second, and capped", () => {
    const found = fast("# H\n" + "```mermaid\n```\n".repeat(20_000));
    expect(found.diagrams).toHaveLength(MAX_NOTE_DIAGRAMS);
    expect(found.diagrams.at(-1)?.name).toBe(`h-${MAX_NOTE_DIAGRAMS}`);
    expect(found.problems).toEqual([expect.stringContaining(`more than ${MAX_NOTE_DIAGRAMS} mermaid diagrams`)]);
  });

  test("explicit ids that pre-claim the suffixes are skipped in well under a second", () => {
    const claimed = Array.from({ length: 6_000 }, (_, i) => `\`\`\`mermaid\n%% archer-id: h-${i + 2}\n\`\`\`\n`).join(
      "",
    );
    fast("# H\n" + claimed + "```mermaid\n```\n".repeat(6_000));
  });

  test("a derived name skips a suffix claimed explicitly later in the note", () => {
    const { diagrams } = noteDiagrams("# H\n```mermaid\n```\n```mermaid\n```\n```mermaid\n%% archer-id: h-2\n```\n");
    expect(diagrams.map((d) => d.name)).toEqual(["h", "h-3", "h-2"]);
  });

  test("a long run of whitespace in the comment header is read in well under a second", () => {
    const found = fast("```mermaid\n%% archer-id: a" + " ".repeat(100_000) + "b \nflowchart LR\n```\n");
    expect(found.diagrams[0]).toMatchObject({ explicit: false, name: "diagram-1" });
  });

  test("a huge heading over many fences is slugged in well under a second", () => {
    const found = fast("# " + "a ".repeat(200_000) + "\n" + "```mermaid\n```\n".repeat(5_000));
    expect(found.diagrams[0]!.name.length).toBeLessThanOrEqual(100);
  });
});

// From a Codex review of the note tools: a replacement must stay inside its fence,
// and a splice keeps every byte outside the body, line endings included.
describe("replaceDiagramBody keeps the note's structure", () => {
  test("refuses a source with a line that would close its fence early", () => {
    const md = "# H\n\n```mermaid\nflowchart LR\n```\n\nProse after.\n";
    const target = noteDiagrams(md).diagrams[0]!;
    expect(() => replaceDiagramBody(md, target, "flowchart TB\n```\n# injected\n")).toThrow(/close its fence/);
    expect(() => replaceDiagramBody(md, target, "flowchart TB\n   ````\n")).toThrow(/close its fence/);
    // A shorter run, or one with words after it, does not close a ``` fence.
    expect(replaceDiagramBody(md, target, "flowchart TB\n%% `` not a fence\n")).toContain("%% `` not a fence");
    const tilde = "~~~~mermaid\nflowchart LR\n~~~~\n";
    expect(() => replaceDiagramBody(tilde, noteDiagrams(tilde).diagrams[0]!, "flowchart LR\n~~~~~\n")).toThrow(
      /close its fence/,
    );
    expect(replaceDiagramBody(tilde, noteDiagrams(tilde).diagrams[0]!, "flowchart LR\n~~~\n")).toContain(
      "\n~~~\n~~~~\n",
    );
  });

  test("keeps each untouched line's own ending in a note that mixes them", () => {
    const md = "# H\r\n\n```mermaid\r\nflowchart LR\r\n```\nProse.\r\n";
    const next = replaceDiagramBody(md, noteDiagrams(md).diagrams[0]!, "flowchart TB\n");
    expect(next).toBe("# H\r\n\n```mermaid\r\n%% archer-id: h\r\nflowchart TB\r\n```\nProse.\r\n");
  });
});

// A block nested in a list or blockquote, moved to the top level just below
// its container, when the agent may (relocateDiagram).
describe("relocateDiagram", () => {
  const listed =
    '# H\n\nBefore.\n\n- First item\n- With a diagram:\n\n  ```mermaid\n  flowchart LR\n    a["A"]\n  ```\n\n- Last item\n\nAfter the list.\n';

  test("knows a nested block's container and that it is closed", () => {
    const [d] = noteDiagrams(listed).diagrams;
    expect(d).toMatchObject({ writable: false, closed: true, fenceLine: 8, containerEndLine: 15 });
    const quoted = noteDiagrams("> Quote:\n>\n> ```mermaid\n> flowchart LR\n> ```\n\nAfter.\n").diagrams[0];
    expect(quoted).toMatchObject({ writable: false, closed: true, containerEndLine: 6 });
  });

  test("moves a list's block below the list, pinned, with the new source, and touches no other prose", () => {
    const d = noteDiagrams(listed).diagrams[0]!;
    const next = relocateDiagram(listed, d, 'flowchart LR\n  a["A"] e1@--> b["B"]\n');
    expect(next).toBe(
      '# H\n\nBefore.\n\n- First item\n- With a diagram:\n\n\n- Last item\n\n```mermaid\n%% archer-id: h\nflowchart LR\n  a["A"] e1@--> b["B"]\n```\n\nAfter the list.\n',
    );
    expect(noteDiagrams(next).diagrams[0]).toMatchObject({ name: "h", explicit: true, writable: true });
  });

  test("moves a blockquote's block below the quote", () => {
    const quoted = "> Quote:\n>\n> ```mermaid\n> flowchart LR\n> ```\n\nAfter.\n";
    const next = relocateDiagram(quoted, noteDiagrams(quoted).diagrams[0]!, "flowchart LR\n");
    expect(next).toBe("> Quote:\n>\n\n```mermaid\n%% archer-id: diagram-1\nflowchart LR\n```\n\nAfter.\n");
  });

  test("refuses a block at the top level, and an unclosed one", () => {
    const top = "```mermaid\nflowchart LR\n```\n";
    expect(() => relocateDiagram(top, noteDiagrams(top).diagrams[0]!, "flowchart LR\n")).toThrow(
      /already at the top level/,
    );
    const open = "- item\n\n  ```mermaid\n  flowchart LR\n";
    expect(() => relocateDiagram(open, noteDiagrams(open).diagrams[0]!, "flowchart LR\n")).toThrow(/closing fence/);
  });
});
