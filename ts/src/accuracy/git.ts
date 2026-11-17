import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { AccuracyError } from "./errors.ts";
import { ConfinedRefusal, ConfinedTooLarge, readConfinedFile } from "../project/confined-fs.ts";
export const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_ACCURACY_FILES = 4096;
export const MAX_CODE_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_ACCURACY_BYTES = 32 * 1024 * 1024;
export const GIT_TIMEOUT_MS = 10000;
export const ACCURACY_TIMEOUT_MS = 30000;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export function gitRef(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*(?:[~^][0-9]*)*$/.test(raw) ||
    raw.includes("..") ||
    raw.includes("//") ||
    raw.endsWith("/")
  )
    throw new AccuracyError(
      "invalid_git_ref",
      "name one Git commit, branch or tag; revision ranges, reflog expressions and options are not accepted",
    );
  return raw;
}
export function safeRelativePath(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > 1024 ||
    raw.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(raw) ||
    isAbsolute(raw) ||
    /^[A-Za-z]:/.test(raw)
  )
    throw new AccuracyError("accuracy_path_refused", "accuracy paths must be relative plain paths inside the project");
  const parts = raw.split("/");
  if (
    parts.length > 64 ||
    parts.some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git")
  )
    throw new AccuracyError(
      "accuracy_path_refused",
      "accuracy paths must stay inside the project and avoid Git metadata",
    );
  return raw;
}
export interface GitEntry {
  readonly path: string;
  readonly oid: string;
  readonly size: number;
  readonly mode: string;
  readonly type: string;
}
/** Every Git call is argv-only, bounded, local and stripped of caller Git overrides. */
export class GitRepository {
  readonly #expires = Date.now() + ACCURACY_TIMEOUT_MS;
  #bytes = 0;
  private constructor(
    readonly root: string,
    readonly projectRoot: string,
    readonly prefix: string,
  ) {}
  static async open(projectRoot: string): Promise<GitRepository> {
    const canonical = realpathSync(projectRoot);
    const provisional = new GitRepository(canonical, canonical, "");
    const root = realpathSync(
      (await provisional.command(["rev-parse", "--show-toplevel"], 4096)).toString("utf8").trim(),
    );
    const prefix = relative(root, canonical).split(sep).join("/");
    if (prefix.startsWith("../") || prefix === ".." || isAbsolute(prefix))
      throw new AccuracyError("accuracy_path_refused", "the Git repository does not contain this project");
    return new GitRepository(root, canonical, prefix);
  }
  /** Whether `projectRoot` is in a Git work tree: true, false, or null when Git itself cannot run. */
  static async workTree(projectRoot: string): Promise<boolean | null> {
    const canonical = realpathSync(projectRoot);
    const probe = new GitRepository(canonical, canonical, "");
    try {
      return (await probe.command(["rev-parse", "--is-inside-work-tree"], 64)).toString("utf8").trim() === "true";
    } catch {
      try {
        await new GitRepository(canonical, canonical, "").command(["--version"], 256);
        return false;
      } catch {
        return null;
      }
    }
  }
  projectPath(path: string): string {
    const valid = safeRelativePath(path);
    return this.prefix === "" ? valid : `${this.prefix}/${valid}`;
  }
  localPath(path: string): string {
    const value =
      this.prefix === "" ? path : path.startsWith(`${this.prefix}/`) ? path.slice(this.prefix.length + 1) : "";
    return safeRelativePath(value);
  }
  checkDeadline(): void {
    if (Date.now() >= this.#expires)
      throw new AccuracyError("accuracy_limit", "accuracy inspection exceeded its time limit");
  }
  takeBytes(count: number): void {
    this.#bytes += count;
    if (this.#bytes > MAX_ACCURACY_BYTES)
      throw new AccuracyError("accuracy_limit", "accuracy inspection exceeded its total byte limit");
  }
  async commit(ref: unknown): Promise<string> {
    const value = gitRef(ref);
    try {
      const commit = (await this.command(["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`], 128))
        .toString("ascii")
        .trim();
      if (!OID.test(commit)) throw new AccuracyError("invalid_git_ref", "Git did not identify one full commit");
      return commit;
    } catch (error) {
      if (error instanceof AccuracyError && error.code === "git_unavailable")
        throw new AccuracyError("invalid_git_ref", "the requested Git revision does not identify a commit");
      throw error;
    }
  }
  async baseline(path: string): Promise<string | null> {
    let head: string;
    try {
      head = await this.commit("HEAD");
    } catch (error) {
      if (error instanceof AccuracyError && error.code === "invalid_git_ref") return null;
      throw error;
    }
    const commit = (
      await this.command(["log", "--follow", "-1", "--format=%H", head, "--", this.projectPath(path)], 128)
    )
      .toString("ascii")
      .trim();
    return commit === ""
      ? null
      : OID.test(commit)
        ? commit
        : (() => {
            throw new AccuracyError("git_unavailable", "Git returned an invalid baseline commit");
          })();
  }
  /** The checked-out branch (absent when detached) and Git's short commit; null before the first commit. */
  async head(): Promise<{ branch?: string; commit: string } | null> {
    let commit: string;
    try {
      commit = (await this.command(["rev-parse", "--short", "--verify", "-q", "HEAD^{commit}"], 128))
        .toString("ascii")
        .trim();
    } catch (error) {
      if (error instanceof AccuracyError && error.code === "git_unavailable") return null; // no commit yet
      throw error;
    }
    if (!/^[a-f0-9]{4,64}$/.test(commit))
      throw new AccuracyError("git_unavailable", "Git returned an invalid short commit");
    let branch: string | undefined;
    try {
      const name = (await this.command(["symbolic-ref", "-q", "--short", "HEAD"], 512)).toString("utf8").trim();
      // A branch name is shown, never interpreted: bounded, with no control characters.
      if (name !== "" && name.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(name)) branch = name;
    } catch (error) {
      if (!(error instanceof AccuracyError && error.code === "git_unavailable")) throw error; // detached HEAD: symbolic-ref exits 1
    }
    return branch === undefined ? { commit } : { branch, commit };
  }
  /** The repository's Git directory, absolute (a worktree's own), and the common one its refs are in. */
  async gitDirs(): Promise<{ gitDir: string; commonDir: string }> {
    const [gitDir, common] = (await this.command(["rev-parse", "--absolute-git-dir", "--git-common-dir"], 8192))
      .toString("utf8")
      .trim()
      .split("\n");
    return { gitDir: realpathSync(gitDir!), commonDir: realpathSync(resolve(this.root, common ?? gitDir!)) };
  }
  /** The last commit on HEAD that touched `path` (project-relative): its short hash and committer date, or null. */
  async lastCommit(path: string): Promise<{ commit: string; committedAt: string } | null> {
    try {
      await this.commit("HEAD");
    } catch (error) {
      if (error instanceof AccuracyError && error.code === "invalid_git_ref") return null;
      throw error;
    }
    const row = (await this.command(["log", "-1", "--format=%h%x00%cI", "HEAD", "--", this.projectPath(path)], 512))
      .toString("utf8")
      .trim();
    if (row === "") return null;
    const [commit, committedAt] = row.split("\0");
    if (!/^[a-f0-9]{4,64}$/.test(commit ?? "") || !/^\d{4}-\d\d-\d\dT/.test(committedAt ?? ""))
      throw new AccuracyError("git_unavailable", "Git returned an invalid commit line");
    return { commit: commit!, committedAt: committedAt! };
  }
  /** The commit's committer date (ISO 8601). */
  async committedAt(commit: string): Promise<string> {
    if (!OID.test(commit)) throw new AccuracyError("invalid_git_ref", "date reads require a resolved commit");
    const date = (await this.command(["log", "-1", "--format=%cI", commit], 128)).toString("ascii").trim();
    if (!/^\d{4}-\d\d-\d\dT/.test(date))
      throw new AccuracyError("git_unavailable", "Git returned an invalid commit date");
    return date;
  }
  /** The newest `limit` commits on HEAD that touched `path` (project-relative), newest first, with their dates; empty before the first commit. */
  async fileHistory(path: string, limit: number): Promise<{ commit: string; committedAt: string }[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new AccuracyError("accuracy_limit", "invalid Git history limit");
    let head: string;
    try {
      head = await this.commit("HEAD");
    } catch (error) {
      if (error instanceof AccuracyError && error.code === "invalid_git_ref") return [];
      throw error;
    }
    const rows = (
      await this.command([
        "log",
        `-n${limit}`,
        "--no-renames",
        "--format=%H%x00%cI",
        head,
        "--",
        this.projectPath(path),
      ])
    )
      .toString("utf8")
      .split("\n")
      .filter(Boolean);
    return rows.map((row) => {
      const [commit, committedAt] = row.split("\0");
      if (!OID.test(commit ?? "") || !/^\d{4}-\d\d-\d\dT/.test(committedAt ?? ""))
        throw new AccuracyError("git_unavailable", "Git returned an invalid history line");
      return { commit: commit!, committedAt: committedAt! };
    });
  }
  /**
   * The newest `limit` commits on HEAD that touched `path`, each with the blob id the file has there, from one
   * `log --raw`: a plain file's id; null when the commit removed it or made it a link or submodule; undefined when
   * the log did not say (a merge), so the caller reads the entry itself.
   */
  async fileVersions(
    path: string,
    limit: number,
  ): Promise<{ commit: string; committedAt: string; oid: string | null | undefined }[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new AccuracyError("accuracy_limit", "invalid Git history limit");
    let head: string;
    try {
      head = await this.commit("HEAD");
    } catch (error) {
      if (error instanceof AccuracyError && error.code === "invalid_git_ref") return [];
      throw error;
    }
    const text = (
      await this.command([
        "log",
        `-n${limit}`,
        "--no-renames",
        "--raw",
        "--no-abbrev",
        "--format=%x01%H%x00%cI",
        head,
        "--",
        this.projectPath(path),
      ])
    ).toString("utf8");
    return text
      .split("\x01")
      .filter(Boolean)
      .map((block) => {
        const [header = "", ...rest] = block.split("\n");
        const [commit, committedAt] = header.split("\0");
        if (!OID.test(commit ?? "") || !/^\d{4}-\d\d-\d\dT/.test(committedAt ?? ""))
          throw new AccuracyError("git_unavailable", "Git returned an invalid history line");
        const raw = rest.find((line) => line.startsWith(":"));
        const fields = raw?.split("\t")[0]?.split(" ");
        const oid =
          fields === undefined
            ? undefined
            : ["100644", "100755"].includes(fields[1] ?? "") && /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(fields[3] ?? "")
              ? fields[3]!
              : null;
        return { commit: commit!, committedAt: committedAt!, oid };
      });
  }
  /** The sizes of blobs by id (one `cat-file --batch-check`); null for an id that is missing or not a blob. */
  async blobSizes(oids: readonly string[]): Promise<Map<string, number | null>> {
    const sizes = new Map<string, number | null>();
    if (oids.length === 0) return sizes;
    if (!oids.every((oid) => OID.test(oid)))
      throw new AccuracyError("invalid_git_ref", "blob reads require resolved object IDs");
    const out = (await this.command(["cat-file", "--batch-check"], oids.length * 160 + 1024, `${oids.join("\n")}\n`))
      .toString("ascii")
      .split("\n")
      .filter(Boolean);
    if (out.length !== oids.length)
      throw new AccuracyError("git_unavailable", "Git returned an invalid object listing");
    out.forEach((line, i) => {
      const match = /^[a-f0-9]+ blob (\d+)$/.exec(line);
      sizes.set(oids[i]!, match === null ? null : Number(match[1]));
    });
    return sizes;
  }
  /** The contents of blobs of the given sizes (from blobSizes, each within `limit`) by id, in one `cat-file --batch`; every byte is counted against the budget. */
  async blobContents(
    oids: readonly string[],
    sizes: ReadonlyMap<string, number | null>,
    limit: number,
  ): Promise<Map<string, Buffer>> {
    const contents = new Map<string, Buffer>();
    if (oids.length === 0) return contents;
    let total = 0;
    for (const oid of oids) {
      const size = sizes.get(oid);
      if (!OID.test(oid) || size === null || size === undefined || size > limit || limit > MAX_CODE_FILE_BYTES)
        throw new AccuracyError("accuracy_limit", "a Git blob exceeds its byte limit");
      this.takeBytes(size);
      total += size;
    }
    const out = await this.command(["cat-file", "--batch"], total + oids.length * 160 + 1024, `${oids.join("\n")}\n`);
    let at = 0;
    for (const oid of oids) {
      const end = out.indexOf(10, at);
      const match = end < 0 ? null : /^([a-f0-9]+) blob (\d+)$/.exec(out.toString("ascii", at, end));
      if (match === null || match[1] !== oid || Number(match[2]) !== sizes.get(oid))
        throw new AccuracyError("git_unavailable", "Git blob size changed or was inconsistent");
      const size = Number(match[2]);
      contents.set(oid, out.subarray(end + 1, end + 1 + size));
      at = end + 1 + size + 1;
    }
    return contents;
  }
  /**
   * When each file under `dir` (project-relative; "" is the whole project) was
   * first added on HEAD: project-relative path to committer date (ISO 8601).
   * One bounded `log` for the whole directory. Renames read as adds
   * (`--no-renames`), so a moved file is dated by the commit that gave it its
   * present path. Empty when HEAD has no commits.
   */
  async firstAdded(dir: string): Promise<Map<string, string>> {
    try {
      await this.commit("HEAD");
    } catch (error) {
      if (error instanceof AccuracyError && error.code === "invalid_git_ref") return new Map();
      throw error;
    }
    const scope = this.scopes([dir]);
    const out = (
      await this.command([
        "log",
        "--no-renames",
        "--diff-filter=A",
        "--format=%x01%cI",
        "--name-only",
        "-z",
        "HEAD",
        "--",
        ...(scope.length === 0 ? ["."] : scope),
      ])
    ).toString("utf8");
    const added = new Map<string, string>();
    // `\x01<date>\0\n<path>\0<path>\0...`, newest commit first: an older add of
    // the same path (deleted, then added again) overwrites, so the first add wins.
    for (const block of out.split("\x01")) {
      const [date, ...names] = block.split("\0");
      if (date === undefined || !/^\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d)$/.test(date)) continue;
      for (const raw of names) {
        const name = raw.replace(/^\n+/, "");
        if (name === "") continue;
        try {
          added.set(this.localPath(name), date);
        } catch {
          // Outside the project, or spelled in a way Archer refuses: no date.
        }
      }
    }
    return added;
  }
  async tree(commit: string, path?: string | readonly string[]): Promise<GitEntry[]> {
    if (!OID.test(commit)) throw new AccuracyError("invalid_git_ref", "tree reads require a resolved commit");
    const scoped = this.scopes(path === undefined ? [""] : typeof path === "string" ? [path] : path);
    const bytes = await this.command([
      "ls-tree",
      "-r",
      "-l",
      "-z",
      "--full-tree",
      commit,
      ...(scoped.length === 0 ? [] : ["--", ...scoped]),
    ]);
    const rows = nulRows(bytes);
    if (rows.length > MAX_ACCURACY_FILES)
      throw new AccuracyError("accuracy_limit", "the project tree has too many files for accuracy inspection");
    return rows.map((row) => {
      const match = /^(\d{6}) ([a-z]+) ([a-f0-9]{40}|[a-f0-9]{64}) +([0-9]+|-)\t([\s\S]+)$/.exec(row);
      if (!match) throw new AccuracyError("git_unavailable", "Git returned an invalid tree entry");
      return {
        path: this.localPath(match[5]!),
        oid: match[3]!,
        mode: match[1]!,
        type: match[2]!,
        size: match[4] === "-" ? 0 : Number(match[4]),
      };
    });
  }
  async entry(commit: string, path: string): Promise<GitEntry | null> {
    const entries = await this.tree(commit, path);
    return entries.find((entry) => entry.path === path) ?? null;
  }
  async blob(entry: GitEntry, limit: number): Promise<Buffer> {
    if (!OID.test(entry.oid)) throw new AccuracyError("invalid_git_ref", "blob reads require one resolved object ID");
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_CODE_FILE_BYTES)
      throw new AccuracyError("accuracy_limit", "invalid Git blob byte limit");
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      throw new AccuracyError(
        "accuracy_path_refused",
        "Git accuracy reads only plain file blobs, never links or submodules",
      );
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limit)
      throw new AccuracyError("accuracy_limit", "a Git blob exceeds its byte limit");
    this.takeBytes(entry.size);
    const bytes = await this.command(["cat-file", "blob", entry.oid], limit);
    if (bytes.length !== entry.size)
      throw new AccuracyError("git_unavailable", "Git blob size changed or was inconsistent");
    return bytes;
  }
  private scopes(paths: readonly string[]): string[] {
    if (paths.includes("")) return this.prefix === "" ? [] : [this.prefix];
    return paths.map((path) => this.projectPath(path));
  }
  async workingPaths(roots: readonly string[] = [""]): Promise<string[]> {
    const scopes = this.scopes(roots);
    const rows = nulRows(
      await this.command(["ls-files", "-z", "--cached", "--others", ...(scopes.length === 0 ? [] : ["--", ...scopes])]),
    );
    const paths = [...new Set(rows.map((row) => this.localPath(row)))];
    if (paths.length > MAX_ACCURACY_FILES)
      throw new AccuracyError("accuracy_limit", "the working project has too many files for accuracy inspection");
    return paths;
  }
  workingBytes(path: string): {
    bytes: Buffer;
    mode: string;
  } | null {
    this.checkDeadline();
    safeRelativePath(path);
    // The confined seam (G6): every segment opened without following a link, a regular file with one
    // name, read from its descriptor and still bound to the path afterwards.
    let read: { bytes: Buffer; stat: { mode: number } };
    try {
      read = readConfinedFile(this.projectRoot, path.split("/"), { shown: path, limit: MAX_CODE_FILE_BYTES });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof ConfinedTooLarge)
        throw new AccuracyError("accuracy_limit", "a covered file exceeds its byte limit");
      if (error instanceof ConfinedRefusal) {
        if (error.reason === "link")
          throw new AccuracyError("accuracy_path_refused", "covered paths may not follow symbolic links");
        if (error.reason === "moved")
          throw new AccuracyError(
            "accuracy_path_refused",
            "a covered file changed during accuracy inspection; retry after the edit",
          );
        throw new AccuracyError(
          "accuracy_path_refused",
          error.reason === "hard_link"
            ? "covered paths must name plain files with one name (no hard links)"
            : "covered paths must name plain files",
        );
      }
      if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return null;
      throw new AccuracyError("accuracy_path_refused", "a covered file could not be opened safely");
    }
    this.takeBytes(read.bytes.length);
    return { bytes: read.bytes, mode: read.stat.mode & 0o111 ? "100755" : "100644" };
  }
  private command(args: readonly string[], maxBytes = MAX_GIT_OUTPUT_BYTES, input?: string): Promise<Buffer> {
    this.checkDeadline();
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_OPTIONAL_LOCKS: "0",
    });
    return new Promise((resolveResult, reject) => {
      const child = spawn(
        "git",
        ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
        { cwd: this.root, env, stdio: ["pipe", "pipe", "pipe"] },
      );
      child.stdin.on("error", () => {});
      child.stdin.end(input);
      const chunks: Buffer[] = [];
      let length = 0,
        settled = false;
      const timer = setTimeout(
        () => fail(new AccuracyError("accuracy_limit", "Git inspection exceeded its time limit")),
        Math.max(1, Math.min(GIT_TIMEOUT_MS, this.#expires - Date.now())),
      );
      const fail = (error: AccuracyError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(error);
      };
      child.stdout.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxBytes)
          return fail(new AccuracyError("accuracy_limit", "Git inspection exceeded its output byte limit"));
        chunks.push(chunk);
      });
      child.stderr.resume();
      child.on("error", () => fail(new AccuracyError("git_unavailable", "Git could not run locally")));
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) reject(new AccuracyError("git_unavailable", "Git could not inspect this repository"));
        else resolveResult(Buffer.concat(chunks, length));
      });
    });
  }
}
function nulRows(bytes: Buffer): string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AccuracyError("accuracy_path_refused", "Git paths must be UTF-8 text");
  }
  return text.split("\0").filter(Boolean);
}
