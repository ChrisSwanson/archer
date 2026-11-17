// Reads an architecture-beta diagram line by line for where each group,
// service, junction and edge is written, and for the constructs outside the
// profile. Mermaid's parser for this type (Langium) reports its own errors
// with exact positions; the scan adds the profile's rules and positions for
// the adapter.
//
// The profile, statement by statement:
//   group id(icon)[Label] in parent        icon and `in` optional
//   service id(icon)[Label] in group       likewise
//   junction id in group                   `in` optional
//   a:R --> L:b                            an edge: sides L, R, T, B; arrows `--`, `-->`,
//                                          `<--`, `<-->`; a label as `-[label]-`;
//                                          `a{group}` meets the group's boundary
//   title Text
// Icons are Mermaid's built-in five: cloud, database, disk, internet, server.

import { MAX_NESTING_DEPTH } from "../limits.ts";
import type { ArchitectureIcon, ArchitectureSide } from "../../model/index.ts";
import { ARCHITECTURE_ICONS, MAX_ID_CHARS } from "../../model/index.ts";
import type { Span } from "../diagnostics.ts";
import { readLabel } from "../labels.ts";
import { isBlank, isCommentLine, type SourceLine } from "../source.ts";
import { invalidIdMessage, repeatedMessage, Report, textSpan } from "../statements.ts";

export interface ScannedText {
  text: string;
  span: Span;
}

export interface ScannedNode {
  what: "group" | "service" | "junction";
  id: string;
  icon: ArchitectureIcon | undefined;
  label: ScannedText | undefined;
  parent: string | undefined;
  line: SourceLine;
  span: Span;
}

export interface ScannedEdge {
  id: string;
  source: string;
  target: string;
  sourceSide: ArchitectureSide;
  targetSide: ArchitectureSide;
  sourceArrow: boolean;
  targetArrow: boolean;
  sourceGroup: boolean;
  targetGroup: boolean;
  label: ScannedText | undefined;
  line: SourceLine;
  span: Span;
}

export interface ArchitectureScan {
  report: Report;
  title: ScannedText | undefined;
  nodes: ScannedNode[];
  edges: ScannedEdge[];
  /** Edges written again between the same two ends: Mermaid reads them, Archer does not draw them. */
  ignored: ScannedEdge[];
  stopped: boolean;
}

const ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_-]{0,${MAX_ID_CHARS - 1}}$`);
const NODE = /^(group|service)\s+([^\s([]+)(?:\(([^)]*)\))?\s*\[([^\]]*)\](?:\s+in\s+(\S+))?$/;
const JUNCTION = /^junction\s+(\S+?)(?:\s+in\s+(\S+))?$/;
const EDGE = /^([^\s:{]+)(\{group\})?:([LRTB])\s*(<?)-(?:\[([^\]]*)\])?-(>?)\s*([LRTB]):([^\s{]+)(\{group\})?$/;
const SIDES: Record<string, ArchitectureSide> = { L: "left", R: "right", T: "top", B: "bottom" };
const ICONS = new Set<string>(ARCHITECTURE_ICONS);

class Scanner {
  readonly report = new Report();
  readonly scan: ArchitectureScan = {
    report: this.report,
    title: undefined,
    nodes: [],
    edges: [],
    ignored: [],
    stopped: false,
  };
  readonly #ids = new Map<string, ScannedNode>();

  /**
   * Mermaid's Langium lexer refuses some characters a label can hold (ESC)
   * with no position, so labels are checked here too, where the line is known.
   */
  #checked(line: SourceLine, text: ScannedText): ScannedText {
    for (const problem of readLabel(text.text, text.span).problems) this.report.add(line, problem);
    return text;
  }

  line(line: SourceLine): void {
    const text = line.text;
    const start = text.length - text.trimStart().length;
    const trimmed = text.trim();
    if (this.report.trailingComment(line, start)) return;
    const word = /^\S+/.exec(trimmed)?.[0] ?? "";
    if (word === "title") return this.#title(line, start);
    if (word === "group" || word === "service") return this.#node(line, start, trimmed);
    if (word === "junction") return this.#junction(line, start, trimmed);
    if (/^(acctitle|accdescr)/i.test(word))
      return this.report.unsupported(line, "accessibility titles and descriptions", "remove them");
    if (trimmed.includes(":") && trimmed.includes("-")) return this.#edge(line, start, trimmed);
    this.report.unsupported(
      line,
      "this statement",
      "an architecture line is a `group`, `service` or `junction`, or an edge such as `api:R --> L:db`",
    );
  }

  #title(line: SourceLine, start: number): void {
    if (this.scan.title !== undefined)
      return this.report.error(line, "duplicate_title", "the title is set more than once: keep one `title` line");
    const from = start + "title".length;
    const text = line.text.slice(from).trim();
    if (text === "") return this.report.error(line, "expected_label", "expected the title's text after `title`");
    this.scan.title = this.#checked(line, { text, span: textSpan(line, from) });
  }

  #id(line: SourceLine, raw: string, at: number, what: string): string | undefined {
    if (ID.test(raw)) return raw;
    this.report.error(
      line,
      "invalid_id",
      invalidIdMessage(what, raw).replace("and `_`", "`_` and `-`"),
      line.span(at, at + raw.length),
    );
    return undefined;
  }

  #declare(node: ScannedNode): void {
    const known = this.#ids.get(node.id);
    if (known) {
      this.report.error(
        node.line,
        "duplicate_id",
        `'${node.id}' already names a ${known.what} (line ${known.line.number}): give each group, service and junction its own ID`,
        node.span,
      );
      return;
    }
    this.#ids.set(node.id, node);
    this.scan.nodes.push(node);
  }

  #node(line: SourceLine, start: number, trimmed: string): void {
    const match = NODE.exec(trimmed);
    const what = trimmed.startsWith("group") ? "group" : "service";
    if (!match) {
      return this.report.unsupported(
        line,
        `this ${what}`,
        `write \`${what} id(icon)[Label]\`, with \`in group\` after it to place it in a group; the icon is optional`,
      );
    }
    const [, , raw = "", icon, label = "", parent] = match;
    const idStart = line.text.indexOf(raw, start + what.length);
    const id = this.#id(line, raw, idStart, what);
    const span = line.span(idStart, idStart + raw.length);
    if (icon !== undefined && !ICONS.has(icon)) {
      const iconStart = line.text.indexOf(`(${icon})`, idStart) + 1;
      this.report.unsupported(
        line,
        `the icon \`${icon}\``,
        `Archer draws Mermaid's built-in icons only: ${ARCHITECTURE_ICONS.join(", ")}`,
        line.span(iconStart, iconStart + Math.max(icon.length, 1)),
      );
      return;
    }
    const labelStart = line.text.indexOf("[", idStart) + 1;
    const quoted = /^"(.*)"$/.exec(label.trim());
    const text = quoted ? (quoted[1] ?? "") : label.trim();
    if (text === "") {
      return this.report.error(
        line,
        "expected_label",
        `expected a label in the brackets: \`${what} ${raw}[Label]\``,
        line.span(labelStart - 1),
      );
    }
    if (id === undefined) return;
    this.#declare({
      what,
      id,
      icon: icon as ArchitectureIcon | undefined,
      label: this.#checked(line, { text, span: line.span(labelStart, labelStart + Math.max(label.length, 1)) }),
      parent,
      line,
      span,
    });
  }

  #junction(line: SourceLine, start: number, trimmed: string): void {
    const match = JUNCTION.exec(trimmed);
    if (!match)
      return this.report.unsupported(
        line,
        "this junction",
        "write `junction id`, with `in group` after it to place it in a group",
      );
    const [, raw = "", parent] = match;
    const idStart = line.text.indexOf(raw, start + "junction".length);
    const id = this.#id(line, raw, idStart, "junction");
    if (id === undefined) return;
    this.#declare({
      what: "junction",
      id,
      icon: undefined,
      label: undefined,
      parent,
      line,
      span: line.span(idStart, idStart + raw.length),
    });
  }

  #edge(line: SourceLine, start: number, trimmed: string): void {
    const match = EDGE.exec(trimmed);
    if (!match) {
      return this.report.unsupported(
        line,
        "this edge",
        "write an edge as `a:R --> L:b`: each end's side (L, R, T or B) next to it, and `--`, `-->`, `<--` or `<-->` between, " +
          "with a label as `-[label]-`",
      );
    }
    const [
      ,
      left = "",
      leftGroup,
      leftSide = "",
      leftArrow,
      label,
      rightArrow,
      rightSide = "",
      right = "",
      rightGroup,
    ] = match;
    const source = this.#id(line, left, start, "service or junction");
    const rightStart = line.text.lastIndexOf(`:${right}`) + 1;
    const target = this.#id(line, right, rightStart, "service or junction");
    let scannedLabel: ScannedText | undefined;
    if (label !== undefined) {
      const labelStart = line.text.indexOf("[", start + left.length) + 1;
      if (label.trim() === "") {
        return this.report.error(
          line,
          "expected_label",
          "expected a label in `-[...]-`, or no brackets",
          line.span(labelStart - 1),
        );
      }
      scannedLabel = this.#checked(line, {
        text: label.trim(),
        span: line.span(labelStart, labelStart + label.length),
      });
    }
    if (source === undefined || target === undefined) return;
    const id = `${source}--${target}`;
    const span = line.span(start, start + trimmed.length);
    const first = this.scan.edges.find((written) => written.id === id);
    if (first !== undefined) {
      this.report.warning(
        line,
        "duplicate_edge",
        repeatedMessage("edge", source, target, first.line.number, "Write one edge between them."),
        span,
      );
    }
    if (id.length > MAX_ID_CHARS) {
      return this.report.error(
        line,
        "id_too_long",
        `this edge's ID, '${id}', is longer than ${MAX_ID_CHARS} characters: shorten the IDs`,
        span,
      );
    }
    (first === undefined ? this.scan.edges : this.scan.ignored).push({
      id,
      source,
      target,
      sourceSide: SIDES[leftSide] as ArchitectureSide,
      targetSide: SIDES[rightSide] as ArchitectureSide,
      sourceArrow: leftArrow === "<",
      targetArrow: rightArrow === ">",
      sourceGroup: leftGroup !== undefined,
      targetGroup: rightGroup !== undefined,
      label: scannedLabel,
      line,
      span,
    });
  }

  finish(): void {
    for (const node of this.scan.nodes) {
      if (node.parent === undefined) continue;
      const parent = this.#ids.get(node.parent);
      if (parent?.what !== "group") {
        this.report.error(
          node.line,
          "undeclared_group",
          `'${node.parent}' is not a group: declare it with \`group ${node.parent}[Label]\` above this line, or fix the name`,
          node.span,
        );
      }
    }
    // Groups nest at most MAX_NESTING_DEPTH, as boundaries, subgraphs and composite states do.
    // Walked iteratively and cycle-safe: a cycle is the model check's to refuse.
    const groups = new Map(this.scan.nodes.filter((n) => n.what === "group").map((n) => [n.id, n]));
    for (const group of groups.values()) {
      let depth = 0;
      const seen = new Set<string>();
      // Capped one past the bound: a long chain costs no more than the bound per group.
      for (
        let cursor: ScannedNode | undefined = group;
        cursor !== undefined && !seen.has(cursor.id) && depth <= MAX_NESTING_DEPTH;
        cursor = cursor.parent === undefined ? undefined : groups.get(cursor.parent)
      ) {
        seen.add(cursor.id);
        depth++;
      }
      if (depth !== MAX_NESTING_DEPTH + 1) continue;
      this.report.error(
        group.line,
        "nesting_too_deep",
        `this group is nested ${MAX_NESTING_DEPTH + 1} deep, and groups nest at most ${MAX_NESTING_DEPTH}. Flatten the nesting, or split the diagram into views.`,
        group.span,
      );
    }
    for (const edge of this.scan.edges) {
      for (const end of [edge.source, edge.target]) {
        const node = this.#ids.get(end);
        if (node === undefined || node.what === "group") {
          this.report.error(
            edge.line,
            node === undefined ? "undeclared_element" : "unsupported_construct",
            node === undefined
              ? `'${end}' is not a service or junction: declare it, or fix the name if it is a typo`
              : `'${end}' is a group: an edge joins services and junctions; write \`service{group}\` to meet a group's edge`,
            edge.span,
          );
        }
      }
    }
  }
}

export function scanArchitecture(header: SourceLine, statements: readonly SourceLine[]): ArchitectureScan {
  const scanner = new Scanner();
  if (header.text.trim() !== "architecture-beta") {
    scanner.report.unsupported(header, "text after the header", "write `architecture-beta` alone on its line");
  }
  for (const line of statements) {
    if (line.number <= header.number || isBlank(line.text) || isCommentLine(line.text)) continue;
    scanner.line(line);
  }
  scanner.finish();
  return scanner.scan;
}
