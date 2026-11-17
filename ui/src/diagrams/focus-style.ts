/**
 * Shared visual treatment for presentation focus.
 *
 * Both canvases must express focus the same way: when the host sets a focus
 * set, everything outside it steps back. Keeping the constants here stops the
 * graph and sequence canvases from drifting into two visual languages.
 *
 * WHAT STEPS BACK IS THE SHAPES, NEVER THE WORDS (round 1, C-07). Fading a whole
 * element by opacity took its text to 2:1 (WCAG 1.4.3 asks 4.5:1), and the
 * walkthrough e2e hid that from axe with `exclude()`. An off-focus element is
 * still context the reader reads, so:
 *   - its fill and outline fade (`--node-bg-faded`, `--node-border-faded`, the
 *     group tokens), and a line keeps `DIMMED_OPACITY` on its stroke;
 *   - its words take `--text-faded`: a solid, quieter grey that keeps 4.5:1 on
 *     the faded box, on a caption's faded plate and inside a group, in both
 *     themes (pinned by `tests/round1-f2.test.tsx`).
 * `DIMMED_OPACITY` is still written on a graph node's wrapper and on a sequence
 * element's `<g>`, as the state other code and tests read. The stylesheet
 * (`styles.css`, "Off focus") lifts that opacity back to 1 for the element and
 * fades only its shapes: on the graph by `DIMMED_CLASS`; on the sequence canvas
 * by the `opacity="0.25"` attribute, so the two must stay equal.
 *
 * Structural containers are deliberately excluded from the dimming treatment:
 * sequence fragments (`SequenceCanvas.FragmentRect`) and graph group nodes
 * (`xflow-adapter.toXFlowNodes`, `type: "group"`) always render at
 * `FOCUSED_OPACITY`. A focus set carries only participant/message IDs or
 * node/edge IDs -- container IDs can never appear in one -- so a container has
 * no focus state to render. It is chrome that frames whatever is focused
 * inside it, and dimming it would only reduce the contrast the focused content
 * needs. Their *contents* dim normally; the frame does not.
 *
 * Pinned by `tests/sequence-canvas.render.test.tsx` ("leaves fragment
 * containers at full opacity...") and `tests/xflow-adapter.test.ts`
 * ("group container nodes are never dimmed").
 */
export const FOCUSED_OPACITY = 1;
export const DIMMED_OPACITY = 0.25;

/** The class a graph element outside the focus wears; the stylesheet fades its shapes by it. */
export const DIMMED_CLASS = "archer-dimmed";

/** A dimmed line's caption: its words step back to the faded ink, which keeps 4.5:1 on its ground. Spread last. */
export const DIMMED_CAPTION = {
  opacity: FOCUSED_OPACITY,
  color: "var(--text-faded)",
} as const;

export function focusOpacity(dimmed: boolean): number {
  return dimmed ? DIMMED_OPACITY : FOCUSED_OPACITY;
}

/** `classes`, plus `DIMMED_CLASS` when the element is outside the focus. */
export function dimmedClass(classes: string, dimmed: boolean): string {
  return dimmed ? `${classes} ${DIMMED_CLASS}` : classes;
}
