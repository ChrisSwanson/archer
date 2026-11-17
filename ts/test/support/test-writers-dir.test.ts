// The writers root a test run gives its services (tools/test-writers-dir.mjs): its own, removed when the run ends.
// Claim directories are kept once made (src/comments/lock.ts), so a root shared across runs only grows; a value
// `writersRoot()` ignores (empty, relative) would send the run's claims to the person's own state instead.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { runWritersDir } from "../../../tools/test-writers-dir.mjs";

const helper = fileURLToPath(new URL("../../../tools/test-writers-dir.mjs", import.meta.url));

/** A process that takes a run's root, makes a claim directory in it and exits: the root it took, and whether it stayed. */
function run(env: NodeJS.ProcessEnv): { root: string; after: boolean } {
  const script = `import { runWritersDir } from ${JSON.stringify(helper)};
import { mkdirSync } from "node:fs";
const root = runWritersDir(process.env);
mkdirSync(root + "/0123abcd", { recursive: true });
console.log(root);`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
  expect(child.status, child.stderr).toBe(0);
  const root = child.stdout.trim();
  return { root, after: existsSync(root) };
}

test("a run with no writers root of its own gets a private one, removed when the run ends", () => {
  const { ARCHER_WRITERS_DIR: _, ...env } = process.env;
  const { root, after } = run(env);
  expect(isAbsolute(root)).toBe(true);
  expect(after).toBe(false);
});

for (const value of ["", "relative/writers"])
  test(`a writers root writersRoot() would ignore (${JSON.stringify(value)}) is replaced by the run's own`, () => {
    const { root, after } = run({ ...process.env, ARCHER_WRITERS_DIR: value });
    expect(root).not.toBe(value);
    expect(isAbsolute(root)).toBe(true);
    expect(after).toBe(false);
  });

test("a caller's own absolute writers root stands, and is never removed", () => {
  const mine = mkdtempSync(join(tmpdir(), "caller-writers-"));
  try {
    const { root, after } = run({ ...process.env, ARCHER_WRITERS_DIR: mine });
    expect(root).toBe(mine);
    expect(after).toBe(true);
  } finally {
    rmSync(mine, { recursive: true, force: true });
  }
});

test("the run's own root is private to the person running it", () => {
  const { ARCHER_WRITERS_DIR: _, ...env } = process.env;
  const root = runWritersDir(env);
  try {
    expect(statSync(root).mode & 0o077).toBe(0);
  } finally {
    // A test worker is not always let run its exit handlers: remove it here rather than leave it behind.
    rmSync(root, { recursive: true, force: true });
  }
});
