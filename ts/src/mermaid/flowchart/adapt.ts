// Mermaid's reading of a flowchart, held to Archer's profile and turned into
// the freeform graph model. Positions come from the scan; meaning comes from
// Mermaid.

import {
  isStableId,
  type FreeformGraph,
  type GraphCategory,
  type GraphEdge,
  type GraphGroup,
  type GraphNode,
  type GraphSourceOrder,
  type NodeShape,
  type SourceElement,
} from "../../model/index.ts";
import { error, info, warning, type Diagnostic, type Span } from "../diagnostics.ts";
import { CANONICAL_DASH } from "../line-key.ts";
import { restoreEntities } from "../entities.ts";
import { readLabel } from "../labels.ts";
import type { FlowData, FlowEdge, FlowVertex } from "./db.ts";
import type { FlowchartScan } from "./scan.ts";

const SHAPES: Record<string, NodeShape> = {
  square: "rectangle",
  round: "rounded",
  stadium: "stadium",
  circle: "circle",
  diamond: "diamond",
  cylinder: "cylinder",
  hexagon: "hexagon",
  subroutine: "subroutine",
};

const LINES: Record<string, GraphEdge["line"] | undefined> = { normal: undefined, dotted: "dotted", thick: "thick" };
/** The classes an edge may wear: line patterns (ADR 0030). */
const PATTERN_CLASSES = ["dotted", "dashed", "dashdot"] as const;

export const KINDS = ["person", "system", "container", "component", "database", "external"] as const;

export interface Adapted {
  model: FreeformGraph | undefined;
  diagnostics: Diagnostic[];
}

function invalidId(what: string, id: string, at: Span): Diagnostic {
  return error(
    "invalid_id",
    `${what} ID '${id}' is not a stable ID: use 1 to 128 letters, digits, \`_\` and \`-\`, and start with a letter or digit (not \`_\` or \`-\`)`,
    at,
  );
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The value a classDef body gives `property` (`fill`, `stroke`, `stroke-dasharray`), as written. */
function declared(body: string, property: string): string | undefined {
  const pattern = new RegExp(`(?:^|[\\s,])${property}\\s*:\\s*([^,;]+)`);
  return pattern.exec(body.replace(/^classDef\s+\S+/, ""))?.[1]?.trim() || undefined;
}

/**
 * A `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` colour as lowercase `#rrggbb`; `null` for one that is fully
 * transparent (it declares no colour); `undefined` for anything else (a name, `rgb()`), which is not read.
 */
function opaqueHex(written: string): string | null | undefined {
  const hex = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(written)?.[1]?.toLowerCase();
  if (hex === undefined) return undefined;
  const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
  if (full.length === 8 && full.slice(6) === "00") return null;
  return `#${full.slice(0, 6)}`;
}

class Adapter {
  readonly diagnostics: Diagnostic[] = [];

  constructor(
    readonly data: FlowData,
    readonly scan: FlowchartScan,
    /** Where to point when the scan never saw the thing: the header. */
    readonly fallback: Span,
    /** Lines on which the scan already refused something. */
    readonly refusedLines: ReadonlySet<number>,
  ) {}

  #nodeSpan(id: string): Span {
    const mentions = this.scan.nodes.get(id) ?? [];
    return (mentions.find((mention) => mention.declared) ?? mentions[0])?.span ?? this.fallback;
  }

  #label(raw: string, labelType: string, at: Span): string | undefined {
    if (labelType === "markdown") {
      this.diagnostics.push(
        error(
          "unsupported_construct",
          "markdown string labels are not supported: write a plain label, as in `id[Label]`",
          at,
        ),
      );
      return undefined;
    }
    const { label, problems } = readLabel(restoreEntities(raw), at);
    this.diagnostics.push(...problems);
    return problems.length === 0 ? label : undefined;
  }

  node(
    vertex: FlowVertex,
    groupOf: Map<string, string>,
    connected: Set<string>,
    anyEdges: boolean,
  ): GraphNode | undefined {
    const at = this.#nodeSpan(vertex.id);
    if (vertex.type === undefined) {
      this.diagnostics.push(
        this.scan.groups.has(vertex.id)
          ? error(
              "unsupported_construct",
              `'${vertex.id}' is a subgraph, and an edge cannot end at one: connect to a node inside it`,
              at,
            )
          : this.scan.missingDeclarations.has(vertex.id)
            ? {
                ...error(
                  "undeclared_node",
                  `node '${vertex.id}' is never given a label: declare it once, as in \`${vertex.id}[Label]\`, or fix the ID if it is a typo. ` +
                    `\`fix.source\` from \`validate_diagram\` (or \`archer validate <diagram> --json\`) declares every such node with its ID as its label (\`${vertex.id}[${vertex.id}]\`).`,
                  at,
                ),
                fix: { operation: "add-edge-ids" as const },
              }
            : error(
                "undeclared_node",
                `node '${vertex.id}' is never given a label: declare it once, as in \`${vertex.id}[Label]\`, or fix the ID if it is a typo`,
                at,
              ),
      );
      return undefined;
    }
    if (!isStableId(vertex.id)) this.diagnostics.push(invalidId("node", vertex.id, at));
    const shape = SHAPES[vertex.type];
    // The scan refuses a shape it can read where it is written; this catches the rest.
    if (shape === undefined && !this.refusedLines.has(at.start.line)) {
      this.diagnostics.push(
        error(
          "unsupported_construct",
          `the ${vertex.type} shape is outside the profile: use one of \`[ ]\` \`( )\` \`([ ])\` \`(( ))\` \`{ }\` \`[( )]\` \`{{ }}\` \`[[ ]]\``,
          at,
        ),
      );
    }
    const label = this.#label(vertex.text, vertex.labelType, at);
    const classes = vertex.classes.filter((name) => !(name === "clickable" && this.scan.clickTargets.has(vertex.id)));
    if (classes.length > 1) {
      this.diagnostics.push(
        error(
          "unsupported_construct",
          `node '${vertex.id}' has the classes ${classes.join(", ")}: a node takes one class`,
          at,
        ),
      );
    }
    for (const name of classes) this.#checkClass(vertex.id, name, at);
    if (anyEdges && !connected.has(vertex.id)) {
      this.diagnostics.push(
        warning(
          "unconnected_node",
          `node '${vertex.id}' has no incoming or outgoing edges: connect it, or remove it if it is not part of this view`,
          at,
        ),
      );
    }
    if (shape === undefined || label === undefined) return undefined;
    const node: GraphNode = { id: vertex.id, label, shape };
    if (classes.length > 0) node.classes = classes;
    const group = groupOf.get(vertex.id);
    if (group !== undefined) node.groupId = group;
    return node;
  }

  /**
   * A line-pattern class on an edge (ADR 0030): `class e1 dashed` with a
   * `classDef dashed stroke-dasharray: 6 4`, so plain Mermaid draws the same
   * line. Any other class on an edge is reported, never dropped silently.
   * Returns the pattern, `undefined` for none, or `null` when it is refused.
   */
  #patternClass(edge: FlowEdge, at: Span): GraphEdge["line"] | null | undefined {
    const uses = this.scan.classUses.filter((use) => use.node === edge.id);
    // The profile refuses a trailing `;`; on a pattern class it would otherwise
    // be an ignored class here while Mermaid draws the pattern.
    const terminated = uses.find(
      (use) => use.name.endsWith(";") && (PATTERN_CLASSES as readonly string[]).includes(use.name.slice(0, -1)),
    );
    if (terminated !== undefined) {
      this.diagnostics.push(
        error(
          "unsupported_construct",
          `drop the trailing \`;\` after \`class ${edge.id} ${terminated.name.slice(0, -1)}\`: statements end at the line`,
          terminated.span,
        ),
      );
      return null;
    }
    const patterns = uses.filter((use) => (PATTERN_CLASSES as readonly string[]).includes(use.name));
    for (const use of uses.filter((each) => !patterns.includes(each)))
      this.diagnostics.push(
        info(
          "edge_class_ignored",
          `class '${use.name}' on edge '${edge.id}' is ignored: an edge's class can only be a line pattern (dotted, dashed, dashdot)`,
          use.span,
        ),
      );
    if (patterns.length === 0) return undefined;
    const names = [...new Set(patterns.map((use) => use.name))];
    const first = patterns[0]!;
    if (names.length > 1) {
      this.diagnostics.push(
        error(
          "line_pattern_repeated",
          `edge '${edge.id}' has the line patterns ${names.join(" and ")}: give each edge one`,
          first.span,
        ),
      );
      return null;
    }
    const name = names[0] as (typeof PATTERN_CLASSES)[number];
    if (name === "dotted") {
      // Mermaid's own dotted line is `-.->`; a class would draw dotted only in Archer.
      this.diagnostics.push(
        error(
          "line_class_mismatch",
          `a dotted edge is written \`-.->\` in Mermaid: write \`${edge.start} ${edge.id}@-.-> ${edge.end}\` and drop the class`,
          first.span,
        ),
      );
      return null;
    }
    if (edge.stroke !== "normal") {
      this.diagnostics.push(
        error(
          "line_pattern_conflict",
          `edge '${edge.id}' is written \`${edge.stroke === "dotted" ? "-.->" : "==>"}\` and given the class ${name}: write it as \`-->\` with the class, or drop the class`,
          first.span,
        ),
      );
      return null;
    }
    if (name === "dashed" || name === "dashdot") {
      const body = this.scan.classDefBodies.get(name);
      const dash =
        body === undefined
          ? undefined
          : /stroke-dasharray\s*:\s*([\d.\s,]+)/.exec(body.text)?.[1]?.replace(/,/g, " ").replace(/\s+/g, " ").trim();
      if (dash !== CANONICAL_DASH[name]) {
        this.diagnostics.push(
          error(
            "line_class_mismatch",
            `the ${name} class must draw ${name} in Mermaid too: write \`classDef ${name} stroke-dasharray: ${CANONICAL_DASH[name]}\`${body === undefined ? "" : ` (it says ${dash === undefined ? "no dash" : `\`${dash}\``})`}`,
            body?.span ?? first.span,
          ),
        );
        return null;
      }
    }
    return name;
  }

  /**
   * A subgraph's kind or category: `class groupId name`, as a node's, and like a node's at most one. Mermaid
   * has no `:::` on a subgraph, so the `class` statement is the only way it is written.
   */
  #groupClasses(id: string, at: Span): string[] {
    const names = [...new Set(this.scan.classUses.filter((use) => use.node === id).map((use) => use.name))];
    if (names.length > 1) {
      this.diagnostics.push(
        error(
          "unsupported_construct",
          `subgraph '${id}' has the classes ${names.join(", ")}: a subgraph takes one class`,
          at,
        ),
      );
    }
    for (const name of names) this.#checkClass(id, name, at);
    return names;
  }

  /**
   * The authored categories some node or group wears, in declaration order, with what each declares to draw
   * (ADR 0009, amended 2026-11-11). A built-in kind is not a category. A colour Archer cannot read is said
   * so, never dropped silently: the category is then drawn neutral.
   */
  categories(used: ReadonlySet<string>): GraphCategory[] {
    const categories: GraphCategory[] = [];
    for (const name of this.scan.classDefs) {
      if (!used.has(name) || (KINDS as readonly string[]).includes(name)) continue;
      const body = this.scan.classDefBodies.get(name);
      const category: GraphCategory = { name };
      if (body !== undefined) {
        for (const property of ["fill", "stroke"] as const) {
          const written = declared(body.text, property);
          if (written === undefined) continue;
          const colour = opaqueHex(written);
          if (colour === undefined)
            this.diagnostics.push(
              info(
                "category_colour_unread",
                `classDef ${name} ${property} \`${written}\` is not an opaque hex colour, so Archer reads no colour from it: write ${property}:#rrggbb`,
                body.span,
              ),
            );
          else if (colour !== null) category[property] = colour;
        }
        const dash = declared(body.text, "stroke-dasharray");
        if (dash !== undefined && /[1-9]/.test(dash)) category.dashed = true;
      }
      categories.push(category);
    }
    return categories;
  }

  #checkClass(node: string, name: string, at: Span): void {
    if ((KINDS as readonly string[]).includes(name) || this.scan.classDefs.has(name)) return;
    const use = this.scan.classUses.find((candidate) => candidate.node === node && candidate.name === name);
    this.diagnostics.push(
      warning(
        "unknown_class",
        `unknown class '${name}': use one of ${KINDS.join(", ")}, or define it with \`classDef ${name} fill:...,stroke:...\``,
        use?.span ?? at,
      ),
    );
  }

  edge(edge: FlowEdge): GraphEdge | undefined {
    if (!edge.userDefinedId) {
      // The scan names each link it saw without an ID (and Mermaid also
      // drops a repeated ID). A link the scan could not read is still
      // refused, at the header, rather than given Mermaid's generated ID.
      if (this.refusedLines.size === 0) {
        this.diagnostics.push(
          error(
            "unsupported_construct",
            `the edge from '${edge.start}' to '${edge.end}' has no stable ID: write \`${edge.start} id@--> ${edge.end}\``,
            this.fallback,
          ),
        );
      }
      return undefined;
    }
    const at = this.scan.edges.get(edge.id)?.span ?? this.fallback;
    if (!isStableId(edge.id)) this.diagnostics.push(invalidId("edge", edge.id, at));
    if ((edge.type !== "arrow_point" && edge.type !== "double_arrow_point") || !(edge.stroke in LINES)) {
      // The scan reports each such link with its fix; this catches any it could not read.
      if (!this.refusedLines.has(at.start.line)) {
        this.diagnostics.push(
          error(
            "unsupported_construct",
            `edge '${edge.id}' is not a \`-->\`, \`-.->\` or \`==>\` link, or a two-way \`<-->\`, \`<-.->\` or \`<==>\``,
            at,
          ),
        );
      }
      return undefined;
    }
    const result: GraphEdge = { id: edge.id, source: edge.start, target: edge.end };
    if (edge.text !== "") {
      const label = this.#label(edge.text, edge.labelType, at);
      if (label === undefined) return undefined;
      result.label = label;
    }
    const line = LINES[edge.stroke];
    if (line !== undefined) result.line = line;
    const pattern = this.#patternClass(edge, at);
    if (pattern === null) return undefined;
    if (pattern !== undefined) result.line = pattern;
    if (edge.type === "double_arrow_point") result.bidirectional = true;
    return result;
  }

  groups(): { groups: GraphGroup[]; groupOf: Map<string, string> } {
    const groups: GraphGroup[] = [];
    const groupOf = new Map<string, string>();
    for (const subgraph of this.data.subgraphs) {
      const mention = this.scan.groups.get(subgraph.id);
      const at = mention?.span ?? this.fallback;
      if (!isStableId(subgraph.id)) this.diagnostics.push(invalidId("subgraph", subgraph.id, at));
      const label = this.#label(subgraph.title, subgraph.labelType, at);
      const group: GraphGroup = { id: subgraph.id, label: label ?? subgraph.id };
      if (mention?.parent !== undefined) group.parentId = mention.parent;
      const classes = this.#groupClasses(subgraph.id, at);
      if (classes.length > 0) group.classes = classes;
      groups.push(group);
      for (const member of subgraph.members) {
        const isChildGroup = this.scan.groups.get(member)?.parent === subgraph.id;
        if (!isChildGroup && !groupOf.has(member)) groupOf.set(member, subgraph.id);
      }
    }
    return { groups, groupOf };
  }
}

/**
 * A node, edge or group Mermaid's database holds that the scan never saw is a
 * line the two read differently. Archer's checks and positions come from the
 * scan, so such a thing is refused rather than passed through unchecked.
 */
function disagreements(data: FlowData, scan: FlowchartScan, fallback: Span): Diagnostic[] {
  const unseen = [
    ...data.vertices.filter((vertex) => !scan.nodes.has(vertex.id)).map((vertex) => `node '${vertex.id}'`),
    ...data.edges.filter((edge) => edge.userDefinedId && !scan.edges.has(edge.id)).map((edge) => `edge '${edge.id}'`),
    ...data.subgraphs
      .filter((subgraph) => !scan.groups.has(subgraph.id))
      .map((subgraph) => `subgraph '${subgraph.id}'`),
  ];
  return unseen.map((what) =>
    error(
      "parser_disagreement",
      `Mermaid reads a ${what} that Archer does not find written in the source; rewrite the statement that holds it plainly, one statement per line`,
      fallback,
    ),
  );
}

export function adaptFlowchart(
  data: FlowData,
  scan: FlowchartScan,
  fallback: Span,
  refusedLines: ReadonlySet<number>,
): Adapted {
  // When the scan refused a line it stopped reading it, so it would disagree there by design.
  const disagreed = refusedLines.size === 0 ? disagreements(data, scan, fallback) : [];
  if (disagreed.length > 0) return { model: undefined, diagnostics: disagreed };
  const adapter = new Adapter(data, scan, fallback, refusedLines);
  const { groups, groupOf } = adapter.groups();
  const edges = data.edges.map((edge) => adapter.edge(edge));
  const connected = new Set(data.edges.flatMap((edge) => [edge.start, edge.end]));
  const nodes = data.vertices.map((vertex) => adapter.node(vertex, groupOf, connected, data.edges.length > 0));
  const kept = nodes.filter((node): node is GraphNode => node !== undefined);
  const categories = adapter.categories(new Set([...kept, ...groups].flatMap((item) => item.classes ?? [])));
  const drawnEdges = edges.filter((edge): edge is GraphEdge => edge !== undefined);
  const sourceOrder = sourceOrderOf(kept, groups, drawnEdges, scan);
  const diagnostics = adapter.diagnostics;
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return { model: undefined, diagnostics };
  const model: FreeformGraph = {
    type: "freeform-graph",
    direction: scan.direction ?? "tb",
    nodes: kept.sort(byId),
    edges: [...drawnEdges].sort(byId),
    groups: groups.sort(byId),
    ...(categories.length === 0 ? {} : { categories }),
  };
  if (!saysNothingNew(sourceOrder, model)) model.sourceOrder = sourceOrder;
  return { model, diagnostics };
}

/**
 * Whether the written order is the lists' own (every node, then every group, each by id; edges by id): then
 * `sourceOrder` would add nothing, and it is left out. A reader of the order takes that as its meaning.
 */
function saysNothingNew(order: GraphSourceOrder, model: FreeformGraph): boolean {
  const listed = [
    ...model.nodes.map((node) => ({ id: node.id, kind: "node" })),
    ...model.groups.map((group) => ({ id: group.id, kind: "group" })),
  ];
  return (
    order.elements.length === listed.length &&
    order.elements.every((element, at) => element.id === listed[at]!.id && element.kind === listed[at]!.kind) &&
    order.edges.length === model.edges.length &&
    order.edges.every((id, at) => id === model.edges[at]!.id)
  );
}

/**
 * The order the source writes things in, which the model's id-sorted lists lose: nodes and groups by where each
 * is first written (a node's first mention, a group's `subgraph` line), and edges as written. For what reads the
 * source's order -- the layout's model order, the Key's rows (owner, 2026-11-12); never a colour's input.
 */
function sourceOrderOf(
  nodes: readonly GraphNode[],
  groups: readonly GraphGroup[],
  edges: readonly GraphEdge[],
  scan: FlowchartScan,
): GraphSourceOrder {
  const ordered = <T extends { id: string }>(items: readonly { item: T; at: Span | undefined }[]): T[] =>
    items
      .map(({ item, at }) => ({ item, line: at?.start.line ?? Infinity, column: at?.start.column ?? Infinity }))
      .sort(
        (a, b) =>
          a.line - b.line || a.column - b.column || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
      )
      .map(({ item }) => item);
  return {
    elements: ordered<SourceElement>([
      ...nodes.map((node) => ({
        item: { id: node.id, kind: "node" as const },
        at: scan.nodes.get(node.id)?.[0]?.span,
      })),
      ...groups.map((group) => ({
        item: { id: group.id, kind: "group" as const },
        at: scan.groups.get(group.id)?.span,
      })),
    ]),
    edges: ordered(edges.map((edge) => ({ item: { id: edge.id }, at: scan.edges.get(edge.id)?.span }))).map(
      ({ id }) => id,
    ),
  };
}
