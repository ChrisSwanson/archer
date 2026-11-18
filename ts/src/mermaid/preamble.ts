// What comes before the diagram's statements: YAML frontmatter, `%%{init}%%`
// directives, comments and the header. Also prepares the text Mermaid parses,
// with every line where it was in the source so Mermaid's positions map back.

import type { DiagramKind } from "../model/index.ts";
import { error, info, type Diagnostic } from "./diagnostics.ts";
import { isBlank, isCommentLine, splitLines, type SourceLine } from "./source.ts";

export type DiagramFamily = "flowchart" | "sequence" | "state" | "er" | "c4" | "architecture" | "journey";

/** The view kind a source of each family takes when nothing names one. */
export const KIND_FOR_FAMILY: Readonly<Record<DiagramFamily, DiagramKind>> = {
  flowchart: "freeform",
  sequence: "sequence",
  state: "state",
  er: "entity-relationship",
  c4: "c4",
  architecture: "architecture",
  journey: "journey",
};

/** The kind `source` would compile to by its header alone; `freeform` when it has none Archer reads. */
export function kindOfSource(source: string): DiagramKind {
  const { family } = readPreamble(source);
  return family === undefined ? "freeform" : KIND_FOR_FAMILY[family];
}

export interface Preamble {
  /** The source's lines, unchanged. */
  lines: SourceLine[];
  /** The lines as the profile reads them: frontmatter and directives blanked. */
  statements: SourceLine[];
  header: SourceLine | undefined;
  family: DiagramFamily | undefined;
  diagnostics: Diagnostic[];
  /** The text handed to Mermaid: same lines, comments and refused preamble blanked. */
  mermaidText: string;
}

const FENCE = /^\s*-{3,}\s*$/;
const DIRECTIVE = /%%\{[\s\S]*?\}%%/g;

/** Replace every character but line breaks with a space, keeping each position. */
function blank(text: string): string {
  return text.replace(/[^\r\n]/g, " ");
}

/** The number of lines a YAML frontmatter block takes at the top, or 0. */
function frontmatterLength(lines: readonly SourceLine[]): number {
  if (!FENCE.test(lines[0]?.text ?? "")) return 0;
  const closing = lines.findIndex((line, index) => index > 0 && FENCE.test(line.text));
  // Without a closing fence only the opening line is frontmatter.
  return closing === -1 ? 1 : closing + 1;
}

function blankDirectives(text: string, lines: readonly SourceLine[], diagnostics: Diagnostic[]): string {
  const found: { lineIndex: number; index: number; length: number }[] = [];
  let scanned = 0;
  let lineIndex = 0;
  let lineStart = 0;
  const blanked = text.replace(DIRECTIVE, (directive: string, offset: number) => {
    for (; scanned < offset; scanned += 1) {
      if (text.charCodeAt(scanned) === 10) {
        lineIndex += 1;
        lineStart = scanned + 1;
      }
    }
    const firstBreak = directive.indexOf("\n");
    found.push({ lineIndex, index: offset - lineStart, length: firstBreak === -1 ? directive.length : firstBreak });
    return blank(directive);
  });
  const first = found[0];
  const line = first ? lines[first.lineIndex] : undefined;
  if (first && line) {
    const what =
      found.length === 1 ? "this `%%{init}%%` directive is" : `${found.length} \`%%{init}%%\` directives are`;
    diagnostics.push(
      info(
        "ignored_styling",
        `${what} ignored${found.length === 1 ? "" : " (the first is here)"}: Archer draws diagrams with its own theme`,
        line.span(first.index, first.index + first.length),
      ),
    );
  }
  return blanked;
}

/** Mermaid diagram types Archer knows it does not draw (lower case), so the refusal can name them. */
const UNSUPPORTED_TYPES: ReadonlySet<string> = new Set([
  "classdiagram",
  "c4code",
  "gantt",
  "pie",
  "gitgraph",
  "mindmap",
  "timeline",
  "quadrantchart",
  "requirementdiagram",
  "sankey-beta",
  "xychart-beta",
  "block-beta",
  "packet-beta",
  "kanban",
  "zenuml",
  "radar-beta",
  "treemap-beta",
  "sankey",
  "xychart",
  "block",
  "packet",
  "radar",
  "treemap",
]);

function familyOf(header: string): DiagramFamily | undefined {
  if (/^(flowchart|graph)(\s|$)/.test(header)) return "flowchart";
  if (/^sequenceDiagram(\s|$)/.test(header)) return "sequence";
  if (/^stateDiagram(-v2)?(\s|$)/.test(header)) return "state";
  if (/^erDiagram(\s|$)/.test(header)) return "er";
  if (/^C4(Context|Container|Component|Dynamic|Deployment)(\s|$)/.test(header)) return "c4";
  if (/^architecture-beta(\s|$)/.test(header)) return "architecture";
  if (/^journey(\s|$)/.test(header)) return "journey";
  return undefined;
}

export function readPreamble(source: string): Preamble {
  const diagnostics: Diagnostic[] = [];
  const original = splitLines(source);
  const fence = frontmatterLength(original);
  if (fence > 0) {
    const opener = original[0];
    if (opener) {
      diagnostics.push(
        error(
          "unsupported_construct",
          "YAML frontmatter (`---`) is not supported: remove the block; a view's title and kind come from its registration",
          opener.statementSpan(),
        ),
      );
    }
  }
  const withoutFrontmatter = original.map((line, index) => (index < fence ? blank(line.text) : line.text)).join("\n");
  const statements = splitLines(blankDirectives(withoutFrontmatter, original, diagnostics));

  const header = statements.find((line) => !isBlank(line.text) && !isCommentLine(line.text));
  const family = header ? familyOf(header.text.trim()) : undefined;
  if (family === undefined) {
    const at = header ? header.statementSpan() : { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };
    const word = header?.text.trim().match(/^[A-Za-z][A-Za-z0-9-]*/)?.[0];
    if (word !== undefined && UNSUPPORTED_TYPES.has(word.toLowerCase())) {
      diagnostics.push(
        error(
          "unsupported_diagram_type",
          `\`${word}\` is a Mermaid diagram type Archer does not support. Archer draws \`flowchart\`, \`sequenceDiagram\`, ` +
            "`stateDiagram-v2`, `erDiagram`, `C4Context` (or `C4Container`, `C4Component`, `C4Dynamic`), `architecture-beta` and `journey`: " +
            "say so, or draw the same facts in one of those",
          at,
        ),
      );
    } else
      diagnostics.push(
        error(
          "expected_flowchart",
          "expected a diagram header: `flowchart LR` (or `graph`, with LR, RL, TB, TD or BT), `sequenceDiagram`, " +
            "`stateDiagram-v2`, `erDiagram`, `C4Context` (or `C4Container`, `C4Component`), `architecture-beta` or `journey`",
          at,
        ),
      );
  }
  const mermaidText = statements.map((line) => (isCommentLine(line.text) ? "" : line.text)).join("\n");
  return { lines: original, statements, header, family, diagnostics, mermaidText };
}

/**
 * Where a position Mermaid reports lies in the source: a one-based line and a
 * UTF-16 offset into it. Mermaid trims what precedes the header, so its line
 * 1 is the header line without its indent.
 */
export function sourcePosition(
  header: SourceLine,
  mermaidLine: number,
  mermaidOffset: number,
): { line: number; index: number } {
  const line = mermaidLine + header.number - 1;
  const index = mermaidLine === 1 ? mermaidOffset + header.indent.length : mermaidOffset;
  return { line, index };
}
