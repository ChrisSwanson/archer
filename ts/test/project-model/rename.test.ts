// Renaming ids by text (ADR 0036 §10): per family, ids change and labels, strings, classes and edge
// ids do not. Each case is checked the way the plan checks it: the renamed source compiles to the
// old model with the ids renamed.
import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { isRenameOf, renameSource } from "../../src/project-model/rename.ts";

async function renamed(source: string, map: Record<string, string>): Promise<string> {
  const before = await compile(source);
  if (before.model === null) throw new Error(before.diagnostics.map((d) => d.message).join("; "));
  const renames = new Map(Object.entries(map));
  const next = renameSource(source, before.model, renames);
  const after = await compile(next);
  expect(after.model, after.diagnostics.map((d) => d.message).join("; ")).not.toBeNull();
  expect(isRenameOf(before.model, after.model!, renames)).toBe(true);
  return next;
}

describe("renameSource, family by family", () => {
  test("C4: aliases and Rel ends change, labels and descriptions that say the id do not", async () => {
    const next = await renamed(
      `C4Container\n%% archer-line dotted: web--db\n%% archer-key dotted: Async\nSystem_Boundary(shop, "Shop") {\n  Container(web, "web", "React", "Talks to db")\n  ContainerDb(db, "db")\n}\nRel(web, db, "Reads db rows")\n`,
      { db: "ordersDb" },
    );
    expect(next).toContain('ContainerDb(ordersDb, "db")');
    expect(next).toContain('Rel(web, ordersDb, "Reads db rows")');
    expect(next).toContain("archer-line dotted: web--ordersDb");
    expect(next).toContain('"Talks to db"');
  });

  test("flowchart: node ids, subgraph ids and class lists change; labels, edge ids, edge text and class names do not", async () => {
    const source = `flowchart LR\n  subgraph svc[svc group]\n    api[api server]:::container\n  end\n  db[(db)]:::database\n  api api-db@-->|calls api| db\n  client[Client] e2@--> api\n  class client component\n  style api fill:#fff\n`;
    const next = await renamed(source, { api: "gateway", svc: "service" });
    expect(next).toContain("subgraph service[svc group]");
    expect(next).toContain("gateway[api server]:::container");
    expect(next).toContain("gateway api-db@-->|calls api| db");
    expect(next).toContain("e2@--> gateway");
  });

  test("a swap in one view: svc becomes service while service becomes serviceModule", async () => {
    const next = await renamed(
      `flowchart LR\n  subgraph svc[Background service]\n    service[service module]:::component\n    state[state module]:::component\n  end\n  service e1@--> state\n`,
      { svc: "service", service: "serviceModule" },
    );
    expect(next).toContain("subgraph service[Background service]");
    expect(next).toContain("serviceModule[service module]:::component");
  });

  test("sequence: participants, activations and message ends change; message text and aliases do not", async () => {
    const next = await renamed(
      `sequenceDiagram\n  participant web as web app\n  actor user\n  user->>web: opens web\n  Note over user,web: web is slow\n  alt web up\n    activate web\n    web-->>user: done\n    deactivate web\n  end\n`,
      { web: "storefront" },
    );
    expect(next).toContain("participant storefront as web app");
    expect(next).toContain("user->>storefront: opens web");
    expect(next).toContain("Note over user,storefront: web is slow");
    expect(next).toContain("alt web up");
  });

  test("architecture: services, groups and edge ends change; sides and labels do not", async () => {
    await renamed(
      `architecture-beta\n  group g(cloud)[g]\n  service db(database)[db] in g\n  service api(server)[API] in g\n  db:R --> L:api\n`,
      { db: "ordersDb", g: "cloudGroup" },
    );
  });

  test("state: states, transitions and a label that was the id move together", async () => {
    await renamed(
      `stateDiagram-v2\n  state cart\n  state paid\n  cart --> paid: pay for cart\n  note right of cart : cart holds items\n`,
      { cart: "basket" },
    );
  });

  test("ER: entities change; attributes and relationship labels do not", async () => {
    await renamed(
      `erDiagram\n  CUSTOMER ||--o{ ORDER : "CUSTOMER places"\n  CUSTOMER {\n    string CUSTOMER\n  }\n  ORDER {\n    int id\n  }\n`,
      { CUSTOMER: "BUYER" },
    );
  });
});
