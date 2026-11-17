/**
 * What the Diagrams and Notes views say of a row beside its title: its
 * threads and, for a note, who wrote it. Pure, shared by both views.
 */
import type { ReactNode } from "react";
import type { FileRow } from "../file-index";

/** The contract both views implement; the project page frame passes the rows its search admits. */
export type PreviewOptions = { readonly firstScreen: boolean };

export type ProjectViewProps = {
  /** Already filtered by the shared search and filters; each view keeps its own kind. */
  readonly rows: readonly FileRow[];
  readonly now: number;
  /** The overview: name each row's project. */
  readonly showProject?: boolean;
  readonly onOpen: (row: FileRow) => void;
  /** A diagram's thumbnail; a placeholder is drawn when absent. `firstScreen`: the card shows without scrolling. */
  readonly renderPreview?: (row: FileRow, options?: PreviewOptions) => ReactNode;
  readonly emptyMessage?: string;
};

export type Threads = {
  readonly total: number;
  readonly open: number;
  /** What is in sight: "2 · 1 open", "1 open", "3"; "" when there is none. */
  readonly text: string;
  /** The sentence for a screen reader and a tooltip. */
  readonly label: string;
};

const plural = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

/**
 * A row's threads. Its retained total when comment activity is known, else
 * the threads not yet resolved, which are all a row without activity carries.
 */
export function threadsOf(row: FileRow): Threads {
  const open = row.openThreads;
  const total = Math.max(row.totalThreads ?? open, open);
  if (total === 0) return { total, open, text: "", label: "No threads" };
  if (open === 0) return { total, open, text: total.toLocaleString(), label: plural(total, "thread") };
  if (total === open)
    return { total, open, text: `${open.toLocaleString()} open`, label: `${plural(open, "thread")}, all open` };
  return {
    total,
    open,
    text: `${total.toLocaleString()} · ${open.toLocaleString()} open`,
    label: `${plural(total, "thread")}, ${open.toLocaleString()} open`,
  };
}

export type Author = "agent" | "person";

/**
 * Who wrote a note, when its row says (`author:` front matter). The service's
 * note listing does not carry it yet, so a row without it reads as unrecorded.
 */
export function authorOf(row: FileRow): Author | null {
  const author = (row as FileRow & { readonly author?: unknown }).author;
  return author === "agent" || author === "person" ? author : null;
}

export const AUTHOR_LABEL: Readonly<Record<Author, string>> = { agent: "Agent", person: "Person" };

/** A folder as the views show it; the Archer folder itself is "Top level". */
export const folderLabel = (row: FileRow): string => (row.folder === "" ? "Top level" : row.folder);
