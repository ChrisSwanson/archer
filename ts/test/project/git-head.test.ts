// The project page's Git fact: branch and short commit, asked of Git in the
// background at most once per interval, never awaited by a request.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { GitRepository } from "../../src/accuracy/git.ts";
import { GitHeadBook } from "../../src/project/git-head.ts";
import { cleanup, commit, git, repo } from "../accuracy/support.ts";

const plain: string[] = [];
afterEach(() => {
  cleanup();
  for (const dir of plain.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("head names the checked-out branch and Git's short commit; detached has no branch; unborn is null", async () => {
  const root = repo({ "a.txt": "a" });
  git(root, "checkout", "-q", "-b", "feat/readme");
  expect(await (await GitRepository.open(root)).head()).toBeNull();
  const full = commit(root);
  const short = git(root, "rev-parse", "--short", "HEAD");
  expect(await (await GitRepository.open(root)).head()).toEqual({ branch: "feat/readme", commit: short });
  expect(full.startsWith(short)).toBe(true);
  git(root, "checkout", "-q", "--detach");
  expect(await (await GitRepository.open(root)).head()).toEqual({ commit: short });
});

test("the book answers from its cache, asks Git in the background, and at most once per interval", async () => {
  const root = repo({ "a.txt": "a" });
  git(root, "checkout", "-q", "-b", "main");
  commit(root);
  let now = 1_000_000,
    learned = 0;
  const book = new GitHeadBook(root, () => now);
  expect(book.current()).toBeUndefined();
  await book.refresh(() => learned++);
  expect(book.current()).toMatchObject({ branch: "main" });
  expect(learned).toBe(1);
  git(root, "checkout", "-q", "-b", "other");
  await book.refresh(() => learned++);
  expect(book.inspections).toBe(1);
  expect(book.current()).toMatchObject({ branch: "main" });
  now += 60_000;
  await book.refresh(() => learned++);
  expect(book.inspections).toBe(2);
  expect(book.current()).toMatchObject({ branch: "other" });
  expect(learned).toBe(2);
  now += 60_000;
  await book.refresh(() => learned++);
  expect(learned).toBe(2); // unchanged answers are not announced
});

test("outside a Git checkout the book knows there is no Git fact", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archer-nogit-")));
  plain.push(root);
  const book = new GitHeadBook(root, () => 0);
  await book.refresh();
  expect(book.current()).toBeNull();
});

test("Git's first answer is news only to a reader who saw no answer yet", async () => {
  const root = repo({ "a.txt": "a" });
  git(root, "checkout", "-q", "-b", "main");
  commit(root);
  let learned = 0;
  const unread = new GitHeadBook(root, () => 0);
  await unread.refresh(() => learned++);
  expect(unread.current()).toMatchObject({ branch: "main" });
  expect(learned).toBe(0);
  const read = new GitHeadBook(root, () => 0);
  expect(read.current()).toBeUndefined();
  await read.refresh(() => learned++);
  expect(learned).toBe(1);
});
