/* @jsxRuntime automatic */
/* @jsxImportSource react */
import type { JSX } from "react";
import { ACTOR_GLYPH_WIDTH } from "../layout/sequence-layout";
const ARROW_SIZE = 8;
/** Text that is one line most of the time, and stacked `tspan`s when wrapped. */
export function Lines(props: {
  lines: readonly string[];
  x: number;
  /** The baseline of the LAST line. */
  lastBaseline: number;
  lineHeight: number;
}): JSX.Element {
  const { lines, x, lastBaseline, lineHeight } = props;
  if (lines.length === 1) {
    return <>{lines[0]}</>;
  }
  return (
    <>
      {lines.map((line, i) => (
        <tspan
          // biome-ignore lint/suspicious/noArrayIndexKey: the wrapped lines of one label, re-derived together; a line has no identity or state beyond its position.
          key={i}
          x={x}
          y={lastBaseline - (lines.length - 1 - i) * lineHeight}
        >
          {line}
        </tspan>
      ))}
    </>
  );
}
/**
 * The figure that makes an actor read as a person: a head and shoulders.
 *
 * A SHAPE, so it survives greyscale and does not depend on the box being a
 * different colour; drawn inline in one 1.5px stroke -- the weight of the box
 * it sits in -- rather than as an emoji or a symbol character, which would be
 * a different glyph (and often a different colour) on every platform. It is
 * decoration inside the participant's own group: the box, the hit area, the
 * ring and the selection are the participant's, unchanged.
 */
export function ActorGlyph(props: { x: number; y: number }): JSX.Element {
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a decorative SVG part with no tabindex, never focusable; biome misreads SVG elements as focusable.
    <g className="archer-seq-actor-glyph" aria-hidden="true" transform={`translate(${props.x} ${props.y})`}>
      <circle cx={ACTOR_GLYPH_WIDTH / 2} cy={4.25} r={3.5} strokeWidth={1.5} />
      <path d="M 1 16.25 V 15 A 6 6 0 0 1 13 15 V 16.25" strokeWidth={1.5} />
    </g>
  );
}
export function Arrowhead(props: { tipX: number; y: number; direction: 1 | -1; open: boolean }): JSX.Element {
  const { tipX, y, direction, open } = props;
  const baseX = tipX - direction * ARROW_SIZE;
  const half = ARROW_SIZE / 2;
  return open ? (
    <polyline
      className="archer-seq-arrowhead"
      points={`${baseX},${y - half} ${tipX},${y} ${baseX},${y + half}`}
      fill="none"
      strokeWidth={1.5}
    />
  ) : (
    <polygon className="archer-seq-arrowhead" points={`${tipX},${y} ${baseX},${y - half} ${baseX},${y + half}`} />
  );
}
