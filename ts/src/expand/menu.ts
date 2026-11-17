// GET api/expand-menu (ADR 0036 §11–§13, A5, A8–A10, A13; browser-contract-draft.md route 1, ticket 14):
// one element's Expand entries on one canvas, each with the piece it would add, so a hover preview and an
// add cost no request. Pure: it reads the project model, the occurrence index and last-good envelopes.
//
// Entries, in order: the diagrams that open the element (opensIn), then those that draw it (drawnIn), then
// the ones that cannot be a frame (O3: "open it on its own"); then the model relationships the canvas does
// not draw. "Inside" is the page's (ADR 0029). Sources come only from the base view's own inventory (A9);
// `based-on:` copies never are (O11); proposed views are, labelled (A5). The caps are A13's, echoed.

import type { DiagramEnvelope } from "../model/envelope.ts";
import {
  FAMILIES,
  type ElementKind,
  type Family,
  type Occurrence,
  type ProjectModel,
  type RelationshipDirection,
} from "../project-model/merge.ts";
import {
  EXPLORATIONS_SCHEMA_VERSION,
  EXPLORATION_LIMITS,
  expansionKey,
  expansionOf,
  shareableExpansions,
  type DropReason,
  type Expansion,
  type ExplorationLimits,
} from "../../../shared/explorations.mts";
import {
  cutFor,
  cutModel,
  drawnIdsOf,
  pairKey,
  shapeOf,
  type AttachWire,
  type Cut,
  type GraphFamily,
  type Shape,
} from "./pieces.ts";

export interface ExpandSources {
  readonly model: ProjectModel;
  readonly generation: number;
  /** A view's last-good envelope, or null (never compiled, or not in this project). */
  envelope(viewId: string): DiagramEnvelope | null;
  /** A view's inventory title. */
  title(viewId: string): string;
}

export interface Piece {
  readonly source: string;
  readonly revision: string;
  readonly family: GraphFamily;
  /** The element the piece was cut for: its box is on the canvas, never in the piece. */
  readonly touches: string;
  /** The piece is the element's inside in the source (else its neighbours there). */
  readonly opens: boolean;
  readonly kind: string;
  readonly model: DiagramEnvelope["model"];
  readonly attach: readonly AttachWire[];
  readonly boxes: number;
  readonly wires: number;
  readonly total: { readonly boxes: number; readonly wires: number };
  readonly truncated: boolean;
}

export type Omitted = "own" | "limit" | "bytes";
type Adds = { readonly boxes: number; readonly wires: number };

export interface Reading {
  readonly kind?: ElementKind;
  readonly parent?: string;
  readonly views: readonly string[];
}

export interface DiagramEntry {
  readonly source: string;
  readonly title: string;
  readonly family: Family;
  readonly sourceRevision: string;
  readonly relation: "opens" | "draws";
  /** Index into `element.readings`. */
  readonly reading: number;
  readonly proposed?: true;
  readonly adds: Adds;
  readonly onCanvas: boolean;
  readonly piece: Piece | null;
  readonly omitted?: Omitted;
}

export interface NeighbourEntry {
  readonly element: string;
  readonly name: string;
  readonly kinds: readonly ElementKind[];
  readonly direction: RelationshipDirection;
  readonly via: string;
  readonly viaTitle: string;
  readonly viaRevision: string;
  readonly alsoDrawnIn: number;
  readonly proposed?: true;
  readonly adds: Adds;
  readonly onCanvas: boolean;
  readonly piece: Piece | null;
  readonly omitted?: Omitted;
}

interface Capped<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly truncated: boolean;
}

export interface ExpandMenu {
  readonly schemaVersion: typeof EXPLORATIONS_SCHEMA_VERSION;
  readonly viewId: string;
  readonly revision: string;
  readonly modelGeneration: number;
  readonly element: {
    readonly id: string;
    readonly name: string;
    readonly readings: readonly Reading[];
    readonly conflicting: boolean;
  } | null;
  /** The expansions the request named that hold on this canvas, in order; the rest are in `dropped`. */
  readonly canvas: readonly Expansion[];
  readonly dropped: readonly (Expansion & { readonly reason: DropReason })[];
  readonly limits: ExplorationLimits;
  readonly remaining: { readonly sources: number; readonly boxes: number; readonly wires: number };
  readonly diagrams: Capped<DiagramEntry>;
  readonly neighbours: Capped<NeighbourEntry>;
  readonly bytesTruncated: boolean;
}

export type MenuRefusal = { readonly status: 404; readonly code: "diagram_not_found"; readonly message: string };

export const GRAPH: ReadonlySet<Family> = new Set(["c4", "architecture", "flowchart", "er"]);
const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What an exploration answer keeps for everything but its entries and frames (P43): its head, at most 8 notices
 * and the comment pins, which take only the room left; 12 KiB of the 64 KiB. The entries, their pieces and the
 * frames' summaries get the rest.
 */
export const reserveBytes = (limits: ExplorationLimits): number => Math.ceil((limits.maxResponseBytes * 3) / 16);
const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
/** What a dropped entry takes of an exploration answer, at its longest reason. */
const droppedBytes = (e: Expansion): number =>
  jsonBytes({ ...e, status: "dropped", reason: "element_not_on_canvas" }) + 1;

/** The canvas as the service sees it: what is drawn, how much each source has added, and the bytes an answer about it takes. */
export class Canvas {
  readonly drawn: Set<string>;
  readonly pairs = new Set<string>();
  readonly sources = new Map<string, { boxes: number; wires: number }>();
  /** The elements each source's frame touches, as the answer lists them. */
  readonly touched = new Map<string, Set<string>>();
  boxes = 0;
  wires = 0;
  /** What the entries replayed so far take of an exploration answer (P43): items, pieces, frame summaries. */
  bytes = 0;
  constructor(base: DiagramEnvelope, shape: Shape | null) {
    this.drawn = drawnIdsOf(base.model);
    for (const w of shape?.wires ?? []) this.pairs.add(pairKey(w.source, w.target));
  }
  /** What adding `e` with `piece` takes of the answer: its item and piece, its frame's summary if new, the element it touches. */
  cost(e: Expansion, piece: Piece, title: string): number {
    const touched = this.touched.get(e.source);
    const frame =
      touched === undefined
        ? jsonBytes({
            source: e.source,
            sourceRevision: piece.revision,
            title,
            family: piece.family,
            proposed: true,
            touches: [],
            boxes: 99999,
            wires: 99999,
            truncated: false,
            pins: [],
          }) + 1
        : 0;
    return (
      jsonBytes({ ...e, status: "added", frame: 99, piece }) +
      1 +
      frame +
      (touched?.has(e.element) === true ? 0 : jsonBytes(e.element) + 1)
    );
  }
  add(e: Expansion, shape: Shape, cut: Cut, cost: number): void {
    for (const id of cut.boxes) this.drawn.add(id);
    const at = this.sources.get(e.source) ?? { boxes: 0, wires: 0 };
    at.boxes += cut.boxes.length;
    at.wires += cut.wires.length + cut.attach.length;
    this.sources.set(e.source, at);
    this.touched.set(e.source, (this.touched.get(e.source) ?? new Set()).add(e.element));
    this.boxes += cut.boxes.length;
    this.wires += cut.wires.length + cut.attach.length;
    this.bytes += cost;
    const wired = new Set([...cut.wires, ...cut.attach.map((a) => a.key)]);
    for (const w of shape.wires) if (wired.has(w.id)) this.pairs.add(pairKey(w.source, w.target));
  }
  /** Why an addition of `adds` from `source`, taking `cost` bytes with `later` still to come, does not fit, or null. */
  over(source: string, adds: Adds, limits: ExplorationLimits, cost = 0, later = 0): string | null {
    if (!this.sources.has(source) && this.sources.size >= limits.maxAddedSources) return "sources";
    if (this.boxes + adds.boxes > limits.maxAddedBoxes) return "boxes";
    if (this.wires + adds.wires > limits.maxAddedWires) return "wires";
    if (this.bytes + cost + later > limits.maxResponseBytes - reserveBytes(limits)) return "bytes";
    return null;
  }
}

/** "link" when adding `next` would leave a list no link or reader report can carry (P42), else null. */
function unshared(kept: readonly Expansion[], next: Expansion, limits: ExplorationLimits): "link" | null {
  return shareableExpansions([...kept, next], limits).ok ? null : "link";
}

function addsOf(cut: Cut): Adds {
  return { boxes: cut.boxes.length, wires: cut.wires.length + cut.attach.length };
}

function pieceOf(envelope: DiagramEnvelope, shape: Shape, element: string, cut: Cut, opens: boolean): Piece {
  return {
    source: envelope.view.id,
    revision: envelope.revision,
    family: shape.family,
    touches: element,
    opens,
    kind: envelope.view.kind,
    model: cutModel(envelope, cut),
    attach: cut.attach,
    boxes: cut.boxes.length,
    wires: cut.wires.length + cut.attach.length,
    total: cut.total,
    truncated: cut.truncated,
  };
}

/** Why `viewId` cannot be a frame on `base`'s canvas, or null: sources come from this inventory only (A9, O3, O11). */
function unusable(sources: ExpandSources, base: string, viewId: string): DropReason | null {
  if (viewId === base) return "source_is_base";
  const fact = sources.model.views.find((v) => v.id === viewId);
  if (fact === undefined) return "source_unknown";
  if (fact.basedOn !== undefined) return "source_is_copy";
  if (fact.uncompiled === true || sources.envelope(viewId) === null) return "source_uncompiled";
  if (fact.family === undefined || !GRAPH.has(fact.family)) return "source_not_frame";
  return null;
}

function usable(
  sources: ExpandSources,
  base: string,
  viewId: string,
): { envelope: DiagramEnvelope; shape: Shape } | null {
  if (unusable(sources, base, viewId) !== null) return null;
  const envelope = sources.envelope(viewId)!;
  const shape = shapeOf(envelope.model);
  return shape === null ? null : { envelope, shape };
}

export type { DropReason };

/** What a replay keeps: each expansion that holds, in order, with the piece it added then. */
export interface Replayed {
  readonly canvas: Canvas;
  readonly kept: Expansion[];
  readonly pieces: Piece[];
  readonly dropped: (Expansion & { reason: DropReason })[];
}

/**
 * Replays `expand` onto the base, in order; an entry that does not hold is dropped with its reason. This is the one
 * place an entry is kept, for the menu, a present, a link, the page's own list and the agent's report alike, so the
 * byte budget is decided here (P43): an entry whose item would leave no room for the drops still to come is
 * `limit_passed`, and the answer that lists the result always fits `maxResponseBytes`.
 */
export function replay(
  sources: ExpandSources,
  base: DiagramEnvelope,
  expand: readonly Expansion[],
  limits: ExplorationLimits,
): Replayed {
  const canvas = new Canvas(base, shapeOf(base.model));
  const kept: Expansion[] = [],
    pieces: Piece[] = [],
    dropped: (Expansion & { reason: DropReason })[] = [];
  const seen = new Set<string>();
  const drops = expand.map(droppedBytes);
  let later = drops.reduce((n, b) => n + b, 0);
  expand.forEach((e, i) => {
    later -= drops[i]!;
    const drop = (reason: DropReason): void => {
      dropped.push({ ...e, reason });
      canvas.bytes += drops[i]!;
    };
    const key = expansionKey(e);
    if (seen.has(key)) return drop("duplicate");
    seen.add(key);
    const why = unusable(sources, base.view.id, e.source);
    if (why !== null) return drop(why);
    const from = usable(sources, base.view.id, e.source)!;
    if (!canvas.drawn.has(e.element)) return drop("element_not_on_canvas");
    if (!from.shape.boxes.has(e.element) && !from.shape.frames.has(e.element)) return drop("source_unrelated");
    // A neighbour entry (P41) is the menu's own cut: that one neighbour, as the person saw it previewed.
    const cut = cutFor(from.shape, e.element, canvas.drawn, limits.maxPieceBoxes, e.neighbour, canvas.pairs);
    if (cut === null) return drop("nothing_to_add");
    const piece = pieceOf(
      from.envelope,
      from.shape,
      e.element,
      cut,
      e.neighbour === undefined && from.shape.frames.has(e.element),
    );
    const cost = canvas.cost(e, piece, sources.title(e.source));
    if (canvas.over(e.source, addsOf(cut), limits, cost, later) !== null) return drop("limit_passed");
    pieces.push(piece);
    canvas.add(e, from.shape, cut, cost);
    kept.push(e);
  });
  return { canvas, kept, pieces, dropped };
}

/** One reading per distinct (kind, parent) over the element's occurrences that give either (A3). */
function readingsOf(occurrences: readonly Occurrence[]): Reading[] {
  const by = new Map<string, { kind?: ElementKind; parent?: string; views: Set<string> }>();
  for (const o of occurrences) {
    if (o.weak === true) continue;
    const key = `${o.kind ?? ""}\0${o.parent ?? ""}`;
    const at = by.get(key) ?? {
      ...(o.kind === undefined ? {} : { kind: o.kind }),
      ...(o.parent === undefined ? {} : { parent: o.parent }),
      views: new Set<string>(),
    };
    at.views.add(o.viewId);
    by.set(key, at);
  }
  return [...by.values()]
    .map((r) => ({ ...r, views: [...r.views].sort(byString) }))
    .sort((a, b) => byString(a.views[0]!, b.views[0]!));
}

function capped<T>(items: readonly T[], max: number): Capped<T> {
  return { items: items.slice(0, max), total: items.length, truncated: items.length > max };
}

/** The menu for `element` on `viewId` with `expand` already on the canvas. */
export function expandMenu(
  sources: ExpandSources,
  viewId: string,
  element: string,
  expand: readonly Expansion[],
  limits: ExplorationLimits = EXPLORATION_LIMITS,
): ExpandMenu | MenuRefusal {
  const base = sources.envelope(viewId);
  if (base === null)
    return {
      status: 404,
      code: "diagram_not_found",
      message: `no diagram view is registered as '${viewId.slice(0, 200)}'`,
    };
  const { canvas, kept, dropped } = replay(sources, base, expand, limits);
  const remaining = {
    sources: Math.max(0, limits.maxAddedSources - canvas.sources.size),
    boxes: Math.max(0, limits.maxAddedBoxes - canvas.boxes),
    wires: Math.max(0, limits.maxAddedWires - canvas.wires),
  };
  const head = {
    schemaVersion: EXPLORATIONS_SCHEMA_VERSION,
    viewId,
    revision: base.revision,
    modelGeneration: sources.generation,
    canvas: kept,
    dropped,
    limits,
    remaining,
  } as const;
  const indexed = sources.model.index.find((e) => e.id === element);
  // Not an element (a plain group, an unkinded node), or a base that is no graph: an empty menu, not an error.
  if (indexed === undefined || shapeOf(base.model) === null) {
    return {
      ...head,
      element: null,
      diagrams: capped([], limits.maxMenuCandidates),
      neighbours: capped([], limits.maxMenuCandidates),
      bytesTruncated: false,
    };
  }
  const modelled = sources.model.elements.find((e) => e.id === element);
  const occurrences = indexed.occurrences;
  const readings = readingsOf(occurrences);
  const name = modelled?.name ?? occurrences[0]?.label ?? element;
  const conflicting = modelled !== undefined && (modelled.kinds.length > 1 || modelled.parents.length > 1);
  // A whole-source entry on the canvas is not offered again; one neighbour added from a source leaves the rest of it offered.
  const on = new Set(kept.filter((e) => e.neighbour === undefined).map((e) => `${e.element}\0${e.source}`));
  const proposed = new Set(sources.model.views.filter((v) => v.proposed === true).map((v) => v.id));

  const diagrams: DiagramEntry[] = [];
  for (const o of occurrences) {
    if (o.viewId === viewId || on.has(`${element}\0${o.viewId}`)) continue;
    const fact = sources.model.views.find((v) => v.id === o.viewId);
    if (fact === undefined || fact.basedOn !== undefined) continue;
    const envelope = sources.envelope(o.viewId);
    if (envelope === null) continue;
    const reading = Math.max(
      0,
      readings.findIndex((r) => r.views.includes(o.viewId)),
    );
    const common = {
      source: o.viewId,
      title: sources.title(o.viewId),
      family: o.family,
      sourceRevision: envelope.revision,
      reading,
      ...(proposed.has(o.viewId) ? { proposed: true as const } : {}),
      onCanvas: canvas.sources.has(o.viewId),
    };
    if (!GRAPH.has(o.family)) {
      diagrams.push({ ...common, relation: "draws", adds: { boxes: 0, wires: 0 }, piece: null, omitted: "own" });
      continue;
    }
    const from = usable(sources, viewId, o.viewId);
    if (from === null) continue;
    const opens = o.opens === true;
    const cut = cutFor(from.shape, element, canvas.drawn, limits.maxPieceBoxes, undefined, canvas.pairs);
    if (cut === null) continue;
    const adds = addsOf(cut);
    // The replay's own rules, the byte budget included (P43), so an entry offered here is one every reader keeps.
    const next = expansionOf(element, o.viewId),
      piece = pieceOf(from.envelope, from.shape, element, cut, opens);
    const over =
      canvas.over(o.viewId, adds, limits, canvas.cost(next, piece, sources.title(o.viewId))) ??
      unshared(kept, next, limits);
    diagrams.push({
      ...common,
      relation: opens ? "opens" : "draws",
      adds,
      ...(over === null ? { piece } : { piece: null, omitted: "limit" as const }),
    });
  }
  const order = (e: DiagramEntry): number => (e.omitted === "own" ? 2 : e.relation === "opens" ? 0 : 1);
  diagrams.sort((a, b) => order(a) - order(b) || byString(a.source, b.source) || a.reading - b.reading);

  const neighbours: NeighbourEntry[] = [];
  const pairs = sources.model.relationships.filter((r) => (r.from === element) !== (r.to === element));
  const others = [...new Set(pairs.map((r) => (r.from === element ? r.to : r.from)))]
    .filter((id) => !canvas.drawn.has(id))
    .sort(byString);
  for (const other of others.slice(0, limits.maxRelationshipsPerElement)) {
    const both = pairs.filter((r) => r.from === other || r.to === other);
    const occ = both.flatMap((r) => r.occurrences);
    const direction: RelationshipDirection = occ.every((o) => o.direction === "undirected")
      ? "undirected"
      : both.length > 1 || occ.some((o) => o.direction === "two-way")
        ? "two-way"
        : both[0]!.from === element
          ? "forward"
          : "reverse";
    const views = [...new Set(occ.map((o) => o.viewId))].filter((v) => v !== viewId);
    const rank = (v: string): number => {
      const fact = sources.model.views.find((f) => f.id === v);
      const family = fact?.family ?? "sequence";
      return (GRAPH.has(family) ? 0 : 100) + FAMILIES.indexOf(family) * 2 + (fact?.embedded === true ? 1 : 0);
    };
    views.sort((a, b) => rank(a) - rank(b) || byString(a, b));
    const via = views[0];
    if (via === undefined) continue;
    const envelope = sources.envelope(via);
    if (envelope === null) continue;
    const target = sources.model.elements.find((e) => e.id === other);
    const common = {
      element: other,
      name: target?.name ?? other,
      kinds: (target?.kinds ?? []).map((k) => k.value),
      direction,
      via,
      viaTitle: sources.title(via),
      viaRevision: envelope.revision,
      alsoDrawnIn: views.length - 1,
      ...(proposed.has(via) ? { proposed: true as const } : {}),
      onCanvas: canvas.sources.has(via),
    };
    const from = usable(sources, viewId, via);
    const cut =
      from === null ? null : cutFor(from.shape, element, canvas.drawn, limits.maxPieceBoxes, other, canvas.pairs);
    if (from === null || cut === null) {
      neighbours.push({ ...common, adds: { boxes: 0, wires: 0 }, piece: null, omitted: "own" });
      continue;
    }
    const adds = addsOf(cut);
    const next = expansionOf(element, via, other),
      piece = pieceOf(from.envelope, from.shape, element, cut, false);
    const over =
      canvas.over(via, adds, limits, canvas.cost(next, piece, sources.title(via))) ?? unshared(kept, next, limits);
    neighbours.push({ ...common, adds, ...(over === null ? { piece } : { piece: null, omitted: "limit" as const }) });
  }
  const menu: ExpandMenu = {
    ...head,
    element: { id: element, name, readings, conflicting },
    diagrams: capped(diagrams, limits.maxMenuCandidates),
    neighbours: {
      ...capped(neighbours, limits.maxMenuCandidates),
      total: others.length,
      truncated: others.length > Math.min(neighbours.length, limits.maxMenuCandidates),
    },
    bytesTruncated: false,
  };
  return withinBytes(menu, limits.maxResponseBytes);
}

/** Past `maxBytes`, pieces are dropped from the last entry backwards (`omitted: "bytes"`). */
function withinBytes(menu: ExpandMenu, maxBytes: number): ExpandMenu {
  const size = (m: ExpandMenu): number => Buffer.byteLength(JSON.stringify(m));
  if (size(menu) <= maxBytes) return menu;
  const diagrams = [...menu.diagrams.items],
    neighbours = [...menu.neighbours.items];
  let out: ExpandMenu = menu;
  const lists: (DiagramEntry | NeighbourEntry)[][] = [neighbours, diagrams];
  for (const list of lists) {
    for (let i = list.length - 1; i >= 0 && size(out) > maxBytes; i--) {
      const entry = list[i]!;
      if (entry.piece === null) continue;
      list[i] = { ...entry, piece: null, omitted: "bytes" };
      out = {
        ...out,
        diagrams: { ...out.diagrams, items: diagrams },
        neighbours: { ...out.neighbours, items: neighbours as NeighbourEntry[] },
        bytesTruncated: true,
      };
    }
  }
  return out;
}
