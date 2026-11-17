/**
 * One mermaid fence of a note, drawn in place: a plate in a hairline frame,
 * captioned like a drawing sheet with the diagram's name, its kind, its state
 * in words and the note's freshness.
 *
 * Drawn lazily. Laying a diagram out is the expensive part of a page, so a
 * figure asks for its drawing only when it comes within a screen of what its
 * scroller shows, and holds its place with its name and kind until then.
 *
 * The drawing is the SVG export painter's (`export/painter.ts`): the same
 * shapes, labels and routes as an exported file, in the page's own tokens so
 * it follows the theme. It is decorative for assistive technology; the
 * figure's name and caption say what it is.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { kindLabel } from "../app/inventory";
import type { EmbeddedDiagramSummary, NoteFreshness } from "./contract";
import { Freshness } from "./Freshness";
import type { FigureLoad, FigureLoader } from "./note-figures";

/** How far beyond what its scroller shows a figure starts drawing: one screen. */
export const FIGURE_ROOT_MARGIN = "100% 0px";

/**
 * The element that scrolls `element` into and out of sight: the observer's root. A margin on the viewport
 * stops at an inner scroller's edge (the note reader's article): with the viewport as root, a figure was
 * near only once it was in sight, and one passed in a quick scroll stayed undrawn until scrolled back (O182).
 */
export function figureScroller(element: Element): Element | null {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === "auto" || overflowY === "scroll") && at.scrollHeight > at.clientHeight) return at;
  }
  return null;
}

export function figureKind(kind: string): string {
  return kindLabel(kind) ?? (kind === "freeform" ? "Flowchart" : kind);
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function NoteFigure(props: {
  readonly diagram: EmbeddedDiagramSummary;
  readonly load: FigureLoader;
  readonly freshness?: NoteFreshness;
  readonly now: number;
  /** Opens the diagram in the canvas at its own address; without it the figure is not a link. */
  readonly onOpen?: (address: string) => void;
  /** Takes the focus when it mounts: the figure the reader opened, on their way back. */
  readonly autoFocus?: boolean;
  /** Told once it has taken that focus. */
  readonly onFocused?: () => void;
}): JSX.Element {
  const { diagram, load } = props;
  const link = useRef<HTMLAnchorElement>(null);
  const { onFocused } = props;
  useEffect(() => {
    if (props.autoFocus !== true || link.current === null) return;
    link.current.focus({ preventScroll: true });
    onFocused?.();
  }, [props.autoFocus, onFocused]);
  const figure = useRef<HTMLElement>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const [state, setState] = useState<FigureLoad | null>(null);

  useEffect(() => {
    const element = figure.current;
    if (near || element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { root: figureScroller(element), rootMargin: FIGURE_ROOT_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);

  useEffect(() => {
    if (!near) return;
    let live = true;
    void load(diagram.address, diagram.sourceRevision).then((answer) => {
      if (live) setState(answer);
    });
    return () => {
      live = false;
    };
  }, [near, load, diagram.address, diagram.sourceRevision]);

  const kind = figureKind(diagram.kind);
  const errors =
    state?.status === "failing" ? state.diagram.diagnostics.filter((d) => d.severity === "error").length : 0;
  const drawing =
    state?.status === "drawn" ? (
      <svg
        className="archer-note-figure-drawing"
        viewBox={state.drawing.viewBox}
        // Never drawn larger than it was laid out: a small diagram is not blown up to the column.
        width={Number(state.drawing.viewBox.split(" ")[2]) || undefined}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        focusable="false"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: the export painter's own output, every label escaped as it is painted (xml(), static-markup-page); xss-corpus.e2e.ts holds embedded figures of hostile diagrams inert.
        dangerouslySetInnerHTML={{
          __html: `<g fill="var(--node-bg)" stroke="var(--node-border)" color="var(--node-text)">${state.drawing.content}</g>`,
        }}
      />
    ) : state?.status === "failing" ? (
      <pre className="archer-note-figure-source">
        <code>{state.diagram.source}</code>
      </pre>
    ) : (
      <p className="archer-note-figure-wait">
        {state?.status === "error" ? state.message : near ? "Drawing…" : `${kind} diagram`}
      </p>
    );
  return (
    <figure
      ref={figure}
      className="archer-note-figure"
      aria-label={`${diagram.name}, ${kind}`}
      data-state={state?.status ?? (near ? "drawing" : "waiting")}
    >
      {props.onOpen === undefined ? (
        <div className="archer-note-figure-plate">{drawing}</div>
      ) : (
        <a
          ref={link}
          className="archer-note-figure-plate archer-note-figure-link"
          href={`?view=${encodeURIComponent(diagram.address)}`}
          aria-label={`Open ${diagram.name}, ${kind}`}
          data-address={diagram.address}
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            props.onOpen?.(diagram.address);
          }}
        >
          {drawing}
        </a>
      )}
      <figcaption className="archer-note-figure-caption">
        <span className="archer-note-figure-name">{diagram.name}</span>
        <span className="archer-note-figure-kind">{kind}</span>
        {state?.status === "failing" ? (
          <span className="archer-note-figure-failure">Does not compile: {plural(errors, "problem", "problems")}</span>
        ) : null}
        {diagram.writable ? null : (
          <span className="archer-note-figure-kind" title="Nested in a list or blockquote: Archer cannot write it back">
            Read only
          </span>
        )}
        {props.freshness === undefined ? null : <Freshness freshness={props.freshness} now={props.now} />}
      </figcaption>
    </figure>
  );
}
