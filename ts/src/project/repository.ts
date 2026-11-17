/**
 * A project's git repository, for its default name. When archer.toml gives no `name`, a
 * project is named after its repository; a linked worktree (`git worktree add`) is named
 * after the main repository, and keeps its own folder and branch as a detail. Read from the
 * worktree's small git files (`.git`, `commondir`, `HEAD`), without running git: bounded
 * reads, and anything unexpected means "no repository", so the folder name is used.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface RepositoryIdentity {
  /** The repository's name: its main checkout's folder, or a bare repository's without `.git`. */
  readonly name: string;
  /** The real path of the git directory every worktree of the repository shares. */
  readonly commonDir: string;
  /** Present for a linked worktree: its own folder name and checked-out branch. */
  readonly worktree?: { readonly folder: string; readonly branch?: string };
}

const MAX_GIT_FILE = 4096;
/** The most characters of a worktree's folder or branch the catalog carries (the page's bound). */
const MAX_DETAIL = 255;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const CONTROLS = /[\u0000-\u001f\u007f]/gu;

/** The repository whose checkout `root` is, or null when `root` holds no readable `.git`. */
export function repositoryOf(root: string): RepositoryIdentity | null {
  try {
    const dotGit = join(root, ".git");
    const info = lstatSync(dotGit);
    if (info.isDirectory()) return { name: basename(root), commonDir: realpathSync(dotGit) };
    if (!info.isFile()) return null;
    const line = small(dotGit);
    const target = line === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(line)?.[1];
    if (target === undefined || target === null) return null;
    const gitDir = realpathSync(resolve(root, target));
    if (!lstatSync(gitDir).isDirectory()) return null;
    const common = optional(join(gitDir, "commondir"));
    // No commondir: the folder's own repository kept elsewhere (a submodule, --separate-git-dir).
    if (common === null) return { name: basename(root), commonDir: gitDir };
    const commonDir = realpathSync(resolve(gitDir, common.trim()));
    if (!isAbsolute(commonDir) || !lstatSync(commonDir).isDirectory()) return null;
    const name =
      basename(commonDir) === ".git" ? basename(dirname(commonDir)) : basename(commonDir).replace(/\.git$/, "");
    if (name === "") return null;
    const head = optional(join(gitDir, "HEAD"));
    const ref = head === null ? undefined : /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head)?.[1];
    // Shown in every reader's project list: a branch the page could not show is left out, a folder bounded.
    const branch = ref !== undefined && ref.length <= MAX_DETAIL && !CONTROL.test(ref) ? ref : undefined;
    const folder =
      [...basename(root).replace(CONTROLS, "")].slice(0, MAX_DETAIL).join("").slice(0, MAX_DETAIL) || "worktree";
    return { name, commonDir, worktree: { folder, ...(branch === undefined ? {} : { branch }) } };
  } catch {
    return null;
  }
}

/** What a project is called: archer.toml's `name`, else its repository's, else its folder's. */
export function projectDisplayName(
  project: { readonly root: string; readonly name?: string },
  repository = repositoryOf(project.root),
): string {
  return project.name ?? repository?.name ?? basename(project.root);
}

/** A small file's text, or null when absent; refuses links, non-files and oversized files. */
function optional(path: string): string | null {
  try {
    lstatSync(path);
  } catch (failure) {
    if ((failure as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw failure;
  }
  const text = small(path);
  if (text === null) throw new Error("unreadable git file");
  return text;
}

function small(path: string): string | null {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_GIT_FILE) return null;
    const bytes = Buffer.alloc(info.size);
    let used = 0;
    while (used < bytes.length) {
      const amount = readSync(fd, bytes, used, bytes.length - used, used);
      if (amount === 0) break;
      used += amount;
    }
    return bytes.subarray(0, used).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
