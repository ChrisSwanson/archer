/* @jsxRuntime automatic */
/* @jsxImportSource react */
/**
 * The pictograms the newer diagram types draw: Mermaid's five built-in
 * architecture icons and the C4 person.
 *
 * Line drawings in `currentColor`, so each takes its element's own ink in
 * every theme, design and state and needs no colour of its own. Each is a
 * second channel beside words: an icon is always named in the element's
 * accessible name, never only drawn.
 */
import type { JSX } from "react";
import type { ArchitectureIcon } from "./figures";

const ICONS: Readonly<Record<ArchitectureIcon, JSX.Element>> = {
  cloud: <path d="M7 18h10.5a3.5 3.5 0 0 0 .4-7A5.5 5.5 0 0 0 7.3 9.6 4.2 4.2 0 0 0 7 18z" />,
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.6" />
      <path d="M5 6v12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V6" />
      <path d="M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" />
    </>
  ),
  disk: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.8" />
    </>
  ),
  internet: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4c2.4 2.2 3.6 4.9 3.6 8s-1.2 5.8-3.6 8c-2.4-2.2-3.6-4.9-3.6-8S9.6 6.2 12 4z" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="4" width="16" height="7" rx="1.5" />
      <rect x="4" y="13" width="16" height="7" rx="1.5" />
      <path d="M7.5 7.5h.01M7.5 16.5h.01M11 7.5h5M11 16.5h5" />
    </>
  ),
};

/** One of Mermaid's built-in architecture icons, 24 units square. */
export function ArchitectureGlyph(props: { icon: ArchitectureIcon; size?: number }): JSX.Element {
  const size = props.size ?? 16;
  return (
    <svg
      className={`archer-arch-icon archer-arch-icon-${props.icon}`}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[props.icon]}
    </svg>
  );
}

/** The C4 person: a head over shoulders. */
export function PersonGlyph(props: { size: number }): JSX.Element {
  return (
    <svg
      className="archer-c4-person-glyph"
      viewBox="0 0 24 24"
      width={props.size}
      height={props.size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="7.5" r="4" />
      <path d="M4 21c0-4.6 3.6-7.6 8-7.6s8 3 8 7.6" />
    </svg>
  );
}
