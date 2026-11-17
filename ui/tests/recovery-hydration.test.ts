import { expect, test } from "vitest";
import { recoveredSelection, selectionReducer } from "../src/selection/state";
const stamp = { viewId: "flow", revision: "valid-revision", presentationId: "present-abc" };
const raw = { schemaVersion: 1, ...stamp, selectionRevision: 7, nodes: [{ id: "a", label: "Customer" }], edges: [] };
const ids = { nodeIds: ["a", "b"], edgeIds: [] };
test("recovery keeps exact selection revision and enters the production reducer", () => {
  const restored = recoveredSelection(raw, stamp, ids);
  expect(restored).toMatchObject({ selectionRevision: 7, selectedNodeIds: ["a"], additiveBase: null });
  expect(selectionReducer(null, { type: "restore", state: restored! })).toEqual(restored);
});
test.each([
  { revision: "changed" },
  { presentationId: "different" },
  { viewId: "other" },
  { nodes: [{ id: "missing" }] },
  { nodes: [{ id: "a" }, { id: "a" }] },
  { selectionRevision: -1 },
])("recovery refuses stale or invalid %j", (patch) => {
  expect(recoveredSelection({ ...raw, ...patch }, stamp, ids)).toBeNull();
});
