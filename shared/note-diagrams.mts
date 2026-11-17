/**
 * The Mermaid diagrams embedded in a note (docs/proposals/notes-with-embedded-diagrams.md).
 *
 * Every ```` ```mermaid ```` fence is a diagram that opens with no setup. Its
 * name is, in order:
 *   - the `%% archer-id: <name>` line among the comment lines before its
 *     header, when it is a stable ID no earlier fence of the note claimed;
 *   - else the slug of the nearest heading above it, `-2`, `-3`, ... for the
 *     next fences under the same heading;
 *   - else `diagram-<n>`, n its place among the note's mermaid fences.
 * A derived name never takes one written explicitly anywhere in the note.
 *
 * Fences are found with markdown-it's own block tokens -- the parser that
 * draws the note -- so a fence inside another fence, an indented code block
 * or an HTML block is never mistaken for one. Line numbers are 1-based in the
 * text given.
 *
 * Only a fence at the top level whose body lines are exactly its content (no
 * list or blockquote prefix, no opening indent) and which is closed is offered
 * for writing back: splicing de-indented text into a nested block is how a
 * write corrupts a note.
 */
import MarkdownIt from "markdown-it";

const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });

/** The grammar of every Archer ID (`ts/src/model/ids.ts`). */
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SLUG_MAX = 100;
/** A heading's first characters are all a slug is made of. */
const HEADING_CHARS_READ = 400;
/** What is kept of a heading to show beside its diagrams. */
const HEADING_KEPT = 200;
/** Longer comment lines are never an id line: an ID is at most 128 characters. */
const ID_LINE_MAX = 512;

/**
 * The most diagrams one note offers, as many as archer.toml lists views
 * (`MAX_VIEWS`). A note is untrusted input read on the service's event loop;
 * past this the rest of its fences stay code, and a problem says so.
 */
export const MAX_NOTE_DIAGRAMS = 256;

export interface NoteDiagram {
  readonly name: string;
  /** Named by a `%% archer-id:` line, so the name survives reordering and heading edits. */
  readonly explicit: boolean;
  /** Its place among the note's mermaid fences, from 1. */
  readonly ordinal: number;
  /** The nearest heading above it, as text. */
  readonly heading: string | null;
  /** The fence's content: the Mermaid source. */
  readonly source: string;
  /** The opening fence's line. */
  readonly fenceLine: number;
  /** The first line of the body (the line after the opening fence). */
  readonly bodyLine: number;
  readonly bodyLineCount: number;
  readonly closed: boolean;
  readonly writable: boolean;
  /** The opening fence's run of backticks or tildes: a body line of at least as many closes it. */
  readonly fence: string;
  /**
   * For a block nested in a list or blockquote: the first line after the
   * top-level block that holds it, where `relocateDiagram` puts it.
   */
  readonly containerEndLine?: number;
}

export interface NoteDiagrams {
  readonly diagrams: NoteDiagram[];
  /** What was not taken as written, in sentences. */
  readonly problems: string[];
}

/** A heading's text as an ID: lower case, ASCII letters and digits joined by `-`, or null when nothing is left. */
export function slugOf(heading: string): string | null {
  // Every step is linear: the input is bounded first, the one regular
  // expression has no ambiguous tail, and the dashes are trimmed by hand.
  const words = heading
    .slice(0, HEADING_CHARS_READ)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  let start = 0;
  let end = words.length;
  while (start < end && words[start] === "-") start++;
  while (end > start && words[end - 1] === "-") end--;
  let slug = words.slice(start, end).slice(0, SLUG_MAX);
  while (slug.endsWith("-")) slug = slug.slice(0, -1);
  return slug === "" ? null : slug;
}

/**
 * The `%% archer-id:` value among the comment lines before the header, if
 * any. Read by hand, not by a regular expression: a lazy capture before a
 * `\s*$` tail backtracks quadratically on a long run of spaces.
 */
export function archerIdOf(source: string): string | null {
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("%%")) return null;
    if (trimmed.length > ID_LINE_MAX) continue;
    const rest = trimmed.slice(2).trimStart();
    if (!rest.startsWith("archer-id")) continue;
    const after = rest.slice("archer-id".length).trimStart();
    if (after.startsWith(":")) return after.slice(1).trim();
  }
  return null;
}

type Token = ReturnType<InstanceType<typeof MarkdownIt>["parse"]>[number];

function headingText(inline: Token | undefined): string {
  if (inline === undefined) return "";
  const children = inline.children ?? [];
  return children.length === 0
    ? inline.content
    : children.map((c) => (c.type === "text" || c.type === "code_inline" ? c.content : "")).join("");
}

interface Found {
  readonly ordinal: number;
  readonly heading: string | null;
  readonly source: string;
  readonly fenceLine: number;
  readonly bodyLine: number;
  readonly bodyLineCount: number;
  readonly closed: boolean;
  readonly writable: boolean;
  readonly fence: string;
  readonly containerEndLine?: number;
  readonly archerId: string | null;
}

/** `line` without the `>` markers of the blockquotes it is in. */
function withoutQuotes(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  let rest = line;
  for (let m = /^ {0,3}> ?/.exec(rest); m !== null; m = /^ {0,3}> ?/.exec(rest)) rest = rest.slice(m[0].length);
  return rest;
}

function closesFence(line: string | undefined, markup: string): boolean {
  if (line === undefined) return false;
  const trimmed = line.trim();
  const char = markup[0] ?? "`";
  let run = 0;
  while (trimmed[run] === char) run++;
  return run >= markup.length && run === trimmed.length;
}

export function noteDiagrams(markdown: string): NoteDiagrams {
  const tokens = parser.parse(markdown, {});
  const lines = markdown.split(/\r?\n/);
  const found: Found[] = [];
  let capped = false;
  let heading: string | null = null;
  let container: Token | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.level === 0 && token.nesting === 1) container = token;
    if (token.type === "heading_open") {
      heading = headingText(tokens[i + 1])
        .trim()
        .slice(0, HEADING_KEPT);
      continue;
    }
    if (token.type !== "fence" || token.map === null) continue;
    const lang = token.info.trim().split(/\s+/, 1)[0] ?? "";
    if (lang.toLowerCase() !== "mermaid") continue;
    if (found.length === MAX_NOTE_DIAGRAMS) {
      capped = true;
      break;
    }
    const [open, end] = token.map;
    const nested = token.level > 0;
    // A nested block's closing line carries its container's prefix (`> `, or a list's indent).
    const closed = end - 1 > open && closesFence(nested ? withoutQuotes(lines[end - 1]) : lines[end - 1], token.markup);
    const bodyEnd = closed ? end - 1 : end;
    const raw = lines
      .slice(open + 1, bodyEnd)
      .map((l) => `${l}\n`)
      .join("");
    found.push({
      ordinal: found.length + 1,
      heading: heading === "" ? null : heading,
      source: token.content,
      fenceLine: open + 1,
      bodyLine: open + 2,
      bodyLineCount: bodyEnd - (open + 1),
      closed,
      writable: closed && token.level === 0 && raw === token.content,
      fence: token.markup,
      ...(nested && container?.map ? { containerEndLine: container.map[1] + 1 } : {}),
      archerId: archerIdOf(token.content),
    });
  }

  const problems: string[] = [];
  if (capped)
    problems.push(
      `the note has more than ${MAX_NOTE_DIAGRAMS} mermaid diagrams; only the first ${MAX_NOTE_DIAGRAMS} are offered as diagrams, and the rest stay code`,
    );
  const taken = new Map<string, number>();
  const explicit = new Set<number>();
  for (const f of found) {
    if (f.archerId === null) continue;
    if (!STABLE_ID.test(f.archerId)) {
      problems.push(
        `line ${f.fenceLine}: "${f.archerId.slice(0, 200)}" is not a diagram name (letters, digits, "-" and "_", starting with a letter or digit, at most 128 characters); the diagram is named as if it had none`,
      );
      continue;
    }
    const first = taken.get(f.archerId);
    if (first !== undefined) {
      problems.push(
        `line ${f.fenceLine}: "${f.archerId}" already names the diagram at line ${first}; this one is named as if it had none`,
      );
      continue;
    }
    taken.set(f.archerId, f.fenceLine);
    explicit.add(f.ordinal);
  }

  // Each base keeps the next suffix to try, so naming N fences under one
  // heading is linear, not N²/2: a suffix is passed over only when it is
  // taken, and each taken name is in one base's run of suffixes at most.
  const nextSuffix = new Map<string, number>();
  const slugs = new Map<string, string | null>();
  const diagrams = found.map((f): NoteDiagram => {
    let name: string;
    if (explicit.has(f.ordinal)) name = f.archerId!;
    else {
      let slug: string | null = null;
      if (f.heading !== null) {
        if (!slugs.has(f.heading)) slugs.set(f.heading, slugOf(f.heading));
        slug = slugs.get(f.heading) ?? null;
      }
      const base = slug ?? `diagram-${f.ordinal}`;
      name = base;
      if (taken.has(name)) {
        let n = nextSuffix.get(base) ?? 2;
        while (taken.has(`${base}-${n}`)) n++;
        name = `${base}-${n}`;
        nextSuffix.set(base, n + 1);
      }
      taken.set(name, f.fenceLine);
    }
    const { archerId: _id, ...rest } = f;
    return { ...rest, name, explicit: explicit.has(f.ordinal) };
  });
  return { diagrams, problems };
}

/** `notes/auth.md` and `login-flow` -> `notes/auth.md#login-flow`. */
export function diagramAddress(notePath: string, name: string): string {
  return `${notePath}#${name}`;
}

/** An address is at most this long (ADR 0012). */
export const MAX_ADDRESS_CHARS = 1200;

const SEGMENT_FIRST = "[^.\\\\/#?:\\u0000-\\u001f\\u007f]";
const SEGMENT_REST = "[^\\\\/#?:\\u0000-\\u001f\\u007f]";
/**
 * A diagram address, `<note path>#<name>` (ADR 0012), as the envelope
 * schema states it: segments that never start with `.` and hold no `/`, `\`,
 * `#`, `?`, `:` or control character, the last ending `.md`, then `#` and a
 * stable ID. Each segment's characters exclude its delimiter, so a match is
 * linear in the address's length.
 */
export const DIAGRAM_ADDRESS_SOURCE = `^(?:${SEGMENT_FIRST}${SEGMENT_REST}*/)*${SEGMENT_FIRST}${SEGMENT_REST}*\\.md#[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`;
export const DIAGRAM_ADDRESS_PATTERN = new RegExp(DIAGRAM_ADDRESS_SOURCE, "u");

/** Whether `raw` is a diagram address (ADR 0012). */
export function isDiagramAddress(raw: string): boolean {
  return typeof raw === "string" && raw.length <= MAX_ADDRESS_CHARS && DIAGRAM_ADDRESS_PATTERN.test(raw);
}

/**
 * The note and name an address names, or null when it is not one (ADR
 * 0012): a folder-relative `.md` path that stays inside the Archer folder,
 * `#`, and a stable ID.
 */
export function parseDiagramAddress(raw: string): { notePath: string; name: string } | null {
  if (!isDiagramAddress(raw)) return null;
  const hash = raw.lastIndexOf("#");
  return { notePath: raw.slice(0, hash), name: raw.slice(hash + 1) };
}

/** `source` with a `%% archer-id: <name>` first line, unless it names itself already. */
export function pinName(source: string, name: string): string {
  return archerIdOf(source) === null ? `%% archer-id: ${name}\n${source}` : source;
}

/**
 * `markdown` with `diagram`'s body replaced by `source`, and the diagram's
 * name pinned with a `%% archer-id:` line unless `source` carries one. Every
 * other line, and the note's line ending, is kept as it was.
 */
export function replaceDiagramBody(markdown: string, diagram: NoteDiagram, source: string): string {
  if (!diagram.closed)
    throw new Error(
      `the diagram "${diagram.name}" has no closing fence, so Archer cannot write it back; close the fence first`,
    );
  if (!diagram.writable)
    throw new Error(
      `the diagram "${diagram.name}" is nested in a list or blockquote (or indented), so Archer cannot write it back without changing the note around it; move it to the top level of the note`,
    );
  // Every line with its own ending, so a note that mixes them keeps each.
  const lines = markdown.split(/(?<=\n)/);
  const start = diagram.bodyLine - 1;
  const ending = (line: string | undefined): string => (line?.endsWith("\r\n") ? "\r\n" : "\n");
  const bare = (line: string): string => line.replace(/\r?\n$/, "");
  const current = lines
    .slice(start, start + diagram.bodyLineCount)
    .map((l) => `${bare(l)}\n`)
    .join("");
  if (current !== diagram.source) throw new Error(`the diagram "${diagram.name}" changed in the note; read it again`);
  const text = pinName(source.replace(/\r\n?/g, "\n"), diagram.name);
  const body = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const closer = body.findIndex((line) => wouldClose(line, diagram.fence));
  if (closer >= 0)
    throw new Error(
      `line ${closer + 1} of the new source ("${body[closer]!.trim().slice(0, 40)}") would close its fence early and turn the rest of the note into something else; a diagram's source cannot hold a line of ${diagram.fence.length} or more ${diagram.fence[0] === "~" ? "tildes" : "backticks"} alone`,
    );
  const eol = ending(lines[diagram.fenceLine - 1]);
  const next = [
    ...lines.slice(0, start),
    ...body.map((line) => line + eol),
    ...lines.slice(start + diagram.bodyLineCount),
  ].join("");
  // Read back: the fence must be where it was, holding exactly the new body, still closed.
  const again = noteDiagrams(next).diagrams.find((d) => d.fenceLine === diagram.fenceLine);
  if (again === undefined || !again.closed || again.source !== `${body.join("\n")}\n`)
    throw new Error(`the new source of "${diagram.name}" would change the note around its fence; nothing was written`);
  return next;
}

/** Whether `line` would close a fence opened with `fence` (CommonMark: up to 3 spaces, then at least as many of its character, then only spaces). */
function wouldClose(line: string, fence: string): boolean {
  let indent = 0;
  while (line[indent] === " ") indent++;
  return indent <= 3 && closesFence(line.slice(indent), fence);
}

/**
 * `markdown` with a block nested in a list or blockquote moved to the top
 * level, just below the top-level block that held it, as `source` with its
 * name pinned. Its lines leave the container; every other line is kept as it
 * was. For the agent only when the note is its own or the person asked
 * (write_diagram's `relocate`): it restructures the note.
 */
export function relocateDiagram(markdown: string, diagram: NoteDiagram, source: string): string {
  if (diagram.containerEndLine === undefined)
    throw new Error(`the diagram "${diagram.name}" is already at the top level of the note; write it in place`);
  if (!diagram.closed)
    throw new Error(
      `the diagram "${diagram.name}" has no closing fence, so Archer cannot tell where it ends; close the fence first`,
    );
  const lines = markdown.split(/(?<=\n)/);
  const eol = lines[diagram.fenceLine - 1]?.endsWith("\r\n") ? "\r\n" : "\n";
  const text = pinName(source.replace(/\r\n?/g, "\n"), diagram.name);
  const body = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  const closer = body.findIndex((line) => wouldClose(line, diagram.fence));
  if (closer >= 0)
    throw new Error(
      `line ${closer + 1} of the new source would close its fence early; a diagram's source cannot hold a line of ${diagram.fence.length} or more ${diagram.fence[0] === "~" ? "tildes" : "backticks"} alone`,
    );
  // The block's own lines: its opening fence, body and closing fence.
  const from = diagram.fenceLine - 1;
  const count = diagram.bodyLineCount + 2;
  const kept = [...lines.slice(0, from), ...lines.slice(from + count)];
  let at = diagram.containerEndLine - 1 - count;
  const blank = (line: string | undefined): boolean => line === undefined || line.trim() === "";
  const ensureEnd = (line: string): string => (line.endsWith("\n") ? line : line + eol);
  if (at > 0 && !kept[at - 1]!.endsWith("\n")) kept[at - 1] = ensureEnd(kept[at - 1]!);
  const block = [
    ...(blank(kept[at - 1]) ? [] : [eol]),
    `${diagram.fence}mermaid${eol}`,
    ...body.map((line) => line + eol),
    `${diagram.fence}${eol}`,
    ...(blank(kept[at]) && at < kept.length ? [] : [eol]),
  ];
  if (at > kept.length) at = kept.length;
  const next = [...kept.slice(0, at), ...block, ...kept.slice(at)].join("");
  const moved = noteDiagrams(next).diagrams.find((d) => d.name === diagram.name && d.explicit);
  if (moved === undefined || !moved.writable)
    throw new Error(`moving "${diagram.name}" to the top level would change the note around it; nothing was written`);
  return next;
}
