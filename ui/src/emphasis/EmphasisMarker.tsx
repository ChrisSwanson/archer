/**
 * The group number, drawn: the one non-colour cue emphasis has (ADR 0030,
 * "Group numbers"), off unless the reader asks for it.
 *
 * A small disc in the canvas colour, ringed in the group's hue, holding the
 * group's number in body ink. The number carries the group in greyscale, in
 * print and in forced colours; the ring keeps it tied to its hue for everyone
 * else. Its contrast is the text's own on the canvas, never a hue's.
 *
 * The same shape everywhere: the canvases draw it at an element's top-left
 * corner and on a line's middle (clear of its caption); export draws it from
 * `emphasisMarkerSvg` at the same points; the legend's rows and member list
 * show it beside each group's label.
 */
import type { JSX } from "react";

/** The disc's radius, in drawing units. Legible at phone zoom; smaller than a comment pin. */
export const MARKER_RADIUS = 7;
/** At the type floor (`--type-floor`, round 1 V6): the smallest text the page sets. */
export const MARKER_FONT_PX = 11;
export const MARKER_STROKE = 1.5;

export const EMPHASIS_MARKER_CLASS = "archer-emph-marker";

/** One marker centred on (x, y), for an SVG canvas. Hidden from assistive technology: the name says it. */
export function EmphasisMarker(props: { readonly slot: number; readonly x: number; readonly y: number }): JSX.Element {
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: a decorative SVG part with no tabindex, never focusable; biome misreads SVG elements as focusable.
    <g
      className={EMPHASIS_MARKER_CLASS}
      transform={`translate(${props.x} ${props.y})`}
      aria-hidden="true"
      data-slot={props.slot}
    >
      <circle r={MARKER_RADIUS} />
      <text textAnchor="middle" dominantBaseline="central" fontSize={MARKER_FONT_PX}>
        {props.slot}
      </text>
    </g>
  );
}

/**
 * The same marker as SVG text, for export: colours named as theme tokens
 * (`var(--…)`), which export resolves to literals.
 */
export function emphasisMarkerSvg(slot: number, x: number, y: number, hue: string): string {
  const n = Math.max(1, Math.min(9, Math.trunc(slot)));
  return (
    `<g class="export-emph-marker" transform="translate(${x} ${y})" data-slot="${n}">` +
    `<circle r="${MARKER_RADIUS}" fill="var(--bg)" stroke="${hue}" stroke-width="${MARKER_STROKE}"/>` +
    `<text text-anchor="middle" y="${MARKER_FONT_PX * 0.36}" font-size="${MARKER_FONT_PX}" font-weight="700" fill="var(--text)" stroke="none">${n}</text>` +
    `</g>`
  );
}
