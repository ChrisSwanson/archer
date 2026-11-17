/**
 * The project page's Diagrams view: every diagram the search admits as one
 * uniform card gallery, with no folder grouping. A card is a fixed 16:9
 * preview, a title, a description line and one metadata row; the whole card
 * opens the diagram through its one button. Type chips narrow the gallery
 * within the view (docs: project page redesign, Views).
 */
import { useId, useLayoutEffect, useRef, useState, type JSX, type MouseEvent, type RefObject } from "react";
import { noteRowOf, typeLabel, type FileRow } from "../file-index";
import { browserRoutePath, rowRoute } from "../browser-routes";
import { DateCell, Glyph } from "../FileTable";
import { folderLabel, threadsOf, type ProjectViewProps } from "./view-facts";
import "./project-views.css";
import "./DiagramsView.css";
import { firstScreenCards, windowFirstScreen } from "./first-screen";

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
/** The chip that narrows to the diagrams embedded in notes; no diagram type is spelled this way. */
const IN_NOTES = "\u0000in-notes";
const diagramCount = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "diagram" : "diagrams"}`;

/** Each type present, by its label, A to Z; a pressed type stays though the search left none of it. */
function typeCounts(rows: readonly FileRow[], pressed: string | null): readonly (readonly [string, number])[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(typeLabel(row), (counts.get(typeLabel(row)) ?? 0) + 1);
  if (pressed !== null && !counts.has(pressed)) counts.set(pressed, 0);
  return [...counts].sort(([a], [b]) => collator.compare(a, b));
}

/** Measured once the grid is laid out, before the browser decides which lazy images to ask for. */
function useFirstScreen(grid: RefObject<HTMLUListElement | null>, cards: number): number {
  const [count, setCount] = useState(windowFirstScreen);
  useLayoutEffect(() => {
    const element = grid.current,
      card = element?.firstElementChild;
    if (element === null || element === undefined || !(card instanceof HTMLElement)) return;
    const columns = getComputedStyle(element)
      .gridTemplateColumns.split(" ")
      .filter((track) => track !== "").length;
    const height = card.getBoundingClientRect().height;
    if (columns === 0 || height === 0) return;
    setCount(
      firstScreenCards({
        columns,
        cardHeight: height,
        gridTop: element.getBoundingClientRect().top,
        viewportHeight: window.innerHeight,
      }),
    );
  }, [grid, cards > 0]);
  return count;
}

export function DiagramsView(
  props: ProjectViewProps & {
    /** "In notes" kept by the page (its address, `?in=notes`); without it the chip is the gallery's own. */
    readonly inNotes?: boolean;
    readonly onInNotes?: (inNotes: boolean) => void;
  },
): JSX.Element {
  const [chosen, choose] = useState<string | null>(null);
  const kept = props.inNotes !== undefined && props.onInNotes !== undefined;
  const pressed = kept ? (props.inNotes === true ? IN_NOTES : chosen === IN_NOTES ? null : chosen) : chosen;
  const setPressed = (value: string | null): void => {
    if (kept && (value === IN_NOTES) !== props.inNotes) props.onInNotes!(value === IN_NOTES);
    choose(value);
  };
  const diagrams = props.rows.filter((row) => row.kind === "diagram");
  const inNotes = diagrams.filter((row) => row.embedded !== undefined);
  const types = typeCounts(diagrams, pressed === IN_NOTES ? null : pressed);
  const shown =
    pressed === null ? diagrams : pressed === IN_NOTES ? inNotes : diagrams.filter((row) => typeLabel(row) === pressed);
  const grid = useRef<HTMLUListElement>(null);
  const firstScreen = useFirstScreen(grid, shown.length);
  const chip = (label: string, value: string | null, count: number): JSX.Element => (
    <button
      key={label}
      type="button"
      className="archer-diagrams-chip"
      aria-pressed={pressed === value}
      aria-label={`${label}, ${diagramCount(count)}`}
      onClick={() => setPressed(value)}
    >
      {label}
      <span className="archer-diagrams-chip-count" aria-hidden="true">
        {count.toLocaleString()}
      </span>
    </button>
  );
  return (
    <div className="archer-diagrams-view">
      {diagrams.length > 0 || pressed !== null ? (
        <div className="archer-diagrams-chips" role="group" aria-label="Diagram type">
          {chip("All", null, diagrams.length)}
          {inNotes.length > 0 || pressed === IN_NOTES ? chip("In notes", IN_NOTES, inNotes.length) : null}
          {types.map(([label, count]) => chip(label, label, count))}
        </div>
      ) : null}
      {shown.length > 0 ? (
        <ul className="archer-diagrams-grid" aria-label="Diagrams" ref={grid}>
          {shown.map((row, index) => (
            <li key={row.key}>
              <DiagramCard {...props} row={row} firstScreen={index < firstScreen} />
            </li>
          ))}
        </ul>
      ) : (
        <div className="archer-project-view-empty">
          <p>{diagrams.length > 0 ? "No diagrams match" : (props.emptyMessage ?? "No diagrams match")}</p>
          {diagrams.length > 0 ? (
            <button type="button" onClick={() => setPressed(null)}>
              Show every type
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function DiagramCard({
  row,
  firstScreen,
  ...props
}: ProjectViewProps & { readonly row: FileRow; readonly firstScreen: boolean }): JSX.Element {
  const titleId = useId();
  const threads = threadsOf(row);
  const note = noteRowOf(row);
  const noteHref = note === null ? null : browserRoutePath(rowRoute(note));
  // The title's button is the card's one control; a click elsewhere on the card is the same click,
  // unless the reader was selecting its text.
  const click = (event: MouseEvent<HTMLElement>): void => {
    if (event.target instanceof Element && event.target.closest("button, a")) return;
    if ((window.getSelection()?.toString() ?? "") !== "") return;
    props.onOpen(row);
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: a click anywhere on the card is the same as on its title's button, the card's keyboard control.
    <article
      className="archer-diagram-card"
      aria-label={row.title}
      data-target={row.target}
      data-browser-row={row.key}
      data-failing={row.failing ? "true" : undefined}
      onClick={click}
    >
      <div className="archer-diagram-card-preview">
        {props.renderPreview?.(row, { firstScreen }) ?? (
          <span className="archer-diagram-card-placeholder">
            <Glyph icon="diagram" />
          </span>
        )}
      </div>
      <div className="archer-diagram-card-body">
        <h2 className="archer-diagram-card-heading">
          <button
            type="button"
            id={titleId}
            className="archer-diagram-card-title archer-project-view-open"
            title={row.title}
            aria-label={row.failing ? `${row.title} — does not compile` : undefined}
            onClick={() => props.onOpen(row)}
          >
            {row.title}
          </button>
        </h2>
        {row.embedded === undefined ? null : (
          <p className="archer-diagram-card-address" title={row.embedded.address}>
            {row.embedded.address}
          </p>
        )}
        <p className="archer-diagram-card-description" data-empty={row.description === undefined ? "true" : undefined}>
          {row.description ?? ""}
        </p>
        <p className="archer-diagram-card-meta">
          <span className="archer-project-view-kind">{typeLabel(row)}</span>
          {props.showProject ? (
            <span className="archer-project-view-project" title={row.projectName}>
              {row.projectName}
            </span>
          ) : null}
          {note === null ? (
            <span className="archer-project-view-folder" title={row.sourcePath ?? row.path}>
              {folderLabel(row)}
            </span>
          ) : (
            <a
              className="archer-diagram-card-note"
              href={noteHref ?? undefined}
              title={note.path}
              onClick={(event) => {
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                props.onOpen(note);
              }}
            >
              in {note.title}
            </a>
          )}
          {threads.total > 0 ? (
            <span
              className="archer-project-view-threads"
              data-open={threads.open > 0 ? "true" : "false"}
              title={threads.label}
            >
              <span aria-hidden="true">
                {threads.open > 0 ? threads.text : `${threads.text} ${threads.total === 1 ? "thread" : "threads"}`}
              </span>
              <span className="archer-visually-hidden">{threads.label}</span>
            </span>
          ) : null}
          {row.walkthroughs === undefined ? null : (
            <span className="archer-project-view-walks">
              {row.walkthroughs} {row.walkthroughs === 1 ? "walkthrough" : "walkthroughs"}
            </span>
          )}
          <span className="archer-diagram-card-edited">
            <DateCell iso={row.modifiedAt} now={props.now} label="Edited" />
          </span>
        </p>
      </div>
    </article>
  );
}
