/**
 * "Delete it and its connections" needs no server operation: the page chains `delete-edge` for each
 * connection, then `delete-node`, through the stateless edit route, and commits the final source as one
 * step. These tests hold that route open per family, and name the case where a middle step refuses
 * (the page then shows that refusal and keeps the original source).
 */
import { expect, test } from "vitest";
import { editDiagram, type DiagramEdit } from "../../src/authoring/diagram-edit.ts";
import { compile } from "../../src/mermaid/index.ts";

type Ends = { id: string; source?: string; target?: string; from?: string; to?: string; type?: string };
async function connections(source: string, id: string): Promise<string[]> {
  const model = (await compile(source)).model as unknown as Record<string, Ends[] | undefined> | null;
  if (!model) throw new Error("source does not compile");
  const edges =
    model.edges ?? model.relationships ?? model.transitions ?? (model.events ?? []).filter((e) => e.type === "message");
  // Last first: sequence message ids are source-order ordinals, so deleting from the end keeps the rest.
  return edges
    .filter((e) => [e.source, e.target, e.from, e.to].includes(id))
    .map((e) => e.id)
    .reverse();
}
async function cascade(source: string, id: string) {
  let current = source;
  for (const edge of await connections(source, id)) {
    const step = await editDiagram(current, { kind: "delete-edge", id: edge } as DiagramEdit);
    if (!step.ok) return step;
    current = step.source;
  }
  return editDiagram(current, { kind: "delete-node", id });
}

for (const [family, source, id, expected] of [
  [
    "flowchart",
    "flowchart LR\n  a[A]\n  b[B]\n  c[C]\n  a e1@--> b\n  b e2@--> c",
    "b",
    "flowchart LR\n  a[A]\n  c[C]",
  ],
  // A connection line that declares the node leaves its declaration behind, then that goes.
  [
    "flowchart inline declaration",
    "flowchart LR\n  a[A] e1@--> b[B]\n  c[C]\n  b e2@--> c",
    "b",
    "flowchart LR\n  a[A]\n  c[C]",
  ],
  [
    "C4",
    'C4Context\n  Person(u, "User")\n  System(s, "Shop")\n  System(p, "Pay")\n  Rel(u, s, "Uses")\n  Rel(s, p, "Charges")',
    "s",
    'C4Context\n  Person(u, "User")\n  System(p, "Pay")',
  ],
  ["ER", "erDiagram\n  A\n  B\n  C\n  A ||--o{ B : has\n  B ||--|{ C : holds", "B", "erDiagram\n  A\n  C"],
  [
    "state",
    "stateDiagram-v2\n  A : a\n  B : b\n  C : c\n  [*] --> A\n  A --> B\n  B --> C",
    "B",
    "stateDiagram-v2\n  A : a\n  C : c\n  [*] --> A",
  ],
  [
    "sequence",
    "sequenceDiagram\n  participant A\n  participant B\n  participant C\n  A->>B: hi\n  B->>C: go\n  A->>C: x",
    "B",
    "sequenceDiagram\n  participant A\n  participant C\n  A->>C: x",
  ],
] as const)
  test(`${family}: delete with connections chains through the edit route`, async () => {
    expect(await cascade(source, id)).toEqual({ ok: true, source: expected });
  });

for (const [name, source, id, code] of [
  // C would be left a bare `state C` that Mermaid does not draw.
  [
    "state leaves a bare neighbour",
    "stateDiagram-v2\n  state A\n  state B\n  state C\n  [*] --> A\n  A --> B\n  B --> C",
    "B",
    "edit_delete_leaves_undrawn_state",
  ],
] as const)
  test(`cascade stops on a middle refusal: ${name}`, async () => {
    expect(await cascade(source, id)).toMatchObject({ ok: false, code });
  });
