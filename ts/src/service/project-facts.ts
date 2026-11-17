// The project page's title facts (docs/adr/0017): what the project holds and
// where it is, computed from the catalog's own inventory, the cached Git head
// (`git-head.ts`) and the project root. Additive catalog fields: an older page
// ignores them. Nothing here reads a file or runs a command.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, sep, basename } from "node:path";
import type { GitHead } from "../project/git-head.ts";

export interface ProjectFacts {
  /** Every diagram view, durable and embedded. */
  readonly diagrams: number;
  readonly notes: number;
  /** Sent threads on views and notes that are not resolved; drafts are not counted. */
  readonly openThreads: number;
  /** ISO 8601: the latest modification time of a diagram or note; absent when none is known. */
  readonly lastEditedAt?: string;
  /** The project root for display, home-relative where it is under the home folder (`~/code/archer`). */
  readonly projectFolder: string;
  /** Absent outside a Git checkout, before the first commit, or until Git has answered. */
  readonly git?: GitHead;
}

type Threads = Readonly<Record<string, number>>;
export interface FactsInput {
  readonly views: readonly { readonly threads?: Threads; readonly modifiedAt?: string }[];
  readonly notes: readonly { readonly threads?: Threads; readonly modifiedAt?: string }[];
  readonly root: string;
  readonly git: GitHead | null | undefined;
  /** For tests; defaults to the service user's home folder, canonical like project roots. */
  readonly home?: string;
}

let home: string | undefined;
/** The home folder with its links resolved, as project roots are; asked once. */
function canonicalHome(): string {
  if (home === undefined) {
    try {
      home = realpathSync(homedir());
    } catch {
      home = homedir();
    }
  }
  return home;
}

/** `path` with the home folder written `~`; any other path unchanged. */
export function homeRelative(path: string, home: string = homedir()): string {
  // Outside the home directory only the folder's own name is shown: the
  // catalog reaches every grant holder, and an absolute path names the account.
  const elsewhere = `\u2026/${basename(path)}`;
  if (home === "" || !isAbsolute(home)) return elsewhere;
  const rest = relative(home, path);
  if (rest === "") return "~";
  if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest)) return elsewhere;
  return `~/${rest.split(sep).join("/")}`;
}

/** Free text for the page (an agent's label, a refusal): every absolute path in it written as the catalog writes paths (review C15, L16). */
export function pageText(text: string, home: string = homedir()): string {
  return text.replace(/(?<![\w~.])\/[^\s·,;:'"()<>[\]{}]*/gu, (path) =>
    path === "/" ? path : homeRelative(path.replace(/[.]+$/u, ""), home) + (path.match(/[.]+$/u)?.[0] ?? ""),
  );
}

// A draft is unsent: the agent cannot see it, so it is not an open thread yet.
const open = (threads: Threads | undefined): number =>
  threads === undefined
    ? 0
    : Object.entries(threads).reduce(
        (sum, [status, count]) => (status === "resolved" || status === "draft" ? sum : sum + count),
        0,
      );

export function projectFacts(input: FactsInput): ProjectFacts {
  const items = [...input.views, ...input.notes];
  let lastEditedAt: string | undefined,
    lastEdited = -Infinity;
  for (const item of items) {
    const at = item.modifiedAt === undefined ? NaN : Date.parse(item.modifiedAt);
    if (at > lastEdited) {
      lastEdited = at;
      lastEditedAt = item.modifiedAt;
    }
  }
  return {
    diagrams: input.views.length,
    notes: input.notes.length,
    openThreads: items.reduce((sum, item) => sum + open(item.threads), 0),
    ...(lastEditedAt === undefined ? {} : { lastEditedAt }),
    projectFolder: homeRelative(input.root, input.home ?? canonicalHome()),
    ...(input.git == null ? {} : { git: input.git }),
  };
}
