/* @jsxRuntime automatic */
/* @jsxImportSource react */
/**
 * The marks drawn at an edge's ends when an arrowhead is not what they mean:
 * an entity relationship's cardinality, in crow's-foot notation.
 *
 * Each end is drawn in a frame of its own: the origin is where the wire meets
 * the entity, and +x points INTO the entity, so a mark is written once and
 * turned to whichever way the wire arrives. Read outward from the entity, as
 * crow's-foot notation is read:
 *
 *   exactly one    two bars                 ──┼┼
 *   zero or one    a bar, then a ring       ──○┼
 *   one or more    a bar, then the foot     ──┼<
 *   zero or more   a ring, then the foot    ──○<
 *
 * The ring is filled with the canvas, so the wire behind it does not show
 * through: an open ring is what says "zero".
 */
import type { JSX } from "react";
import type { Cardinality, EdgeFigure } from "./figures";

type Pt = { readonly x: number; readonly y: number };

/** How far along the wire, back from the entity, each part of a mark stands. */
const NEAR_BAR = 9;
const FAR_BAR = 15;
const RING = 19;
const RING_R = 4;
const FOOT = 14;
const SPREAD = 7;

function Mark(props: { cardinality: Cardinality }): JSX.Element {
  const bar = (at: number) => <line x1={-at} y1={-SPREAD} x2={-at} y2={SPREAD} />;
  const ring = <circle cx={-RING} cy={0} r={RING_R} className="archer-er-ring" />;
  const foot = <path d={`M ${-FOOT} 0 L 0 ${-SPREAD} M ${-FOOT} 0 L 0 0 M ${-FOOT} 0 L 0 ${SPREAD}`} />;
  switch (props.cardinality) {
    case "exactly-one":
      return (
        <>
          {bar(NEAR_BAR)}
          {bar(FAR_BAR)}
        </>
      );
    case "zero-or-one":
      return (
        <>
          {bar(NEAR_BAR)}
          {ring}
        </>
      );
    case "one-or-more":
      return (
        <>
          {foot}
          {bar(FAR_BAR + 2)}
        </>
      );
    case "zero-or-more":
      return (
        <>
          {foot}
          {ring}
        </>
      );
  }
}

/** The end of `route` at `at`, and the way the wire is travelling into it. */
function endOf(route: readonly Pt[], at: "source" | "target"): { point: Pt; angle: number } {
  const [end, before] = at === "target" ? [route[route.length - 1], route[route.length - 2]] : [route[0], route[1]];
  return { point: end, angle: (Math.atan2(end.y - before.y, end.x - before.x) * 180) / Math.PI };
}

export function EdgeEnds(props: { figure: EdgeFigure; route: readonly Pt[] }): JSX.Element | null {
  if (props.figure.type !== "cardinality" || props.route.length < 2) return null;
  const ends = [
    { at: "source" as const, cardinality: props.figure.source },
    { at: "target" as const, cardinality: props.figure.target },
  ];
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a decorative SVG part with no tabindex, never focusable; biome misreads SVG elements as focusable.
    <g className="archer-er-ends" aria-hidden="true">
      {ends.map(({ at, cardinality }) => {
        const { point, angle } = endOf(props.route, at);
        return (
          <g
            key={at}
            className={`archer-er-mark archer-er-${cardinality}`}
            data-end={at}
            data-cardinality={cardinality}
            transform={`translate(${point.x} ${point.y}) rotate(${angle})`}
          >
            <Mark cardinality={cardinality} />
          </g>
        );
      })}
    </g>
  );
}
