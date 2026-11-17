import { posix } from "node:path";
import { revisionOf, type Project } from "../project/index.ts";
import { coveredBy, coveragePatterns, coverageRoots } from "./coverage.ts";
import { AccuracyError } from "./errors.ts";
import { GitRepository, MAX_ACCURACY_FILES, MAX_CODE_FILE_BYTES } from "./git.ts";
export type StaleStatus = "current" | "stale" | "not-covered" | "never-reviewed" | "unavailable";
export interface CoveredChange {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
}
export interface DiagramStaleness {
  readonly viewId: string;
  readonly covers: readonly string[];
  readonly status: StaleStatus;
  readonly baselineCommit: string | null;
  readonly changedPaths: readonly CoveredChange[];
  readonly reason?: string;
}
export interface StaleDiagramsResult {
  readonly status: "available" | "unavailable";
  readonly views: readonly DiagramStaleness[];
  readonly reason?: string;
}
export async function listStaleDiagrams(
  project: Project,
  options: {
    viewId?: string;
  } = {},
): Promise<StaleDiagramsResult> {
  const views = project.views.filter((view) => options.viewId === undefined || view.id === options.viewId);
  if (options.viewId !== undefined && views.length === 0)
    throw new AccuracyError("historical_view_unavailable", "the requested view is not registered in this project");
  let git: GitRepository;
  try {
    git = await GitRepository.open(project.root);
  } catch (error) {
    if (!(error instanceof AccuracyError) || error.code !== "git_unavailable") throw error;
    return {
      status: "unavailable",
      reason: "git_unavailable",
      views: views.map((view) => ({
        viewId: view.id,
        covers: view.covers ?? [],
        status: "unavailable",
        baselineCommit: null,
        changedPaths: [],
        reason: "git_unavailable",
      })),
    };
  }
  const results: DiagramStaleness[] = [];
  for (const view of views) {
    const covers = coveragePatterns(view.covers ?? []);
    const base = { viewId: view.id, covers, baselineCommit: null, changedPaths: [] };
    if (covers.length === 0) {
      results.push({ ...base, status: "not-covered" });
      continue;
    }
    try {
      const baselineCommit = await git.baseline(posix.join(project.folderSetting, view.source));
      if (baselineCommit === null) {
        results.push({ ...base, status: "never-reviewed", reason: "diagram_has_no_git_commit" });
        continue;
      }
      const roots = coverageRoots(covers);
      const old = new Map(
        (await git.tree(baselineCommit, roots))
          .filter((entry) => coveredBy(entry.path, covers))
          .map((entry) => [entry.path, entry]),
      );
      const now = (await git.workingPaths(roots)).filter((path) => coveredBy(path, covers));
      const candidates = [...new Set([...old.keys(), ...now])].sort();
      if (candidates.length > MAX_ACCURACY_FILES)
        throw new AccuracyError("accuracy_limit", "too many covered files for accuracy inspection");
      const changedPaths: CoveredChange[] = [];
      for (const path of candidates) {
        const before = old.get(path);
        if (before !== undefined && (before.type !== "blob" || !["100644", "100755"].includes(before.mode)))
          throw new AccuracyError("accuracy_path_refused", "covered history may not contain links or submodules");
        const current = git.workingBytes(path);
        if (before === undefined) {
          if (current !== null) changedPaths.push({ path, status: "added" });
        } else if (current === null) changedPaths.push({ path, status: "deleted" });
        else if (
          before.mode !== current.mode ||
          revisionOf(await git.blob(before, MAX_CODE_FILE_BYTES)) !== revisionOf(current.bytes)
        )
          changedPaths.push({ path, status: "modified" });
      }
      results.push({
        viewId: view.id,
        covers,
        status: changedPaths.length === 0 ? "current" : "stale",
        baselineCommit,
        changedPaths,
      });
    } catch (error) {
      if (!(error instanceof AccuracyError)) throw error;
      results.push({ ...base, status: "unavailable", reason: error.code });
    }
  }
  return { status: "available", views: results };
}
