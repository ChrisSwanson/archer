import { describe, expect, it } from "vitest";
import {
  initialPresentationState,
  presentationReducer,
  type PresentationAction,
  type PresentationState,
} from "../src/presentation/controller";

describe("presentationReducer", () => {
  it("page turn increments layoutGeneration", () => {
    const state0 = initialPresentationState();
    const state1 = presentationReducer(state0, {
      type: "present",
      command: { presentationId: "p1", viewId: "view-a" },
      revision: "rev-1",
    });
    expect(state1).not.toBeNull();
    const layoutGen1 = (state1 as PresentationState).layoutGeneration;

    const state2 = presentationReducer(state1, {
      type: "present",
      command: { presentationId: "p1", viewId: "view-b" },
      revision: "rev-2",
    });
    expect(state2).not.toBeNull();
    expect((state2 as PresentationState).layoutGeneration).toBeGreaterThan(layoutGen1);
  });

  it("same-view focus does not increment layoutGeneration", () => {
    const state1 = presentationReducer(initialPresentationState(), {
      type: "present",
      command: { presentationId: "p1", viewId: "view-a", focus: { nodeIds: ["x"] } },
      revision: "rev-1",
    }) as PresentationState;

    const state2 = presentationReducer(state1, {
      type: "present",
      command: { presentationId: "p1", viewId: "view-a", focus: { nodeIds: ["y"] } },
      revision: "rev-1",
    }) as PresentationState;

    expect(state2.layoutGeneration).toBe(state1.layoutGeneration);
    expect(state2.generation).toBeGreaterThan(state1.generation);
  });

  // A live-reload push re-presents the same view under a new revision. App.tsx
  // keys its layout cache on layoutGeneration, so leaving it flat here makes
  // the canvas redraw the pre-edit layout and the saved edit never appears.
  it("same view at a new revision increments layoutGeneration", () => {
    const state1 = presentationReducer(initialPresentationState(), {
      type: "present",
      command: { presentationId: "p1", viewId: "view-a" },
      revision: "rev-1",
    }) as PresentationState;

    const state2 = presentationReducer(state1, {
      type: "present",
      command: { presentationId: "p1", viewId: "view-a" },
      revision: "rev-2",
    }) as PresentationState;

    expect(state2.revision).toBe("rev-2");
    expect(state2.layoutGeneration).toBeGreaterThan(state1.layoutGeneration);
  });

  // The former "a revision change keeps the same-view viewport default" test
  // lived here. It asserted `state.viewport === "fit-focus"` at a time when
  // nothing read `viewport` at all, so it would have passed no matter how the
  // canvas behaved. What it claimed to protect -- the user keeping their frame
  // across a live-reload redraw -- is asserted on the rendered canvas
  // transform in `app.render.test.tsx`. The default is restated below only
  // because a renderer now consumes it.
  it("a re-present of the same view with no focus asks to preserve the frame", () => {
    const state1 = presentationReducer(initialPresentationState(), {
      type: "present",
      command: { presentationId: "p1", viewId: "view-a" },
      revision: "rev-1",
    }) as PresentationState;

    const state2 = presentationReducer(state1, {
      type: "present",
      command: { presentationId: "p1", viewId: "view-a" },
      revision: "rev-2",
    }) as PresentationState;

    expect(state2.viewport).toBe("preserve");
  });

  it("page turn with reset returns null", () => {
    const state1 = presentationReducer(initialPresentationState(), {
      type: "present",
      command: { presentationId: "p1", viewId: "view-a" },
      revision: "rev-1",
    });
    const state2 = presentationReducer(state1, { type: "reset" });
    expect(state2).toBeNull();
  });

  it("stale layout_complete is ignored", () => {
    let state = presentationReducer(initialPresentationState(), {
      type: "present",
      command: { presentationId: "p1", viewId: "view-a" },
      revision: "rev-1",
    }) as PresentationState;

    // Advance generation a few times to simulate gen reaching 5.
    for (let i = 0; i < 10; i++) {
      state = presentationReducer(state, {
        type: "present",
        command: { presentationId: "p1", viewId: "view-a", focus: { nodeIds: [String(i)] } },
        revision: "rev-1",
      }) as PresentationState;
    }

    const beforeGen = state.generation;
    const stale: PresentationAction = { type: "layout_complete", generation: beforeGen - 2 };
    const after = presentationReducer(state, stale);
    expect(after).toBe(state);
    expect((after as PresentationState).generation).toBe(beforeGen);
  });

  it("default viewport is fit-all for page turn", () => {
    const state = presentationReducer(initialPresentationState(), {
      type: "present",
      command: { presentationId: "p1", viewId: "view-a" },
      revision: "rev-1",
    }) as PresentationState;
    expect(state.viewport).toBe("fit-all");
  });

  it("default viewport is fit-focus for same-view focus", () => {
    const state1 = presentationReducer(initialPresentationState(), {
      type: "present",
      command: { presentationId: "p1", viewId: "view-a" },
      revision: "rev-1",
    }) as PresentationState;

    const state2 = presentationReducer(state1, {
      type: "present",
      command: { presentationId: "p1", viewId: "view-a", focus: { nodeIds: ["x"] } },
      revision: "rev-1",
    }) as PresentationState;

    expect(state2.viewport).toBe("fit-focus");
  });
});
