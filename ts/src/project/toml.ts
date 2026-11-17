// The part of TOML that archer.toml uses: top-level `key = value` pairs,
// `[table]` and `[[array of tables]]` headers, and values that are strings
// (basic or literal), integers or booleans. The covers field in [[views]],
// discovery's roots and exclude, the global file's `[agents] launcher` (an
// argv, ADR 0035 §8) and `delivery` in `[agents]` or a `[[projects]]` rule (the
// delivery order, ADR 0035 amended 2026-10-31) additionally accept a bounded string array. Anything else (other arrays, inline
// tables, multi-line strings, floats, dates, dotted keys) is refused with its
// line, so a manifest is never half-read.

export type TomlValue = string | number | boolean | TomlTable | TomlTable[] | string[];
export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`line ${line}: ${message}`);
  }
}

const BARE_KEY = /^[A-Za-z0-9_-]+/;
const ESCAPES: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

export function parseToml(text: string): TomlTable {
  const root: TomlTable = Object.create(null) as TomlTable;
  let table = root;
  // Tables defined by a header, so `[x]` twice is refused as TOML refuses it.
  const headers = new Set<string>();
  const arrays = new Set<string>();
  const viewTables = new WeakSet<TomlTable>();
  const projectTables = new WeakSet<TomlTable>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  lines.forEach((raw, index) => {
    const n = index + 1;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    if (line.startsWith("[")) {
      table = openTable(root, line, n, headers, arrays, viewTables, projectTables);
      return;
    }
    const reader = new LineReader(line, n);
    const key = reader.key();
    reader.skipSpace();
    if (reader.peek() === ".") throw new TomlError(n, `dotted keys such as "${key}.…" are not read in archer.toml`);
    if (!reader.eat("=")) throw new TomlError(n, `expected key = value`);
    reader.skipSpace();
    const discoveryArray = root["discovery"] === table && (key === "roots" || key === "exclude");
    const launcherArray = root["agents"] === table && key === "launcher";
    const deliveryArray = key === "delivery" && (root["agents"] === table || projectTables.has(table));
    const named = discoveryArray || launcherArray || deliveryArray;
    const value = reader.value((key === "covers" && viewTables.has(table)) || named, named ? key : "covers");
    reader.end();
    if (Object.hasOwn(table, key)) throw new TomlError(n, `"${key}" is set twice`);
    table[key] = value;
  });
  return root;
}

/** A top-level key written after a table header: TOML gives it to that table, not to the top level. */
export interface MisplacedKey {
  readonly line: number;
  /** The header as written, such as `[[views]]` or `[service]`. */
  readonly header: string;
  readonly headerLine: number;
  /** For a `[[name]]` header, which entry of that list it opens, counting from one. */
  readonly entry: number;
}

/**
 * The first line that sets `key` under a table header, or null (C-30): `edit = false` written after
 * `[[views]]` is that view's key, and must be reported rather than read as nothing. Runs on text
 * parseToml accepted, so every line is a header, a comment, blank or a one-line `key = value`.
 * `allowed`: the headers, as written without spaces (`[agents]`, `[[projects]]`), where the key belongs.
 */
export function misplacedKey(text: string, key: string, allowed: readonly string[] = []): MisplacedKey | null {
  let header: { text: string; line: number; entry: number } | null = null;
  const entries = new Map<string, number>();
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const text = line.replace(/\s*#.*$/u, "").replace(/\s+/gu, "");
      const entry = (entries.get(text) ?? 0) + 1;
      entries.set(text, entry);
      header = { text, line: index + 1, entry };
      continue;
    }
    if (header === null || allowed.includes(header.text)) continue;
    let name: string;
    try {
      name = new LineReader(line, index + 1).key();
    } catch {
      continue;
    }
    if (name === key) return { line: index + 1, header: header.text, headerLine: header.line, entry: header.entry };
  }
  return null;
}

/** The sentence that names a misplaced key's line and the fix. */
export function misplacedKeyMessage(key: string, at: MisplacedKey): string {
  return `line ${at.line}: \`${key}\` is under the ${at.header} header on line ${at.headerLine}, so TOML makes it that table's setting, not a top-level one; move it above the first [table] header`;
}

/** The sentence for a delivery key (C-33, X-19) written under a table other than the ones it belongs in. */
export function misplacedAgentsKeyMessage(key: string, at: MisplacedKey): string {
  return `line ${at.line}: \`${key}\` is under the ${at.header} header on line ${at.headerLine}, so TOML makes it that table's setting, not a delivery setting; move it under [agents]`;
}

function openTable(
  root: TomlTable,
  line: string,
  n: number,
  headers: Set<string>,
  arrays: Set<string>,
  viewTables: WeakSet<TomlTable>,
  projectTables: WeakSet<TomlTable>,
): TomlTable {
  const array = line.startsWith("[[");
  const match = (array ? /^\[\[\s*([A-Za-z0-9_-]+)\s*\]\]\s*(#.*)?$/ : /^\[\s*([A-Za-z0-9_-]+)\s*\]\s*(#.*)?$/).exec(
    line,
  );
  if (!match?.[1]) throw new TomlError(n, `"${line}" is not a table header archer.toml can read`);
  const name = match[1];
  const existing = root[name];
  const fresh: TomlTable = Object.create(null) as TomlTable;
  if (array) {
    if (existing === undefined) {
      root[name] = [fresh];
      arrays.add(name);
    } else if (arrays.has(name) && Array.isArray(existing)) (existing as TomlTable[]).push(fresh);
    else throw new TomlError(n, `"${name}" is already a value or a table, not a list of [[${name}]] tables`);
    if (name === "views") viewTables.add(fresh);
    if (name === "projects") projectTables.add(fresh);
    return fresh;
  }
  if (existing !== undefined || headers.has(name))
    throw new TomlError(n, `[${name}] is defined twice, or is already a value`);
  headers.add(name);
  root[name] = fresh;
  return fresh;
}

class LineReader {
  private at = 0;
  constructor(
    private readonly text: string,
    private readonly n: number,
  ) {}

  peek(): string | undefined {
    return this.text[this.at];
  }

  eat(c: string): boolean {
    if (this.text[this.at] !== c) return false;
    this.at++;
    return true;
  }

  skipSpace(): void {
    while (this.peek() === " " || this.peek() === "\t") this.at++;
  }

  key(): string {
    const c = this.peek();
    if (c === '"') return this.basicString();
    if (c === "'") return this.literalString();
    const bare = BARE_KEY.exec(this.text.slice(this.at))?.[0];
    if (!bare) throw new TomlError(this.n, "expected key = value");
    this.at += bare.length;
    return bare;
  }

  value(allowCoverage = false, arrayField = "covers"): TomlValue {
    const rest = this.text.slice(this.at);
    if (rest.startsWith('"""') || rest.startsWith("'''"))
      throw new TomlError(this.n, "multi-line strings are not read in archer.toml");
    const c = this.peek();
    if (c === '"') return this.basicString();
    if (c === "'") return this.literalString();
    if (c === "[") {
      if (allowCoverage) return this.coverageArray(arrayField);
      throw new TomlError(this.n, "arrays are not read in archer.toml except covers in [[views]]");
    }
    if (c === "{") throw new TomlError(this.n, "an inline table is not read in archer.toml; use a [table]");
    const word = /^[^\s#]+/.exec(rest)?.[0] ?? "";
    this.at += word.length;
    if (word === "true") return true;
    if (word === "false") return false;
    if (/^[+-]?(0|[1-9](_?[0-9])*)$/.test(word)) {
      const value = Number(word.replace(/_/g, ""));
      if (Number.isSafeInteger(value)) return value;
    }
    throw new TomlError(
      this.n,
      `"${word}" is not a value archer.toml can read (a quoted string, a whole number, true or false)`,
    );
  }

  private coverageArray(field: string): string[] {
    const out: string[] = [];
    this.at++;
    for (;;) {
      this.skipSpace();
      if (this.eat("]")) return out;
      if (out.length >= (field === "exclude" ? 128 : 64))
        throw new TomlError(this.n, `${field} holds at most ${field === "exclude" ? 128 : 64} paths/globs`);
      const c = this.peek();
      if (c !== '"' && c !== "'")
        throw new TomlError(
          this.n,
          `${field} holds only quoted ${field === "launcher" ? "arguments" : field === "delivery" ? "steps" : "paths/globs"}`,
        );
      out.push(c === '"' ? this.basicString() : this.literalString());
      this.skipSpace();
      if (this.eat("]")) return out;
      if (!this.eat(",")) throw new TomlError(this.n, `expected a comma or ] in ${field}`);
    }
  }

  end(): void {
    this.skipSpace();
    const c = this.peek();
    if (c !== undefined && c !== "#")
      throw new TomlError(this.n, `unexpected text after the value: "${this.text.slice(this.at)}"`);
  }

  private literalString(): string {
    const close = this.text.indexOf("'", this.at + 1);
    if (close < 0) throw new TomlError(this.n, "unterminated string");
    const value = this.text.slice(this.at + 1, close);
    this.at = close + 1;
    return value;
  }

  private basicString(): string {
    let out = "";
    this.at++;
    for (;;) {
      const c = this.text[this.at];
      if (c === undefined) throw new TomlError(this.n, "unterminated string");
      this.at++;
      if (c === '"') return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = this.text[this.at] ?? "";
      this.at++;
      const simple = ESCAPES[e];
      if (simple !== undefined) {
        out += simple;
        continue;
      }
      const digits = e === "u" ? 4 : e === "U" ? 8 : 0;
      const hex = this.text.slice(this.at, this.at + digits);
      const code = digits > 0 && /^[0-9A-Fa-f]+$/.test(hex) && hex.length === digits ? Number.parseInt(hex, 16) : -1;
      if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        throw new TomlError(this.n, `"\\${e}${hex}" is not a string escape TOML knows`);
      out += String.fromCodePoint(code);
      this.at += digits;
    }
  }
}
