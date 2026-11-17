// The person's global preferences note (ADR 0031): Markdown for agents, with front matter flags
// Archer parses. A bad flag warns and falls back; it never crashes a front door.

import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parsePreferences, preferencesPath, readPreferences, setPreference } from "../../src/config/preferences.ts";
import { cleanUp, tempDir } from "../service/support.ts";

afterEach(cleanUp);

test("the note is preferences.md in the Archer home", () => {
  expect(preferencesPath({ HOME: "/h" })).toBe("/h/.archer/preferences.md");
  expect(preferencesPath({ HOME: "/h", ARCHER_HOME: "/a" })).toBe("/a/preferences.md");
});

test.each([
  ["", "ask", 0],
  ["# just notes\n", "ask", 0],
  ["---\ninstances: reuse-main\n---\nbody", "reuse-main", 0],
  ['---\r\ninstances: "reuse-any"\r\n---\r\n', "reuse-any", 0],
  ["---\n# a comment\n\ninstances: ask\n---\n", "ask", 0],
  ["---\ninstances: sometimes\n---\n", "ask", 1],
  ["---\ncolour: blue\ninstances: reuse-main\n---\n", "reuse-main", 1],
  ["---\njust words\n---\n", "ask", 1],
  ["---\ninstances: reuse-main\n", "ask", 1],
  ["---\ninstances: reuse-main\ninstances: reuse-any\n---\n", "reuse-any", 1],
] as const)("front matter %j reads as %s with %i warning(s)", (text, mode, warnings) => {
  const parsed = parsePreferences(text);
  expect(parsed.instances).toBe(mode);
  expect(parsed.warnings).toHaveLength(warnings);
});

test("a warning names the problem and the file's allowed values", () => {
  expect(parsePreferences("---\ninstances: sometimes\n---\n").warnings[0]).toMatch(
    /instances.*sometimes.*ask, reuse-main, reuse-any/,
  );
  expect(parsePreferences("---\ncolour: blue\n---\n").warnings[0]).toMatch(/unknown key.*colour/);
});

test("parsing never throws, on arbitrary text or text made of its own vocabulary", () => {
  const words = [
    "---",
    "\n",
    "instances",
    ":",
    " ",
    "ask",
    "reuse-main",
    "reuse-any",
    '"',
    "'",
    "#",
    "\r",
    "x",
    "\u0000",
    "é",
  ];
  let seed = 7;
  const random = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  for (let i = 0; i < 2_000; i++) {
    const text =
      i % 2 === 0
        ? Array.from({ length: random(40) }, () => words[random(words.length)]).join("")
        : Array.from({ length: random(80) }, () => String.fromCharCode(random(0x3000))).join("");
    const parsed = parsePreferences(text);
    expect(["ask", "reuse-main", "reuse-any"]).toContain(parsed.instances);
  }
});

test("a missing note is the default, without warnings", () => {
  const home = tempDir("archer-home-");
  expect(readPreferences({ HOME: home })).toMatchObject({ instances: "ask", warnings: [], exists: false });
});

test("an unreadable note warns and uses the default", () => {
  const home = tempDir("archer-home-");
  mkdirSync(join(home, ".archer", "preferences.md"), { recursive: true });
  const read = readPreferences({ HOME: home });
  expect(read.instances).toBe("ask");
  expect(read.warnings[0]).toMatch(/cannot read/);
});

test("set creates the note privately, with the flag, a short body and a dated note line", () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home };
  setPreference(
    env,
    "instances",
    "reuse-main",
    "keep using the old one until Friday",
    new Date("2026-10-21T12:00:00Z"),
  );
  const text = readFileSync(preferencesPath(env), "utf8");
  expect(text.startsWith("---\ninstances: reuse-main\n---\n")).toBe(true);
  expect(text).toContain(".archer/user_preferences.md");
  expect(text.trimEnd().split("\n").at(-1)).toBe(
    "- 2026-10-21 instances: reuse-main — keep using the old one until Friday",
  );
  expect(statSync(preferencesPath(env)).mode & 0o777).toBe(0o600);
  expect(readPreferences(env)).toMatchObject({ instances: "reuse-main", warnings: [], exists: true });
});

test("set rewrites only the flag and appends its line, keeping the person's text", () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home };
  mkdirSync(join(home, ".archer"), { recursive: true });
  const original = "---\n# mine\ninstances: ask\nother: kept\n---\n# My rules\n\nReuse for demos only.\n";
  writeFileSync(preferencesPath(env), original);
  setPreference(env, "instances", "reuse-any", undefined, new Date("2026-10-22T08:00:00Z"));
  expect(readFileSync(preferencesPath(env), "utf8")).toBe(
    "---\n# mine\ninstances: reuse-any\nother: kept\n---\n# My rules\n\nReuse for demos only.\n- 2026-10-22 instances: reuse-any\n",
  );
});

test("set adds front matter to a note that has none, and keeps a note to one line", () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home };
  mkdirSync(join(home, ".archer"), { recursive: true });
  writeFileSync(preferencesPath(env), "Just my notes.");
  setPreference(env, "instances", "ask", "two\nlines", new Date("2026-10-22T08:00:00Z"));
  expect(readFileSync(preferencesPath(env), "utf8")).toBe(
    "---\ninstances: ask\n---\nJust my notes.\n- 2026-10-22 instances: ask — two lines\n",
  );
});

test("set refuses an unknown key or mode by name", () => {
  const env = { HOME: tempDir("archer-home-") };
  expect(() => setPreference(env, "colour", "blue")).toThrow(/unknown preference "colour".*instances/);
  expect(() => setPreference(env, "instances", "always")).toThrow(/ask, reuse-main, reuse-any/);
});

test("set leaves one instances line, so the recorded choice is the effective one", () => {
  const home = tempDir("archer-home-");
  const env = { HOME: home };
  mkdirSync(join(home, ".archer"), { recursive: true });
  writeFileSync(preferencesPath(env), "---\ninstances: ask\nother: x\ninstances: ask\n---\nbody\n");
  setPreference(env, "instances", "reuse-main", undefined, new Date("2026-10-22T08:00:00Z"));
  expect(readFileSync(preferencesPath(env), "utf8")).toBe(
    "---\ninstances: reuse-main\nother: x\n---\nbody\n- 2026-10-22 instances: reuse-main\n",
  );
  expect(readPreferences(env).instances).toBe("reuse-main");
});

test("a FIFO in place of the note does not block, and warns", async () => {
  const { execFileSync } = await import("node:child_process");
  const home = tempDir("archer-home-");
  mkdirSync(join(home, ".archer"), { recursive: true });
  execFileSync("mkfifo", ["-m", "600", preferencesPath({ HOME: home })]);
  const read = readPreferences({ HOME: home });
  expect(read.instances).toBe("ask");
  expect(read.warnings[0]).toMatch(/not a file/);
}, 5_000);
