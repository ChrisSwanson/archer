/**
 * The canvas cluster's own glyphs, shared by the graph and sequence canvases (and so by the web page and
 * the embedded view): one drawing of zoom in, zoom out, fit and help wherever the cluster stands.
 *
 * Drawn on the icon scale's padded 24-unit box (`--icon` in styles.css): strokes inside 4.5–19.5, so at
 * the scale's 20px they draw the same 12.5px glyph as every other control icon. Outlines, never fills:
 * React Flow's own zoom glyphs were filled shapes that filled their box and read heavier than the rest.
 */
import type { JSX, ReactNode } from "react";

function Glyph({ children, stroke = 1.5 }: { children: ReactNode; stroke?: number }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const ZoomInGlyph = (): JSX.Element => (
  <Glyph>
    <path d="M12 4.5v15M4.5 12h15" />
  </Glyph>
);
/** Close, dismiss or clear: one cross wherever a control takes something away (round 1, V3). Sized by its control's rule. */
export const CloseGlyph = (): JSX.Element => (
  <Glyph>
    <path d="M6 6l12 12M18 6 6 18" />
  </Glyph>
);
export const ZoomOutGlyph = (): JSX.Element => (
  <Glyph>
    <path d="M4.5 12h15" />
  </Glyph>
);
export const FitGlyph = (): JSX.Element => (
  <Glyph>
    <path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" />
  </Glyph>
);
export const HelpGlyph = (): JSX.Element => (
  // A question mark is narrow: drawn a quarter larger, so it stands as tall as its neighbours.
  <Glyph>
    <g transform="translate(12 12) scale(1.25) translate(-12 -12)">
      <path d="M9 8.85a3.15 3.15 0 1 1 4.35 2.85c-.9.45-1.35 1.2-1.35 2.1v.6" />
      <circle cx="12" cy="18.15" r="0.9" fill="currentColor" stroke="none" />
    </g>
  </Glyph>
);

/**
 * The diagram key's pair (round 1, O5): out of the panel, and back into it. Pop out is a box with an arrow
 * leaving it up and to the right; dock is the window with its side panel, an arrow going into the panel. They
 * share the frame, so one reads as the other's reverse; a downward arrow over a tray read as "download".
 */
export const PopOutGlyph = (): JSX.Element => (
  <Glyph>
    <path d="M13.5 4.5h6v6M19.5 4.5l-8 8M17.25 13.5v6H4.5V6.75h6.75" />
  </Glyph>
);
export const DockSideGlyph = (): JSX.Element => (
  <Glyph>
    <rect x="4.5" y="5.25" width="15" height="13.5" rx="1.5" />
    <path d="M14.25 5.25v13.5M6.75 12h4.5M9.25 9.75 11.5 12l-2.25 2.25" />
  </Glyph>
);
