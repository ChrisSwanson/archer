/**
 * One folder of the Archer folder, as the breadcrumb and the project page's
 * folder headings open it (`?folder=`): the project page's table, for the
 * folder and every folder beneath it, each subfolder a group whose heading
 * opens it in turn.
 */
import { useEffect, useMemo, useRef, type JSX } from "react";
import type { ContentsNote } from "./contents";
import { fileRows, type FileRow } from "./file-index";
import { FileTable, Glyph, type Column, type FileGroup } from "./FileTable";
import type { DiagramView } from "./inventory";

export type FolderPageProps = {
  /** Folder-relative, `/`-separated; "" is the Archer folder itself; null names no folder (a `?folder=` outside it). */
  readonly path: string | null;
  readonly views: readonly DiagramView[];
  readonly notes: readonly ContentsNote[];
  readonly failingViewIds?: ReadonlySet<string>;
  readonly presentedViewId?: string | null;
  readonly now: number;
  readonly onOpenFolder: (path: string) => void;
  readonly onOpen: (row: FileRow) => void;
  /** The search page, narrowed to this folder. */
  readonly onSearch: (folder: string) => void;
};

/** The folder page's columns: the project is the page's own, and the kind is the row's icon. */
const FOLDER_COLUMNS: readonly Column[] = ["name", "type", "folder", "edited", "created"];

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The rows of `under` and every folder beneath it, one group per folder, `under` first, then by path; diagrams before notes, by name. */
function folderGroups(rows: readonly FileRow[], under: string, onOpenFolder: (path: string) => void): FileGroup[] {
  const byFolder = new Map<string, FileRow[]>();
  for (const row of rows) {
    if (under !== "" && row.folder !== under && !row.folder.startsWith(`${under}/`)) continue;
    byFolder.set(row.folder, [...(byFolder.get(row.folder) ?? []), row]);
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...byFolder.keys()]
    .sort((a, b) => (a === under ? -1 : b === under ? 1 : collator.compare(a, b)))
    .map((folder) => {
      const held = byFolder
        .get(folder)!
        .sort((a, b) => (a.kind === b.kind ? collator.compare(a.title, b.title) : a.kind === "diagram" ? -1 : 1));
      return { id: folder || ".", heading: folderHeading(folder, under, held.length, onOpenFolder), rows: held };
    });
}

/** A folder group's heading: the folder this page shows, or a way into one beneath it. */
function folderHeading(
  folder: string,
  under: string,
  files: number,
  onOpenFolder: (path: string) => void,
): JSX.Element {
  const count = <span className="archer-files-group-count">{files}</span>;
  return folder === under ? (
    <span className="archer-files-folder archer-files-folder--here">
      <Glyph icon="folder" />
      <span>{folder === "" ? "Top level" : `${folder}/`}</span>
      {count}
    </span>
  ) : (
    <button
      type="button"
      className="archer-files-folder"
      onClick={() => onOpenFolder(folder)}
      aria-label={`Folder ${folder}, ${plural(files, "file", "files")}`}
    >
      <Glyph icon="folder" />
      <span>{under === "" ? folder : folder.slice(under.length + 1)}/</span>
      {count}
    </button>
  );
}

/** The folder page's way to the search page, with its key. */
function SearchThisFolder({ onSearch }: { readonly onSearch: () => void }): JSX.Element {
  return (
    <button type="button" className="archer-project-search" onClick={onSearch} aria-keyshortcuts="/">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
        <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      Search this folder
      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: a <kbd> hint inside a button, not focusable itself; the button names the shortcut with aria-keyshortcuts. */}
      <kbd aria-hidden="true">/</kbd>
    </button>
  );
}

export function FolderPage(props: FolderPageProps): JSX.Element {
  const { path, views, notes, failingViewIds, presentedViewId, now, onOpenFolder, onOpen, onSearch } = props;
  const rows = useMemo(
    () =>
      fileRows({
        slug: "",
        name: "",
        views,
        notes,
        current: true,
        ...(failingViewIds === undefined ? {} : { failingViewIds }),
        presentedViewId: presentedViewId ?? null,
      }),
    [views, notes, failingViewIds, presentedViewId],
  );
  const groups = useMemo(
    () => (path === null ? [] : folderGroups(rows, path, onOpenFolder)),
    [rows, path, onOpenFolder],
  );
  const name = path === null ? "Unknown folder" : path.split("/").at(-1) || "Archer folder";
  const region = useRef<HTMLElement | null>(null);
  // The segment the reader pressed becomes the current page and is gone: the
  // folder takes the focus, so the keyboard carries on from what it shows.
  useEffect(() => {
    region.current?.focus({ preventScroll: true });
  }, [path]);
  const held = groups.flatMap((group) => group.rows);
  const diagrams = held.filter((row) => row.kind === "diagram").length;
  return (
    <section ref={region} className="archer-contents archer-project archer-folder" aria-label={name} tabIndex={-1}>
      <div className="archer-project-head">
        {path === null ? null : (
          <p className="archer-contents-tally archer-folder-path" title={path}>
            {path === "" ? "The Archer folder" : `${path}/`}
            {held.length === 0
              ? null
              : ` · ${plural(diagrams, "diagram", "diagrams")} · ${plural(held.length - diagrams, "note", "notes")}`}
          </p>
        )}
        {path === null || held.length === 0 ? null : <SearchThisFolder onSearch={() => onSearch(path)} />}
      </div>
      {held.length === 0 ? (
        <p className="archer-folder-empty" role="status">
          Nothing is in this folder now. Its diagrams and notes were moved or deleted.
        </p>
      ) : (
        <FileTable
          label={`Diagrams and notes in ${name}`}
          columns={FOLDER_COLUMNS}
          groups={groups}
          now={now}
          onOpen={onOpen}
        />
      )}
    </section>
  );
}
