// What the terminal painter reads: the graph part of Archer's wire model
// (schema/diagram-envelope.schema.json, `DiagramModel` for the three graph
// types). The types are structural and narrow so the compiled model plugs in
// as it is, with no adapter: a field the schema allows to be null or absent is
// allowed to be null or absent here too.

export type Direction = "tb" | "bt" | "lr" | "rl";

export type NodeShape =
  | "rectangle"
  | "rounded"
  | "stadium"
  | "circle"
  | "diamond"
  | "cylinder"
  | "hexagon"
  | "subroutine";

export type EdgeLine = "solid" | "dotted" | "thick";

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly shape?: NodeShape | null | undefined;
  readonly classes?: readonly string[] | undefined;
  readonly groupId?: string | null | undefined;
}

export interface GraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label?: string | null | undefined;
  readonly line?: EdgeLine | undefined;
  /** An arrowhead at each end (`<-->`). */
  readonly bidirectional?: boolean | undefined;
}

export interface GraphGroup {
  readonly id: string;
  readonly label: string;
  readonly parentId?: string | null | undefined;
}

export interface GraphInput {
  readonly type?: string | undefined;
  readonly direction?: Direction | null | undefined;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly groups: readonly GraphGroup[];
}

const GRAPH_TYPES = new Set(["architecture-graph", "data-flow-graph", "freeform-graph"]);
const DIRECTIONS = new Set<string>(["tb", "bt", "lr", "rl"]);
const SHAPES = new Set<string>([
  "rectangle",
  "rounded",
  "stadium",
  "circle",
  "diamond",
  "cylinder",
  "hexagon",
  "subroutine",
]);
const LINES = new Set<string>(["solid", "dotted", "thick"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const absent = (v: unknown): boolean => v === undefined || v === null;

/**
 * Checks that untrusted JSON (a file named on the command line) is a graph
 * model the painter can draw, and says what is wrong when it is not. Every
 * reference must resolve: an edge to an unknown node would otherwise fail deep
 * inside the layout engine with a message about ports.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function readGraphInput(json: unknown): GraphInput {
  if (!isRecord(json)) throw new Error("the model must be a JSON object");
  const type = json["type"];
  if (type === "sequence-trace")
    throw new Error("sequence diagrams cannot be drawn in the terminal yet; only graphs can");
  if (typeof type !== "string" || !GRAPH_TYPES.has(type))
    throw new Error(
      `model type ${JSON.stringify(type)} is not a graph (expected one of ${[...GRAPH_TYPES].join(", ")})`,
    );
  const direction = json["direction"];
  if (!absent(direction) && !(typeof direction === "string" && DIRECTIONS.has(direction)))
    throw new Error(`direction ${JSON.stringify(direction)} is not one of tb, bt, lr, rl`);

  const list = (key: string): Record<string, unknown>[] => {
    const value = json[key];
    if (!Array.isArray(value)) throw new Error(`"${key}" must be an array`);
    return value.map((item, i) => {
      if (!isRecord(item)) throw new Error(`${key}[${i}] must be an object`);
      return item;
    });
  };
  const text = (item: Record<string, unknown>, where: string, key: string): string => {
    const value = item[key];
    if (typeof value !== "string") throw new Error(`${where}.${key} must be a string`);
    // Ids follow the schema's pattern, so one can never carry a control
    // character into a drawing or an error message.
    if ((key === "id" || key === "source" || key === "target") && !ID.test(value))
      throw new Error(
        `${where}.${key} is not a valid id (letters, digits, "_" and "-", starting with a letter or digit)`,
      );
    return value;
  };
  const optionalText = (item: Record<string, unknown>, where: string, key: string): string | undefined => {
    const value = item[key];
    if (absent(value)) return undefined;
    if (typeof value !== "string") throw new Error(`${where}.${key} must be a string`);
    return value;
  };

  const groups: GraphGroup[] = list("groups").map((g, i) => {
    const where = `groups[${i}]`;
    const parentId = optionalText(g, where, "parentId");
    return {
      id: text(g, where, "id"),
      label: text(g, where, "label"),
      ...(parentId === undefined ? {} : { parentId }),
    };
  });
  const nodes: GraphNode[] = list("nodes").map((n, i) => {
    const where = `nodes[${i}]`;
    const shape = n["shape"];
    if (!absent(shape) && !(typeof shape === "string" && SHAPES.has(shape)))
      throw new Error(`${where}.shape ${JSON.stringify(shape)} is not a known shape`);
    const classes = n["classes"];
    if (classes !== undefined && !(Array.isArray(classes) && classes.every((c) => typeof c === "string")))
      throw new Error(`${where}.classes must be an array of strings`);
    const groupId = optionalText(n, where, "groupId");
    return {
      id: text(n, where, "id"),
      label: text(n, where, "label"),
      ...(absent(shape) ? {} : { shape: shape as NodeShape }),
      ...(classes === undefined ? {} : { classes: classes as string[] }),
      ...(groupId === undefined ? {} : { groupId }),
    };
  });
  const edges: GraphEdge[] = list("edges").map((e, i) => {
    const where = `edges[${i}]`;
    const line = e["line"];
    if (line !== undefined && !(typeof line === "string" && LINES.has(line)))
      throw new Error(`${where}.line ${JSON.stringify(line)} is not solid, dotted or thick`);
    const label = optionalText(e, where, "label");
    const bidirectional = e["bidirectional"];
    if (bidirectional !== undefined && typeof bidirectional !== "boolean")
      throw new Error(`${where}.bidirectional must be true or false`);
    return {
      id: text(e, where, "id"),
      source: text(e, where, "source"),
      target: text(e, where, "target"),
      ...(label === undefined ? {} : { label }),
      ...(line === undefined ? {} : { line: line as EdgeLine }),
      ...(bidirectional === true ? { bidirectional: true } : {}),
    };
  });

  const unique = (items: readonly { id: string }[], what: string): Set<string> => {
    const ids = new Set<string>();
    for (const item of items) {
      if (ids.has(item.id)) throw new Error(`${what} "${item.id}" appears twice`);
      ids.add(item.id);
    }
    return ids;
  };
  const nodeIds = unique(nodes, "node");
  const groupIds = unique(groups, "group");
  unique(edges, "edge");
  for (const n of nodes)
    if (n.groupId != null && !groupIds.has(n.groupId))
      throw new Error(`node "${n.id}" is in unknown group "${n.groupId}"`);
  for (const g of groups)
    if (g.parentId != null && !groupIds.has(g.parentId))
      throw new Error(`group "${g.id}" is in unknown group "${g.parentId}"`);
  for (const g of groups) {
    // A cycle of parents would send the layout's walk round for ever.
    const seen = new Set<string>();
    for (let at: string | null | undefined = g.id; at != null; at = groups.find((p) => p.id === at)?.parentId) {
      if (seen.has(at)) throw new Error(`group "${g.id}" is inside itself`);
      seen.add(at);
    }
  }
  for (const e of edges)
    for (const end of [e.source, e.target])
      if (!nodeIds.has(end)) throw new Error(`edge "${e.id}" names unknown node "${end}"`);

  return { type, ...(absent(direction) ? {} : { direction: direction as Direction }), nodes, edges, groups };
}
