// The person's global preferences note, `<Archer home>/preferences.md` (ADR 0031): Markdown that
// agents read and follow, like a skill file of the person's own. Archer parses only its YAML front
// matter, and only flat `key: value` lines; an unknown key or bad value is a warning, never a
// failure. A project's `.archer/user_preferences.md` is its counterpart, read by agents only, and
// wins over this note for that project.
//
//   instances: ask | reuse-main | reuse-any   what a front door does when the choice of running
//                                              copy is ambiguous (default ask)
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, type Env } from "../service/paths.ts";
import { archerHome } from "../service/instances.ts";

export const INSTANCE_MODES = ["ask", "reuse-main", "reuse-any"] as const;
export type InstancesMode = (typeof INSTANCE_MODES)[number];

export interface Preferences {
  readonly instances: InstancesMode;
  readonly warnings: readonly string[];
  readonly path: string;
  readonly exists: boolean;
}

const MAX_BYTES = 64 * 1024;
const MAX_NOTE_CHARS = 300;

export const preferencesPath = (env: Env = process.env): string => join(archerHome(env), "preferences.md");

const isMode = (value: string): value is InstancesMode => (INSTANCE_MODES as readonly string[]).includes(value);

/** The index of the front matter's closing line, or null when the text has none. */
function frontMatter(lines: readonly string[]): { end: number } | null | "unterminated" {
  if (lines[0]?.replace(/\r$/, "") !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.replace(/\r$/, "") === "---");
  return end < 0 ? "unterminated" : { end };
}

/** The flags in `text`'s front matter; defaults, with a warning, for anything Archer cannot use. */
export function parsePreferences(text: string): { instances: InstancesMode; warnings: string[] } {
  const warnings: string[] = [];
  let instances: InstancesMode = "ask";
  const lines = text.split("\n");
  const found = frontMatter(lines);
  if (found === null) return { instances, warnings };
  if (found === "unterminated")
    return { instances, warnings: ["the front matter has no closing --- line; using the defaults"] };
  let seen = false;
  for (let index = 1; index < found.end; index++) {
    const line = lines[index]!.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (match === null) {
      warnings.push(`front matter line ${index + 1} is not "key: value"; ignored`);
      continue;
    }
    const key = match[1]!,
      value = match[2]!
        .replace(/\s+#.*$/, "")
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2");
    if (key !== "instances") {
      warnings.push(`unknown key "${key.slice(0, 40)}" in the front matter; ignored (known: instances)`);
      continue;
    }
    if (seen) warnings.push("instances is set twice; the last one counts");
    seen = true;
    if (isMode(value)) instances = value;
    else {
      instances = "ask";
      warnings.push(`instances: "${value.slice(0, 40)}" is not one of ${INSTANCE_MODES.join(", ")}; using ask`);
    }
  }
  return { instances, warnings };
}

function readText(path: string): { text: string } | { missing: true } | { problem: string } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { missing: true }
      : { problem: `cannot read ${path} (${code ?? "error"}); using the defaults` };
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { problem: `cannot read ${path}: not a file; using the defaults` };
    if (stats.size > MAX_BYTES)
      return { problem: `cannot read ${path}: larger than ${MAX_BYTES} bytes; using the defaults` };
    const buffer = Buffer.alloc(stats.size);
    readSync(fd, buffer, 0, stats.size, 0);
    return { text: buffer.toString("utf8") };
  } catch (error) {
    return { problem: `cannot read ${path} (${(error as NodeJS.ErrnoException).code ?? "error"}); using the defaults` };
  } finally {
    closeSync(fd);
  }
}

/** The person's preferences; never throws. */
export function readPreferences(env: Env = process.env): Preferences {
  const path = preferencesPath(env);
  const read = readText(path);
  if ("missing" in read) return { instances: "ask", warnings: [], path, exists: false };
  if ("problem" in read) return { instances: "ask", warnings: [read.problem], path, exists: true };
  return { ...parsePreferences(read.text), path, exists: true };
}

const TEMPLATE = (mode: InstancesMode): string => `---
instances: ${mode}
---
# Archer preferences

Notes for agents, in the person's own words: when to reuse a running Archer and when to start a
fresh one. Archer reads only the front matter above (\`instances: ask | reuse-main | reuse-any\`);
agents follow the rest. A project's \`.archer/user_preferences.md\` wins over this note for that
project.

## Notes

`;

/**
 * Sets `key` to `value` in the front matter and appends a dated one-line note, keeping every
 * other line of the person's text. Throws on an unknown key or value.
 */
export function setPreference(env: Env, key: string, value: string, note?: string, now = new Date()): Preferences {
  if (key !== "instances")
    throw new Error(`unknown preference "${key.slice(0, 40)}"; the one Archer reads is instances`);
  if (!isMode(value)) throw new Error(`instances must be one of ${INSTANCE_MODES.join(", ")}`);
  const path = preferencesPath(env);
  ensurePrivateDir(archerHome(env));
  const read = readText(path);
  if ("problem" in read) throw new Error(read.problem.replace(/; using the defaults$/, ""));
  let text: string;
  if ("missing" in read) text = TEMPLATE(value);
  else {
    const lines = read.text.split("\n");
    const found = frontMatter(lines);
    if (found === null || found === "unterminated") text = `---\ninstances: ${value}\n---\n${read.text}`;
    else {
      // One instances line, where the first one was: parsing takes the last, so none may remain after it.
      const isFlag = (line: string): boolean => /^\s*instances\s*:/.test(line);
      const at = lines.slice(1, found.end).findIndex(isFlag);
      const flag = `instances: ${value}${at >= 0 && lines[at + 1]!.endsWith("\r") ? "\r" : ""}`;
      const matter = lines.slice(1, found.end).filter((line) => !isFlag(line));
      matter.splice(at < 0 ? 0 : at, 0, flag);
      text = [lines[0]!, ...matter, ...lines.slice(found.end)].join("\n");
    }
  }
  const oneLine = note?.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS) ?? "";
  const line = `- ${now.toISOString().slice(0, 10)} instances: ${value}${oneLine === "" ? "" : ` — ${oneLine}`}\n`;
  text = `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}`;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
  return readPreferences(env);
}
