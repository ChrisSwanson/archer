// A parse Mermaid refused, as a located diagnostic (research 01, "Error
// shape"). Jison reports where the last good token ended (`loc.last_line`,
// `loc.last_column`, 0-based column), which is where the offending token
// starts; the token text is in `hash.text` and the alternatives it would have
// taken in `hash.expected`.

import { error, type Diagnostic } from "./diagnostics.ts";
import type { MermaidFailure } from "./engine.ts";
import { sourcePosition } from "./preamble.ts";
import { lineSpan, type SourceLine } from "./source.ts";

/** Jison's names for tokens, as an author would write them. */
const TOKEN_NAMES: Record<string, string> = {
  SQE: "`]`",
  PE: "`)`",
  PS: "`(`",
  SQS: "`[`",
  DIAMOND_STOP: "`}`",
  PIPE: "`|`",
  NEWLINE: "end of line",
  EOF: "end of file",
  SEMI: "`;`",
  AMP: "`&`",
  STR: "a quoted string",
  NODE_STRING: "a node ID",
  TEXT: "text",
  LINK: "a link such as `-->`",
  LINK_ID: "an edge ID such as `e1@`",
  STYLE_SEPARATOR: "`:::`",
  ACTOR: "a participant",
};

function nameOf(token: string): string {
  return TOKEN_NAMES[token] ?? `\`${token}\``;
}

function expectedList(expected: unknown): string {
  if (!Array.isArray(expected)) return "";
  const names = expected
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/^'|'$/g, ""))
    .filter((item) => item in TOKEN_NAMES)
    .map(nameOf);
  const unique = [...new Set(names)].slice(0, 6);
  return unique.length === 0 ? "" : `; expected ${unique.join(", ")}`;
}

/**
 * Whether Mermaid's parser refused the text, as opposed to its database
 * refusing what the text says (an unmatched deactivation, say), which also
 * comes with a hash but with no real position.
 */
export function isParseError(failure: MermaidFailure): boolean {
  return failure.hash?.loc !== undefined && /^(Parse|Lexical) error/.test(failure.message);
}

function isEnd(token: unknown): boolean {
  return token === "EOF" || token === 1 || token === "1";
}

/**
 * The diagnostic for a failure, positioned in the original source. A
 * failure with no position (Mermaid threw something other than a parse
 * error) points at the header.
 */
export function diagnoseMermaidFailure(
  failure: MermaidFailure,
  header: SourceLine,
  lines: readonly SourceLine[],
): Diagnostic {
  const loc = isParseError(failure) ? failure.hash?.loc : undefined;
  if (!loc) {
    return error(
      "unexpected_token",
      `Mermaid could not read this diagram: ${failure.message.split("\n")[0] ?? ""}`,
      header.statementSpan(),
    );
  }
  const token = failure.hash?.token;
  if (isEnd(token)) {
    // Jison reports the end of the source; the statement left open is the
    // one its last good token was in.
    const opened = sourcePosition(header, loc.first_line, loc.first_column);
    const openedLine = lines[opened.line - 1];
    const at = openedLine ? openedLine.statementSpan() : lineSpan(lines, Math.min(opened.line, lines.length));
    return error(
      "unexpected_end",
      `the source ends before the statement on line ${at.start.line} is finished${expectedList(failure.hash?.expected)}`,
      at,
    );
  }
  const { line, index: reported } = sourcePosition(header, loc.last_line, loc.last_column);
  const sourceLine = lines[line - 1];
  const text = typeof failure.hash?.text === "string" ? failure.hash.text : "";
  const found = typeof token === "string" ? nameOf(token) : "this";
  const message = `Mermaid cannot read line ${line} here: found ${found}${expectedList(failure.hash?.expected)}`;
  if (!sourceLine) return error("unexpected_token", message, lineSpan(lines, line));
  const index = Math.min(reported, sourceLine.text.length);
  const trailingComment = sourceLine.text.slice(index).startsWith("%%");
  return error(
    "unexpected_token",
    trailingComment
      ? "Mermaid has no comment after a statement in a flowchart: put the comment on its own line"
      : message,
    sourceLine.span(index, index + Math.max(text.length, 1)),
  );
}

/**
 * The scan's diagnostics after Mermaid refused the source, with Mermaid's own
 * complaint added only where the scan has nothing to say: Mermaid stops at
 * the first problem, the scan names each with its fix. A complaint with no
 * real position, or about the end of the source, is explained by any error
 * the scan found.
 */
export function addMermaidFailure(
  scanned: readonly Diagnostic[],
  failure: MermaidFailure,
  header: SourceLine,
  lines: readonly SourceLine[],
): Diagnostic[] {
  const complaint = diagnoseMermaidFailure(failure, header, lines);
  const located = isParseError(failure) && complaint.code !== "unexpected_end";
  const explained = scanned.some(
    (diagnostic) =>
      diagnostic.severity === "error" && (!located || diagnostic.span.start.line === complaint.span.start.line),
  );
  return explained ? [...scanned] : [...scanned, complaint];
}
