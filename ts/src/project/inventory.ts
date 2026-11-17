// What the Archer folder holds: diagrams (`.mmd`) and notes (`.md`), and
// which diagrams each note is about (ticket 09). Entries whose name starts
// with "." are skipped, and a link is followed only to a file inside the
// folder, never into a directory.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { ProjectError } from "./errors.ts";
import { ConfinedTooLarge } from "./confined-fs.ts";
import { readInFolder, realOf, within, type Project, type View } from "./project.ts";

export interface DiagramEntry {
  /** Relative to the Archer folder, `/`-separated. */
  readonly path: string;
  /** The archer.toml view whose source this is, if any. */
  readonly view?: View;
}

export interface FrontMatter {
  readonly type?: string;
  readonly status?: string;
  /** `agent` for a note the agent wrote as its own document (ADR 0012): the agent may restructure it. */
  readonly author?: string;
  readonly diagrams?: readonly string[];
  /** What the note is about, in a sentence or two (`describe.ts`). */
  readonly description?: string;
  /** `based-on: <view id>@<revision>`: the note is an elaborated copy of that view (ADR 0036 §1, A1). */
  readonly basedOn?: string;
}

export interface NoteEntry {
  readonly path: string;
  readonly type?: string;
  readonly status?: string;
  /** The diagrams the note is about, folder-relative, sorted. */
  readonly diagrams: readonly string[];
  /** What could not be read or followed, in sentences. */
  readonly problems: readonly string[];
}

/** Notes past this size are listed but not read. */
export const MAX_NOTE_BYTES = 1024 * 1024;

/** One pass over the folder: the paths ending in each of `extensions`, sorted. */
function walkAll(project: Project, extensions: readonly string[]): string[][] {
  const found = extensions.map((): string[] => []);
  if (!existsSync(project.folder)) return found;
  const folderReal = realOf(project.folder);
  const visit = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      // A folder below the top renamed or removed while the walk runs is simply not there any more.
      if (
        prefix !== "" &&
        ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR")
      )
        return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(path, rel);
      else if (entry.isFile()) {
        extensions.forEach((extension, index) => {
          if (entry.name.endsWith(extension)) found[index]!.push(rel);
        });
      } else if (entry.isSymbolicLink()) {
        extensions.forEach((extension, index) => {
          if (!entry.name.endsWith(extension)) return;
          const real = realOf(path);
          if (within(folderReal, real) && existsSync(real) && statSync(real).isFile()) found[index]!.push(rel);
        });
      }
    }
  };
  visit(project.folder, "");
  return found.map((paths) => paths.sort());
}

function walk(project: Project, extension: string): string[] {
  return walkAll(project, [extension])[0]!;
}

export function listDiagrams(project: Project): DiagramEntry[] {
  const views = new Map(project.views.map((v) => [v.source, v]));
  return walk(project, ".mmd").map((path) => {
    const view = views.get(path);
    return view === undefined ? { path } : { path, view };
  });
}

/** The folder is walked once for both kinds of file. */
export function listNotes(project: Project): NoteEntry[] {
  const [mmd, md] = walkAll(project, [".mmd", ".md"]) as [string[], string[]];
  const diagrams = new Set(mmd);
  // Looked up per note: by name (a front-matter entry) and by folder (a note without entries).
  const index: DiagramIndex = { all: diagrams, byName: new Map(), byDir: new Map() };
  for (const d of mmd) {
    for (const [map, key] of [
      [index.byName, posix.basename(d, ".mmd")],
      [index.byDir, posix.dirname(d)],
    ] as const) {
      const held = map.get(key);
      if (held === undefined) map.set(key, [d]);
      else held.push(d);
    }
  }
  return md.map((path) => readNote(project, path, index));
}

interface DiagramIndex {
  readonly all: ReadonlySet<string>;
  readonly byName: Map<string, string[]>;
  readonly byDir: Map<string, string[]>;
}

function readNote(project: Project, path: string, index: DiagramIndex): NoteEntry {
  const diagrams = index.all;
  const problems: string[] = [];
  let text = "";
  try {
    // The confined seam (G6): no link followed, one name, read from the descriptor.
    text = readInFolder(project, path, MAX_NOTE_BYTES).toString("utf8");
  } catch (error) {
    if (error instanceof ConfinedTooLarge) problems.push(`the note is over ${MAX_NOTE_BYTES} bytes and was not read`);
    // Listed, but refused (a hard link, or swapped for a link since the walk): say why and read nothing.
    else if (error instanceof ProjectError) problems.push(error.message);
    else
      throw new ProjectError(
        "io_error",
        `cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
      );
  }
  const { fields, problems: frontProblems, body } = splitFrontMatter(text);
  problems.push(...frontProblems);
  const dir = posix.dirname(path);
  const about = new Set<string>();
  const follow = (what: "diagram" | "link", target: string): void => {
    const joined = posix.normalize(posix.join(dir, target));
    if (target.startsWith("/") || joined === ".." || joined.startsWith("../"))
      problems.push(`${what} ${target} is outside the Archer folder`);
    else if (diagrams.has(joined)) about.add(joined);
    else if (what === "diagram" && diagrams.has(`${joined}.mmd`)) about.add(`${joined}.mmd`);
    else {
      // A front-matter entry may name a diagram the way Archer shows it: by
      // name, without `.mmd`, from anywhere in the folder, when that name is
      // unique. Body links stay relative paths, as Markdown reads them.
      const name = target.replace(/\.mmd$/, "");
      const matches = what === "diagram" && !name.includes("/") ? (index.byName.get(name) ?? []) : [];
      if (matches.length === 1 && matches[0] !== undefined) about.add(matches[0]);
      else if (matches.length > 1)
        problems.push(`${what} ${target} names more than one diagram (${matches.join(", ")}); give its path`);
      else problems.push(`${what} ${target} does not exist`);
    }
  };
  const named = fields.diagrams ?? [];
  if (named.length > 0) for (const target of named) follow("diagram", target);
  else for (const d of index.byDir.get(dir) ?? []) about.add(d);
  for (const target of mmdLinks(body)) follow("link", target);

  return {
    path,
    ...(fields.type === undefined ? {} : { type: fields.type }),
    ...(fields.status === undefined ? {} : { status: fields.status }),
    diagrams: [...about].sort(),
    problems,
  };
}

/** The `.mmd` targets of Markdown links in a note's body, outside code fences. */
function mmdLinks(body: string): string[] {
  const targets: string[] = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const raw = [...inlineTargets(line), ...referenceTarget(line)];
    for (const link of raw) {
      let target = cut(link, "#?");
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || !target.endsWith(".mmd")) continue;
      try {
        target = decodeURIComponent(target);
      } catch {
        // Kept as written.
      }
      targets.push(target);
    }
  }
  return targets;
}

// The scans below are linear in the line's length, whatever it holds: a note
// is untrusted text, and a backtracking pattern over it can take minutes.

/** `text` up to the first of `stops`. */
function cut(text: string, stops: string): string {
  for (let i = 0; i < text.length; i++) if (stops.includes(text[i] ?? "")) return text.slice(0, i);
  return text;
}

const isSpace = (c: string | undefined): boolean => c === " " || c === "\t";

/** Targets of inline links, `[text](target "title")` or `[text](<target>)`. */
export function inlineTargets(line: string): string[] {
  const targets: string[] = [];
  let at = line.indexOf("](");
  while (at >= 0) {
    let i = at + 2;
    while (isSpace(line[i])) i++;
    let end: number;
    if (line[i] === "<") {
      const close = line.indexOf(">", i);
      // No `>` anywhere after this: no later `<…>` target can close either.
      if (close < 0) break;
      targets.push(line.slice(i + 1, close));
      end = close + 1;
    } else {
      end = i;
      while (end < line.length && line[end] !== ")" && !isSpace(line[end])) end++;
      if (end > i) targets.push(line.slice(i, end));
    }
    at = line.indexOf("](", Math.max(end, at + 2));
  }
  return targets;
}

/** The target of a reference definition, `[label]: target`. */
export function referenceTarget(line: string): string[] {
  let i = 0;
  while (i < 3 && line[i] === " ") i++;
  if (line[i] !== "[") return [];
  const close = line.indexOf("]", i + 1);
  if (close <= i + 1 || line[close + 1] !== ":") return [];
  let start = close + 2;
  while (isSpace(line[start])) start++;
  if (line[start] === "<") {
    const end = line.indexOf(">", start);
    return end < 0 ? [] : [line.slice(start + 1, end)];
  }
  let end = start;
  while (end < line.length && !isSpace(line[end])) end++;
  return end > start ? [line.slice(start, end)] : [];
}

/** A note's front matter: the fields Archer reads, and what it could not read. */
export function readFrontMatter(text: string): { fields: FrontMatter; problems: string[] } {
  const { fields, problems } = splitFrontMatter(text);
  return { fields, problems };
}

const KNOWN = new Set(["type", "status", "diagrams", "author", "description", "based-on"]);

/** A note's front matter, what could not be read of it, and the Markdown after it. */
export function splitFrontMatter(text: string): { fields: FrontMatter; problems: string[]; body: string } {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return { fields: {}, problems: [], body: text };
  const close = lines.findIndex((l, i) => i > 0 && (l.trimEnd() === "---" || l.trimEnd() === "..."));
  if (close < 0)
    return { fields: {}, problems: ["the front matter has no closing --- line, so it was not read"], body: text };

  const problems: string[] = [];
  const values = new Map<string, string | string[]>();
  let current: string | null = null;
  for (let i = 1; i < close; i++) {
    const line = lines[i] ?? "";
    const n = i + 1;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const pair = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?$/.exec(line.trimEnd());
    if (pair?.[1] !== undefined) {
      current = pair[1];
      const value = (pair[2] ?? "").trim();
      if (KNOWN.has(current)) values.set(current, value === "" ? [] : parseValue(value));
      continue;
    }
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (current === null) {
      problems.push(`front matter line ${n} belongs to no field: "${line.trim()}"`);
      continue;
    }
    if (!KNOWN.has(current)) continue;
    const list = values.get(current);
    if (item?.[1] !== undefined && Array.isArray(list)) list.push(scalar(item[1]));
    else problems.push(`front matter line ${n} cannot be read as part of "${current}": "${line.trim()}"`);
  }

  const fields: {
    type?: string;
    status?: string;
    author?: string;
    description?: string;
    diagrams?: string[];
    basedOn?: string;
  } = {};
  for (const [key, field] of [
    ["type", "type"],
    ["status", "status"],
    ["author", "author"],
    ["description", "description"],
    ["based-on", "basedOn"],
  ] as const) {
    const value = values.get(key);
    if (typeof value === "string") {
      if (value !== "") fields[field] = value;
    } else if (value !== undefined && value.length > 0) problems.push(`front matter "${key}" must be a single value`);
  }
  const diagrams = values.get("diagrams");
  if (diagrams !== undefined)
    fields.diagrams = (typeof diagrams === "string" ? [diagrams] : diagrams).filter((d) => d !== "");
  return { fields, problems, body: lines.slice(close + 1).join("\n") };
}

function parseValue(value: string): string | string[] {
  if (value.startsWith("[")) {
    const inner = value.endsWith("]") ? value.slice(1, -1) : value.slice(1);
    return inner.trim() === "" ? [] : inner.split(",").map((s) => scalar(s));
  }
  return scalar(value);
}

function scalar(raw: string): string {
  const value = raw.trim();
  const quoted = /^"(.*)"$|^'(.*)'$/.exec(value);
  if (quoted) return quoted[1] ?? quoted[2] ?? "";
  // A comment starts at a `#` after a space.
  for (let i = 1; i < value.length; i++)
    if (value[i] === "#" && isSpace(value[i - 1])) return value.slice(0, i).trimEnd();
  return value;
}
