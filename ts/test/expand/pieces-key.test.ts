// A piece cut from a graph keeps what its Key and its layout read: the categories, and the source order of what
// it holds.
import { expect, test } from "vitest";
import { cutFor, cutModel, shapeOf } from "../../src/expand/pieces.ts";
import { compile } from "../../src/mermaid/index.ts";
import type { DiagramEnvelope } from "../../src/model/index.ts";

test("a cut piece keeps the categories, and the source order of what it holds", async () => {
  const source =
    "flowchart LR\n  %% archer-key gpu: Model server\n  c[C]\n  a[A]:::gpu\n  b[B]:::person\n  d[D]\n  a e1@--> b\n  b e2@--> c\n  c e3@--> d\n  classDef gpu fill:#ecfdf5,stroke:#0f766e\n";
  const model = (await compile(source)).model!;
  const envelope = {
    schemaVersion: 2,
    revision: `sha256:${"a".repeat(64)}`,
    view: { id: "v", kind: "freeform", title: "V" },
    model,
  } as unknown as DiagramEnvelope;
  const cut = cutFor(shapeOf(model)!, "b", new Set(["b"]), 10)!;
  const piece = cutModel(envelope, cut) as {
    categories?: unknown;
    sourceOrder?: unknown;
    nodes: { id: string }[];
    edges: { id: string }[];
  };
  expect(piece.categories).toEqual([{ name: "gpu", fill: "#ecfdf5", stroke: "#0f766e", meaning: "Model server" }]);
  expect(piece.nodes.map((n) => n.id).sort()).toEqual(["a", "c"]);
  // Only its own ids, in the order the source writes them.
  expect(piece.sourceOrder).toEqual({
    elements: [
      { id: "c", kind: "node" },
      { id: "a", kind: "node" },
    ],
    edges: piece.edges.map((e) => e.id).sort(),
  });
});
