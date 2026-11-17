// A flowchart's model lists its nodes, groups and edges by id; `sourceOrder` keeps the order they are written in,
// for what reads the source's order: the layout's model order and the Key's rows (owner, 2026-11-12). C4 and
// architecture models already list their elements and links as written, so they need no such field.

import { describe, expect, test } from "vitest";
import { compile } from "../../src/mermaid/index.ts";
import { checkAgainst } from "./support/schema.ts";

const nodes = (...ids: string[]) => ids.map((id) => ({ id, kind: "node" }));

describe("a flowchart's source order", () => {
  test("lists nodes and groups in the order each is first written, and edges as written", async () => {
    const source = [
      "flowchart TB",
      "  ask[Ask]:::you",
      "  plan[Plan]:::ai",
      "  dropped[Dropped]:::gone",
      "  ship[Ship]:::real",
      "  pat[Pat]:::person",
      "  ask z1@--> plan",
      "  plan e2@--> dropped",
      "  plan a3@--> ship",
      "  pat e4@--> ask",
      "  classDef real fill:#7f1d1d,stroke:#450a0a",
      "  classDef gone fill:#e5e7eb,stroke:#9ca3af",
      "  classDef ai fill:#f1f5f9,stroke:#64748b",
      "  classDef you fill:#dbeafe,stroke:#1d4ed8",
      "",
    ].join("\n");
    const result = await compile(source);
    expect(result.diagnostics).toEqual([]);
    expect(result.model).toMatchObject({
      sourceOrder: { elements: nodes("ask", "plan", "dropped", "ship", "pat"), edges: ["z1", "e2", "a3", "e4"] },
    });
    // The lists themselves stay sorted by id, as before.
    expect((result.model as { nodes: { id: string }[] }).nodes.map((n) => n.id)).toEqual([
      "ask",
      "dropped",
      "pat",
      "plan",
      "ship",
    ]);
    expect(checkAgainst("DiagramModel", result.model)).toEqual([]);
  });

  test("a group is placed at its subgraph line, a node at its first mention, wherever it is declared", async () => {
    const source = [
      "flowchart TB",
      "  vm e0@--> late",
      "  subgraph g1[GPU 1]",
      "    farm[Farm]",
      "    chat[Chat]",
      "  end",
      "  late[Late]",
      "  vm[VM] e1@--> farm",
      "  vm e2@--> chat",
      "",
    ].join("\n");
    const result = await compile(source);
    expect(result.model).toMatchObject({
      sourceOrder: {
        elements: [...nodes("vm", "late"), { id: "g1", kind: "group" }, ...nodes("farm", "chat")],
        edges: ["e0", "e1", "e2"],
      },
    });
  });

  test("tells a subgraph from a node that shares its id", async () => {
    const result = await compile(
      "flowchart TB\n  api[API]\n  subgraph api[Shares its ID]\n    click[Click]\n    other[Other]\n  end\n",
    );
    expect(result.model).toMatchObject({
      sourceOrder: { elements: [...nodes("api"), { id: "api", kind: "group" }, ...nodes("click", "other")] },
    });
  });

  test("is left out when it would say nothing the lists do not: nodes, then groups, each by id; edges by id", async () => {
    const same = await compile("flowchart LR\n  a[A] e1@--> b[B]\n  b e2@--> c[C]\n");
    expect(same.model).not.toHaveProperty("sourceOrder");
    // One swap anywhere and it is there, whole.
    const nodeSwap = await compile("flowchart LR\n  b[B] e1@--> a[A]\n");
    expect(nodeSwap.model).toMatchObject({ sourceOrder: { elements: nodes("b", "a"), edges: ["e1"] } });
    const edgeSwap = await compile("flowchart LR\n  a[A] e2@--> b[B]\n  b e1@--> a\n");
    expect(edgeSwap.model).toMatchObject({ sourceOrder: { elements: nodes("a", "b"), edges: ["e2", "e1"] } });
    const groupFirst = await compile("flowchart LR\n  subgraph g[G]\n    a[A]\n    b[B]\n  end\n");
    expect(groupFirst.model).toMatchObject({
      sourceOrder: { elements: [{ id: "g", kind: "group" }, ...nodes("a", "b")], edges: [] },
    });
  });

  test("follows an edit: a node appended to the source comes last", async () => {
    const { editFlowchart } = await import("../../src/authoring/flowchart-edit.ts");
    const edited = await editFlowchart("flowchart LR\n  b[B]\n  c[C]\n", {
      kind: "add-node",
      id: "a",
      label: "A",
    });
    expect(edited).toMatchObject({ ok: true });
    const result = await compile((edited as { source: string }).source);
    expect(result.model).toMatchObject({ sourceOrder: { elements: nodes("b", "c", "a") } });
  });

  test("C4 and architecture models list their elements and links as written, so they carry none", async () => {
    const c4 = await compile(
      'C4Context\n  Person(zed, "Zed")\n  System(alpha, "Alpha")\n  Rel(zed, alpha, "Uses")\n  Rel(alpha, zed, "Calls")\n',
    );
    expect((c4.model as { elements: { id: string }[] }).elements.map((e) => e.id)).toEqual(["zed", "alpha"]);
    expect(c4.model).not.toHaveProperty("sourceOrder");
    const arch = await compile(
      "architecture-beta\n  service web(server)[Web]\n  service api(server)[API]\n  service db(database)[DB]\n  web:R --> L:db\n  api:R --> L:web\n",
    );
    expect((arch.model as { services: { id: string }[] }).services.map((s) => s.id)).toEqual(["web", "api", "db"]);
    expect((arch.model as { edges: { id: string }[] }).edges.map((e) => e.id)).toEqual(["web--db", "api--web"]);
    expect(arch.model).not.toHaveProperty("sourceOrder");
  });
});
