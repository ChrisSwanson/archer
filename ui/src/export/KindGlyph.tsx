/* @jsxRuntime automatic */
/* @jsxImportSource react */
import type { JSX } from "react";
import type { NodeKind } from "../layout/graph-metrics";
/**
 * One small pictogram per semantic class.
 *
 * Drawn in `currentColor`, so it takes the node's own text colour in every
 * theme and every state and never needs a colour of its own. It is the second
 * channel beside the caption's words: the class reads without hue.
 */
export function KindGlyph(props: { kind: NodeKind; size?: number }): JSX.Element {
  const size = props.size ?? 11;
  return (
    <svg
      viewBox="0 0 12 12"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {GLYPHS[props.kind]}
    </svg>
  );
}
const GLYPHS: Record<NodeKind, JSX.Element> = {
  // Head and shoulders.
  person: (
    <>
      <circle cx="6" cy="3.4" r="2" />
      <path d="M2 11c0-2.6 1.8-4.2 4-4.2s4 1.6 4 4.2" />
    </>
  ),
  // A box with its own inside: the thing the diagram is about.
  system: (
    <>
      <rect x="1.5" y="1.5" width="9" height="9" rx="1" />
      <rect x="4" y="4" width="4" height="4" />
    </>
  ),
  // A window with a title bar: something that runs.
  container: (
    <>
      <rect x="1.5" y="2" width="9" height="8" rx="1" />
      <path d="M1.5 4.8h9" />
    </>
  ),
  // The UML component: a box with two lugs.
  component: (
    <>
      <rect x="3.5" y="1.5" width="7" height="9" rx="0.8" />
      <rect x="1.5" y="3.4" width="4" height="1.8" />
      <rect x="1.5" y="6.8" width="4" height="1.8" />
    </>
  ),
  // A cylinder.
  database: (
    <>
      <ellipse cx="6" cy="3" rx="4" ry="1.6" />
      <path d="M2 3v6c0 .9 1.8 1.6 4 1.6s4-.7 4-1.6V3" />
    </>
  ),
  // An arrow leaving a box: outside the boundary.
  external: (
    <>
      <path d="M5 2.2H2v7.6h7.6v-3" />
      <path d="M7.2 2h2.8v2.8" />
      <path d="M10 2 5.6 6.4" />
    </>
  ),
};
