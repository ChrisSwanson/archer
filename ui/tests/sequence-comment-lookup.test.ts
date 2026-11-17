// @vitest-environment jsdom
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { anchorIds, anchorMissing, commentScopes, diagramChoices } from "../src/comments/canvas-anchors";
import { projectEnvelope } from "../src/diagrams/projection";

async function drawing(label: string) {
  const { compile } = await import(resolve(__dirname, "../../ts/src/mermaid/index.ts"));
  const compiled = await compile(
    `sequenceDiagram\nparticipant A as Client\nparticipant B as Server\nalt Ready\nA->>B: Send\nopt Cached\nNote over A,B: ${label}\nB-->>A: Hit\nend\nelse Wait\nNote right of B: Waiting\nend\n`,
  );
  expect(compiled.diagnostics).toEqual([]);
  const model = projectEnvelope({
    schemaVersion: 2,
    view: { id: "sequence", kind: "sequence", title: "Sequence" },
    revision: `sha256:${"a".repeat(64)}`,
    model: compiled.model,
  });
  if (!model.ok || model.type !== "sequence") throw new Error("sequence projection failed");
  return model;
}

test("repeated scope lookups preserve nested source order and refresh when the projected view changes", async () => {
  const first = await drawing("Original");
  const expected = [
    { kind: "view" },
    { kind: "group", id: "frag-0", label: "Ready" },
    { kind: "group", id: "frag-1", label: "Cached" },
    { kind: "node", id: "note-0", label: "Original" },
    { kind: "node", id: "note-1", label: "Waiting" },
  ];
  const note = expected[3] as { kind: "node"; id: string; label: string };
  for (let i = 0; i < 3; i++) {
    expect(diagramChoices(first, [], []).map((choice) => choice.anchor)).toEqual(expected);
    expect(anchorIds(note, first)).toBeNull();
    expect(anchorMissing(first, note)).toBe(false);
    expect(anchorIds({ kind: "node", id: "A", label: "Client" }, first)).toEqual({ nodeIds: ["A"], edgeIds: [] });
  }
  const next = await drawing("Replacement");
  expect(diagramChoices(next, [], []).map((choice) => choice.anchor)).toEqual([
    ...expected.slice(0, 3),
    { ...note, label: "Replacement" },
    expected[4],
  ]);
  expect(diagramChoices(first, [], []).map((choice) => choice.anchor)).toEqual(expected);
});

test("the drawn model supplies scope choices and guards without guarding authored participants", async () => {
  const model = await drawing("Original");
  const scopes = commentScopes(model);
  expect(scopes.choices).toBe(true);
  expect(scopes.guard?.({ kind: "group", id: "frag-0", label: "Ready" })).toBe("block");
  expect(scopes.guard?.({ kind: "node", id: "note-0", label: "Original" })).toBe("note");
  expect(scopes.guard?.({ kind: "node", id: "A", label: "Client" })).toBeUndefined();
  expect(scopes.guard?.({ kind: "view" })).toBeUndefined();
  expect(commentScopes(null)).toEqual({ choices: false });
});
