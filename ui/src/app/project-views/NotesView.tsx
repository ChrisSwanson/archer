/**
 * The project page's Notes view: every note the search admits in one flat
 * table, newest edit first. Each header sorts by its column's own kind of
 * value: text A to Z, threads most first, dates newest first; a second click
 * reverses. The sort is the frame's when it passes `sort` and `onSort`,
 * otherwise the view keeps its own.
 */
import { useState, type JSX } from "react";
import type { FileRow, Sort } from "../file-index";
import { createdSourcePhrase } from "../file-facts";
import { DateCell } from "../FileTable";
import { AUTHOR_LABEL, authorOf, folderLabel, threadsOf, type ProjectViewProps } from "./view-facts";
import "./project-views.css";
import "./NotesView.css";

/** The keys the Notes view sorts by; `total` is the Threads column, as in `SortKey`. */
export const NOTE_SORT_KEYS = ["name", "project", "folder", "author", "total", "edited", "created"] as const;
export type NoteSortKey = (typeof NOTE_SORT_KEYS)[number];
export type NoteSort = { readonly key: NoteSortKey; readonly dir: "asc" | "desc" };
export const DEFAULT_NOTE_SORT: NoteSort = { key: "edited", dir: "desc" };

export type NotesViewProps = ProjectViewProps & {
  /** The frame's sort; a `Sort` whose key the view has no column for falls back to Edited, newest first. */
  readonly sort?: Sort | { readonly key: string; readonly dir: "asc" | "desc" };
  /** Called with the header's key (one of `NOTE_SORT_KEYS`) instead of sorting locally. */
  readonly onSort?: (key: string) => void;
};

const HEADING: Readonly<Record<NoteSortKey, string>> = {
  project: "Project",
  name: "Note",
  folder: "Folder",
  author: "Author",
  total: "Threads",
  edited: "Edited",
  created: "Created",
};

/** Text reads A to Z on a first click; counts and dates most and newest first. */
export const firstDirection = (key: NoteSortKey): "asc" | "desc" =>
  key === "total" || key === "edited" || key === "created" ? "desc" : "asc";

/** The sort after a click on `key`: the same column reverses, another starts at its first direction. */
export function nextNoteSort(sort: NoteSort, key: NoteSortKey): NoteSort {
  return sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: firstDirection(key) };
}

const isNoteSortKey = (key: string): key is NoteSortKey => (NOTE_SORT_KEYS as readonly string[]).includes(key);
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Sorted by `sort`. A missing author or date sorts last whichever way; ties by title, path, project. */
export function sortNotes(rows: readonly FileRow[], sort: NoteSort): FileRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const tie = (a: FileRow, b: FileRow): number =>
    collator.compare(a.title, b.title) ||
    collator.compare(a.path, b.path) ||
    collator.compare(a.projectName, b.projectName);
  const value = (row: FileRow): string | number | null => {
    switch (sort.key) {
      case "project":
        return row.projectName;
      case "name":
        return row.title;
      case "folder":
        return row.folder;
      case "author": {
        const author = authorOf(row);
        return author === null ? null : AUTHOR_LABEL[author];
      }
      case "total":
        return threadsOf(row).total;
      case "edited":
        return row.modifiedAt === undefined ? null : Date.parse(row.modifiedAt);
      case "created":
        return row.createdAt === undefined ? null : Date.parse(row.createdAt);
    }
  };
  return [...rows].sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if (x === null || y === null) return x === y ? tie(a, b) : x === null ? 1 : -1;
    const order = typeof x === "number" && typeof y === "number" ? x - y : collator.compare(String(x), String(y));
    return order * sign || tie(a, b);
  });
}

export function NotesView(props: NotesViewProps): JSX.Element {
  const [local, setLocal] = useState<NoteSort>(DEFAULT_NOTE_SORT);
  const controlled = props.sort !== undefined && props.onSort !== undefined;
  const sort: NoteSort = controlled
    ? isNoteSortKey(props.sort!.key)
      ? { key: props.sort!.key, dir: props.sort!.dir }
      : DEFAULT_NOTE_SORT
    : local;
  const pick = (key: NoteSortKey): void => (controlled ? props.onSort!(key) : setLocal(nextNoteSort(local, key)));
  const notes = sortNotes(
    props.rows.filter((row) => row.kind === "note"),
    sort,
  );
  const columns: readonly NoteSortKey[] = props.showProject
    ? NOTE_SORT_KEYS
    : NOTE_SORT_KEYS.filter((key) => key !== "project");
  if (notes.length === 0)
    return (
      <div className="archer-notes-view">
        <div className="archer-project-view-empty">
          <p>{props.emptyMessage ?? "No notes match"}</p>
        </div>
      </div>
    );
  return (
    <div className="archer-notes-view">
      {/* Its own horizontal scroll at phone width, reachable from the keyboard. */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container is a Tab stop so a keyboard can scroll it (axe scrollable-region-focusable; UI_UX.md, RS1-02). */}
      <div className="archer-notes-scroll" role="region" aria-label="Notes table" tabIndex={0}>
        <table className="archer-notes-table" aria-label="Notes" data-project={props.showProject ? "true" : undefined}>
          <thead>
            <tr>
              {columns.map((key) => {
                const active = sort.key === key;
                return (
                  <th
                    key={key}
                    scope="col"
                    className={`archer-notes-col-${key}`}
                    aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <button
                      type="button"
                      className="archer-notes-sort"
                      data-active={active ? "true" : undefined}
                      onClick={() => pick(key)}
                    >
                      {HEADING[key]}
                      {active ? (
                        <span className="archer-notes-sort-arrow" aria-hidden="true">
                          {sort.dir === "asc" ? "↑" : "↓"}
                        </span>
                      ) : null}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {notes.map((row) => (
              <NoteRow key={row.key} row={row} columns={columns} {...props} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NoteRow({
  row,
  columns,
  ...props
}: NotesViewProps & { readonly row: FileRow; readonly columns: readonly NoteSortKey[] }): JSX.Element {
  const threads = threadsOf(row);
  const author = authorOf(row);
  const cell = (key: NoteSortKey): JSX.Element => {
    switch (key) {
      case "project":
        return (
          <td key={key} className="archer-notes-col-project">
            <span className="archer-project-view-project" title={row.projectName}>
              {row.projectName}
            </span>
          </td>
        );
      case "name":
        return (
          <td key={key} className="archer-notes-col-name">
            <button
              type="button"
              className="archer-project-view-open"
              title={row.title}
              onClick={() => props.onOpen(row)}
            >
              <span className="archer-notes-title">{row.title}</span>
            </button>
            {row.description === undefined ? null : (
              <span className="archer-notes-description" title={row.description}>
                {row.description}
              </span>
            )}
          </td>
        );
      case "folder":
        return (
          <td key={key} className="archer-notes-col-folder">
            <span className="archer-project-view-folder" title={row.sourcePath ?? row.path}>
              {folderLabel(row)}
            </span>
          </td>
        );
      case "author":
        return (
          <td key={key} className="archer-notes-col-author">
            {author === null ? (
              <span className="archer-files-none" title="Author not recorded">
                <span aria-hidden="true">—</span>
                <span className="archer-visually-hidden">Author not recorded</span>
              </span>
            ) : (
              <span className="archer-notes-author" data-author={author}>
                {AUTHOR_LABEL[author]}
              </span>
            )}
          </td>
        );
      case "total":
        return (
          <td key={key} className="archer-notes-col-total">
            {threads.total === 0 ? (
              <span className="archer-files-none" title="No threads">
                <span aria-hidden="true">—</span>
                <span className="archer-visually-hidden">No threads</span>
              </span>
            ) : (
              <span
                className="archer-project-view-threads"
                data-open={threads.open > 0 ? "true" : "false"}
                title={threads.label}
              >
                <span aria-hidden="true">{threads.text}</span>
                <span className="archer-visually-hidden">{threads.label}</span>
              </span>
            )}
          </td>
        );
      case "edited":
        return (
          <td key={key} className="archer-notes-col-edited">
            <DateCell iso={row.modifiedAt} now={props.now} label="Edited" />
          </td>
        );
      case "created":
        return (
          <td key={key} className="archer-notes-col-created">
            <DateCell
              iso={row.createdAt}
              now={props.now}
              label="Created"
              source={row.createdFrom === undefined ? undefined : createdSourcePhrase(row.createdFrom)}
            />
          </td>
        );
    }
  };
  return (
    <tr data-target={row.target} data-browser-row={row.key}>
      {columns.map(cell)}
    </tr>
  );
}
