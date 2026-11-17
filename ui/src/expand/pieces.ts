/**
 * The Expand menu's answer as the page reads it (GET api/expand-menu; schema/explorations.v1.schema.json),
 * and a piece turned into what the canvas draws: its cut model wrapped as an envelope and projected in its
 * own notation (O3), with its attach wires projected the same way, so a C4 wire still carries its
 * technology and an architecture wire its arrows.
 */
import { projectEnvelope, type ProjectedEdge } from "../diagrams/projection";
import type { FramePiece } from "./frame-view";

export type Omitted = "own" | "limit" | "bytes";
export type Adds = { readonly boxes: number; readonly wires: number };
export type AttachWire = {
  readonly key: string;
  readonly from: string;
  readonly to: string;
  readonly direction: "forward" | "reverse" | "two-way" | "undirected";
  readonly label?: string;
  readonly technology?: string;
  readonly line?: string;
};

export type Piece = {
  readonly source: string;
  readonly revision: string;
  readonly family: "c4" | "architecture" | "flowchart" | "er";
  readonly touches: string;
  readonly opens: boolean;
  readonly kind: string;
  readonly model: { readonly type: string } & Record<string, unknown>;
  readonly attach: readonly AttachWire[];
  readonly boxes: number;
  readonly wires: number;
  readonly total: { readonly boxes: number; readonly wires: number };
  readonly truncated: boolean;
};

export type Reading = { readonly kind?: string; readonly parent?: string; readonly views: readonly string[] };

export type DiagramEntry = {
  readonly source: string;
  readonly title: string;
  readonly family: string;
  readonly sourceRevision: string;
  readonly relation: "opens" | "draws";
  readonly reading: number;
  readonly proposed?: true;
  readonly adds: Adds;
  readonly onCanvas: boolean;
  readonly piece: Piece | null;
  readonly omitted?: Omitted;
};

export type NeighbourEntry = {
  readonly element: string;
  readonly name: string;
  readonly kinds: readonly string[];
  readonly direction: string;
  readonly via: string;
  readonly viaTitle: string;
  readonly viaRevision: string;
  readonly alsoDrawnIn: number;
  readonly proposed?: true;
  readonly adds: Adds;
  readonly onCanvas: boolean;
  readonly piece: Piece | null;
  readonly omitted?: Omitted;
};

export type Limits = {
  readonly maxAddedSources: number;
  readonly maxAddedBoxes: number;
  readonly maxAddedWires: number;
  readonly maxMenuCandidates: number;
  readonly maxRelationshipsPerElement: number;
  readonly maxPieceBoxes: number;
  readonly maxResponseBytes: number;
  readonly maxExpansions: number;
  readonly maxExpandParamChars: number;
};

export type ExpandMenu = {
  readonly schemaVersion: 1;
  readonly viewId: string;
  readonly revision: string;
  readonly modelGeneration: number;
  readonly element: {
    readonly id: string;
    readonly name: string;
    readonly readings: readonly Reading[];
    readonly conflicting: boolean;
  } | null;
  readonly canvas: readonly { readonly element: string; readonly source: string }[];
  readonly limits: Limits;
  readonly remaining: { readonly sources: number; readonly boxes: number; readonly wires: number };
  readonly diagrams: { readonly items: readonly DiagramEntry[]; readonly total: number; readonly truncated: boolean };
  readonly neighbours: {
    readonly items: readonly NeighbourEntry[];
    readonly total: number;
    readonly truncated: boolean;
  };
  readonly bytesTruncated: boolean;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The answer if it has the shape this page reads (schema version 1), else null: a newer service's answer is not guessed at. */
export function readExpandMenu(value: unknown): ExpandMenu | null {
  if (
    !isObject(value) ||
    value["schemaVersion"] !== 1 ||
    typeof value["viewId"] !== "string" ||
    typeof value["revision"] !== "string"
  )
    return null;
  const lists = [value["diagrams"], value["neighbours"]];
  if (!lists.every((l) => isObject(l) && Array.isArray(l["items"]))) return null;
  if (!isObject(value["limits"]) || !isObject(value["remaining"]) || !Array.isArray(value["canvas"])) return null;
  return value as ExpandMenu;
}

export type FramePin = {
  readonly kind: "node" | "edge" | "group";
  readonly id: string;
  readonly open: number;
  readonly latestPostAt?: string;
};
export type ExplorationFrame = {
  readonly source: string;
  readonly sourceRevision: string;
  readonly title: string;
  readonly family: Piece["family"];
  readonly proposed?: true;
  readonly touches: readonly string[];
  readonly boxes: number;
  readonly wires: number;
  readonly truncated: boolean;
  readonly pins: readonly FramePin[];
};
export type ResolvedExpansion =
  | {
      readonly element: string;
      readonly source: string;
      readonly neighbour?: string;
      readonly status: "added";
      readonly frame: number;
      readonly piece: Piece;
    }
  | {
      readonly element: string;
      readonly source: string;
      readonly neighbour?: string;
      readonly status: "dropped";
      readonly reason: string;
    };

/** GET api/exploration (routes 2 and 3): every frame of one exploration, each requested entry added or dropped. */
export type Exploration = {
  readonly schemaVersion: 1;
  readonly viewId: string;
  readonly revision: string;
  readonly origin: "presentation" | "link";
  readonly presentationId?: string;
  readonly generation?: number;
  readonly expansions: {
    readonly items: readonly ResolvedExpansion[];
    readonly total: number;
    readonly truncated: boolean;
  };
  readonly frames: readonly ExplorationFrame[];
  readonly notices?: readonly string[];
};

/** The answer if it has the shape this page reads, else null. */
export function readExploration(value: unknown): Exploration | null {
  if (
    !isObject(value) ||
    value["schemaVersion"] !== 1 ||
    typeof value["viewId"] !== "string" ||
    typeof value["revision"] !== "string"
  )
    return null;
  const list = value["expansions"];
  if (!isObject(list) || !Array.isArray(list["items"]) || !Array.isArray(value["frames"])) return null;
  for (const item of list["items"] as unknown[]) {
    if (!isObject(item) || typeof item["element"] !== "string" || typeof item["source"] !== "string") return null;
    if (item["status"] === "added" ? !isObject(item["piece"]) : item["status"] !== "dropped") return null;
  }
  return value as Exploration;
}

/** A stub box for an attach wire's far end, in the piece's family, so the wire can be projected; it is never drawn. */
function stub(family: Piece["family"], id: string): Record<string, unknown> {
  switch (family) {
    case "c4":
      return { id, kind: "container", label: id };
    case "architecture":
      return { id, label: id };
    case "er":
      return { id, label: id, attributes: [] };
    default:
      return { id, label: id };
  }
}

/** An attach wire as a wire of the piece's own model. */
function wireOf(family: Piece["family"], w: AttachWire): Record<string, unknown> {
  const [source, target] = w.direction === "reverse" ? [w.to, w.from] : [w.from, w.to];
  const words = {
    ...(w.label === undefined ? {} : { label: w.label }),
    ...(w.line === undefined ? {} : { line: w.line }),
  };
  switch (family) {
    case "c4":
      return {
        id: w.key,
        source,
        target,
        ...words,
        ...(w.technology === undefined ? {} : { technology: w.technology }),
        ...(w.direction === "two-way" ? { bidirectional: true } : {}),
      };
    case "architecture":
      return {
        id: w.key,
        source,
        target,
        sourceSide: "right",
        targetSide: "left",
        targetArrow: w.direction !== "undirected",
        ...(w.direction === "two-way" ? { sourceArrow: true } : {}),
        ...words,
      };
    case "er":
      return {
        id: w.key,
        source,
        target,
        sourceCardinality: "exactly-one",
        targetCardinality: "zero-or-more",
        identifying: false,
        ...(w.label === undefined ? {} : { label: w.label }),
      };
    default:
      return { id: w.key, source, target, ...words, ...(w.direction === "two-way" ? { bidirectional: true } : {}) };
  }
}

const BOXES: Readonly<Record<Piece["family"], string>> = {
  c4: "elements",
  architecture: "services",
  er: "entities",
  flowchart: "nodes",
};
const WIRES: Readonly<Record<Piece["family"], string>> = {
  c4: "relationships",
  architecture: "edges",
  er: "relationships",
  flowchart: "edges",
};

/** The piece projected in its own notation, or null when this page cannot draw it. */
export function projectPiece(piece: Piece, title: string): FramePiece | null {
  const envelope = (model: unknown) => ({
    schemaVersion: 2,
    view: { id: piece.source, kind: piece.kind, title: title.slice(0, 200) || piece.source },
    revision: piece.revision,
    model,
  });
  const own = projectEnvelope(envelope(piece.model));
  if (!own.ok || own.type !== "graph") return null;
  let attach: ProjectedEdge[] = [];
  if (piece.attach.length > 0) {
    const boxes = BOXES[piece.family],
      wires = WIRES[piece.family];
    const have = new Set(((piece.model[boxes] as { id: string }[] | undefined) ?? []).map((b) => b.id));
    const ends = [...new Set(piece.attach.flatMap((w) => [w.from, w.to]))].filter((id) => !have.has(id));
    const model = {
      ...piece.model,
      [boxes]: [...((piece.model[boxes] as unknown[]) ?? []), ...ends.map((id) => stub(piece.family, id))],
      [wires]: piece.attach.map((w) => wireOf(piece.family, w)),
    };
    const wired = projectEnvelope(envelope(model));
    if (wired.ok && wired.type === "graph") {
      const keys = new Set(piece.attach.map((w) => w.key));
      attach = wired.view.edges.filter((e) => keys.has(e.id));
    }
  }
  return { touches: piece.touches, nodes: own.view.nodes, edges: own.view.edges, attach };
}
