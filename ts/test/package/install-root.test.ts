// The licences in THIRD_PARTY_NOTICES.md come from `npm ls` over the installed tree. A worktree whose
// node_modules is a link to another checkout's (.agents/skills/archer-ui-verification) has its
// packages installed there: npm ls run in the worktree sees every one of them as a link outside the
// project, calls them extraneous and fails, so the notices are listed where the install lives.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { installRoot } from "../../scripts/package.ts";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "archer-install-root-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("a checkout with its own node_modules lists its own install", () => {
  const checkout = join(scratch, "checkout");
  mkdirSync(join(checkout, "node_modules"), { recursive: true });
  expect(installRoot(checkout)).toBe(checkout);
});

test("a worktree whose node_modules links to another checkout's lists that checkout's install", () => {
  const main = join(scratch, "main");
  mkdirSync(join(main, "node_modules"), { recursive: true });
  const worktree = join(scratch, "worktree");
  mkdirSync(worktree);
  symlinkSync(join(main, "node_modules"), join(worktree, "node_modules"));
  expect(installRoot(worktree)).toBe(main);
});

test("a checkout with no install yet is its own root, so npm ls reports what is missing there", () => {
  const bare = join(scratch, "bare");
  mkdirSync(bare);
  expect(installRoot(bare)).toBe(bare);
});
