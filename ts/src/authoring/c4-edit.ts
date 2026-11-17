/**
 * Source-preserving C4 edits with production compiler model postconditions. No filesystem writes.
 *
 * The profile holds every C4 statement to one exact form on its own line, so the C4 scan maps each
 * element, boundary and relationship to one line, and the argument reader to the exact span of each
 * quoted argument. An edit splices one argument or one whole line, or appends one line; the result
 * must compile to exactly the expected model, and every byte outside the splice is unchanged.
 */
import { isDeepStrictEqual } from "node:util";
import { compileCached as compile, withDiagnostic } from "./compile-cache.ts";
import { readPreamble } from "../mermaid/preamble.ts";
import { readArguments, scanC4, type Argument } from "../mermaid/c4/scan.ts";
import { checkLabel, writeLineBreaks } from "../mermaid/labels.ts";
import { isBlank, isCommentLine, type SourceLine } from "../mermaid/source.ts";
import type { C4Element, C4ElementKind, C4Level, C4Model, C4Relationship, StableId } from "../model/index.ts";
import { MAX_ID_CHARS } from "../model/index.ts";
import type { DiagramEdit, DiagramEditResult } from "./diagram-edit.ts";

/** Mermaid's C4 element functions; `external` adds the `_Ext` suffix. */
export const C4_ELEMENT_FUNCTIONS = [
  "Person",
  "System",
  "SystemDb",
  "SystemQueue",
  "Container",
  "ContainerDb",
  "ContainerQueue",
  "Component",
  "ComponentDb",
  "ComponentQueue",
] as const;
export type C4ElementFunction = (typeof C4_ELEMENT_FUNCTIONS)[number];
export const C4_RELATIONS = ["rel", "birel"] as const;
export type C4Relation = (typeof C4_RELATIONS)[number];

/** The profile's alias grammar (scan.ts): no hyphen, unlike a stable ID. */
const ALIAS = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_]{0,${MAX_ID_CHARS - 1}}$`, "u");
/** Mermaid's C4 database names its top-level pseudo-boundary `global`. */
const RESERVED = new Set(["global"]);
const STYLING =
  /^\s*(?:UpdateElementStyle|UpdateRelStyle|UpdateBoundaryStyle|UpdateLayoutConfig|AddElementTag|AddRelTag)\s*\(/u;
const LEVELS: Record<string, C4Level> = { C4Context: "context", C4Container: "container", C4Component: "component" };
const ENTITIES: Record<string, string> = { "#": "#35;", '"': "#quot;", "%": "#37;" };

/**
 * A C4 label as a quoted argument. The scan ends a quoted argument at the next `"`, and the compiler
 * decodes `#name;` entity codes, so `"` and every `#` are written as codes; `%` beside another `%` is
 * written as a code so the text never forms a `%%{...}%%` directive or a `%%` comment.
 */
export function quoteC4(label: string): string {
  return `"${writeLineBreaks(label.replace(/[#"]|%(?=%)|(?<=%)%/gu, (ch) => ENTITIES[ch]!))}"`;
}

/**
 * Why `label` cannot be a C4 label exactly as requested; undefined when it can. An element or boundary may
 * be drawn blank (`""`, model label ''), as a flowchart shape may; a relationship label is required.
 */
function labelProblem(label: string | undefined, line: SourceLine | undefined, required: boolean): string | undefined {
  if (label === undefined || (required && label.trim() === "")) return "edit_label_required";
  if (label === "") return undefined;
  // The compiler trims labels, and refuses HTML tags, control characters and overlong labels.
  if (label !== label.trim()) return "edit_invalid_label";
  const at = line?.statementSpan() ?? { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };
  return checkLabel(label, at).length === 0 ? undefined : "edit_invalid_label";
}

function kindOf(element: string): C4ElementKind {
  return /^Person/u.test(element)
    ? "person"
    : /^System/u.test(element)
      ? "system"
      : /^Container/u.test(element)
        ? "container"
        : "component";
}

export async function editC4(source: string, edit: DiagramEdit): Promise<DiagramEditResult> {
  const refuse = (code: string, existingId?: string): DiagramEditResult =>
    existingId === undefined ? { ok: false, source, code } : { ok: false, source, code, existingId };
  if (edit.kind === "change-shape" || edit.kind === "direction") return refuse("edit_unsupported_for_family");
  if (edit.kind === "add-node" && edit.shape !== undefined) return refuse("edit_unsupported_for_family");
  if (edit.kind === "connect" && edit.line !== undefined) return refuse("edit_unsupported_for_family");
  const compiled = await compile(source);
  const preamble = readPreamble(source);
  if (preamble.header === undefined) return withDiagnostic(refuse("edit_requires_valid_c4"), compiled);
  // The compiler refuses a header with nothing under it; the first element may still be added to one.
  const level = LEVELS[preamble.header.text.trim()];
  const blank =
    edit.kind === "add-node" &&
    level !== undefined &&
    preamble.diagnostics.length === 0 &&
    preamble.statements.every((l) => l.number <= preamble.header!.number || isBlank(l.text) || isCommentLine(l.text));
  const before: C4Model | undefined =
    compiled.model?.type === "c4-model"
      ? compiled.model
      : blank
        ? { type: "c4-model", level: level!, elements: [], boundaries: [], relationships: [] }
        : undefined;
  if (before === undefined) return withDiagnostic(refuse("edit_requires_valid_c4"), compiled);
  const expected = structuredClone(before);
  const scan = scanC4(preamble.header, preamble.statements);
  if (
    scan.elements.length !== before.elements.length ||
    scan.boundaries.length !== before.boundaries.length ||
    scan.relationships.length !== before.relationships.length
  ) {
    return refuse("edit_source_mapping_ambiguous");
  }
  // Physical lines with their offsets; the preamble keeps every statement on its source line.
  const physical = [...source.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/gu)].map((m) => ({
    start: m.index,
    textEnd: m.index + m[1]!.length,
    end: m.index + m[0].length,
  }));
  const at = (line: SourceLine) => physical[line.number - 1]!;
  /** The arguments of a statement line, offsets into the line. */
  const argsOf = (line: SourceLine): Argument[] | undefined => {
    const open = line.text.indexOf("(");
    return open === -1 ? undefined : readArguments(line, open)?.args;
  };

  let candidate = source;
  let kept: [number, number] = [0, source.length];
  const splice = (start: number, end: number, text: string) => {
    candidate = source.slice(0, start) + text + source.slice(end);
    kept = [start, end];
  };
  /** Replace the quoted argument at `index` of `line`; false when it cannot be mapped exactly. */
  const replaceArgument = (line: SourceLine, index: number, text: string): boolean => {
    const arg = argsOf(line)?.[index];
    if (arg === undefined || arg.text === undefined) return false;
    const start = at(line).start + arg.start;
    if (source.slice(start, start + arg.raw.length) !== arg.raw) return false;
    splice(start, start + arg.raw.length, text);
    return true;
  };
  /** Replace two spans of the source at once, the first before the second. */
  const spliceTwo = (first: [number, number, string], second: [number, number, string]) => {
    candidate =
      source.slice(0, first[0]) + first[2] + source.slice(first[1], second[0]) + second[2] + source.slice(second[1]);
    kept = [first[0], second[1]];
  };
  const removeLine = (line: SourceLine) => {
    const here = at(line);
    // The last line has no line break of its own: take the one before it, so no break is added or left (a blank line before it stays).
    if (
      here.end === here.textEnd &&
      line.number > 1 &&
      physical[line.number - 2]!.textEnd > physical[line.number - 2]!.start
    )
      splice(physical[line.number - 2]!.textEnd, here.end, "");
    else splice(here.start, here.end, "");
  };
  const append = (text: string) => {
    const newline = /\r\n|\r|\n/u.exec(source)?.[0] ?? "\n";
    const ended = /[\r\n]$/u.test(source);
    // The indent of the last top-level statement, else the profile's four spaces.
    const topLevel = [
      ...scan.elements.filter((e) => e.boundary === undefined).map((e) => e.line),
      ...scan.boundaries.filter((b) => b.parent === undefined).map((b) => b.line),
      ...scan.relationships.map((r) => r.line),
    ]
      .sort((a, b) => a.number - b.number)
      .at(-1);
    const indent = topLevel?.indent ?? "    ";
    const addition = (ended ? "" : newline) + indent + text + (ended ? newline : "");
    candidate = source + addition;
    kept = [source.length, source.length];
  };
  const stylingLines = preamble.statements.filter((l) => l.number > preamble.header!.number && STYLING.test(l.text));
  /** Whether a styling statement names `id` (or, for a relationship, its two ends); unreadable styling counts. */
  const styled = (matches: (args: Argument[]) => boolean) =>
    stylingLines.some((l) => {
      const args = argsOf(l);
      return args === undefined || matches(args);
    });
  const named = (arg: Argument | undefined, id: string) => arg !== undefined && (arg.raw === id || arg.text === id);

  const element = "id" in edit && edit.id !== undefined ? scan.elements.find((e) => e.id === edit.id) : undefined;
  const boundary = "id" in edit && edit.id !== undefined ? scan.boundaries.find((b) => b.id === edit.id) : undefined;
  const relationship =
    "id" in edit && edit.id !== undefined ? scan.relationships.find((r) => r.id === edit.id) : undefined;
  // Mermaid merged later lines into this relationship (the compiler warns): no one line holds what it draws.
  if (relationship && relationship.merged.length > 0 && edit.kind !== "connect")
    return refuse("edit_source_mapping_ambiguous");

  if (edit.kind === "add-node") {
    if (edit.element === undefined) return refuse("edit_element_required");
    if (!C4_ELEMENT_FUNCTIONS.includes(edit.element)) return refuse("edit_invalid_element");
    if (edit.external !== undefined && typeof edit.external !== "boolean") return refuse("edit_invalid_element");
    if (!ALIAS.test(edit.id)) return refuse("edit_invalid_id");
    if (RESERVED.has(edit.id)) return refuse("edit_id_reserved");
    if (element || boundary) return refuse("edit_id_exists");
    const problem = labelProblem(edit.label, undefined, false);
    if (problem) return refuse(problem);
    const added: C4Element = { id: edit.id as StableId, kind: kindOf(edit.element), label: edit.label };
    if (edit.external === true) added.external = true;
    if (edit.element.endsWith("Db")) added.shape = "database";
    else if (edit.element.endsWith("Queue")) added.shape = "queue";
    expected.elements.push(added);
    append(`${edit.element}${edit.external === true ? "_Ext" : ""}(${edit.id}, ${quoteC4(edit.label)})`);
  } else if (edit.kind === "connect") {
    const id = `${edit.source}--${edit.target}`;
    if (edit.id !== undefined && edit.id !== id) return refuse("edit_relationship_id_derived");
    const relation = edit.relation ?? "rel";
    if (!C4_RELATIONS.includes(relation)) return refuse("edit_invalid_relation");
    const ends = [edit.source, edit.target];
    if (ends.some((end) => scan.boundaries.some((b) => b.id === end))) return refuse("edit_endpoint_boundary");
    if (ends.some((end) => !scan.elements.some((e) => e.id === end))) return refuse("edit_target_missing");
    const existing = scan.relationships.find((r) => r.id === id);
    if (existing) return refuse("edit_relationship_exists", existing.id);
    if (id.length > MAX_ID_CHARS) return refuse("edit_invalid_id");
    const problem = labelProblem(edit.label, undefined, true);
    if (problem) return refuse(problem);
    const added: C4Relationship = {
      id: id as StableId,
      source: edit.source as StableId,
      target: edit.target as StableId,
      label: edit.label!,
    };
    if (relation === "birel") added.bidirectional = true;
    expected.relationships.push(added);
    append(`${relation === "birel" ? "BiRel" : "Rel"}(${edit.source}, ${edit.target}, ${quoteC4(edit.label!)})`);
  } else if (edit.kind === "relabel-node") {
    const target = element ?? boundary;
    if (!target) return refuse("edit_target_missing");
    const problem = labelProblem(edit.label, target.line, false);
    if (problem) return refuse(problem);
    const modelled = element
      ? expected.elements.find((e) => e.id === edit.id)
      : expected.boundaries.find((b) => b.id === edit.id);
    if (!modelled) return refuse("edit_source_mapping_ambiguous");
    if (modelled.label === edit.label) return { ok: true, source };
    if (!replaceArgument(target.line, 1, quoteC4(edit.label))) return refuse("edit_source_mapping_ambiguous");
    modelled.label = edit.label;
  } else if (edit.kind === "relabel-edge") {
    if (!relationship) return refuse("edit_target_missing");
    const problem = labelProblem(edit.label, relationship.line, true);
    if (problem) return refuse(problem);
    const modelled = expected.relationships.find((r) => r.id === edit.id);
    if (!modelled) return refuse("edit_source_mapping_ambiguous");
    if (modelled.label === edit.label) return { ok: true, source };
    if (!replaceArgument(relationship.line, 2, quoteC4(edit.label))) return refuse("edit_source_mapping_ambiguous");
    modelled.label = edit.label;
  } else if (edit.kind === "retarget-edge") {
    if (edit.message !== undefined) return refuse("edit_unsupported_for_family");
    if (edit.source === undefined && edit.target === undefined) return refuse("edit_endpoint_required");
    if (!relationship) return refuse("edit_target_missing");
    const from = edit.source ?? relationship.source;
    const to = edit.target ?? relationship.target;
    if ([from, to].some((end) => scan.boundaries.some((b) => b.id === end))) return refuse("edit_endpoint_boundary");
    if ([from, to].some((end) => !scan.elements.some((e) => e.id === end))) return refuse("edit_target_missing");
    const id = `${from}--${to}`;
    if (id === relationship.id) return { ok: true, source };
    const existing = scan.relationships.find((r) => r.id === id);
    if (existing) return refuse("edit_relationship_exists", existing.id);
    if (id.length > MAX_ID_CHARS) return refuse("edit_invalid_id");
    // `UpdateRelStyle(from, to, ...)` names the relationship by its ends: it would no longer apply.
    if (styled((args) => named(args[0], relationship.source) && named(args[1], relationship.target)))
      return refuse("edit_retarget_styling_dependency");
    const args = argsOf(relationship.line);
    const [a, b] = [args?.[0], args?.[1]];
    if (a === undefined || b === undefined || a.raw !== relationship.source || b.raw !== relationship.target)
      return refuse("edit_source_mapping_ambiguous");
    const base = at(relationship.line).start;
    if (
      source.slice(base + a.start, base + a.start + a.raw.length) !== a.raw ||
      source.slice(base + b.start, base + b.start + b.raw.length) !== b.raw
    )
      return refuse("edit_source_mapping_ambiguous");
    spliceTwo(
      [base + a.start, base + a.start + a.raw.length, from],
      [base + b.start, base + b.start + b.raw.length, to],
    );
    const modelled = expected.relationships.find((r) => r.id === edit.id);
    if (!modelled) return refuse("edit_source_mapping_ambiguous");
    modelled.id = id as StableId;
    modelled.source = from as StableId;
    modelled.target = to as StableId;
  } else if (edit.kind === "delete-edge") {
    if (!relationship) return refuse("edit_target_missing");
    if (styled((args) => named(args[0], relationship.source) && named(args[1], relationship.target)))
      return refuse("edit_delete_styling_dependency");
    removeLine(relationship.line);
    expected.relationships = expected.relationships.filter((r) => r.id !== edit.id);
  } else if (edit.kind === "delete-node") {
    if (boundary) return refuse("edit_delete_boundary_unsupported");
    if (!element) return refuse("edit_target_missing");
    if (scan.relationships.some((r) => r.source === edit.id || r.target === edit.id))
      return refuse("edit_delete_referenced_node");
    if (styled((args) => args.some((arg) => named(arg, edit.id)))) return refuse("edit_delete_styling_dependency");
    // A boundary must hold at least one element or boundary.
    if (
      element.boundary !== undefined &&
      !scan.elements.some((e) => e !== element && e.boundary === element.boundary) &&
      !scan.boundaries.some((b) => b.parent === element.boundary)
    ) {
      return refuse("edit_delete_last_in_boundary");
    }
    // A C4 diagram with nothing under its header does not compile.
    if (scan.elements.length === 1 && scan.boundaries.length === 0) return refuse("edit_delete_last_element");
    removeLine(element.line);
    expected.elements = expected.elements.filter((e) => e.id !== edit.id);
  } else {
    return refuse("edit_unsupported_for_family");
  }

  // Every byte outside the splice is the source's own.
  const [start, end] = kept;
  const tail = source.length - end;
  if (
    candidate.slice(0, start) !== source.slice(0, start) ||
    candidate.slice(candidate.length - tail) !== source.slice(end)
  )
    return refuse("edit_invalid_result");
  const after = await compile(candidate);
  if (!isDeepStrictEqual(after.model, expected)) return refuse("edit_invalid_result");
  return { ok: true, source: candidate };
}
