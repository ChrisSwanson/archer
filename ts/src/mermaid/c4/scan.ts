// Reads a C4 diagram line by line. Mermaid's C4 grammar accepts much that it
// then reads wrongly or drops without a word (a `Rel` with no label swallows
// the next line; a `$tags` argument drops the relationship; a second element
// with an alias moves the first), so the scan holds every statement to the
// profile's exact form and the adapter compares Mermaid's reading with it.
//
// The profile, statement by statement (every argument after an alias quoted):
//   Person(alias, "Label", "Description")                 _Ext: external
//   System(alias, "Label", "Description")                 SystemDb, SystemQueue, _Ext
//   Container(alias, "Label", "Technology", "Description") ContainerDb, ContainerQueue, _Ext
//   Component(alias, "Label", "Technology", "Description") ComponentDb, ComponentQueue, _Ext
//   Enterprise_Boundary(alias, "Label") {   ...   }        System_, Container_Boundary, Boundary
//   Rel(from, to, "Label", "Technology", "Description")   BiRel; Rel_U/D/L/R: Rel, hint ignored
//   title Text
//   UpdateElementStyle, UpdateRelStyle, UpdateBoundaryStyle, UpdateLayoutConfig,
//   AddElementTag, AddRelTag: styling, accepted and ignored

import type { C4BoundaryKind, C4ElementKind, C4ElementShape, C4Level } from "../../model/index.ts";
import { MAX_ID_CHARS } from "../../model/index.ts";
import { info, type Span } from "../diagnostics.ts";
import { MAX_NESTING_DEPTH } from "../limits.ts";
import { isBlank, isCommentLine, type SourceLine } from "../source.ts";
import { invalidIdMessage, Report, textSpan } from "../statements.ts";

export interface ScannedText {
  text: string;
  span: Span;
}

export interface ScannedElement {
  id: string;
  kind: C4ElementKind;
  external: boolean;
  shape: C4ElementShape | undefined;
  /** Mermaid's name for the macro's shape: `external_container_db`. */
  mermaidType: string;
  label: ScannedText;
  technology: ScannedText | undefined;
  description: ScannedText | undefined;
  boundary: string | undefined;
  line: SourceLine;
  span: Span;
}

export interface ScannedBoundary {
  id: string;
  kind: C4BoundaryKind;
  label: ScannedText;
  parent: string | undefined;
  line: SourceLine;
  span: Span;
  empty: boolean;
}

export interface ScannedRelationship {
  id: string;
  source: string;
  target: string;
  bidirectional: boolean;
  /** Mermaid's name for the macro: `rel`, `birel`, `rel_d`, ... */
  mermaidType: string;
  label: ScannedText;
  technology: ScannedText | undefined;
  description: ScannedText | undefined;
  line: SourceLine;
  span: Span;
  sourceSpan: Span;
  targetSpan: Span;
  /**
   * Later lines naming the same two aliases. Mermaid keeps one relationship per pair, at the first
   * one's place, and each later one replaces its label and type, and its technology and description
   * where it gives them; the fields above are the result.
   */
  merged: SourceLine[];
}

export interface C4Scan {
  report: Report;
  level: C4Level | undefined;
  title: ScannedText | undefined;
  elements: ScannedElement[];
  boundaries: ScannedBoundary[];
  relationships: ScannedRelationship[];
  stopped: boolean;
}

const ALIAS = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_]{0,${MAX_ID_CHARS - 1}}$`);
const ELEMENT =
  /^(Person|System|SystemDb|SystemQueue|Container|ContainerDb|ContainerQueue|Component|ComponentDb|ComponentQueue)(_Ext)?$/;
const BOUNDARIES: Record<string, { kind: C4BoundaryKind; mermaid: string }> = {
  Enterprise_Boundary: { kind: "enterprise", mermaid: "ENTERPRISE" },
  System_Boundary: { kind: "system", mermaid: "SYSTEM" },
  Container_Boundary: { kind: "container", mermaid: "CONTAINER" },
  Boundary: { kind: "generic", mermaid: "system" },
};
const RELATIONS = new Set([
  "Rel",
  "BiRel",
  "Rel_U",
  "Rel_Up",
  "Rel_D",
  "Rel_Down",
  "Rel_L",
  "Rel_Left",
  "Rel_R",
  "Rel_Right",
]);
const MERMAID_REL: Record<string, string> = {
  Rel: "rel",
  BiRel: "birel",
  Rel_U: "rel_u",
  Rel_Up: "rel_u",
  Rel_D: "rel_d",
  Rel_Down: "rel_d",
  Rel_L: "rel_l",
  Rel_Left: "rel_l",
  Rel_R: "rel_r",
  Rel_Right: "rel_r",
};
const STYLING = new Set([
  "UpdateElementStyle",
  "UpdateRelStyle",
  "UpdateBoundaryStyle",
  "UpdateLayoutConfig",
  "AddElementTag",
  "AddRelTag",
]);
const LEVELS: Record<string, C4Level> = { C4Context: "context", C4Container: "container", C4Component: "component" };

export interface Argument {
  /** As written, trimmed. */
  raw: string;
  /** The text inside the quotes, when quoted. */
  text: string | undefined;
  start: number;
  span: Span;
}

/** The arguments between `(` at `open` and its `)`, split at commas outside quotes; undefined when unbalanced. */
export function readArguments(line: SourceLine, open: number): { args: Argument[]; close: number } | undefined {
  const text = line.text;
  const args: Argument[] = [];
  let quoted = false;
  let from = open + 1;
  for (let index = open + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') quoted = !quoted;
    else if (!quoted && (character === "," || character === ")")) {
      const piece = text.slice(from, index);
      const start = from + (piece.length - piece.trimStart().length);
      const raw = piece.trim();
      const inner = /^"([^"]*)"$/.exec(raw);
      args.push({ raw, text: inner?.[1], start, span: line.span(start, start + Math.max(raw.length, 1)) });
      from = index + 1;
      if (character === ")") return { args, close: index };
    }
  }
  return undefined;
}

class Scanner {
  readonly report = new Report();
  readonly scan: C4Scan = {
    report: this.report,
    level: undefined,
    title: undefined,
    elements: [],
    boundaries: [],
    relationships: [],
    stopped: false,
  };
  readonly #ids = new Map<string, { line: SourceLine; boundary: boolean }>();
  readonly #open: ScannedBoundary[] = [];
  readonly #hints: Span[] = [];

  line(line: SourceLine): void {
    const text = line.text;
    const start = text.length - text.trimStart().length;
    const trimmed = text.trim();
    if (this.report.trailingComment(line, start)) return;
    if (trimmed === "}") return this.#close(line, start);
    if (/^title(\s|$)/.test(trimmed)) return this.#title(line, start);
    const macro = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(trimmed);
    if (!macro) {
      if (/^(acctitle|accdescr)/i.test(trimmed))
        return this.report.unsupported(line, "accessibility titles and descriptions", "remove them");
      return this.report.unsupported(
        line,
        "this statement",
        'a C4 line is an element, a boundary or a relationship, such as `Person(user, "User")` or `Rel(user, app, "Uses")`',
      );
    }
    const name = macro[1] ?? "";
    if (STYLING.has(name)) return this.report.styling(line);
    const open = start + macro[0].length - 1;
    const read = readArguments(line, open);
    if (read === undefined) {
      return this.report.error(
        line,
        "unexpected_end",
        `\`${name}(\` is never closed: end the statement with \`)\` on the same line`,
        line.span(start, open + 1),
      );
    }
    const after = text.slice(read.close + 1).trim();
    const brace = after === "{";
    if (after !== "" && !brace) {
      return this.report.unsupported(
        line,
        "text after the statement",
        "write one statement per line",
        line.span(read.close + 1, text.trimEnd().length),
      );
    }
    // A refused statement that opens a block still opens one, so its `}` closes it.
    if (brace && !(name in BOUNDARIES))
      this.#open.push({
        id: "",
        kind: "generic",
        label: { text: "", span: line.statementSpan() },
        parent: undefined,
        line,
        span: line.statementSpan(),
        empty: false,
      });
    const named = read.args.find((arg) => arg.raw.startsWith("$"));
    if (named) {
      return this.report.unsupported(
        line,
        `the named argument \`${named.raw.split("=")[0]}\``,
        "remove it; sprites, tags and links are not drawn",
        named.span,
      );
    }
    const element = ELEMENT.exec(name);
    if (element) return this.#element(line, start, name, element[1] ?? "", element[2] !== undefined, read.args, brace);
    const boundary = BOUNDARIES[name];
    if (boundary) return this.#boundary(line, start, name, boundary, read.args, brace);
    if (RELATIONS.has(name)) return this.#relationship(line, start, name, read.args, brace);
    if (name === "Rel_Back") {
      const [from, to] = read.args;
      return this.report.unsupported(
        line,
        "`Rel_Back`",
        `write the relationship the way it points: \`Rel(${to?.raw ?? "to"}, ${from?.raw ?? "from"}, ...)\``,
        line.span(start, start + name.length),
      );
    }
    if (/^(Deployment_Node|Node|Node_L|Node_R|RelIndex|Person_Db)$/.test(name) || /^Deployment/.test(name)) {
      return this.report.unsupported(
        line,
        `\`${name}\``,
        "C4 dynamic and deployment diagrams are not supported",
        line.span(start, start + name.length),
      );
    }
    this.report.unsupported(
      line,
      `\`${name}\``,
      "use Person, System, Container, Component (with Db, Queue or _Ext), a boundary, Rel or BiRel",
      line.span(start, start + name.length),
    );
  }

  #title(line: SourceLine, start: number): void {
    if (this.scan.title !== undefined)
      return this.report.error(line, "duplicate_title", "the title is set more than once: keep one `title` line");
    const from = start + "title".length;
    const text = line.text.slice(from).trim();
    if (text === "") return this.report.error(line, "expected_label", "expected the title's text after `title`");
    this.scan.title = { text, span: textSpan(line, from) };
  }

  #alias(line: SourceLine, arg: Argument | undefined, what: string, at: Span): string | undefined {
    if (arg === undefined || arg.raw === "") {
      this.report.error(line, "expected_id", `expected the ${what}'s alias as the first argument`, at);
      return undefined;
    }
    if (!ALIAS.test(arg.raw)) {
      this.report.error(line, "invalid_id", invalidIdMessage(what, arg.raw), arg.span);
      return undefined;
    }
    return arg.raw;
  }

  /** The quoted argument at `index`; undefined when absent, and refused when written unquoted. */
  #text(line: SourceLine, args: readonly Argument[], index: number, what: string): ScannedText | undefined | null {
    const arg = args[index];
    if (arg === undefined) return undefined;
    if (arg.text === undefined) {
      this.report.error(
        line,
        "unquoted_argument",
        `the ${what} must be quoted: Mermaid reads an unquoted C4 argument differently from what is written`,
        arg.span,
        arg.raw.includes('"')
          ? []
          : [{ start: arg.start, end: arg.start + arg.raw.length, replacement: `"${arg.raw}"` }],
      );
      return null;
    }
    const inner = arg.raw.length > 2 ? line.span(arg.start + 1, arg.start + arg.raw.length - 1) : arg.span;
    return { text: arg.text, span: inner };
  }

  #declare(line: SourceLine, id: string, at: Span, boundary: boolean): boolean {
    const known = this.#ids.get(id);
    if (known) {
      this.report.error(
        line,
        "duplicate_id",
        `'${id}' is already an alias (line ${known.line.number}), and Mermaid would move the first to here: give each element and boundary its own alias`,
        at,
      );
      return false;
    }
    this.#ids.set(id, { line, boundary });
    return true;
  }

  #element(
    line: SourceLine,
    start: number,
    name: string,
    base: string,
    external: boolean,
    args: Argument[],
    brace: boolean,
  ): void {
    const at = line.span(start, start + name.length);
    if (brace)
      return this.report.unsupported(
        line,
        "a body on an element",
        "only boundaries hold other elements: move what it holds into a boundary",
        at,
      );
    const kind = (
      /^Person/.test(base)
        ? "person"
        : /^System/.test(base)
          ? "system"
          : /^Container/.test(base)
            ? "container"
            : "component"
    ) as C4ElementKind;
    const shape: C4ElementShape | undefined = base.endsWith("Db")
      ? "database"
      : base.endsWith("Queue")
        ? "queue"
        : undefined;
    const most = kind === "person" || kind === "system" ? 3 : 4;
    if (args.length > most) {
      return this.report.unsupported(
        line,
        `a ${most + 1}th argument`,
        `${name} takes an alias, a label${most === 4 ? ", a technology" : ""} and a description; sprites, tags and links are not drawn`,
        args[most]?.span ?? at,
      );
    }
    const id = this.#alias(line, args[0], kind, at);
    const label = this.#text(line, args, 1, "label");
    const technology = most === 4 ? this.#text(line, args, 2, "technology") : undefined;
    const description = this.#text(line, args, most - 1, "description");
    if (label === undefined)
      return this.report.error(line, "expected_label", `expected a label: \`${name}(alias, "Label")\``, at);
    if (id === undefined || label === null || technology === null || description === null) return;
    const span = args[0]?.span ?? at;
    if (!this.#declare(line, id, span, false)) return;
    const mermaidType = `${external ? "external_" : ""}${kind}${shape === "database" ? "_db" : shape === "queue" ? "_queue" : ""}`;
    const boundary = this.#open.at(-1);
    if (boundary) boundary.empty = false;
    this.scan.elements.push({
      id,
      kind,
      external,
      shape,
      mermaidType,
      label,
      technology,
      description,
      boundary: boundary?.id,
      line,
      span,
    });
  }

  #boundary(
    line: SourceLine,
    start: number,
    name: string,
    found: { kind: C4BoundaryKind },
    args: Argument[],
    brace: boolean,
  ): void {
    const at = line.span(start, start + name.length);
    if (!brace)
      return this.report.error(
        line,
        "expected_block",
        `a boundary holds elements: end the line with \`{\`, and close it with \`}\``,
        at,
      );
    if (args.length > 2) {
      this.#open.push({
        id: "",
        kind: found.kind,
        label: { text: "", span: at },
        parent: undefined,
        line,
        span: at,
        empty: false,
      });
      return this.report.unsupported(
        line,
        "a boundary's third argument",
        "a boundary takes an alias and a label",
        args[2]?.span ?? at,
      );
    }
    if (this.#open.length >= MAX_NESTING_DEPTH) {
      this.report.error(
        line,
        "nesting_too_deep",
        `this boundary is nested ${MAX_NESTING_DEPTH + 1} deep, and boundaries nest at most ${MAX_NESTING_DEPTH}. ` +
          "Flatten the nesting, or split the diagram into views. Nothing after this line was checked.",
        at,
      );
      this.scan.stopped = true;
      return;
    }
    const id = this.#alias(line, args[0], "boundary", at);
    const label = this.#text(line, args, 1, "label");
    const parent = this.#open.at(-1);
    if (parent) parent.empty = false;
    const span = args[0]?.span ?? at;
    const scanned: ScannedBoundary = {
      id: id ?? "",
      kind: found.kind,
      label: label ?? { text: "", span },
      parent: parent?.id,
      line,
      span,
      empty: true,
    };
    this.#open.push(scanned);
    if (label === undefined)
      return this.report.error(line, "expected_label", `expected a label: \`${name}(alias, "Label") {\``, at);
    if (id === undefined || label === null || !this.#declare(line, id, span, true)) return;
    this.scan.boundaries.push(scanned);
  }

  #close(line: SourceLine, start: number): void {
    const closed = this.#open.pop();
    if (closed === undefined)
      return this.report.error(line, "unexpected_token", "`}` with no boundary to close", line.span(start));
    if (closed.empty && closed.id !== "") {
      this.report.error(
        closed.line,
        "empty_boundary",
        `boundary '${closed.id}' holds nothing, and Mermaid cannot read an empty one: put an element in it, or remove it`,
        closed.span,
      );
    }
  }

  #relationship(line: SourceLine, start: number, name: string, args: Argument[], brace: boolean): void {
    const at = line.span(start, start + name.length);
    if (brace) return this.report.unsupported(line, "a body on a relationship", "move what it holds out of it", at);
    if (args.length > 5) {
      return this.report.unsupported(
        line,
        "a sixth argument",
        `${name} takes two aliases, a label, a technology and a description`,
        args[5]?.span ?? at,
      );
    }
    const source = this.#alias(line, args[0], "element", at);
    const target = this.#alias(line, args[1], "element", at);
    const label = this.#text(line, args, 2, "label");
    const technology = this.#text(line, args, 3, "technology");
    const description = this.#text(line, args, 4, "description");
    if (args.length < 2) return;
    if (label === undefined) {
      return this.report.error(
        line,
        "expected_label",
        `expected a label: \`${name}(${source ?? "from"}, ${target ?? "to"}, "Label")\`; Mermaid reads the next line into a relationship without one`,
        at,
      );
    }
    if (source === undefined || target === undefined || label === null || technology === null || description === null)
      return;
    if (!/^Rel$|^BiRel$/.test(name)) this.#hints.push(at);
    const id = `${source}--${target}`;
    const span = line.statementSpan();
    const first = this.scan.relationships.find((written) => written.id === id);
    if (first !== undefined) {
      this.report.warning(
        line,
        "duplicate_relationship",
        `this relationship repeats the one from '${source}' to '${target}' on line ${first.line.number}. Mermaid keeps one ` +
          "relationship per pair: it draws the first one with this one's label and arrow (and its technology and description, " +
          "where given) in place of the first's, and Archer draws what Mermaid draws. Write one relationship, with everything it carries.",
        span,
      );
      first.label = label;
      if (technology !== undefined) first.technology = technology;
      if (description !== undefined) first.description = description;
      first.bidirectional = name === "BiRel";
      first.mermaidType = MERMAID_REL[name] ?? "rel";
      first.merged.push(line);
      return;
    }
    if (id.length > MAX_ID_CHARS) {
      return this.report.error(
        line,
        "id_too_long",
        `this relationship's ID, '${id}', is longer than ${MAX_ID_CHARS} characters: shorten the aliases`,
        span,
      );
    }
    this.scan.relationships.push({
      id,
      source,
      target,
      bidirectional: name === "BiRel",
      mermaidType: MERMAID_REL[name] ?? "rel",
      label,
      technology,
      description,
      line,
      span: args[0]?.span ?? at,
      sourceSpan: args[0]?.span ?? at,
      targetSpan: args[1]?.span ?? at,
      merged: [],
    });
  }

  finish(): void {
    if (!this.scan.stopped) {
      for (const boundary of this.#open) {
        if (boundary.id === "") continue;
        this.report.error(
          boundary.line,
          "unclosed_block",
          `boundary '${boundary.id}' is never closed: add \`}\` after its last line`,
          boundary.span,
        );
      }
    }
    for (const relationship of this.scan.relationships) {
      for (const [end, at] of [
        [relationship.source, relationship.sourceSpan],
        [relationship.target, relationship.targetSpan],
      ] as const) {
        const known = this.#ids.get(end);
        if (known === undefined) {
          this.report.error(
            relationship.line,
            "undeclared_element",
            `'${end}' is not the alias of any element: declare it (\`System(${end}, "Label")\`), or fix the name if it is a typo`,
            at,
          );
        } else if (known.boundary) {
          this.report.error(
            relationship.line,
            "unsupported_construct",
            `'${end}' is a boundary: a relationship connects two elements`,
            at,
          );
        }
      }
    }
    const first = this.#hints[0];
    if (first !== undefined) {
      this.report.notes.push(
        info(
          "ignored_layout_hint",
          `${this.#hints.length === 1 ? "this direction is" : `${this.#hints.length} directions are`} ignored${this.#hints.length === 1 ? "" : " (the first is here)"}: Archer lays the diagram out itself, and reads \`Rel_D\` and the others as \`Rel\``,
          first,
        ),
      );
    }
  }
}

export function scanC4(header: SourceLine, statements: readonly SourceLine[]): C4Scan {
  const scanner = new Scanner();
  const word = header.text.trim();
  const level = LEVELS[word];
  if (level === undefined) {
    scanner.report.unsupported(
      header,
      /^C4(Dynamic|Deployment)$/.test(word) ? `\`${word}\`` : "text after the header",
      /^C4(Dynamic|Deployment)$/.test(word)
        ? "Archer reads C4Context, C4Container and C4Component diagrams"
        : "write `C4Context`, `C4Container` or `C4Component` alone on its line",
    );
  }
  scanner.scan.level = level;
  for (const line of statements) {
    if (line.number <= header.number || isBlank(line.text) || isCommentLine(line.text)) continue;
    scanner.line(line);
    if (scanner.scan.stopped) break;
  }
  scanner.finish();
  return scanner.scan;
}
