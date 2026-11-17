// Slice A on the service side: a note's embedded diagrams under note-scoped
// addresses, compiled by the production compiler, with positions in the note.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { compileEmbedded, embeddedDiagrams, readEmbedded } from "../../src/notes/embedded.ts";
import { findProject } from "../../src/project/index.ts";
import { loadFixtures } from "../mermaid/support/fixtures.ts";
import { removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

const fixtures = fileURLToPath(new URL("../../../fixtures/", import.meta.url));
const AUTH = readFileSync(join(fixtures, "notes/auth.md"), "utf8");
const GOLDEN = JSON.parse(readFileSync(join(fixtures, "notes/auth.diagrams.json"), "utf8")) as {
  diagrams: Record<string, unknown>[];
  problems: string[];
};

const projectWith = (files: Record<string, string>) => findProject(tempDir(files));

describe("embeddedDiagrams", () => {
  test("lists the golden note's diagrams with addresses, kinds and lines of the note file", () => {
    const project = projectWith({ ".archer/notes/auth.md": AUTH });
    const listed = embeddedDiagrams(project, "notes/auth.md");
    expect(listed.problems).toEqual(GOLDEN.problems);
    expect(listed.diagrams.map(({ sourceRevision: _r, ...rest }) => rest)).toEqual(GOLDEN.diagrams);
    for (const d of listed.diagrams) expect(d.sourceRevision).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("a diagram's revision is its body's, so an edit to the prose leaves it alone", () => {
    const before = embeddedDiagrams(projectWith({ ".archer/notes/auth.md": AUTH }), "notes/auth.md").diagrams;
    const edited = AUTH.replace(
      "The login path keeps the token server-side.",
      "The login path keeps the token server-side, always.\n\nMore prose.",
    );
    const after = embeddedDiagrams(projectWith({ ".archer/notes/auth.md": edited }), "notes/auth.md").diagrams;
    expect(after.map((d) => d.sourceRevision)).toEqual(before.map((d) => d.sourceRevision));
    expect(after[0]!.line).toBe(before[0]!.line + 2);
  });

  test("a note that is not there, or not a note, has no diagrams", () => {
    const project = projectWith({ ".archer/flow.mmd": "flowchart LR\n" });
    expect(embeddedDiagrams(project, "nope.md").diagrams).toEqual([]);
    expect(embeddedDiagrams(project, "flow.mmd").diagrams).toEqual([]);
  });
});

describe("compileEmbedded", () => {
  test("compiles every ported golden fixture, embedded in a note, to its golden model", async () => {
    const fixtures = loadFixtures();
    const note = [
      "# Every fixture",
      ...fixtures.map(
        (f) => `\n\`\`\`mermaid\n%% archer-id: ${f.name.replace("/", "-")}\n${f.source.replace(/\n?$/, "\n")}\`\`\``,
      ),
    ].join("\n");
    const project = projectWith({ ".archer/all.md": note });
    expect(fixtures.length).toBe(21);
    for (const fixture of fixtures) {
      const read = readEmbedded(project, `all.md#${fixture.name.replace("/", "-")}`);
      expect(read, fixture.name).not.toBeNull();
      const compiled = await compileEmbedded(read!);
      expect(compiled.envelope?.model, fixture.name).toEqual(fixture.expected);
    }
  }, 120_000);

  test("names the view by its address and reports problems at lines of the note", async () => {
    const project = projectWith({ ".archer/notes/auth.md": AUTH });
    const ok = await compileEmbedded(readEmbedded(project, "notes/auth.md#login-flow")!);
    expect(ok.envelope?.view).toMatchObject({ id: "notes/auth.md#login-flow", title: "Login flow" });
    const broken = await compileEmbedded(readEmbedded(project, "notes/auth.md#broken")!);
    expect(broken.envelope).toBeNull();
    expect(broken.diagnostics.length).toBeGreaterThan(0);
    // `a[A] --> b[B]` is line 45 of the note file (front matter included).
    expect(broken.diagnostics.map((d) => d.span.start.line)).toContain(45);
  });

  test("an address that names no diagram reads as null", () => {
    const project = projectWith({ ".archer/notes/auth.md": AUTH });
    expect(readEmbedded(project, "notes/auth.md#nope")).toBeNull();
    expect(readEmbedded(project, "notes/missing.md#login-flow")).toBeNull();
    expect(readEmbedded(project, "../outside.md#x")).toBeNull();
  });
});

test("list_diagrams lists the embedded diagrams under their addresses", async () => {
  const { createApplication } = await import("../../src/application/index.ts");
  const app = createApplication({
    cwd: tempDir({ ".archer/notes/auth.md": AUTH, ".archer/flow.mmd": "flowchart LR\n  a[A]\n" }),
  });
  try {
    const answer = await app.call("list_diagrams", {});
    expect(answer.structured["embedded"]).toEqual(
      GOLDEN.diagrams.map((d) => ({
        address: d["address"],
        note: "notes/auth.md",
        name: d["name"],
        kind: d["kind"],
        line: d["line"],
        writable: d["writable"],
      })),
    );
    expect(answer.text).toContain("5 diagram(s) embedded in notes");
  } finally {
    app.close();
  }
});

test("a FIFO named like a note is never read: the service is not blocked", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = tempDir({ ".archer/notes/real.md": "# Real\n" });
  execFileSync("mkfifo", [join(root, ".archer/notes/hang.md")]);
  const project = findProject(root);
  const started = performance.now();
  expect(readEmbedded(project, "notes/hang.md#a")).toBeNull();
  expect(embeddedDiagrams(project, "notes/hang.md").diagrams).toEqual([]);
  const { FreshnessCache } = await import("../../src/notes/freshness.ts");
  expect(await new FreshnessCache(project).of("notes/hang.md")).toEqual({
    status: "unavailable",
    reason: "note_not_found",
  });
  expect(performance.now() - started).toBeLessThan(2000);
}, 10_000);

describe("pinEmbedded", () => {
  test("pins only the block the caller saw, by its revision", async () => {
    const { pinEmbedded } = await import("../../src/notes/embedded.ts");
    const note = '# Login\n\n```mermaid\nflowchart LR\n  a["A"]\n```\n';
    const root = tempDir({ ".archer/n.md": note });
    const project = findProject(root);
    const seen = readEmbedded(project, "n.md#login")!.sourceRevision;
    // Another block now takes the name before the page saw it.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(root, ".archer/n.md"), note.replace("# Login\n", "# Login\n\n```mermaid\nflowchart TB\n```\n"));
    expect(pinEmbedded(project, "n.md#login", seen)).toBe("stale");
    expect(readFileSync(join(root, ".archer/n.md"), "utf8")).not.toContain("archer-id");
  });

  test("inserts only the id line, ending as the body's first line does, so the compiled revision holds", async () => {
    const { pinEmbedded } = await import("../../src/notes/embedded.ts");
    const note = '# Login\r\n\r\n```mermaid\r\nflowchart LR\n  a["A"]\n```\n';
    const root = tempDir({ ".archer/n.md": note });
    const project = findProject(root);
    const before = await compileEmbedded(readEmbedded(project, "n.md#login")!);
    expect(pinEmbedded(project, "n.md#login", readEmbedded(project, "n.md#login")!.sourceRevision)).toBe("pinned");
    expect(readFileSync(join(root, ".archer/n.md"), "utf8")).toBe(
      '# Login\r\n\r\n```mermaid\r\n%% archer-id: login\nflowchart LR\n  a["A"]\n```\n',
    );
    const after = await compileEmbedded(readEmbedded(project, "n.md#login")!);
    expect(after.envelope?.revision).toBe(before.envelope?.revision);
  });
});
