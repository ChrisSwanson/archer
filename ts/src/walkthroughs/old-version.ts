// The source a walkthrough was written on (ADR 0034 §3): the recorded `commit` when its blob hashes to the
// walkthrough's `modelRevision`; else the file's last MAX_SEARCH_COMMITS commits, newest first, for one that
// does; else "not in Git history". Git trouble of any kind (no repository, a shallow clone, a deleted file)
// is the same answer, never an error: the walkthrough is then shown as text only.
import {
  blobLimitFor,
  compileAt,
  revisionAt,
  revisionOfBlob,
  type HistoricalDiagram,
  type HistoricalPlace,
} from "../accuracy/history.ts";
import { AccuracyError } from "../accuracy/errors.ts";
import { GitRepository } from "../accuracy/git.ts";
import type { Project } from "../project/index.ts";
import { COMMIT_ID } from "./contract.ts";

export const MAX_SEARCH_COMMITS = 200;

/** The view whose walkthrough is opened: its id and where its source is now (folder-relative). */
export interface OldVersionPlace extends HistoricalPlace {
  readonly viewId: string;
}

export type OldVersion =
  | {
      readonly status: "found";
      readonly how: "recorded" | "search";
      readonly commit: string;
      readonly committedAt: string;
      readonly diagram: Exclude<HistoricalDiagram, { status: "unavailable" }>;
    }
  | { readonly status: "not-in-history"; readonly reason: "not_found" | "git_unavailable" };

export async function findOldVersion(
  project: Project,
  place: OldVersionPlace,
  walkthrough: { readonly modelRevision: string; readonly commit?: string },
): Promise<OldVersion> {
  const lost = (reason: "not_found" | "git_unavailable"): OldVersion => ({ status: "not-in-history", reason });
  try {
    const git = await GitRepository.open(project.root);
    // The folder is the project's now: `place.path` is relative to it.
    const folderSetting = project.folderSetting;
    const found = async (
      how: "recorded" | "search",
      commit: string,
      committedAt: string,
    ): Promise<OldVersion | null> => {
      const diagram = await compileAt(git, folderSetting, commit, place, place.viewId);
      return diagram.status === "unavailable" ? null : { status: "found", how, commit, committedAt, diagram };
    };
    if (walkthrough.commit !== undefined && COMMIT_ID.test(walkthrough.commit)) {
      try {
        const commit = await git.commit(walkthrough.commit);
        if ((await revisionAt(git, folderSetting, commit, place)) === walkthrough.modelRevision) {
          const hit = await found("recorded", commit, await git.committedAt(commit));
          if (hit !== null) return hit;
        }
      } catch {
        // An unknown or unreadable commit only means the search runs.
      }
    }
    const path = posix(folderSetting, place.path);
    const versions = await git.fileVersions(path, MAX_SEARCH_COMMITS);
    const limit = blobLimitFor(place);
    // A blob's revision is worked out once, from contents fetched in batches that grow as the search goes on:
    // a match near the top costs one small batch, a long search a few large ones.
    const revisions = new Map<string, string | null>();
    const sizes = await git.blobSizes([
      ...new Set(versions.flatMap((v) => (typeof v.oid === "string" ? [v.oid] : []))),
    ]);
    let batch = 8;
    const revisionOfOid = async (from: number, oid: string): Promise<string | null> => {
      if (!revisions.has(oid)) {
        const wanted = new Set<string>();
        for (let j = from; j < versions.length && wanted.size < batch; j++) {
          const next = versions[j]!.oid;
          if (typeof next === "string" && !revisions.has(next)) wanted.add(next);
        }
        batch = Math.min(batch * 2, 64);
        // A blob too large or missing has no revision to match; it is not the end of the search.
        const fetch = [...wanted].filter((id) => {
          const size = sizes.get(id);
          if (size === null || size === undefined || size > limit) {
            revisions.set(id, null);
            return false;
          }
          return true;
        });
        for (const [id, bytes] of await git.blobContents(fetch, sizes, limit))
          revisions.set(id, revisionOfBlob(place, bytes));
      }
      return revisions.get(oid) ?? null;
    };
    for (const [i, { commit, committedAt, oid }] of versions.entries()) {
      try {
        let revision: string | null;
        if (oid === null) continue;
        if (oid === undefined) revision = await revisionAt(git, folderSetting, commit, place);
        else revision = await revisionOfOid(i, oid);
        if (revision === walkthrough.modelRevision) {
          const hit = await found("search", commit, committedAt);
          if (hit !== null) return hit;
        }
      } catch (error) {
        // One version that cannot be read (a link, a bad merge entry) is not the end of the search; the Git budget is.
        if (error instanceof AccuracyError && error.code === "accuracy_limit") throw error;
      }
    }
    return lost("not_found");
  } catch {
    return lost("git_unavailable");
  }
}

const posix = (folder: string, path: string): string => `${folder}/${path}`;
