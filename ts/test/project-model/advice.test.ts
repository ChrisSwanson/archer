// The advisory lint (ADR 0036 §9, A6, A7): a good and a bad diagram per rule, the draft replacing the
// written view's occurrences, and the project report. Views compile with the production compiler.
import { describe, expect, test } from "vitest";
import {
  diagramAdvice,
  draftAdvice,
  projectReport,
  similarPairs,
  type Advice,
  type AdviceCode,
} from "../../src/project-model/advice.ts";
import { mergeProjectModel, type ModelInputView, type ProjectModel } from "../../src/project-model/merge.ts";
import { view } from "./support.ts";

const codes = (advice: readonly Advice[]): AdviceCode[] => advice.map((a) => a.code);
const of = (advice: readonly Advice[], code: AdviceCode): Advice[] => advice.filter((a) => a.code === code);
const alone = async (source: string, others: readonly ModelInputView[] = []): Promise<Advice[]> => {
  const v = await view("v", source);
  return diagramAdvice(v.envelope!.model, others.length === 0 ? null : mergeProjectModel(others));
};

const c4 = (level: "Context" | "Container" | "Component", body: string): string => `C4${level}\n${body}\n`;
const elements = (n: number, macro = "Container"): string =>
  Array.from({ length: n }, (_, i) => `${macro}(e${i}, "E${i}")`).join("\n");

// The element the model rules check against: one C4 view of a shop.
const SHOP = c4(
  "Container",
  `Person(shopper, "Shopper")
System_Boundary(shop, "Shop") {
  Container(web, "Storefront", "React")
  ContainerDb(ordersDb, "Orders database", "Postgres")
}
Rel(shopper, web, "Buys from")
Rel(web, ordersDb, "Stores orders", "SQL")`,
);

describe("per-diagram rules: a good and a bad diagram each (§9)", () => {
  test.each([
    ["context", "Context", 10, "System"],
    ["container", "Container", 15, "Container"],
    ["component", "Component", 12, "Component"],
  ] as const)("too_many_elements: a %s view over %i elements", async (_level, level, budget, macro) => {
    expect(codes(await alone(c4(level, elements(budget, macro))))).toEqual([]);
    const bad = await alone(c4(level, elements(budget + 1, macro)));
    expect(of(bad, "too_many_elements")).toEqual([
      expect.objectContaining({
        severity: "warning",
        fix: expect.stringContaining(`${budget + 1} elements, more than ${budget}`),
      }),
    ]);
  });

  test("too_many_elements counts elements, not boundaries", async () => {
    const boundaries = Array.from(
      { length: 6 },
      (_, i) => `System_Boundary(b${i}, "B${i}") {\n  Container(c${i}, "C${i}")\n}`,
    ).join("\n");
    expect(codes(await alone(c4("Container", boundaries)))).toEqual([]);
  });

  test("description_too_long: over 15 words", async () => {
    const fifteen = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen";
    expect(codes(await alone(c4("Container", `Container(api, "API", "Node", "${fifteen}")`)))).toEqual([]);
    expect(
      of(await alone(c4("Container", `Container(api, "API", "Node", "${fifteen} sixteen")`)), "description_too_long"),
    ).toEqual([expect.objectContaining({ element: "api" })]);
  });

  test("technology_too_long: over 5 words, punctuation not counted", async () => {
    expect(codes(await alone(c4("Container", `Container(db, "DB", "PostgreSQL 16 + pgvector, schema kb")`)))).toEqual(
      [],
    );
    expect(
      of(
        await alone(c4("Container", `Container(db, "DB", "PostgreSQL 16 with pgvector and schema kb")`)),
        "technology_too_long",
      ),
    ).toEqual([expect.objectContaining({ element: "db" })]);
  });

  test("technology_is_path: a path or a file, never a protocol pair such as HTTP/JSON", async () => {
    for (const tech of ["HTTP/JSON", "TypeScript", "Node.js", "TCP/IP"])
      expect(codes(await alone(c4("Container", `Container(api, "API", "${tech}")`))), tech).toEqual([]);
    for (const tech of [
      "ts/src/application",
      "~/.local/state/archer",
      "app/WebShell.tsx, shell-help.ts",
      "app/FolderPage.tsx, ContentsPage.tsx",
      "node archer.js",
      "./bin",
      "_policy.toml, operator-only",
    ])
      expect(of(await alone(c4("Container", `Container(api, "API", "${tech}")`)), "technology_is_path"), tech).toEqual([
        expect.objectContaining({ element: "api" }),
      ]);
  });

  test("boundary_too_deep: more than 2 boundary levels", async () => {
    const two = `Enterprise_Boundary(a, "A") {\n  System_Boundary(b, "B") {\n    Container(x, "X")\n  }\n}`;
    expect(codes(await alone(c4("Container", two)))).toEqual([]);
    const three = `Enterprise_Boundary(a, "A") {\n  System_Boundary(b, "B") {\n    Boundary(c, "C") {\n      Container(x, "X")\n    }\n  }\n}`;
    expect(of(await alone(c4("Container", three)), "boundary_too_deep")).toEqual([
      expect.objectContaining({ element: "c", fix: expect.stringContaining("3 deep") }),
    ]);
  });

  test("code_in_label: an identifier, a call or a route in a C4 arrow label", async () => {
    const pair = (label: string) => c4("Container", `Container(a, "A")\nContainer(b, "B")\nRel(a, b, "${label}")`);
    for (const label of ["Sends orders", "Reads HTTP/JSON", "Stores order rows"])
      expect(codes(await alone(pair(label))), label).toEqual([]);
    for (const label of ["Records fetch_attempts", "createApplication, call", "Calls render()", "POST /v1/embeddings"])
      expect(of(await alone(pair(label)), "code_in_label"), label).toEqual([expect.objectContaining({ edge: "a--b" })]);
  });

  test("response_arrow (N1): a Returns arrow back along a request, in C4 and flowcharts", async () => {
    const c4Good = c4("Container", `Container(a, "A")\nContainer(b, "B")\nRel(a, b, "Requests pages")`);
    expect(codes(await alone(c4Good))).toEqual([]);
    // A Returns label with no request the other way is not a response arrow.
    expect(
      codes(await alone(c4("Container", `Container(a, "A")\nContainer(b, "B")\nRel(b, a, "Returns pages")`))),
    ).toEqual([]);
    const c4Bad = c4(
      "Container",
      `Container(a, "A")\nContainer(b, "B")\nRel(a, b, "Requests pages")\nRel(b, a, "Returns pages")`,
    );
    expect(of(await alone(c4Bad), "response_arrow")).toEqual([expect.objectContaining({ edge: "b--a" })]);
    expect(
      of(
        await alone("flowchart LR\n  a[A] ask@-->|query| b[B]\n  b ret@-->|Responds with rows| a\n"),
        "response_arrow",
      ),
    ).toEqual([expect.objectContaining({ edge: "ret" })]);
  });

  test("arrow_from_store (N2): a C4 store or queue, or an architecture database, starting an arrow", async () => {
    expect(
      codes(
        await alone(
          c4(
            "Container",
            `Container(api, "API")\nContainerDb(db, "DB")\nRel(api, db, "Reads from")\nBiRel(db, api, "Syncs")`,
          ),
        ),
      ),
    ).toEqual([]);
    expect(
      of(
        await alone(c4("Container", `Container(api, "API")\nContainerDb(db, "DB")\nRel(db, api, "Rows")`)),
        "arrow_from_store",
      ),
    ).toEqual([expect.objectContaining({ edge: "db--api" })]);
    expect(
      of(
        await alone(c4("Container", `Container(api, "API")\nContainerQueue(q, "Jobs")\nRel(q, api, "Delivers")`)),
        "arrow_from_store",
      ),
    ).toHaveLength(1);
    const arch = (edge: string) =>
      `architecture-beta\n  service db(database)[Orders DB]\n  service api(server)[API]\n  ${edge}\n`;
    expect(codes(await alone(arch("api:R --> L:db")))).toEqual([]);
    expect(of(await alone(arch("db:R --> L:api")), "arrow_from_store")).toEqual([
      expect.objectContaining({ edge: "db--api" }),
    ]);
  });

  test("arrow_from_store is not checked on flowcharts: their arrows are flow (hand-read, 2026-11-02)", async () => {
    expect(codes(await alone("flowchart LR\n  db[(Orders)]:::database e1@--> api[API]:::container\n"))).toEqual([]);
  });

  test("code_relationship (N3): Implements, Extends, Inherits", async () => {
    const pair = (label: string) => c4("Component", `Component(a, "A")\nComponent(b, "B")\nRel(a, b, "${label}")`);
    expect(codes(await alone(pair("Calls")))).toEqual([]);
    for (const label of ["Implements", "Extends Base", "Inherits from"])
      expect(of(await alone(pair(label)), "code_relationship"), label).toHaveLength(1);
    expect(of(await alone("flowchart LR\n  a[A] i@-->|implements| b[B]\n"), "code_relationship")).toEqual([
      expect.objectContaining({ edge: "i" }),
    ]);
  });

  test("label_holds_file (N11): a flowchart label longer than a name that holds a file name", async () => {
    expect(codes(await alone('flowchart LR\n  scan["scan.ts"] e1@--> db["Mermaid diagram db"]\n'))).toEqual([]);
    const bad = await alone(
      'flowchart LR\n  scan["scan.ts: Archer\'s profile rules, spans and fix hints"] e1@--> db["Mermaid diagram db"]\n',
    );
    expect(of(bad, "label_holds_file")).toEqual([expect.objectContaining({ element: "scan" })]);
  });

  test("step_reuses_element_id (N5): a decision, a state or a journey task with an element's id", async () => {
    const shop = [await view("shop", SHOP)];
    expect(codes(await alone("flowchart LR\n  check{In stock?} e1@--> pay[Pay]\n", shop))).toEqual([]);
    expect(
      of(await alone("flowchart LR\n  web{Logged in?} e1@--> pay[Pay]\n", shop), "step_reuses_element_id"),
    ).toEqual([expect.objectContaining({ element: "web" })]);
    expect(codes(await alone("stateDiagram-v2\n  state cart\n  state paid\n  cart --> paid\n", shop))).toEqual([]);
    expect(
      of(await alone("stateDiagram-v2\n  state web\n  state paid\n  web --> paid\n", shop), "step_reuses_element_id"),
    ).toEqual([expect.objectContaining({ element: "web" })]);
    expect(codes(await alone("journey\n  section Buy\n    browse: 5: Me\n", shop))).toEqual([]);
    expect(of(await alone("journey\n  section Buy\n    web: 5: Me\n", shop), "step_reuses_element_id")).toEqual([
      expect.objectContaining({ element: "web" }),
    ]);
  });

  test("unkinded_node: a box with an element's id, or its name, and no kind class", async () => {
    const shop = [await view("shop", SHOP)];
    expect(codes(await alone("flowchart LR\n  web[Storefront]:::container e1@--> pay[Pay]\n", shop))).toEqual([]);
    const sameId = await alone("flowchart LR\n  web[Storefront] e1@--> pay[Pay]\n", shop);
    expect(of(sameId, "unkinded_node")).toEqual([
      expect.objectContaining({
        element: "web",
        fix: expect.stringContaining("give it a kind class (container) so it joins"),
      }),
    ]);
    const sameName = await alone("flowchart LR\n  orders[(Orders database)] e1@--> pay[Pay]\n", shop);
    expect(of(sameName, "unkinded_node")).toEqual([
      expect.objectContaining({ element: "orders", fix: expect.stringContaining("use the id 'ordersDb'") }),
    ]);
  });

  test("sequences: no level rule applies, and participants reusing ids are what they should do", async () => {
    const shop = [await view("shop", SHOP)];
    expect(
      codes(
        await alone(
          "sequenceDiagram\n  participant web\n  participant ordersDb\n  web->>ordersDb: insert_order()\n  ordersDb-->>web: Returns id\n",
          shop,
        ),
      ),
    ).toEqual([]);
  });
});

describe("model rules on a draft (A6)", () => {
  test("a view's own ids never give possible_duplicate, written again or with a new label", async () => {
    const shop = await view("shop", SHOP);
    const model = mergeProjectModel([shop]);
    expect(of(draftAdvice(model, "shop", shop), "possible_duplicate")).toEqual([]);
    const relabelled = await view("shop", SHOP.replace('"Orders database"', '"Orders DB"'));
    expect(of(draftAdvice(model, "shop", relabelled), "possible_duplicate")).toEqual([]);
  });

  test("a new id named like an element elsewhere is a possible duplicate; reusing the id is not", async () => {
    const model = mergeProjectModel([await view("shop", SHOP)]);
    const dup = await view(
      "ops",
      c4(
        "Container",
        `Container(api, "API")\nContainerDb(orders, "Orders database", "Postgres")\nRel(api, orders, "Reads")`,
      ),
    );
    expect(of(draftAdvice(model, "ops", dup), "possible_duplicate")).toEqual([
      expect.objectContaining({ element: "orders", fix: expect.stringContaining("use the id 'ordersDb'") }),
    ]);
    const reuse = await view(
      "ops",
      c4(
        "Container",
        `Container(api, "API")\nContainerDb(ordersDb, "Orders database", "Postgres")\nRel(api, ordersDb, "Reads")`,
      ),
    );
    expect(of(draftAdvice(model, "ops", reuse), "possible_duplicate")).toEqual([]);
  });

  test("an id already in the view's last-good drawing is not new", async () => {
    // Two views each with the same name under two ids: the second is the one being written again.
    const a = await view("a", c4("Container", `ContainerDb(ordersDb, "Orders database")`));
    const b = await view("b", c4("Container", `ContainerDb(orders, "Orders database")`));
    const model = mergeProjectModel([a, b]);
    expect(of(draftAdvice(model, "b", b), "possible_duplicate")).toEqual([]);
    expect(of(projectReport(model, [a, b]).model, "possible_duplicate")).toHaveLength(1);
  });

  test("siblings are not duplicates: Agent host A and Agent host", async () => {
    const model = mergeProjectModel([await view("a", c4("Context", `System(host, "Agent host")`))]);
    const b = await view("b", c4("Context", `System(hostA, "Agent host A")\nSystem(hostB, "Agent host B")`));
    expect(of(draftAdvice(model, "b", b), "possible_duplicate")).toEqual([]);
  });

  test("the draft's occurrences replace the written view's: a conflict the draft makes, and one it removes", async () => {
    const shop = await view("shop", SHOP);
    const ops = await view("ops", c4("Component", `Component(web, "Storefront")`));
    const model = mergeProjectModel([shop, ops]);
    expect(of(draftAdvice(model, "ops", ops), "element_kind_conflict")).toEqual([
      expect.objectContaining({ element: "web", severity: "warning" }),
    ]);
    const fixed = await view(
      "ops",
      c4("Component", `Container(web, "Storefront")`).replace("C4Component", "C4Container"),
    );
    expect(of(draftAdvice(model, "ops", fixed), "element_kind_conflict")).toEqual([]);
    // A conflict between two other views is not this write's.
    const other = await view("other", c4("Container", `Container(api, "API")`));
    expect(codes(draftAdvice(mergeProjectModel([shop, ops, other]), "other", other))).toEqual([]);
  });

  test("a draft's flowchart subgraph is a parent only as the written model would read it (A5, A18)", async () => {
    const ops = await view("ops", c4("Container", `System_Boundary(ops, "Ops") {\n  Container(api, "API")\n}`));
    const flow = await view("flow", `flowchart LR\n  subgraph shop [Shop]\n    api[API]:::container\n  end\n`);
    const conflicts = (advice: readonly Advice[]) => of(advice, "element_parent_conflict").map((a) => a.element);
    // Only a proposed view declares shop: the written model has no element shop, so no conflict.
    const plan = await view("plan", c4("Context", `System(shop, "Shop")`), { status: "proposed" });
    expect(conflicts(draftAdvice(mergeProjectModel([ops, plan]), "flow", flow))).toEqual([]);
    // The C4 view that declared shop drops it: api is part of ops alone again.
    const ctx = await view("ctx", c4("Context", `System(shop, "Shop")`));
    const model = mergeProjectModel([ops, ctx, flow]);
    expect(conflicts(draftAdvice(model, "flow", flow))).toEqual(["api"]);
    const dropped = await view("ctx", c4("Context", `System(store, "Store")`));
    expect(draftAdvice(model, "ctx", dropped).filter((a) => a.code === "element_parent_conflict")).toEqual([]);
    expect(
      projectReport(mergeProjectModel([ops, dropped, flow]), [ops, dropped, flow]).model.filter(
        (a) => a.code === "element_parent_conflict",
      ),
    ).toEqual([]);
  });

  test("element_parent_conflict: a container in two systems is a warning; in one, nothing", async () => {
    const a = await view("a", c4("Container", `System_Boundary(shop, "Shop") {\n  Container(api, "API")\n}`));
    const same = await view("b", c4("Container", `System_Boundary(shop, "Shop") {\n  Container(api, "API")\n}`));
    expect(of(draftAdvice(mergeProjectModel([a, same]), "b", same), "element_parent_conflict")).toEqual([]);
    const other = await view("b", c4("Container", `System_Boundary(ops, "Ops") {\n  Container(api, "API")\n}`));
    expect(of(draftAdvice(mergeProjectModel([a, other]), "b", other), "element_parent_conflict")).toEqual([
      expect.objectContaining({ element: "api", severity: "warning" }),
    ]);
  });

  test("a component shared by two containers stays info", async () => {
    const a = await view("a", c4("Component", `Container_Boundary(api, "API") {\n  Component(auth, "Auth")\n}`));
    const b = await view("b", c4("Component", `Container_Boundary(worker, "Worker") {\n  Component(auth, "Auth")\n}`));
    const advice = draftAdvice(mergeProjectModel([a, b]), "b", b);
    expect(of(advice, "element_parent_conflict")).toEqual([
      expect.objectContaining({ element: "auth", severity: "info" }),
    ]);
  });

  test("an embedded rename: the old address's occurrences go, the new address's come", async () => {
    const before = await view("notes/n.md#old", c4("Container", `ContainerDb(orders, "Orders database")`), {
      embedded: true,
    });
    const shop = await view("shop", SHOP);
    const model = mergeProjectModel([shop, before]);
    const renamed = await view("notes/n.md#new", c4("Container", `ContainerDb(orders, "Orders database")`), {
      embedded: true,
    });
    // 'orders' was in the old address's drawing, so it is not new.
    expect(of(draftAdvice(model, "notes/n.md#old", renamed), "possible_duplicate")).toEqual([]);
  });
});

describe("the project report (A7)", () => {
  test("per-view findings from each last-good drawing, and model findings once", async () => {
    const shop = await view("shop", SHOP);
    const ops = await view("ops", c4("Component", `Component(web, "Storefront", "ts/src/web")`));
    const never: ModelInputView = { ...(await view("broken", SHOP)), envelope: null };
    const report = projectReport(mergeProjectModel([shop, ops, never]), [shop, ops, never]);
    expect(report.views).toEqual([
      { viewId: "ops", advice: [expect.objectContaining({ code: "technology_is_path", element: "web" })] },
    ]);
    expect(codes(report.model)).toEqual(["element_kind_conflict"]);
    expect(report.total).toBe(2);
  });
});

describe("the look-alike scan's cost (P44, R13-04)", () => {
  // One element per view, as the model would merge it: names distinct unless `name` is given.
  const element = (i: number, name = `Element ${i}`) => {
    const id = `e${String(i).padStart(6, "0")}`;
    return {
      id,
      name,
      kinds: [{ value: "container" as const, views: [`v${i}`] }],
      parents: [],
      drawnIn: [`v${i}`],
      opensIn: [],
      occurrences: [{ id, label: name, viewId: `v${i}`, family: "c4" as const, kind: "container" as const }],
      conflicts: [],
    };
  };
  const model = (n: number, name?: string) =>
    ({
      schemaVersion: 1,
      elements: Array.from({ length: n }, (_, i) => element(i, name)),
      relationships: [],
      views: [],
      index: [],
      flowcharts: [],
    }) as unknown as ProjectModel;

  test("with touching ids, only touching × population is enumerated and scored, each unordered pair once", () => {
    for (const n of [800, 1600]) {
      const touching = new Set(["e000000"]);
      let probes = 0;
      const has = touching.has.bind(touching);
      touching.has = (x: string) => (probes++, has(x));
      const budget = { scored: 0 };
      expect(similarPairs(model(n), touching, budget)).toEqual([]);
      expect(budget.scored).toBe(n - 1);
      expect(probes).toBeLessThanOrEqual(2 * n);
    }
    // Two touching ids that look alike are one pair, scored once.
    const budget = { scored: 0 };
    const pairs = similarPairs(model(10, "Shop API"), new Set(["e000000", "e000001"]), budget);
    expect(pairs.map((p) => `${p.a.id}~${p.b.id}`).filter((k) => k === "e000000~e000001")).toHaveLength(1);
    expect(budget.scored).toBe(9 + 8);
  });

  test("a scan past its budget stops, says so, and keeps what it found", () => {
    const budget = { scored: 0, limit: 100 };
    const pairs = similarPairs(model(800, "Shop API"), undefined, budget);
    expect(budget.scored).toBe(100);
    expect(budget).toMatchObject({ exhausted: true });
    expect(pairs).toHaveLength(100);
  });
});
