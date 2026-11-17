// A label's line break is `\n` in the model and `<br/>` in the source: every
// editor writes a new label's breaks as `<br/>`, the result reads back to the
// same lines, and an edit elsewhere leaves a break as it was written.

import { expect, test } from "vitest";
import { editDiagram, type DiagramEdit } from "../../src/authoring/diagram-edit.ts";
import { previewAuthoring } from "../../src/authoring/preview.ts";
import { compile } from "../../src/mermaid/index.ts";

const cases: { family: string; source: string; edit: DiagramEdit; written: string }[] = [
  {
    family: "flowchart node",
    source: "flowchart LR\n  a[A]\n  b[B]\n  a e1@--> b\n",
    edit: { kind: "relabel-node", id: "a", label: "Web < 5ms\nEU" },
    written: 'a["Web #lt; 5ms<br/>EU"]',
  },
  {
    family: "flowchart edge",
    source: "flowchart LR\n  a[A]\n  b[B]\n  a e1@--> b\n",
    edit: { kind: "relabel-edge", id: "e1", label: "reads\nwrites" },
    written: 'e1@-->|"reads<br/>writes"|',
  },
  {
    family: "flowchart new node",
    source: "flowchart LR\n  a[A]\n",
    edit: { kind: "add-node", id: "c", label: "one\ntwo" },
    written: 'c["one<br/>two"]',
  },
  {
    family: "sequence message",
    source: "sequenceDiagram\n    participant a as A\n    a->>a: x\n",
    edit: { kind: "relabel-edge", id: "msg-0", label: "GET;\n200" },
    written: "a->>a: GET#59;<br/>200",
  },
  {
    family: "sequence note",
    source: "sequenceDiagram\n    participant a as A\n    Note over a: x\n",
    edit: { kind: "relabel-note", id: "note-0", text: "one\ntwo" },
    written: "Note over a: one<br/>two",
  },
  {
    family: "sequence participant",
    source: "sequenceDiagram\n    participant a as A\n    a->>a: x\n",
    edit: { kind: "relabel-node", id: "a", label: "Web\nEU" },
    written: "participant a as Web<br/>EU",
  },
  {
    family: "C4 element",
    source: 'C4Context\n    Person(p, "P")\n',
    edit: { kind: "relabel-node", id: "p", label: "End\nuser" },
    written: 'Person(p, "End<br/>user")',
  },
  {
    family: "ER entity",
    source: "erDiagram\n    A\n    B\n    A ||--o{ B : has\n",
    edit: { kind: "relabel-node", id: "A", label: "Order\nline" },
    written: 'A["Order<br/>line"]',
  },
  {
    family: "ER relationship",
    source: "erDiagram\n    A\n    B\n    A ||--o{ B : has\n",
    edit: { kind: "relabel-edge", id: "A--B", label: "has\nmany" },
    written: '"has<br/>many"',
  },
  {
    family: "state",
    source: "stateDiagram-v2\n    A : A\n    B : B\n    A --> B : go\n",
    edit: { kind: "relabel-edge", id: "A--B", label: "go\nnow" },
    written: "A --> B : go<br/>now",
  },
];

test.each(cases)(
  "$family: a new label's line break is written as <br/> and reads back as a line break",
  async ({ source, edit, written }) => {
    const result = await editDiagram(source, edit);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.source).toContain(written);
    const label = "label" in edit ? edit.label : "text" in edit ? edit.text : "";
    expect(JSON.stringify((await compile(result.source)).model)).toContain(JSON.stringify(label).slice(1, -1));
  },
);

test("an edit elsewhere keeps a line break exactly as it was written", async () => {
  const source = 'flowchart LR\n  a["one<BR >two"]\n  b[B<br>c]\n  a e1@-->|x</br>y| b\n';
  const result = await editDiagram(source, { kind: "retarget-edge", id: "e1", source: "b", target: "a" });
  expect(result).toEqual({
    ok: true,
    source: 'flowchart LR\n  a["one<BR >two"]\n  b[B<br>c]\n  b e1@-->|x</br>y| a\n',
  });
  // Relabelling to the label it already holds changes nothing.
  expect(await editDiagram(source, { kind: "relabel-node", id: "b", label: "B\nc" })).toEqual({ ok: true, source });
});

test("the browser edit request takes \\n as a line break and still refuses other control characters", async () => {
  const source = "flowchart LR\n  a[A]\n";
  const ok = (await previewAuthoring({ source, edit: { kind: "relabel-node", id: "a", label: "one\ntwo" } }, true)) as {
    ok: boolean;
    source: string;
  };
  expect(ok.source).toBe('flowchart LR\n  a["one<br/>two"]\n');
  await expect(
    previewAuthoring({ source, edit: { kind: "relabel-node", id: "a", label: "one\rtwo" } }, true),
  ).rejects.toThrow(/control characters/);
});
