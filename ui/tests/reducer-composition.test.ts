import { describe, expect, it } from "vitest";
import {
  presentationReducer,
  initialPresentationState,
  type PresentationAction,
  type PresentationState,
} from "../src/presentation/controller";
import { selectionReducer, type SelectionAction, type SelectionState } from "../src/selection/state";
import { buildSelectionContext } from "../src/selection/bridge";
import { createStandaloneBridge } from "../src/app/host-bridge";

function dispatchPresentation(
  state: PresentationState | null,
  ...actions: PresentationAction[]
): PresentationState | null {
  return actions.reduce(presentationReducer, state);
}

function dispatchSelection(state: SelectionState | null, ...actions: SelectionAction[]): SelectionState | null {
  return actions.reduce(selectionReducer, state);
}

// These are pure reducer/bridge composition tests: they drive the reducers
// directly and assert the state algebra. They deliberately do NOT cover App
// wiring -- `app.render.test.tsx` mounts the real component for that.
describe("presentation/selection reducer composition", () => {
  it("page turn clears selection and resets selectionRevision", () => {
    let presentation = dispatchPresentation(initialPresentationState(), {
      type: "present",
      command: { presentationId: "p1", viewId: "v1" },
      revision: "rev1",
    });
    let selection = dispatchSelection(null, {
      type: "page_turn",
      viewId: "v1",
      revision: "rev1",
      presentationId: "p1",
    });

    selection = dispatchSelection(selection, {
      type: "select",
      nodeIds: ["n1", "n2"],
      edgeIds: [],
    });
    expect(selection!.selectionRevision).toBe(1);
    expect(selection!.selectedNodeIds).toEqual(["n1", "n2"]);

    presentation = dispatchPresentation(presentation, {
      type: "present",
      command: { presentationId: "p2", viewId: "v2" },
      revision: "rev2",
    });
    selection = dispatchSelection(selection, {
      type: "page_turn",
      viewId: "v2",
      revision: "rev2",
      presentationId: "p2",
    });

    expect(presentation!.viewId).toBe("v2");
    expect(presentation!.layoutGeneration).toBe(2);
    expect(selection!.selectionRevision).toBe(0);
    expect(selection!.selectedNodeIds).toEqual([]);
  });

  it("same-view focus does not increment layoutGeneration", () => {
    let presentation = dispatchPresentation(initialPresentationState(), {
      type: "present",
      command: { presentationId: "p1", viewId: "v1" },
      revision: "rev1",
    });
    const initialLayoutGen = presentation!.layoutGeneration;

    presentation = dispatchPresentation(presentation, {
      type: "present",
      command: { presentationId: "p1", viewId: "v1", focus: { nodeIds: ["n1"] } },
      revision: "rev1",
    });

    expect(presentation!.layoutGeneration).toBe(initialLayoutGen);
    expect(presentation!.generation).toBe(2);
    expect(presentation!.focus.nodeIds).toEqual(["n1"]);
  });

  it("selection context is published to bridge on meaningful select", () => {
    const bridge = createStandaloneBridge({ onPresent: () => {}, onClear: () => {} });

    let selection = dispatchSelection(null, {
      type: "page_turn",
      viewId: "v1",
      revision: "rev1",
      presentationId: "p1",
    });

    selection = dispatchSelection(selection, {
      type: "select",
      nodeIds: ["web"],
      edgeIds: ["calls"],
    });

    const nodeDetails = new Map([
      ["web", { label: "Web" }],
      ["api", { label: "API" }],
    ] as const);
    const edgeDetails = new Map([["calls", { source: "web", target: "api", label: "calls" }]] as const);

    const context = buildSelectionContext(selection!, nodeDetails, edgeDetails);
    bridge.setSelection(context);

    const published = bridge.getSelection() as {
      viewId: string;
      nodes: unknown[];
      edges: unknown[];
    };
    expect(published.viewId).toBe("v1");
    expect(published.nodes).toHaveLength(1);
    expect(published.edges).toHaveLength(1);
  });

  // The former "bridge delivers present message and drives full wiring cycle"
  // test lived here. It hand-built the `present` action that App.handlePresent
  // derives, so `projectEnvelope`, `isPresentationCommand` and the page-turn
  // decision never ran. `app.render.test.tsx` mounts App and posts real host
  // messages, which drives all of them, so this one was deleted rather than
  // rewritten.

  it("presenting a different view advances layoutGeneration", () => {
    let presentation = dispatchPresentation(initialPresentationState(), {
      type: "present",
      command: { presentationId: "p1", viewId: "v1" },
      revision: "rev1",
    });
    const gen1 = presentation!.layoutGeneration;

    presentation = dispatchPresentation(presentation, {
      type: "present",
      command: { presentationId: "p2", viewId: "v2" },
      revision: "rev2",
    });

    // App keys its layout cache on this counter, so a bump is what invalidates
    // a cached layout. The cache lookup itself is App's, and is covered by
    // `app.render.test.tsx`; asserting it here would only restate App's own
    // comparison inside the test.
    expect(presentation!.layoutGeneration).toBeGreaterThan(gen1);
    expect(presentation!.layoutGeneration).toBe(2);
  });

  it("reset clears both presentation and selection state", () => {
    let presentation = dispatchPresentation(initialPresentationState(), {
      type: "present",
      command: { presentationId: "p1", viewId: "v1" },
      revision: "rev1",
    });
    let selection = dispatchSelection(null, {
      type: "page_turn",
      viewId: "v1",
      revision: "rev1",
      presentationId: "p1",
    });
    selection = dispatchSelection(selection, {
      type: "select",
      nodeIds: ["n1"],
      edgeIds: [],
    });

    presentation = dispatchPresentation(presentation, { type: "reset" });
    selection = dispatchSelection(selection, { type: "clear" });

    expect(presentation).toBeNull();
    expect(selection!.selectedNodeIds).toEqual([]);
  });
});
