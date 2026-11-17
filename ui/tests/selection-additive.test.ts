/**
 * The union rule behind an additive marquee.
 *
 * The canvas reports the rectangle's CURRENT contents each time they change
 * (`marquee-contents.test.tsx`), not what was selected when the drag began. So
 * "add to the selection" means: remember what was held at the start, and merge
 * every report into it until the drag ends.
 *
 * Kept in the reducer because it is a rule about state, not about pointers --
 * `additive-marquee.test.tsx` covers the gesture reaching it.
 */
import { describe, expect, it } from "vitest";
import { selectionReducer, type SelectionState } from "../src/selection/state";

const base: SelectionState = {
  viewId: "view-a",
  revision: "rev-1",
  presentationId: "p1",
  selectionRevision: 3,
  selectedNodeIds: ["n1"],
  selectedEdgeIds: ["e1"],
  additiveBase: null,
};

describe("an additive marquee merges into what was already held", () => {
  it("keeps the starting selection and adds the rectangle's contents", () => {
    const started = selectionReducer(base, { type: "marquee_start", additive: true });
    const moved = selectionReducer(started, { type: "select", nodeIds: ["n2"], edgeIds: [] });

    expect(moved?.selectedNodeIds).toEqual(["n1", "n2"]);
    expect(moved?.selectedEdgeIds).toEqual(["e1"]);
  });

  it("does not double-count a node the rectangle also covers", () => {
    const started = selectionReducer(base, { type: "marquee_start", additive: true });
    const moved = selectionReducer(started, { type: "select", nodeIds: ["n1", "n2"], edgeIds: ["e1"] });

    expect(moved?.selectedNodeIds).toEqual(["n1", "n2"]);
    expect(moved?.selectedEdgeIds).toEqual(["e1"]);
  });

  it("keeps merging into the START selection as the rectangle shrinks", () => {
    // Each pointer move is a fresh report, not a delta. Merging into the
    // PREVIOUS result instead would make the selection grow monotonically and
    // never let go of a node the user has dragged back off.
    const started = selectionReducer(base, { type: "marquee_start", additive: true });
    const wide = selectionReducer(started, { type: "select", nodeIds: ["n2", "n3"], edgeIds: [] });
    const narrowed = selectionReducer(wide, { type: "select", nodeIds: ["n2"], edgeIds: [] });

    expect(narrowed?.selectedNodeIds).toEqual(["n1", "n2"]);
  });

  it("stops merging once the drag ends", () => {
    const started = selectionReducer(base, { type: "marquee_start", additive: true });
    const moved = selectionReducer(started, { type: "select", nodeIds: ["n2"], edgeIds: [] });
    const ended = selectionReducer(moved, { type: "marquee_end" });
    const afterwards = selectionReducer(ended, { type: "select", nodeIds: ["n4"], edgeIds: [] });

    expect(afterwards?.selectedNodeIds).toEqual(["n4"]);
  });

  it("replaces, not merges, when the drag was not additive", () => {
    const started = selectionReducer(base, { type: "marquee_start", additive: false });
    const moved = selectionReducer(started, { type: "select", nodeIds: ["n2"], edgeIds: [] });

    expect(moved?.selectedNodeIds).toEqual(["n2"]);
    expect(moved?.selectedEdgeIds).toEqual([]);
  });

  it("does not publish a new selection merely for starting or ending a drag", () => {
    // The revision is what the host validates against; bumping it for a
    // gesture that changed nothing would be a selection the user never made.
    const started = selectionReducer(base, { type: "marquee_start", additive: true });
    expect(started?.selectionRevision).toBe(base.selectionRevision);

    const ended = selectionReducer(started, { type: "marquee_end" });
    expect(ended?.selectionRevision).toBe(base.selectionRevision);
  });

  it("drops a half-finished additive drag when the page turns", () => {
    const started = selectionReducer(base, { type: "marquee_start", additive: true });
    const turned = selectionReducer(started, {
      type: "page_turn",
      viewId: "view-b",
      revision: "rev-9",
      presentationId: "p2",
    });

    expect(turned?.additiveBase).toBeNull();
    expect(turned?.selectedNodeIds).toEqual([]);
  });
});
