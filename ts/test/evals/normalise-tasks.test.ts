// The normalisation evals (ticket 06; scripts/evals/v1/normalise.mjs): normMeasures on hand-made good and
// bad diagrams compiled by the production compiler, the fixture's seeds, and each task's judge, mutation-
// checked: a run that does what good is passes, and each mutation fails exactly the checks that name it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { compile } from "../../src/mermaid/compile.ts";
import {
  ANALYTICS_EXPORT,
  PAYMENT_RETRIES,
  SHOP_INTERNALS,
  containerPairs,
  findingsSeen,
  normMeasures,
  runMeasures,
  seededFor,
  // @ts-expect-error -- a plain .mjs script without types
} from "../../scripts/evals/v1/normalise.mjs";
// @ts-expect-error -- a plain .mjs script without types
import { NORMALISE } from "../../scripts/evals/v1/facts.mjs";
// @ts-expect-error -- a plain .mjs script without types
import { TASKS } from "../../scripts/evals/v1/tasks.mjs";
// @ts-expect-error -- a plain .mjs script without types
import { fisher, pool } from "../../scripts/evals/v1/normalise-report.mjs";
// @ts-expect-error -- a plain .mjs script without types
import { parseTranscript } from "../../scripts/evals/v1/judge.mjs";

vi.hoisted(() => {
  process.env.ARCHER_EVAL_HOLDOUT = "/nonexistent/archer-evals/holdout.mjs";
});

type Check = { name: string; level: string; pass: boolean; detail?: string };
type Measures = Record<string, unknown> & { drift: string[]; homonyms: string[]; ids: string[] };
const failed = (checks: Check[]) => checks.filter((c) => !c.pass).map((c) => c.name);
const model = async (source: string) => {
  const r = await compile(source);
  if (!r.model) throw new Error(`does not compile: ${JSON.stringify(r.diagnostics)}`);
  return r.model;
};
const measure = async (source: string): Promise<Measures> => normMeasures(await model(source));
const block = (note: string) => /```mermaid\n([\s\S]*?)```/.exec(note)![1]!;
const DEMO = join(__dirname, "../fixtures/pageturner/.archer/diagrams");
const CONTAINERS = readFileSync(join(DEMO, "containers.mmd"), "utf8");

describe("normMeasures", () => {
  test("Pageturner's containers view is the norm: every seeded element by its own id, nothing mixed or drifted", async () => {
    expect(await measure(CONTAINERS)).toMatchObject({
      family: "c4",
      level: "container",
      elements: 11,
      relationships: 11,
      mixed: false,
      inBand: true,
      scopes: 1,
      orphans: 0,
      twoHop: 0,
      techPathLike: 0,
      uses: 0,
      identLabels: 0,
      birel: 0,
      rel5th: 0,
      reused: 11,
      expected: 11,
      labelDrift: 0,
      drift: [],
      homonyms: [],
    });
  });

  test("the verbose seed measures as verbose: components in a container view, paths, Uses, calls, BiRels, drifted ids", async () => {
    const m = await measure(SHOP_INTERNALS);
    expect(m).toMatchObject({
      level: "container",
      mixed: true,
      inBand: false,
      birel: 2,
      uses: 3,
      identLabels: 2,
      drift: ["shopApi", "postgres", "redisQueue"],
      homonyms: [],
    });
    expect(m.techPathLike).toBeGreaterThanOrEqual(10);
    expect(m.rel5th).toBe(17);
    expect(m.descWordsMax).toBeGreaterThan(15);
    expect(m.words).toBe(NORMALISE.shopInternals.seedWords);
  });

  test("the seed says every container-level fact the tidy must keep", async () => {
    const pairs = new Set(containerPairs(await model(SHOP_INTERNALS)).map(([a, b]: string[]) => `${a}->${b}`));
    for (const [a, b] of NORMALISE.shopInternals.facts) expect(pairs, `${a}->${b}`).toContain(`${a}->${b}`);
  });

  test("the collision notes compile, and their drift and homonym are what the measures see", async () => {
    expect((await measure(block(PAYMENT_RETRIES))).drift).toEqual(["office", "provider", "queue"]);
    expect((await measure(block(ANALYTICS_EXPORT))).homonyms).toEqual(["db"]);
  });

  const CONTEXT = `C4Context
  Person(customer, "Customer")
  Person(staff, "Shop Staff")
  System(pageturner, "Pageturner", "Online bookshop")
  System_Ext(payments, "Payment Provider")
  System_Ext(courier, "Courier")
  System_Ext(email, "Email Service")
  Rel(customer, pageturner, "Buys books from")
  Rel(staff, pageturner, "Manages stock in")
  Rel(pageturner, payments, "Takes payments through")
  Rel(pageturner, courier, "Books collections with")
  Rel(pageturner, email, "Sends emails through")
`;

  test("a good context view: one system in scope, every element reused", async () => {
    // "Pageturner" is not containers.mmd's "Pageturner Online Bookshop": one label drift, never a homonym.
    expect(await measure(CONTEXT)).toMatchObject({
      level: "context",
      mixed: false,
      inScopeSystems: 1,
      reused: 6,
      expected: 6,
      labelDrift: 1,
      drift: [],
      homonyms: [],
      orphans: 0,
    });
  });

  test.each([
    [
      "a container in a context view is mixed",
      CONTEXT.replace(
        'System_Ext(email, "Email Service")',
        'System_Ext(email, "Email Service")\n  Container(api, "Shop API")\n  Rel(pageturner, api, "Calls")',
      ),
      { mixed: true },
    ],
    [
      "a drifted alias is drift, and a seeded element under it is not reused",
      CONTEXT.replace(/payments/g, "provider"),
      { drift: ["provider"], reused: 5, expected: 6 },
    ],
    [
      "a new id for a seeded element is not reused",
      CONTEXT.replace(/payments/g, "paymentProvider"),
      { drift: [], reused: 5, expected: 6 },
    ],
    [
      "a seeded id on the analytics warehouse is a homonym",
      CONTEXT.replace(
        'System_Ext(email, "Email Service")',
        'System_Ext(email, "Email Service")\n  System_Ext(db, "Analytics warehouse", "BigQuery")\n  Rel(pageturner, db, "Exports to")',
      ),
      { homonyms: ["db"] },
    ],
    [
      "a relabelled seeded element is label drift",
      CONTEXT.replace('"Courier"', '"ParcelPro courier"'),
      { reused: 6, labelDrift: 2 },
    ],
    [
      "an element with no relationship is an orphan",
      CONTEXT.replace('  Rel(pageturner, email, "Sends emails through")\n', ""),
      { orphans: 1 },
    ],
  ])("%s", async (_name, source, expected) => {
    expect(await measure(source)).toMatchObject(expected);
  });

  test("a component view opening two containers is mixed; one opened container is not", async () => {
    const one = `C4Component
  Container(web, "Storefront", "React")
  Container_Boundary(api, "Shop API") {
    Component(orders, "Orders", "Express")
    Component(stock, "Stock", "Express")
  }
  ContainerDb(db, "Shop Database", "PostgreSQL")
  Rel(web, orders, "Places orders with")
  Rel(orders, db, "Saves orders in")
  Rel(stock, db, "Reads stock from")
`;
    expect(await measure(one)).toMatchObject({
      level: "component",
      mixed: false,
      scopes: 1,
      twoHop: 0,
      reused: 2,
      expected: 2,
    });
    const two = one.replace(
      'ContainerDb(db, "Shop Database", "PostgreSQL")',
      'ContainerDb(db, "Shop Database", "PostgreSQL")\n  Container_Boundary(worker, "Worker") {\n    Component(mailer, "Mailer")\n  }\n  Rel(mailer, db, "Reads")',
    );
    expect(await measure(two)).toMatchObject({ mixed: true, scopes: 2 });
  });

  test("a technology that is a path or a command is path-like; a technology is not", async () => {
    const m = await measure(`C4Container
  Container(a, "A", "services/shop-api/src/orders.js")
  Container(b, "B", "npm run start")
  Container(c, "C", "Node.js, Express")
  Container(d, "D", "JSON/HTTPS")
  Rel(a, b, "Calls")
  Rel(c, d, "Calls")
`);
    expect(m.techPathLike).toBe(2);
  });

  test("labels name seeded elements by kind: a component called Payments is not the provider", () => {
    expect(seededFor("Payments", "component")).toBeUndefined();
    expect(seededFor("Payment Provider", "system")?.id).toBe("payments");
    expect(seededFor("Gift card database", "container")).toBeUndefined();
    expect(seededFor("Shop DB", "container")?.id).toBe("db");
    expect(seededFor("Paystream", undefined)?.id).toBe("payments");
  });
});

describe("what a run saw and left", () => {
  test("findingsSeen counts the advice validate and write results showed, once per finding", () => {
    const text =
      "Wrote it.\nAdvice (fix each, or say in one line why not):\n- Cut the description of 'api' to 15 words or fewer. [description_too_long]\n- (info) shared [element_parent_conflict]";
    expect(
      findingsSeen([
        { tool: "write_diagram", text },
        { tool: "validate_diagram", text: '{"advice":[{"code":"code_in_label"}]}' },
        { tool: "read_diagram", text },
      ]),
    ).toBe(3);
  });

  test("findingsSeen counts what a CLI present showed too: it prints the diagram's advice after the link", () => {
    const text =
      "Presenting 'Shop' (rev sha256:1). Give the person this link exactly:\nhttp://x\nAdvice (fix each, or say in one line why not):\n- The technology of 'api' is a path. [technology_is_path]";
    expect(findingsSeen([{ tool: "present_diagram", text }])).toBe(1);
  });

  test("`archer present <name>` in a shell is present_diagram, with its view and the URL it returned", () => {
    const dir = mkdtempSync(join(tmpdir(), "norm-transcript-"));
    const url = "http://127.0.0.1:45113/projects/project/diagrams/system-context.mmd?token=abc";
    const lines = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "archer present system-context" } },
            { type: "tool_use", id: "t2", name: "Bash", input: { command: "archer present --file args.json" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: `Presenting 'System Context'. Give the person this link exactly:\n${url}\n`,
            },
            {
              type: "tool_result",
              tool_use_id: "t2",
              content: `Presenting.\n${url.replace("system-context.mmd", "notes/scratch/refunds.md").replace("?token=abc", "?token=abc#refund-flow")}\n`,
            },
          ],
        },
      },
    ];
    writeFileSync(join(dir, "transcript.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
    const { calls } = parseTranscript(join(dir, "transcript.jsonl"), "claude");
    expect(
      calls.map((c: { tool: string; input: { viewId?: string }; url?: string }) => [
        c.tool,
        c.input.viewId,
        Boolean(c.url),
      ]),
    ).toEqual([
      ["present_diagram", "system-context", true],
      ["present_diagram", "notes/scratch/refunds.md#refund-flow", true],
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("runMeasures pools the views: zero findings only when every view was linted clean", async () => {
    const m = await measure(CONTAINERS);
    const view = (findings: number | null) => ({ viewId: "v", compiled: true, findings, advice: [], measures: m });
    expect(runMeasures([view(0), view(0)], [])).toMatchObject({
      zeroFindings: true,
      findings: 0,
      reused: 22,
      expected: 22,
      mixed: false,
      inBand: true,
      drift: [],
    });
    expect(runMeasures([view(0), view(2)], [])).toMatchObject({ zeroFindings: false, findings: 2 });
    expect(runMeasures([view(null)], [])).toMatchObject({ zeroFindings: null, findings: null });
  });
});

// ---- the judges

const URL = "http://127.0.0.1:4000/projects/pageturner/v/new?follow";
const task = (id: string) => TASKS.find((t: { id: string }) => t.id === id);
interface RunSpec {
  added?: Record<string, string>;
  edited?: Record<string, string>;
  baseline?: Record<string, string>;
  advice?: Record<string, unknown[]>;
  calls?: unknown[];
  finalText?: string;
}
/** A judged run's evidence (judge.mjs ctx) for diagrams written as files: compiled for real, linted by a stub. */
async function runCtx({
  added = {},
  edited = {},
  baseline = {},
  advice = {},
  calls,
  finalText = `Here it is: ${URL}`,
}: RunSpec) {
  const viewId = (path: string) =>
    path
      .split("/")
      .pop()!
      .replace(/\.mmd$/, "");
  const models: Record<string, unknown> = {};
  for (const [path, source] of Object.entries({ ...added, ...edited }))
    if (path.endsWith(".mmd")) models[viewId(path)] = await model(source);
  const diagrams = Object.entries(added).map(([path, source]) => ({
    path,
    viewId: viewId(path),
    source,
    compiled: "compiled",
    longLabels: [],
    labelWarnings: 0,
    pinnedInside: true,
  }));
  const first = Object.keys(added)[0] ?? Object.keys(edited)[0];
  return {
    calls: calls ?? [
      {
        server: "archer",
        tool: "present_diagram",
        input: { viewId: first ? viewId(first) : "x" },
        ok: true,
        urls: [URL],
        url: URL,
      },
    ],
    finalText,
    changed: [...Object.keys(added), ...Object.keys(edited)],
    added: Object.keys(added),
    files: { ...added, ...edited },
    baseline,
    compiled: Object.fromEntries(Object.keys({ ...added, ...edited }).map((p) => [p, "compiled"])),
    diagrams,
    newDiagram: diagrams[0],
    newDiagramSource: diagrams[0]?.source,
    newNotes: [],
    emphases: [],
    readDiagram: (id: string) => (models[id] ? { envelope: { model: models[id] } } : null),
    lint: (id: string) => advice[id] ?? [],
  };
}
const judge = async (id: string, spec: RunSpec) => failed(task(id).judge(await runCtx(spec)));

const T1 = `C4Context
  title Pageturner
  Person(customer, "Customer")
  Person(staff, "Shop Staff")
  System(pageturner, "Pageturner Online Bookshop")
  System_Ext(payments, "Payment Provider")
  System_Ext(courier, "Courier")
  System_Ext(email, "Email Service")
  Rel(customer, pageturner, "Buys books from")
  Rel(staff, pageturner, "Manages stock in")
  Rel(pageturner, payments, "Takes payments through")
  Rel(pageturner, courier, "Books collections with")
  Rel(pageturner, email, "Sends emails through")
`;
const T1_PATH = ".archer/diagrams/context.mmd";

describe("T1 norm-context", () => {
  test("the good run passes, and its measures are recorded", async () => {
    expect(await judge("norm-context", { added: { [T1_PATH]: T1 } })).toEqual([]);
    const measures = task("norm-context").measures(await runCtx({ added: { [T1_PATH]: T1 } }));
    expect(measures).toMatchObject({
      written: 1,
      zeroFindings: true,
      reused: 6,
      expected: 6,
      mixed: false,
      inBand: true,
      drift: [],
      homonyms: [],
    });
  });
  test.each([
    [
      "a container in it",
      T1.replace("  Rel(customer", '  Container(api, "Shop API")\n  Rel(pageturner, api, "Calls")\n  Rel(customer'),
      ["only people and software systems"],
    ],
    [
      "two systems in scope",
      T1.replace('System_Ext(courier, "Courier")', 'System(courier, "Courier")'),
      ["exactly one system in scope, the rest external"],
    ],
    [
      "the provider under its drifted id",
      T1.replace(/payments/g, "provider"),
      [
        "reuses the seeded ids for the five neighbours",
        "no drifted alias (queue, cdn, provider, office, shopApi, postgres, redisQueue)",
      ],
    ],
    [
      "the provider under a new id",
      T1.replace(/payments/g, "paymentProvider"),
      ["reuses the seeded ids for the five neighbours"],
    ],
    [
      "eleven elements",
      T1.replace(
        "  Rel(customer",
        Array.from(
          { length: 5 },
          (_, i) => `  System_Ext(partner${i}, "Partner ${i}")\n  Rel(pageturner, partner${i}, "Sends to")\n`,
        ).join("") + "  Rel(customer",
      ),
      ["within the L1 band (10)"],
    ],
  ])("mutation: %s", async (_name, source, expected) => {
    expect(await judge("norm-context", { added: { [T1_PATH]: source } })).toEqual(expected);
  });
  test("the flowchart rewritten in place as a C4 context view passes too", async () => {
    const path = ".archer/diagrams/system-context.mmd";
    expect(
      await judge("norm-context", {
        edited: { [path]: T1 },
        baseline: { [path]: "flowchart LR\n  a --> b\n" },
        calls: [writeCall, { ...presentContainers, input: { viewId: "system-context" } }],
      }),
    ).toEqual([]);
    expect(
      await judge("norm-context", {
        edited: { [path]: T1.replace(/payments/g, "provider") },
        calls: [writeCall, { ...presentContainers, input: { viewId: "system-context" } }],
      }),
    ).toEqual([
      "reuses the seeded ids for the five neighbours",
      "no drifted alias (queue, cdn, provider, office, shopApi, postgres, redisQueue)",
    ]);
    // Its archer.toml kind may follow the family; any other archer.toml change is collateral damage.
    const toml = 'name = "Pageturner"\n[[views]]\nid = "system-context"\nkind = "c4-context"\n';
    const present = { ...presentContainers, input: { viewId: "system-context" } };
    expect(
      await judge("norm-context", {
        edited: { [path]: T1, "archer.toml": toml.replace('"c4-context"', '"c4"') },
        baseline: { "archer.toml": toml },
        calls: [writeCall, present],
      }),
    ).toEqual([]);
    expect(
      await judge("norm-context", {
        edited: { [path]: T1, "archer.toml": toml.replace("Pageturner", "Shop") },
        baseline: { "archer.toml": toml },
        calls: [writeCall, present],
      }),
    ).toEqual(["no other files changed"]);
  });
  test("mutation: a lint finding left", async () => {
    expect(
      await judge("norm-context", {
        added: { [T1_PATH]: T1 },
        advice: { context: [{ code: "description_too_long", severity: "warning", element: "x" }] },
      }),
    ).toEqual(["no lint findings left"]);
  });
});

const T2 = `C4Container
  title Bookshop containers
  Person(customer, "Customer")
  Person(staff, "Staff")
  System_Boundary(bookshop, "Bookshop") {
    Container(storefront, "Storefront", "React")
    Container(backoffice, "Back office", "React")
    Container(shop_api, "Shop API", "Node.js, Express")
    Container(worker, "Worker", "Node.js, BullMQ")
    ContainerDb(database, "Database", "PostgreSQL 16")
    ContainerQueue(queue, "Job queue", "Redis 7")
  }
  System_Ext(paystream, "Paystream", "Card payments")
  Rel(customer, storefront, "Buys books in")
  Rel(staff, backoffice, "Manages stock in")
  Rel(storefront, shop_api, "Places orders with")
  Rel(backoffice, shop_api, "Manages stock through")
  Rel(shop_api, database, "Reads and writes")
  Rel(shop_api, queue, "Queues jobs on")
  Rel(worker, queue, "Takes jobs from")
  Rel(shop_api, paystream, "Opens payments with")
`;
const T2_PATH = ".archer/diagrams/containers.mmd";

describe("T2 norm-containers-control", () => {
  test("the good run passes (no ids to copy: ids are free, containers matched by label)", async () => {
    expect(await judge("norm-containers-control", { added: { [T2_PATH]: T2 } })).toEqual([]);
  });
  test.each([
    [
      "a component in it",
      T2.replace("  }\n", '    Component(orders, "Orders", "Express")\n  }\n').replace(
        "Rel(worker, queue",
        'Rel(shop_api, orders, "Routes to")\n  Rel(worker, queue',
      ),
      ["no components in a container view"],
    ],
    ["the queue left out", T2.replace(/.*queue.*\n/gi, ""), ["the containers the code has"]],
    [
      "a file path as technology",
      T2.replace('"Node.js, BullMQ"', '"services/worker/src/index.js"'),
      ["technology is a technology, not a path or command"],
    ],
    ["a Uses label", T2.replace('"Takes jobs from"', '"Uses"'), ["relationship labels are short verb phrases"]],
  ])("mutation: %s", async (_name, source, expected) => {
    expect(await judge("norm-containers-control", { added: { [T2_PATH]: source } })).toEqual(expected);
  });
});

const T3 = `C4Component
  title Shop API components
  Container(web, "Storefront", "React")
  Container(backoffice, "Back Office", "React")
  Container_Boundary(api, "Shop API") {
    Component(orders, "Orders", "Express router")
    Component(stock, "Stock", "Express router")
    Component(payments_client, "Payments", "fetch")
    Component(webhooks, "Payment webhooks", "Express router")
  }
  ContainerDb(db, "Shop Database", "PostgreSQL")
  ContainerQueue(jobs, "Job Queue", "Redis")
  System_Ext(payments, "Payment Provider")
  Rel(web, orders, "Places orders with")
  Rel(backoffice, stock, "Adds stock with")
  Rel(orders, payments_client, "Opens payments with")
  Rel(payments_client, payments, "Creates sessions with")
  Rel(payments, webhooks, "Reports outcomes to")
  Rel(orders, db, "Saves orders in")
  Rel(stock, db, "Changes stock in")
  Rel(webhooks, jobs, "Queues emails on")
`;
const T3_PATH = ".archer/diagrams/shop-api-components.mmd";

describe("T3 norm-component-from-code", () => {
  test("the good run passes", async () => {
    expect(await judge("norm-component-from-code", { added: { [T3_PATH]: T3 } })).toEqual([]);
  });
  test.each([
    [
      "the boundary under a drifted id",
      T3.replace("Container_Boundary(api,", "Container_Boundary(shopApi,"),
      [
        "one container decomposed, and it is api",
        "components only inside that boundary",
        "no drifted alias (queue, cdn, provider, office, shopApi, postgres, redisQueue)",
      ],
    ],
    ["the database under a new id", T3.replace(/\bdb\b/g, "orders_db"), ["neighbours reuse the seeded ids"]],
    [
      "the database under the analytics name",
      T3.replace('"Shop Database"', '"Analytics warehouse"'),
      ["no seeded id used for something else"],
    ],
    [
      "three components",
      T3.replace(/.*Component\(stock.*\n/, "")
        .replace(/.*stock, db.*\n/, "")
        .replace('Rel(backoffice, stock, "Adds stock with")', 'Rel(backoffice, orders, "Looks up orders with")'),
      ["4 to 6 components"],
    ],
    [
      "a neighbour two hops away",
      T3.replace(
        "  Rel(web, orders",
        '  Person(customer, "Customer")\n  Rel(customer, web, "Shops in")\n  Rel(web, orders',
      ),
      ["only direct neighbours"],
    ],
  ])("mutation: %s", async (_name, source, expected) => {
    expect(await judge("norm-component-from-code", { added: { [T3_PATH]: source } })).toEqual(expected);
  });
});

const CONTAINERS_PATH = ".archer/diagrams/containers.mmd";
const T4 =
  CONTAINERS.replace(
    "        ContainerDb(db,",
    '        Container(giftcards, "Gift Card Service", "Go", "Balances and redemptions")\n        ContainerDb(giftcards_db, "Gift Card Database", "PostgreSQL", "Cards and balances")\n        ContainerDb(db,',
  ) +
  '    Rel(web, giftcards, "Checks balances with", "JSON over HTTPS")\n    Rel(api, giftcards, "Redeems cards through", "JSON over HTTPS")\n    Rel(giftcards, giftcards_db, "Reads and writes", "SQL")\n';
const writeCall = { server: "archer", tool: "write_diagram", input: {}, ok: true };
const presentContainers = {
  server: "archer",
  tool: "present_diagram",
  input: { viewId: "containers" },
  ok: true,
  urls: [URL],
  url: URL,
};

describe("T4 norm-extend", () => {
  const edit = (source: string) => ({
    edited: { [CONTAINERS_PATH]: source },
    baseline: { [CONTAINERS_PATH]: CONTAINERS },
    calls: [writeCall, presentContainers],
  });
  test("the good run (an edit of containers) passes; so does a new container view", async () => {
    expect(await judge("norm-extend", edit(T4))).toEqual([]);
    expect(
      await judge("norm-extend", {
        added: { ".archer/diagrams/gift-cards.mmd": T4.replace("Pageturner Containers", "Gift cards") },
      }),
    ).toEqual([]);
  });
  test.each([
    [
      "the Storefront under a new id",
      T4.replace("Rel(web, giftcards", "Rel(storefront, giftcards").replace(
        "        Container(giftcards,",
        '        Container(storefront, "Storefront", "React")\n        Container(giftcards,',
      ),
      ["the existing parts keep their ids (web and api are the ends)"],
    ],
    [
      "an original line changed",
      T4.replace('"Buys books online"', '"Buys books"'),
      ["an edited containers diagram keeps every original line"],
    ],
    [
      "the database as a plain container",
      T4.replace("ContainerDb(giftcards_db", "Container(giftcards_db"),
      ["the gift card service is a container, its database a ContainerDb"],
    ],
  ])("mutation: %s", async (_name, source, expected) => {
    expect(await judge("norm-extend", edit(source))).toEqual(expected);
  });
  test("mutation: a new view whose gift-card database takes the id db (C5)", async () => {
    const view = `C4Container
  title Gift cards
  System_Boundary(pageturner, "Pageturner Online Bookshop") {
    Container(web, "Storefront", "React")
    Container(api, "Shop API", "Node.js")
    Container(giftcards, "Gift Card Service", "Go")
    ContainerDb(db, "Gift Card Database", "PostgreSQL")
  }
  Rel(web, giftcards, "Checks balances with")
  Rel(api, giftcards, "Redeems cards through")
  Rel(giftcards, db, "Reads and writes")
`;
    expect(await judge("norm-extend", { added: { ".archer/diagrams/gift-cards.mmd": view } })).toEqual([
      "the new database does not take the id db",
      "no seeded id used for something else",
    ]);
  });
});

const T5 = `sequenceDiagram
    actor staff as Shop Staff
    participant backoffice as Back Office
    participant api as Shop API
    participant payments as Payment Provider
    participant db as Shop Database
    participant jobs as Job Queue
    participant worker as Worker
    participant email as Email Service
    staff->>backoffice: Refund a damaged book
    backoffice->>api: Refund the order
    api->>payments: Refund the card
    api->>db: Mark the order refunded
    api-)jobs: Queue a receipt email
    worker->>jobs: Take the job
    worker->>email: Send the receipt
`;
const T5_PATH = ".archer/diagrams/refunds.mmd";

describe("T5 norm-flow-over-existing", () => {
  test("the good run passes", async () => {
    expect(await judge("norm-flow-over-existing", { added: { [T5_PATH]: T5 } })).toEqual([]);
  });
  test.each([
    [
      "the provider under the refund flow's alias",
      T5.replace(/payments/g, "provider"),
      [
        "every node or participant is a seeded element, by id",
        "draws every part the person named",
        "no drifted alias (queue, cdn, provider, office, shopApi, postgres, redisQueue)",
      ],
    ],
    [
      "a code-level participant",
      T5.replace("    participant email", "    participant webhooks as webhooks.js\n    participant email").replace(
        "    staff->>",
        "    api->>webhooks: Check\n    staff->>",
      ),
      ["every node or participant is a seeded element, by id", "no mixed level (no code-level part)"],
    ],
    ["the worker left out", T5.replace(/.*worker.*\n/g, ""), ["draws every part the person named"]],
  ])("mutation: %s", async (_name, source, expected) => {
    expect(await judge("norm-flow-over-existing", { added: { [T5_PATH]: source } })).toEqual(expected);
  });
});

const S = NORMALISE.shopInternals;
const TIDY = `C4Container
    title Shop internals
    Person(customer, "Customer")
    Person(staff, "Shop Staff")
    System_Boundary(pageturner, "Pageturner Online Bookshop") {
        Container(web, "Storefront", "React")
        Container(backoffice, "Back Office", "React")
        Container(api, "Shop API", "Node.js, Express")
        ContainerDb(db, "Shop Database", "PostgreSQL 16")
        ContainerQueue(jobs, "Job Queue", "Redis 7")
        Container(worker, "Worker", "Node.js, BullMQ")
    }
    System_Ext(payments, "Payment Provider")
    System_Ext(courier, "Courier")
    System_Ext(email, "Email Service")
    Rel(customer, web, "Buys books in", "HTTPS")
    Rel(staff, backoffice, "Manages stock in", "HTTPS")
    Rel(web, api, "Places orders with", "JSON over HTTPS")
    Rel(backoffice, api, "Manages stock through", "JSON over HTTPS")
    Rel(api, payments, "Opens payments with", "HTTPS")
    Rel(payments, api, "Reports outcomes to", "Webhook")
    Rel(api, db, "Reads and writes", "SQL")
    Rel(api, jobs, "Queues emails and bookings on")
    Rel(worker, jobs, "Takes jobs from")
    Rel(worker, email, "Sends emails through", "HTTPS")
    Rel(worker, courier, "Books collections with", "HTTPS")
`;

describe("T6 norm-refactor", () => {
  const tidy = (source: string, extra: Record<string, string> = {}) => ({
    edited: { [S.path]: source },
    added: extra,
    baseline: { [S.path]: SHOP_INTERNALS },
    calls: [writeCall, { ...presentContainers, input: { viewId: "shop-internals" } }],
  });
  test("the good run passes: one tidy container view in place", async () => {
    expect(await judge("norm-refactor", tidy(TIDY))).toEqual([]);
  });
  test("a split into a container view and a component view keeps the facts through the component boundary", async () => {
    const components = `C4Component
    title Shop API components
    Container(web, "Storefront", "React")
    Container_Boundary(api, "Shop API") {
        Component(orders, "Orders", "Express")
        Component(webhooks, "Webhooks", "Express")
    }
    System_Ext(payments, "Payment Provider")
    Rel(web, orders, "Places orders with")
    Rel(payments, webhooks, "Reports outcomes to")
`;
    const container = TIDY.replace('    Rel(payments, api, "Reports outcomes to", "Webhook")\n', "");
    expect(
      await judge("norm-refactor", tidy(container, { ".archer/diagrams/shop-api-components.mmd": components })),
    ).toEqual([]);
  });
  test.each([
    [
      "the seed left as it was",
      SHOP_INTERNALS,
      [
        "no view mixes levels",
        "drifted ids renamed to the project's ids (shopApi→api, postgres→db, redisQueue→jobs)",
        "words per view at most half the seed's",
        "every view within its band",
      ],
    ],
    ["a fact lost", TIDY.replace(/.*Rel\(worker, courier.*\n/, ""), ["the facts are kept"]],
    [
      "the drifted ids kept",
      TIDY.replace(/\bdb\b/g, "postgres"),
      ["drifted ids renamed to the project's ids (shopApi→api, postgres→db, redisQueue→jobs)"],
    ],
    [
      "a component left in",
      TIDY.replace("    }\n", '        Component(orders, "Orders")\n    }\n').replace(
        "    Rel(web, api",
        '    Rel(api, orders, "Routes to")\n    Rel(web, api',
      ),
      ["no view mixes levels"],
    ],
  ])("mutation: %s", async (_name, source, expected) => {
    expect(await judge("norm-refactor", tidy(source))).toEqual(expected);
  });
});

describe("the report (normalise-report.mjs)", () => {
  test("Fisher's exact test matches the design's worked numbers (ticket 06 §5) and a textbook table", () => {
    expect(fisher(10, 20, 20, 10).two).toBeCloseTo(0.0194, 3);
    expect(fisher(15, 15, 25, 5).two).toBeCloseTo(0.0127, 3);
    // Fisher's tea-tasting table [[3, 1], [1, 3]]: one-sided 0.243, two-sided 0.486.
    expect(fisher(1, 3, 3, 1).greater).toBeCloseTo(0.2429, 3);
    expect(fisher(1, 3, 3, 1).two).toBeCloseTo(0.4857, 3);
    // No difference: P(X ≤ 4) for X ~ Hypergeometric(16, 8, 8) = (1 + 4900/12870) / 2.
    expect(fisher(4, 4, 4, 4)).toEqual({ two: 1, greater: expect.closeTo(0.6904, 3) });
  });

  test("pool counts a rate over the runs that can show it, and leaves T2 out of drift and reuse", () => {
    const run = (task: string, measures: Record<string, unknown>, verdict = "pass") => ({
      task,
      verdict,
      toolCalls: 10,
      archerCalls: 4,
      usage: { seconds: 60, costUsd: 0.5, turns: 12, tokens: { output_tokens: 3000 } },
      measures: {
        written: 1,
        findings: 0,
        zeroFindings: true,
        findingsSeen: 0,
        reused: 5,
        expected: 5,
        drift: [],
        homonyms: [],
        views: [{ family: "c4", mixed: false, inBand: true }],
        words: [{ level: "context", words: 40 }],
        ...measures,
      },
    });
    const p = pool([
      run("norm-context", {}),
      run(
        "norm-context",
        { drift: ["provider"], reused: 4, findings: 2, zeroFindings: false, findingsSeen: 3 },
        "fail",
      ),
      run("norm-containers-control", { drift: ["queue"] }),
    ]);
    expect(p.noDrift).toEqual({ yes: 1, n: 2, rate: 0.5 });
    expect(p.fullReuse).toEqual({ yes: 1, n: 2, rate: 0.5 });
    expect(p.zeroFindings).toEqual({ yes: 2, n: 3, rate: 0.667 });
    expect(p.fixPass).toEqual({ yes: 0, n: 1, rate: 0 });
    expect(p.pass).toEqual({ yes: 2, n: 3, rate: 0.667 });
    expect(p.cost).toMatchObject({ secondsMedian: 60, usdTotal: 1.5, tokensMedian: { output: 3000 } });
  });
});

test("the six tasks are main-set tasks on the normalise fixture, with the canary on their prompts", () => {
  const ids = [
    "norm-context",
    "norm-containers-control",
    "norm-component-from-code",
    "norm-extend",
    "norm-flow-over-existing",
    "norm-refactor",
  ];
  const source = readFileSync(join(__dirname, "../../scripts/evals/v1/normalise.mjs"), "utf8");
  for (const id of ids) {
    const t = task(id);
    expect(t?.set).toBe("main");
    expect(typeof t.layout).toBe("function");
    expect(typeof t.measures).toBe("function");
    const line = source.split("\n").find((l) => l.includes(JSON.stringify(t.prompt)));
    expect(line).toContain("aev-canary-5d1f8e02b7c4");
  }
});

beforeAll(() => {
  expect(NORMALISE.bands).toEqual({ context: 10, container: 15, component: 12 });
});
