// @vitest-environment jsdom
import { resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { anchorAt, anchorIds, anchorMissing, diagramChoices, type DrawnModel } from "../src/comments/canvas-anchors";
import { projectEnvelope } from "../src/diagrams/projection";
import { sequenceSelectionModel } from "../src/selection/sequence-selection";

async function drawing(): Promise<DrawnModel> {
  const compilerPath = resolve(__dirname, "../../ts/src/mermaid/index.ts");
  const { compile } = await import(compilerPath);
  const compiled = await compile(
    "sequenceDiagram\nparticipant A\nparticipant B\nalt ready\n A->>B: Start\n opt cached\n  B-->>A: Hit\n end\nelse wait\n B-->>A: Wait\nend\n",
  );
  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.model?.type).toBe("sequence-trace");
  const projected = projectEnvelope({
    schemaVersion: 2,
    view: { id: "seq", kind: "sequence", title: "Sequence" },
    revision: `sha256:${"a".repeat(64)}`,
    model: compiled.model,
  });
  if (!projected.ok || projected.type !== "sequence") throw new Error("sequence projection failed");
  return projected;
}

afterEach(() => {
  document.body.replaceChildren();
});

test("the target picker includes whole nested blocks without adding them to selection", async () => {
  const model = await drawing();
  const choices = diagramChoices(model, [], []);
  expect(choices.map((c) => c.anchor)).toEqual([
    { kind: "view" },
    { kind: "group", id: "frag-0", label: "ready" },
    { kind: "group", id: "frag-1", label: "cached" },
  ]);
  expect(choices.map((c) => c.label)).toEqual(["Whole diagram", "alt block: ready", "opt block: cached"]);
  expect(anchorIds(choices[1]!.anchor)).toBeNull();
  if (model.type !== "sequence") throw new Error("expected sequence");
  expect(sequenceSelectionModel(model.view).nodeDetails.has("frag-0")).toBe(false);
  expect([...sequenceSelectionModel(model.view).edgeDetails.keys()]).not.toContain("frag-0");
});

test("header and border hits resolve blocks, while a child message keeps priority", async () => {
  const model = await drawing();
  document.body.innerHTML =
    '<svg><g data-seq-channel="fragments" data-seq-id="frag-0"><rect/><g data-seq-channel="messages" data-seq-id="msg-0"><path/></g></g><g data-seq-channel="fragments" data-seq-id="frag-1"><text/></g></svg>';
  expect(anchorAt(document.querySelector("rect"), model)).toEqual({ kind: "group", id: "frag-0", label: "ready" });
  expect(anchorAt(document.querySelector("text"), model)).toEqual({ kind: "group", id: "frag-1", label: "cached" });
  expect(anchorAt(document.querySelector("path"), model)).toEqual({ kind: "edge", id: "msg-0", label: "Start" });
  expect(anchorMissing(model, { kind: "group", id: "frag-1", label: "cached" })).toBe(false);
  expect(anchorMissing(model, { kind: "group", id: "frag-99", label: "gone" })).toBe(true);
});
