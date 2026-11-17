/**
 * The Folders tab: the project's files as a tree, folders with disclosure
 * arrows and indentation only, with an aligned Title column beside the file
 * names and the kind, threads, edited and created columns after it. Headers
 * sort (files within each folder) and, by their handle at the left, reorder.
 *
 * A treegrid: each row has a level, a folder's row says whether it is open
 * (`aria-expanded`, as its arrow does; the arrow only opens and closes), its
 * name is a link to its page, and a file's title (or anywhere else on its
 * row) opens it. One tab stop roves between the rows' names (WAI-ARIA
 * treegrid keys); a file's search matches are reached from its title with
 * Right and Left, and Up, Down, Home and End leave them for another row.
 */
// biome-ignore-all lint/a11y/useFocusableInteractive: the treegrid's one roving tab stop is each row's name (above); its rows, cells and headers are reached by the treegrid keys, not each made a stop.
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { browserRoutePath } from "./browser-routes";
import { useColumnDrag } from "./column-drag";
import { dateLabel, DateInSight, Glyph, inside, noDateReason } from "./FileTable";
import { typeLabel, type FileRow, type Sort, type SortKey } from "./file-index";
import { createdSourcePhrase } from "./file-facts";
import {
  buildFolderTree,
  fileName,
  TREE_COLUMN_LABEL,
  TREE_SORT_KEY,
  useFolderTreeOpen,
  visibleTreeRows,
  type TreeColumn,
  type TreeFolder,
  type TreeNode,
} from "./project-tree";
import type { MatchSummary, SearchMatch } from "./search";
import { SearchMatches } from "./SearchMatches";
import "./FileTableScroll.css";
import "./FolderTree.css";
import { worktreeDetail, type ProjectWorktree } from "./project-directory";

export type FolderTreeProps = {
  readonly rows: readonly FileRow[];
  /** The folder the page is at; the tree starts below it. */
  readonly under?: string | null;
  /** Across projects (the overview), each project is a root of the tree. */
  readonly projects?: readonly {
    readonly slug: string;
    readonly name: string;
    readonly description?: string;
    readonly worktree?: ProjectWorktree;
  }[];
  readonly sort: Sort;
  readonly onSort: (key: SortKey) => void;
  readonly columns: readonly TreeColumn[];
  readonly onColumnsReorder?: (columns: readonly TreeColumn[]) => void;
  /** A search or filter is set: folders with matches open, and toggles last only for it. */
  readonly filtering: boolean;
  readonly now: number;
  readonly onOpen: (row: FileRow) => void;
  /** A project's name opened: its page (ADR 0017 explicit navigation). */
  readonly onOpenProject?: (slug: string) => void;
  /** A folder's name opened: that folder's page. The arrow never calls it. */
  readonly onOpenFolder?: (slug: string, path: string) => void;
  /** The folder the page is at, marked `aria-current="page"` where the tree shows it. */
  readonly currentFolder?: { readonly slug: string; readonly path: string };
  /** Across projects, which project roots are closed: the page's, so the sidebar can open one. */
  readonly collapsedProjects?: ReadonlySet<string>;
  readonly onToggleProject?: (slug: string) => void;
  readonly matches?: ReadonlyMap<string, MatchSummary>;
  readonly onOpenMatch?: (row: FileRow, match: SearchMatch) => void;
  readonly label?: string;
};

// In rem, so the fixed columns grow with the reader's text size, and each heading fits its column on one line
// at the normal size ("THREADS" broke into "THREAD / S" in 84px; owner, round 1 pass 5 O3).
const WIDTH: Readonly<Record<"name" | TreeColumn, string>> = {
  name: "minmax(14rem, 1.15fr)",
  title: "minmax(10rem, 1fr)",
  kind: "6rem",
  threads: "6.5rem",
  edited: "6rem",
  created: "6rem",
};
const INDENT_PX = 22;

const rowId = (node: TreeNode): string => `${node.kind}:${node.key}`;

function Chevron({ open }: { readonly open: boolean }): JSX.Element {
  return (
    <svg
      className="archer-folder-tree-chevron"
      data-open={open ? "true" : "false"}
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M4.5 3 7.5 6 4.5 9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/*
 * A file row's cells carry their full text as their accessible name, beside the short text in sight,
 * rather than in visually hidden copies: a row is a dozen elements, not twenty (perf pass 1).
 */

function ThreadsCell({ row }: { readonly row: FileRow }): JSX.Element {
  const open = row.unresolvedThreads ?? row.openThreads;
  const total = row.totalThreads;
  if ((total ?? 0) === 0 && open === 0) {
    const why = total === undefined ? "Comment activity unavailable" : "No threads";
    return (
      <span
        role="gridcell"
        data-column="threads"
        className="archer-folder-tree-number archer-files-none"
        title={why}
        aria-label={why}
      >
        —
      </span>
    );
  }
  const text = total === undefined ? `${open} open` : open > 0 ? `${total} · ${open} open` : `${total}`;
  return (
    <span
      role="gridcell"
      data-column="threads"
      className="archer-folder-tree-number archer-folder-tree-threads"
      data-open={open > 0 ? "true" : undefined}
      aria-label={`${total === undefined ? "" : `${total} ${total === 1 ? "thread" : "threads"}, `}${open} open`}
    >
      {text}
    </span>
  );
}

/** A date cell that is itself the `<time>`: machine-readable, short in sight, named in full. */
function DateGridCell({
  column,
  iso,
  now,
  label,
  source,
  gitSourced,
}: {
  readonly column: TreeColumn;
  readonly iso: string | undefined;
  readonly now: number;
  readonly label: string;
  readonly source?: string;
  readonly gitSourced?: boolean;
}): JSX.Element {
  if (iso === undefined) {
    const why = noDateReason(label);
    return (
      <span
        role="gridcell"
        data-column={column}
        className="archer-files-date archer-files-none"
        title={why}
        aria-label={why}
      >
        —
      </span>
    );
  }
  const full = dateLabel(iso, label, source);
  return (
    <time
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a cell of the file treegrid (APG treegrid pattern); <time> keeps the machine-readable date.
      role="gridcell"
      data-column={column}
      className="archer-files-date"
      dateTime={iso}
      title={full}
      aria-label={full}
    >
      <DateInSight iso={iso} now={now} gitSourced={gitSourced === true} />
    </time>
  );
}

export function FolderTree(props: FolderTreeProps): JSX.Element {
  const { rows, sort, onSort, columns, now } = props;
  const tree = useMemo(
    () =>
      buildFolderTree(rows, {
        ...(props.under === undefined ? {} : { under: props.under }),
        sort,
        ...(props.projects === undefined ? {} : { projects: props.projects }),
      }),
    [rows, props.under, sort, props.projects],
  );
  const slugs = useMemo(() => new Set(rows.map((row) => row.slug)), [rows]);
  const disclosure = useFolderTreeOpen(props.filtering, props.under ?? "", slugs);
  const { collapsedProjects, onToggleProject } = props;
  const projectChoice = (folder: TreeFolder): boolean =>
    folder.projectRoot && collapsedProjects !== undefined && !props.filtering;
  const isOpen = (folder: TreeFolder): boolean =>
    projectChoice(folder) ? !collapsedProjects!.has(folder.slug) : disclosure.isOpen(folder);
  const toggle = (folder: TreeFolder): void => {
    if (projectChoice(folder) && onToggleProject !== undefined) onToggleProject(folder.slug);
    else disclosure.toggle(folder);
  };
  const visible = visibleTreeRows(tree, isOpen);
  const ids = visible.map(({ node }) => rowId(node));
  const [focusId, setFocusId] = useState<string | null>(null);
  const stop = focusId !== null && ids.includes(focusId) ? focusId : ids[0];
  const primaries = useRef(new Map<string, HTMLElement>());
  const primaryRef = useCallback(
    (id: string) =>
      (element: HTMLElement | null): void => {
        if (element === null) primaries.current.delete(id);
        else primaries.current.set(id, element);
      },
    [],
  );
  const onFocus = (event: FocusEvent<HTMLDivElement>): void => {
    const id =
      event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tree-id]")?.dataset.treeId : undefined;
    if (id !== undefined) setFocusId(id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || !(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLElement>(
      "[data-tree-primary], [data-tree-cell], .archer-folder-tree-disclose",
    );
    const id = control?.closest<HTMLElement>("[data-tree-id]")?.dataset.treeId;
    const at = id === undefined ? -1 : ids.indexOf(id);
    if (control === null || at < 0) return;
    const entry = visible[at]!;
    // A row's own cells after its name: a file's search matches.
    const row = control.closest<HTMLElement>("[data-tree-id]")!;
    const cells = [...row.querySelectorAll<HTMLElement>("[data-tree-primary], [data-tree-cell]")];
    const cell = cells.indexOf(control);
    const move = (to: number): void => {
      const target = primaries.current.get(ids[Math.max(0, Math.min(ids.length - 1, to))]!);
      event.preventDefault();
      target?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        move(at + 1);
        return;
      case "ArrowUp":
        move(at - 1);
        return;
      case "Home":
        move(0);
        return;
      case "End":
        move(ids.length - 1);
        return;
      case "ArrowRight":
        if (entry.node.kind !== "folder") {
          if (cell >= 0 && cell < cells.length - 1) {
            event.preventDefault();
            cells[cell + 1]!.focus();
          }
          return;
        }
        event.preventDefault();
        if (!entry.expanded) toggle(entry.node);
        else if (visible[at + 1] !== undefined && visible[at + 1]!.node.depth > entry.node.depth) move(at + 1);
        return;
      case "ArrowLeft": {
        if (cell > 0) {
          event.preventDefault();
          cells[cell - 1]!.focus();
          return;
        }
        if (entry.node.kind === "folder" && entry.expanded) {
          event.preventDefault();
          toggle(entry.node);
          return;
        }
        for (let up = at - 1; up >= 0; up--)
          if (visible[up]!.node.depth < entry.node.depth) {
            move(up);
            return;
          }
        return;
      }
      case " ":
        // On a name, Space is the arrow; on a file it must not open it or scroll the page (acceptance check 12).
        if (control.dataset.treePrimary === undefined) return;
        event.preventDefault();
        if (entry.node.kind === "folder") toggle(entry.node);
        return;
    }
  };
  const onKeyUp = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === " " && event.target instanceof Element && event.target.closest("[data-tree-primary]") !== null)
      event.preventDefault();
  };
  const frameRef = useRef<HTMLDivElement>(null);
  const drag = useColumnDrag<TreeColumn>({
    frameRef,
    order: columns,
    ...(props.onColumnsReorder === undefined ? {} : { onReorder: props.onColumnsReorder }),
    headerSelector: ".archer-folder-tree-head [data-column]",
    cellSelector: (column) => `[data-column="${column}"]`,
  });
  const all = ["name", ...columns] as const;
  const style = { "--archer-tree-columns": all.map((column) => WIDTH[column]).join(" ") } as CSSProperties;
  const header = (column: "name" | TreeColumn): JSX.Element => {
    const key = TREE_SORT_KEY[column];
    const active = sort.key === key;
    return (
      <span
        key={column}
        role="columnheader"
        aria-label={TREE_COLUMN_LABEL[column]}
        className="archer-folder-tree-heading"
        data-column={column}
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      >
        {column === "name" ? null : drag.dragHandle(column, TREE_COLUMN_LABEL[column])}
        <button
          type="button"
          className="archer-files-sort"
          data-active={active ? "true" : undefined}
          onClick={() => onSort(key)}
        >
          {TREE_COLUMN_LABEL[column]}
          <svg className="archer-files-sort-mark" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            {active ? (
              <path d={sort.dir === "asc" ? "M3 7.5 6 4.5l3 3" : "M3 4.5 6 7.5l3-3"} />
            ) : (
              <path d="M3.5 4.5 6 2.5l2.5 2M3.5 7.5 6 9.5l2.5-2" />
            )}
          </svg>
        </button>
      </span>
    );
  };
  const folderRow = (folder: TreeFolder, expanded: boolean): JSX.Element => {
    const id = rowId(folder);
    // A project's name is its root page, whatever folder the tree is rooted at.
    const target = folder.projectRoot ? "" : folder.path;
    const href = browserRoutePath({ kind: "browse", projectSlug: folder.slug, folder: target });
    const here =
      props.currentFolder !== undefined &&
      props.currentFolder.slug === folder.slug &&
      props.currentFolder.path === target;
    const open = (event: MouseEvent<HTMLElement>): void => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      event.currentTarget.focus();
      // Going where the page already is adds no history entry.
      if (here) return;
      if (folder.projectRoot) props.onOpenProject?.(folder.slug);
      else props.onOpenFolder?.(folder.slug, folder.path);
    };
    const label = folder.projectRoot ? folder.name : `${folder.name}/`;
    const primary = {
      className: "archer-folder-tree-folder-link",
      "data-tree-primary": "",
      tabIndex: stop === id ? 0 : -1,
      ref: primaryRef(id),
      ...(here ? { "aria-current": "page" as const } : {}),
    };
    return (
      <div
        key={folder.key}
        role="row"
        className="archer-folder-tree-row"
        data-folder={folder.path}
        data-tree-id={id}
        data-browser-folder={`${folder.slug}\0folder:${folder.path}`}
        data-project-root={folder.projectRoot ? "true" : undefined}
        {...(folder.projectRoot
          ? { "data-browser-project": folder.slug, "data-project-collapsed": expanded ? "false" : "true" }
          : {})}
        aria-level={folder.depth + 1}
        aria-expanded={expanded}
      >
        <span
          role="gridcell"
          className="archer-folder-tree-name"
          data-column="name"
          style={{ paddingInlineStart: folder.depth * INDENT_PX }}
        >
          <button
            type="button"
            className="archer-folder-tree-disclose"
            aria-expanded={expanded}
            tabIndex={-1}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${folder.name}`}
            onClick={() => toggle(folder)}
          >
            <Chevron open={expanded} />
          </button>
          {href !== null ? (
            <a {...primary} href={href} onClick={open}>
              {label}
            </a>
          ) : (
            <button type="button" {...primary} onClick={open}>
              {label}
            </button>
          )}
          {folder.projectRoot
            ? (() => {
                const detail = worktreeDetail(props.projects?.find((project) => project.slug === folder.slug));
                return detail === null ? null : (
                  <span className="archer-project-worktree" title={detail.title}>
                    {" "}
                    · {detail.text}
                  </span>
                );
              })()
            : null}
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label replaces the bare number in the name the enclosing control or cell computes from its content (accname); tests pin it. */}
          <span
            className="archer-folder-tree-count"
            aria-label={`${folder.files} ${folder.files === 1 ? "file" : "files"}`}
          >
            {folder.files}
          </span>
        </span>
        {columns.map((column) => (
          <span
            key={column}
            role="gridcell"
            data-column={column}
            className={column === "title" ? "archer-folder-tree-title" : undefined}
          >
            {column === "title" && folder.projectRoot ? (
              <span className="archer-folder-tree-title-text archer-folder-tree-description">
                {props.projects?.find((project) => project.slug === folder.slug)?.description}
              </span>
            ) : null}
          </span>
        ))}
      </div>
    );
  };
  const fileRow = (node: Extract<TreeNode, { kind: "file" }>): JSX.Element => {
    const row = node.row;
    const click = (event: MouseEvent<HTMLDivElement>): void => {
      // The name, a match and a selection of text are the reader's own; anywhere else opens the row.
      if (event.target instanceof Element && event.target.closest("button, a")) return;
      if ((window.getSelection()?.toString() ?? "") !== "") return;
      props.onOpen(row);
    };
    const summary =
      props.matches === undefined || props.onOpenMatch === undefined ? undefined : inside(props.matches.get(row.key));
    const cell = (column: TreeColumn): JSX.Element => {
      switch (column) {
        case "title":
          return (
            <span
              key={column}
              role="gridcell"
              data-column={column}
              className="archer-folder-tree-title"
              title={row.title}
            >
              <button
                type="button"
                className="archer-folder-tree-open archer-folder-tree-title-text"
                data-tree-primary=""
                tabIndex={stop === rowId(node) ? 0 : -1}
                ref={primaryRef(rowId(node))}
                aria-label={row.failing ? `${row.title} — does not compile` : undefined}
                onClick={() => props.onOpen(row)}
              >
                {row.title}
              </button>
              {row.failing ? (
                <span className="archer-files-chip" data-tone="danger">
                  Does not compile
                </span>
              ) : null}
              {row.presented ? (
                <span className="archer-files-chip" data-voice="agent">
                  Presented by the agent
                </span>
              ) : null}
              {summary === undefined ? null : (
                <SearchMatches
                  summary={summary}
                  label={`Matches in ${row.title}`}
                  roving
                  onOpen={(match) => props.onOpenMatch!(row, match)}
                />
              )}
            </span>
          );
        case "kind":
          return (
            <span key={column} role="gridcell" data-column={column} className="archer-folder-tree-kind">
              {typeLabel(row)}
            </span>
          );
        case "threads":
          return <ThreadsCell key={column} row={row} />;
        case "edited":
          return <DateGridCell key={column} column={column} iso={row.modifiedAt} now={now} label="Edited" />;
        case "created":
          return (
            <DateGridCell
              key={column}
              column={column}
              iso={row.createdAt}
              now={now}
              label="Created"
              gitSourced={row.createdFrom === "git"}
              {...(row.createdFrom === undefined ? {} : { source: createdSourcePhrase(row.createdFrom) })}
            />
          );
      }
    };
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: a click anywhere on a file's row is the same as on its name, which is the row's keyboard stop (treegrid).
      <div
        key={node.key}
        role="row"
        className="archer-folder-tree-row archer-folder-tree-file-row"
        data-browser-row={row.key}
        data-tree-id={rowId(node)}
        data-target={row.target}
        data-kind={row.kind}
        aria-level={node.depth + 1}
        onClick={click}
        style={{ "--archer-tree-indent": `${node.depth * INDENT_PX}px` } as CSSProperties}
      >
        <span
          role="gridcell"
          className="archer-folder-tree-name archer-folder-tree-file"
          data-column="name"
          title={row.sourcePath ?? row.path}
        >
          <Glyph icon={row.kind} />
          <span className="archer-folder-tree-file-name">{fileName(row)}</span>
        </span>
        {columns.map(cell)}
      </div>
    );
  };
  return (
    <div ref={frameRef} className="archer-folder-tree-frame" {...drag.frameHandlers}>
      <div
        role="treegrid"
        aria-label={props.label ?? "Project files"}
        className="archer-folder-tree"
        style={style}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
      >
        <div role="row" className="archer-folder-tree-head">
          {all.map(header)}
        </div>
        {visible.map(({ node, expanded }) =>
          node.kind === "folder" ? folderRow(node, expanded === true) : fileRow(node),
        )}
      </div>
    </div>
  );
}
