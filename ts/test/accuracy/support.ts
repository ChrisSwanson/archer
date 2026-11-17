import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findProject } from "../../src/project/index.ts";
const roots: string[] = [];
export const FLOW = "flowchart LR\n a[Client]\n b[API]\n a hop@--> b\n";
export function write(root: string, path: string, value: string | Buffer) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), value);
}
// Auto-maintenance is off. After a commit Git starts a detached `git maintenance run --auto`; in 2.55 its
// geometric strategy repacks from about 100 loose objects and prunes them, removing emptied objects/xx
// folders while the next `git add` creates its temporary object in one. On APFS that create fails with
// EINVAL ("unable to create temporary file: Invalid argument"); cleanup's rmSync then meets ENOTEMPTY
// from the repack still writing.
const GIT_OPTIONS = [
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
];
export function git(root: string, ...args: string[]): string {
  return execFileSync("git", [...GIT_OPTIONS, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
export function repo(files: Record<string, string | Buffer> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-accuracy-")));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Archer tests");
  git(root, "config", "user.email", "archer@example.invalid");
  for (const [path, value] of Object.entries(files)) write(root, path, value);
  return root;
}
export function commit(root: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-qm", "snapshot");
  return git(root, "rev-parse", "HEAD");
}
/**
 * `texts.length` commits on top of HEAD (or the first, in a repository with none), the i-th writing `texts[i]` to
 * `path`, in one `git fast-import`: real commits, trees and blobs, as `write` and `commit` in a loop make them, but
 * stored as one pack instead of loose objects, and three processes instead of three per commit. The index and
 * working tree are left at the last commit, as that loop leaves them. Returns the commits, oldest first.
 */
export function importHistory(root: string, path: string, texts: readonly (string | Buffer)[]): string[] {
  const branch = git(root, "symbolic-ref", "HEAD");
  let parent: string | undefined;
  try {
    parent = git(root, "rev-parse", "--verify", "-q", "HEAD");
  } catch {
    parent = undefined; // No commit yet.
  }
  const start = Math.floor(Date.now() / 1000);
  const chunks: Buffer[] = [];
  const line = (text: string) => chunks.push(Buffer.from(`${text}\n`, "utf8"));
  texts.forEach((text, i) => {
    const message = `snapshot ${i}`;
    const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
    line(`commit ${branch}`);
    line(`mark :${i + 1}`);
    line(`committer Archer tests <archer@example.invalid> ${start + i + 1} +0000`);
    line(`data ${Buffer.byteLength(message)}`);
    line(message);
    if (i === 0 && parent !== undefined) line(`from ${parent}`);
    line(`M 100644 inline ${path}`);
    line(`data ${bytes.length}`);
    chunks.push(bytes);
    line("");
  });
  const marks = join(root, ".git", "archer-import-marks");
  execFileSync("git", [...GIT_OPTIONS, "fast-import", "--quiet", `--export-marks=${marks}`], {
    cwd: root,
    input: Buffer.concat(chunks),
    stdio: ["pipe", "ignore", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const byMark = new Map(
    readFileSync(marks, "utf8")
      .trim()
      .split("\n")
      .map((entry) => entry.split(" ") as [string, string]),
  );
  rmSync(marks);
  git(root, "reset", "-q", "--hard");
  return texts.map((_, i) => byMark.get(`:${i + 1}`)!);
}
export const manifest = (extra = 'covers = ["src/**"]', source = ".archer/flow.mmd", kind = "freeform") =>
  `version = 1\n[[views]]\nid = "flow"\nkind = "${kind}"\ntitle = "Flow"\nsource = "${source}"\n${extra}\n`;
export function project(root: string) {
  return findProject(root);
}
export function cleanup() {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
