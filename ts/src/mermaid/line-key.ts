// Line patterns and what they mean (ADR 0030).
//
// A line may be dotted, dashed or (as a last resort) dash-dot only when it
// means something the other lines don't, and the author says what in a comment
// Mermaid ignores and Archer reads:
//
//   %% archer-key dashed: Person to system
//
// A flowchart gives a line its pattern in Mermaid's own syntax (`-.->`, `==>`,
// or `class e1 dashed` with a matching `classDef`), so other renderers draw
// the same line. C4, architecture and state diagrams have no such syntax, so
// there the author names the lines too:
//
//   %% archer-line dashed: shopper--web, admin--web
//
// Sequence and ER diagrams already give their dashes a meaning (a reply; a
// non-identifying relationship), so a pattern of the author's is refused there.
// Archer never invents a meaning: a pattern with no `archer-key` is drawn, and
// its Key row says "meaning not stated".
//
// In a flowchart the same directive names an authored category (a `classDef`
// a node or group wears), for the Key and the drawing's legend:
//
//   %% archer-key gpu: Model server on a GPU
//
// A line pattern's name is the pattern's (`dashed`, …), whatever classDefs say;
// a built-in kind keeps its own word. Without a key a category is called by its
// class name, as written.

import { KINDS } from "./flowchart/adapt.ts";
import { KEY_PATTERNS, type DiagramModel, type EdgeLine, type KeyPattern, type LineKeyEntry } from "../model/index.ts";
import { error, span, warning, type Diagnostic, type Span } from "./diagnostics.ts";
import type { DiagramFamily } from "./preamble.ts";
import type { SourceLine } from "./source.ts";

/** The patterns an `archer-line` may give; `thick` is a flowchart's `==>`. */
export const LINE_PATTERNS = ["dotted", "dashed", "dashdot"] as const;
/** The dash a pattern class's `classDef` must declare, so plain Mermaid draws what Archer draws. */
export const CANONICAL_DASH: Readonly<Record<"dashed" | "dashdot", string>> = { dashed: "6 4", dashdot: "8 3 2 3" };
export const MAX_MEANING_WORDS = 4;
export const MAX_MEANING_CHARS = 32;
/**
 * A category's meaning names a thing rather than a line's relation ("Model server on a GPU", the owner's legend),
 * so it may take one word more; the 32 characters hold for both.
 */
export const MAX_CATEGORY_MEANING_WORDS = 5;

const DIRECTIVE = /^\s*%%\s*archer-(key|line)\b/;
// Greedy captures, trimmed in code: a lazy group before `\s*$` backtracks
// quadratically on a long line of spaces.
const KEY = /^\s*%%\s*archer-key\s+(\S+)\s*:(.*)$/;
const LINE = /^\s*%%\s*archer-line\s+(\S+)\s*:(.*)$/;
/** No valid directive is this long (a meaning is at most 32 characters); a longer one is refused unread. */
export const MAX_DIRECTIVE_CHARS = 512;
const BY_NOTATION: readonly DiagramFamily[] = ["sequence", "er", "journey"];
const NAMES_LINES: readonly DiagramFamily[] = ["c4", "architecture", "state"];

export interface LineDirectives {
  readonly keys: Map<KeyPattern, { meaning: string; at: Span }>;
  /** A flowchart's category meanings, by class name as written (`%% archer-key gpu: …`). */
  readonly categories: Map<string, { meaning: string; at: Span }>;
  readonly lines: { pattern: (typeof LINE_PATTERNS)[number]; ids: string[]; at: Span }[];
  readonly diagnostics: Diagnostic[];
}

const isKeyPattern = (value: string): value is KeyPattern => (KEY_PATTERNS as readonly string[]).includes(value);
const isLinePattern = (value: string): value is (typeof LINE_PATTERNS)[number] =>
  (LINE_PATTERNS as readonly string[]).includes(value);

/** Every `archer-key` and `archer-line` in the source, checked for form. */
export function readLineDirectives(lines: readonly SourceLine[], family: DiagramFamily | undefined): LineDirectives {
  const found: LineDirectives = { keys: new Map(), categories: new Map(), lines: [], diagnostics: [] };
  const refuse = (at: Span, code: string, message: string) => found.diagnostics.push(error(code, message, at));
  for (const line of lines) {
    const kind = DIRECTIVE.exec(line.text)?.[1];
    if (kind === undefined) {
      // A near miss of `archer-key` or `archer-line` is a typo, not silence. Other
      // `archer-` words (`archer-id`, and words other features add) are not ours.
      const word = /^\s*%%\s*archer-([A-Za-z]{1,8})\b/.exec(line.text)?.[1];
      const lower = word?.toLowerCase();
      // A directive is lowercase: `archer-KEY` is reported, not silently read or dropped.
      const meant =
        word === undefined || lower === "id"
          ? undefined
          : (["key", "line"] as const).find((w) => w !== word && levenshtein(lower!, w) <= (w === "key" ? 1 : 2));
      if (meant !== undefined && line.text.length <= MAX_DIRECTIVE_CHARS)
        refuse(
          line.statementSpan(),
          "line_directive_unknown",
          `\`archer-${word}\` is not a directive: did you mean \`archer-${meant}\`?`,
        );
      continue;
    }
    const at = line.statementSpan();
    if (line.text.length > MAX_DIRECTIVE_CHARS) {
      refuse(
        at,
        "line_directive_malformed",
        `an \`archer-${kind}\` line is at most ${MAX_DIRECTIVE_CHARS} characters: state a meaning in ${MAX_MEANING_WORDS} words, and split a long list of edges over several lines`,
      );
      continue;
    }
    if (family !== undefined && BY_NOTATION.includes(family)) {
      refuse(
        at,
        "line_pattern_by_notation",
        `\`archer-${kind}\` is not used in this diagram: its notation already says what its dashes mean (a reply, a non-identifying relationship). Remove the line`,
      );
      continue;
    }
    if (kind === "key") {
      const match = KEY.exec(line.text);
      if (match === null) {
        refuse(
          at,
          "line_directive_malformed",
          "write a key as `%% archer-key <pattern>: <what it means>`, e.g. `%% archer-key dashed: Person to system`",
        );
        continue;
      }
      const pattern = match[1] ?? "";
      const meaning = (match[2] ?? "").trim();
      if (!isKeyPattern(pattern) && family === "flowchart") {
        readCategoryKey(found, pattern, meaning, at);
        continue;
      }
      if (!isKeyPattern(pattern)) {
        refuse(
          at,
          "line_pattern_unknown",
          `unknown line pattern '${pattern.slice(0, 32)}': use dotted, dashed, dashdot (a last resort) or thick`,
        );
        continue;
      }
      if (!meaningFits(meaning)) {
        refuse(
          at,
          "line_meaning_text",
          `say what a ${pattern} line means in ${MAX_MEANING_WORDS} words or fewer (${MAX_MEANING_CHARS} characters), e.g. \`%% archer-key ${pattern}: Asynchronous\``,
        );
        continue;
      }
      if (found.keys.has(pattern)) {
        refuse(
          at,
          "line_key_repeated",
          `the ${pattern} line already has a meaning on line ${found.keys.get(pattern)!.at.start.line}: keep one \`archer-key ${pattern}\``,
        );
        continue;
      }
      found.keys.set(pattern, { meaning, at });
      continue;
    }
    if (family === "flowchart") {
      refuse(
        at,
        "line_directive_unsupported",
        "a flowchart gives a line its pattern in Mermaid's own syntax: `-.->` for dotted, or `class <edge ids> dashed` (or `dashdot`) with `classDef dashed stroke-dasharray: 6 4`. Remove the `archer-line`",
      );
      continue;
    }
    if (family !== undefined && !NAMES_LINES.includes(family)) continue;
    const match = LINE.exec(line.text);
    if (match === null) {
      refuse(
        at,
        "line_directive_malformed",
        "write it as `%% archer-line <pattern>: <edge id>, <edge id>`, e.g. `%% archer-line dashed: shopper--web`",
      );
      continue;
    }
    const pattern = match[1] ?? "";
    const list = (match[2] ?? "").trim();
    if (!isLinePattern(pattern)) {
      refuse(
        at,
        "line_pattern_unknown",
        `unknown line pattern '${pattern.slice(0, 32)}': use dotted, dashed or dashdot (a last resort)`,
      );
      continue;
    }
    const ids = list.split(",").map((id) => id.trim());
    if (ids.some((id) => id === "")) {
      refuse(
        at,
        "line_directive_malformed",
        "list the edges by id, separated by commas, with none empty: `%% archer-line dashed: a--b, c--d`",
      );
      continue;
    }
    found.lines.push({ pattern, ids, at });
  }
  return found;
}

const meaningFits = (meaning: string, words = MAX_MEANING_WORDS): boolean =>
  meaning !== "" && meaning.split(/\s+/).filter(Boolean).length <= words && [...meaning].length <= MAX_MEANING_CHARS;

/** A flowchart's `archer-key <name>: <meaning>` for a name that is not a line pattern: a category's meaning. */
function readCategoryKey(found: LineDirectives, name: string, meaning: string, at: Span): void {
  const shown = name.slice(0, 64);
  if (!meaningFits(meaning, MAX_CATEGORY_MEANING_WORDS)) {
    found.diagnostics.push(
      error(
        "category_meaning_text",
        `say what the ${shown} category means in ${MAX_CATEGORY_MEANING_WORDS} words or fewer (${MAX_MEANING_CHARS} characters), e.g. \`%% archer-key ${shown}: Model server on a GPU\``,
        at,
      ),
    );
    return;
  }
  const first = found.categories.get(name);
  if (first !== undefined) {
    found.diagnostics.push(
      error(
        "category_key_repeated",
        `the ${shown} category already has a meaning on line ${first.at.start.line}: keep one \`archer-key ${shown}\``,
        at,
      ),
    );
    return;
  }
  found.categories.set(name, { meaning, at });
}

/**
 * Give a flowchart's categories their authored meanings. A name the source declares no `classDef` for is an
 * error (with the nearest class), as is a built-in kind (it keeps its word); a declared class that nothing
 * wears has no row to name, which is a warning.
 */
function applyCategoryKeys(
  model: DiagramModel,
  keys: LineDirectives["categories"],
  classDefs: ReadonlySet<string>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const categories =
    model.type === "freeform-graph" || model.type === "architecture-graph" || model.type === "data-flow-graph"
      ? (model.categories ?? [])
      : [];
  const byName = new Map(categories.map((category) => [category.name, category]));
  for (const [name, { meaning, at }] of keys) {
    const shown = name.slice(0, 64);
    if ((KINDS as readonly string[]).includes(name)) {
      diagnostics.push(
        error(
          "category_key_kind",
          `${shown} is a built-in kind, and the Key calls it by its own word: remove the \`archer-key ${shown}\`, or give those nodes a category of your own`,
          at,
        ),
      );
      continue;
    }
    const category = byName.get(name);
    if (category !== undefined) {
      category.meaning = meaning;
      continue;
    }
    if (classDefs.has(name)) {
      diagnostics.push(
        warning(
          "category_key_unused",
          `the key says what the ${shown} category means, but no node or group wears it: remove the \`archer-key ${shown}\``,
          at,
        ),
      );
      continue;
    }
    const hint = nearest(name, [...classDefs, ...KEY_PATTERNS]);
    diagnostics.push(
      error(
        "key_target_unknown",
        `no line pattern or classDef '${shown}' in this diagram${hint === undefined ? ": a key names dotted, dashed, dashdot, thick or a category declared with `classDef`, exactly as written" : `: did you mean '${hint}'?`}`,
        at,
      ),
    );
  }
  return diagnostics;
}

/** The ids a family's edges carry, and a setter for each one's line. */
function edgesOf(model: DiagramModel): { id: string; line?: EdgeLine | undefined }[] {
  switch (model.type) {
    case "c4-model":
      return model.relationships;
    case "state-machine":
      return model.transitions;
    case "service-architecture":
      return model.edges;
    case "architecture-graph":
    case "data-flow-graph":
    case "freeform-graph":
      return model.edges;
    default:
      return [];
  }
}

function nearest(id: string, among: readonly string[]): string | undefined {
  let best: string | undefined;
  let distance = Infinity;
  for (const candidate of [...among].sort()) {
    const d = levenshtein(id.toLowerCase(), candidate.toLowerCase());
    if (d < distance) [best, distance] = [candidate, d];
  }
  return distance <= Math.max(2, Math.floor([...id].length / 3)) ? best : undefined;
}

function levenshtein(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  let previous = Array.from({ length: right.length + 1 }, (_, j) => j);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++)
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[right.length] ?? 0;
}

/**
 * Give the model its authored lines and key. Mutates `model` (it is the
 * compiler's own, not yet published) and returns the problems found; an
 * `archer-line` naming an edge the diagram does not have is an error.
 */
export function applyLineDirectives(
  model: DiagramModel,
  directives: LineDirectives,
  classDefs: ReadonlySet<string> = new Set(),
): Diagnostic[] {
  const diagnostics: Diagnostic[] = applyCategoryKeys(model, directives.categories, classDefs);
  const edges = edgesOf(model);
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  const assigned = new Map<string, number>();
  for (const { pattern, ids, at } of directives.lines) {
    for (const id of ids) {
      const edge = byId.get(id);
      if (edge === undefined) {
        const hint = nearest(id, [...byId.keys()]);
        diagnostics.push(
          error(
            "line_target_unknown",
            `no edge '${id.slice(0, 128)}' in this diagram${hint === undefined ? ": an edge's id is its two ends, as in `a--b`" : `: did you mean '${hint}'?`}`,
            at,
          ),
        );
        continue;
      }
      if (assigned.has(id)) {
        diagnostics.push(
          error(
            "line_pattern_repeated",
            `edge '${id}' already has a pattern from line ${assigned.get(id)}: give each edge one pattern`,
            at,
          ),
        );
        continue;
      }
      assigned.set(id, at.start.line);
      edge.line = pattern;
    }
  }
  if (
    directives.keys.size > 0 &&
    model.type !== "sequence-trace" &&
    model.type !== "user-journey" &&
    model.type !== "entity-relationship"
  ) {
    model.lineKey = [...directives.keys]
      .sort((a, b) => a[1].at.start.line - b[1].at.start.line)
      .map(([pattern, { meaning }]): LineKeyEntry => ({ pattern, meaning }));
  }
  return diagnostics;
}

/** Where `archer-key <pattern>` is declared in `source`, for a warning's span. */
function keyLine(source: string, pattern: string): number {
  const lines = source.split(/\r\n?|\n/);
  const index = lines.findIndex((line) => new RegExp(`^\\s*%%\\s*archer-key\\s+${pattern}\\b`).test(line));
  return index < 0 ? 1 : index + 1;
}

/** The reading rules for line patterns (warnings; `lint.ts` holds writers to them). */
export function lintLinePatterns(source: string, model: DiagramModel): { identity: string; diagnostic: Diagnostic }[] {
  const edges = edgesOf(model);
  if (edges.length === 0) return [];
  const used = new Map<KeyPattern, string[]>();
  for (const edge of edges) {
    const line = edge.line;
    if (line === undefined || line === "solid") continue;
    used.set(line, [...(used.get(line) ?? []), edge.id]);
  }
  const key = new Map(("lineKey" in model ? (model.lineKey ?? []) : []).map((entry) => [entry.pattern, entry.meaning]));
  const findings: { identity: string; diagnostic: Diagnostic }[] = [];
  const at = (line: number): Span => span(line, 1);
  for (const [pattern, ids] of used) {
    if (!key.has(pattern))
      // One finding per edge, so a write that adds an unexplained edge to an
      // already unexplained pattern still introduces something.
      for (const id of ids)
        findings.push({
          identity: `line_meaning_missing:${pattern}:${id}`,
          diagnostic: warning(
            "line_meaning_missing",
            `edge '${id}' is drawn ${pattern} with no stated meaning: add \`%% archer-key ${pattern}: <what it means>\`, or make it solid. Archer will not guess`,
            at(1),
          ),
        });
    if (ids.length === edges.length && edges.length > 1 && pattern !== "thick")
      findings.push({
        identity: `line_pattern_everywhere:${pattern}`,
        diagnostic: warning(
          "line_pattern_everywhere",
          `every line is ${pattern}, so the pattern distinguishes nothing: make them solid`,
          at(1),
        ),
      });
  }
  for (const pattern of key.keys())
    if (!used.has(pattern))
      findings.push({
        identity: `line_key_unused:${pattern}`,
        diagnostic: warning(
          "line_key_unused",
          `the key says what a ${pattern} line means, but no line is ${pattern}: remove the \`archer-key ${pattern}\``,
          at(keyLine(source, pattern)),
        ),
      });
  if (used.has("dashdot") && (!used.has("dotted") || !used.has("dashed")))
    findings.push({
      identity: "line_pattern_last_resort:dashdot",
      diagnostic: warning(
        "line_pattern_last_resort",
        `dash-dot is a last resort: use ${!used.has("dotted") ? "dotted" : "dashed"}, which no line uses yet`,
        at(keyLine(source, "dashdot")),
      ),
    });
  return findings;
}
