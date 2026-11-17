// Rename suggestions for ids that already drifted (ADR 0036 P44): validate_diagram with suggest: true
// names, for the view it checks, the existing ids that look like another element under another id,
// with the probable survivor, its evidence and a rename-plan entry. Opt-in; it never edits a source,
// and the write rule (A22) is unchanged. The acceptance cases are the normalisation eval's own
// fixtures (scripts/evals/v1/normalise.mjs): T6's drifted seed, T2's empty project, T4's gift service.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createApplication } from "../../src/application/index.ts";
import { planRenames } from "../../src/application/rename-plan.ts";
import { ProjectModelCache } from "../../src/application/project-model.ts";
import {
  DEFAULT_SUGGESTIONS,
  SUGGESTION_BUDGET,
  defaultSuggestions,
  suggestionFields,
  suggestionText,
  viewSuggestions,
} from "../../src/application/suggest.ts";
import type { ProjectModel } from "../../src/project-model/merge.ts";
import { main } from "../../src/bin/main.ts";
import { findProject } from "../../src/project/index.ts";
// @ts-expect-error -- a plain .mjs script without types
import { SHOP_INTERNALS, normaliseLayout } from "../../scripts/evals/v1/normalise.mjs";
import { cleanUp, tempDir, write } from "../service/support.ts";

afterEach(cleanUp);

interface Suggestion {
  id: string;
  label: string;
  views: string[];
  to?: string;
  toLabel?: string;
  toViews?: string[];
  similarity: number;
  evidence: { matched: string; labels: [string, string] };
  candidates?: { id: string; label: string; views: string[]; similarity: number }[];
  revisions: Record<string, string | null>;
  competing?: string[];
  withinView?: boolean;
  entry?: { from: string; to: string; views: string[]; why: string };
}

const DEMO = resolve(__dirname, "../fixtures/pageturner");
const ARCHER_2422068 = resolve(__dirname, "../fixtures/project-model/archer-2422068");
const tools = { demo: DEMO, agentsMd: "# Agents\n", skills: () => {}, commit: () => {} };
const normalise = (internals: boolean): string =>
  normaliseLayout(tempDir("archer-suggest-"), tools, { internals }).project;
const suggestionsOf = (r: { structured: Record<string, unknown> }): Suggestion[] =>
  r.structured["suggestions"] as Suggestion[];
const renames = (list: Suggestion[]): string[] =>
  list
    .filter((s) => s.to !== undefined)
    .map((s) => `${s.id}→${s.to}`)
    .sort();

async function cli(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "",
    err = "";
  const code = await main(args, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    isTTY: false,
    columns: undefined,
    env: {},
    cwd,
  });
  return { code, out, err };
}

/** No id is renamed two ways, and no survivor is itself renamed (never contradictory, §10). */
function consistent(list: Suggestion[]): void {
  const from = list.map((s) => s.id);
  expect(new Set(from).size).toBe(from.length);
  for (const s of list) if (s.to !== undefined) expect(from).not.toContain(s.to);
}

test("T6: the drifted seed is told shopApi → api, postgres → db, redisQueue → jobs, with evidence and a plan entry", async () => {
  const root = normalise(true);
  const app = createApplication({ cwd: root });
  try {
    const checked = await app.call("validate_diagram", {
      viewId: "shop-internals",
      source: SHOP_INTERNALS,
      suggest: true,
    });
    expect(checked.structured["valid"]).toBe(true);
    const list = suggestionsOf(checked);
    expect(renames(list)).toEqual(expect.arrayContaining(["postgres→db", "redisQueue→jobs", "shopApi→api"]));
    consistent(list);
    const api = list.find((s) => s.id === "shopApi")!;
    expect(api).toMatchObject({
      label: "Shop API",
      views: ["shop-internals"],
      to: "api",
      toLabel: "Shop API",
      similarity: 1,
      evidence: { matched: "api", labels: ["Shop API", "Shop API"] },
    });
    expect(api.toViews).toContain("containers");
    // Ruling 2026-11-06: within the checked view a rename is part of the change asked for.
    expect(api.withinView).toBe(true);
    expect(list.find((s) => s.id === "queue")?.withinView).toBe(false);
    expect(checked.text).toMatch(
      /\nRename in shop-internals as part of this change; for other views, ask the person first\.\n/,
    );
    expect(api.entry).toEqual({
      from: "shopApi",
      to: "api",
      views: ["shop-internals"],
      why: expect.stringContaining("'shopApi' (Shop API) and 'api' (Shop API)"),
    });
    // The revisions a write of each named view would pass as expectedRevision.
    const read = await app.call("read_diagram", { viewId: "containers" });
    expect(api.revisions["containers"]).toBe(read.structured["sourceRevision"]);
    expect(api.revisions["shop-internals"]).toBe(
      (await app.call("read_diagram", { viewId: "shop-internals" })).structured["sourceRevision"],
    );
    // Separate from advice: the seed's own ids are not new (A22 unchanged), so advice has no duplicate.
    expect(((checked.structured["advice"] ?? []) as { code: string }[]).map((a) => a.code)).not.toContain(
      "possible_duplicate",
    );
    expect(checked.text).toMatch(
      /\nRename suggestions \(nothing was changed\):\n- shopApi → api in shop-internals: 'Shop API' \(1\.00\)\n/,
    );
    // Short lines, the most similar first: output cut at a few thousand characters keeps the best.
    const lines = checked.text
      .slice(
        checked.text.indexOf("\nRename suggestions"),
        checked.text.indexOf("for other views, ask the person first."),
      )
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(120);
    const scores = list.filter((x) => x.to !== undefined).map((x) => x.similarity);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
    // An ER entity is not a person of the same name: kinds that share nothing are never one thing.
    expect(list.map((s) => s.id)).not.toContain("CUSTOMER");
    // Nothing was written.
    expect(readFileSync(join(root, ".archer/diagrams/shop-internals.mmd"), "utf8")).toBe(SHOP_INTERNALS);
  } finally {
    app.close();
  }
});

test("T6: the suggested entries make a plan that dry-runs clean, and the tidied seed has none of them left", async () => {
  const root = normalise(true);
  const app = createApplication({ cwd: root });
  try {
    const list = suggestionsOf(
      await app.call("validate_diagram", { viewId: "shop-internals", source: SHOP_INTERNALS, suggest: true }),
    );
    const entries = list
      .filter((s) => s.views.includes("shop-internals") && s.entry !== undefined)
      .map((s) => s.entry!);
    expect(entries.map((e) => `${e.from}→${e.to}`).sort()).toEqual(["postgres→db", "redisQueue→jobs", "shopApi→api"]);
    const plan = await planRenames(app, findProject(root), entries);
    expect(plan.problems).toEqual([]);
    const write = plan.writes.find((w) => w.kind === "diagram" && w.viewId === "shop-internals")!;
    const after = suggestionsOf(
      await app.call("validate_diagram", {
        viewId: "shop-internals",
        source: (write as { source: string }).source,
        suggest: true,
      }),
    );
    expect(after.filter((s) => s.views.includes("shop-internals"))).toEqual([]);
  } finally {
    app.close();
  }
});

// Decided 2026-11-06: shown by default on an existing view (agents skipped the opt-in and its hint).
test("validating an existing view lists its first 5 definite suggestions by default, its own renames first", async () => {
  const app = createApplication({ cwd: normalise(true) });
  try {
    const checked = await app.call("validate_diagram", { viewId: "shop-internals", source: SHOP_INTERNALS });
    const list = suggestionsOf(checked);
    expect(list).toHaveLength(5);
    expect(list.every((s) => s.entry !== undefined)).toBe(true);
    expect(
      list
        .slice(0, 3)
        .map((s) => `${s.id}→${s.to}`)
        .sort(),
    ).toEqual(["postgres→db", "redisQueue→jobs", "shopApi→api"]);
    expect(list.slice(0, 3).every((s) => s.withinView === true)).toBe(true);
    expect(checked.structured["suggestionsTruncated"]).toBe(true);
    expect(checked.text).toMatch(/\nRename suggestions \(nothing was changed\):\n- shopApi → api in shop-internals/);
    expect(checked.text).toMatch(/\n1 more: validate again with suggest: true for all\.\n/);
    expect(checked.text).not.toMatch(/Tidying names\?/);
    expect(checked.structured).not.toHaveProperty("hints");
    // Right after the first line, before the diagnostics and advice: output cut at ~2,500 characters keeps it.
    expect(checked.text).toMatch(
      /^Valid, with diagnostics\.\nRename suggestions \(nothing was changed\):\n- shopApi → api[\s\S]*\nDiagnostics:\n\[/,
    );
    expect(checked.text.indexOf("Rename in shop-internals as part of this change")).toBeLessThan(
      checked.text.indexOf("[nest_level_mismatch]"),
    );
    expect(checked.text.indexOf("[nest_level_mismatch]")).toBeLessThan(checked.text.indexOf("Advice ("));
    // suggest: true gives the whole list; suggest: false none.
    const all = suggestionsOf(
      await app.call("validate_diagram", { viewId: "shop-internals", source: SHOP_INTERNALS, suggest: true }),
    );
    expect(renames(all)).toHaveLength(6);
    const off = await app.call("validate_diagram", {
      viewId: "shop-internals",
      source: SHOP_INTERNALS,
      suggest: false,
    });
    expect(off.structured).not.toHaveProperty("suggestions");
    expect(off.text).not.toMatch(/Rename suggestions/);
  } finally {
    app.close();
  }
});

test("by default nothing is listed for a project of one view, or a view with nothing drifted", async () => {
  const alone = project({ one: C4('Container(a, "Shop API")\n') });
  const single = createApplication({ cwd: alone });
  try {
    const r = await single.call("validate_diagram", { viewId: "one", source: C4('Container(a, "Shop API")\n') });
    // Layout progress is separate from the unchanged empty rename-suggestion result.
    expect(r.text).toMatch(
      /^Valid\.(?:\nLayout review pending \(non-blocking\)\. Run measure_diagram with the inspect arguments to get the result; it is not delivered automatically\.)?$/,
    );
    expect(r.structured.layoutReview).toMatchObject({ version: 1, profile: "desktop-1025x896-gutter24" });
    expect(r.structured).not.toHaveProperty("suggestions");
  } finally {
    single.close();
  }
  const cwd = project({
    a: C4('Container(api, "Shop API")\n'),
    b: C4('Container(shopApi, "Shop API")\n'),
    t: C4('Container(worker, "Worker")\n'),
  });
  const app = createApplication({ cwd });
  try {
    // An existing view with no drift: no line at all.
    const clean = await app.call("validate_diagram", { viewId: "t", source: C4('Container(worker, "Worker")\n') });
    expect(clean.text).toMatch(
      /^Valid\.(?:\nLayout review pending \(non-blocking\)\. Run measure_diagram with the inspect arguments to get the result; it is not delivered automatically\.)?$/,
    );
    expect(clean.structured).not.toHaveProperty("suggestions");
    expect(clean.structured.layoutReview).toMatchObject({ version: 1, profile: "desktop-1025x896-gutter24" });
  } finally {
    app.close();
  }
});

test("archer validate lists them by default too, in its own words; --no-suggest turns them off", async () => {
  const root = normalise(true);
  const text = await cli(root, ["validate", "shop-internals"]);
  expect(text.out).toMatch(/- shopApi → api in shop-internals/);
  expect(text.out).toContain("1 more: run archer validate shop-internals --suggest for all.");
  // The status line, then the suggestions, then the diagnostics and advice.
  expect(text.out).toMatch(
    /^\.archer\/diagrams\/shop-internals\.mmd: ok, \d+ warnings\nRename suggestions \(nothing was changed\):\n- shopApi → api/,
  );
  expect(text.out.indexOf("for other views, ask the person first.")).toBeLessThan(
    text.out.indexOf("shop-internals.mmd:1"),
  );
  const json = JSON.parse((await cli(root, ["validate", "shop-internals", "--json"])).out) as {
    suggestions: Suggestion[];
    suggestionsTruncated?: boolean;
  };
  expect(json.suggestions).toHaveLength(5);
  expect(json.suggestionsTruncated).toBe(true);
  const off = await cli(root, ["validate", "shop-internals", "--no-suggest", "--json"]);
  expect(off.code).toBe(0);
  expect(JSON.parse(off.out)).not.toHaveProperty("suggestions");
  expect((await cli(root, ["validate", "shop-internals", "--no-suggest"])).out).not.toMatch(/Rename suggestions/);
  expect((await cli(root, ["validate", "shop-internals", "--suggest", "--no-suggest"])).code).toBe(2);
});

test("a draft is checked as it would be written: an id the draft already renamed is not suggested", async () => {
  const app = createApplication({ cwd: normalise(true) });
  try {
    const tidied = SHOP_INTERNALS.replace(/\bshopApi\b/g, "api");
    const list = suggestionsOf(
      await app.call("validate_diagram", { viewId: "shop-internals", source: tidied, suggest: true }),
    );
    expect(list.map((s) => s.id)).not.toContain("shopApi");
    expect(renames(list)).toEqual(expect.arrayContaining(["postgres→db", "redisQueue→jobs"]));
  } finally {
    app.close();
  }
});

test("T2: a fresh project after archer init has nothing to suggest", async () => {
  const root = tempDir("archer-suggest-");
  expect((await cli(root, ["init"])).code).toBe(0);
  // The agent's first diagram, written with file tools and then checked: nothing else to look like.
  const draft = `C4Container\nPerson(customer, "Customer")\nContainer(api, "Shop API", "Node.js")\nContainerDb(db, "Shop Database", "PostgreSQL")\nRel(customer, api, "Buys through", "HTTPS")\nRel(api, db, "Reads and writes", "SQL")\n`;
  write(root, ".archer/diagrams/containers.mmd", draft);
  const app = createApplication({ cwd: root });
  try {
    const checked = await app.call("validate_diagram", { viewId: "containers", source: draft, suggest: true });
    expect(checked.structured["suggestions"]).toEqual([]);
    expect(checked.text).toMatch(
      /\nNo rename suggestions\.(?:\nLayout review pending \(non-blocking\)\. Run measure_diagram with the inspect arguments to get the result; it is not delivered automatically\.)?$/,
    );
    expect(checked.structured.layoutReview).toMatchObject({ version: 1, profile: "desktop-1025x896-gutter24" });
  } finally {
    app.close();
  }
});

test("T4: a genuinely new gift card service and its database are not suggested as anything else", async () => {
  const root = normalise(false);
  const app = createApplication({ cwd: root });
  try {
    const containers = readFileSync(join(root, ".archer/diagrams/containers.mmd"), "utf8");
    const draft = containers
      .replace(
        "        ContainerDb(db,",
        '        Container(gift, "Gift Card Service", "Go", "Balances and redemptions")\n        ContainerDb(giftDb, "Gift Card Database", "PostgreSQL", "Cards and balances")\n        ContainerDb(db,',
      )
      .concat(
        '    Rel(web, gift, "Checks balances with", "JSON over HTTPS")\n    Rel(api, gift, "Redeems cards through", "JSON over HTTPS")\n    Rel(gift, giftDb, "Reads and writes", "SQL")\n',
      );
    const list = suggestionsOf(
      await app.call("validate_diagram", { viewId: "containers", source: draft, suggest: true }),
    );
    for (const s of list) {
      expect(s.id).not.toMatch(/gift/i);
      expect(s.to ?? "").not.toMatch(/gift/i);
      for (const c of s.candidates ?? []) expect(c.id).not.toMatch(/gift/i);
    }
    consistent(list);
  } finally {
    app.close();
  }
});

test("suggest is for one view: it is refused with project: true", async () => {
  const app = createApplication({ cwd: normalise(true) });
  try {
    const refused = await app
      .call("validate_diagram", { project: true, suggest: true })
      .catch((e: { message: string }) => e);
    expect((refused as { message: string }).message).toMatch(/suggest: cannot be sent with project: true/);
  } finally {
    app.close();
  }
});

// ------------------------------------------------------------------ grouping and resolution

const C4 = (body: string) => `C4Container\n${body}`;
function project(views: Record<string, string>): string {
  const cwd = tempDir("archer-suggest-");
  write(cwd, "archer.toml", "version = 1\n");
  for (const [id, source] of Object.entries(views)) write(cwd, `.archer/diagrams/${id}.mmd`, source);
  return cwd;
}
async function suggest(cwd: string, viewId: string): Promise<Suggestion[]> {
  const app = createApplication({ cwd });
  try {
    const source = readFileSync(join(cwd, `.archer/diagrams/${viewId}.mmd`), "utf8");
    return suggestionsOf(await app.call("validate_diagram", { viewId, source, suggest: true }));
  } finally {
    app.close();
  }
}

test("a chain resolves to its one survivor: no id is renamed to an id that is itself renamed", async () => {
  // queue (in one view) looks like jobs and like redisQueue; redisQueue looks like jobs. jobs is the most drawn.
  const cwd = project({
    a: C4('ContainerQueue(jobs, "Job Queue")\n'),
    b: C4('ContainerQueue(jobs, "Job Queue")\nContainer(w, "Worker")\n'),
    c: C4('ContainerQueue(redisQueue, "Job Queue")\n'),
    d: C4('ContainerQueue(queue, "Job queue")\n'),
  });
  const list = await suggest(cwd, "d");
  expect(renames(list)).toEqual(["queue→jobs", "redisQueue→jobs"]);
  consistent(list);
});

test("two survivors for one id is ambiguous: the candidates are named and no rename is planned", async () => {
  // ordersApi and ordersService are drawn side by side in c, so they are two things; orders looks like both.
  const cwd = project({
    a: C4('Container(ordersApi, "Orders API")\n'),
    b: C4('Container(ordersService, "Orders API")\n'),
    c: C4('Container(ordersApi, "Orders API")\nContainer(ordersService, "Orders Service")\n'),
    t: C4('Container(orders, "Orders API")\n'),
  });
  const list = await suggest(cwd, "t");
  const orders = list.find((s) => s.id === "orders")!;
  expect(orders.to).toBeUndefined();
  expect(orders.entry).toBeUndefined();
  expect(orders.candidates!.map((c) => c.id).sort()).toEqual(["ordersApi", "ordersService"]);
  expect(list.map((s) => s.id)).toEqual(["orders"]);
});

test("a system in one view and a container in another may be one thing at two levels; a table is not a person", async () => {
  const cwd = project({
    context: 'C4Context\nSystem(state, "Account state")\n',
    containers: C4('ContainerDb(account, "Account state")\nContainer(api, "API")\n'),
    data: 'erDiagram\n  ACCOUNT_STATE["Account state"] {\n    string id\n  }\n',
  });
  const list = await suggest(cwd, "context");
  expect(renames(list)).toEqual(["state→account"]);
});

test("siblings and two boxes of one drawing are never one thing", async () => {
  const cwd = project({
    a: C4('Container(hostA, "Agent host A")\nContainer(hostB, "Agent host B")\n'),
    t: C4('Container(host, "Agent host")\nContainer(cache, "Cache")\nContainer(cache2, "Cache")\n'),
  });
  expect(await suggest(cwd, "t")).toEqual([]);
});

test("only pairs that touch the checked view are suggested", async () => {
  const cwd = project({
    a: C4('Container(api, "Shop API")\n'),
    b: C4('Container(shopApi, "Shop API")\n'),
    t: C4('Container(worker, "Worker")\n'),
  });
  expect(await suggest(cwd, "t")).toEqual([]);
  expect(renames(await suggest(cwd, "b"))).toEqual(["shopApi→api"]);
  expect(renames(await suggest(cwd, "a"))).toEqual(["shopApi→api"]);
});

// ------------------------------------------------------------------ the entries, taken together (R13-01 to R13-03)

/** The suggestions for `viewId`, and the plan their entries make together: it must be ready. */
async function planned(
  cwd: string,
  viewId: string,
): Promise<{ list: Suggestion[]; ready: boolean; problems: unknown[] }> {
  const app = createApplication({ cwd });
  try {
    const source = readFileSync(join(cwd, `.archer/diagrams/${viewId}.mmd`), "utf8");
    const list = suggestionsOf(await app.call("validate_diagram", { viewId, source, suggest: true }));
    const plan = await planRenames(
      app,
      findProject(cwd),
      list.flatMap((s) => (s.entry === undefined ? [] : [s.entry])),
    );
    return { list, ready: plan.ready, problems: [...plan.problems] };
  } finally {
    app.close();
  }
}

test("a chain does not end on an id its source is drawn beside: c → b → a with a and c in one view", async () => {
  const cwd = project({
    one: C4('Container(a, "Shop API")\nContainer(c, "Shop API")\n'),
    two: C4('Container(b, "Shop API")\n'),
  });
  const { list, ready, problems } = await planned(cwd, "one");
  expect(problems).toEqual([]);
  expect(ready).toBe(true);
  expect(list.find((s) => s.id === "c")?.entry).toBeUndefined();
  expect(renames(list)).toEqual(["b→a"]);
});

test("two ids of one view that both look like one survivor are ambiguous, not two renames onto it", async () => {
  const cwd = project({
    one: C4('Container(b, "Shop API")\nContainer(c, "Shop API")\n'),
    two: C4('Container(a, "Shop API")\n'),
    three: C4('Container(a, "Shop API")\n'),
  });
  const { list, ready, problems } = await planned(cwd, "one");
  expect(problems).toEqual([]);
  expect(ready).toBe(true);
  for (const id of ["b", "c"]) {
    const s = list.find((x) => x.id === id)!;
    expect(s.to).toBeUndefined();
    expect(s.entry).toBeUndefined();
    expect(s.candidates!.map((c) => c.id)).toEqual(["a"]);
    expect(s.competing).toEqual([id === "b" ? "c" : "b"]);
  }
  expect(suggestionText({ suggestions: list as never }, "one")).toMatch(
    /- b \('Shop API', in one\) looks like a, not offered: in one, 'b' and 'c' would both become 'a' in this view/,
  );
});

test("a survivor's id already used in the source's view, by an unkinded step, is not suggested", async () => {
  const cwd = project({
    one: "flowchart LR\n z[Shop API]:::container\n api[Validate Input]\n",
    two: C4('Container(api, "Shop API")\n'),
  });
  const { list, ready, problems } = await planned(cwd, "one");
  expect(problems).toEqual([]);
  expect(ready).toBe(true);
  expect(list.some((s) => s.entry !== undefined)).toBe(false);
});

test("a table is not renamed to a person through an id drawn as both", async () => {
  const cwd = project({
    one: C4('Person(a, "Customer")\n'),
    two: C4('Person(a, "Customer")\n'),
    three: C4('Person(a, "Customer")\n'),
    four: C4('Person(b, "Customer")\n'),
    five: 'erDiagram\n b["Customer"] {\n string id\n }\n',
    six: 'erDiagram\n c["Customer"] {\n string id\n }\n',
  });
  const { list, ready } = await planned(cwd, "six");
  expect(ready).toBe(true);
  expect(list.some((s) => s.id === "c" && (s.to === "a" || s.entry !== undefined))).toBe(false);
  await classSafe(cwd, list);
  expect(list.find((s) => s.id === "c")).toMatchObject({
    candidates: [{ id: "b" }],
    blocked: { problem: "'b' is drawn as a table and a person: settle what it is first" },
  });
  // b itself is drawn as a person and a table: it is no one's survivor and not renamed either.
  const { list: fromFour } = await planned(cwd, "four");
  expect(fromFour.filter((s) => s.entry !== undefined)).toEqual([]);
});

/** No entry renames across classes: a person, a table and a part of the system are never one id. */
async function classSafe(cwd: string, list: Suggestion[], cache = new ProjectModelCache()): Promise<void> {
  const { model } = await cache.build(findProject(cwd));
  const classes = (id: string) =>
    new Set(
      model.elements
        .find((e) => e.id === id)!
        .kinds.map((k) => (k.value === "person" || k.value === "code" ? k.value : "part")),
    );
  for (const s of list)
    if (s.entry !== undefined)
      expect(
        new Set([...classes(s.entry.from), ...classes(s.entry.to)]).size,
        `${s.entry.from} → ${s.entry.to}`,
      ).toBeLessThanOrEqual(1);
}

test("T6 and archer at 2422068: every view's entries, taken together, make a ready plan across one class", async () => {
  const t6 = normalise(true);
  const t6Plan = await planned(t6, "shop-internals");
  expect(t6Plan.problems).toEqual([]);
  expect(renames(t6Plan.list)).toEqual(expect.arrayContaining(["postgres→db", "redisQueue→jobs", "shopApi→api"]));
  await classSafe(t6, t6Plan.list);
  // archer's own folder, every view that contributes, copied so the dry run reads a project of its own.
  const archer = tempDir("archer-suggest-2422068-");
  cpSync(ARCHER_2422068, archer, { recursive: true });
  const app = createApplication({ cwd: archer });
  try {
    // One cache for the loop: the dry runs write nothing, so a cold build per view (twice) only cost time, and ran
    // this test out of 60 s under stress (O268).
    const cache = new ProjectModelCache();
    const { model } = await cache.build(findProject(archer));
    let offered = 0;
    for (const v of model.views.filter((x) => x.contributes)) {
      const read = await app.call("read_diagram", { viewId: v.id });
      const source = (read.structured["source"] as { text?: string }).text!;
      const list = suggestionsOf(await app.call("validate_diagram", { viewId: v.id, source, suggest: true }));
      const entries = list.flatMap((s) => (s.entry === undefined ? [] : [s.entry]));
      offered += entries.length;
      const plan = await planRenames(app, findProject(archer), entries, cache);
      expect(plan.problems, v.id).toEqual([]);
      await classSafe(archer, list, cache);
    }
    expect(offered).toBeGreaterThan(0);
  } finally {
    app.close();
  }
}, 60_000);

test("asked of a source that does not compile: an empty list and why, in one shape for the API, the CLI and its JSON", async () => {
  const broken = "flowchart LR\n a --> b\n";
  const cwd = project({ one: broken });
  const app = createApplication({ cwd });
  let said: string;
  try {
    const r = await app.call("validate_diagram", { viewId: "one", source: broken, suggest: true });
    expect(r.structured["valid"]).toBe(false);
    expect(r.structured["suggestions"]).toEqual([]);
    expect(r.structured["suggestionsUnavailable"]).toBe("does_not_compile");
    said = suggestionText({ suggestions: [], suggestionsUnavailable: "does_not_compile" }, "one").replace(/^\n/, "");
    expect(r.text).toContain(said);
  } finally {
    app.close();
  }
  const text = await cli(cwd, ["validate", "one", "--suggest"]);
  expect(text.code).toBe(1);
  expect(text.out).toContain(said);
  const json = await cli(cwd, ["validate", "one", "--suggest", "--json"]);
  expect(json.code).toBe(1);
  expect(JSON.parse(json.out)).toMatchObject({ suggestions: [], suggestionsUnavailable: "does_not_compile" });
});

// ------------------------------------------------------------------ the CLI

test("archer validate <view> --suggest prints the suggestions, and --json carries them", async () => {
  const root = normalise(true);
  const text = await cli(root, ["validate", "shop-internals", "--suggest"]);
  expect(text.code).toBe(0);
  expect(text.out).toMatch(/Rename suggestions \(nothing was changed\):\n- shopApi → api in shop-internals/);
  const json = await cli(root, ["validate", "shop-internals", "--suggest", "--json"]);
  expect(json.code).toBe(0);
  const value = JSON.parse(json.out) as { suggestions: Suggestion[] };
  expect(renames(value.suggestions)).toEqual(expect.arrayContaining(["postgres→db", "redisQueue→jobs", "shopApi→api"]));
  // --suggest is the whole list: nothing truncated.
  expect(value).not.toHaveProperty("suggestionsTruncated");
  // compile takes no --suggest.
  expect((await cli(root, ["compile", "shop-internals", "--suggest"])).code).toBe(2);
});

test("archer call validate_diagram --source takes suggest: true", async () => {
  const root = normalise(true);
  const dir = mkdtempSync(join(tmpdir(), "archer-suggest-call-"));
  writeFileSync(join(dir, "draft.mmd"), SHOP_INTERNALS);
  writeFileSync(join(dir, "args.json"), JSON.stringify({ viewId: "shop-internals", suggest: true }));
  const r = await cli(root, [
    "call",
    "validate_diagram",
    "--source",
    join(dir, "draft.mmd"),
    "--file",
    join(dir, "args.json"),
    "--json",
  ]);
  expect(r.code).toBe(0);
  const value = JSON.parse(r.out) as { structuredContent?: { suggestions: Suggestion[] }; suggestions?: Suggestion[] };
  expect(renames((value.structuredContent ?? value).suggestions!)).toEqual(expect.arrayContaining(["shopApi→api"]));
});

test("the cache reuses a list for one signature and computes again for another", async () => {
  const { SuggestionCache } = await import("../../src/application/suggest.ts");
  const cache = new SuggestionCache();
  const one = cache.get("a", () => ({ suggestions: [], scored: 0 }));
  expect(
    cache.get("a", () => {
      throw new Error("scanned again");
    }),
  ).toBe(one);
  cache.get("b", () => ({ suggestions: [], scored: 0 }));
  expect(cache.scans).toBe(2);
});

// ------------------------------------------------------------------ cost and budgets (R13-04)

describe("the suggestion scan is bounded", () => {
  const element = (i: number, name = `Element ${i}`) => {
    const id = `e${String(i).padStart(6, "0")}`;
    return {
      id,
      name,
      kinds: [{ value: "container", views: [`v${i}`] }],
      parents: [],
      drawnIn: [`v${i}`],
      opensIn: [],
      occurrences: [{ id, label: name, viewId: `v${i}`, family: "c4", kind: "container" }],
      conflicts: [],
    };
  };
  const model = (n: number, name?: (i: number) => string | undefined) =>
    ({
      schemaVersion: 1,
      elements: Array.from({ length: n }, (_, i) => element(i, name?.(i))),
      relationships: [],
      views: [],
      index: [],
      flowcharts: [],
    }) as unknown as ProjectModel;

  test("800 elements and one look-alike: the checked view's ids against the population, not every pair", () => {
    const found = viewSuggestions(
      model(800, (i) => (i === 1 ? "Element 0" : undefined)),
      "v1",
      new Map(),
    );
    expect(found.suggestions.map((s) => `${s.id}→${s.to}`)).toEqual(["e000001→e000000"]);
    expect(found.incomplete).toBeUndefined();
    // v1's one id against 799, then e000000 (reached) against the 798 not yet scanned.
    expect(found.scored).toBeLessThanOrEqual(2 * 800);
  });

  test("800 look-alikes: the scan stops at its budget and says the list is incomplete", () => {
    const found = viewSuggestions(
      model(800, () => "Shop API"),
      "v5",
      new Map(),
    );
    expect(found.incomplete).toBe(true);
    expect(found.scored).toBeLessThanOrEqual(SUGGESTION_BUDGET.scored);
    expect(found.suggestions.length).toBeLessThanOrEqual(SUGGESTION_BUDGET.suggestions);
    expect(suggestionText(suggestionFields(found), "v5")).toMatch(/incomplete/);
    // The default list (an existing view, no suggest) is the same scan, cut to 5, and says so too.
    const shown = defaultSuggestions(suggestionFields(found));
    expect(shown.suggestions.length).toBeLessThanOrEqual(DEFAULT_SUGGESTIONS);
    expect(shown.suggestionsIncomplete).toBe(true);
    expect(suggestionText(shown, "v5")).toMatch(/incomplete/);
  });
});

test("in structured output and archer validate --json, the suggestions come before the diagnostics", async () => {
  const cwd = normalise(true);
  const app = createApplication({ cwd });
  try {
    const checked = await app.call("validate_diagram", { viewId: "shop-internals", source: SHOP_INTERNALS });
    const keys = Object.keys(checked.structured);
    expect(keys.indexOf("suggestions")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("suggestions")).toBeLessThan(keys.indexOf("diagnostics"));
  } finally {
    app.close();
  }
  const { out } = await cli(cwd, ["validate", "shop-internals", "--json"]);
  expect(out.indexOf('"suggestions"')).toBeGreaterThan(0);
  expect(out.indexOf('"suggestions"')).toBeLessThan(out.indexOf('"diagnostics"'));
});
