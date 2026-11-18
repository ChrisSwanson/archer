// The `add-edge-ids` fix: a flowchart pasted from elsewhere, whose edges have
// no IDs, with a readable ID written on each (`source_target`, numbered
// `_2`, `_3` when taken), exactly where the profile's diagnostic shows it, and
// each node it only names declared at its first mention, its ID as its label
// (`a` → `a[a]`), and each chained edge moved to a line of its own, from its
// source's bare ID (`a --> b --> c` → `a a_b@--> b` and `b b_c@--> c`).
// Nothing else changes: every other byte is kept, line breaks too.

import { readPreamble } from "../preamble.ts";
import { scanFlowchart } from "./scan.ts";

export interface AddedEdgeId {
  /** One-based line of the source the ID was written on. */
  line: number;
  id: string;
}

export interface EdgeIdsAdded {
  source: string;
  added: AddedEdgeId[];
  /** Nodes only ever named, declared at their first mention with their ID as their label (`a` → `a[a]`). */
  declared: AddedEdgeId[];
}

/**
 * `source` with an ID on every flowchart edge written without one, a declaration for every node only ever
 * named, and each chain split into one edge per line; unchanged when there is none, or it is not a flowchart.
 */
export function addMissingEdgeIds(source: string): EdgeIdsAdded {
  const preamble = readPreamble(source);
  if (preamble.header === undefined || preamble.family !== "flowchart") return { source, added: [], declared: [] };
  const scan = scanFlowchart(preamble.header, preamble.statements);
  // A link that is itself refused keeps its own refusal, whose rewrite names the ID with the right link.
  const inserts = [
    ...scan.missingIds.filter((m) => m.fixable).map((m) => ({ ...m, end: m.offset, kind: "id" as const })),
    ...[...scan.missingDeclarations.values()].map((m) => ({ ...m, end: m.offset, kind: "declaration" as const })),
    ...scan.chainSplits.map((m) => ({
      line: m.line,
      offset: m.start,
      end: m.end,
      text: m.replacement,
      kind: "split" as const,
    })),
  ];
  if (inserts.length === 0) return { source, added: [], declared: [] };
  // The source's own lines with their own line breaks: even entries are lines, odd ones their breaks.
  const parts = source.split(/(\r\n|\r|\n)/),
    written = [...parts];
  const added: (AddedEdgeId & { at: number })[] = [],
    declared: (AddedEdgeId & { at: number })[] = [];
  // From the end of each line back, so offsets hold; at one offset the ID goes in first, then a chain's split,
  // then the declaration, so each lands before the one written ahead of it
  // (`a-->b-->c` → `a[a] a_b@-->b[b]` and `b b_c@-->c[c]`).
  const order = { id: 0, split: 1, declaration: 2 };
  inserts.sort((a, b) => a.line.number - b.line.number || b.offset - a.offset || order[a.kind] - order[b.kind]);
  for (const insert of inserts) {
    const index = 2 * (insert.line.number - 1);
    const text = parts[index];
    // The preamble keeps a statement's text as written, blanking directives in place; a line it rewrote is left alone.
    if (text === undefined || !asScanned(written[index] ?? "", insert.line.text)) continue;
    parts[index] = text.slice(0, insert.offset) + insert.text + text.slice(insert.end);
    if (insert.kind === "split") continue;
    (insert.kind === "id" ? added : declared).push({ line: insert.line.number, id: insert.id, at: insert.offset });
  }
  const inOrder = (list: (AddedEdgeId & { at: number })[]): AddedEdgeId[] =>
    list.sort((a, b) => a.line - b.line || a.at - b.at).map(({ line, id }) => ({ line, id }));
  return { source: parts.join(""), added: inOrder(added), declared: inOrder(declared) };
}

/** `original` read as `scanned`: the same characters, except where the preamble blanked a directive with spaces. */
function asScanned(original: string, scanned: string): boolean {
  if (original.length !== scanned.length) return false;
  for (let index = 0; index < scanned.length; index += 1)
    if (scanned[index] !== " " && scanned[index] !== original[index]) return false;
  return true;
}
