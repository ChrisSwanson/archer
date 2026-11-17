// When a file in the Archer folder was created and last edited, for the
// project page and the search page
// (the projects-and-search design).
//
// EDITED is the file's modification time. CREATED is the file system's birth
// time where it keeps one (statx on Linux ext4/btrfs/xfs, APFS, NTFS). Where it
// does not, Node reports a birth time of 0, or the change time in its place;
// the date is then the commit that first added the file at its path, from one
// bounded `git log` over the folder (`GitRepository.firstAdded`), and failing
// that there is none. A birth time equal to the change time is ambiguous (see
// `birthTime`): Git's date is used, and otherwise the creation date is absent.
// Git is asked in the background (`refresh`); a reload never waits on it. Git is asked at most once a minute, during a reload,
// never per request. An inspection that fails (Git timed out on a loaded
// machine, or could not run) is not an answer: the last answer stands and Git
// is asked again shortly, a few times, without waiting for a reload.
import { statSync } from "node:fs";
import { GitRepository } from "../accuracy/git.ts";
import { resolveInFolder, type Project } from "./index.ts";

export type CreatedSource = "filesystem" | "git";

export interface FileDates {
  /** ISO 8601. */
  readonly createdAt?: string;
  readonly createdFrom?: CreatedSource;
  /** ISO 8601: the file's modification time. */
  readonly modifiedAt?: string;
}

/** Git's answer is kept this long before a reload asks again. */
const GIT_MAX_AGE_MS = 60_000;
/** After a failed inspection, Git is asked again after these delays, then left until a reload. */
const GIT_RETRY_DELAYS_MS = [1_000, 4_000, 15_000] as const;

/**
 * The birth time Node reports: null when the file system keeps none (0), and
 * `certain: false` when it equals the change time. That is libuv's fallback
 * where there is no birth time, but also what Linux reports for a file written
 * in one go and never changed since (its timestamps are coarse), so it is
 * never used as a creation date: Git must supply one instead.
 */
/** Milliseconds as Node's plain `stat` dates them (rounded), so dates agree with `stat().mtime`. */
const msOf = (ns: bigint): number => Math.round(Number(ns / 1_000_000_000n) * 1000 + Number(ns % 1_000_000_000n) / 1e6);

export function birthTime(stat: {
  readonly birthtimeNs: bigint;
  readonly ctimeNs: bigint;
}): { readonly at: string; readonly certain: boolean } | null {
  if (stat.birthtimeNs <= 0n) return null;
  return { at: new Date(msOf(stat.birthtimeNs)).toISOString(), certain: stat.birthtimeNs !== stat.ctimeNs };
}

const sameDates = (a: ReadonlyMap<string, string> | null, b: ReadonlyMap<string, string> | null): boolean =>
  (a?.size ?? 0) === (b?.size ?? 0) && [...(a ?? [])].every(([path, date]) => b?.get(path) === date);

export class FileDateBook {
  /** Folder-relative path to first-add date; null until Git has been asked, or when it cannot be. */
  #added: Map<string, string> | null = null;
  #askedAt = 0;
  #asking: Promise<void> | null = null;
  /** Consecutive failed inspections, and the timer that asks again after one. */
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  /** For tests: how many times Git was asked. */
  inspections = 0;

  constructor(
    private project: Project,
    private readonly stat: typeof statSync = statSync,
  ) {}

  /** The dates of the file at `path` (folder-relative), from the file system and what Git last said. */
  of(path: string): FileDates {
    let stat;
    try {
      stat = this.stat(resolveInFolder(this.project, path), { bigint: true });
    } catch {
      return {};
    }
    if (stat === undefined) return {};
    const modifiedAt = new Date(msOf(stat.mtimeNs)).toISOString();
    const born = birthTime(stat);
    if (born?.certain === true) return { createdAt: born.at, createdFrom: "filesystem", modifiedAt };
    const added = this.#added?.get(path);
    if (added !== undefined) return { createdAt: new Date(added).toISOString(), createdFrom: "git", modifiedAt };
    return { modifiedAt };
  }

  /**
   * Asks Git again, in the background, when one of `paths` has no certain
   * birth time and Git's answer is missing or over a minute old; `learned` is
   * called when its answer changed a date. A reload never waits on Git: it
   * publishes what the file system says, and the dates follow. The promise is
   * for tests; it never rejects.
   */
  refresh(project: Project, paths: readonly string[], learned: () => void = () => {}): Promise<void> {
    this.project = project;
    const fresh = this.#added !== null && Date.now() - this.#askedAt < GIT_MAX_AGE_MS;
    if (fresh || this.#asking !== null) return this.#asking ?? Promise.resolve();
    return this.#start(project, paths, learned);
  }

  #start(project: Project, paths: readonly string[], learned: () => void): Promise<void> {
    if (this.#asking !== null) return this.#asking;
    const needed = paths.some((path) => {
      try {
        return birthTime(this.stat(resolveInFolder(project, path), { bigint: true })!)?.certain !== true;
      } catch {
        return false;
      }
    });
    if (!needed) return Promise.resolve();
    const before = this.#added;
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#retry = null;
    this.#asking = this.#ask(project).then((answered) => {
      this.#asking = null;
      if (answered) this.#failures = 0;
      else if (!this.#closed && this.#failures < GIT_RETRY_DELAYS_MS.length) {
        // A reload within the minute does not ask again; this timer does.
        this.#retry = setTimeout(
          () => {
            this.#retry = null;
            if (!this.#closed) void this.#start(this.project, paths, learned);
          },
          GIT_RETRY_DELAYS_MS[this.#failures++],
        );
        this.#retry.unref?.();
      }
      if (!sameDates(before, this.#added)) {
        try {
          learned();
        } catch {
          /* A publication failure must not reject this background refresh. */
        }
      }
    });
    return this.#asking;
  }

  /** Stops asking Git again after a failure; for a project that is detached. */
  close(): void {
    this.#closed = true;
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#retry = null;
  }

  /** Whether Git answered. A failed inspection keeps the last answer (none at first). */
  async #ask(project: Project): Promise<boolean> {
    this.inspections++;
    this.#askedAt = Date.now();
    const folder = project.folderSetting.replace(/^\.\/+/, "").replace(/\/+$/, "");
    const inProject = folder === "" || folder === ".";
    try {
      const inside = await GitRepository.workTree(project.root);
      if (inside === null) throw new Error("Git could not run");
      if (!inside) {
        this.#added = new Map();
        return true;
      }
      const git = await GitRepository.open(project.root);
      const added = await git.firstAdded(inProject ? "" : folder);
      const byFolder = new Map<string, string>();
      for (const [path, date] of added) {
        if (inProject) byFolder.set(path, date);
        else if (path.startsWith(`${folder}/`)) byFolder.set(path.slice(folder.length + 1), date);
      }
      this.#added = byFolder;
      return true;
    } catch {
      // Git could not answer (it timed out on a loaded machine, or could not
      // run): no new dates from it, and asked again shortly.
      this.#added ??= new Map();
      return false;
    }
  }
}
