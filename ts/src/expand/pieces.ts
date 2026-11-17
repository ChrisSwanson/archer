// What an addition brings (ADR 0036 §12): the part of a source that touches the element, cut from the
// source's last-good model in its own notation (O3), valid against the frozen envelope schema. Graph
// families only (C4, flowchart, architecture, ER). A piece is drawn full: inner frames are flattened
// (ticket 10, answer 9), so every kept box loses its group and the cut has no groups. A box already on
// the canvas is never in a piece (O6: drawn once); a wire from the piece to it is an `attach` wire.

import type { DiagramEnvelope, DiagramModel } from "../model/envelope.ts";
import type { C4Element, C4Model } from "../model/c4.ts";
import type { GraphModel, GraphNode } from "../model/graph.ts";
import type { ArchitectureService, ServiceArchitecture } from "../model/architecture.ts";
import type { EntityRelationship } from "../model/er.ts";
import { isGraphModel } from "../model/kinds.ts";

export type GraphFamily = "c4" | "architecture" | "flowchart" | "er";

/** A wire as written in its source: its own id and ends, how it reads, and its words. */
export interface SourceWire {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly direction: "forward" | "two-way" | "reverse" | "undirected";
  readonly label?: string;
  readonly technology?: string;
  readonly line?: string;
}

/** One source model seen as boxes, frames and wires, whatever its family. */
export interface Shape {
  readonly family: GraphFamily;
  /** Every box id (a C4 element, flowchart node, service, entity), with the frame it sits in. */
  readonly boxes: ReadonlyMap<string, string | undefined>;
  /** Every frame id (boundary, subgraph, group), with its parent frame. */
  readonly frames: ReadonlyMap<string, string | undefined>;
  /** A frame that is an element and can stand as a box in a cut (a C4 system or container boundary, any subgraph or group). */
  readonly boxLike: ReadonlySet<string>;
  readonly wires: readonly SourceWire[];
}

export function graphFamily(model: DiagramModel): GraphFamily | null {
  if (isGraphModel(model)) return "flowchart";
  if (model.type === "c4-model") return "c4";
  if (model.type === "service-architecture") return "architecture";
  if (model.type === "entity-relationship") return "er";
  return null;
}

const words = (value: string | null | undefined): string | undefined =>
  value == null || value === "" ? undefined : value;

export function shapeOf(model: DiagramModel): Shape | null {
  const family = graphFamily(model);
  if (family === null) return null;
  const boxes = new Map<string, string | undefined>();
  const frames = new Map<string, string | undefined>();
  const boxLike = new Set<string>();
  const wires: SourceWire[] = [];
  const wire = (w: SourceWire): void => {
    wires.push(w);
  };
  if (family === "flowchart") {
    const m = model as GraphModel;
    for (const g of m.groups) {
      frames.set(g.id, g.parentId ?? undefined);
      boxLike.add(g.id);
    }
    for (const n of m.nodes) boxes.set(n.id, n.groupId ?? undefined);
    for (const e of m.edges)
      wire({
        id: e.id,
        source: e.source,
        target: e.target,
        direction: e.bidirectional === true ? "two-way" : "forward",
        ...(words(e.label) === undefined ? {} : { label: e.label! }),
        ...(e.line === undefined ? {} : { line: e.line }),
      });
  } else if (family === "c4") {
    const m = model as C4Model;
    for (const b of m.boundaries) {
      frames.set(b.id, b.parentId ?? undefined);
      if (b.kind === "system" || b.kind === "container") boxLike.add(b.id);
    }
    for (const e of m.elements) boxes.set(e.id, e.boundaryId ?? undefined);
    for (const r of m.relationships)
      wire({
        id: r.id,
        source: r.source,
        target: r.target,
        direction: r.bidirectional === true ? "two-way" : "forward",
        ...(words(r.label) === undefined ? {} : { label: r.label! }),
        ...(words(r.technology) === undefined ? {} : { technology: r.technology! }),
        ...(r.line === undefined ? {} : { line: r.line }),
      });
  } else if (family === "architecture") {
    const m = model as ServiceArchitecture;
    for (const g of m.groups) {
      frames.set(g.id, g.parentId ?? undefined);
      boxLike.add(g.id);
    }
    for (const s of m.services) boxes.set(s.id, s.groupId ?? undefined);
    for (const e of m.edges) {
      // A wire to a group's edge or a junction joins nothing a cut can hold.
      if (e.sourceGroup === true || e.targetGroup === true) continue;
      const at = { s: e.sourceArrow === true, t: e.targetArrow === true };
      wire({
        id: e.id,
        source: e.source,
        target: e.target,
        direction: at.s && at.t ? "two-way" : at.t ? "forward" : at.s ? "reverse" : "undirected",
        ...(words(e.label) === undefined ? {} : { label: e.label! }),
        ...(e.line === undefined ? {} : { line: e.line }),
      });
    }
  } else {
    const m = model as EntityRelationship;
    for (const e of m.entities) boxes.set(e.id, undefined);
    for (const r of m.relationships)
      wire({
        id: r.id,
        source: r.source,
        target: r.target,
        direction: "undirected",
        ...(words(r.label) === undefined ? {} : { label: r.label! }),
      });
  }
  return { family, boxes, frames, boxLike, wires };
}

/** Every id the model draws, boxes and frames: what a base view puts on the canvas. */
export function drawnIdsOf(model: DiagramModel): Set<string> {
  const shape = shapeOf(model);
  if (shape === null) return new Set();
  return new Set([...shape.boxes.keys(), ...shape.frames.keys()]);
}

/** The boxes inside frame `id` at any depth (inner frames flattened), in source order. */
export function insideOf(shape: Shape, id: string): string[] {
  const under = (frame: string | undefined): boolean => {
    const seen = new Set<string>();
    for (let at = frame; at !== undefined && !seen.has(at); at = shape.frames.get(at)) {
      if (at === id) return true;
      seen.add(at);
    }
    return false;
  };
  return [...shape.boxes].filter(([, frame]) => under(frame)).map(([box]) => box);
}

/** A wire to attach a piece to a box already on the canvas (O6): the source's own id and ends. */
export interface AttachWire {
  readonly key: string;
  readonly from: string;
  readonly to: string;
  readonly direction: SourceWire["direction"];
  readonly label?: string;
  readonly technology?: string;
  readonly line?: string;
}

export interface Cut {
  /** The piece's boxes, new to the canvas, in source order. */
  readonly boxes: readonly string[];
  /** Wires with both ends in the piece. */
  readonly wires: readonly string[];
  readonly attach: readonly AttachWire[];
  /** Boxes before `maxPieceBoxes`, and wires before the cap fell on their ends. */
  readonly total: { readonly boxes: number; readonly wires: number };
  readonly truncated: boolean;
}

/**
 * The cut for `element` in `shape`: its inside when the source opens it, else its direct neighbours
 * there; `only` narrows the neighbours to one (a "neighbour not drawn here" entry). `drawn` is every id on
 * the canvas; a candidate already drawn is not added and its wire attaches to it.
 */
export function cutFor(
  shape: Shape,
  element: string,
  drawn: ReadonlySet<string>,
  maxBoxes: number,
  only?: string,
  pairs: ReadonlySet<string> = new Set(),
): Cut | null {
  const opens = shape.frames.has(element) && only === undefined;
  const candidates = opens ? insideOf(shape, element) : neighboursOf(shape, element, only);
  if (candidates.length === 0) return null;
  const fresh = candidates.filter((id) => !drawn.has(id));
  const kept = new Set(fresh.slice(0, maxBoxes));
  const onCanvas = (id: string): boolean => drawn.has(id) || (!opens && id === element);
  const wires: string[] = [];
  const attach: AttachWire[] = [];
  let totalWires = 0;
  for (const w of shape.wires) {
    if (w.source === w.target || pairs.has(pairKey(w.source, w.target))) continue;
    const s = kept.has(w.source),
      t = kept.has(w.target);
    const freshEnd = (id: string): boolean => fresh.includes(id);
    if (opens) {
      if (s && t) {
        wires.push(w.id);
        totalWires++;
        continue;
      }
      if ((s && onCanvas(w.target)) || (t && onCanvas(w.source))) {
        attach.push(attachOf(w));
        totalWires++;
        continue;
      }
      if (
        (freshEnd(w.source) && (freshEnd(w.target) || onCanvas(w.target))) ||
        (freshEnd(w.target) && onCanvas(w.source))
      )
        totalWires++;
      continue;
    }
    // Neighbours: only the element's own wires, each to a kept box or to a neighbour already drawn.
    const other = w.source === element ? w.target : w.target === element ? w.source : null;
    if (other === null || (only !== undefined && other !== only)) continue;
    if (kept.has(other) || (drawn.has(other) && candidates.includes(other))) {
      attach.push(attachOf(w));
      totalWires++;
    } else if (freshEnd(other)) totalWires++;
  }
  if (kept.size === 0 && attach.length === 0 && wires.length === 0) return null;
  return {
    boxes: [...kept],
    wires,
    attach,
    total: { boxes: fresh.length, wires: totalWires },
    truncated: fresh.length > kept.size,
  };
}

/** An unordered pair of ends: a wire the canvas already draws between them is not drawn again. */
export const pairKey = (a: string, b: string): string => (a < b ? `${a}\0${b}` : `${b}\0${a}`);

function attachOf(w: SourceWire): AttachWire {
  return {
    key: w.id,
    from: w.source,
    to: w.target,
    direction: w.direction,
    ...(w.label === undefined ? {} : { label: w.label }),
    ...(w.technology === undefined ? {} : { technology: w.technology }),
    ...(w.line === undefined ? {} : { line: w.line }),
  };
}

/** The element's direct neighbours in `shape`, in wire order: boxes, or frames that can stand as boxes. */
function neighboursOf(shape: Shape, element: string, only?: string): string[] {
  if (!shape.boxes.has(element) && !shape.boxLike.has(element)) return [];
  const out: string[] = [];
  for (const w of shape.wires) {
    const other = w.source === element ? w.target : w.target === element ? w.source : null;
    if (other === null || other === element || out.includes(other)) continue;
    if (only !== undefined && other !== only) continue;
    if (shape.boxes.has(other) || shape.boxLike.has(other)) out.push(other);
  }
  return out;
}

/** The cut as a model of the source's own type: kept boxes with no frame, the wires inside the piece. */
export function cutModel(envelope: DiagramEnvelope, cut: Cut): DiagramModel {
  const model = envelope.model;
  const keep = new Set(cut.boxes);
  const inside = new Set(cut.wires);
  const family = graphFamily(model);
  if (family === "flowchart") {
    const m = model as GraphModel;
    const nodes: GraphNode[] = [];
    for (const id of cut.boxes) {
      const node = m.nodes.find((n) => n.id === id);
      const group = node === undefined ? m.groups.find((g) => g.id === id) : undefined;
      if (node !== undefined) nodes.push({ ...node, groupId: null });
      else if (group !== undefined)
        nodes.push({
          id: group.id,
          label: group.label,
          ...(group.classes === undefined ? {} : { classes: group.classes }),
          groupId: null,
        });
    }
    return {
      type: m.type,
      ...(m.direction == null ? {} : { direction: m.direction }),
      nodes,
      edges: m.edges.filter((e) => inside.has(e.id)),
      groups: [],
      ...(m.lineKey === undefined ? {} : { lineKey: m.lineKey }),
      ...(m.categories === undefined ? {} : { categories: m.categories }),
      // The piece's own boxes, in the source's order: a group it holds is a box (a node) here.
      ...(m.sourceOrder === undefined
        ? {}
        : {
            sourceOrder: {
              elements: m.sourceOrder.elements
                .filter((element) => keep.has(element.id) && nodes.some((node) => node.id === element.id))
                .filter((element, at, all) => all.findIndex((other) => other.id === element.id) === at)
                .map((element) => ({ id: element.id, kind: "node" as const })),
              edges: m.sourceOrder.edges.filter((id) => inside.has(id)),
            },
          }),
    };
  }
  if (family === "c4") {
    const m = model as C4Model;
    const elements: C4Element[] = [];
    for (const id of cut.boxes) {
      const element = m.elements.find((e) => e.id === id);
      const boundary = element === undefined ? m.boundaries.find((b) => b.id === id) : undefined;
      if (element !== undefined) elements.push({ ...element, boundaryId: null });
      else if (boundary !== undefined)
        elements.push({
          id: boundary.id,
          kind: boundary.kind === "system" ? "system" : "container",
          label: boundary.label,
        });
    }
    return {
      type: "c4-model",
      level: m.level,
      ...(m.title == null ? {} : { title: m.title }),
      elements,
      boundaries: [],
      relationships: m.relationships.filter((r) => inside.has(r.id)),
      ...(m.lineKey === undefined ? {} : { lineKey: m.lineKey }),
    };
  }
  if (family === "architecture") {
    const m = model as ServiceArchitecture;
    const services: ArchitectureService[] = [];
    for (const id of cut.boxes) {
      const service = m.services.find((s) => s.id === id);
      const group = service === undefined ? m.groups.find((g) => g.id === id) : undefined;
      if (service !== undefined) services.push({ ...service, groupId: null });
      else if (group !== undefined)
        services.push({
          id: group.id,
          label: group.label,
          ...(group.icon == null ? {} : { icon: group.icon }),
          groupId: null,
        });
    }
    return {
      type: "service-architecture",
      ...(m.title == null ? {} : { title: m.title }),
      groups: [],
      services,
      junctions: [],
      edges: m.edges.filter((e) => inside.has(e.id)),
      ...(m.lineKey === undefined ? {} : { lineKey: m.lineKey }),
    };
  }
  const m = model as EntityRelationship;
  return {
    type: "entity-relationship",
    ...(m.direction == null ? {} : { direction: m.direction }),
    entities: m.entities.filter((e) => keep.has(e.id)),
    relationships: m.relationships.filter((r) => inside.has(r.id)),
  };
}
