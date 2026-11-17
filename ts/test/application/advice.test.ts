// The advisory lint in validate_diagram and write_diagram (ADR 0036 §9, A6, A7): advice never refuses,
// a write shows only the written diagram's findings, the two refusals stay as they were, and
// project: true is the project report.
import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { cleanUp, tempDir, write } from "../service/support.ts";

afterEach(cleanUp);

type Advice = { code: string; severity: string; element?: string; edge?: string; fix: string };
const SHOP = `C4Container\nPerson(shopper, "Shopper")\nSystem_Boundary(shop, "Shop") {\n  Container(web, "Storefront", "React")\n  ContainerDb(ordersDb, "Orders database", "Postgres")\n}\nRel(shopper, web, "Buys from")\nRel(web, ordersDb, "Stores orders", "SQL")\n`;
const OPS = `C4Container\nContainer(api, "API", "Node")\nContainerDb(ordersDb, "Orders database", "Postgres")\nRel(api, ordersDb, "Reads orders", "SQL")\n`;
/** OPS drawing the orders database under a new id, with a path for a technology. */
const OPS_DUP = OPS.replace(/ordersDb/g, "orders").replace('"Node"', '"ts/src/api"');

function project(): string {
  const cwd = tempDir("archer-advice-");
  write(cwd, "archer.toml", "version = 1\n");
  write(cwd, ".archer/diagrams/shop.mmd", SHOP);
  write(cwd, ".archer/diagrams/ops.mmd", OPS);
  return cwd;
}
const codes = (advice: unknown): string[] => ((advice as Advice[] | undefined) ?? []).map((a) => a.code);

test("validate_diagram lists advice, and it never makes a source invalid", async () => {
  const app = createApplication({ cwd: project() });
  try {
    const checked = await app.call("validate_diagram", { viewId: "ops", source: OPS_DUP });
    expect(checked.structured.valid).toBe(true);
    expect(codes(checked.structured.advice).sort()).toEqual(["possible_duplicate", "technology_is_path"]);
    expect(checked.structured.advice).toContainEqual(
      expect.objectContaining({
        code: "possible_duplicate",
        element: "orders",
        fix: expect.stringContaining("use the id 'ordersDb'"),
      }),
    );
    expect(checked.text).toMatch(/\nAdvice \(fix each, or say in one line why not\):\n- /);
    // The view's own source: its own ids never match themselves, and a clean source has no advice.
    const own = await app.call("validate_diagram", { viewId: "ops", source: OPS });
    expect(own.structured.advice).toBeUndefined();
    expect(own.text.split("\n")[0]).toBe("Valid.");
  } finally {
    app.close();
  }
});

test("write_diagram writes, then gives advice on the diagram it wrote, never on others", async () => {
  const cwd = project();
  // Another diagram with findings of its own: none of them is this write's.
  write(cwd, ".archer/diagrams/other.mmd", `C4Container\nContainer(x, "X", "~/bin/x")\n`);
  const app = createApplication({ cwd });
  try {
    const before = await app.call("read_diagram", { viewId: "ops" });
    const written = await app.call("write_diagram", {
      viewId: "ops",
      source: OPS_DUP,
      expectedRevision: before.structured.sourceRevision,
    });
    expect(written.structured.status).toBe("compiled");
    expect(readFileSync(`${cwd}/.archer/diagrams/ops.mmd`, "utf8")).toBe(OPS_DUP);
    expect(codes(written.structured.advice).sort()).toEqual(["possible_duplicate", "technology_is_path"]);
    expect((written.structured.advice as Advice[]).every((a) => a.element !== "x")).toBe(true);
    // Written again unchanged: 'orders' is in its last-good drawing now, so it is not new.
    const again = await app.call("write_diagram", {
      viewId: "ops",
      source: OPS_DUP,
      expectedRevision: written.structured.sourceRevision,
    });
    expect(codes(again.structured.advice)).toEqual(["technology_is_path"]);
    // A clean write says nothing more than before.
    const clean = await app.call("write_diagram", {
      viewId: "ops",
      source: OPS,
      expectedRevision: again.structured.sourceRevision,
    });
    expect(clean.structured.advice).toBeUndefined();
    expect(clean.text).not.toMatch(/Advice/);
  } finally {
    app.close();
  }
});

test("an embedded diagram: advice on the note's block, renamed or not", async () => {
  const cwd = project();
  const note = (body: string, name = "flow") =>
    `---\nauthor: agent\n---\n# Ops\n\n\`\`\`mermaid\n%% archer-id: ${name}\n${body}\`\`\`\n`;
  write(cwd, ".archer/notes/ops.md", note(OPS));
  const app = createApplication({ cwd });
  try {
    const checked = await app.call("validate_diagram", {
      viewId: "notes/ops.md#flow",
      source: `%% archer-id: flow\n${OPS_DUP}`,
    });
    expect(codes(checked.structured.advice).sort()).toEqual(["possible_duplicate", "technology_is_path"]);
    const before = await app.call("read_diagram", { viewId: "notes/ops.md#flow" });
    const renamed = await app.call("write_diagram", {
      viewId: "notes/ops.md#flow",
      source: `%% archer-id: flow2\n${OPS}`,
      expectedRevision: before.structured.sourceRevision,
    });
    expect(renamed.structured.address).toBe("notes/ops.md#flow2");
    // The old address's ids are the block's own: renaming it does not make them new.
    expect(renamed.structured.advice).toBeUndefined();
  } finally {
    app.close();
  }
});

test("the two write refusals are unchanged: nesting and reading rules refuse, advice or not (A6)", async () => {
  const cwd = project();
  const nested = `C4Container\nSystem_Boundary(shop, "Shop") {\n  Container(web, "Storefront", "ts/src/web")\n  Container(db, "Database")\n}\nRel(web, db, "Reads")\n`;
  write(cwd, ".archer/diagrams/nested.mmd", nested);
  write(cwd, ".archer/diagrams/flow.mmd", "flowchart LR\n  a[Client] e1@-->|sends| b[API]\n");
  const app = createApplication({ cwd });
  try {
    // Nesting (ADR 0029 §8): a component dropped into a system boundary, with a path technology for advice.
    const misplaced = nested.replace(
      '  Container(db, "Database")',
      '  Container(db, "Database")\n  Component(cache, "Cache", "src/cache.ts")',
    );
    const first = await app.call("read_diagram", { viewId: "nested" });
    const refused = await app
      .call("write_diagram", { viewId: "nested", source: misplaced, expectedRevision: first.structured.sourceRevision })
      .catch((e: { data?: Record<string, unknown> }) => e);
    expect((refused as { data: Record<string, unknown> }).data.code).toBe("invalid_source");
    expect((refused as { data: { diagnostics: { code: string }[] } }).data.diagnostics.map((d) => d.code)).toEqual([
      "nest_level_mismatch",
    ]);
    expect(readFileSync(`${cwd}/.archer/diagrams/nested.mmd`, "utf8")).toBe(nested);
    const validated = await app.call("validate_diagram", { viewId: "nested", source: misplaced });
    expect(validated.structured.valid).toBe(false);
    expect(codes(validated.structured.advice)).toContain("technology_is_path");
    // Reading rules (ADR 0030): a label over the limit.
    const long =
      "flowchart LR\n  a[Client] e1@-->|sends the signed order request with every line item and the address| b[API]\n";
    const flow = await app.call("read_diagram", { viewId: "flow" });
    const tooLong = await app
      .call("write_diagram", { viewId: "flow", source: long, expectedRevision: flow.structured.sourceRevision })
      .catch((e: { data?: Record<string, unknown> }) => e);
    expect((tooLong as { data: Record<string, unknown> }).data.code).toBe("invalid_source");
    expect(readFileSync(`${cwd}/.archer/diagrams/flow.mmd`, "utf8")).not.toBe(long);
  } finally {
    app.close();
  }
});

test("project: true is the project report; viewId and source are refused with it and required without it (A7)", async () => {
  const cwd = project();
  write(cwd, ".archer/diagrams/dup.mmd", OPS_DUP);
  const app = createApplication({ cwd });
  try {
    const report = await app.call("validate_diagram", { project: true });
    const views = report.structured.views as { viewId: string; advice: Advice[] }[];
    expect(views).toEqual([
      { viewId: "dup", advice: [expect.objectContaining({ code: "technology_is_path", element: "api" })] },
    ]);
    expect(codes(report.structured.model)).toEqual(["possible_duplicate"]);
    expect(report.structured.total).toBe(2);
    expect(report.text).toMatch(/^2 findings across 3 diagrams; fix each, or say in one line why not:\n- dup: /);
    for (const args of [
      { project: true, viewId: "ops" },
      { project: true, source: OPS },
      { viewId: "ops" },
      { source: OPS },
      {},
    ]) {
      const refused = await app
        .call("validate_diagram", args)
        .catch((e: { data?: Record<string, unknown>; message: string }) => e);
      expect((refused as { data: Record<string, unknown> }).data.code, JSON.stringify(args)).toBe("invalid_arguments");
    }
    const both = await app
      .call("validate_diagram", { project: true, viewId: "ops", source: OPS })
      .catch((e: { message: string }) => e);
    expect((both as { message: string }).message).toMatch(
      /2 problems[\s\S]*viewId: cannot be sent with project: true[\s\S]*source: cannot be sent with project: true/,
    );
  } finally {
    app.close();
  }
});
