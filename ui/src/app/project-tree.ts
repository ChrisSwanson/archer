/**
 * The Folders tab's tree: the rows the search and filters kept, nested by
 * folder (and, across projects, by project first). Pure, so the shape,
 * sorting and disclosure are enumerated in tests rather than read off a page.
 *
 * Sorting reorders the files inside each folder; folders keep their
 * alphabetical place after the folder's own files. Which folders are open is
 * a viewer preference per project (`archer.folderTree.v1`), never the address.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { browserStateKey } from "../runtime/address.ts";
import { sortRows, type FileRow, type Sort, type SortKey } from "./file-index";

export type TreeFolder = {
  readonly kind: "folder";
  /** `<slug>\0<folder path>`; a project's own root is `<slug>\0`. */
  readonly key: string;
  readonly slug: string;
  /** Project-relative folder path, "" for a project root. */
  readonly path: string;
  readonly name: string;
  /** Depth below the tree's own root (a project root, across projects, is 0). */
  readonly depth: number;
  readonly projectRoot: boolean;
  /** Files at or below this folder. */
  readonly files: number;
  /** Files of this folder's project in the tree: how large the project is, for the default (D3). */
  readonly projectFiles: number;
  readonly children: readonly TreeNode[];
};
export type TreeFile = { readonly kind: "file"; readonly key: string; readonly depth: number; readonly row: FileRow };
export type TreeNode = TreeFolder | TreeFile;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

type MutableFolder = {
  slug: string;
  path: string;
  name: string;
  projectRoot: boolean;
  folders: Map<string, MutableFolder>;
  files: FileRow[];
};

/**
 * The tree of `rows`. With `projects`, each project is a root of its own
 * (the overview); without, the folders under `under` are the roots.
 */
export function buildFolderTree(
  rows: readonly FileRow[],
  options: {
    readonly under?: string | null;
    readonly sort: Sort;
    readonly projects?: readonly { readonly slug: string; readonly name: string }[];
  },
): readonly TreeNode[] {
  const under = (options.under ?? "").replace(/^\/+|\/+$/g, "");
  const base = under === "" ? [] : under.split("/");
  const roots = new Map<string, MutableFolder>();
  const rootOf = (slug: string, name: string): MutableFolder => {
    let root = roots.get(slug);
    if (root === undefined) {
      root = { slug, path: under, name, projectRoot: true, folders: new Map(), files: [] };
      roots.set(slug, root);
    }
    return root;
  };
  for (const project of options.projects ?? []) rootOf(project.slug, project.name);
  const projectFiles = new Map<string, number>();
  for (const row of rows) {
    const segments = row.folder === "" ? [] : row.folder.split("/");
    if (base.some((segment, index) => segments[index] !== segment)) continue;
    projectFiles.set(row.slug, (projectFiles.get(row.slug) ?? 0) + 1);
    let folder = options.projects === undefined ? rootOf("", "") : rootOf(row.slug, row.projectName);
    for (let index = base.length; index < segments.length; index++) {
      const name = segments[index]!;
      let next = folder.folders.get(name);
      if (next === undefined) {
        next = {
          slug: row.slug,
          path: segments.slice(0, index + 1).join("/"),
          name,
          projectRoot: false,
          folders: new Map(),
          files: [],
        };
        folder.folders.set(name, next);
      }
      folder = next;
    }
    folder.files.push(row);
  }
  const freeze = (folder: MutableFolder, depth: number): { readonly nodes: TreeNode[]; readonly files: number } => {
    const files: TreeNode[] = sortFolderFiles(folder.files, options.sort).map((row) => ({
      kind: "file",
      key: row.key,
      depth,
      row,
    }));
    let count = folder.files.length;
    const folders: TreeNode[] = [...folder.folders.values()]
      .sort((a, b) => collator.compare(a.name, b.name))
      .map((child) => {
        const inner = freeze(child, depth + 1);
        count += inner.files;
        return {
          kind: "folder",
          key: `${child.slug}\0${child.path}`,
          slug: child.slug,
          path: child.path,
          name: child.name,
          depth,
          projectRoot: false,
          files: inner.files,
          projectFiles: projectFiles.get(child.slug) ?? 0,
          children: inner.nodes,
        };
      });
    return { nodes: [...files, ...folders], files: count };
  };
  if (options.projects === undefined) return freeze(rootOf("", ""), 0).nodes;
  return [...roots.values()].map((root) => {
    const inner = freeze(root, 1);
    return {
      kind: "folder",
      key: `${root.slug}\0`,
      slug: root.slug,
      path: "",
      name: root.name,
      depth: 0,
      projectRoot: true,
      files: inner.files,
      projectFiles: inner.files,
      children: inner.nodes,
    };
  });
}

/** A file's name, its folder already said by the tree. */
export const fileName = (row: FileRow): string => {
  const path = row.sourcePath ?? row.path;
  return path.split("/").at(-1) ?? path;
};

function sortFolderFiles(rows: readonly FileRow[], sort: Sort): FileRow[] {
  // In a folder the path differs only by file name, so Path sorts by name.
  if (sort.key !== "folder") return sortRows(rows, sort);
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort(
    (a, b) => collator.compare(fileName(a), fileName(b)) * sign || collator.compare(a.title, b.title),
  );
}

/** Past this many files in a project, its folders start closed (performance plan D3). */
export const OPEN_FOLDERS_UP_TO = 200;

/**
 * A folder's place before the viewer chooses: open, so a project's files are all in sight, unless the
 * project has more than `OPEN_FOLDERS_UP_TO` files in the tree; then its folders start closed (D3). A
 * project's own root stays open. The default is never stored: only the viewer's choice is.
 *
 * `large` is what the visit first saw of the project (`useFolderTreeOpen` settles it once), so a poll that
 * takes a project across the threshold neither opens nor closes folders under the reader.
 */
export function openByDefault(folder: TreeFolder, large = folder.projectFiles > OPEN_FOLDERS_UP_TO): boolean {
  return folder.projectRoot || !large;
}

export type VisibleTreeRow = { readonly node: TreeNode; readonly expanded?: boolean };

/** The rows on screen: a closed folder hides everything beneath it. */
export function visibleTreeRows(nodes: readonly TreeNode[], isOpen: (folder: TreeFolder) => boolean): VisibleTreeRow[] {
  const out: VisibleTreeRow[] = [];
  const walk = (list: readonly TreeNode[]): void => {
    for (const node of list) {
      if (node.kind === "file") {
        out.push({ node });
        continue;
      }
      const expanded = isOpen(node);
      out.push({ node, expanded });
      if (expanded) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

// ------------------------------------------------------- the open folders

export const FOLDER_TREE_KEY = "archer.folderTree.v1";
const MAX_PROJECTS = 64;
const MAX_FOLDERS = 512;
const MAX_JSON_CHARS = 200_000;
/** Open (true) or closed (false) by the viewer, per project slug and folder path. */
export type FolderChoices = Readonly<Record<string, Readonly<Record<string, boolean>>>>;

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readFolderChoices(storage: Storage | null = safeStorage()): FolderChoices {
  try {
    const raw = storage?.getItem(browserStateKey(FOLDER_TREE_KEY));
    if (raw == null || raw.length > MAX_JSON_CHARS) return {};
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const out: Record<string, Record<string, boolean>> = {};
    for (const [slug, folders] of Object.entries(value).slice(0, MAX_PROJECTS)) {
      if (slug.length > 240 || typeof folders !== "object" || folders === null || Array.isArray(folders)) continue;
      const kept: Record<string, boolean> = {};
      for (const [path, open] of Object.entries(folders).slice(0, MAX_FOLDERS))
        if (path.length <= 1024 && typeof open === "boolean") kept[path] = open;
      out[slug] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

/** One folder's choice recorded; the project most recently changed is kept first when the bound is reached. */
export function withFolderChoice(choices: FolderChoices, slug: string, path: string, open: boolean): FolderChoices {
  const own = { ...(choices[slug] ?? {}) };
  delete own[path];
  const folders = Object.fromEntries([[path, open], ...Object.entries(own)].slice(0, MAX_FOLDERS));
  const others = Object.entries(choices).filter(([other]) => other !== slug);
  return Object.fromEntries([[slug, folders], ...others].slice(0, MAX_PROJECTS));
}

/**
 * Which folders are open. While a search or filter is set, every folder with
 * a match opens and the viewer's toggles last only for that search, so a
 * remembered closed folder never hides a match.
 */
export function useFolderTreeOpen(
  filtering: boolean,
  root = "",
  slugs?: ReadonlySet<string>,
): { readonly isOpen: (folder: TreeFolder) => boolean; readonly toggle: (folder: TreeFolder) => void } {
  const [choices, setChoices] = useState<FolderChoices>(readFolderChoices);
  const [transient, setTransient] = useState<ReadonlyMap<string, boolean>>(new Map());
  useEffect(() => {
    if (!filtering) setTransient(new Map());
  }, [filtering]);
  useEffect(() => {
    const changed = (event: StorageEvent): void => {
      if (event.key === browserStateKey(FOLDER_TREE_KEY) || event.key === null) setChoices(readFolderChoices());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  // Whether each project (at the folder the tree is rooted at) was large when this visit first showed it
  // unfiltered: decided once, so a catalog poll crossing the threshold keeps folders, and focus, where they were.
  // The decisions belong to the tree's scope and hold only its projects at its root: another root, or a project
  // that left the unfiltered tree (`slugs`, the projects its rows hold), decides afresh. A filter narrowing the
  // rows is not a new scope.
  const large = useRef({ root, bySlug: new Map<string, boolean>() });
  if (large.current.root !== root) large.current = { root, bySlug: new Map() };
  else if (!filtering && slugs !== undefined)
    for (const slug of large.current.bySlug.keys()) if (!slugs.has(slug)) large.current.bySlug.delete(slug);
  const isOpen = useCallback(
    (folder: TreeFolder): boolean => {
      if (filtering) return transient.get(folder.key) ?? true;
      const chosen = choices[folder.slug]?.[folder.path];
      if (chosen !== undefined) return chosen;
      const decided = large.current.bySlug;
      let settled = decided.get(folder.slug);
      if (settled === undefined) {
        settled = folder.projectFiles > OPEN_FOLDERS_UP_TO;
        decided.set(folder.slug, settled);
      }
      return openByDefault(folder, settled);
    },
    [choices, transient, filtering, root],
  );
  const toggle = useCallback(
    (folder: TreeFolder): void => {
      const next = !isOpen(folder);
      if (filtering) {
        setTransient((current) => new Map(current).set(folder.key, next));
        return;
      }
      setChoices((current) => {
        const updated = withFolderChoice(current, folder.slug, folder.path, next);
        try {
          safeStorage()?.setItem(browserStateKey(FOLDER_TREE_KEY), JSON.stringify(updated));
        } catch {
          /* Kept in memory when storage refuses. */
        }
        return updated;
      });
    },
    [isOpen, filtering],
  );
  return { isOpen, toggle };
}

// --------------------------------------------------------- the columns

export const TREE_COLUMNS = ["title", "kind", "threads", "edited", "created"] as const;
export type TreeColumn = (typeof TREE_COLUMNS)[number];
export const TREE_COLUMN_LABEL: Readonly<Record<"name" | TreeColumn, string>> = {
  name: "Name",
  title: "Title",
  kind: "Kind",
  threads: "Threads",
  edited: "Edited",
  created: "Created",
};
/** The shared sort key each sortable column sets. */
export const TREE_SORT_KEY: Readonly<Record<"name" | TreeColumn, SortKey>> = {
  name: "folder",
  title: "name",
  kind: "type",
  threads: "total",
  edited: "edited",
  created: "created",
};
export const TREE_COLUMNS_KEY = "archer.folderTreeColumns.v1";

export function readTreeColumns(storage: Storage | null = safeStorage()): readonly TreeColumn[] {
  try {
    const raw = storage?.getItem(browserStateKey(TREE_COLUMNS_KEY));
    if (raw == null || raw.length > 512) return TREE_COLUMNS;
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return TREE_COLUMNS;
    const kept = [
      ...new Set(value.filter((column): column is TreeColumn => (TREE_COLUMNS as readonly unknown[]).includes(column))),
    ];
    // A column added since the order was saved goes at the end.
    return [...kept, ...TREE_COLUMNS.filter((column) => !kept.includes(column))];
  } catch {
    return TREE_COLUMNS;
  }
}

export function useTreeColumns(): {
  readonly columns: readonly TreeColumn[];
  readonly onColumnsChange: (columns: readonly TreeColumn[]) => void;
} {
  const [columns, setColumns] = useState(readTreeColumns);
  const onColumnsChange = useCallback((next: readonly TreeColumn[]): void => {
    setColumns(next);
    try {
      safeStorage()?.setItem(browserStateKey(TREE_COLUMNS_KEY), JSON.stringify(next));
    } catch {
      /* Kept in memory when storage refuses. */
    }
  }, []);
  return { columns, onColumnsChange };
}
