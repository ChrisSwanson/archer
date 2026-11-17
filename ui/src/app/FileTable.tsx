/**
 * Files as a table, one row each: what it is, what it is about, where it is,
 * and when it was created and last edited (the projects-and-search design),
 * grouped by folder. Its one caller is FolderPage:
 * the project page's tables became the Folders tree, and the sorting, column
 * drag, inline details and scrolling body only they used were removed (perf
 * pass 2).
 *
 * Its semantics are a table's, spelled out with roles as well, because at
 * phone width the rows are laid out as blocks and a browser drops a table's
 * implied roles from a `display: block` table. A title or row click opens the file.
 */
import { Fragment, type JSX, type MouseEvent, type ReactNode } from "react";
import { createdSourcePhrase, descriptionSourcePhrase, longDate, shortDate } from "./file-facts";
import { typeLabel, type FileRow } from "./file-index";
import type { MatchSummary } from "./search";
import "./ProjectPages.css";
import "./FileTableDetails.css";
import "./FileTableScroll.css";

/** The folder page's columns: the description and status ride under the name. */
export type Column = "name" | "type" | "folder" | "edited" | "created";

const HEADING: Readonly<Record<Column, string>> = {
  name: "Name",
  type: "Type",
  folder: "Path",
  edited: "Edited",
  created: "Created",
};

export const ICON = {
  folder: "M3 6.5h6l2 2h10V19H3z",
  diagram: "M4 4h6v6H4z M14 14h6v6h-6z M10 7h7v7",
  note: "M5 3h10l4 4v14H5z M15 3v5h4 M8 12h8 M8 16h6",
} as const;

export function Glyph({
  icon,
  className,
}: {
  readonly icon: keyof typeof ICON;
  readonly className?: string;
}): JSX.Element {
  return (
    <svg className={className ?? "archer-files-glyph"} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={ICON[icon]} />
    </svg>
  );
}

export type FileGroup = { readonly id: string; readonly heading: ReactNode; readonly rows: readonly FileRow[] };

export type FileTableProps = {
  /** The table's name, for a screen reader. */
  readonly label: string;
  readonly columns: readonly Column[];
  /** Grouped (the project and folder pages), or one sorted body (the search page). */
  readonly groups: readonly FileGroup[];
  readonly now: number;
  readonly onOpen: (row: FileRow) => void;
};

/** A row says this many of its matches; the rest are counted. */
export const ROW_MATCHES = 2;

/** What matched inside the file, the first few: its title and path are on the row already. */
export function inside(summary: MatchSummary | undefined): MatchSummary | undefined {
  if (summary === undefined) return undefined;
  const matches = summary.matches.filter((match) => match.field !== "title" && match.field !== "path");
  const shown = matches.slice(0, ROW_MATCHES);
  const more = summary.more + matches.length - shown.length;
  return shown.length === 0 && more === 0 ? undefined : { matches: shown, more };
}

/** A date in full, as a screen reader hears it and a tooltip shows it: what it is, when, and from where. */
export const dateLabel = (iso: string, label: string, source?: string): string =>
  `${label} ${longDate(iso)}${source === undefined ? "" : `, ${source}`}`;

/** Why a date cell is empty, said in full. */
export const noDateReason = (label: string, emptyReason?: string): string =>
  emptyReason ??
  (label === "Created" ? "No creation date: the file system keeps none and Git has no commit adding it" : "Not known");

/** A date as it reads in sight: short, or in the chosen format, and Git named when the date came from it. */
export function DateInSight({
  iso,
  now,
  gitSourced = false,
}: {
  readonly iso: string;
  readonly now: number;
  readonly gitSourced?: boolean;
}): JSX.Element {
  return (
    <>
      {shortDate(iso, now)}
      {/* A date from Git says so in sight, not only in the tooltip. */}
      {gitSourced ? <span className="archer-files-source"> · Git</span> : null}
    </>
  );
}

export function DateCell({
  iso,
  now,
  label,
  source,
  gitSourced = false,
  emptyReason,
}: {
  readonly iso: string | undefined;
  readonly now: number;
  readonly label: string;
  readonly source?: string;
  readonly gitSourced?: boolean;
  readonly emptyReason?: string;
}): JSX.Element {
  if (iso === undefined) {
    const why = noDateReason(label, emptyReason);
    return (
      <span className="archer-files-none" title={why}>
        <span aria-hidden="true">—</span>
        <span className="archer-visually-hidden">{why}</span>
      </span>
    );
  }
  const full = dateLabel(iso, label, source);
  return (
    <time dateTime={iso} title={full}>
      <span aria-hidden="true">
        <DateInSight iso={iso} now={now} gitSourced={gitSourced} />
      </span>
      <span className="archer-visually-hidden">{full}</span>
    </time>
  );
}

export function Status({ row }: { readonly row: FileRow }): JSX.Element | null {
  const chips: JSX.Element[] = [];
  if (row.presented)
    chips.push(
      <li key="presented" className="archer-files-chip" data-voice="agent">
        Presented by the agent
      </li>,
    );
  if (row.failing)
    chips.push(
      <li key="failing" className="archer-files-chip" data-tone="danger">
        Does not compile
      </li>,
    );
  if (row.openThreads > 0)
    chips.push(
      <li key="threads" className="archer-files-chip">
        {row.openThreads} open {row.openThreads === 1 ? "thread" : "threads"}
      </li>,
    );
  if (row.walkthroughs !== undefined)
    chips.push(
      <li key="walkthroughs" className="archer-files-chip">
        {row.walkthroughs} {row.walkthroughs === 1 ? "walkthrough" : "walkthroughs"}
      </li>,
    );
  return chips.length === 0 ? null : (
    <ul className="archer-files-chips" aria-label="Status">
      {chips}
    </ul>
  );
}

function Row(props: FileTableProps & { readonly row: FileRow }): JSX.Element {
  const { row, columns, now, onOpen } = props;
  const click = (event: MouseEvent<HTMLTableRowElement>): void => {
    // The title, a match and a selection of text are the reader's own; anywhere else opens the row.
    if (event.target instanceof Element && event.target.closest("button, a")) return;
    if ((window.getSelection()?.toString() ?? "") !== "") return;
    onOpen(row);
  };
  const cell = (column: Column): JSX.Element => {
    switch (column) {
      case "name":
        return (
          <td key={column} role="cell" className="archer-files-name" data-column={column}>
            <div className="archer-files-title-line">
              <span
                className="archer-files-activity-indicator"
                {...(row.unresolvedThreads !== undefined && row.unresolvedThreads > 0
                  ? {
                      "data-active": "true",
                      role: "img",
                      "aria-label": `${row.unresolvedThreads} unresolved discussion ${row.unresolvedThreads === 1 ? "thread" : "threads"}`,
                    }
                  : { "aria-hidden": true })}
              />
              <Glyph icon={row.kind} />
              <button
                type="button"
                className="archer-files-open"
                title={row.title}
                // What is wrong with it is part of its name, as a reader hears the row.
                aria-label={row.failing ? `${row.title} — does not compile` : undefined}
                onClick={() => onOpen(row)}
              >
                <span className="archer-files-title-text">{row.title}</span>
              </button>
            </div>
            {row.description === undefined ? null : (
              <p
                className="archer-files-description"
                title={descriptionSourcePhrase(row.descriptionFrom)}
                data-from={row.descriptionFrom}
              >
                {row.description}
              </p>
            )}
            <Status row={row} />
          </td>
        );
      case "type":
        return (
          <td key={column} role="cell" data-column={column} title={row.type === null ? undefined : typeLabel(row)}>
            {row.type === null ? (
              <span className="archer-files-none">{row.kind === "diagram" ? "Diagram" : "Note"}</span>
            ) : (
              typeLabel(row)
            )}
          </td>
        );
      case "folder": {
        const sourcePath = row.sourcePath ?? row.path;
        const file = sourcePath.split("/").at(-1) ?? sourcePath;
        return (
          <td
            key={column}
            role="cell"
            className="archer-files-path"
            data-column={column}
            title={row.sourcePath ?? row.path}
          >
            <span className="archer-files-path-line">
              <span className="archer-files-file">{file}</span>
            </span>
          </td>
        );
      }
      case "edited":
        return (
          <td key={column} role="cell" className="archer-files-date" data-column={column}>
            <DateCell iso={row.modifiedAt} now={now} label="Edited" />
          </td>
        );
      case "created":
        return (
          <td key={column} role="cell" className="archer-files-date" data-column={column}>
            <DateCell
              iso={row.createdAt}
              now={now}
              label="Created"
              gitSourced={row.createdFrom === "git"}
              {...(row.createdFrom === undefined ? {} : { source: createdSourcePhrase(row.createdFrom) })}
            />
          </td>
        );
    }
  };
  return (
    <tr
      role="row"
      className="archer-files-row"
      data-browser-row={row.key}
      data-target={row.target}
      data-kind={row.kind}
      onClick={click}
    >
      {columns.map(cell)}
    </tr>
  );
}

export function FileTable(props: FileTableProps): JSX.Element {
  const { label, columns, groups } = props;
  const grouped = groups.length > 1 || groups.some((group) => group.heading !== null);
  const header = (
    <thead role="rowgroup">
      <tr role="row">
        {columns.map((column) => (
          <th
            key={column}
            scope="col"
            role="columnheader"
            aria-label={HEADING[column]}
            className="archer-files-head"
            data-column={column}
          >
            <div className="archer-files-head-content">
              <span>{HEADING[column]}</span>
            </div>
          </th>
        ))}
      </tr>
    </thead>
  );
  const bodies = groups.map((group) => (
    <Fragment key={group.id}>
      <tbody role="rowgroup" className="archer-files-group" data-group={group.id}>
        {group.heading === null ? null : (
          <tr role="row" className="archer-files-group-head">
            <th scope="rowgroup" role="rowheader" colSpan={columns.length}>
              {group.heading}
            </th>
          </tr>
        )}
        {group.rows.map((row) => (
          <Row key={row.key} {...props} row={row} />
        ))}
      </tbody>
    </Fragment>
  ));
  return (
    <div className="archer-files-frame">
      <table
        className="archer-files"
        role="table"
        aria-label={label}
        data-grouped={grouped ? "true" : undefined}
        data-text-layout="wrap"
      >
        {header}
        {bodies}
      </table>
    </div>
  );
}
