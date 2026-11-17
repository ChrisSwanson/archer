// change-arrow: one operation, for flowchart edges and sequence messages, that
// sets where the arrowheads are (one-way, two-way) or turns the arrow round
// (reverse), splicing only the link or the two ends. Retargeting keeps an
// arrow two-way.

import { describe, expect, test } from "vitest";
import { editDiagram, type DiagramEdit } from "../../src/authoring/diagram-edit.ts";
import { previewAuthoring } from "../../src/authoring/preview.ts";

const flow = (edge: string) => `flowchart LR\n  a[A]\n  b[B]\n  c[C]\n  ${edge}\n  b e2@--> c\n`;
const seq = (message: string) =>
  `sequenceDiagram\n    participant a as A\n    participant b as B\n    participant c as C\n    ${message}\n`;

describe("flowchart", () => {
  test.each([
    ["a e1@--> b", "two-way", "a e1@<--> b"],
    ["a e1@-.->|x| b", "two-way", "a e1@<-.->|x| b"],
    ["a e1@===> b", "two-way", "a e1@<===> b"],
    ["a e1@<--> b", "one-way", "a e1@--> b"],
    ["a e1@<==>|x| b", "one-way", "a e1@==>|x| b"],
    ["a e1@-->|x| b", "reverse", "b e1@-->|x| a"],
    ["a[Alpha] e1@--> b", "reverse", "b e1@--> a[Alpha]"],
    ["a e1@<-.-> b", "reverse", "b e1@<-.-> a"],
  ] as const)("%s, %s: %s", async (edge, arrow, written) => {
    const source = edge.includes("[Alpha]") ? flow(edge).replace("  a[A]\n", "") : flow(edge);
    const result = await editDiagram(source, { kind: "change-arrow", id: "e1", arrow });
    expect(result).toEqual({ ok: true, source: source.replace(edge, written) });
  });

  test.each([
    ["a e1@--> b", "one-way"],
    ["a e1@<--> b", "two-way"],
    ["a e1@--> a", "reverse"],
  ] as const)("%s is already %s: nothing changes", async (edge, arrow) => {
    const source = flow(edge);
    expect(await editDiagram(source, { kind: "change-arrow", id: "e1", arrow })).toEqual({ ok: true, source });
  });

  test("an unknown edge is refused", async () => {
    expect(await editDiagram(flow("a e1@--> b"), { kind: "change-arrow", id: "nope", arrow: "two-way" })).toMatchObject(
      { ok: false, code: "edit_target_missing" },
    );
  });

  test("retargeting a two-way edge keeps it two-way", async () => {
    const source = flow("a e1@<-->|x| b");
    expect(await editDiagram(source, { kind: "retarget-edge", id: "e1", target: "c" })).toEqual({
      ok: true,
      source: source.replace("a e1@<-->|x| b", "a e1@<-->|x| c"),
    });
  });
});

describe("sequence", () => {
  test.each([
    ["a->>b: x", "two-way", "a<<->>b: x"],
    ["a-->>b: x", "two-way", "a<<-->>b: x"],
    ["a<<->>b: x", "one-way", "a->>b: x"],
    ["a<<-->>b: x", "one-way", "a-->>b: x"],
    ["a->>b: x", "reverse", "b->>a: x"],
    ["a-)b: x", "reverse", "b-)a: x"],
    ["a<<->>b: x", "reverse", "b<<->>a: x"],
  ] as const)("%s, %s: %s", async (message, arrow, written) => {
    const source = seq(message);
    expect(await editDiagram(source, { kind: "change-arrow", id: "msg-0", arrow })).toEqual({
      ok: true,
      source: source.replace(message, written),
    });
  });

  test("an async message has no two-way form in Mermaid", async () => {
    expect(await editDiagram(seq("a-)b: x"), { kind: "change-arrow", id: "msg-0", arrow: "two-way" })).toMatchObject({
      ok: false,
      code: "edit_invalid_message_kind",
    });
  });

  test("reversing a message that activates or deactivates is refused", async () => {
    expect(await editDiagram(seq("a->>+b: x"), { kind: "change-arrow", id: "msg-0", arrow: "reverse" })).toMatchObject({
      ok: false,
      code: "edit_activation_dependency",
    });
  });

  test("retargeting or changing the kind of a two-way message keeps it two-way", async () => {
    const source = seq("a<<->>b: x");
    expect(await editDiagram(source, { kind: "retarget-edge", id: "msg-0", target: "c" })).toEqual({
      ok: true,
      source: source.replace("a<<->>b", "a<<->>c"),
    });
    expect(await editDiagram(source, { kind: "retarget-edge", id: "msg-0", message: "reply" })).toEqual({
      ok: true,
      source: source.replace("a<<->>b", "a<<-->>b"),
    });
    expect(await editDiagram(source, { kind: "retarget-edge", id: "msg-0", message: "async" })).toMatchObject({
      ok: false,
      code: "edit_invalid_message_kind",
    });
  });
});

test.each([
  "stateDiagram-v2\n  state A\n  state B\n  A --> B\n",
  "erDiagram\n  A\n  B\n  A ||--o{ B : x\n",
  'C4Context\n  Person(p, "P")\n  Rel(p, p, "x")\n',
])("other families refuse it", async (source) => {
  const edit: DiagramEdit = { kind: "change-arrow", id: "A--B", arrow: "two-way" };
  expect(await editDiagram(source, edit)).toMatchObject({ ok: false, code: "edit_unsupported_for_family" });
});

test("the browser edit route takes it, and only the three arrows", async () => {
  const source = flow("a e1@--> b");
  const done = (await previewAuthoring(
    { source, edit: { kind: "change-arrow", id: "e1", arrow: "two-way" } },
    true,
  )) as { source: string };
  expect(done.source).toBe(source.replace("e1@-->", "e1@<-->"));
  await expect(
    previewAuthoring({ source, edit: { kind: "change-arrow", id: "e1", arrow: "both" } }, true),
  ).rejects.toThrow();
  await expect(previewAuthoring({ source, edit: { kind: "change-arrow", id: "e1" } }, true)).rejects.toThrow();
});
