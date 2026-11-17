/**
 * Marks the elements the agent just added or changed, on whichever canvas is
 * drawing them (phase3-front-door.md, "Change pulse").
 *
 * A stylesheet, not a prop threaded through three canvases: every drawn
 * element already carries its model id for hit-testing -- a graph node or
 * edge `data-id` (a group `group:<id>`), a sequence participant or message
 * `data-seq-id`, a journey task `data-journey-id` -- so the rule finds them
 * where they are, survives every re-render, and costs the canvases nothing.
 *
 * ONCE. The animation runs a single time; "Show changes" starts it again by
 * swapping between two identical keyframe names (`round`), which is what makes
 * a browser restart an animation on an element it already ran on.
 *
 * REDUCED MOTION: a static outline in the agent's colour, held while the
 * change notice is up, instead of anything that moves.
 *
 * Ids are written into attribute selectors as quoted strings, escaped, so an
 * id cannot close the string or the rule.
 */
import type { JSX } from "react";

/** A CSS string literal's contents: backslash, quote and line breaks escaped. */
export function cssString(value: string): string {
  return value.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\a ").replace(/\r/g, "\\d ").replace(/\f/g, "\\c ");
}

/** Every element drawn for one of `ids`, on any canvas, scoped to the stage. */
export function pulseSelector(ids: readonly string[]): string {
  return ids
    .flatMap((id) => {
      const s = cssString(id);
      return [
        `.archer-stage .react-flow__node[data-id="${s}"]`,
        `.archer-stage .react-flow__node[data-id="group:${s}"]`,
        `.archer-stage .react-flow__edge[data-id="${s}"]`,
        `.archer-stage [data-seq-id="${s}"]`,
        `.archer-stage [data-journey-id="${s}"]`,
      ];
    })
    .join(",\n");
}

export function pulseRule(ids: readonly string[], round: number, reducedMotion: boolean): string {
  if (ids.length === 0) return "";
  const declarations = reducedMotion
    ? "filter: drop-shadow(0 0 1px var(--agent)) drop-shadow(0 0 1px var(--agent)) drop-shadow(0 0 1px var(--agent));"
    : `animation: archer-change-pulse-${round % 2} 1.8s cubic-bezier(0.16, 1, 0.3, 1) 1;`;
  return `${pulseSelector(ids)} {\n  ${declarations}\n}`;
}

export function ChangePulse(props: {
  readonly ids: readonly string[];
  readonly round: number;
  readonly reducedMotion: boolean;
}): JSX.Element | null {
  const rule = pulseRule(props.ids, props.round, props.reducedMotion);
  if (rule === "") return null;
  return <style data-archer-change-pulse={props.reducedMotion ? "static" : "once"}>{rule}</style>;
}
