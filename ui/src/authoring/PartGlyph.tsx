import type { JSX } from "react";
import type { Family, Part } from "./families";

/** A small drawing of what a part adds: its shape, line or construct. Decorative only. */
export function PartGlyph({ family, part }: { family: Family; part: Part }): JSX.Element {
  return (
    <svg className="authoring-part-glyph" aria-hidden="true" viewBox="0 0 34 20">
      {glyph(family, part)}
    </svg>
  );
}

const arrowHead = (x: number, y: number) => (
  <path d={`M${x - 5} ${y - 4} ${x} ${y} ${x - 5} ${y + 4}`} className="authoring-glyph-line" />
);

function glyph(family: Family, part: Part): JSX.Element {
  if (part.kind === "node" && "shape" in part.create) {
    switch (part.create.shape) {
      case "diamond":
        return <path d="M17 1 32 10 17 19 2 10Z" className="authoring-glyph-fill" />;
      case "stadium":
        return <rect x="3" y="3" width="28" height="14" rx="7" className="authoring-glyph-fill" />;
      case "subroutine":
        return (
          <>
            <rect x="3" y="3" width="28" height="14" className="authoring-glyph-fill" />
            <path d="M7 3V17M27 3V17" className="authoring-glyph-line" />
          </>
        );
      case "cylinder":
        return (
          <>
            <path d="M5 5C5 2 29 2 29 5V15C29 18 5 18 5 15Z" className="authoring-glyph-fill" />
            <path d="M5 5C5 8 29 8 29 5" className="authoring-glyph-line" />
          </>
        );
      default:
        return <rect x="3" y="3" width="28" height="14" rx="2" className="authoring-glyph-fill" />;
    }
  }
  if (part.kind === "connection") {
    if ("relation" in part.create) {
      return part.create.relation === "birel" ? (
        <>
          <path d="M6 10H28" className="authoring-glyph-line" />
          {arrowHead(30, 10)}
          <path d="M9 6 4 10 9 14" className="authoring-glyph-line" />
        </>
      ) : (
        <>
          <path d="M3 10H28" className="authoring-glyph-line" />
          {arrowHead(30, 10)}
        </>
      );
    }
    if ("cardinality" in part.create) {
      const c = part.create.cardinality;
      return c === "one-to-one" ? (
        <path d="M3 10H31M7 6V14M27 6V14" className="authoring-glyph-line" />
      ) : c === "many-to-many" ? (
        <path d="M3 10H31M7 10 3 6M7 10 3 14M27 10 31 6M27 10 31 14" className="authoring-glyph-line" />
      ) : (
        <path d="M3 10H31M7 6V14M27 10 31 6M27 10 31 14" className="authoring-glyph-line" />
      );
    }
    if ("message" in part.create) {
      const m = part.create.message;
      return m === "reply" ? (
        <>
          <path d="M31 10H6" className="authoring-glyph-line dashed" />
          <path d="M9 6 4 10 9 14" className="authoring-glyph-line" />
        </>
      ) : m === "async" ? (
        <>
          <path d="M3 10H28" className="authoring-glyph-line" />
          <path d="M24 6 30 10" className="authoring-glyph-line" />
        </>
      ) : (
        <>
          <path d="M3 10H28" className="authoring-glyph-line" />
          {arrowHead(30, 10)}
        </>
      );
    }
    if ("transition" in part.create)
      return (
        <>
          <path d="M3 10H28" className="authoring-glyph-line" />
          {arrowHead(30, 10)}
        </>
      );
    const labelled = part.labelMode !== "none",
      y = labelled ? 13 : 10,
      line = part.create.line;
    return (
      <>
        <path
          d={`M3 ${y}H28`}
          className={`authoring-glyph-line${line === "dotted" ? " dashed" : line === "thick" ? " thick" : ""}`}
        />
        {arrowHead(30, y)}
        {labelled ? <rect x="9" y="2" width="14" height="7" rx="2" className="authoring-glyph-fill" /> : null}
      </>
    );
  }
  if (part.kind === "marker")
    return part.which === "start" ? (
      <circle cx="17" cy="10" r="5" className="authoring-glyph-solid" />
    ) : (
      <>
        <circle cx="17" cy="10" r="7" className="authoring-glyph-line" />
        <circle cx="17" cy="10" r="4" className="authoring-glyph-solid" />
      </>
    );
  if (part.kind === "note") return <path d="M8 2H23L27 6V18H8Z" className="authoring-glyph-fill" />;
  if (part.kind === "wrap") {
    // Each fragment drawn as what it does: a loop arrow, alternatives split by a dashed line, an optional (dashed) frame, parallel lanes.
    const frame = (
      <>
        <rect
          x="2"
          y="2"
          width="30"
          height="16"
          rx="2"
          className={`authoring-glyph-line${part.fragment === "opt" ? " dashed" : ""}`}
        />
        <rect x="2" y="2" width="10" height="5" className="authoring-glyph-fill" />
      </>
    );
    if (part.fragment === "loop")
      return (
        <>
          {frame}
          <path d="M24 9a5 4 0 1 1-4-1M24 6v3h-3" className="authoring-glyph-line" />
        </>
      );
    if (part.fragment === "alt")
      return (
        <>
          {frame}
          <path d="M2 12H32" className="authoring-glyph-line dashed" />
        </>
      );
    if (part.fragment === "par")
      return (
        <>
          {frame}
          <path d="M2 11H32M17 7V18" className="authoring-glyph-line dashed" />
        </>
      );
    return (
      <>
        {frame}
        <path d="M14 12H26" className="authoring-glyph-line" />
      </>
    );
  }
  if (part.kind === "group")
    return (
      <>
        <rect x="2" y="2" width="30" height="16" rx="3" className="authoring-glyph-line dashed" />
        <rect x="7" y="7" width="8" height="6" rx="1" className="authoring-glyph-fill" />
        <rect x="19" y="7" width="8" height="6" rx="1" className="authoring-glyph-fill" />
      </>
    );
  const key = part.key;
  if (family === "sequence") {
    if (key === "participant")
      return (
        <>
          <rect x="9" y="1" width="16" height="7" rx="1" className="authoring-glyph-fill" />
          <path d="M17 8V19" className="authoring-glyph-line dashed" />
        </>
      );
    if (key === "actor")
      return (
        <>
          <circle cx="17" cy="4" r="3" className="authoring-glyph-fill" />
          <path d="M17 7V13M11 9H23M17 13 12 19M17 13 22 19" className="authoring-glyph-line" />
        </>
      );
    if (key === "message" || key === "async")
      return (
        <>
          <path d="M3 10H28" className="authoring-glyph-line" />
          {arrowHead(30, 10)}
        </>
      );
    if (key === "reply")
      return (
        <>
          <path d="M31 10H6" className="authoring-glyph-line dashed" />
          <path d="M9 6 4 10 9 14" className="authoring-glyph-line" />
        </>
      );
    if (key === "note") return <path d="M8 2H23L27 6V18H8Z" className="authoring-glyph-fill" />;
    if (key === "loop") return <path d="M26 6A10 6 0 1 0 28 12M26 2V7H21" className="authoring-glyph-line" />;
    return (
      <>
        <rect x="3" y="2" width="28" height="16" rx="2" className="authoring-glyph-line" />
        <path d="M3 10H31" className="authoring-glyph-line dashed" />
      </>
    );
  }
  if (key === "person")
    return (
      <>
        <circle cx="17" cy="5" r="4" className="authoring-glyph-fill" />
        <path d="M7 19C7 12 27 12 27 19Z" className="authoring-glyph-fill" />
      </>
    );
  if (key === "database")
    return (
      <>
        <path d="M5 5C5 2 29 2 29 5V15C29 18 5 18 5 15Z" className="authoring-glyph-fill" />
        <path d="M5 5C5 8 29 8 29 5" className="authoring-glyph-line" />
      </>
    );
  if (key === "container")
    return (
      <>
        <rect x="3" y="3" width="28" height="14" rx="2" className="authoring-glyph-fill" />
        <path d="M7 7H20" className="authoring-glyph-line" />
      </>
    );
  if (key === "boundary" || key === "composite")
    return (
      <>
        <rect x="2" y="2" width="30" height="16" rx="3" className="authoring-glyph-line dashed" />
        <rect x="10" y="7" width="14" height="7" rx="1" className="authoring-glyph-fill" />
      </>
    );
  if (key === "start") return <circle cx="17" cy="10" r="5" className="authoring-glyph-solid" />;
  if (key === "end")
    return (
      <>
        <circle cx="17" cy="10" r="7" className="authoring-glyph-line" />
        <circle cx="17" cy="10" r="4" className="authoring-glyph-solid" />
      </>
    );
  if (key === "choice") return <path d="M17 2 26 10 17 18 8 10Z" className="authoring-glyph-fill" />;
  if (key === "entity")
    return (
      <>
        <rect x="5" y="2" width="24" height="16" rx="1" className="authoring-glyph-fill" />
        <path d="M5 7H29M5 12H29" className="authoring-glyph-line" />
      </>
    );
  if (key === "one-many")
    return (
      <>
        <path d="M3 10H31M7 6V14M27 10 31 6M27 10 31 14" className="authoring-glyph-line" />
      </>
    );
  if (key === "one-one")
    return (
      <>
        <path d="M3 10H31M7 6V14M27 6V14" className="authoring-glyph-line" />
      </>
    );
  if (key === "many-many")
    return (
      <>
        <path d="M3 10H31M7 10 3 6M7 10 3 14M27 10 31 6M27 10 31 14" className="authoring-glyph-line" />
      </>
    );
  if (key === "external")
    return <rect x="3" y="3" width="28" height="14" rx="2" className="authoring-glyph-line dashed" />;
  if (key === "state" || key === "system")
    return <rect x="3" y="3" width="28" height="14" rx={key === "state" ? 6 : 2} className="authoring-glyph-fill" />;
  return (
    <>
      <path d="M3 10H28" className="authoring-glyph-line" />
      {arrowHead(30, 10)}
    </>
  );
}
