import { describe, expect, it } from "vitest";
import { selectionReducer, type SelectionState } from "../src/selection/state";
import { buildSelectionContext } from "../src/selection/bridge";

describe("selectionReducer", () => {
  it("page_turn clears selection", () => {
    const selected = selectionReducer(null, {
      type: "page_turn",
      viewId: "view-a",
      revision: "rev-1",
      presentationId: "p1",
    });
    expect(selected).not.toBeNull();
    expect((selected as SelectionState).selectedNodeIds).toEqual([]);
    expect((selected as SelectionState).selectedEdgeIds).toEqual([]);

    const withSelection = selectionReducer(selected, {
      type: "select",
      nodeIds: ["n1"],
      edgeIds: [],
    }) as SelectionState;
    expect(withSelection.selectedNodeIds).toEqual(["n1"]);

    const afterPageTurn = selectionReducer(withSelection, {
      type: "page_turn",
      viewId: "view-b",
      revision: "rev-2",
      presentationId: "p1",
    }) as SelectionState;
    expect(afterPageTurn.selectedNodeIds).toEqual([]);
    expect(afterPageTurn.selectedEdgeIds).toEqual([]);
    expect(afterPageTurn.viewId).toBe("view-b");
    expect(afterPageTurn.selectionRevision).toBe(0);
  });

  it("select updates selection revision", () => {
    const base = selectionReducer(null, {
      type: "page_turn",
      viewId: "view-a",
      revision: "rev-1",
      presentationId: "p1",
    }) as SelectionState;
    expect(base.selectionRevision).toBe(0);

    const selected = selectionReducer(base, {
      type: "select",
      nodeIds: ["n1"],
      edgeIds: ["e1"],
    }) as SelectionState;
    expect(selected.selectionRevision).toBe(1);
    expect(selected.selectedNodeIds).toEqual(["n1"]);
    expect(selected.selectedEdgeIds).toEqual(["e1"]);

    const selectedAgain = selectionReducer(selected, {
      type: "select",
      nodeIds: ["n2"],
      edgeIds: [],
    }) as SelectionState;
    expect(selectedAgain.selectionRevision).toBe(2);
  });

  // A recompile of the view the user is on is not a page turn: stable IDs mean
  // a node that survived the edit is still the same node, so it stays
  // selected. This is asserted at reducer level on purpose -- React Flow
  // reports a removed node through `onSelectionChange` by itself, so the
  // rendered canvas looks the same whether or not the reducer drops the ID,
  // and only the state can show that it never names an element the model
  // no longer contains. The user-visible half (a surviving node stays
  // selected and is re-stamped) is asserted in `app.render.test.tsx`.
  it("revision_change keeps surviving ids, drops removed ones, and re-stamps", () => {
    const base = selectionReducer(null, {
      type: "page_turn",
      viewId: "view-a",
      revision: "rev-1",
      presentationId: "p1",
    }) as SelectionState;
    const selected = selectionReducer(base, {
      type: "select",
      nodeIds: ["kept", "removed"],
      edgeIds: ["e-kept", "e-removed"],
    }) as SelectionState;

    const afterEdit = selectionReducer(selected, {
      type: "revision_change",
      revision: "rev-2",
      nodeIds: ["kept", "unrelated"],
      edgeIds: ["e-kept"],
    }) as SelectionState;

    expect(afterEdit.selectedNodeIds).toEqual(["kept"]);
    expect(afterEdit.selectedEdgeIds).toEqual(["e-kept"]);
    // The stamp the host validates the next click against has to move with the
    // model, and losing part of the selection is a change the host must see.
    expect(afterEdit.revision).toBe("rev-2");
    expect(afterEdit.viewId).toBe("view-a");
    expect(afterEdit.selectionRevision).toBe(selected.selectionRevision + 1);
  });

  it("revision_change that changes nothing re-stamps without a new selection", () => {
    const base = selectionReducer(null, {
      type: "page_turn",
      viewId: "view-a",
      revision: "rev-1",
      presentationId: "p1",
    }) as SelectionState;
    const selected = selectionReducer(base, {
      type: "select",
      nodeIds: ["kept"],
      edgeIds: [],
    }) as SelectionState;

    const afterEdit = selectionReducer(selected, {
      type: "revision_change",
      revision: "rev-2",
      nodeIds: ["kept", "added"],
      edgeIds: [],
    }) as SelectionState;

    expect(afterEdit.selectedNodeIds).toEqual(["kept"]);
    expect(afterEdit.revision).toBe("rev-2");
    expect(afterEdit.selectionRevision).toBe(selected.selectionRevision);
  });

  it("select before page_turn returns null", () => {
    const result = selectionReducer(null, {
      type: "select",
      nodeIds: ["n1"],
      edgeIds: [],
    });
    expect(result).toBeNull();
  });

  it("clear keeps viewId but empties selection", () => {
    const base = selectionReducer(null, {
      type: "page_turn",
      viewId: "view-a",
      revision: "rev-1",
      presentationId: "p1",
    }) as SelectionState;
    const selected = selectionReducer(base, {
      type: "select",
      nodeIds: ["n1"],
      edgeIds: ["e1"],
    }) as SelectionState;
    const cleared = selectionReducer(selected, { type: "clear" }) as SelectionState;
    expect(cleared.viewId).toBe("view-a");
    expect(cleared.revision).toBe("rev-1");
    expect(cleared.presentationId).toBe("p1");
    expect(cleared.selectedNodeIds).toEqual([]);
    expect(cleared.selectedEdgeIds).toEqual([]);
    expect(cleared.selectionRevision).toBe(selected.selectionRevision + 1);
  });
});

describe("buildSelectionContext", () => {
  it("includes only selected elements", () => {
    const state: SelectionState = {
      viewId: "view-a",
      revision: "rev-1",
      presentationId: "p1",
      selectionRevision: 1,
      selectedNodeIds: ["n1"],
      selectedEdgeIds: ["e1"],
      additiveBase: null,
    };
    const nodeDetails = new Map([
      ["n1", { label: "Node 1" }],
      ["n2", { label: "Node 2" }],
    ]);
    const edgeDetails = new Map([
      ["e1", { source: "n1", target: "n2", label: "calls" }],
      ["e2", { source: "n2", target: "n1" }],
    ]);

    const ctx = buildSelectionContext(state, nodeDetails, edgeDetails);
    expect(ctx.nodes).toHaveLength(1);
    expect(ctx.nodes[0]).toEqual({ id: "n1", label: "Node 1" });
    expect(ctx.edges).toHaveLength(1);
    expect(ctx.edges[0]).toEqual({ id: "e1", source: "n1", target: "n2", label: "calls" });
    expect(ctx.viewId).toBe("view-a");
    expect(ctx.revision).toBe("rev-1");
    expect(ctx.presentationId).toBe("p1");
    expect(ctx.selectionRevision).toBe(1);
    expect(ctx.schemaVersion).toBe(1);
  });

  it("with empty selection returns empty arrays", () => {
    const state: SelectionState = {
      viewId: "view-a",
      revision: "rev-1",
      presentationId: "p1",
      selectionRevision: 0,
      selectedNodeIds: [],
      selectedEdgeIds: [],
      additiveBase: null,
    };
    const ctx = buildSelectionContext(state, new Map(), new Map());
    expect(ctx.nodes).toEqual([]);
    expect(ctx.edges).toEqual([]);
  });

  // Plan section 3, rule 8: selection is context, not an assertion about what
  // the reader intends. The page has no way to know why something was clicked, so
  // what it publishes is the WHOLE of what it knows: which elements, of which
  // model. A field added here -- a note, a prompt, an intent -- would be the
  // page speaking for the reader.
  it("says what is selected and against which model, and nothing else", () => {
    const state: SelectionState = {
      viewId: "view-a",
      revision: "rev-1",
      presentationId: "p1",
      selectionRevision: 3,
      selectedNodeIds: ["n1"],
      selectedEdgeIds: ["e1", "e2"],
      additiveBase: null,
    };
    const ctx = buildSelectionContext(
      state,
      new Map([["n1", { label: "Node 1" }]]),
      new Map([
        ["e1", { source: "n1", target: "n2", label: "calls" }],
        ["e2", { source: "n2", target: "n1" }],
      ]),
    );

    expect(ctx).toEqual({
      schemaVersion: 1,
      viewId: "view-a",
      revision: "rev-1",
      presentationId: "p1",
      selectionRevision: 3,
      nodes: [{ id: "n1", label: "Node 1" }],
      edges: [
        { id: "e1", source: "n1", target: "n2", label: "calls" },
        { id: "e2", source: "n2", target: "n1" },
      ],
    });
  });
});
