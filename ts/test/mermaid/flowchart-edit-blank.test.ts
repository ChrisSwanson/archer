import { expect, test } from "vitest";
import { editFlowchart } from "../../src/authoring/flowchart-edit.ts";
import { compile } from "../../src/mermaid/index.ts";
test("draw a blank shape before choosing its label and preserve exact no-ops", async () => {
  const empty = "flowchart LR\n",
    added = await editFlowchart(empty, { kind: "add-node", id: "node_a", label: "" });
  expect(added.ok).toBe(true);
  if (!added.ok) throw new Error(added.code);
  expect((await compile(added.source)).model).toMatchObject({ nodes: [{ id: "node_a", label: "" }] });
  const labeled = await editFlowchart(added.source, { kind: "relabel-node", id: "node_a", label: "API" });
  expect(labeled.ok).toBe(true);
  if (!labeled.ok) throw new Error(labeled.code);
  const cleared = await editFlowchart(labeled.source, { kind: "relabel-node", id: "node_a", label: "" });
  expect(cleared.ok).toBe(true);
  if (!cleared.ok) throw new Error(cleared.code);
  expect((await compile(cleared.source)).model).toMatchObject({ nodes: [{ id: "node_a", label: "" }] });
  expect(await editFlowchart(cleared.source, { kind: "relabel-node", id: "node_a", label: "" })).toEqual({
    ok: true,
    source: cleared.source,
  });
});
test("optional connector labels can be left blank or cleared without empty pipes", async () => {
  const source = "flowchart LR\n a[A]\n b[B]\n";
  const connected = await editFlowchart(source, { kind: "connect", id: "e1", source: "a", target: "b", label: "" });
  expect(connected.ok).toBe(true);
  if (!connected.ok) throw new Error(connected.code);
  const model = (await compile(connected.source)).model;
  expect(model).toMatchObject({ edges: [{ id: "e1", source: "a", target: "b" }] });
  expect(model && "edges" in model && model.edges[0]).not.toHaveProperty("label");
  const labeled = await editFlowchart(connected.source, { kind: "relabel-edge", id: "e1", label: "calls" });
  expect(labeled.ok).toBe(true);
  if (!labeled.ok) throw new Error(labeled.code);
  const cleared = await editFlowchart(labeled.source, { kind: "relabel-edge", id: "e1", label: "" });
  expect(cleared).toEqual({ ok: true, source: connected.source });
});
