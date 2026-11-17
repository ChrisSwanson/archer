// The project model merge (ADR 0036 §1–§6, A3–A5), on views compiled by the production compiler.
import { describe, expect, test } from "vitest";
import {
  mergeProjectModel,
  replaceView,
  type ModelElement,
  type ModelInputView,
  type ProjectModel,
} from "../../src/project-model/merge.ts";
import type { GraphModel } from "../../src/model/index.ts";
import { view } from "./support.ts";

const element = (model: ProjectModel, id: string): ModelElement => {
  const found = model.elements.find((e) => e.id === id);
  if (found === undefined) throw new Error(`no element ${id}; have ${model.elements.map((e) => e.id).join(", ")}`);
  return found;
};
const ids = (model: ProjectModel): string[] => model.elements.map((e) => e.id);
const pair = (model: ProjectModel, from: string, to: string) =>
  model.relationships.find((r) => r.from === from && r.to === to);

const SHOP = `C4Container
Person(user, "Shopper")
Enterprise_Boundary(corp, "Corp") {
  System_Boundary(shop, "Shop") {
    Boundary(grp, "Group") {
      Container(web, "Web", "React")
    }
    ContainerDb(db, "Orders DB", "Postgres")
  }
}
System_Ext(pay, "Payments")
Rel(user, web, "uses")
BiRel(web, db, "reads", "SQL")
Rel(web, pay, "charges")
`;

describe("what each family contributes (§1, A3)", () => {
  test("C4: elements and element boundaries join; enterprise and generic boundaries are frames, passed through for parents", async () => {
    const model = mergeProjectModel([await view("shop", SHOP)]);
    expect(ids(model)).toEqual(["db", "pay", "shop", "user", "web"]);
    expect(element(model, "web")).toMatchObject({
      name: "Web",
      kinds: [{ value: "container", views: ["shop"] }],
      parents: [{ value: "shop", views: ["shop"] }],
      path: ["shop"],
      technology: "React",
      drawnIn: ["shop"],
      opensIn: [],
    });
    expect(element(model, "shop")).toMatchObject({
      kinds: [{ value: "system" }],
      parents: [],
      path: [],
      drawnIn: [],
      opensIn: ["shop"],
    });
    expect(element(model, "db")).toMatchObject({ shape: "database", technology: "Postgres" });
    expect(element(model, "pay")).toMatchObject({ external: true, kinds: [{ value: "system" }] });
  });

  test("flowchart: only kinded nodes join; database is a container; external alone and plain steps do not", async () => {
    const flow = await view(
      "flow",
      `flowchart LR
  api[API]:::container
  db[(DB)]:::database
  ext[Ext]:::external
  who[User]:::person
  step[Do it]
  who e0@--> api
  api e1@--> db
  api e2@--> step
  api e3@--> ext
`,
    );
    const model = mergeProjectModel([flow]);
    expect(ids(model)).toEqual(["api", "db", "who"]);
    expect(element(model, "db")).toMatchObject({ kinds: [{ value: "container" }], shape: "database" });
    // Only edges whose two ends joined.
    expect(model.relationships.map((r) => `${r.from}>${r.to}`)).toEqual(["api>db", "who>api"]);
  });

  test("flowchart: a subgraph is a parent only when its id is an element elsewhere; a plain subgraph is a frame", async () => {
    const flow = await view(
      "flow",
      `flowchart LR
  subgraph web [Web app]
    subgraph inner [Inner]
      ui[UI]:::component
    end
  end
  subgraph tools [Tools]
    cli[CLI]:::component
  end
  ui e1@--> cli
`,
    );
    const alone = mergeProjectModel([flow]);
    expect(element(alone, "ui").parents).toEqual([]);
    expect(ids(alone)).toEqual(["cli", "ui"]);
    const c4 = await view("ctx", `C4Context\nSystem(web, "Web")\n`);
    const both = mergeProjectModel([flow, c4]);
    expect(element(both, "ui")).toMatchObject({ parents: [{ value: "web", views: ["flow"] }], path: ["web"] });
    expect(element(both, "web")).toMatchObject({
      drawnIn: ["ctx"],
      opensIn: ["flow"],
      kinds: [{ value: "system", views: ["ctx"] }],
    });
    expect(element(both, "cli").parents).toEqual([]);
    expect(ids(both)).not.toContain("tools");
    expect(ids(both)).not.toContain("inner");
  });

  test("architecture: services join with no kind, a group is never a parent, and a missing kind never conflicts", async () => {
    const arch = await view(
      "topology",
      `architecture-beta
  group host(server)[Host]
  service web(server)[Web server] in host
  service db(database)[DB]
  web:R --> L:db
`,
    );
    const c4 = await view("ctx", `C4Container\nContainer(web, "Web")\n`);
    const model = mergeProjectModel([arch, c4]);
    expect(ids(model)).toEqual(["db", "web"]);
    expect(element(model, "db").kinds).toEqual([]);
    expect(element(model, "web")).toMatchObject({
      kinds: [{ value: "container", views: ["ctx"] }],
      parents: [],
      conflicts: [],
    });
  });

  test("ER: entities join as code", async () => {
    const model = mergeProjectModel([
      await view("data", `erDiagram\n  CUSTOMER\n  ORDER\n  CUSTOMER ||--o{ ORDER : places\n`),
    ]);
    expect(element(model, "CUSTOMER").kinds).toEqual([{ value: "code", views: ["data"] }]);
  });

  test("sequence: participants are weak, adding drawn-in only; a sequence-only element takes its label as its name", async () => {
    const seq = await view(
      "login",
      `sequenceDiagram\n  participant web as Browser tab\n  participant auth as Auth\n  web->>auth: login\n`,
    );
    const c4 = await view("ctx", SHOP);
    const model = mergeProjectModel([seq, c4]);
    expect(element(model, "web")).toMatchObject({
      name: "Web",
      kinds: [{ value: "container", views: ["ctx"] }],
      parents: [{ value: "shop", views: ["ctx"] }],
      drawnIn: ["ctx", "login"],
    });
    expect(element(model, "auth")).toMatchObject({ name: "Auth", kinds: [], parents: [], drawnIn: ["login"] });
  });

  test("state and journey add nothing", async () => {
    const model = mergeProjectModel([
      await view("life", `stateDiagram-v2\n  state open\n  state done\n  [*] --> open\n  open --> done\n`),
      await view("day", `journey\n  title Day\n  section Work\n    Code: 5: me\n`),
    ]);
    expect(model.elements).toEqual([]);
    expect(model.views.map((v) => v.contributes)).toEqual([false, false]);
  });
});

describe("name precedence (§3)", () => {
  test("C4 over architecture over kinded flowchart over ER over sequence", async () => {
    const families = [
      await view("e-seq", `sequenceDiagram\n  participant x as From sequence\n  participant y as Y\n  x->>y: hi\n`),
      await view("d-er", `erDiagram\n  x["From ER"]\n`),
      await view("c-flow", `flowchart LR\n  x[From flowchart]:::component\n`),
      await view("b-arch", `architecture-beta\n  service x(server)[From architecture]\n`),
      await view("a-c4", `C4Component\nComponent(x, "From C4")\n`),
    ];
    // Drop the strongest one at a time: the next family names it.
    const names: string[] = [];
    for (let n = families.length; n > 0; n--) names.push(element(mergeProjectModel(families.slice(0, n)), "x").name);
    expect(names).toEqual(["From C4", "From architecture", "From flowchart", "From ER", "From sequence"]);
  });

  test("a tie goes to a diagrams/ file over a note, then to view id order", async () => {
    const note = await view("a-note", `C4Context\nSystem(x, "In a note")\n`, { embedded: true });
    const fileB = await view("b-file", `C4Context\nSystem(x, "In file b")\n`);
    const fileC = await view("c-file", `C4Context\nSystem(x, "In file c")\n`);
    expect(element(mergeProjectModel([note, fileC, fileB]), "x").name).toBe("In file b");
    expect(element(mergeProjectModel([note]), "x").name).toBe("In a note");
  });
});

describe("conflicts keep both readings (§4, A3)", () => {
  test("two kinds: both readings kept with their views, and element_kind_conflict names them", async () => {
    const model = mergeProjectModel([
      await view("ctx", `C4Context\nSystem(browser, "Browser")\n`),
      await view("page", `C4Component\nComponent(browser, "Browser tests")\n`),
      await view("flow", `flowchart LR\n  browser[Browser]:::system\n`),
    ]);
    const browser = element(model, "browser");
    expect(browser.kinds).toEqual([
      { value: "component", views: ["page"] },
      { value: "system", views: ["ctx", "flow"] },
    ]);
    expect(browser.conflicts).toEqual([
      expect.objectContaining({ code: "element_kind_conflict", severity: "warning", views: ["ctx", "flow", "page"] }),
    ]);
  });

  test("two parents: a warning, no path; a component under two containers is informational", async () => {
    const a = await view("a", `C4Component\nContainer_Boundary(page, "Page") {\n  Component(shell, "Shell")\n}\n`);
    const b = await view("b", `C4Component\nContainer_Boundary(web, "Web") {\n  Component(shell, "Shell")\n}\n`);
    const shared = element(mergeProjectModel([a, b]), "shell");
    expect(shared.parents.map((r) => r.value)).toEqual(["page", "web"]);
    expect(shared.path).toBeUndefined();
    expect(shared.conflicts).toEqual([
      expect.objectContaining({ code: "element_parent_conflict", severity: "info", views: ["a", "b"] }),
    ]);

    const c = await view("c", `C4Container\nSystem_Boundary(kbc, "KBC") {\n  Container(plugins, "Plugins")\n}\n`);
    const d = await view("d", `C4Container\nSystem_Boundary(search, "Search") {\n  Container(plugins, "Plugins")\n}\n`);
    const plugins = element(mergeProjectModel([c, d]), "plugins");
    expect(plugins.conflicts).toEqual([
      expect.objectContaining({ code: "element_parent_conflict", severity: "warning" }),
    ]);
  });

  test("a cross-view cycle is a warning, never informational, and ancestry stops at the repeat", async () => {
    const a = await view(
      "a",
      `C4Component\nContainer_Boundary(x, "X") {\n  Container_Boundary(y, "Y") {\n    Component(z, "Z")\n  }\n}\n`,
    );
    const b = await view(
      "b",
      `C4Component\nContainer_Boundary(y, "Y") {\n  Container_Boundary(x, "X") {\n    Component(w, "W")\n  }\n}\n`,
    );
    const model = mergeProjectModel([a, b]);
    for (const id of ["x", "y"]) {
      const e = element(model, id);
      expect(e.path).toBeUndefined();
      expect(e.conflicts).toEqual([expect.objectContaining({ code: "element_parent_conflict", severity: "warning" })]);
    }
    // z sits under y, whose ancestry loops: one reading, but no acyclic path.
    expect(element(model, "z")).toMatchObject({ parents: [{ value: "y" }], conflicts: [] });
    expect(element(model, "z").path).toBeUndefined();
  });

  test("a self-parent is a warning (an envelope whose node sits in a subgraph of its own id)", async () => {
    // The compiler never writes one today (a node inside a subgraph of its own id is left outside it,
    // nest_id_clash), but an envelope can say it, and the walk must stop.
    const flow = await view(
      "flow",
      `flowchart LR\n  subgraph web [Web]\n    x[X]:::container\n  end\n  web[Web]:::container\n`,
    );
    const model = flow.envelope!.model as GraphModel;
    const selfParent = {
      ...flow,
      envelope: {
        ...flow.envelope!,
        model: { ...model, nodes: model.nodes.map((n) => (n.id === "web" ? { ...n, groupId: "web" } : n)) },
      },
    };
    const merged = mergeProjectModel([selfParent]);
    const web = element(merged, "web");
    expect(web.parents).toEqual([{ value: "web", views: ["flow"] }]);
    expect(web.path).toBeUndefined();
    expect(web.conflicts).toEqual([expect.objectContaining({ code: "element_parent_conflict", severity: "warning" })]);
    expect(web).toMatchObject({ drawnIn: ["flow"], opensIn: ["flow"] });
  });

  test("a weak occurrence never conflicts", async () => {
    const model = mergeProjectModel([
      await view("ctx", SHOP),
      await view("seq", `sequenceDiagram\n  participant web as W\n  participant db as D\n  web->>db: q\n`),
    ]);
    expect(element(model, "web").conflicts).toEqual([]);
  });
});

describe("proposed designs and copies (§5, A5)", () => {
  test("a view titled (proposed), or in a note with status: proposed, adds nothing to the model but is in the index, flagged", async () => {
    const base = await view("ctx", `C4Context\nSystem(shop, "Shop")\n`);
    const byTitle = await view(
      "plan",
      `C4Context\nSystem(shop, "Shop v2")\nSystem(gift, "Gift cards")\nRel(shop, gift, "redeems")\n`,
      { title: "Gift cards (proposed)" },
    );
    const byStatus = await view("notes/plan.md#next", `C4Context\nSystem(loyalty, "Loyalty")\n`, {
      embedded: true,
      status: "proposed",
    });
    const model = mergeProjectModel([base, byTitle, byStatus]);
    expect(ids(model)).toEqual(["shop"]);
    expect(element(model, "shop")).toMatchObject({ name: "Shop", drawnIn: ["ctx"] });
    expect(model.relationships).toEqual([]);
    expect(model.views).toEqual([
      { id: "ctx", family: "c4", contributes: true },
      { id: "plan", family: "c4", proposed: true, contributes: false },
      { id: "notes/plan.md#next", family: "c4", embedded: true, proposed: true, contributes: false },
    ]);
    const shop = model.index.find((e) => e.id === "shop")!;
    expect(shop.occurrences.map((o) => [o.viewId, o.proposed ?? false])).toEqual([
      ["ctx", false],
      ["plan", true],
    ]);
    expect(model.index.map((e) => e.id)).toEqual(["gift", "loyalty", "shop"]);
  });

  test("status: proposal reads as proposed (A16)", async () => {
    const model = mergeProjectModel([
      await view("notes/shell.md#next", `C4Context\nSystem(shell, "Shell")\n`, { embedded: true, status: "proposal" }),
    ]);
    expect(model.elements).toEqual([]);
    expect(model.views[0]).toMatchObject({ proposed: true, contributes: false });
  });

  test("a C4 diagram's own title marks it proposed too", async () => {
    const model = mergeProjectModel([
      await view("plan", `C4Context\ntitle Checkout (proposed)\nSystem(shop, "Shop")\n`),
    ]);
    expect(model.elements).toEqual([]);
  });

  test("a based-on copy adds nothing, and is not in the index (O11)", async () => {
    const copy = await view("notes/scratch/x.md#c", `C4Context\nSystem(shop, "Shop, in detail")\n`, {
      embedded: true,
      basedOn: "ctx@sha256:abc",
    });
    const model = mergeProjectModel([copy]);
    expect(model.elements).toEqual([]);
    expect(model.index).toEqual([]);
    expect(model.views).toEqual([
      { id: "notes/scratch/x.md#c", family: "c4", embedded: true, basedOn: "ctx@sha256:abc", contributes: false },
    ]);
  });

  test("a view that never compiled is named uncompiled", async () => {
    const model = mergeProjectModel([
      { id: "broken", title: "broken", path: "diagrams/broken.mmd", embedded: false, envelope: null },
    ]);
    expect(model.views).toEqual([{ id: "broken", uncompiled: true, contributes: false }]);
  });
});

describe("relationships by ordered pair (§6, A4)", () => {
  test("reverse-only, two-way and arrowless architecture edges", async () => {
    const model = mergeProjectModel([
      await view(
        "arch",
        `architecture-beta
  service a(server)[A]
  service b(server)[B]
  service c(server)[C]
  service d(server)[D]
  a:R --> L:b
  b:R <-- L:c
  c:B <--> T:d
  a:B -- T:d
`,
      ),
    ]);
    const pairs = model.relationships.map(
      (r) => `${r.from}>${r.to}:${r.occurrences.map((o) => o.direction).join(",")}`,
    );
    expect(pairs).toEqual([
      "a>b:forward",
      "a>d:undirected",
      "c>b:reverse",
      "c>d:two-way",
      "d>a:undirected",
      "d>c:two-way",
    ]);
    expect(pair(model, "c", "b")!.occurrences[0]).toMatchObject({ id: "b--c", source: "b", target: "c" });
  });

  test("C4 BiRel and a flowchart <--> count both ways; technology and labels stay on the occurrence", async () => {
    const model = mergeProjectModel([
      await view("shop", SHOP),
      await view("flow", `flowchart LR\n  web[Web]:::container\n  db[(DB)]:::database\n  web e1@<-->|syncs| db\n`),
    ]);
    expect(pair(model, "web", "db")!.drawnIn).toEqual(["flow", "shop"]);
    expect(pair(model, "db", "web")!.occurrences.map((o) => [o.viewId, o.direction, o.label, o.technology])).toEqual([
      ["shop", "two-way", "reads", "SQL"],
      ["flow", "two-way", "syncs", undefined],
    ]);
  });

  test("ER relationships are undirected and keep their cardinality", async () => {
    const model = mergeProjectModel([
      await view("data", `erDiagram\n  CUSTOMER\n  ORDER\n  CUSTOMER ||--o{ ORDER : places\n`),
    ]);
    expect(pair(model, "ORDER", "CUSTOMER")!.occurrences[0]).toMatchObject({
      direction: "undirected",
      label: "places",
      cardinality: { source: "exactly-one", target: "zero-or-more" },
    });
    expect(pair(model, "CUSTOMER", "ORDER")).toBeDefined();
  });

  test("parallel edges: two drawings of one pair in one view, and the same pair in two views, are one relationship", async () => {
    const flow = await view(
      "flow",
      `flowchart LR\n  a[A]:::container\n  b[B]:::container\n  a e1@-->|reads| b\n  a e2@-->|writes| b\n`,
    );
    const seq = await view(
      "seq",
      `sequenceDiagram\n  participant a as A\n  participant b as B\n  a->>b: go\n  loop again\n    a->>b: go\n  end\n  b<<->>a: chat\n`,
    );
    const model = mergeProjectModel([flow, seq]);
    const ab = pair(model, "a", "b")!;
    expect(ab.drawnIn).toEqual(["flow", "seq"]);
    expect(ab.occurrences.map((o) => `${o.viewId}:${o.id}`)).toEqual([
      "flow:e1",
      "flow:e2",
      "seq:msg-0",
      "seq:msg-1",
      "seq:msg-2",
    ]);
    // A sequence message adds its pair without its label (§1).
    expect(ab.occurrences.filter((o) => o.viewId === "seq").every((o) => o.label === undefined)).toBe(true);
    expect(pair(model, "b", "a")!.occurrences.map((o) => o.id)).toEqual(["msg-2"]);
  });

  test("an edge to a step or a junction does not join", async () => {
    const model = mergeProjectModel([
      await view(
        "arch",
        `architecture-beta\n  service a(server)[A]\n  service b(server)[B]\n  junction j\n  a:R -- L:j\n  j:R -- L:b\n`,
      ),
    ]);
    expect(model.relationships).toEqual([]);
  });
});

describe("a draft substituted into the model is the model rebuilt with it (A6)", () => {
  // Whether a flowchart subgraph joins depends on every other view (§1, A18), so each slot's variants
  // add or remove the only declaration of p or r, or draw it only in a proposed view or a copy.
  const FLOW = `flowchart LR
  subgraph p [Parent]
    x[X]:::container
  end
  subgraph r [R]
    y[Y]:::component
  end
  x e1@--> y
`;
  const slots = async (): Promise<ModelInputView[][]> => [
    [
      await view("ctx", `C4Context\nSystem(p, "Parent")\n`),
      await view("ctx", `C4Context\nSystem(q, "Other")\n`),
      await view("ctx", `C4Context\nSystem(p, "Parent")\n`, { status: "proposed" }),
      await view("ctx", `C4Context\nSystem(p, "Parent")\n`, { basedOn: "flow@sha256:0" }),
      { ...(await view("ctx", `C4Context\nSystem(p, "Parent")\n`)), envelope: null },
    ],
    [
      await view("flow", FLOW),
      await view("flow", FLOW, { status: "proposed" }),
      await view("flow", `flowchart LR\n  subgraph p [Parent]\n    x[X]:::container\n  end\n`),
    ],
    [
      await view("other", `flowchart LR\n  r[R]:::system\n`),
      await view("other", `flowchart LR\n  subgraph q [Q]\n    z[Z]:::component\n  end\n`),
    ],
    [await view("seq", `sequenceDiagram\n  participant r as R\n  participant p as P\n  r->>p: hi\n`)],
  ];
  // Every inventory with each slot absent or one of its variants.
  const inventories = (all: ModelInputView[][]): ModelInputView[][] =>
    all.reduce<ModelInputView[][]>(
      (acc, variants) => acc.flatMap((inv) => [inv, ...variants.map((v) => [...inv, v])]),
      [[]],
    );
  const substituted = (
    inventory: readonly ModelInputView[],
    previousId: string,
    draft: ModelInputView,
  ): ModelInputView[] => {
    const at = inventory.findIndex((v) => v.id === previousId);
    const rest = inventory.filter((v) => v.id !== previousId && v.id !== draft.id);
    if (at < 0) return [...rest, draft];
    const out = inventory
      .filter((v) => v.id !== draft.id || v.id === previousId)
      .map((v) => (v.id === previousId ? draft : v));
    return out;
  };

  test("adding or removing the only declaration, proposed-only declarations, copies and uncompiled drafts", async () => {
    const all = await slots();
    let checked = 0;
    for (const inventory of inventories(all)) {
      const before = mergeProjectModel(inventory);
      for (const variants of all)
        for (const draft of variants) {
          expect(replaceView(before, draft.id, draft), `${inventory.map((v) => v.id).join(",")} ← ${draft.id}`).toEqual(
            mergeProjectModel(substituted(inventory, draft.id, draft)),
          );
          checked++;
        }
    }
    expect(checked).toBeGreaterThan(500);
  });

  test("removing p's only declaration takes x's parent with it; declaring it again promotes the frame", async () => {
    const [ctx, flow] = [await view("ctx", `C4Context\nSystem(p, "Parent")\n`), await view("flow", FLOW)];
    const other = await view("ctx", `C4Context\nSystem(q, "Other")\n`);
    const without = replaceView(mergeProjectModel([ctx, flow]), "ctx", other);
    expect(ids(without)).toEqual(["q", "x", "y"]);
    expect(element(without, "x").parents).toEqual([]);
    const back = replaceView(without, "ctx", ctx);
    expect(element(back, "x")).toMatchObject({ parents: [{ value: "p", views: ["flow"] }], path: ["p"] });
  });

  test("a proposed declaration does not promote a contributing view's frame into the model", async () => {
    const proposed = await view("ctx", `C4Context\nSystem(p, "Parent")\n`, { status: "proposed" });
    const flow = await view("flow", FLOW);
    const next = replaceView(mergeProjectModel([proposed]), "flow", flow);
    expect(ids(next)).toEqual(["x", "y"]);
    // The index Expand reads still opens p in the flowchart (A5).
    expect(next.index.find((e) => e.id === "p")?.occurrences.map((o) => o.viewId)).toEqual(["ctx", "flow"]);
  });

  test("an embedded rename puts the draft where the old address was", async () => {
    const old = await view("notes/n.md#old", `C4Context\nSystem(p, "Parent")\n`, { embedded: true });
    const flow = await view("flow", FLOW);
    const renamed = await view("notes/n.md#new", `C4Context\nSystem(q, "Other")\n`, { embedded: true });
    expect(replaceView(mergeProjectModel([old, flow]), old.id, renamed)).toEqual(mergeProjectModel([renamed, flow]));
  });
});

test("the merge is deterministic whatever the input order", async () => {
  const views = [
    await view("shop", SHOP),
    await view("flow", `flowchart LR\n  web[Web app]:::component\n  db[(DB)]:::database\n  web e1@--> db\n`),
    await view("seq", `sequenceDiagram\n  participant user as U\n  participant web as W\n  user->>web: hi\n`),
  ];
  const forward = mergeProjectModel(views);
  const backward = mergeProjectModel([...views].reverse());
  expect({ ...backward, views: [] }).toEqual({ ...forward, views: [] });
});
