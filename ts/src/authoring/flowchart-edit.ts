/** Source-preserving flowchart edits with production compiler model postconditions. No filesystem writes. */
import { isDeepStrictEqual } from "node:util";
import type { EditDiagnostic } from "./compile-cache.ts";
import { compileCached as compile, withDiagnostic } from "./compile-cache.ts";
import { checkLabel, writeLineBreaks } from "../mermaid/labels.ts";
import { readPreamble } from "../mermaid/preamble.ts";
import { lexStatement, type Token } from "../mermaid/flowchart/lexer.ts";
import type { Direction, EdgeLine, NodeShape, StableId } from "../model/index.ts";
export type FlowchartEdit =
  | { kind: "relabel-node"; id: string; label: string }
  | { kind: "add-node"; id: string; label: string; shape?: NodeShape }
  | { kind: "connect"; id: string; source: string; target: string; label?: string; line?: EdgeLine }
  | { kind: "relabel-edge"; id: string; label: string }
  /** Change one or both ends of an edge; the edge keeps its ID. */
  | { kind: "retarget-edge"; id: string; source?: string; target?: string }
  | { kind: "change-shape"; id: string; shape: NodeShape }
  /** One-way or two-way arrowheads, or the ends swapped; the edge keeps its ID. */
  | { kind: "change-arrow"; id: string; arrow: "one-way" | "two-way" | "reverse" }
  | { kind: "delete-edge"; id: string }
  | { kind: "delete-node"; id: string }
  | { kind: "direction"; direction: Direction };
export type FlowchartEditResult =
  | { ok: true; source: string }
  | { ok: false; source: string; code: string; diagnostic?: EditDiagnostic };
const shapes: Record<NodeShape, readonly [string, string]> = {
  rectangle: ["[", "]"],
  rounded: ["(", ")"],
  stadium: ["([", "])"],
  circle: ["((", "))"],
  diamond: ["{", "}"],
  cylinder: ["[(", ")]"],
  hexagon: ["{{", "}}"],
  subroutine: ["[[", "]]"],
};
// The canvas draws the three patterns Mermaid spells as arrows; `dashed` and
// `dashdot` are edge classes the author writes in the source (ADR 0030).
const arrows: Partial<Record<EdgeLine, string>> = { solid: "-->", dotted: "-.->", thick: "==>" };
/** A model without its `sourceOrder`, which records where things are written rather than what they are. */
function withoutOrder(model: object | null | undefined): object | null | undefined {
  if (model === null || model === undefined || !("sourceOrder" in model)) return model;
  const { sourceOrder: _order, ...rest } = model as { sourceOrder?: unknown };
  return rest;
}

function quote(label: string): string {
  if (label === "") return '" "';
  const entities: Record<string, string> = {
    "#": "#35;",
    '"': "#quot;",
    "&": "#amp;",
    "<": "#lt;",
    ">": "#gt;",
    "|": "#124;",
  };
  return `"${writeLineBreaks(label.replace(/[#"&<>|]/gu, (ch) => entities[ch]!))}"`;
}
/** Whether `label` can be written exactly as requested: the compiler trims labels and refuses tags, control characters and overlong text. */
function labelValid(label: string | undefined): boolean {
  if (label === undefined || label === "") return true;
  return (
    label === label.trim() &&
    !label.includes("%%") &&
    checkLabel(label, { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } }).length === 0
  );
}

/** A line's leading whitespace. */
const indentOf = (text: string): string => /^[ \t]*/u.exec(text)![0];
/**
 * One edge line, `a<decl> id@--> b<decl>`, split into the declarations written on each end and the text
 * between them (edge ID, link, label). Null when the line has anything else (`&`, `;`, a comment, a chain).
 */
function splitEnds(
  text: string,
  tokens: readonly Token[],
): { source: string; middle: string; target: string; targetAt: number } | null {
  const declares = (t: Token | undefined) => t?.kind === "shape" || t?.kind === "class" || t?.kind === "metadata";
  if (tokens[0]?.kind !== "id") return null;
  let i = 1;
  while (declares(tokens[i])) i++;
  const sourceEnd = tokens[i - 1]!.end;
  if (tokens[i]?.kind !== "edge-id") return null;
  const link = tokens[i + 1];
  if (link?.kind !== "link" && link?.kind !== "text-link") return null;
  const targetAt = i + 2 + (tokens[i + 2]?.kind === "pipe" ? 1 : 0);
  const target = tokens[targetAt];
  if (target?.kind !== "id") return null;
  let j = targetAt + 1;
  while (declares(tokens[j])) j++;
  if (j !== tokens.length || text.slice(tokens[j - 1]!.end).trim() !== "") return null;
  return {
    source: text.slice(tokens[0].end, sourceEnd),
    middle: text.slice(sourceEnd, target.start),
    target: text.slice(target.end, tokens[j - 1]!.end),
    targetAt,
  };
}

export async function editFlowchart(source: string, edit: FlowchartEdit): Promise<FlowchartEditResult> {
  const refuse = (code: string): FlowchartEditResult => ({ ok: false, source, code });
  const compiled = await compile(source);
  if (compiled.model?.type !== "freeform-graph")
    return withDiagnostic(refuse("edit_requires_valid_flowchart"), compiled);
  const before = compiled.model;
  const expected = structuredClone(before);
  const statements = readPreamble(source).statements;
  let lineIndex = 0;
  const lines = [...source.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/g)].map((match) => {
    const text = statements[lineIndex++]?.text ?? "";
    const special = /^\s*(?:%%|(?:flowchart|graph|subgraph|end|classDef|class|style|click|linkStyle)(?:\s|$))/u.test(
      text,
    );
    const lexed = lexStatement(special ? "" : text);
    return { text, start: match.index, end: match.index + match[0].length, tokens: lexed.tokens, opaque: lexed.opaque };
  });
  const node = "id" in edit ? expected.nodes.find((n) => n.id === edit.id) : undefined;
  const edge = "id" in edit ? expected.edges.find((e) => e.id === edit.id) : undefined;
  let candidate = source;
  const splice = (start: number, end: number, text: string) => {
    candidate = source.slice(0, start) + text + source.slice(end);
  };
  // Appended lines take the indent of the last top-level statement (two spaces when there is none).
  let indent = "  ";
  {
    const header = lines.findIndex((l) => /^\s*(?:flowchart|graph)\b/u.test(l.text));
    let depth = 0;
    for (const l of header < 0 ? [] : lines.slice(header + 1)) {
      const text = l.text.trim();
      if (text === "" || text.startsWith("%%")) continue;
      if (/^end\b/u.test(text)) depth = Math.max(0, depth - 1);
      if (depth === 0) indent = indentOf(l.text);
      if (/^subgraph\b/u.test(text)) depth++;
    }
  }
  // The source's own line break, for any line this edit writes.
  const lineBreak = /\r\n|\r|\n/u.exec(source)?.[0] ?? "\n";
  const append = (text: string) => {
    const ended = /[\r\n]$/u.test(source);
    candidate = source + (ended ? "" : lineBreak) + indent + text + (ended ? lineBreak : "");
  };
  if (edit.kind === "add-node") {
    if (node) return refuse("edit_id_exists");
    if (!labelValid(edit.label)) return refuse("edit_invalid_label");
    const shape = edit.shape === undefined ? "rectangle" : edit.shape;
    if (!Object.hasOwn(shapes, shape)) return refuse("edit_invalid_shape");
    const [open, close] = shapes[shape];
    expected.nodes.push({ id: edit.id as StableId, label: edit.label, shape });
    append(`${edit.id}${open}${quote(edit.label)}${close}`);
  } else if (edit.kind === "connect") {
    if (edge) return refuse("edit_id_exists");
    if (!labelValid(edit.label)) return refuse("edit_invalid_label");
    if (!before.nodes.some((n) => n.id === edit.source) || !before.nodes.some((n) => n.id === edit.target))
      return refuse("edit_target_missing");
    const line = edit.line === undefined ? "solid" : edit.line;
    if (!Object.hasOwn(arrows, line)) return refuse("edit_invalid_line");
    // The compiler records solid as an absent `line`.
    expected.edges.push({
      id: edit.id as StableId,
      source: edit.source as StableId,
      target: edit.target as StableId,
      ...(edit.label === undefined || edit.label === "" ? {} : { label: edit.label }),
      ...(line === "solid" ? {} : { line }),
    });
    append(
      `${edit.source} ${edit.id}@${arrows[line]}${edit.label === undefined || edit.label === "" ? "" : `|${quote(edit.label)}|`} ${edit.target}`,
    );
  } else if (edit.kind === "retarget-edge") {
    if ((edit as { message?: unknown }).message !== undefined) return refuse("edit_unsupported_for_family");
    if (edit.source === undefined && edit.target === undefined) return refuse("edit_endpoint_required");
    if (!edge) return refuse("edit_target_missing");
    const from = edit.source ?? edge.source;
    const to = edit.target ?? edge.target;
    if (!before.nodes.some((n) => n.id === from) || !before.nodes.some((n) => n.id === to))
      return refuse("edit_target_missing");
    if (from === edge.source && to === edge.target) return { ok: true, source };
    const matches = lines.filter((l) => l.tokens.some((t) => t.kind === "edge-id" && t.text === edit.id));
    if (matches.length !== 1 || matches[0]!.opaque) return refuse("edit_source_mapping_ambiguous");
    const line = matches[0]!;
    const tokens = line.tokens;
    // One link per line, with no `&` group (the profile refuses both; this guards the splice).
    if (
      tokens.some((t) => t.kind === "amp") ||
      tokens.filter((t) => t.kind === "link" || t.kind === "text-link").length !== 1
    )
      return refuse("edit_source_mapping_ambiguous");
    const at = tokens.findIndex((t) => t.kind === "edge-id");
    const first = tokens[0];
    const link = tokens[at + 1];
    const toAt = at + 2 + (tokens[at + 2]?.kind === "pipe" ? 1 : 0);
    const last = tokens[toAt];
    if (
      first?.kind !== "id" ||
      first.text !== edge.source ||
      (link?.kind !== "link" && link?.kind !== "text-link") ||
      last?.kind !== "id" ||
      last.text !== edge.target
    )
      return refuse("edit_source_mapping_ambiguous");
    const [s0, s1, t0, t1] = [
      line.start + first.start,
      line.start + first.end,
      line.start + last.start,
      line.start + last.end,
    ];
    if (source.slice(s0, s1) !== edge.source || source.slice(t0, t1) !== edge.target)
      return refuse("edit_source_mapping_ambiguous");
    // A shape, class or metadata written on an end declares that node: a new name would move it, so the
    // declaration stays behind on a line of its own (the source's before the edge, the target's after).
    const ends = splitEnds(line.text, tokens);
    if (!ends) return refuse("edit_retarget_inline_declaration");
    const lead = indentOf(line.text),
      nl = lineBreak;
    const movesSource = from !== edge.source && ends.source !== "";
    const movesTarget = to !== edge.target && ends.target !== "";
    candidate =
      source.slice(0, line.start) +
      (movesSource ? `${lead}${edge.source}${ends.source}${nl}` : "") +
      line.text.slice(0, first.start) +
      from +
      (movesSource ? "" : ends.source) +
      ends.middle +
      to +
      (movesTarget ? "" : ends.target) +
      (movesTarget ? `${nl}${lead}${edge.target}${ends.target}` : "") +
      source.slice(line.start + line.text.length);
    edge.source = from as StableId;
    edge.target = to as StableId;
  } else if (edit.kind === "change-arrow") {
    if (!edge) return refuse("edit_target_missing");
    if (!["one-way", "two-way", "reverse"].includes(edit.arrow)) return refuse("edit_invalid_line");
    const twoWay = edge.bidirectional === true;
    if (
      (edit.arrow === "one-way" && !twoWay) ||
      (edit.arrow === "two-way" && twoWay) ||
      (edit.arrow === "reverse" && edge.source === edge.target)
    )
      return { ok: true, source };
    const matches = lines.filter((l) => l.tokens.some((t) => t.kind === "edge-id" && t.text === edit.id));
    if (matches.length !== 1 || matches[0]!.opaque) return refuse("edit_source_mapping_ambiguous");
    const line = matches[0]!;
    const at = line.tokens.findIndex((t) => t.kind === "edge-id");
    const link = line.tokens[at + 1];
    if (link?.kind !== "link" || line.tokens.filter((t) => t.kind === "link" || t.kind === "text-link").length !== 1)
      return refuse("edit_source_mapping_ambiguous");
    if (edit.arrow === "reverse") {
      // Each end moves with its declaration, so a node declared on the line stays declared.
      const ends = splitEnds(line.text, line.tokens);
      const first = line.tokens[0];
      const last = ends ? line.tokens[ends.targetAt] : undefined;
      if (
        !ends ||
        first?.kind !== "id" ||
        last?.kind !== "id" ||
        first.text !== edge.source ||
        last.text !== edge.target
      )
        return refuse("edit_source_mapping_ambiguous");
      const end = line.tokens.at(-1)!.end;
      splice(
        line.start + first.start,
        line.start + end,
        last.text + ends.target + ends.middle + first.text + ends.source,
      );
      [edge.source, edge.target] = [edge.target, edge.source];
    } else {
      // `-->` and `<-->`, `-.->` and `<-.->`, `==>` and `<==>`: the lengths as written.
      splice(
        line.start + link.start,
        line.start + link.end,
        edit.arrow === "two-way" ? `<${link.op}` : link.op.slice(1),
      );
      if (edit.arrow === "two-way") edge.bidirectional = true;
      else delete edge.bidirectional;
    }
  } else if (edit.kind === "direction") {
    if (before.direction === edit.direction) return { ok: true, source };
    const headers = lines.filter((l) => /^\s*(?:flowchart|graph)\s+(?:LR|RL|TB|TD|BT)\s*$/u.test(l.text));
    if (headers.length !== 1) return refuse("edit_source_mapping_ambiguous");
    const header = headers[0]!;
    const match = /\b(?:LR|RL|TB|TD|BT)\b/u.exec(header.text)!;
    splice(header.start + match.index, header.start + match.index + match[0].length, edit.direction.toUpperCase());
    expected.direction = edit.direction;
  } else if (edit.kind === "delete-node" || edit.kind === "delete-edge") {
    if (edit.kind === "delete-node" ? !node : !edge) return refuse("edit_target_missing");
    if (edit.kind === "delete-node" && before.edges.some((e) => e.source === edit.id || e.target === edit.id))
      return refuse("edit_delete_referenced_node");
    const matches = lines.filter((l) =>
      l.tokens.some(
        (t) =>
          (t.kind === "id" || t.kind === "edge-id") &&
          t.kind === (edit.kind === "delete-node" ? "id" : "edge-id") &&
          t.text === edit.id,
      ),
    );
    if (matches.length !== 1) return refuse("edit_source_mapping_ambiguous");
    const line = matches[0]!;
    // Styling that names the element (`style`/`class`/`click`), or a `linkStyle` ordinal at or after
    // a deleted edge (the delete would restyle the edges after it), is kept by refusing.
    const at = lines.indexOf(line);
    const ordinal = lines
      .slice(0, at)
      .reduce((n, l) => n + l.tokens.filter((t) => t.kind === "link" || t.kind === "text-link").length, 0);
    const counted = lines.slice(0, at).every((l) => !l.opaque);
    const depends = statements.some((l) => {
      const words = l.text.trim().split(/\s+/u);
      const keyword = words[0];
      if (keyword !== "style" && keyword !== "class" && keyword !== "click" && keyword !== "linkStyle") return false;
      const names = (words[1] ?? "").split(",");
      if (keyword !== "linkStyle") return names.includes(edit.id);
      if (edit.kind === "delete-node" || words[1] === "default") return false;
      return !counted || names.some((n) => !/^\d+$/u.test(n) || Number(n) >= ordinal);
    });
    if (depends) return refuse("edit_delete_styling_dependency");
    if (edit.kind === "delete-node" && (line.tokens.length !== 2 || line.tokens[1]?.kind !== "shape" || node?.groupId))
      return refuse("edit_delete_nonisolated_declaration");
    const ends =
      edit.kind === "delete-edge" &&
      line.tokens.some((t) => t.kind === "shape" || t.kind === "class" || t.kind === "metadata")
        ? splitEnds(line.text, line.tokens)
        : undefined;
    if (ends === null) return refuse("edit_delete_inline_declaration");
    if (ends) {
      // The edge goes; a node declared on its line stays, one declaration per line at the line's indent.
      const first = line.tokens[0] as Extract<Token, { kind: "id" }>,
        last = line.tokens[ends.targetAt] as Extract<Token, { kind: "id" }>;
      const lead = indentOf(line.text),
        nl = lineBreak;
      const kept = [
        ends.source === "" ? "" : first.text + ends.source,
        ends.target === "" ? "" : last.text + ends.target,
      ].filter(Boolean);
      splice(line.start + first.start, line.start + line.text.length, kept.join(nl + lead));
    } else {
      // An unterminated last line takes the break before it, so the file does not gain a trailing newline.
      const previous = /(?:\r\n|\r|\n)$/u.exec(source.slice(0, line.start))?.[0] ?? "";
      const terminated = /[\r\n]$/u.test(source.slice(line.start, line.end));
      splice(terminated ? line.start : line.start - previous.length, line.end, "");
    }
    if (edit.kind === "delete-node") expected.nodes = expected.nodes.filter((n) => n.id !== edit.id);
    else expected.edges = expected.edges.filter((e) => e.id !== edit.id);
  } else {
    const target = edit.kind === "relabel-edge" ? edge : node;
    if (!target) return refuse("edit_target_missing");
    if (
      edit.kind === "change-shape"
        ? node?.shape === edit.shape
        : (edit.kind === "relabel-edge" ? (target.label ?? "") : target.label) === edit.label
    )
      return { ok: true, source };
    if (edit.kind !== "change-shape" && !labelValid(edit.label)) return refuse("edit_invalid_label");
    const mappings: { line: (typeof lines)[number]; token: Token; after: Token | undefined }[] = [];
    for (const line of lines)
      if (!line.opaque)
        for (let i = 0; i < line.tokens.length; i++) {
          const token = line.tokens[i]!;
          if (edit.kind === "relabel-edge") {
            if (token.kind === "edge-id" && token.text === edit.id && line.tokens[i + 1]?.kind === "link")
              mappings.push({ line, token: line.tokens[i + 1]!, after: line.tokens[i + 2] });
          } else if (token.kind === "id" && token.text === edit.id && line.tokens[i + 1]?.kind === "shape")
            mappings.push({ line, token: line.tokens[i + 1]!, after: undefined });
        }
    if (mappings.length !== 1) return refuse("edit_source_mapping_ambiguous");
    const { line, token, after } = mappings[0]!;
    if (edit.kind === "relabel-edge") {
      const start = after?.kind === "pipe" ? after.start : token.end;
      splice(
        line.start + start,
        line.start + (after?.kind === "pipe" ? after.end : token.end),
        edit.label === "" ? "" : `|${quote(edit.label)}|`,
      );
      if (edit.label === "") delete edge!.label;
      else edge!.label = edit.label;
    } else if (token.kind === "shape") {
      if (edit.kind === "relabel-node") {
        splice(line.start + token.labelStart, line.start + token.labelEnd, quote(edit.label));
        node!.label = edit.label;
      } else {
        const [open, close] = shapes[edit.shape];
        splice(line.start + token.start, line.start + token.end, open + token.raw + close);
        node!.shape = edit.shape;
      }
    }
  }
  expected.nodes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  expected.edges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const after = await compile(candidate);
  // What the edit promises is the model's content; where things are written (`sourceOrder`) follows the splice.
  if (!isDeepStrictEqual(withoutOrder(after.model), withoutOrder(expected))) return refuse("edit_invalid_result");
  return { ok: true, source: candidate };
}
