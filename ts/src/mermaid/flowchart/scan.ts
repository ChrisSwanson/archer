// Reads a flowchart line by line for what Mermaid's database cannot say:
// where each node, edge and group is written, which edges lack an ID, which
// links and shapes are outside the profile, how deep subgraphs nest, and the
// old Archer forms with the line to write instead.

import { isStableId, type Direction } from "../../model/index.ts";
import { error, info, type Diagnostic, type Span } from "../diagnostics.ts";
import type { Edit, Finding } from "../findings.ts";
import { MAX_NESTING_DEPTH } from "../limits.ts";
import { isBlank, isCommentLine, type SourceLine } from "../source.ts";
import { lexStatement, readId, readShape, type ShapeToken, type Token } from "./lexer.ts";
import { legacyQuote, linkFindings, trailingComment } from "./rewrites.ts";

export interface NodeMention {
  id: string;
  span: Span;
  /** Written with a shape and label here, rather than referred to by ID. */
  declared: boolean;
  /** The line it is written on and the UTF-16 offset just past its ID: where a declaration would go. */
  line: SourceLine;
  end: number;
}

/** A node only ever referred to by its ID: `[id]` written just after its first mention declares it. */
export interface MissingDeclaration {
  line: SourceLine;
  offset: number;
  text: string;
  id: string;
}

export interface EdgeMention {
  id: string;
  span: Span;
}

export interface GroupMention {
  id: string;
  span: Span;
  parent: string | undefined;
}

export interface ClassUse {
  node: string;
  name: string;
  span: Span;
}

export interface MissingEdgeId {
  line: SourceLine;
  offset: number;
  /** What to insert: the ID and its `@`, with a space before it when the link is glued to its source. */
  text: string;
  id: string;
  /** False when the link itself is refused (`a--b`, `-- text -->`): that refusal's rewrite names the ID, and `add-edge-ids` leaves the line alone. */
  fixable: boolean;
}

/** A chained edge moved to a line of its own: its line's text from `start` to `end` (UTF-16) becomes `replacement`. */
export interface ChainSplit extends Edit {
  line: SourceLine;
}

export interface FlowchartScan {
  direction: Direction | undefined;
  findings: Finding[];
  notes: Diagnostic[];
  /** Every mention of each node ID, in source order. */
  nodes: Map<string, NodeMention[]>;
  edges: Map<string, EdgeMention>;
  groups: Map<string, GroupMention>;
  classUses: ClassUse[];
  classDefs: Set<string>;
  /** Each `classDef`'s declaration text and line, for the line-pattern classes (ADR 0030). */
  classDefBodies: Map<string, { text: string; span: Span }>;
  clickTargets: Set<string>;
  /** Links written with no edge ID. */
  anonymousLinks: number;
  /** The ID to insert on each link written with none, at a UTF-16 offset into its line, in source order. */
  missingIds: MissingEdgeId[];
  /** Nodes never given a label, with the declaration to write at their first mention, in source order. */
  missingDeclarations: Map<string, MissingDeclaration>;
  /** Each chained edge's move to a line of its own: the text from `start` to `end` of its line becomes `replacement`. */
  chainSplits: ChainSplit[];
  /** Checking stopped at a subgraph nested too deep; nothing after it was read. */
  stopped: boolean;
}

const DIRECTIONS: Record<string, Direction> = { LR: "lr", RL: "rl", TB: "tb", TD: "tb", BT: "bt" };
const SUPPORTED_SHAPES = new Set(["(", "((", "([", "[", "[[", "[(", "{", "{{"]);
const STYLING = ["style", "linkStyle", "click"] as const;

interface PendingSuggestion {
  finding: Finding;
  edit: Edit;
  source: string;
  target: string;
  op: string;
  fixable: boolean;
}

class Scanner {
  readonly scan: FlowchartScan = {
    direction: undefined,
    findings: [],
    notes: [],
    nodes: new Map(),
    edges: new Map(),
    groups: new Map(),
    classUses: [],
    classDefs: new Set(),
    classDefBodies: new Map(),
    clickTargets: new Set(),
    anonymousLinks: 0,
    missingIds: [],
    missingDeclarations: new Map(),
    chainSplits: [],
    stopped: false,
  };
  readonly #open: { id: string; line: SourceLine; keyword: Span }[] = [];
  readonly #styling = new Map<string, { count: number; first: Span }>();
  readonly #suggestions: PendingSuggestion[] = [];

  #add(...findings: (Finding | undefined)[]): void {
    for (const finding of findings) if (finding) this.scan.findings.push(finding);
  }

  report(line: SourceLine, diagnostic: Diagnostic, edits: Edit[] = [], legacy = false): Finding {
    const finding = { diagnostic, line, edits, legacy };
    this.scan.findings.push(finding);
    return finding;
  }

  header(line: SourceLine): void {
    const text = line.text;
    const keyword = /^\s*(flowchart|graph)/.exec(text);
    if (!keyword) return;
    const afterKeyword = keyword[0].length;
    const rest = text.slice(afterKeyword);
    const direction = /^\s+(\S+)\s*$/.exec(rest);
    const found = direction?.[1];
    if (found !== undefined && found in DIRECTIONS) {
      this.scan.direction = DIRECTIONS[found];
      return;
    }
    const at =
      found === undefined ? line.span(afterKeyword) : line.span(text.indexOf(found, afterKeyword), text.length);
    this.report(
      line,
      error(
        "expected_direction",
        `expected a direction after \`${keyword[1]}\`: one of LR, RL, TB, TD or BT, as in \`${keyword[1]} TB\``,
        at,
      ),
      [{ start: afterKeyword, end: text.length, replacement: " TB" }],
    );
  }

  line(line: SourceLine): void {
    const text = line.text;
    const trimmed = text.trim();
    const start = text.length - text.trimStart().length;
    const word = /^\S+/.exec(trimmed)?.[0] ?? "";
    const followedBySpace = trimmed.length > word.length;
    if (word === "subgraph" && followedBySpace) return this.subgraph(line, start);
    if (word === "end") return this.end(line, start, trimmed);
    if (word === "classDef" && followedBySpace) return this.classDef(line, trimmed);
    if (word === "class" && followedBySpace) return this.classStatement(line, start);
    if ((STYLING as readonly string[]).includes(word) && followedBySpace) return this.styling(line, word, start);
    if (word === "direction" && followedBySpace) {
      this.report(
        line,
        error(
          "unsupported_construct",
          "`direction` inside a diagram is not supported: the header's direction applies to the whole diagram",
          line.span(start, start + word.length),
        ),
      );
      return;
    }
    if (/^(accTitle|accDescr)\b/.test(trimmed) || (word === "title" && followedBySpace)) {
      this.report(
        line,
        error(
          "unsupported_construct",
          "titles and accessibility descriptions are not supported in the source: a view's title comes from its registration",
          line.statementSpan(),
        ),
      );
      return;
    }
    this.statement(line);
  }

  /** After the last line: what is still open, the names of missing edge IDs, the styling notes. */
  finish(): void {
    if (!this.scan.stopped) {
      for (const open of this.#open) {
        this.report(
          open.line,
          error(
            "unclosed_subgraph",
            `subgraph '${open.id}' is never closed: add \`end\` after its last line`,
            open.keyword,
          ),
        );
      }
    }
    const taken = new Set(this.scan.edges.keys());
    for (const suggestion of this.#suggestions) this.#finishSuggestion(suggestion, taken);
    // Mermaid pasted from elsewhere names nodes without declaring them (`a --> b`): `add-edge-ids` declares each at
    // its first mention, its ID as its label (`a[a]`). A subgraph's ID is not a node.
    for (const [id, mentions] of this.scan.nodes) {
      const first = mentions[0];
      if (
        first === undefined ||
        !isStableId(id) ||
        this.scan.groups.has(id) ||
        mentions.some((mention) => mention.declared)
      )
        continue;
      this.scan.missingDeclarations.set(id, { line: first.line, offset: first.end, text: `[${id}]`, id });
    }
    for (const [keyword, { count, first }] of this.#styling) {
      const what = count === 1 ? `this \`${keyword}\` statement is` : `${count} \`${keyword}\` statements are`;
      this.scan.notes.push(
        info(
          "ignored_styling",
          `${what} ignored${count === 1 ? "" : " (the first is here)"}: Archer draws diagrams with its own theme`,
          first,
        ),
      );
    }
  }

  end(line: SourceLine, start: number, trimmed: string): void {
    if (trimmed !== "end") {
      const comment = /^end\s+(%%.*)$/.exec(trimmed);
      if (comment) this.#add(trailingComment(line, line.text.indexOf("%%", start)));
      else return this.statement(line);
    }
    if (this.#open.pop() === undefined) {
      this.report(
        line,
        error("unexpected_token", "`end` with no open `subgraph` to close", line.span(start, start + 3)),
      );
    }
  }

  subgraph(line: SourceLine, start: number): void {
    const text = line.text;
    const keyword = line.span(start, start + "subgraph".length);
    if (this.#open.length >= MAX_NESTING_DEPTH) {
      this.report(
        line,
        error(
          "subgraph_nesting_too_deep",
          `this subgraph is nested ${MAX_NESTING_DEPTH + 1} deep, and subgraphs nest at most ${MAX_NESTING_DEPTH}. ` +
            "Flatten the grouping, or split the diagram into views. Nothing after this line was checked.",
          keyword,
        ),
      );
      this.scan.stopped = true;
      return;
    }
    let at = start + "subgraph".length;
    while (/\s/.test(text[at] ?? "")) at += 1;
    const idEnd = readId(text, at);
    const id = text.slice(at, idEnd);
    let after = idEnd;
    while (/\s/.test(text[after] ?? "")) after += 1;
    let shape: ShapeToken | undefined;
    if (id !== "" && after < text.length && !text.startsWith("%%", after)) {
      shape = readShape(text, after);
      const rest = shape ? text.slice(shape.end).trim() : "";
      if (!shape || (rest !== "" && !rest.startsWith("%%"))) {
        this.#untitledSubgraph(line, at);
        this.#open.push({ id: `\u0000${line.number}`, line, keyword });
        return;
      }
    } else if (id === "") {
      this.#untitledSubgraph(line, at);
      this.#open.push({ id: `\u0000${line.number}`, line, keyword });
      return;
    }
    if (shape && shape.opener !== "[") {
      this.report(
        line,
        error(
          "unsupported_construct",
          "a node shape is not a subgraph label: write `subgraph id[Label]`",
          line.span(shape.start, shape.end),
        ),
        [
          { start: shape.start, end: shape.start + shape.opener.length, replacement: "[" },
          { start: shape.end - shape.closer.length, end: shape.end, replacement: "]" },
        ],
      );
    } else if (shape) {
      this.#add(legacyQuote(line, shape));
    }
    const comment = text.indexOf("%%", shape ? shape.end : idEnd);
    if (comment !== -1) this.#add(trailingComment(line, comment));
    const parent = this.#open.at(-1)?.id;
    const span = line.span(at, idEnd);
    if (this.scan.groups.has(id)) {
      this.report(
        line,
        error("duplicate_subgraph", `subgraph '${id}' is declared more than once: give each subgraph its own ID`, span),
      );
    } else {
      this.scan.groups.set(id, { id, span, parent: parent?.startsWith("\u0000") ? undefined : parent });
    }
    this.#open.push({ id, line, keyword });
  }

  #untitledSubgraph(line: SourceLine, at: number): void {
    const title = line.text
      .slice(at)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    const id =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "group";
    this.report(
      line,
      error(
        "unsupported_construct",
        "a subgraph needs an ID before its title: write `subgraph id[Title]`",
        line.span(at, line.text.trimEnd().length),
      ),
      [{ start: at, end: line.text.trimEnd().length, replacement: `${id}["${title}"]` }],
    );
  }

  classDef(line: SourceLine, trimmed: string): void {
    const names = /^classDef\s+(\S+)/.exec(trimmed)?.[1];
    if (names === undefined) return;
    for (const name of names.split(",")) {
      if (name === "default") this.#styled("classDef default", line.statementSpan());
      else {
        this.scan.classDefs.add(name);
        this.scan.classDefBodies.set(name, { text: trimmed, span: line.statementSpan() });
      }
    }
  }

  classStatement(line: SourceLine, start: number): void {
    const match = /^(class\s+)(\S+)(\s+)(\S+)\s*$/.exec(line.text.slice(start));
    if (!match) return;
    const [, keyword = "", nodes = "", gap = "", name = ""] = match;
    const nameStart = start + keyword.length + nodes.length + gap.length;
    for (const node of nodes.split(",")) {
      this.scan.classUses.push({ node, name, span: line.span(nameStart, nameStart + name.length) });
    }
  }

  styling(line: SourceLine, keyword: string, start: number): void {
    this.#styled(keyword, line.span(start, start + keyword.length));
    if (keyword === "click") {
      const target = /^click\s+(\S+)/.exec(line.text.slice(start))?.[1];
      if (target !== undefined) this.scan.clickTargets.add(target);
    }
  }

  #styled(keyword: string, at: Span): void {
    const seen = this.#styling.get(keyword);
    if (seen) seen.count += 1;
    else this.#styling.set(keyword, { count: 1, first: at });
  }

  /** A node reference at `tokens[index]`: ID, then optional shape, metadata and class. */
  #nodeRef(line: SourceLine, tokens: readonly Token[], index: number): { id: string; next: number } | undefined {
    const idToken = tokens[index];
    if (idToken?.kind !== "id") return undefined;
    let next = index + 1;
    const id = idToken.text;
    const shape = tokens[next]?.kind === "shape" ? (tokens[next] as ShapeToken) : undefined;
    if (shape) {
      next += 1;
      if (!SUPPORTED_SHAPES.has(shape.opener)) {
        this.report(
          line,
          error(
            "unsupported_construct",
            "this node shape is outside the profile: use one of `[ ]` `( )` `([ ])` `(( ))` `{ }` `[( )]` `{{ }}` `[[ ]]`",
            line.span(shape.start, shape.end),
          ),
        );
      } else {
        this.#add(legacyQuote(line, shape));
      }
    }
    const metadata = tokens[next];
    if (metadata?.kind === "metadata") {
      next += 1;
      this.report(
        line,
        error(
          "unsupported_construct",
          "node metadata (`@{ ... }`) is not supported: give the node a shape and label, as in `id[Label]`",
          line.span(metadata.start, metadata.end),
        ),
      );
    }
    const mentions = this.scan.nodes.get(id) ?? [];
    const span = line.span(idToken.start, idToken.end);
    if (shape && mentions.some((mention) => mention.declared)) {
      this.report(
        line,
        error(
          "duplicate_node",
          `node '${id}' is given a label more than once: label it once, and refer to it by its bare ID elsewhere`,
          span,
        ),
      );
    }
    mentions.push({ id, span, declared: shape !== undefined || metadata?.kind === "metadata", line, end: idToken.end });
    this.scan.nodes.set(id, mentions);
    let classes = 0;
    while (tokens[next]?.kind === "class") {
      const token = tokens[next] as Extract<Token, { kind: "class" }>;
      classes += 1;
      if (classes === 2) {
        this.report(
          line,
          error(
            "unsupported_construct",
            "a node takes one class: remove all but one `:::class`",
            line.span(token.start, token.end),
          ),
        );
      }
      this.scan.classUses.push({ node: id, name: token.name, span: line.span(token.start + 3, token.end) });
      next += 1;
    }
    return { id, next };
  }

  statement(line: SourceLine): void {
    const lexed = lexStatement(line.text);
    const tokens = lexed.tokens;
    const ref = this.#nodeRef(line, tokens, 0);
    if (!ref) return;
    let source: string = ref.id;
    let index = ref.next;
    let edgeId: Extract<Token, { kind: "edge-id" }> | undefined;
    let edges = 0;
    // Where the last target node's text ends: a chained edge moves from here to a line of its own.
    let sourceEnd = tokens[ref.next - 1]?.end ?? 0;
    while (index < tokens.length) {
      const token = tokens[index] as Token;
      if (token.kind === "amp") {
        this.report(
          line,
          error(
            "unsupported_construct",
            "`&` is not supported: write one edge per line, each with its own ID",
            line.span(token.start),
          ),
        );
        return;
      }
      if (token.kind === "semi") {
        // Removed at the end of the line; elsewhere, what follows moves to a line of its own.
        const rest = line.text.slice(token.end);
        const edit =
          rest.trim() === ""
            ? { start: token.start, end: token.end, replacement: "" }
            : {
                start: token.start,
                end: token.end + (rest.length - rest.trimStart().length),
                replacement: `\n${line.indent}`,
              };
        this.report(
          line,
          error(
            "unsupported_construct",
            "`;` is not supported: write one statement per line, with no `;`",
            line.span(token.start),
          ),
          [edit],
        );
        index += 1;
        continue;
      }
      if (token.kind === "comment") {
        this.#add(trailingComment(line, token.start));
        return;
      }
      if (token.kind === "edge-id") {
        edgeId = token;
        index += 1;
        continue;
      }
      if (token.kind !== "link" && token.kind !== "text-link") return;
      index += 1;
      const pipe = tokens[index]?.kind === "pipe" ? (tokens[index] as Extract<Token, { kind: "pipe" }>) : undefined;
      if (pipe) index += 1;
      const target = this.#nodeRef(line, tokens, index);
      if (!target) {
        if (index >= tokens.length) {
          this.report(
            line,
            error(
              "expected_target_node",
              "this link has no target node on its line: write `source id@--> target` on one line",
              line.span(token.start, token.end),
            ),
          );
        }
        return;
      }
      index = target.next;
      edges += 1;
      const linkProblems = linkFindings(line, token, pipe);
      this.#add(...linkProblems);
      const chained = edges > 1;
      // The ID goes in before the split is recorded: at one offset, the edit recorded first lands last.
      this.#edgeId(
        line,
        edgeId,
        token,
        source,
        target.id,
        !linkProblems.some((finding) => !finding.legacy && finding.diagnostic.code === "unsupported_construct"),
        chained,
      );
      if (chained) {
        // The edge moves to a line of its own, from its source by its bare ID: `a --> b --> c` → `a --> b` and `b --> c`.
        const split = { start: sourceEnd, end: (edgeId ?? token).start, replacement: `\n${line.indent}${source} ` };
        this.report(
          line,
          error(
            "unsupported_construct",
            "chained edges are not supported: write one edge per line, each with its own ID",
            line.span(token.start, token.end),
          ),
          [split],
        );
        this.scan.chainSplits.push({ line, ...split });
      }
      sourceEnd = tokens[target.next - 1]?.end ?? sourceEnd;
      source = target.id;
      edgeId = undefined;
    }
  }

  #edgeId(
    line: SourceLine,
    edgeId: Extract<Token, { kind: "edge-id" }> | undefined,
    link: Token,
    source: string,
    target: string,
    fixable: boolean,
    chained: boolean,
  ): void {
    if (edgeId === undefined) {
      this.scan.anonymousLinks += 1;
      const before = line.text[link.start - 1];
      // A chained edge's split ends in a space after its source.
      const edit = {
        start: link.start,
        end: link.start,
        replacement: chained || before === undefined || /\s/.test(before) ? "" : " ",
      };
      const finding = this.report(
        line,
        error(
          "unsupported_construct",
          "every edge needs a stable ID, written after its source node: `source id@--> target`",
          line.span(link.start, link.end),
        ),
        [edit],
      );
      this.#suggestions.push({
        finding,
        edit,
        source,
        target,
        op: link.kind === "link" || link.kind === "text-link" ? link.op : "-->",
        fixable,
      });
      return;
    }
    const id = edgeId.text;
    const span = line.span(edgeId.start, edgeId.end - 1);
    if (this.scan.edges.has(id)) {
      this.report(
        line,
        error("duplicate_edge", `edge ID '${id}' is used more than once: give each edge its own ID`, span),
      );
      return;
    }
    this.scan.edges.set(id, { id, span });
  }

  /** Name a missing edge ID once every ID in the file is known, so the name is free. */
  #finishSuggestion(suggestion: PendingSuggestion, taken: Set<string>): void {
    const base =
      `${suggestion.source}_${suggestion.target}`.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[^A-Za-z0-9]+/, "") ||
      "edge";
    let id = base;
    for (let counter = 2; taken.has(id); counter += 1) id = `${base}_${counter}`;
    taken.add(id);
    suggestion.edit.replacement += `${id}@`;
    const op = suggestion.op.startsWith("<") || suggestion.op.endsWith(">") ? suggestion.op : "-->";
    suggestion.finding.diagnostic = {
      ...suggestion.finding.diagnostic,
      message:
        `every edge needs a stable ID, written after its source node: \`${suggestion.source} ${id}@${op} ${suggestion.target}\`. ` +
        "The edit `add-edge-ids` writes one on every edge that has none.",
      fix: { operation: "add-edge-ids" },
    };
    this.scan.missingIds.push({
      line: suggestion.finding.line,
      offset: suggestion.edit.start,
      text: suggestion.edit.replacement,
      id,
      fixable: suggestion.fixable,
    });
  }
}

/** Read the statements of a flowchart whose header is `header`. */
export function scanFlowchart(header: SourceLine, statements: readonly SourceLine[]): FlowchartScan {
  const scanner = new Scanner();
  scanner.header(header);
  for (const line of statements) {
    if (line.number <= header.number || isBlank(line.text) || isCommentLine(line.text)) continue;
    scanner.line(line);
    if (scanner.scan.stopped) break;
  }
  scanner.finish();
  return scanner.scan;
}
