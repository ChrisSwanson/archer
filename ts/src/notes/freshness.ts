// How fresh a note is: the last commit that touched it, and whether it has
// changed since (docs/proposals/notes-with-embedded-diagrams.md, decision 6).
// Its embedded diagrams share the note's answer. Not staleness: no `covers`,
// no baseline, only how old the words on the page are.
//
// Git runs through the accuracy tools' bounded, argv-only helper
// (`GitRepository`), never per render: an answer is kept for the note's
// revision and the repository's state -- HEAD's file and what it names (the
// branch's ref file or packed-refs), the index and HEAD's log, which every
// commit, reset, checkout and `git add` moves -- for at most a minute, and
// concurrent askers share one inspection.
//
// "Uncommitted changes" compares the note's bytes with its blob at HEAD
// (`cat-file`), never `git status`: status may run a repository's clean
// filters, which are commands. A repository that converts line endings or
// filters Markdown on commit therefore reads as changed.
import { readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { AccuracyError } from "../accuracy/errors.ts";
import { GitRepository, MAX_CODE_FILE_BYTES } from "../accuracy/git.ts";
import { revisionOf, type Project } from "../project/index.ts";
import { readNoteBytes } from "./embedded.ts";

import type { NoteFreshness } from "../comments/contract.ts";

export type Freshness = NoteFreshness;

/** No answer is kept longer than this, in case a change to the repository moved none of the stamps. */
const MAX_AGE_MS = 60_000;

/** How long "not in Git" (or "Git cannot run") is believed before Git is asked again. */
const RECHECK_MS = 30_000;

/** At most this many answers are kept; the oldest go first. */
const MAX_CACHED = 512;

const stampOf = (path: string): string => {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "-";
  }
};

export class FreshnessCache {
  /** How many times Git was asked about a note: for tests and the log. */
  inspections = 0;
  readonly #answers = new Map<string, Promise<Freshness>>();
  /** The Git directories; "none" outside a work tree; null when Git cannot run. */
  #gitDir: Promise<{ gitDir: string; commonDir: string } | "none" | null> | undefined;
  #retryAt = 0;

  constructor(private readonly project: Project) {}

  /** The repository's state, "none" outside Git, or null when Git cannot be asked. */
  async #repositoryStamp(): Promise<string | "none" | null> {
    this.#gitDir ??= (async () => {
      try {
        const inside = await GitRepository.workTree(this.project.root);
        if (inside !== true) return inside === false ? "none" : null;
        return await (await GitRepository.open(this.project.root)).gitDirs();
      } catch {
        return null;
      }
    })();
    const dir = await this.#gitDir;
    // Asked again after a while: a project can become a repository, and Git may have been busy.
    if ((dir === null || dir === "none") && this.#retryAt === 0) {
      this.#retryAt = Date.now() + RECHECK_MS;
    } else if ((dir === null || dir === "none") && Date.now() >= this.#retryAt) {
      this.#gitDir = undefined;
      this.#retryAt = 0;
    }
    if (dir === null || dir === "none") return dir;
    let head = "";
    try {
      head = readFileSync(join(dir.gitDir, "HEAD"), "utf8").slice(0, 512).trim();
    } catch {
      // No HEAD file: the stamps below still move.
    }
    const ref = /^ref: (refs\/[^\0\n]+)$/.exec(head)?.[1];
    const named = ref === undefined || ref.split("/").includes("..") ? [] : [stampOf(join(dir.commonDir, ref))];
    return [
      head,
      ...named,
      stampOf(join(dir.commonDir, "packed-refs")),
      ...["index", "logs/HEAD"].map((f) => stampOf(join(dir.gitDir, f))),
      Math.floor(Date.now() / MAX_AGE_MS),
    ].join("|");
  }

  /** The freshness of the note at `notePath` (folder-relative). */
  async of(notePath: string): Promise<Freshness> {
    const bytes = readNoteBytes(this.project, notePath);
    if (bytes === null) return { status: "unavailable", reason: "note_not_found" };
    const revision = revisionOf(bytes);
    const stamp = await this.#repositoryStamp();
    if (stamp === "none") return { status: "not-in-git" };
    if (stamp === null) return { status: "unavailable", reason: "git_unavailable" };
    const key = `${notePath}\0${revision}\0${stamp}`;
    const held = this.#answers.get(key);
    if (held !== undefined) return held;
    const answer = this.#inspect(notePath, bytes);
    this.#answers.set(key, answer);
    if (this.#answers.size > MAX_CACHED) this.#answers.delete(this.#answers.keys().next().value!);
    // A failed inspection is not kept: the next asker tries again.
    void answer.then((a) => {
      if (a.status === "unavailable") this.#answers.delete(key);
    });
    return answer;
  }

  async #inspect(notePath: string, bytes: Buffer): Promise<Freshness> {
    this.inspections++;
    const path = posix.join(this.project.folderSetting, notePath);
    try {
      const git = await GitRepository.open(this.project.root);
      const last = await git.lastCommit(path);
      if (last === null) return { status: "never-committed" };
      const entry = await git.entry(await git.commit("HEAD"), path);
      const committed =
        entry === null || entry.size > MAX_CODE_FILE_BYTES ? null : await git.blob(entry, MAX_CODE_FILE_BYTES);
      return { status: "committed", ...last, uncommitted: committed === null || !committed.equals(bytes) };
    } catch (error) {
      return { status: "unavailable", reason: error instanceof AccuracyError ? error.code : "git_unavailable" };
    }
  }
}

/** Freshness in one line, for an agent. */
export function freshnessLine(freshness: Freshness): string {
  switch (freshness.status) {
    case "committed":
      return `last committed in ${freshness.commit} on ${freshness.committedAt}${freshness.uncommitted ? ", with uncommitted changes since" : ""}`;
    case "never-committed":
      return "never committed";
    case "not-in-git":
      return "Not in Git (the project is not in a Git repository)";
    default:
      return `commit history unavailable (${freshness.reason})`;
  }
}
