// Reads an ER diagram line by line for what Mermaid's database cannot say:
// where each entity, attribute and relationship is written, which entities
// were declared, and the constructs outside the profile.
//
// The profile, statement by statement:
//   NAME                           an entity
//   NAME["Label"]                  an entity with a label
//   NAME {  ...  }                 an entity with attributes, one per line:
//     type name [PK|FK|UK[, ...]] ["comment"]
//   A ||--o{ B : label             a relationship; the label is one word or quoted
//   direction LR                   the diagram's direction
//   classDef, class, style, :::    styling: accepted and ignored

import type { AttributeKey, Cardinality, Direction } from "../../model/index.ts";
import { MAX_ID_CHARS } from "../../model/index.ts";
import type { Span } from "../diagnostics.ts";
import { isBlank, isCommentLine, type SourceLine } from "../source.ts";
import { invalidIdMessage, repeatedMessage, Report } from "../statements.ts";

export interface ScannedAttribute {
  type: string;
  name: string;
  keys: AttributeKey[];
  comment: string | undefined;
  span: Span;
  commentSpan: Span | undefined;
}

/** One line declaring an entity, as UTF-16 offsets into `line.text` (for source-preserving edits). */
export interface ScannedDeclaration {
  line: SourceLine;
  /** Just after the name as written, `:::class` included. */
  nameEnd: number;
  /** The `["label"]`: the brackets, and the text between the quotes. */
  bracket: { start: number; end: number; textStart: number; textEnd: number } | undefined;
  /** The `}` line that closes this declaration's attribute block, when it opens one. */
  close: SourceLine | undefined;
}

export interface ScannedEntity {
  id: string;
  declared: boolean;
  /** Every line that declares it, in source order. */
  declarations: ScannedDeclaration[];
  line: SourceLine;
  span: Span;
  labelSpan: Span | undefined;
  attributes: ScannedAttribute[];
}

export interface ScannedRelationship {
  id: string;
  source: string;
  target: string;
  sourceCardinality: Cardinality;
  targetCardinality: Cardinality;
  identifying: boolean;
  line: SourceLine;
  span: Span;
  labelSpan: Span;
  /** The label as written after `:`, quotes included, as UTF-16 offsets into `line.text`. */
  labelStart: number;
  labelEnd: number;
  /** Each entity name as written (with any `:::class`), as UTF-16 offsets into `line.text`. */
  sourceRange: [number, number];
  targetRange: [number, number];
}

export interface ErScan {
  report: Report;
  /** In order of first mention. */
  entities: ScannedEntity[];
  relationships: ScannedRelationship[];
  /** Relationships written again between the same two entities: Mermaid reads them, Archer does not draw them. */
  ignored: ScannedRelationship[];
  direction: Direction | undefined;
  stopped: boolean;
}

const ENTITY_ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]{0,${MAX_ID_CHARS - 1}}$`);
/** The marker beside the left entity, then the line, then the marker beside the right one. */
const RELATIONSHIP = /^(\S+?)\s+(\|o|\|\||\}o|\}\|)(--|\.\.)(o\||\|\||o\{|\|\{)\s+(\S+?)\s*:\s*(.*)$/;
const LEFT: Record<string, Cardinality> = {
  "|o": "zero-or-one",
  "||": "exactly-one",
  "}o": "zero-or-more",
  "}|": "one-or-more",
};
const RIGHT: Record<string, Cardinality> = {
  "o|": "zero-or-one",
  "||": "exactly-one",
  "o{": "zero-or-more",
  "|{": "one-or-more",
};
const ENTITY = /^([^\s[{"]+)(?:\[\s*"([^"]*)"\s*\])?(\s*\{)?$/;
const ATTRIBUTE = /^(\S+)\s+(\S+)((?:\s+(?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?)(?:\s+"([^"]*)")?$/;
const KEYS = new Set(["PK", "FK", "UK"]);
/** A relationship with its cardinalities in words (`one or more to zero or one`). */
const WORDED = /\b(one|zero|many|only)\b.*\bto\b/i;
/** Words Mermaid's ER lexer reads as cardinality keywords wherever they stand. */
const KEYWORDS = new Set(["one", "zero", "many", "more", "only", "to", "optionally", "u", "or"]);
const EXAMPLE = "`CUSTOMER ||--o{ ORDER : places`";

class Scanner {
  readonly report = new Report();
  readonly scan: ErScan = {
    report: this.report,
    entities: [],
    relationships: [],
    ignored: [],
    direction: undefined,
    stopped: false,
  };
  readonly #entities = new Map<string, ScannedEntity>();
  #block:
    | { entity: ScannedEntity | undefined; declaration?: ScannedDeclaration; line: SourceLine; at: Span }
    | undefined;

  line(line: SourceLine): void {
    const text = line.text;
    const start = text.length - text.trimStart().length;
    const trimmed = text.trim();
    if (this.report.trailingComment(line, start)) return;
    if (this.#block) {
      if (trimmed === "}") {
        if (this.#block.declaration) this.#block.declaration.close = line;
        this.#block = undefined;
        return;
      }
      return this.#attribute(line, start, trimmed);
    }
    if (trimmed === "}")
      return this.report.error(line, "unexpected_token", "`}` with no entity block to close", line.span(start));
    const word = /^\S+/.exec(trimmed)?.[0] ?? "";
    if (word === "classDef" || word === "class" || word === "style") return this.report.styling(line);
    if (word === "direction") return this.#direction(line, trimmed);
    if (/^(title|acctitle|accdescr)/i.test(word)) return this.report.unsupported(line, `\`${word}\``, "remove it");
    if ((/(--|\.\.)/.test(trimmed) && /[|}{o]/.test(trimmed)) || WORDED.test(trimmed))
      return this.#relationship(line, start, trimmed);
    if (trimmed.startsWith('"')) {
      return this.report.error(
        line,
        "invalid_id",
        `a quoted entity name has no ID Archer can anchor to: write \`NAME[${/^"[^"]*"/.exec(trimmed)?.[0] ?? '"Label"'}]\` ` +
          "with an ID of letters, digits, `_` and `-` for NAME",
        line.statementSpan(),
      );
    }
    this.#declaration(line, start, trimmed);
  }

  #id(line: SourceLine, raw: string, offset: number): string | undefined {
    let id = raw;
    const styled = raw.indexOf(":::");
    if (styled > 0) {
      id = raw.slice(0, styled);
      this.report.styling(line);
    }
    if (!ENTITY_ID.test(id)) {
      const quoted = /^"(.*)"$/.exec(id);
      this.report.error(
        line,
        "invalid_id",
        quoted
          ? `a quoted entity name has no ID Archer can anchor to: write \`NAME["${quoted[1] ?? ""}"]\` with an ID of letters, digits, \`_\` and \`-\``
          : invalidIdMessage("entity", id).replace("and `_`", "`_` and `-`"),
        line.span(offset, offset + raw.length),
      );
      return undefined;
    }
    return id;
  }

  #mention(line: SourceLine, id: string, span: Span): ScannedEntity {
    const known = this.#entities.get(id);
    if (known) return known;
    const entity: ScannedEntity = {
      id,
      declared: false,
      declarations: [],
      line,
      span,
      labelSpan: undefined,
      attributes: [],
    };
    this.#entities.set(id, entity);
    this.scan.entities.push(entity);
    return entity;
  }

  #direction(line: SourceLine, trimmed: string): void {
    const match = /^direction\s+(TB|BT|LR|RL)$/.exec(trimmed);
    if (!match) return this.report.unsupported(line, "this direction", "write `direction` and one of TB, BT, LR or RL");
    if (this.scan.direction !== undefined) {
      return this.report.error(
        line,
        "duplicate_direction",
        "the direction is set more than once: keep one `direction` line",
      );
    }
    this.scan.direction = (match[1] ?? "TB").toLowerCase() as Direction;
  }

  #declaration(line: SourceLine, start: number, trimmed: string): void {
    const match = ENTITY.exec(trimmed);
    if (!match) {
      return this.report.unsupported(
        line,
        "this statement",
        `an ER diagram line is an entity (\`NAME\`, \`NAME["Label"]\`, \`NAME {\`) or a relationship (${EXAMPLE})`,
      );
    }
    const [, raw = "", label, brace] = match;
    const id = this.#id(line, raw, start);
    if (id === undefined) {
      if (brace) this.#block = { entity: undefined, line, at: line.statementSpan() };
      return;
    }
    const span = line.span(start, start + id.length);
    const entity = this.#mention(line, id, span);
    entity.declared = true;
    const declaration: ScannedDeclaration = { line, nameEnd: start + raw.length, bracket: undefined, close: undefined };
    entity.declarations.push(declaration);
    if (label !== undefined) {
      const labelStart = line.text.indexOf('"', start) + 1;
      const textEnd = labelStart + label.length;
      declaration.bracket = {
        start: start + raw.length,
        end: line.text.indexOf("]", textEnd) + 1,
        textStart: labelStart,
        textEnd,
      };
      const at = line.span(labelStart, labelStart + Math.max(label.length, 1));
      if (label.trim() === "")
        this.report.error(line, "expected_label", `expected a label: \`${id}["Label"]\`, or no brackets`, at);
      else if (entity.labelSpan !== undefined) {
        this.report.error(
          line,
          "duplicate_declaration",
          `entity '${id}' already has a label (line ${entity.labelSpan.start.line}): an entity takes one label`,
          at,
        );
      } else entity.labelSpan = at;
    }
    if (brace) this.#block = { entity, declaration, line, at: span };
  }

  #attribute(line: SourceLine, start: number, trimmed: string): void {
    const match = ATTRIBUTE.exec(trimmed);
    const entity = this.#block?.entity;
    const [, first = "", second = ""] = match ?? [];
    if (match && KEYS.has(second.replace(/,.*$/, ""))) {
      // `id PK`: Mermaid reads the name as the type and refuses the key.
      return this.report.error(
        line,
        "unsupported_construct",
        `attribute '${first}' has a key but no type: write the type first, then the name and its keys, ` +
          `as in \`int ${first} ${trimmed.slice(first.length).trim()}\``,
        line.statementSpan(),
      );
    }
    if (!match) {
      return this.report.unsupported(
        line,
        "this attribute",
        'write one attribute per line as `type name`, then any of `PK`, `FK`, `UK` separated by commas, then an optional "comment"',
      );
    }
    if (entity === undefined) return;
    const [, type = "", name = "", keys = "", comment] = match;
    const parsedKeys = keys
      .split(",")
      .map((key) => key.trim())
      .filter((key): key is AttributeKey => KEYS.has(key));
    let commentSpan: Span | undefined;
    if (comment !== undefined) {
      const at = line.text.lastIndexOf('"', line.text.trimEnd().length - 2) + 1;
      commentSpan = line.span(at, at + Math.max(comment.length, 1));
    }
    entity.attributes.push({
      type,
      name,
      keys: parsedKeys,
      comment,
      span: line.span(start, start + trimmed.length),
      commentSpan,
    });
  }

  #relationship(line: SourceLine, start: number, trimmed: string): void {
    const match = RELATIONSHIP.exec(trimmed);
    if (!match && !trimmed.includes(":") && RELATIONSHIP.test(`${trimmed} : x`)) {
      return this.report.unsupported(
        line,
        "a relationship with no label",
        `write its label after a colon, ${EXAMPLE}, or \`${trimmed} : ""\` for none`,
      );
    }
    if (!match) {
      const words = /\b(one|zero|many|only)\b/i.test(trimmed);
      return this.report.unsupported(
        line,
        words ? "a relationship written in words" : "this relationship",
        `write the cardinalities as markers (\`|o\`, \`||\`, \`}o\`, \`}|\` on the left; \`o|\`, \`||\`, \`o{\`, \`|{\` on the right), ` +
          `the line as \`--\` or \`..\`, and a label: ${EXAMPLE}`,
      );
    }
    const [, left = "", leftMark = "", lineMark = "", rightMark = "", right = "", label = ""] = match;
    const source = this.#id(line, left, start);
    const rightStart = line.text.indexOf(` ${right}`, start + left.length + 6) + 1;
    const target = this.#id(line, right, rightStart);
    const colon = line.text.indexOf(":", rightStart + right.length);
    const labelStart = colon + 1 + (line.text.slice(colon + 1).length - line.text.slice(colon + 1).trimStart().length);
    const labelSpan = line.span(labelStart, labelStart + Math.max(label.trimEnd().length, 1));
    const text = label.trim();
    if (text === "") {
      return this.report.error(
        line,
        "expected_label",
        `expected a label after \`:\`, or \`""\` for none: ${EXAMPLE}`,
        line.span(colon),
      );
    }
    const keyword = KEYWORDS.has(text.toLowerCase());
    if (!/^"[^"]*"$/.test(text) && (keyword || !/^[A-Za-z_][\w-]*$/.test(text))) {
      return this.report.error(
        line,
        "unquoted_label",
        keyword
          ? `Mermaid reads \`${text}\` as a cardinality keyword: quote the label`
          : "Mermaid reads a second word of an unquoted relationship label as another entity: quote the label",
        labelSpan,
        [
          {
            start: labelStart,
            end: labelStart + label.trimEnd().length,
            replacement: `"${text.replace(/"/g, "#quot;")}"`,
          },
        ],
      );
    }
    if (source === undefined || target === undefined) return;
    this.#mention(line, source, line.span(start, start + source.length));
    this.#mention(line, target, line.span(rightStart, rightStart + target.length));
    const id = `${source}--${target}`;
    const span = line.span(start, start + trimmed.length);
    const first = this.scan.relationships.find((written) => written.id === id);
    if (first !== undefined) {
      this.report.warning(
        line,
        "duplicate_relationship",
        repeatedMessage(
          "relationship",
          source,
          target,
          first.line.number,
          "Write one relationship from the first entity to the second, and put both meanings in its label.",
        ),
        span,
      );
    }
    if (id.length > MAX_ID_CHARS) {
      return this.report.error(
        line,
        "id_too_long",
        `this relationship's ID, '${id}', is longer than ${MAX_ID_CHARS} characters: shorten the entity names`,
        span,
      );
    }
    (first === undefined ? this.scan.relationships : this.scan.ignored).push({
      id,
      source,
      target,
      sourceCardinality: LEFT[leftMark] as Cardinality,
      targetCardinality: RIGHT[rightMark] as Cardinality,
      identifying: lineMark === "--",
      line,
      span,
      labelSpan,
      labelStart,
      labelEnd: labelStart + label.trimEnd().length,
      sourceRange: [start, start + left.length],
      targetRange: [rightStart, rightStart + right.length],
    });
  }

  finish(): void {
    if (this.#block) {
      const { line, at } = this.#block;
      this.report.error(
        line,
        "unclosed_block",
        "this entity's attribute block is never closed: add `}` after its last attribute",
        at,
      );
    }
    for (const entity of this.scan.entities) {
      if (entity.declared) continue;
      this.report.error(
        entity.line,
        "undeclared_entity",
        `entity '${entity.id}' is never declared: add a line \`${entity.id}\` (or \`${entity.id} {\` with its attributes), or fix the name if it is a typo`,
        entity.span,
      );
    }
  }
}

export function scanEr(header: SourceLine, statements: readonly SourceLine[]): ErScan {
  const scanner = new Scanner();
  if (header.text.trim() !== "erDiagram")
    scanner.report.unsupported(header, "text after the header", "write `erDiagram` alone on its line");
  for (const line of statements) {
    if (line.number <= header.number || isBlank(line.text) || isCommentLine(line.text)) continue;
    scanner.line(line);
  }
  scanner.finish();
  return scanner.scan;
}
