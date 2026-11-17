// Findings about how a flowchart line is written, each with the edit that
// fixes it: the old Archer forms Mermaid does not parse, and links outside
// the profile.

import { error } from "../diagnostics.ts";
import { moveCommentEdits, type Finding } from "../findings.ts";
import type { SourceLine } from "../source.ts";
import type { ShapeToken, Token } from "./lexer.ts";

/** Characters Mermaid does not take in an unquoted label. */
const NEEDS_QUOTES = /[()[\]{}"]/;

const QUOTE_MESSAGE = "Mermaid needs this label quoted: it holds parentheses, brackets, braces or quotes";

function quoted(label: string): string {
  return `"${label.replace(/"/g, "#quot;")}"`;
}

/** Rust read `%%` after a statement as a comment; Mermaid refuses it. */
export function trailingComment(line: SourceLine, at: number): Finding {
  return {
    line,
    diagnostic: error(
      "legacy_syntax",
      "Mermaid has no comment after a statement in a flowchart: put the comment on a line of its own",
      line.span(at, line.text.trimEnd().length),
    ),
    edits: moveCommentEdits(line, at),
    legacy: true,
  };
}

/** Rust took delimiters in an unquoted label; Mermaid needs the label quoted. */
export function legacyQuote(line: SourceLine, shape: ShapeToken): Finding | undefined {
  if (shape.quoted || !NEEDS_QUOTES.test(shape.raw)) return undefined;
  return {
    line,
    diagnostic: error("legacy_syntax", QUOTE_MESSAGE, line.span(shape.labelStart, shape.labelEnd)),
    edits: [{ start: shape.labelStart, end: shape.labelEnd, replacement: quoted(shape.raw.trim()) }],
    legacy: true,
  };
}

/** What is wrong with a link and its pipe label, if anything. */
export function linkFindings(
  line: SourceLine,
  token: Extract<Token, { kind: "link" | "text-link" }>,
  pipe: Extract<Token, { kind: "pipe" }> | undefined,
): Finding[] {
  const findings: Finding[] = [];
  const refuse = (message: string, replacement?: string) =>
    findings.push({
      line,
      diagnostic: error("unsupported_construct", message, line.span(token.start, token.end)),
      edits: replacement === undefined ? [] : [{ start: token.start, end: token.end, replacement }],
      legacy: false,
    });
  const op = token.op;
  const twoWay = op.startsWith("<");
  const family = (twoWay ? "<" : "") + (op.includes("=") ? "==>" : op.includes(".") ? "-.->" : "-->");
  if (token.kind === "text-link") {
    refuse(`link text goes between pipes after the link: \`${family}|${token.text}|\``, `${family}|${token.text}|`);
  } else if (twoWay && !op.endsWith(">")) {
    refuse(`a two-way link has an arrowhead at each end: write \`${family}\``, op.includes("~") ? undefined : family);
  } else if (twoWay) {
    // `<-->`, `<-.->`, `<==>` and their longer forms: one edge, drawn with an arrowhead at each end.
  } else if (op.startsWith("~")) {
    refuse("invisible links (`~~~`) are not supported: leave the nodes unlinked");
  } else if (op.endsWith("x") || op.endsWith("o")) {
    refuse(
      `cross and circle link ends are not supported: write \`${family}\` and say what the end meant in the label`,
      family,
    );
  } else if (!op.endsWith(">")) {
    refuse(`links without an arrowhead are not supported: every edge is directed, as in \`${family}\``, family);
  }
  if (!pipe) return findings;
  const content = pipe.quoted ? pipe.raw.trim().slice(1, -1).trim() : pipe.raw.trim();
  if (content === "") {
    findings.push({
      line,
      diagnostic: error(
        "expected_label",
        "an edge label between pipes is empty: write the label, or leave the pipes out",
        line.span(pipe.start, pipe.end),
      ),
      edits: [],
      legacy: false,
    });
  } else if (!pipe.quoted && NEEDS_QUOTES.test(content)) {
    findings.push({
      line,
      diagnostic: error("legacy_syntax", QUOTE_MESSAGE, line.span(pipe.start + 1, pipe.end - 1)),
      edits: [{ start: pipe.start + 1, end: pipe.end - 1, replacement: quoted(content) }],
      legacy: true,
    });
  }
  return findings;
}
