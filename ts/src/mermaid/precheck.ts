// Bounds checked before Mermaid reads a source (server review S1). Mermaid's
// parsers are superlinear in a line's length and in block depth; one 29 KB
// source held the service for 40 s. Each bound is far above any real diagram,
// and a source past one is refused with that one problem, unread by Mermaid.

import { error, type Diagnostic } from "./diagnostics.ts";
import { characterCount, lineTooLongMessage, MAX_LINE_CHARS, MAX_NESTING_DEPTH, MAX_SCANNED_DEPTH } from "./limits.ts";
import type { DiagramFamily, Preamble } from "./preamble.ts";
import { isCommentLine, type SourceLine } from "./source.ts";

/** How a family opens and closes its blocks. Quoted text is skipped before either is looked for. */
type Blocks =
  | { kind: "keyword"; opens: RegExp; code: string; what: string }
  | { kind: "brace"; code: string; what: string };

const BLOCKS: Partial<Record<DiagramFamily, Blocks>> = {
  flowchart: { kind: "keyword", opens: /^subgraph(\s|$)/, code: "subgraph_nesting_too_deep", what: "subgraphs" },
  sequence: {
    kind: "keyword",
    opens: /^(loop|alt|opt|par|par_over|critical|break|rect|box)(\s|$)/,
    code: "fragment_nesting_too_deep",
    what: "fragments",
  },
  state: { kind: "brace", code: "nesting_too_deep", what: "composite states" },
  c4: { kind: "brace", code: "nesting_too_deep", what: "boundaries" },
};

const END = /^end(\s|%%|$)/;
const QUOTED = /"[^"]*"/g;
/**
 * The line as Mermaid's parser receives it: Mermaid encodes every `#\w+;` as an entity before it
 * parses (encodeEntities, after dropping the `;` that ends a `style`/`classDef` line holding a
 * colour), so those `;` separate no statements for it, and none here.
 */
function asMermaidParses(text: string): string {
  return text
    .replace(/style.*:\S*#.*;/g, (s) => s.slice(0, -1))
    .replace(/classDef.*:\S*#.*;/g, (s) => s.slice(0, -1))
    .replace(/#\w+;/g, "#");
}

/** The depth change of each block a line opens (+1) or closes (-1), in order; statements may share a line, split at `;`. */
function* steps(text: string, blocks: Blocks): Generator<1 | -1> {
  const unquoted = asMermaidParses(text).replace(QUOTED, '""');
  if (blocks.kind === "brace") {
    for (const character of unquoted)
      if (character === "{") yield 1;
      else if (character === "}") yield -1;
    return;
  }
  for (const statement of unquoted.split(";")) {
    const trimmed = statement.trim();
    if (END.test(trimmed)) yield -1;
    else if (blocks.opens.test(trimmed)) yield 1;
  }
}

/** The one problem that keeps Mermaid from reading this source, if any. */
export function precheck(preamble: Preamble): Diagnostic | undefined {
  const blocks = preamble.family === undefined ? undefined : BLOCKS[preamble.family];
  let depth = 0;
  for (const line of preamble.statements) {
    if (isCommentLine(line.text)) continue;
    if (line.text.length > MAX_LINE_CHARS && characterCount(line.text) > MAX_LINE_CHARS) return tooLong(line);
    if (blocks === undefined) continue;
    for (const step of steps(line.text, blocks)) {
      depth = Math.max(0, depth + step);
      if (depth > MAX_SCANNED_DEPTH) {
        return error(
          blocks.code,
          `this line nests blocks more than ${MAX_SCANNED_DEPTH} deep, and ${blocks.what} nest at most ${MAX_NESTING_DEPTH}. ` +
            "Flatten the nesting, or split the diagram into views. Nothing else was checked.",
          line.statementSpan(),
        );
      }
    }
  }
  return undefined;
}

function tooLong(line: SourceLine): Diagnostic {
  return error("line_too_long", lineTooLongMessage(characterCount(line.text)), line.span(0));
}
