// ADR 0034 §2: each reference resolves against the current model as current,
// changed or out of date; a step takes its worst, a walkthrough is current,
// partly out of date or archived. Resolution is pure and derived.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import type { DiagramModel } from "../../src/model/index.ts";
import { revisionOf } from "../../src/project/index.ts";
import { serializeWalkthroughs, validateWalkthroughsFile } from "../../src/walkthroughs/store.ts";
import type { EdgeRef, NodeRef, Step, Walkthrough } from "../../src/walkthroughs/contract.ts";
import { resolveWalkthrough } from "../../src/walkthroughs/resolve.ts";

async function model(source: string): Promise<DiagramModel> {
  const { model, diagnostics } = await compile(source);
  if (model === null) throw new Error(diagnostics.map((d) => d.message).join("; "));
  return model;
}

const walkthrough = (steps: Step[]): Walkthrough => ({
  id: "w",
  title: "W",
  revision: 1,
  modelRevision: "sha256:0",
  author: "agent",
  writtenAt: "2026-10-23T09:00:00Z",
  steps,
});
const step = (refs: Pick<Step, "nodes" | "edges" | "messages">): Step => ({
  id: "s",
  title: "S",
  kind: "does",
  what: "x",
  ...refs,
});
const node = (id: string, label: string, kind: NodeRef["kind"] = "node"): NodeRef => ({ kind, id, label });
const edge = (id: string, source: string, target: string, label?: string): EdgeRef => ({
  id,
  source,
  target,
  ...(label === undefined ? {} : { label }),
});

interface Family {
  readonly name: string;
  readonly source: string;
  /** One kept node and one kept edge, as written. */
  readonly node: NodeRef;
  readonly edge: EdgeRef;
  /** The source with the node's label changed, and with the edge's label changed. */
  readonly relabelNode: (s: string) => string;
  readonly relabelEdge: (s: string) => string;
  /** The source with the edge removed (its ends kept). */
  readonly removeEdge: (s: string) => string;
}

const FAMILIES: Family[] = [
  {
    name: "flowchart",
    source: "flowchart LR\n  a[Client] e1@-->|asks| b[API]\n  b e2@--> c[DB]\n",
    node: node("a", "Client"),
    edge: edge("e1", "a", "b", "asks"),
    relabelNode: (s) => s.replace("a[Client]", "a[Browser]"),
    relabelEdge: (s) => s.replace("|asks|", "|calls|"),
    removeEdge: (s) => s.replace("a[Client] e1@-->|asks| b[API]", "a[Client]\n  b[API]"),
  },
  {
    name: "C4",
    source:
      'C4Container\n    Person(customer, "Customer")\n    System(api, "Shop API")\n    System(db, "Database")\n    Rel(customer, api, "Calls")\n    Rel(api, db, "Reads and writes")\n',
    node: node("customer", "Customer"),
    edge: edge("customer--api", "customer", "api", "Calls"),
    relabelNode: (s) => s.replace('"Customer"', '"Shopper"'),
    relabelEdge: (s) => s.replace('"Calls"', '"Uses"'),
    removeEdge: (s) => s.replace('    Rel(customer, api, "Calls")\n', ""),
  },
  {
    name: "state",
    source:
      "stateDiagram-v2\n    state Idle\n    state Checking\n    Idle --> Checking : submit\n    Checking --> Idle : fail\n",
    node: node("Idle", "Idle"),
    edge: edge("Idle--Checking", "Idle", "Checking", "submit"),
    relabelNode: (s) => s.replace("state Idle\n", "state Idle\n    Idle : Waiting\n"),
    relabelEdge: (s) => s.replace(": submit", ": send"),
    removeEdge: (s) => s.replace("    Idle --> Checking : submit\n", ""),
  },
  {
    name: "ER",
    source:
      "erDiagram\n    CUSTOMER\n    ORDER\n    LINE\n    CUSTOMER ||--o{ ORDER : places\n    ORDER ||--|{ LINE : contains\n",
    node: node("ORDER", "ORDER"),
    edge: edge("CUSTOMER--ORDER", "CUSTOMER", "ORDER", "places"),
    relabelNode: (s) => s.replace("    ORDER\n", '    ORDER["Purchase"]\n'),
    relabelEdge: (s) => s.replace(": places", ": submits"),
    removeEdge: (s) => s.replace("    CUSTOMER ||--o{ ORDER : places\n", ""),
  },
  {
    name: "architecture",
    source:
      "architecture-beta\n    group cloud(cloud)[Cloud]\n    service gateway(server)[Gateway] in cloud\n    service hub(database)[Hub] in cloud\n    service db(database)[DB] in cloud\n    gateway:R --> L:hub\n    hub:R --> L:db\n",
    node: node("gateway", "Gateway"),
    edge: edge("hub--db", "hub", "db"),
    relabelNode: (s) => s.replace("[Gateway]", "[Front door]"),
    // Architecture edges carry no label.
    relabelEdge: (s) => s,
    removeEdge: (s) => s.replace("    hub:R --> L:db\n", ""),
  },
];

describe.each(FAMILIES)("$name", (family) => {
  const walked = walkthrough([step({ nodes: [family.node] }), step({ edges: [family.edge] })]);

  test("ids kept: current", async () => {
    const resolved = resolveWalkthrough(walked, await model(family.source));
    expect([resolved.status, resolved.outOfDate, resolved.changed]).toEqual(["current", [], []]);
  });

  test("a label changed: changed, and the walkthrough still plays", async () => {
    const node = resolveWalkthrough(walked, await model(family.relabelNode(family.source)));
    expect([node.status, node.changed, node.steps[0]?.status]).toEqual(["current", [1], "changed"]);
    expect(node.steps[0]?.nodes[0]?.label).not.toBe(family.node.label);
    if (family.relabelEdge(family.source) !== family.source) {
      const edge = resolveWalkthrough(walked, await model(family.relabelEdge(family.source)));
      expect([edge.status, edge.changed]).toEqual(["current", [2]]);
    }
  });

  test("an edge removed: its step out of date, the walkthrough partly", async () => {
    const resolved = resolveWalkthrough(walked, await model(family.removeEdge(family.source)));
    expect([resolved.status, resolved.outOfDate, resolved.steps.map((s) => s.status)]).toEqual([
      "partly-out-of-date",
      [2],
      ["current", "out-of-date"],
    ]);
  });
});

describe("C4", () => {
  const C4 = FAMILIES[1]!.source;
  test("an alias rename puts its relationships out of date as well as the box", async () => {
    const renamed = await model(C4.replaceAll("customer", "shopper"));
    const resolved = resolveWalkthrough(
      walkthrough([
        step({ nodes: [node("customer", "Customer")] }),
        step({ edges: [edge("customer--api", "customer", "api", "Calls")] }),
        step({ edges: [edge("api--db", "api", "db", "Reads and writes")] }),
      ]),
      renamed,
    );
    expect(resolved.outOfDate).toEqual([1, 2]);
    expect(resolved.status).toBe("partly-out-of-date");
  });

  test("a duplicate relationship merges into the first, under the later label: changed (ADR 0034 risk)", async () => {
    const merged = await model(
      C4.replace(
        '    Rel(api, db, "Reads and writes")\n',
        '    Rel(api, db, "Reads and writes")\n    Rel(api, db, "Writes")\n',
      ),
    );
    const resolved = resolveWalkthrough(
      walkthrough([step({ edges: [edge("api--db", "api", "db", "Reads and writes")] })]),
      merged,
    );
    expect([resolved.status, resolved.changed, resolved.steps[0]?.edges[0]]).toEqual([
      "current",
      [1],
      { status: "changed", label: "Writes" },
    ]);
  });
});

describe("flowchart", () => {
  test("an edge id re-pointed to other ends is out of date", async () => {
    const now = await model("flowchart LR\n  a[Client] e1@--> c[DB]\n  b[API]\n");
    const resolved = resolveWalkthrough(walkthrough([step({ edges: [edge("e1", "a", "b")] })]), now);
    expect(resolved.steps[0]?.edges[0]?.status).toBe("out-of-date");
    expect(resolved.status).toBe("archived");
  });

  test("a subgraph and a node sharing an id resolve by kind", async () => {
    const shared =
      "flowchart LR\n  subgraph api[API service]\n    x[Handler]\n  end\n  api[API node]\n  a[Client] e1@--> api\n";
    const asGroup = node("api", "API service", "group"),
      asNode = node("api", "API node");
    const both = walkthrough([step({ nodes: [asGroup] }), step({ nodes: [asNode] })]);
    expect(resolveWalkthrough(both, await model(shared)).status).toBe("current");
    // Without the subgraph only the node resolves; without the node only the group.
    const noGroup = await model("flowchart LR\n  x[Handler]\n  api[API node]\n  a[Client] e1@--> api\n");
    expect(resolveWalkthrough(both, noGroup).outOfDate).toEqual([1]);
    const noNode = await model(
      "flowchart LR\n  subgraph api[API service]\n    x[Handler]\n  end\n  a[Client] e1@--> x\n",
    );
    expect(resolveWalkthrough(both, noNode).outOfDate).toEqual([2]);
  });

  test("a message needs its two boxes, not a line between them", async () => {
    const now = await model("flowchart LR\n  a[Client] e1@--> b[API]\n  c[Provider]\n");
    const ok = walkthrough([
      step({
        nodes: [node("a", "Client"), node("c", "Provider")],
        messages: [{ from: "a", to: "c", label: "Pay by card" }],
      }),
    ]);
    expect(resolveWalkthrough(ok, now).status).toBe("current");
    const gone = walkthrough([step({ messages: [{ from: "a", to: "z", label: "Pay" }] })]);
    expect(resolveWalkthrough(gone, now).status).toBe("archived");
  });
});

describe("archived", () => {
  const before = "flowchart LR\n  a[Client] e1@--> b[API]\n  b e2@--> c[DB]\n";
  const walked = walkthrough([
    step({ edges: [edge("e1", "a", "b")] }),
    step({ edges: [edge("e2", "b", "c")], nodes: [node("c", "DB")] }),
  ]);

  test("no step resolves: archived; the elements come back: current again, with nothing written", async () => {
    const stored = JSON.stringify(walked);
    const without = await model("flowchart LR\n  x[Other]\n");
    const archived = resolveWalkthrough(walked, without);
    expect([archived.status, archived.outOfDate]).toEqual(["archived", [1, 2]]);
    const back = resolveWalkthrough(walked, await model(before));
    expect([back.status, back.outOfDate]).toEqual(["current", []]);
    expect(JSON.stringify(walked)).toBe(stored);
  });

  test("a sequence or journey model resolves no step", async () => {
    const sequence = await model("sequenceDiagram\n  participant a as Client\n  participant b as API\n  a->>b: hi\n");
    expect(resolveWalkthrough(walked, sequence).status).toBe("archived");
  });
});

describe("the prototype's four walkthroughs (test/fixtures/walkthroughs)", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/walkthroughs");
  const read = (name: string) => readFileSync(join(dir, name));
  const parsed = validateWalkthroughsFile(JSON.parse(read("containers.walkthroughs.json").toString("utf8")));

  test("the fixture is a valid file, in its own byte order", () => {
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? serializeWalkthroughs(parsed.file) : "").toBe(
      read("containers.walkthroughs.json").toString("utf8"),
    );
  });

  test("two current, one partly out of date (the courier integration), one archived", async () => {
    const file = parsed.ok ? parsed.file : null;
    const current = await model(read("containers.mmd").toString("utf8"));
    expect(
      file?.walkthroughs.map((w) => [
        w.id,
        resolveWalkthrough(w, current).status,
        resolveWalkthrough(w, current).outOfDate,
      ]),
    ).toEqual([
      ["checkout-and-payment", "current", []],
      ["declined-card", "current", []],
      ["order-shipped", "partly-out-of-date", [2]],
      ["pay-with-card-form", "archived", [1, 2, 3, 4]],
    ]);
  });

  test("each is pinned to the revision of the source it was written against, where it is current", async () => {
    const sources: Record<string, string> = {
      "checkout-and-payment": "containers.mmd",
      "declined-card": "containers.mmd",
      "order-shipped": "containers-oct2.mmd",
      "pay-with-card-form": "containers-aug.mmd",
    };
    for (const w of parsed.ok ? parsed.file.walkthroughs : []) {
      const bytes = read(sources[w.id]!);
      expect(w.modelRevision, w.id).toBe(revisionOf(bytes));
      expect(resolveWalkthrough(w, await model(bytes.toString("utf8"))).status, w.id).toBe("current");
    }
  });
});
