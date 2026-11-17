// The nesting profile's write ratchet (ADR 0029; docs/proposals/ws-b-boundary-zoom.md §7): an
// agent write that ADDS a structural nesting finding is refused with nothing written; findings
// already in the source, advisory notes, and sources that do not compile are only reported.

import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { cleanUp, tempDir, write } from "../service/support.ts";

afterEach(cleanUp);

const clean = [
  "C4Container",
  '    System_Boundary(shop, "Web shop") {',
  '        Container(web, "Web app")',
  '        Container(db, "Database")',
  "    }",
  '    Rel(web, db, "Reads")',
  "",
].join("\n");
/** The same model with a component dropped straight into the system boundary. */
const misplaced = clean
  .replace('        Container(db, "Database")', '        Container(db, "Database")\n        Component(cache, "Cache")')
  .replace('    Rel(web, db, "Reads")', '    Rel(web, db, "Reads")\n    Rel(web, cache, "Caches")');

async function attempt(
  app: ReturnType<typeof createApplication>,
  viewId: string,
  source: string,
  expectedRevision?: string,
) {
  const before = await app.call("read_diagram", { viewId });
  return app
    .call("write_diagram", { viewId, source, expectedRevision: expectedRevision ?? before.structured.sourceRevision })
    .then(
      (value) => ({ value, error: undefined }),
      (error: { data?: Record<string, unknown>; message?: string }) => ({ value: undefined, error }),
    );
}

test("a write that adds a structural finding is refused, names the fix, and writes nothing", async () => {
  const cwd = tempDir();
  const path = write(cwd, ".archer/shop.mmd", clean);
  const app = createApplication({ cwd });
  try {
    const outcome = await attempt(app, "shop", misplaced);
    expect(outcome.error?.data?.code).toBe("invalid_source");
    expect(outcome.error?.message).toContain("put it in a Container_Boundary inside 'shop', or make it a Container");
    expect(outcome.error?.message).toContain("Nothing was written");
    expect(
      (outcome.error!.data!.diagnostics as { code: string; span: { start: { line: number } } }[]).map((d) => [
        d.code,
        d.span.start.line,
      ]),
    ).toEqual([["nest_level_mismatch", 5]]);
    expect(readFileSync(path, "utf8")).toBe(clean);
  } finally {
    app.close();
  }
});

test("a finding already in the source is only reported: the write goes through", async () => {
  const cwd = tempDir();
  const path = write(cwd, ".archer/shop.mmd", misplaced);
  const app = createApplication({ cwd });
  try {
    const relabelled = misplaced.replace('"Web app"', '"Storefront"');
    const outcome = await attempt(app, "shop", relabelled);
    expect(outcome.error).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(relabelled);
  } finally {
    app.close();
  }
});

test("renaming an element that already breaks the profile is not adding a finding", async () => {
  const cwd = tempDir();
  const path = write(cwd, ".archer/shop.mmd", misplaced);
  const app = createApplication({ cwd });
  try {
    const renamed = misplaced.replaceAll("cache", "store");
    expect((await attempt(app, "shop", renamed)).error).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(renamed);
  } finally {
    app.close();
  }
});

test("a chain already too deep may not grow deeper", async () => {
  const chain = (depth: number) => {
    const out = ["flowchart LR", "  top[Top]"];
    for (let level = 1; level <= depth; level++)
      out.push(`  subgraph g${level}[G ${level}]`, `    n${level}[N ${level}]`, `    m${level}[M ${level}]`);
    for (let level = depth; level >= 1; level--) out.push("  end");
    out.push("  top e1@--> n1", "");
    // Every subgraph opens before any closes, so each is inside the one before.
    return out.join("\n");
  };
  const cwd = tempDir();
  write(cwd, ".archer/deep.mmd", chain(5));
  const app = createApplication({ cwd });
  try {
    const outcome = await attempt(app, "deep", chain(6));
    expect(outcome.error?.data?.code).toBe("invalid_source");
    expect(outcome.error?.message).toContain("'g6' is nested 6 deep");
  } finally {
    app.close();
  }
});

test("advisory notes never refuse, and a base that does not compile has no ratchet", async () => {
  const cwd = tempDir();
  const path = write(cwd, ".archer/shop.mmd", "C4Container\n    Rel(\n");
  const app = createApplication({ cwd });
  try {
    expect((await attempt(app, "shop", misplaced)).error).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(misplaced);
    const single = "flowchart LR\n  x[X]\n  subgraph g[G]\n    a[A]\n  end\n  x e1@--> a\n";
    expect((await attempt(app, "shop", single)).error).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(single);
  } finally {
    app.close();
  }
});

test("a stale revision is refused as stale before any nesting check", async () => {
  const cwd = tempDir();
  write(cwd, ".archer/shop.mmd", clean);
  const app = createApplication({ cwd });
  try {
    const outcome = await attempt(app, "shop", misplaced, `sha256:${"0".repeat(64)}`);
    expect(outcome.error?.data?.code).toBe("revision_conflict");
  } finally {
    app.close();
  }
});

test("an embedded diagram is held to its own previous text", async () => {
  const cwd = tempDir();
  const note = [
    "---",
    "author: agent",
    "---",
    "# Shop",
    "",
    "```mermaid",
    "%% archer-id: shop",
    clean.trimEnd(),
    "```",
    "",
  ].join("\n");
  const path = write(cwd, ".archer/notes/shop.md", note);
  const app = createApplication({ cwd });
  try {
    const list = await app.call("list_diagrams", {});
    const address = JSON.stringify(list.structured).match(/"(notes\/shop\.md#shop)"/)?.[1] ?? "notes/shop.md#shop";
    const outcome = await attempt(app, address, `%% archer-id: shop\n${misplaced}`);
    expect(outcome.error?.data?.code).toBe("invalid_source");
    // Lines are the note's, as validate_diagram reports them: diagram line 6, after the six lines above its body.
    expect(outcome.error?.message).toContain("Line 12:");
    expect(readFileSync(path, "utf8")).toBe(note);
  } finally {
    app.close();
  }
});

test("registering an existing file with a finding only reports it", async () => {
  const cwd = tempDir();
  write(cwd, "archer.toml", "version = 1\n");
  write(cwd, ".archer/shop.mmd", misplaced);
  const app = createApplication({ cwd });
  try {
    const answer = await app.call("validate_diagram", { viewId: "shop", source: misplaced });
    expect(JSON.stringify(answer.structured)).toContain("nest_level_mismatch");
  } finally {
    app.close();
  }
});
