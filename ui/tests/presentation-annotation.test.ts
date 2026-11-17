/**
 * The agent's annotation is carried into the presentation state.
 *
 * Replacing `annotation: command.annotation` with `annotation: undefined` in
 * the reducer passed every test in `presentation.test.ts` (adversarial review
 * 2026-10-02, "Tests that prove less than they appear to"): the field was
 * stored and nothing looked at it. Whatever draws the caption reads it from
 * this state, so the state has to hold it.
 *
 * This pins the storage only. That a reader SEES the caption is a claim about
 * the page, and is the browser suite's to make.
 */
import { describe, expect, it } from "vitest";
import { initialPresentationState, presentationReducer, type PresentationState } from "../src/presentation/controller";

const CAPTION = "Payment authorization happens before inventory reservation.";

function present(
  state: PresentationState | null,
  annotation: string | undefined,
  revision = "rev-1",
): PresentationState {
  return presentationReducer(state, {
    type: "present",
    command: { presentationId: "p1", viewId: "view-a", ...(annotation === undefined ? {} : { annotation }) },
    revision,
  }) as PresentationState;
}

describe("the presentation's annotation", () => {
  it("is the one the command carried", () => {
    expect(present(initialPresentationState(), CAPTION).annotation).toBe(CAPTION);
  });

  it("is replaced by the next command's, and withdrawn by a command without one", () => {
    const first = present(initialPresentationState(), CAPTION);
    const second = present(first, "Now look at the ledger.");
    expect(second.annotation).toBe("Now look at the ledger.");
    // Presenting again without a caption says there is no caption: the old
    // one described a presentation that is no longer the one on screen.
    expect(present(second, undefined).annotation).toBeUndefined();
  });

  it("survives a live-reload redraw of the same view, which repeats it", () => {
    const first = present(initialPresentationState(), CAPTION);
    const reloaded = present(first, CAPTION, "rev-2");
    expect(reloaded.annotation).toBe(CAPTION);
    expect(reloaded.layoutGeneration).toBeGreaterThan(first.layoutGeneration);
  });
});
