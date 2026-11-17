/* @jsxRuntime automatic */
/* @jsxImportSource react */
import type { ArchitectureIcon } from "../diagrams/figures";
import { ICONS } from "../diagrams/key-entries";
export { ICONS };
import type { JSX } from "react";
import { ArchitectureGlyph, PersonGlyph } from "../diagrams/FigureGlyphs";
/**
 * Small notation samples remain visible even when explanations are folded away. `size` draws it in a square of
 * that many pixels (the drawing's legend); without one the stylesheet sizes it.
 */
export function KeySymbol({ label, size }: { readonly label: string; readonly size?: number }): JSX.Element {
  const lower = label.toLowerCase();
  const architectureIcon = Object.entries(ICONS).find(([, title]) => label === `${title} icon`)?.[0] as
    | ArchitectureIcon
    | undefined;
  if (architectureIcon !== undefined) return <ArchitectureGlyph icon={architectureIcon} size={size ?? 24} />;
  if ((lower === "person" || lower === "actor") && !/ line: /.test(lower)) return <PersonGlyph size={size ?? 24} />;
  let mark: JSX.Element;
  // A line pattern's row is named "<Pattern> line: <the author's meaning>", and
  // the meaning is free text: match the pattern first, never the words after it.
  if (lower.startsWith("dashed line")) mark = <path d="M2 12h28" strokeDasharray="6 4" />;
  else if (lower.startsWith("dash-dot line")) mark = <path d="M2 12h28" strokeDasharray="8 3 2 3" />;
  else if (lower.startsWith("dotted line")) mark = <path d="M2 12h28" strokeDasharray="2 3" />;
  else if (lower.startsWith("thick line:")) mark = <path d="M2 12h28" strokeWidth="3" />;
  else if (lower.includes("database"))
    mark = (
      <>
        <path d="M4 6v12c0 4 24 4 24 0V6" />
        <ellipse cx="16" cy="6" rx="12" ry="4" />
      </>
    );
  else if (lower === "queue")
    mark = (
      <>
        <path d="M8 3h17c7 0 7 18 0 18H8c-7 0-7-18 0-18Z" />
        <ellipse cx="25" cy="12" rx="4" ry="9" />
      </>
    );
  else if (lower.includes("person") || lower === "actor")
    mark = (
      <>
        <circle cx="16" cy="5" r="3" />
        <path d="M9 20v-5a7 7 0 0 1 14 0v5Z" />
      </>
    );
  else if (lower === "call")
    mark = (
      <>
        <path d="M2 12h20" />
        <path d="m22 7 7 5-7 5Z" fill="currentColor" />
      </>
    );
  else if (lower === "reply" || lower === "async message")
    mark = (
      <>
        <path d="M2 12h27" strokeDasharray={lower === "reply" ? "3 2" : undefined} />
        <path d="m22 7 7 5-7 5" />
      </>
    );
  else if (lower === "external") mark = <rect x="3" y="4" width="26" height="16" rx="2" strokeDasharray="3 2" />;
  else if (lower.includes("boundary")) mark = <rect x="2" y="3" width="28" height="18" rx="2" strokeDasharray="3 2" />;
  else if (lower.includes("group") || lower.includes("section") || lower.includes("composite"))
    mark = <rect x="2" y="3" width="28" height="18" rx="4" />;
  else if (lower === "thick line" || lower.startsWith("thick line:")) mark = <path d="M2 12h28" strokeWidth="3" />;
  else if (lower === "cloud icon") mark = <path d="M7 19a6 6 0 0 1-1-12 8 8 0 0 1 15-2 7 7 0 0 1 4 14Z" />;
  else if (lower === "internet icon")
    mark = (
      <>
        <circle cx="16" cy="12" r="10" />
        <ellipse cx="16" cy="12" rx="4" ry="10" />
        <path d="M6 12h20M8 6h16M8 18h16" />
      </>
    );
  else if (lower === "disk icon")
    mark = (
      <>
        <rect x="3" y="6" width="26" height="15" rx="2" />
        <path d="m3 6 5-4h16l5 4M7 16h13" />
        <circle cx="25" cy="16" r="1" />
      </>
    );
  else if (lower === "server icon")
    mark = (
      <>
        <rect x="8" y="2" width="16" height="20" rx="2" />
        <path d="M11 7h10M11 12h10M11 17h10" />
      </>
    );
  else if (["exactly one", "zero or one", "one or more", "zero or more"].includes(lower))
    mark = (
      <>
        <path d="M2 12h26" />
        {lower.includes("zero") ? <circle cx="14" cy="12" r="3" /> : <path d="M14 7v10" />}
        {lower.includes("more") ? <path d="m20 12 9-6m-9 6 9 6" /> : <path d="M23 7v10" />}
      </>
    );
  else if (lower === "lifelines")
    mark = (
      <>
        <rect x="7" y="1" width="18" height="7" />
        <path d="M16 8v16" strokeDasharray="3 2" />
      </>
    );
  else if (lower.includes("identifying") || lower.includes("dotted") || lower.includes("undirected"))
    mark = (
      <path d="M2 12h28" strokeDasharray={lower.includes("non-") || lower.includes("dotted") ? "3 2" : undefined} />
    );
  else if (lower === "fork" || lower === "join") mark = <path d="M6 12h20" strokeWidth="5" />;
  else if (lower === "activation") mark = <rect x="13" y="2" width="6" height="20" />;
  else if (lower === "score rail")
    mark = (
      <>
        <path d="M8 3v18" strokeDasharray="3 2" />
        <path d="M16 3v18" strokeWidth="1" />
        <path d="M24 3v18" strokeWidth="3" />
      </>
    );
  else if (lower === "satisfaction score")
    mark = (
      <>
        {[4, 10, 16, 22, 28].map((x, index) => (
          <circle key={x} cx={x} cy="12" r="2" fill={index < 4 ? "currentColor" : "none"} />
        ))}
      </>
    );
  else if (["pk", "fk", "uk"].includes(lower))
    mark = (
      <text x="16" y="16" textAnchor="middle" stroke="none" fill="currentColor" fontSize="12">
        {label}
      </text>
    );
  else if (lower === "actors") mark = <rect x="2" y="6" width="28" height="12" rx="6" />;
  else if (lower === "message numbers")
    mark = (
      <text x="16" y="16" textAnchor="middle" stroke="none" fill="currentColor" fontSize="12">
        1, 2
      </text>
    );
  else if (lower === "start" || lower === "junction") mark = <circle cx="16" cy="12" r="5" fill="currentColor" />;
  else if (lower === "end")
    mark = (
      <>
        <circle cx="16" cy="12" r="9" />
        <circle cx="16" cy="12" r="5" fill="currentColor" />
      </>
    );
  else if (lower === "choice") mark = <path d="m16 2 13 10-13 10L3 12Z" />;
  else if (lower === "state note")
    mark = (
      <>
        <rect x="10" y="3" width="20" height="18" />
        <path d="M1 12h9" strokeDasharray="2 2" />
      </>
    );
  else if (lower === "note") mark = <path d="M5 2h16l6 6v14H5ZM21 2v6h6" />;
  else mark = <rect x="3" y="4" width="26" height="16" rx="2" />;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 32 24"
      {...(size === undefined ? {} : { width: size, height: size })}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      {mark}
    </svg>
  );
}
