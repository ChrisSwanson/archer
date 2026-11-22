// The syscall-swap harness the confined-seam tests share (confined-seam.test.ts, shared-folder.test.ts): a
// project with a note and an outside folder of the same names, and swaps scheduled at the exact syscall where
// a check-to-use window bites.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { vi } from "vitest";
import { findProject, type Project } from "../../src/project/project.ts";
import { tempDir } from "../project/support.ts";

export const real = { openSync: fs.openSync, renameSync: fs.renameSync, linkSync: fs.linkSync };
export const INSIDE = "# inside\n";
export const OUTSIDE = "# OUTSIDE canary\n";
const sha = (path: string) => createHash("sha256").update(fs.readFileSync(path)).digest("hex");

export interface Layout {
  readonly project: Project;
  readonly folder: string;
  readonly outside: string;
}
/** A project with notes/d/race.md, and outside it a directory with a file of the same name. */
export function layout(): Layout {
  const root = tempDir({
    "archer.toml": "version = 1\n",
    ".archer/notes/d/race.md": INSIDE,
    ".archer/notes/top.md": INSIDE,
  });
  const outside = tempDir({ "d/race.md": OUTSIDE, "canary.md": OUTSIDE });
  return { project: findProject(root), folder: join(root, ".archer"), outside };
}
/** Every file under `dir`, by path, with its hash. */
export function snapshot(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[]) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile()) files.set(path, sha(path));
  }
  return files;
}
/** Replaces `notes/d` with a link to the outside `d` (the real folder kept aside, inside the project). */
export const swapParent = (l: Layout) => () => {
  real.renameSync(join(l.folder, "notes/d"), join(l.folder, "notes/d.aside"));
  fs.symlinkSync(join(l.outside, "d"), join(l.folder, "notes/d"));
};
/** Replaces `notes/top.md` with a link to the outside canary. */
export const swapFile = (l: Layout) => () => {
  fs.symlinkSync(join(l.outside, "canary.md"), join(l.folder, "notes/top.md.link"));
  real.renameSync(join(l.folder, "notes/top.md.link"), join(l.folder, "notes/top.md"));
};

/** Runs `swap` once, at the first call of `syscall` whose path ends with `suffix`, before or after it runs. */
export function once(
  syscall: "openSync" | "renameSync" | "linkSync",
  suffix: RegExp,
  when: "before" | "after",
  swap: () => void,
): { fired: () => boolean } {
  let fired = false;
  const original = real[syscall] as (...args: unknown[]) => unknown;
  vi.spyOn(fs, syscall).mockImplementation(((...args: unknown[]) => {
    const hit = !fired && suffix.test(String(args[syscall === "openSync" ? 0 : 1]));
    if (hit && when === "before") {
      fired = true;
      swap();
    }
    const result = original(...args);
    if (hit && when === "after") {
      fired = true;
      swap();
    }
    return result;
  }) as never);
  syncBuiltinESMExports();
  return { fired: () => fired };
}
