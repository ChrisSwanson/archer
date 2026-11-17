// An exploration (ADR 0036 §13–§14, A8, A10, A11; browser-contract-draft.md routes 2 and 3): one base view
// grown by (element, source) additions, replayed in order against one snapshot. The same replay serves a
// presented exploration (refused whole on any bad entry, A11), a link or a page's own list (best-effort,
// each drop with its reason), the frames the page reads in one request, and the agent's report.

import type { DiagramEnvelope } from "../model/envelope.ts";
import {
  EXPLORATIONS_SCHEMA_VERSION,
  EXPLORATION_LIMITS,
  MAX_FRAME_SELECTION,
  expansionOf,
  sameExpansion,
  type DropReason,
  type ExpandRefusalReason,
  type Expansion,
  type ExplorationLimits,
  type ExplorationStamp,
  type FrameSelection,
} from "../../../shared/explorations.mts";
import { replay, type ExpandSources, type Piece, type Replayed } from "./menu.ts";
import { drawnIdsOf, shapeOf } from "./pieces.ts";

/** Open threads on one part of a frame, as counts (ticket 14 fan-out): the text is read when the pin is opened. */
export interface CommentPin {
  readonly kind: "node" | "edge" | "group";
  readonly id: string;
  readonly open: number;
  readonly latestPostAt?: string;
}

export interface ExplorationSources extends ExpandSources {
  /** Open comment pins on `source` for the local ids given; empty when comments are off. */
  pins(source: string, ids: ReadonlySet<string>): readonly CommentPin[];
}

export interface ResolvedExpansion extends Expansion {
  readonly status: "added" | "dropped";
  /** Index into `frames` when added. */
  readonly frame?: number;
  /** The piece it added, cut when it was replayed (P35): the page builds its additions from these as from a menu. */
  readonly piece?: Piece;
  readonly reason?: DropReason;
}

export interface ExplorationFrame {
  readonly source: string;
  readonly sourceRevision: string;
  readonly title: string;
  readonly family: Piece["family"];
  readonly proposed?: true;
  /** The canvas elements the frame was expanded from, in order. */
  readonly touches: readonly string[];
  readonly boxes: number;
  readonly wires: number;
  readonly truncated: boolean;
  readonly pins: readonly CommentPin[];
}

export interface Exploration {
  readonly schemaVersion: typeof EXPLORATIONS_SCHEMA_VERSION;
  readonly viewId: string;
  readonly revision: string;
  readonly origin: "presentation" | "link";
  readonly presentationId?: string;
  readonly generation?: number;
  readonly modelGeneration: number;
  readonly limits: ExplorationLimits;
  readonly expansions: {
    readonly items: readonly ResolvedExpansion[];
    readonly total: number;
    readonly truncated: boolean;
  };
  readonly frames: readonly ExplorationFrame[];
  readonly counts: { readonly sources: number; readonly boxes: number; readonly wires: number };
  readonly notices?: readonly string[];
  /** Some open comment pins were left out to keep the answer within `limits.maxResponseBytes` (P43). */
  readonly pinsTruncated?: true;
}

/** One bad entry of a presented `expand` (A11): its index, what it named and why. */
export interface ExpandIssue extends Expansion {
  readonly index: number;
  readonly reason: ExpandRefusalReason;
  readonly problem: string;
}

const PROBLEMS: Record<ExpandRefusalReason, (e: Expansion) => string> = {
  duplicate: (e) =>
    `is the same (element, source${e.neighbour === undefined ? "" : ", neighbour"}) as an earlier entry`,
  element_unknown: (e) => `no diagram draws an element '${e.element}'`,
  element_not_on_canvas: (e) =>
    `'${e.element}' is not on the canvas when this entry applies: it is neither in the base view nor in an earlier entry's frame`,
  source_unknown: (e) => `'${e.source}' is not a diagram of this project`,
  source_unrelated: (e) => `'${e.source}' neither draws nor opens '${e.element}'`,
  source_is_base: () => "names the presented view as its own source",
  source_not_frame: (e) =>
    `'${e.source}' is a sequence, state or journey diagram, which cannot be a frame: present it on its own`,
  source_uncompiled: (e) => `'${e.source}' has never compiled, so it has nothing to add`,
  source_is_copy: (e) => `'${e.source}' is a based-on: copy, which adds nothing (O11)`,
  nothing_to_add: (e) =>
    e.neighbour === undefined
      ? `'${e.source}' adds nothing around '${e.element}' that the canvas does not already draw`
      : `'${e.source}' draws no link from '${e.element}' to '${e.neighbour}' that the canvas does not already draw`,
  limit_passed: () =>
    "passes the limit for one view (5 added diagrams, 60 added boxes, 120 added wires, or more drawing than one 64 KiB answer carries)",
  too_many: () => "is past the most entries one call takes",
};

export function problemOf(reason: ExpandRefusalReason, e: Expansion): string {
  return PROBLEMS[reason](e);
}

/** Replays `expand` on `viewId`, or null when the view has no last-good model. */
export function replayOn(
  sources: ExpandSources,
  viewId: string,
  expand: readonly Expansion[],
  limits: ExplorationLimits = EXPLORATION_LIMITS,
): { readonly base: DiagramEnvelope; readonly replayed: Replayed } | null {
  const base = sources.envelope(viewId);
  if (base === null) return null;
  return { base, replayed: replay(sources, base, expand.slice(0, limits.maxExpansions), limits) };
}

/** A11: every bad entry of a presented `expand`, or none when the whole list holds on this snapshot. */
export function expandIssues(
  sources: ExpandSources,
  viewId: string,
  expand: readonly Expansion[],
  limits: ExplorationLimits = EXPLORATION_LIMITS,
): ExpandIssue[] {
  const issues: ExpandIssue[] = [];
  const at = replayOn(sources, viewId, expand, limits);
  if (at === null) return issues;
  const known = new Set(sources.model.index.map((e) => e.id));
  for (const id of drawnIdsOf(at.base.model)) known.add(id);
  // Entries are matched to their drops in order: a pair named twice is dropped as `duplicate` the second time.
  const drops = [...at.replayed.dropped];
  const kept = [...at.replayed.kept];
  expand.forEach((e, index) => {
    if (index >= limits.maxExpansions) {
      issues.push({
        ...e,
        index,
        reason: "too_many",
        problem: `${problemOf("too_many", e)} (${limits.maxExpansions})`,
      });
      return;
    }
    if (kept[0] !== undefined && sameExpansion(kept[0], e)) {
      kept.shift();
      return;
    }
    const drop = drops.findIndex((d) => sameExpansion(d, e));
    if (drop < 0) return;
    const reason: ExpandRefusalReason =
      drops[drop]!.reason === "element_not_on_canvas" && !known.has(e.element)
        ? "element_unknown"
        : drops[drop]!.reason;
    drops.splice(drop, 1);
    issues.push({ ...e, index, reason, problem: problemOf(reason, e) });
  });
  return issues;
}

/** The stamp an opted-in page reads (A8), from a replay that holds. */
export function stampOf(replayed: Replayed, generation: number): ExplorationStamp {
  return { generation, sources: replayed.canvas.sources.size, parts: replayed.canvas.boxes };
}

/** Every frame of `replayed`, one per source in order of its first addition (O7), with the pieces' boxes; each frame's open pins beside it. */
function framesOf(
  sources: ExplorationSources,
  replayed: Replayed,
): { frames: ExplorationFrame[]; pins: (readonly CommentPin[])[]; index: Map<string, number> } {
  const index = new Map<string, number>();
  const by: { source: string; pieces: Piece[]; touches: string[] }[] = [];
  replayed.kept.forEach((e, i) => {
    let at = index.get(e.source);
    if (at === undefined) {
      at = by.length;
      index.set(e.source, at);
      by.push({ source: e.source, pieces: [], touches: [] });
    }
    by[at]!.pieces.push(replayed.pieces[i]!);
    if (!by[at]!.touches.includes(e.element)) by[at]!.touches.push(e.element);
  });
  const proposed = new Set(sources.model.views.filter((v) => v.proposed === true).map((v) => v.id));
  const pins: (readonly CommentPin[])[] = [];
  const frames = by.map((f): ExplorationFrame => {
    const first = f.pieces[0]!;
    const ids = new Set<string>();
    for (const p of f.pieces) {
      const shape = shapeOf(p.model);
      for (const id of shape?.boxes.keys() ?? []) ids.add(id);
      for (const w of shape?.wires ?? []) ids.add(w.id);
      for (const a of p.attach) ids.add(a.key);
    }
    pins.push(sources.pins(f.source, ids));
    return {
      source: f.source,
      sourceRevision: first.revision,
      title: sources.title(f.source),
      family: first.family,
      ...(proposed.has(f.source) ? { proposed: true as const } : {}),
      touches: f.touches,
      boxes: f.pieces.reduce((n, p) => n + p.boxes, 0),
      wires: f.pieces.reduce((n, p) => n + p.wires, 0),
      truncated: f.pieces.some((p) => p.truncated),
      pins: [],
    };
  });
  return { frames, pins, index };
}

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
/** A notice line as an answer carries it: at most 300 characters. */
const noticeLine = (line: string): string => (line.length > 300 ? `${line.slice(0, 299)}…` : line);

/**
 * The answer within `maxResponseBytes` (P43): the replay already kept its entries and frames inside the budget, so
 * only what does not change the canvas is fitted here. Notices go from the last while the head does not fit (never
 * in practice), then comment pins fill the room left in frame order, and `pinsTruncated` says when some did not.
 */
function withinBudget(answer: Exploration, pins: readonly (readonly CommentPin[])[], maxBytes: number): Exploration {
  let out = answer;
  while (jsonBytes(out) > maxBytes && (out.notices?.length ?? 0) > 0) {
    const notices = out.notices!.slice(0, -1);
    const { notices: _gone, ...rest } = out;
    out = notices.length === 0 ? rest : { ...rest, notices };
  }
  // The flag's own bytes are kept back, so the answer fits whether or not it is set.
  let room = maxBytes - jsonBytes(out) - jsonBytes({ pinsTruncated: true });
  let truncated = false;
  const frames = out.frames.map((f, i) => {
    const kept: CommentPin[] = [];
    for (const pin of pins[i] ?? []) {
      const cost = jsonBytes(pin) + 1;
      if (cost > room) {
        truncated = true;
        continue;
      }
      kept.push(pin);
      room -= cost;
    }
    return kept.length === 0 ? f : { ...f, pins: kept };
  });
  return { ...out, frames, ...(truncated ? { pinsTruncated: true as const } : {}) };
}

/** Routes 2 and 3: every frame in one answer, each requested entry added or dropped with its reason. */
export function explorationOf(
  sources: ExplorationSources,
  viewId: string,
  expand: readonly Expansion[],
  origin:
    | { readonly kind: "link" }
    | {
        readonly kind: "presentation";
        readonly presentationId: string;
        readonly generation: number;
        readonly notices: readonly string[];
      },
  limits: ExplorationLimits = EXPLORATION_LIMITS,
): Exploration | null {
  const at = replayOn(sources, viewId, expand, limits);
  if (at === null) return null;
  const { base, replayed } = at;
  const { frames, pins, index } = framesOf(sources, replayed);
  const kept = [...replayed.kept],
    pieces = [...replayed.pieces],
    drops = [...replayed.dropped];
  const items: ResolvedExpansion[] = [];
  for (const e of expand.slice(0, limits.maxExpansions)) {
    const named = expansionOf(e.element, e.source, e.neighbour);
    if (kept[0] !== undefined && sameExpansion(kept[0], e)) {
      kept.shift();
      items.push({ ...named, status: "added", frame: index.get(e.source)!, piece: pieces.shift()! });
      continue;
    }
    const drop = drops.findIndex((d) => sameExpansion(d, e));
    const reason = drop < 0 ? "duplicate" : drops.splice(drop, 1)[0]!.reason;
    items.push({ ...named, status: "dropped", reason });
  }
  return withinBudget(
    {
      schemaVersion: EXPLORATIONS_SCHEMA_VERSION,
      viewId,
      revision: base.revision,
      origin: origin.kind,
      ...(origin.kind === "presentation"
        ? { presentationId: origin.presentationId, generation: origin.generation }
        : {}),
      modelGeneration: sources.generation,
      limits,
      expansions: { items, total: expand.length, truncated: expand.length > limits.maxExpansions },
      frames,
      counts: { sources: replayed.canvas.sources.size, boxes: replayed.canvas.boxes, wires: replayed.canvas.wires },
      ...(origin.kind === "presentation" && origin.notices.length > 0
        ? { notices: origin.notices.slice(0, 8).map(noticeLine) }
        : {}),
    },
    pins,
    limits.maxResponseBytes,
  );
}

/** The agent's view of an exploration (A10): frames by source and the elements they touch, and frame selections resolved against each source's model. */
export interface ExplorationReport {
  readonly origin: "presentation" | "reader";
  readonly viewId: string;
  readonly generation?: number;
  readonly expand: readonly Expansion[];
  readonly frames: readonly {
    readonly source: string;
    readonly title: string;
    readonly touches: readonly string[];
    readonly boxes: number;
    readonly proposed?: true;
  }[];
  readonly selection: readonly (FrameSelection & { readonly label?: string })[];
  readonly dropped?: readonly (Expansion & { readonly reason: DropReason })[];
  readonly notices?: readonly string[];
}

/** Resolves frame selections against the frames' sources: only a part a kept frame draws, named by that source's model (A10). */
export function selectionIn(
  sources: ExpandSources,
  replayed: Replayed,
  selection: readonly FrameSelection[],
): (FrameSelection & { label?: string })[] {
  const out: (FrameSelection & { label?: string })[] = [];
  const seen = new Set<string>();
  for (const s of selection.slice(0, MAX_FRAME_SELECTION)) {
    const key = `${s.source}\0${s.kind}\0${s.id}`;
    if (seen.has(key)) continue;
    const pieces = replayed.pieces.filter((p) => p.source === s.source);
    if (pieces.length === 0) continue;
    const label = labelIn(pieces, s);
    if (label === undefined) continue;
    seen.add(key);
    out.push({ ...s, ...(label === null ? {} : { label }) });
  }
  return out;
}

/** The part's label in the source's own pieces, null when it has none, undefined when no piece draws it. */
function labelIn(pieces: readonly Piece[], s: FrameSelection): string | null | undefined {
  for (const p of pieces) {
    const shape = shapeOf(p.model);
    if (shape === null) continue;
    if (s.kind === "node") {
      if (!shape.boxes.has(s.id)) continue;
      const m = p.model as unknown as Record<
        string,
        readonly { id: string; label?: string | null; name?: string }[] | undefined
      >;
      const box = [
        ...(m["nodes"] ?? []),
        ...(m["elements"] ?? []),
        ...(m["services"] ?? []),
        ...(m["entities"] ?? []),
      ].find((b) => b.id === s.id);
      return box?.label ?? box?.name ?? null;
    }
    const wire =
      shape.wires.find((w) => w.id === s.id) ??
      p.attach.map((a) => ({ id: a.key, label: a.label })).find((w) => w.id === s.id);
    if (wire !== undefined) return wire.label ?? null;
  }
  return undefined;
}

/** The report the agent reads for a replay. */
export function reportOf(
  sources: ExpandSources,
  origin: "presentation" | "reader",
  viewId: string,
  replayed: Replayed,
  extra: { generation?: number; selection?: readonly FrameSelection[]; notices?: readonly string[] },
): ExplorationReport {
  const proposed = new Set(sources.model.views.filter((v) => v.proposed === true).map((v) => v.id));
  const frames: { source: string; title: string; touches: string[]; boxes: number; proposed?: true }[] = [];
  replayed.kept.forEach((e, i) => {
    let f = frames.find((x) => x.source === e.source);
    if (f === undefined) {
      f = {
        source: e.source,
        title: sources.title(e.source),
        touches: [],
        boxes: 0,
        ...(proposed.has(e.source) ? { proposed: true as const } : {}),
      };
      frames.push(f);
    }
    if (!f.touches.includes(e.element)) f.touches.push(e.element);
    f.boxes += replayed.pieces[i]!.boxes;
  });
  return {
    origin,
    viewId,
    ...(extra.generation === undefined ? {} : { generation: extra.generation }),
    expand: replayed.kept,
    frames,
    selection: extra.selection === undefined ? [] : selectionIn(sources, replayed, extra.selection),
    ...(replayed.dropped.length === 0 ? {} : { dropped: replayed.dropped }),
    ...(extra.notices === undefined || extra.notices.length === 0 ? {} : { notices: extra.notices }),
  };
}
