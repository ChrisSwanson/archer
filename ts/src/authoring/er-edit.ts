/**
 * Source-preserving ER edits with production compiler model postconditions. No filesystem writes.
 *
 * The ER scan maps each entity to the lines that declare it (with the exact offsets of its name and its
 * `["label"]`, and the `}` closing its attribute block) and each relationship to its line and the offsets
 * of its label. An edit splices one label, one bracket, one line or one declaration block, or appends one
 * line; the result must compile to exactly the expected model, and every byte outside the splice is unchanged.
 */
import { isDeepStrictEqual } from "node:util";
import { compileCached as compile, withDiagnostic } from "./compile-cache.ts";
import { readPreamble } from "../mermaid/preamble.ts";
import { scanEr, type ScannedDeclaration } from "../mermaid/er/scan.ts";
import { checkLabel, writeLineBreaks } from "../mermaid/labels.ts";
import type { SourceLine } from "../mermaid/source.ts";
import type { Cardinality, Entity, EntityRelationship, Relationship, StableId } from "../model/index.ts";
import { MAX_ID_CHARS } from "../model/index.ts";
import type { DiagramEdit, DiagramEditResult } from "./diagram-edit.ts";

/** The cardinalities the editor offers, as `[left marker, right marker]` and the model's two ends. */
export const ER_CARDINALITIES = ["one-to-many", "one-to-one", "many-to-many", "zero-or-one-to-many"] as const;
export type ErCardinality = (typeof ER_CARDINALITIES)[number];
const MARKERS: Record<ErCardinality, [string, string, Cardinality, Cardinality]> = {
  "one-to-many": ["||", "o{", "exactly-one", "zero-or-more"],
  "one-to-one": ["||", "||", "exactly-one", "exactly-one"],
  "many-to-many": ["}o", "o{", "zero-or-more", "zero-or-more"],
  "zero-or-one-to-many": ["|o", "o{", "zero-or-one", "zero-or-more"],
};

/**
 * The profile's entity name, starting with a letter: Mermaid's ER lexer misreads a name that starts with a
 * digit (`9lives`), and `_` is outside the profile.
 */
const NAME = new RegExp(`^[A-Za-z][A-Za-z0-9_-]{0,${MAX_ID_CHARS - 1}}$`, "u");
/**
 * Names Mermaid's ER lexer (or the profile's scan) reads as keywords, alone or before a `-`: `one`, `to-do`,
 * `end-x`, `u-x` (`u` before `-` is a cardinality), and any name starting `title`, `accTitle` or `accDescr`.
 */
const RESERVED =
  /^(?:(?:one|many|to|end|erDiagram|classDef|class|style|subgraph|direction)(?![A-Za-z0-9_])|u-|title|accTitle|accDescr)/iu;
const STYLING = /^\s*(?:class|style)\s/u;
/** The scan's routing of a line to the relationship reader (scan.ts). */
const RELATIONSHIP_LIKE = (text: string) =>
  (/(--|\.\.)/u.test(text) && /[|}{o]/u.test(text)) || /\b(one|zero|many|only)\b.*\bto\b/iu.test(text);

const code = (ch: string) => `#${ch.codePointAt(0)};`;
const BASE: Record<string, string> = { '"': "#quot;", "#": "#35;", "%": "#37;" };
/** `"` and `#` as codes (the compiler decodes `#name;`), and `%` beside another `%` so no `%%` forms. */
const encode = (label: string) => label.replace(/[#"]|%(?=%)|(?<=%)%/gu, (ch) => BASE[ch]!);

/** A relationship label, always quoted: inside quotes Mermaid reads keywords, `:` and `--` as text. */
export function quoteErRelationshipLabel(label: string): string {
  return `"${writeLineBreaks(encode(label))}"`;
}

/**
 * An entity label as `["…"]`. Beyond the relationship codec, every `%` and `\` (Mermaid's lexer reads a
 * bracketed label only without them), a `-` beside a `-` and a `.` beside a `.` are
 * codes, and so is the `t` of a `to` when the line would otherwise read as a cardinality in words: the scan
 * routes a line holding `--` or `..`, or `one … to`, to its relationship reader.
 */
export function bracketErLabel(label: string, name = ""): string {
  let text = encode(label).replace(/[%\\]|-(?=-)|(?<=-)-|\.(?=\.)|(?<=\.)\./gu, code);
  if (RELATIONSHIP_LIKE(`${name}["${text}"]`))
    text = text.replace(/\bto\b/giu, (word) => code(word[0]!) + word.slice(1));
  return `["${writeLineBreaks(text)}"]`;
}

/** Why `label` cannot be written exactly as requested; undefined when it can. '' is no label. */
function labelProblem(label: unknown, line: SourceLine | undefined): string | undefined {
  if (typeof label !== "string") return "edit_label_required";
  if (label === "") return undefined;
  // The compiler trims labels, and refuses HTML tags, control characters and overlong labels.
  if (label !== label.trim()) return "edit_invalid_label";
  const at = line?.statementSpan() ?? { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } };
  return checkLabel(label, at).length === 0 ? undefined : "edit_invalid_label";
}

export async function editEr(source: string, edit: DiagramEdit): Promise<DiagramEditResult> {
  const refuse = (code: string, existingId?: string): DiagramEditResult =>
    existingId === undefined ? { ok: false, source, code } : { ok: false, source, code, existingId };
  if (edit.kind === "change-shape" || edit.kind === "direction") return refuse("edit_unsupported_for_family");
  if (
    edit.kind === "add-node" &&
    (edit.shape !== undefined || edit.element !== undefined || edit.external !== undefined || edit.state !== undefined)
  )
    return refuse("edit_unsupported_for_family");
  if (edit.kind === "connect" && (edit.line !== undefined || edit.relation !== undefined))
    return refuse("edit_unsupported_for_family");
  const compiled = await compile(source);
  const preamble = readPreamble(source);
  if (preamble.header === undefined || compiled.model?.type !== "entity-relationship")
    return withDiagnostic(refuse("edit_requires_valid_er"), compiled);
  const before: EntityRelationship = compiled.model;
  const expected = structuredClone(before);
  const scan = scanEr(preamble.header, preamble.statements);
  if (scan.entities.length !== before.entities.length || scan.relationships.length !== before.relationships.length)
    return refuse("edit_source_mapping_ambiguous");
  // Physical lines with their offsets; the preamble keeps every statement on its source line.
  const physical = [...source.matchAll(/([^\r\n]*)(\r\n|\r|\n|$)/gu)].map((m) => ({
    start: m.index,
    textEnd: m.index + m[1]!.length,
    end: m.index + m[0].length,
  }));
  const at = (line: SourceLine) => physical[line.number - 1]!;

  let candidate = source;
  let kept: [number, number] = [0, source.length];
  const splice = (start: number, end: number, text: string) => {
    candidate = source.slice(0, start) + text + source.slice(end);
    kept = [start, end];
  };
  /** Replace `[start, end)` of `line`'s text, checking the line still reads as scanned. */
  const spliceInLine = (line: SourceLine, start: number, end: number, text: string): boolean => {
    const here = at(line);
    if (source.slice(here.start, here.textEnd) !== line.text) return false;
    splice(here.start + start, here.start + end, text);
    return true;
  };
  /** Remove lines `first` through `last`, with their line breaks. */
  const removeLines = (first: SourceLine, last: SourceLine) => {
    const from = at(first);
    const to = at(last);
    // The last line has no line break of its own: take the one before it, so no break is added or left (a blank line before it stays).
    if (
      to.end === to.textEnd &&
      first.number > 1 &&
      physical[first.number - 2]!.textEnd > physical[first.number - 2]!.start
    )
      splice(physical[first.number - 2]!.textEnd, to.end, "");
    else splice(from.start, to.end, "");
  };
  const append = (text: string) => {
    const newline = /\r\n|\r|\n/u.exec(source)?.[0] ?? "\n";
    const ended = /[\r\n]$/u.test(source);
    // The indent of the last top-level statement, else the profile's four spaces.
    const topLevel = [
      ...scan.entities.flatMap((e) => e.declarations.map((d) => d.line)),
      ...scan.relationships.map((r) => r.line),
    ]
      .sort((a, b) => a.number - b.number)
      .at(-1);
    const indent = topLevel?.indent ?? "    ";
    candidate = source + (ended ? "" : newline) + indent + text + (ended ? newline : "");
    kept = [source.length, source.length];
  };

  const id = "id" in edit ? edit.id : undefined;
  const entity = id === undefined ? undefined : scan.entities.find((e) => e.id === id);
  const relationship = id === undefined ? undefined : scan.relationships.find((r) => r.id === id);
  // Written again below (the compiler warns and ignores the repeat): removing or moving this line would draw the repeat.
  if ((edit.kind === "delete-edge" || edit.kind === "retarget-edge") && scan.ignored.some((r) => r.id === id))
    return refuse("edit_source_mapping_ambiguous");

  if (edit.kind === "add-node") {
    if (typeof edit.id !== "string" || !NAME.test(edit.id) || edit.id.includes("--")) return refuse("edit_invalid_id");
    if (RESERVED.test(edit.id)) return refuse("edit_id_reserved");
    if (entity) return refuse("edit_id_exists");
    const problem = labelProblem(edit.label, undefined);
    if (problem) return refuse(problem);
    const labelled = edit.label !== "" && edit.label !== edit.id;
    const added: Entity = { id: edit.id as StableId, label: labelled ? edit.label : edit.id, attributes: [] };
    expected.entities.push(added);
    append(edit.id + (labelled ? bracketErLabel(edit.label, edit.id) : ""));
  } else if (edit.kind === "connect") {
    const ends = [edit.source, edit.target];
    if (ends.some((end) => typeof end !== "string" || !scan.entities.some((e) => e.id === end)))
      return refuse("edit_target_missing");
    // Archer names a relationship `source--target`; a name holding `--` makes that name ambiguous.
    if (ends.some((end) => end.includes("--"))) return refuse("edit_relationship_id_ambiguous");
    const derived = `${edit.source}--${edit.target}`;
    if (edit.id !== undefined && edit.id !== derived) return refuse("edit_relationship_id_derived");
    const cardinality = edit.cardinality ?? "one-to-many";
    if (!Object.hasOwn(MARKERS, cardinality)) return refuse("edit_invalid_cardinality");
    if (edit.identifying !== undefined && typeof edit.identifying !== "boolean")
      return refuse("edit_invalid_cardinality");
    const existing = scan.relationships.find((r) => r.id === derived);
    if (existing) return refuse("edit_relationship_exists", existing.id);
    if (derived.length > MAX_ID_CHARS) return refuse("edit_invalid_id");
    const label = edit.label ?? "";
    const problem = labelProblem(label, undefined);
    if (problem) return refuse(problem);
    const [left, right, sourceCardinality, targetCardinality] = MARKERS[cardinality];
    const identifying = edit.identifying ?? true;
    const added: Relationship = {
      id: derived as StableId,
      source: edit.source as StableId,
      target: edit.target as StableId,
      sourceCardinality,
      targetCardinality,
      identifying,
    };
    if (label !== "") added.label = label;
    expected.relationships.push(added);
    append(
      `${edit.source} ${left}${identifying ? "--" : ".."}${right} ${edit.target} : ${quoteErRelationshipLabel(label)}`,
    );
  } else if (edit.kind === "relabel-node") {
    if (!entity) return refuse("edit_target_missing");
    const modelled = expected.entities.find((e) => e.id === edit.id);
    if (!modelled) return refuse("edit_source_mapping_ambiguous");
    const labelled = entity.declarations.filter((d) => d.bracket !== undefined);
    if (labelled.length > 1) return refuse("edit_source_mapping_ambiguous");
    const declaration: ScannedDeclaration | undefined = labelled[0] ?? entity.declarations[0];
    if (!declaration) return refuse("edit_source_mapping_ambiguous");
    const problem = labelProblem(edit.label, declaration.line);
    if (problem) return refuse(problem);
    // An entity with no label shows its name; '' asks for no label.
    const wanted = edit.label === "" ? edit.id : edit.label;
    if (modelled.label === wanted) return { ok: true, source };
    const bracket = declaration.bracket;
    const ok =
      edit.label === "" || edit.label === edit.id
        ? bracket !== undefined && spliceInLine(declaration.line, bracket.start, bracket.end, "")
        : bracket !== undefined
          ? spliceInLine(
              declaration.line,
              bracket.start,
              bracket.end,
              bracketErLabel(edit.label, declaration.line.text.slice(0, bracket.start).trim()),
            )
          : spliceInLine(
              declaration.line,
              declaration.nameEnd,
              declaration.nameEnd,
              bracketErLabel(edit.label, declaration.line.text.slice(0, declaration.nameEnd).trim()),
            );
    if (!ok) return refuse("edit_source_mapping_ambiguous");
    modelled.label = wanted;
  } else if (edit.kind === "relabel-edge") {
    if (!relationship) return refuse("edit_target_missing");
    const problem = labelProblem(edit.label, relationship.line);
    if (problem) return refuse(problem);
    const modelled = expected.relationships.find((r) => r.id === edit.id);
    if (!modelled) return refuse("edit_source_mapping_ambiguous");
    if ((modelled.label ?? "") === edit.label) return { ok: true, source };
    if (
      !spliceInLine(
        relationship.line,
        relationship.labelStart,
        relationship.labelEnd,
        quoteErRelationshipLabel(edit.label),
      )
    )
      return refuse("edit_source_mapping_ambiguous");
    if (edit.label === "") delete modelled.label;
    else modelled.label = edit.label;
  } else if (edit.kind === "retarget-edge") {
    if (edit.message !== undefined) return refuse("edit_unsupported_for_family");
    if (
      edit.source === undefined &&
      edit.target === undefined &&
      edit.cardinality === undefined &&
      edit.identifying === undefined
    )
      return refuse("edit_endpoint_required");
    if (!relationship) return refuse("edit_target_missing");
    if (edit.cardinality !== undefined && !Object.hasOwn(MARKERS, edit.cardinality))
      return refuse("edit_invalid_cardinality");
    if (edit.identifying !== undefined && typeof edit.identifying !== "boolean")
      return refuse("edit_invalid_cardinality");
    const from = edit.source ?? relationship.source;
    const to = edit.target ?? relationship.target;
    if ([from, to].some((end) => typeof end !== "string" || !scan.entities.some((e) => e.id === end)))
      return refuse("edit_target_missing");
    if (from.includes("--") || to.includes("--")) return refuse("edit_relationship_id_ambiguous");
    const derived = `${from}--${to}`;
    const moved = derived !== relationship.id;
    const existing = moved ? scan.relationships.find((r) => r.id === derived) : undefined;
    if (existing) return refuse("edit_relationship_exists", existing.id);
    if (derived.length > MAX_ID_CHARS) return refuse("edit_invalid_id");
    const text = relationship.line.text;
    const [left, right] = [relationship.sourceRange, relationship.targetRange];
    const written = (range: [number, number]) => text.slice(range[0], range[1]);
    // The marker token between the two ends, e.g. `||--o{`: only its markers and line are rewritten.
    const between = text.slice(left[1], right[0]);
    const marker = /^(\s*)(\|\||\|o|\}o|\}\|)(--|\.\.)(o\||\|\||o\{|\|\{)(\s*)$/u.exec(between);
    if (!marker) return refuse("edit_source_mapping_ambiguous");
    const modelled = expected.relationships.find((r) => r.id === edit.id);
    if (!modelled) return refuse("edit_source_mapping_ambiguous");
    const identifying = edit.identifying ?? relationship.identifying;
    const [newLeft, newRight, sourceCardinality, targetCardinality] =
      edit.cardinality === undefined
        ? [marker[2]!, marker[4]!, modelled.sourceCardinality, modelled.targetCardinality]
        : MARKERS[edit.cardinality];
    const written2 = `${marker[1]}${newLeft}${identifying ? "--" : ".."}${newRight}${marker[5]}`;
    const markerChanged = written2 !== between;
    if (!moved && !markerChanged) return { ok: true, source };
    // A `:::class` on an end styles that entity: a new name would move it.
    if (
      (from !== relationship.source && written(left) !== relationship.source) ||
      (to !== relationship.target && written(right) !== relationship.target)
    ) {
      return refuse(
        written(left).startsWith(`${relationship.source}:::`) || written(right).startsWith(`${relationship.target}:::`)
          ? "edit_retarget_inline_declaration"
          : "edit_source_mapping_ambiguous",
      );
    }
    if (!written(left).startsWith(relationship.source) || !written(right).startsWith(relationship.target))
      return refuse("edit_source_mapping_ambiguous");
    const region = from + text.slice(left[0] + relationship.source.length, left[1]) + written2 + to;
    if (!spliceInLine(relationship.line, left[0], right[0] + relationship.target.length, region))
      return refuse("edit_source_mapping_ambiguous");
    modelled.id = derived as StableId;
    modelled.source = from as StableId;
    modelled.target = to as StableId;
    modelled.sourceCardinality = sourceCardinality;
    modelled.targetCardinality = targetCardinality;
    modelled.identifying = identifying;
  } else if (edit.kind === "delete-edge") {
    if (!relationship) return refuse("edit_target_missing");
    removeLines(relationship.line, relationship.line);
    expected.relationships = expected.relationships.filter((r) => r.id !== edit.id);
  } else if (edit.kind === "delete-node") {
    if (!entity) return refuse("edit_target_missing");
    if (scan.relationships.some((r) => r.source === edit.id || r.target === edit.id))
      return refuse("edit_delete_referenced_node");
    const styled = preamble.statements.some(
      (l) =>
        l.number > preamble.header!.number &&
        STYLING.test(l.text) &&
        l.text
          .trim()
          .split(/[\s,]+/u)
          .slice(1)
          .includes(edit.id),
    );
    if (styled) return refuse("edit_delete_styling_dependency");
    // One declaration (with its whole attribute block) is one splice; more would be several.
    const [declaration, ...more] = entity.declarations;
    if (!declaration || more.length > 0) return refuse("edit_delete_multiple_declarations");
    removeLines(declaration.line, declaration.close ?? declaration.line);
    expected.entities = expected.entities.filter((e) => e.id !== edit.id);
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
  // Entities are listed in order of first mention, which a retarget can change: compare them by name.
  const byName = (m: unknown) =>
    m && typeof m === "object" && "entities" in m
      ? {
          ...(m as EntityRelationship),
          entities: [...(m as EntityRelationship).entities].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
        }
      : m;
  if (!isDeepStrictEqual(byName(after.model), byName(expected))) return refuse("edit_invalid_result");
  return { ok: true, source: candidate };
}
