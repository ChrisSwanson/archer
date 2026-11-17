// Mermaid is loaded once and its databases are module state: one parse must
// never see another's nodes, participants or edges, whether the parses run
// one after the other or are started together. (In mermaid 12.1.0 the
// flowchart and sequence types build a fresh database per parse; C4, block
// and timeline share one, which is why the engine serializes parses. These
// tests hold the outcome, whichever way it is achieved.)

import { expect, test } from "vitest";
import { mermaidInstance } from "../../src/mermaid/engine.ts";
import { compile } from "../../src/mermaid/index.ts";

const FIRST = "flowchart LR\n  a[Alpha]\n  b[Beta]\n  a ab@--> b\n  subgraph g[Group]\n    b\n  end\n";
const SECOND = "flowchart TB\n  c[Gamma]\n";
const SEQUENCE_FIRST = "sequenceDiagram\n  participant p as P\n  participant q as Q\n  p->>q: hi\n";
const SEQUENCE_SECOND = "sequenceDiagram\n  participant r as R\n  r->>r: self\n";

test("a second flowchart holds nothing of the first", async () => {
  const first = await compile(FIRST);
  const second = await compile(SECOND);
  expect(first.model).toMatchObject({
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [{ id: "ab" }],
    groups: [{ id: "g" }],
  });
  expect(second.model).toEqual({
    type: "freeform-graph",
    direction: "tb",
    nodes: [{ id: "c", label: "Gamma", shape: "rectangle" }],
    edges: [],
    groups: [],
  });
});

test("a second sequence diagram holds nothing of the first", async () => {
  await compile(SEQUENCE_FIRST);
  const second = await compile(SEQUENCE_SECOND);
  expect(second.model).toEqual({
    type: "sequence-trace",
    participants: [{ id: "r", label: "R" }],
    events: [{ type: "message", id: "msg-0", from: "r", to: "r", label: "self", kind: "sync" }],
  });
});

test("compiling the same source twice gives the same result", async () => {
  const once = await compile(FIRST);
  await compile(SEQUENCE_FIRST);
  const twice = await compile(FIRST);
  expect(twice).toEqual(once);
});

test("parses started together give what they give one at a time", async () => {
  const sources = [FIRST, SEQUENCE_FIRST, SECOND, SEQUENCE_SECOND, FIRST, SECOND];
  const alone: unknown[] = [];
  for (const source of sources) alone.push(await compile(source));
  const together = await Promise.all(sources.map((source) => compile(source)));
  expect(together).toEqual(alone);
});

test("Mermaid is loaded once and the same instance serves every parse", async () => {
  const first = await mermaidInstance();
  await compile(FIRST);
  await compile(SEQUENCE_FIRST);
  expect(await mermaidInstance()).toBe(first);
});

test("a refused parse leaves nothing behind for the next", async () => {
  const refused = await compile("flowchart LR\n  a[A]\n  b(\n");
  expect(refused.model).toBeNull();
  const after = await compile(SECOND);
  expect(after.model).toMatchObject({ nodes: [{ id: "c" }] });
});

// C4 hands every parse the same database object (research 01), so a C4 parse
// must hold nothing of the one before it, whether run alone or together.
const C4_FIRST =
  'C4Context\n  title First\n  Person(a, "A")\n  System_Boundary(b, "B") {\n    System(s, "S")\n  }\n  Rel(a, s, "uses")\n';
const C4_SECOND = 'C4Container\n  Container(c, "C", "Go")\n';
const OTHERS = [
  "stateDiagram-v2\n  A : Alpha\n  [*] --> A\n",
  "erDiagram\n  A\n  B\n  A ||--o{ B : has\n",
  "architecture-beta\n  service a(server)[A]\n",
  "journey\n  section S\n    Go: 3: Me\n",
];

test("a second C4 diagram holds nothing of the first", async () => {
  await compile(C4_FIRST);
  const second = await compile(C4_SECOND);
  expect(second.model).toEqual({
    type: "c4-model",
    level: "container",
    elements: [{ id: "c", kind: "container", label: "C", technology: "Go" }],
    boundaries: [],
    relationships: [],
  });
});

test("C4 and the other new types started together give what they give one at a time", async () => {
  const sources = [C4_FIRST, ...OTHERS, C4_SECOND, C4_FIRST, ...OTHERS.slice().reverse(), C4_SECOND];
  const alone: unknown[] = [];
  for (const source of sources) alone.push(await compile(source));
  const together = await Promise.all(sources.map((source) => compile(source)));
  expect(together).toEqual(alone);
  expect(alone.every((result) => (result as { model: unknown }).model !== null)).toBe(true);
});
