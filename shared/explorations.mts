// Expand (ADR 0036 §11–§13, A8, A13): what the page and the service share. The limits are ticket 13's
// measured constants (docs/wayfinder/diagram-normalisation/slice6-prototype.md), enforced the same way on
// both sides; every answer echoes the values it applied. `maxExpansions` and `maxExpandParamChars` are
// provisional until ticket 11b (the link) settles them.

export const EXPLORATIONS_SCHEMA_VERSION = 1 as const;

/** The `api/connection` capability that says the routes below exist (A8, ADR 0015). */
export const EXPLORATIONS_CAPABILITY = "explorations";

export interface ExplorationLimits {
  /** Sources added to one canvas (O4: the base's own boxes do not count). */
  readonly maxAddedSources: number;
  /** Boxes added to one canvas, over every frame. */
  readonly maxAddedBoxes: number;
  readonly maxAddedWires: number;
  /** Per section of the menu: diagrams, neighbours. */
  readonly maxMenuCandidates: number;
  /** Model relationships read for one element's neighbours. */
  readonly maxRelationshipsPerElement: number;
  /** Boxes in one piece; the rest is "open the full diagram". */
  readonly maxPieceBoxes: number;
  /** One answer's JSON, raw. */
  readonly maxResponseBytes: number;
  /** Entries in one `expand` list (provisional, ticket 11b). */
  readonly maxExpansions: number;
  /** Characters of one encoded `expand` parameter (provisional, ticket 11b). */
  readonly maxExpandParamChars: number;
}

export const EXPLORATION_LIMITS: ExplorationLimits = Object.freeze({
  maxAddedSources: 5,
  maxAddedBoxes: 60,
  maxAddedWires: 120,
  maxMenuCandidates: 12,
  maxRelationshipsPerElement: 24,
  maxPieceBoxes: 40,
  maxResponseBytes: 64 * 1024,
  maxExpansions: 24,
  maxExpandParamChars: 4096,
});

/**
 * One addition, in the order it was made (§14): what `source` draws around `element`, or with `neighbour` (P41)
 * only the wire to that one neighbour and its box, as a "neighbour not drawn here" entry adds it.
 */
export interface Expansion {
  readonly element: string;
  readonly source: string;
  readonly neighbour?: string;
}

/** One key per addition: the same (element, source, neighbour) twice is a duplicate. */
export const expansionKey = (e: Expansion): string => `${e.element}\0${e.source}\0${e.neighbour ?? ""}`;
export const sameExpansion = (a: Expansion, b: Expansion): boolean =>
  a.element === b.element && a.source === b.source && a.neighbour === b.neighbour;
/** The addition as the wire carries it: `neighbour` only when there is one. */
export const expansionOf = (element: string, source: string, neighbour?: string): Expansion =>
  neighbour === undefined ? { element, source } : { element, source, neighbour };

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!,
      b = bytes[i + 1],
      c = bytes[i + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += B64[c & 63]!;
  }
  return out;
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => (i + k < text.length ? B64.indexOf(text[i + k]!) : -1));
    out.push((n[0]! << 2) | (n[1]! >> 4));
    if (n[2]! >= 0) out.push(((n[1]! & 15) << 4) | (n[2]! >> 2));
    if (n[3]! >= 0) out.push(((n[2]! & 3) << 6) | n[3]!);
  }
  return Uint8Array.from(out);
}

/**
 * The `expand` query parameter: base64url (no padding) of a JSON array of `[element, source]` pairs in
 * replay order, or `[element, source, neighbour]` for a neighbour entry (P41; a pair reads as it always did).
 * View ids carry `/` and `#`, so `?open=`'s comma list cannot hold them. The routes pass it through unchanged.
 */
export function encodeExpansions(expansions: readonly Expansion[]): string {
  return toBase64Url(
    new TextEncoder().encode(
      JSON.stringify(
        expansions.map((e) => (e.neighbour === undefined ? [e.element, e.source] : [e.element, e.source, e.neighbour])),
      ),
    ),
  );
}

/** The longest element (or neighbour) and source one `expand` entry may name: the decoder's, so every writer's too. */
export const MAX_EXPAND_ELEMENT_CHARS = 256;
export const MAX_EXPAND_SOURCE_CHARS = 512;

export type ShareableExpansions =
  | { readonly ok: true; readonly param: string }
  | { readonly ok: false; readonly reason: "too_many" | "too_long"; readonly message: string };

/**
 * Whether `expansions` fit one `expand` parameter that `decodeExpansions` reads back (P42): at most `maxExpansions`
 * entries, each name within the decoder's length, `maxExpandParamChars` encoded. Every writer asks before it
 * accepts an addition or emits a link: the page's add, the menu, Copy link and present_diagram's URL.
 */
export function shareableExpansions(
  expansions: readonly Expansion[],
  limits: ExplorationLimits = EXPLORATION_LIMITS,
): ShareableExpansions {
  if (expansions.length > limits.maxExpansions)
    return {
      ok: false,
      reason: "too_many",
      message: `${expansions.length} additions; a link holds at most ${limits.maxExpansions}`,
    };
  const long = expansions.some(
    (e) =>
      e.element.length > MAX_EXPAND_ELEMENT_CHARS ||
      e.source.length > MAX_EXPAND_SOURCE_CHARS ||
      (e.neighbour?.length ?? 0) > MAX_EXPAND_ELEMENT_CHARS,
  );
  if (long)
    return {
      ok: false,
      reason: "too_long",
      message: `a name is longer than a link holds (${MAX_EXPAND_ELEMENT_CHARS} characters for an element, ${MAX_EXPAND_SOURCE_CHARS} for a diagram)`,
    };
  const param = encodeExpansions(expansions);
  if (param.length > limits.maxExpandParamChars)
    return {
      ok: false,
      reason: "too_long",
      message: `the additions' names make a link parameter of ${param.length} characters; a link holds at most ${limits.maxExpandParamChars}`,
    };
  return { ok: true, param };
}

export type DecodedExpansions =
  | { readonly ok: true; readonly expansions: readonly Expansion[] }
  | { readonly ok: false; readonly code: "expand_param_too_long" | "invalid_expand"; readonly message: string };

/** Reads an `expand` parameter; an empty or absent one is no expansions. Never throws. */
export function decodeExpansions(
  text: string | null,
  limits: ExplorationLimits = EXPLORATION_LIMITS,
): DecodedExpansions {
  if (text === null || text === "") return { ok: true, expansions: [] };
  if (text.length > limits.maxExpandParamChars)
    return {
      ok: false,
      code: "expand_param_too_long",
      message: `expand is ${text.length} characters; at most ${limits.maxExpandParamChars}`,
    };
  const bytes = fromBase64Url(text);
  const bad = {
    ok: false,
    code: "invalid_expand",
    message: "expand is base64url of a JSON array of [element, source] pairs or [element, source, neighbour] triples",
  } as const;
  if (bytes === null) return bad;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return bad;
  }
  if (!Array.isArray(value)) return bad;
  if (value.length > limits.maxExpansions)
    return {
      ok: false,
      code: "expand_param_too_long",
      message: `expand names ${value.length} additions; at most ${limits.maxExpansions}`,
    };
  const expansions: Expansion[] = [];
  const id = (v: unknown, max: number): v is string => typeof v === "string" && v !== "" && v.length <= max;
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      (entry.length !== 2 && entry.length !== 3) ||
      !id(entry[0], MAX_EXPAND_ELEMENT_CHARS) ||
      !id(entry[1], MAX_EXPAND_SOURCE_CHARS) ||
      (entry.length === 3 && !id(entry[2], MAX_EXPAND_ELEMENT_CHARS))
    )
      return bad;
    expansions.push(expansionOf(entry[0], entry[1], entry.length === 3 ? (entry[2] as string) : undefined));
  }
  return { ok: true, expansions };
}

/** The id of a source's frame on the canvas: `~` is in no model id (ADR 0012 ids are `[A-Za-z0-9_.-]`). */
export const frameIdOf = (source: string): string => `xf~${source}`;
/** A frame's box or wire on the canvas, keyed by its source (A10): `xf~<source>~/<local id>`. */
export const framePartId = (source: string, local: string): string => `${frameIdOf(source)}~/${local}`;

/** A canvas id back to (source, local id) when it is a frame's part, else null. */
export function framePartOf(canvasId: string): { readonly source: string; readonly id: string } | null {
  if (!canvasId.startsWith("xf~")) return null;
  // A local id never holds `~` or `/`, so the last `~/` ends the source, whatever its view id holds.
  const at = canvasId.lastIndexOf("~/");
  if (at < 3) return null;
  return { source: canvasId.slice(3, at), id: canvasId.slice(at + 2) };
}

/** A frame's group id on the canvas back to its source, else null. */
export function frameSourceOf(groupId: string): string | null {
  return groupId.startsWith("xf~") && framePartOf(groupId) === null ? groupId.slice(3) : null;
}

/** Why a requested expansion is not on the canvas (P30). A link or a page's own list is resolved best-effort and says what it dropped. */
export type DropReason =
  | "duplicate"
  | "element_not_on_canvas"
  | "source_unknown"
  | "source_unrelated"
  | "source_is_base"
  | "source_not_frame"
  | "source_uncompiled"
  | "source_is_copy"
  | "nothing_to_add"
  | "limit_passed";

/**
 * Why `present_diagram` refuses an entry (A11): a drop reason, or `element_unknown` (no view draws the element) and
 * `too_many` (past `maxExpansions`). One bad entry refuses the call whole.
 */
export type ExpandRefusalReason = DropReason | "element_unknown" | "too_many";

/** What an opted-in bootstrap and presentation event carry as `presentation.exploration` (A8; never sent to an older page). */
export interface ExplorationStamp {
  /** Moves on every present with `expand` and on every refresh after a source recompiles or leaves (A11). */
  readonly generation: number;
  readonly sources: number;
  /** Boxes added: the MCP-App line "N parts added: open in Archer" (A11). */
  readonly parts: number;
}

/** A part of a frame the reader selected (A10): its source and local id, never the page's label. */
export interface FrameSelection {
  readonly source: string;
  readonly kind: "node" | "edge";
  readonly id: string;
}

/** POST api/reader-exploration (O1, route 4): the page's own exploration and what it selected in frames; an empty `expand` clears it. */
export interface ReaderExplorationReport {
  readonly viewId: string;
  readonly revision: string;
  readonly expand: readonly Expansion[];
  readonly selection?: readonly FrameSelection[];
}

/** The most frame parts one report or context names. */
export const MAX_FRAME_SELECTION = 64;

/**
 * The page's address with `expand` set to `expansions` (O10: Copy link; the graph itself never writes the address).
 * A list no link can carry (P42) gives the view's own address, `shared: false` and why: never a link the reader refuses.
 */
export function withExpandParam(
  href: string,
  expansions: readonly Expansion[],
  limits: ExplorationLimits = EXPLORATION_LIMITS,
):
  | { readonly href: string; readonly shared: true }
  | { readonly href: string; readonly shared: false; readonly problem: string } {
  const url = new URL(href);
  url.searchParams.delete("expand");
  if (expansions.length === 0) return { href: url.href, shared: true };
  const fit = shareableExpansions(expansions, limits);
  if (!fit.ok) return { href: url.href, shared: false, problem: fit.message };
  url.searchParams.set("expand", fit.param);
  return { href: url.href, shared: true };
}
