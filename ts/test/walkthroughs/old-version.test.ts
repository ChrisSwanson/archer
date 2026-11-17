// Finding the diagram a walkthrough was written on (ADR 0034 §3, plan slice 7a): the recorded commit,
// then a search of the file's last 200 commits by the revision's hash, then "not in Git history".
// Every repository here is a throwaway one; no test reads the working tree for the old model.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { findOldVersion, MAX_SEARCH_COMMITS } from "../../src/walkthroughs/old-version.ts";
import { revisionOf } from "../../src/project/index.ts";
import { cleanup, commit, FLOW, git, importHistory, project, repo, write } from "../accuracy/support.ts";

afterEach(cleanup);

const rev = (text: string) => revisionOf(Buffer.from(text, "utf8"));
const NEW = FLOW.replace("Client", "Shopper");
const NOTE = (body: string) => `---\nauthor: agent\n---\n# Pay\n\n\`\`\`mermaid\n%% archer-id: pay\n${body}\`\`\`\n`;
const file = { viewId: "checkout", path: "checkout.mmd" };

test("the recorded commit is used when its blob hashes to the revision", async () => {
  const root = repo({ ".archer/checkout.mmd": FLOW });
  const written = commit(root);
  write(root, ".archer/checkout.mmd", NEW);
  commit(root);
  const found = await findOldVersion(project(root), file, { modelRevision: rev(FLOW), commit: written });
  expect(found).toMatchObject({ status: "found", how: "recorded", commit: written });
  if (found.status !== "found") throw new Error("not found");
  expect(found.committedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(JSON.stringify(found.diagram.result.envelope?.model)).toContain("Client");
});

test("without a commit, or with one that does not hold the revision, the file's history is searched", async () => {
  const root = repo({ ".archer/checkout.mmd": FLOW });
  const first = commit(root);
  write(root, ".archer/checkout.mmd", NEW);
  const second = commit(root);
  expect(await findOldVersion(project(root), file, { modelRevision: rev(FLOW) })).toMatchObject({
    status: "found",
    how: "search",
    commit: first,
  });
  expect(await findOldVersion(project(root), file, { modelRevision: rev(FLOW), commit: second })).toMatchObject({
    status: "found",
    how: "search",
    commit: first,
  });
  expect(await findOldVersion(project(root), file, { modelRevision: rev(NEW) })).toMatchObject({
    status: "found",
    commit: second,
  });
});

test("a revision that was never committed is not in Git history", async () => {
  const root = repo({ ".archer/checkout.mmd": FLOW });
  commit(root);
  expect(await findOldVersion(project(root), file, { modelRevision: rev("flowchart LR\n x[Never]\n") })).toEqual({
    status: "not-in-history",
    reason: "not_found",
  });
  // A commit that does not exist, or a malformed one, only means the search runs.
  expect(await findOldVersion(project(root), file, { modelRevision: rev("x"), commit: "f".repeat(40) })).toMatchObject({
    status: "not-in-history",
  });
});

test("a repository with no commits, no repository at all, and a file that never existed are not in history either", async () => {
  const root = repo({ ".archer/checkout.mmd": FLOW });
  expect(await findOldVersion(project(root), file, { modelRevision: rev(FLOW) })).toMatchObject({
    status: "not-in-history",
  });
  rmSync(join(root, ".git"), { recursive: true });
  expect(await findOldVersion(project(root), file, { modelRevision: rev(FLOW) })).toEqual({
    status: "not-in-history",
    reason: "git_unavailable",
  });
  git(root, "init", "-q");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.invalid");
  commit(root);
  expect(
    await findOldVersion(project(root), { viewId: "gone", path: "gone.mmd" }, { modelRevision: rev(FLOW) }),
  ).toMatchObject({ status: "not-in-history" });
});

test("a diagram embedded in a note is found by its fence, not by the whole note", async () => {
  const root = repo({ ".archer/notes/pay.md": NOTE(FLOW) });
  const first = commit(root);
  write(root, ".archer/notes/pay.md", NOTE(FLOW).replace("# Pay", "# Pay\n\nProse changes do not matter."));
  commit(root);
  write(root, ".archer/notes/pay.md", NOTE(NEW));
  commit(root);
  const place = { viewId: "notes/pay.md#pay", path: "notes/pay.md", embedded: "pay" };
  // The revision of an embedded diagram is of its body without the archer-id line.
  const found = await findOldVersion(project(root), place, { modelRevision: rev(FLOW) });
  expect(found.status).toBe("found");
  if (found.status !== "found") throw new Error("not found");
  expect(found.diagram.result.envelope?.view.id).toBe("notes/pay.md#pay");
  expect(found.diagram.result.envelope?.revision).toBe(rev(FLOW));
  // The prose-only commit changed the note and not the diagram: the newest commit with that body is found.
  expect(found.how).toBe("search");
  expect(found.commit).not.toBe(first);
});

test("an unregistered .mmd in a subfolder is found", async () => {
  const root = repo({ ".archer/deep/er/checkout.mmd": FLOW });
  const first = commit(root);
  write(root, ".archer/deep/er/checkout.mmd", NEW);
  commit(root);
  expect(
    await findOldVersion(
      project(root),
      { viewId: "checkout", path: "deep/er/checkout.mmd" },
      { modelRevision: rev(FLOW) },
    ),
  ).toMatchObject({ status: "found", commit: first });
});

test("an old source today's compiler refuses is reported, with its commit", async () => {
  const root = repo({ ".archer/checkout.mmd": "garbage\n" });
  const first = commit(root);
  write(root, ".archer/checkout.mmd", FLOW);
  commit(root);
  const found = await findOldVersion(project(root), file, { modelRevision: rev("garbage\n") });
  expect(found).toMatchObject({ status: "found", commit: first, diagram: { status: "failed" } });
});

test("the search looks at the last 200 commits of the file and no further", async () => {
  const root = repo({ ".archer/checkout.mmd": FLOW });
  const first = commit(root);
  importHistory(
    root,
    ".archer/checkout.mmd",
    Array.from({ length: MAX_SEARCH_COMMITS * 2 + 99 }, (_, i) => `flowchart LR\n a[Step ${i}]\n`),
  );
  // 499 commits after the first: its revision is past the bound, the newest 200 are inside it.
  expect(await findOldVersion(project(root), file, { modelRevision: rev(FLOW) })).toEqual({
    status: "not-in-history",
    reason: "not_found",
  });
  expect(await findOldVersion(project(root), file, { modelRevision: rev(FLOW), commit: first })).toMatchObject({
    status: "found",
    how: "recorded",
  });
  const inside = await findOldVersion(project(root), file, {
    modelRevision: rev(`flowchart LR\n a[Step ${MAX_SEARCH_COMMITS * 2 + 50}]\n`),
  });
  expect(inside).toMatchObject({ status: "found", how: "search" });
}, 60_000);

const big = (i: number) => `flowchart LR\n${` a${i}[${"x".repeat(60)}]\n`.repeat(3200)}`;
/** `count` commits of the checkout diagram, `text(i)` the i-th, made in one `git fast-import` (a pack). */
const makeHistory = (root: string, count: number, text: (i: number) => string) =>
  importHistory(
    root,
    ".archer/checkout.mmd",
    Array.from({ length: count }, (_, i) => text(i)),
  );
/** The same as a person's commits leave them, loose objects: steps `from` to `from + count - 1`. */
const commitHistory = (root: string, from: number, count: number, text: (i: number) => string) => {
  const commits: string[] = [];
  for (let i = from; i < from + count; i++) {
    write(root, ".archer/checkout.mmd", text(i));
    commits.push(commit(root));
  }
  return commits;
};

test("the newest MAX_SEARCH_COMMITS commits are searched: the 200th is found, the 201st is not", async () => {
  const root = repo();
  const text = (i: number) => `flowchart LR\n a[Step ${i}]\n`;
  makeHistory(root, MAX_SEARCH_COMMITS + 1, text);
  // 201 commits, steps 0..200: step 1 is the 200th newest, step 0 the 201st.
  expect(await findOldVersion(project(root), file, { modelRevision: rev(text(1)) })).toMatchObject({
    status: "found",
    how: "search",
  });
  expect(await findOldVersion(project(root), file, { modelRevision: rev(text(0)) })).toEqual({
    status: "not-in-history",
    reason: "not_found",
  });
}, 60_000);

test("running out of Git budget is git_unavailable, never 'not in history'", async () => {
  const root = repo();
  makeHistory(root, 205, big);
  // 199 commits back: the byte budget (32 MB) runs out before the search gets there.
  const found = await findOldVersion(project(root), file, { modelRevision: rev(big(5)) });
  expect(found).toEqual({ status: "not-in-history", reason: "git_unavailable" });
}, 120_000);

test("the search runs a handful of Git processes, not three per commit", async () => {
  const root = repo();
  // Steps 0..49 packed, 50..59 loose on top: the search reads both kinds of object on its way to step 0.
  const step = (i: number) => `flowchart LR\n a[Step ${i}]\n`;
  makeHistory(root, 50, step);
  commitHistory(root, 50, 10, step);
  const objects = Object.fromEntries(
    git(root, "count-objects", "-v")
      .split("\n")
      .map((entry) => entry.split(": ") as [string, string]),
  );
  expect(Number(objects["count"]), "loose objects").toBeGreaterThanOrEqual(30);
  expect(Number(objects["packs"]), "packs").toBeGreaterThanOrEqual(1);
  const bin = mkdtempSync(join(tmpdir(), "archer-gitshim-"));
  const log = join(bin, "calls");
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho x >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}:${path}`;
  try {
    const found = await findOldVersion(project(root), file, { modelRevision: rev("flowchart LR\n a[Step 0]\n") });
    expect(found).toMatchObject({ status: "found", how: "search" });
  } finally {
    process.env["PATH"] = path;
  }
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).length;
  rmSync(bin, { recursive: true, force: true });
  // Opening, HEAD, the log, sizes, a few content batches, then the found version's own compile.
  expect(calls).toBeLessThanOrEqual(12);
}, 60_000);
