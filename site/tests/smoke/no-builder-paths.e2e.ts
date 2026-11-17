import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { expect, test } from "@playwright/test";

// The published site names no folder of the machine that built it: not its home, the checkout or the worktree,
// written in full or home-relative (`~/…`, as the project header shows a folder). The Playground's snapshot once
// carried each example's real folder, on a developer's laptop and on the CI runner alike. Run after docs:build.
const root = resolve(process.env.ARCHER_DOCS_DIST ?? "site/.vitepress/dist");
const checkout = resolve(import.meta.dirname, "../../..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test("no built file names the build machine's home, checkout or worktree", () => {
  const home = homedir();
  const homeRelative = (path: string) => (path.startsWith(`${home}/`) ? `~/${relative(home, path)}` : null);
  const forbidden = [home, checkout, homeRelative(checkout), process.cwd(), homeRelative(process.cwd())].filter(
    (value, at, all): value is string => value !== null && value.length > 1 && all.indexOf(value) === at,
  );
  const built = files(root);
  expect(built.length).toBeGreaterThan(50);
  const found: string[] = [];
  for (const file of built) {
    const text = readFileSync(file).toString("latin1");
    for (const value of forbidden) if (text.includes(value)) found.push(`${relative(root, file)}: ${value}`);
  }
  expect(found).toEqual([]);
});

// Nor a Git object id: the public site is exported from another repository, so a commit of the one that built it
// is meaningless there and names private history. A 40-hex run standing alone is a SHA-1 object id (the site's own
// content digests are SHA-256, 64 hex, and are not matched).
test("no built file names a Git commit, the checkout's HEAD or any other", () => {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  const objectId = /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/giu;
  const found: string[] = [];
  for (const file of files(root)) {
    const text = readFileSync(file).toString("latin1");
    if (text.includes(head) || text.includes(head.slice(0, 12))) found.push(`${relative(root, file)}: HEAD`);
    for (const match of text.matchAll(objectId)) found.push(`${relative(root, file)}: ${match[0]}`);
  }
  expect(found).toEqual([]);
});
