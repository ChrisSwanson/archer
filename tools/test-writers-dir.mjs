// The writers root (ARCHER_WRITERS_DIR, ts/src/comments/lock.ts) a test run gives the services it starts and the
// processes they fork: a private directory of the run's own, removed when the process that made it exits.
//
// Writer claim directories are kept once made, one per file ever locked, and tests lock files in fresh temporary
// projects, so a root shared across runs only grows. A caller's own absolute root stands and is never removed. An
// empty or relative one is replaced: `writersRoot()` ignores it and would fall back to the person's own state.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The run's writers root, made on first call in this process (0700, mkdtemp) unless `env` names a usable one. */
export function runWritersDir(env = process.env) {
  const given = env.ARCHER_WRITERS_DIR;
  if (typeof given === "string" && given !== "" && isAbsolute(given)) return given;
  const root = mkdtempSync(join(realpathSync(tmpdir()), "archer-test-writers-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  return root;
}
