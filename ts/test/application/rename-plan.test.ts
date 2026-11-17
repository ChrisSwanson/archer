// The rename plan (ADR 0036 §10, A14, O9) end to end on a sandbox project: built and dry-run first,
// then one write_diagram per view and write_walkthrough for the walkthroughs naming a renamed id;
// every walkthrough stays current; an old long label whose end is renamed is not a new finding;
// and a revision changed mid-plan stops it with a report of what was and was not written.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createApplication, type Application } from "../../src/application/index.ts";
import { applyRenamePlan, planRenames } from "../../src/application/rename-plan.ts";
import { introducedBy } from "../../src/mermaid/lint.ts";
import { writeCap } from "../../src/docs/pack.ts";
import { findProject } from "../../src/project/index.ts";
import { cleanUp, tempDir, write } from "../service/support.ts";

afterEach(cleanUp);

/** A label already over the reading rule's limit: the file has it, so it is only reported. */
const LONG = "Stores every order with its lines, totals and the delivery address";
const SHOP = `C4Container\nPerson(shopper, "Shopper")\nSystem_Boundary(shop, "Shop") {\n  Container(web, "Storefront", "React")\n  ContainerDb(db, "Orders database", "Postgres")\n}\nRel(shopper, web, "Buys from")\nRel(web, db, "${LONG}", "SQL")\n`;
const FLOW =
  "%% archer-id: flow\nflowchart LR\n  web[Storefront]:::container\n  db[(Orders database)]:::database\n  web saves@-->|saves| db\n";
const CTX = `%% archer-id: ctx\nC4Container\nContainer(api, "API")\nContainerDb(db, "Orders database")\nRel(api, db, "Reads orders")\n`;
const NOTE = `---\nauthor: agent\ndescription: Ops.\n---\n# Ops\n\n\`\`\`mermaid\n${FLOW}\`\`\`\n\nBetween the two.\n\n\`\`\`mermaid\n${CTX}\`\`\`\n`;

function sandbox(): string {
  const cwd = tempDir("archer-rename-");
  write(cwd, "archer.toml", "version = 1\n");
  write(cwd, ".archer/diagrams/shop.mmd", SHOP);
  write(cwd, ".archer/notes/ops.md", NOTE);
  return cwd;
}

async function walkthrough(
  app: Application,
  viewId: string,
  id: string,
  nodes: string[],
  edges: string[],
): Promise<void> {
  const read = await app.call("read_diagram", { viewId });
  await app.call("write_walkthrough", {
    viewId,
    modelRevision: read.structured.modelRevision,
    walkthrough: {
      id,
      title: "Order tour",
      steps: [
        {
          title: "Save the order",
          kind: "does",
          what: "The storefront saves the order.",
          nodes: nodes.map((n) => ({ kind: "node", id: n })),
          edges: edges.map((e) => ({ id: e })),
          messages: [],
        },
      ],
    },
  });
}

async function statuses(app: Application): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const viewId of ["shop", "notes/ops.md#flow"]) {
    const listed = await app.call("list_walkthroughs", { viewId });
    for (const w of listed.structured.walkthroughs as { id: string; status: string }[])
      out[`${viewId}/${w.id}`] = w.status;
  }
  return out;
}

async function setUp(): Promise<{ cwd: string; app: Application }> {
  const cwd = sandbox();
  const app = createApplication({ cwd });
  await walkthrough(app, "shop", "tour", ["web", "db"], ["web--db"]);
  await walkthrough(app, "notes/ops.md#flow", "save", ["web", "db"], ["saves"]);
  return { cwd, app };
}

test("a plan is dry-run before it is offered, then applied: every walkthrough stays current", async () => {
  const { cwd, app } = await setUp();
  try {
    expect(await statuses(app)).toEqual({ "shop/tour": "current", "notes/ops.md#flow/save": "current" });
    const plan = await planRenames(app, findProject(cwd), [{ from: "db", to: "ordersDb", why: "a generic id" }]);
    expect(plan.problems).toEqual([]);
    expect(plan.ready).toBe(true);
    expect(
      plan.writes.map((w) =>
        w.kind === "diagram" ? `diagram ${w.viewId}` : `walkthrough ${w.viewId}/${w.walkthroughId}`,
      ),
    ).toEqual([
      "diagram shop",
      "walkthrough shop/tour",
      "diagram notes/ops.md#flow",
      "walkthrough notes/ops.md#flow/save",
      "diagram notes/ops.md#ctx",
    ]);
    // Built and checked, nothing written yet.
    expect(readFileSync(join(cwd, ".archer/diagrams/shop.mmd"), "utf8")).toBe(SHOP);
    const run = await applyRenamePlan(app, plan);
    expect(run.text).toBe("Rename plan applied: 3 diagrams and 2 walkthroughs written.");
    expect(await statuses(app)).toEqual({ "shop/tour": "current", "notes/ops.md#flow/save": "current" });
    const found = await app.call("find_elements", { id: "ordersDb" });
    expect((found.structured.elements as { drawnIn: string[] }[])[0]!.drawnIn).toEqual([
      "notes/ops.md#ctx",
      "notes/ops.md#flow",
      "shop",
    ]);
    expect((await app.call("find_elements", { id: "db" })).structured.total).toBe(0);
    // The note's prose between its two diagrams is as it was.
    expect(readFileSync(join(cwd, ".archer/notes/ops.md"), "utf8")).toContain("\n\nBetween the two.\n\n");
  } finally {
    app.close();
  }
});

test("O9: an old long label whose end is renamed is the old finding; a new long label is still refused", async () => {
  const renamed = SHOP.replace(/\bdb\b/g, "ordersDb");
  expect(await introducedBy(SHOP, renamed)).toEqual([]);
  // Not a rename: the long label moves to a new pair, or the element is relabelled as well.
  expect(
    (await introducedBy(SHOP, renamed.replace('Rel(shopper, web, "Buys from")', `Rel(shopper, web, "${LONG}")`))).map(
      (d) => d.code,
    ),
  ).toEqual(["edge_label_too_long"]);
  expect((await introducedBy(SHOP, renamed.replace('"Orders database"', '"Order store"'))).map((d) => d.code)).toEqual([
    "edge_label_too_long",
  ]);
  // And through write_diagram itself.
  const cwd = sandbox();
  const app = createApplication({ cwd });
  try {
    const read = await app.call("read_diagram", { viewId: "shop" });
    const written = await app.call("write_diagram", {
      viewId: "shop",
      source: renamed,
      expectedRevision: read.structured.sourceRevision,
    });
    expect(written.structured.status).toBe("compiled");
  } finally {
    app.close();
  }
});

test("a revision changed mid-plan stops it, and the report says what was written and what was not", async () => {
  const { cwd, app } = await setUp();
  try {
    const plan = await planRenames(app, findProject(cwd), [{ from: "db", to: "ordersDb" }]);
    const run = await applyRenamePlan(app, plan, {
      beforeWrite: (w) => {
        // Someone edits the note's first diagram after the plan was made.
        if (w.kind === "diagram" && w.viewId === "notes/ops.md#flow") {
          const path = join(cwd, ".archer/notes/ops.md");
          writeFileSync(path, readFileSync(path, "utf8").replace("|saves| db", "|stores| db"));
        }
      },
    });
    expect(run.completed).toBe(false);
    expect(run.failed).toMatchObject({
      write: { kind: "diagram", viewId: "notes/ops.md#flow" },
      code: "revision_conflict",
    });
    expect(run.text.split("\n")).toEqual([
      expect.stringMatching(
        /^Rename plan stopped at notes\/ops\.md#flow \(db → ordersDb\): revision_conflict: notes\/ops\.md#flow changed since the plan was made .*Nothing after it was written; nothing before it was undone\.$/,
      ),
      "Written: shop (db → ordersDb); walkthrough tour on shop.",
      "Not written: notes/ops.md#flow (db → ordersDb); walkthrough save on notes/ops.md#flow; notes/ops.md#ctx (db → ordersDb).",
      "Build the plan again from the project as it is now to finish.",
    ]);
    expect(readFileSync(join(cwd, ".archer/notes/ops.md"), "utf8")).toContain("db[(Orders database)]");
    expect(await statuses(app)).toEqual({ "shop/tour": "current", "notes/ops.md#flow/save": "current" });
  } finally {
    app.close();
  }
});

test("a walkthrough write that fails leaves its diagram renamed, and the report says the walkthrough is out of date", async () => {
  const { cwd, app } = await setUp();
  try {
    const plan = await planRenames(app, findProject(cwd), [{ from: "db", to: "ordersDb" }]);
    const run = await applyRenamePlan(app, plan, {
      beforeWrite: async (w) => {
        // The person rewrites the tour after the plan was made: its revision moves.
        if (w.kind === "walkthrough" && w.walkthroughId === "tour") {
          const read = await app.call("read_diagram", { viewId: "shop" });
          await app.call("write_walkthrough", {
            viewId: "shop",
            modelRevision: read.structured.modelRevision,
            expectedRevision: 1,
            walkthrough: {
              id: "tour",
              title: "Order tour",
              steps: [
                {
                  title: "Buy",
                  kind: "does",
                  what: "The shopper buys.",
                  nodes: [{ kind: "node", id: "web" }],
                  edges: [],
                  messages: [],
                },
              ],
            },
          });
        }
      },
    });
    expect(run.failed).toMatchObject({ write: { kind: "walkthrough", walkthroughId: "tour" } });
    expect(run.text).toContain("Out of date until written: walkthrough tour on shop.");
  } finally {
    app.close();
  }
});

test("problems keep a plan from being offered: an id already in the view, a journey, an id nobody draws", async () => {
  const cwd = sandbox();
  write(cwd, ".archer/diagrams/trip.mmd", "journey\n  section Buy\n    db: 5: Me\n");
  const app = createApplication({ cwd });
  try {
    const project = findProject(cwd);
    const clash = await planRenames(app, project, [{ from: "db", to: "web", views: ["shop"] }]);
    expect(clash.ready).toBe(false);
    expect(clash.problems).toContainEqual(
      expect.objectContaining({ viewId: "shop", problem: expect.stringContaining("'web' is already in this view") }),
    );
    const journey = await planRenames(app, project, [{ from: "db", to: "ordersDb", views: ["trip"] }]);
    expect(journey.problems).toContainEqual(
      expect.objectContaining({ viewId: "trip", problem: expect.stringContaining("journey task") }),
    );
    const nobody = await planRenames(app, project, [{ from: "nothing", to: "something" }]);
    expect(nobody.problems).toEqual([expect.objectContaining({ problem: "no diagram draws 'nothing' as an element" })]);
    await expect(applyRenamePlan(app, clash)).rejects.toThrow(/not offered/);
  } finally {
    app.close();
  }
});

test("in docs mode a note's cap is checked as the whole plan leaves it, not block by block", async () => {
  const block = (name: string) =>
    `\`\`\`mermaid\n%% archer-id: ${name}\nflowchart LR\n  a[A]:::component e@--> b[B]\n\`\`\`\n`;
  const note = (pad: number) =>
    `---\nauthor: agent\ntype: user-flow\n---\n# Pay\n\n${block("one")}\n${"x".repeat(pad)}\n\n${block("two")}`;
  const cwd = tempDir("archer-rename-cap-");
  write(cwd, "archer.toml", 'version = 1\nmode = "docs"\n');
  write(cwd, ".archer/notes/flows/pay.md", note(0));
  const cap = writeCap(findProject(cwd), "notes/flows/pay.md", note(0))!;
  // Each block's rename alone adds 2 characters and fits; both add 4 and do not.
  write(cwd, ".archer/notes/flows/pay.md", note(cap - 3 - [...note(0)].length));
  const app = createApplication({ cwd });
  try {
    const both = await planRenames(app, findProject(cwd), [{ from: "a", to: "abc" }]);
    expect(both.ready, JSON.stringify(both.problems)).toBe(false);
    expect(both.problems.map((p) => p.viewId)).toEqual(["notes/flows/pay.md#one", "notes/flows/pay.md#two"]);
    expect(both.problems[0]!.problem).toContain(
      `notes/flows/pay.md would be ${cap + 1} characters, over its ${cap} cap`,
    );
    expect(
      (await planRenames(app, findProject(cwd), [{ from: "a", to: "abc", views: ["notes/flows/pay.md#one"] }])).ready,
    ).toBe(true);
    // One block that breaks the cap alone is refused as validate_diagram warns of it.
    const alone = await planRenames(app, findProject(cwd), [
      { from: "a", to: "abcdef", views: ["notes/flows/pay.md#one"] },
    ]);
    expect(alone.problems).toEqual([
      expect.objectContaining({
        viewId: "notes/flows/pay.md#one",
        problem: expect.stringContaining("over its docs-mode cap"),
      }),
    ]);
  } finally {
    app.close();
  }
});
