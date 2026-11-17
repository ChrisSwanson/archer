import { symlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { GitRepository, MAX_CODE_FILE_BYTES, gitRef, safeRelativePath } from "../../src/accuracy/git.ts";
import { coveragePatterns, coveredBy } from "../../src/accuracy/coverage.ts";
import { listStaleDiagrams } from "../../src/accuracy/stale.ts";
import { readDiagramAtCommit } from "../../src/accuracy/history.ts";
import { cleanup, commit, FLOW, manifest, project, repo, write } from "./support.ts";
afterEach(cleanup);
test.each(["--help", "HEAD:path", "HEAD..main", "HEAD@{0}", "../main", "HEAD\0x", "HEAD\n"])(
  "revision %j is refused before Git",
  (ref) => expect(() => gitRef(ref)).toThrow(),
);
test.each(["../outside", "/outside", ".git/config", "a/../../b", "a\\b", "a\0b"])("path %j is refused", (path) =>
  expect(() => safeRelativePath(path)).toThrow(),
);
test.each([["../**"], ["/src/**"], [".git/**"], ["src/../**"], ["src/**x"], ["src/{a,b}"]])(
  "coverage %j is refused",
  (pattern) => expect(() => coveragePatterns(pattern)).toThrow(),
);
test("glob matching honors path segments and recursive directories", () => {
  const patterns = coveragePatterns(["src/**/a?.ts"]);
  expect(coveredBy("src/a1.ts", patterns)).toBe(true);
  expect(coveredBy("src/sub/a2.ts", patterns)).toBe(true);
  expect(coveredBy("else/src/a1.ts", patterns)).toBe(false);
});
test("working symlinks are refused rather than reading another project", async () => {
  const root = repo({ "archer.toml": manifest(), ".archer/flow.mmd": FLOW, "src/a.ts": "a" });
  commit(root);
  rmSync(join(root, "src/a.ts"));
  symlinkSync("/etc/passwd", join(root, "src/a.ts"));
  expect((await listStaleDiagrams(project(root))).views[0]).toMatchObject({
    status: "unavailable",
    reason: "accuracy_path_refused",
  });
});
test("oversized covered files are refused before allocation", async () => {
  const root = repo({ "archer.toml": manifest(), ".archer/flow.mmd": FLOW, "src/a.ts": "a" });
  commit(root);
  writeFileSync(join(root, "src/a.ts"), Buffer.alloc(MAX_CODE_FILE_BYTES + 1));
  expect((await listStaleDiagrams(project(root))).views[0]).toMatchObject({
    status: "unavailable",
    reason: "accuracy_limit",
  });
});
test("historical symlink sources are refused and do not consult current target", async () => {
  const root = repo({ "archer.toml": manifest() });
  write(root, ".archer/target.mmd", FLOW);
  symlinkSync("target.mmd", join(root, ".archer/flow.mmd"));
  const old = commit(root);
  expect(await readDiagramAtCommit(project(root), "flow", old)).toMatchObject({
    status: "unavailable",
    reason: "accuracy_path_refused",
  });
});
test("project prefix confines historical and working reads inside a nested Git project", async () => {
  const root = repo({
    "outside.ts": "secret",
    "sub/archer.toml": manifest(),
    "sub/.archer/flow.mmd": FLOW,
    "sub/src/a.ts": "a",
  });
  const baseline = commit(root);
  write(root, "outside.ts", "changed");
  expect((await listStaleDiagrams(project(join(root, "sub")))).views[0]).toMatchObject({
    status: "current",
    baselineCommit: baseline,
  });
  const git = await GitRepository.open(join(root, "sub"));
  await expect(git.entry(baseline, "../outside.ts")).rejects.toMatchObject({ code: "accuracy_path_refused" });
});
test("even a now-deleted historical covered link is refused, rather than treated as safe code", async () => {
  const root = repo({ "archer.toml": manifest(), ".archer/flow.mmd": FLOW });
  write(root, "src/plain.ts", "safe");
  symlinkSync("/etc/passwd", join(root, "src/link.ts"));
  commit(root);
  rmSync(join(root, "src/link.ts"));
  expect((await listStaleDiagrams(project(root))).views[0]).toMatchObject({
    status: "unavailable",
    reason: "accuracy_path_refused",
  });
});
test("crafted Git entries cannot smuggle options into blob reads", async () => {
  const root = repo({ a: "a" });
  commit(root);
  const git = await GitRepository.open(root);
  await expect(
    git.blob({ path: "a", oid: "--batch", size: 1, type: "blob", mode: "100644" }, 10),
  ).rejects.toMatchObject({ code: "invalid_git_ref" });
});
test("coverage enumeration refuses excessive matching paths before reading file bodies", async () => {
  const files: Record<string, string> = { "archer.toml": manifest(), ".archer/flow.mmd": FLOW };
  for (let i = 0; i < 4097; i++) files[`src/${i}.ts`] = "x";
  const root = repo(files);
  commit(root);
  expect((await listStaleDiagrams(project(root))).views[0]).toMatchObject({
    status: "unavailable",
    reason: "accuracy_limit",
  });
});
test("the cumulative read budget refuses before another file body is allocated", async () => {
  const root = repo();
  const git = await GitRepository.open(root);
  git.takeBytes(32 * 1024 * 1024);
  expect(() => git.takeBytes(1)).toThrow(expect.objectContaining({ code: "accuracy_limit" }));
});

test.each(["src/@(a|b).ts", "src/+(a).ts", "src/?(a).ts", "src/*(a).ts"])(
  "unsupported extglob coverage %j is refused by name",
  (pattern) => {
    expect(() => coveragePatterns([pattern])).toThrow(expect.objectContaining({ code: "invalid_coverage" }));
  },
);
