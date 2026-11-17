import type { PassageAnchor } from "./note-markdown.mts";

export const NOTE_EMPHASIS_SCHEMA_VERSION = 1 as const;
/** Group 1, 2 and 3, in priority order. Amber is the agent's voice, never a group. */
export const NOTE_EMPHASIS_SLOT_PALETTES = ["teal", "violet", "coral"] as const;
/**
 * The wire's palette names. Since ADR 0030 nobody chooses one: the service derives it from the
 * group's position, and it is written to the wire and the sidecar for readers of that shape.
 */
export const NOTE_EMPHASIS_PALETTES = NOTE_EMPHASIS_SLOT_PALETTES;
export const NOTE_EMPHASIS_AUTHORS = ["person", "agent"] as const;
export const MAX_NOTE_EMPHASIS_ID_CHARS = 128;
/** Request text past this is malformed rather than refused with the legend's advice. */
const MAX_SENT_TEXT_CHARS = 240;
/** The legend's text, as ADR 0030 bounds diagram emphasis: words for reading, characters for fitting. */
export const NOTE_EMPHASIS_TEXT_LIMITS = {
  title: { words: 5, chars: 40 },
  label: { words: 4, chars: 32 },
  description: { words: Infinity, chars: 90 },
} as const;
export const MAX_NOTE_EMPHASES = 8;
/** ADR 0030: three groups, coloured in order. */
export const MAX_NOTE_EMPHASIS_GROUPS = NOTE_EMPHASIS_SLOT_PALETTES.length;
/** A request with more groups than this is malformed rather than refused with the limit's advice. */
const MAX_SENT_GROUPS = 6;
export const MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP = 64;
export const MAX_NOTE_EMPHASIS_PASSAGES = 256;
export const MAX_NOTE_EMPHASIS_QUOTE_CHARS = 1_000;
export const MAX_NOTE_EMPHASIS_CONTEXT_CHARS = 200;
export const MAX_NOTE_EMPHASIS_FILE_BYTES = 2 * 1024 * 1024;

export type NoteEmphasisPalette = (typeof NOTE_EMPHASIS_PALETTES)[number];
export type NoteEmphasisAuthor = (typeof NOTE_EMPHASIS_AUTHORS)[number];

/** A group as a caller sends it: no palette, since the colour follows the group's position. */
export interface NoteEmphasisGroupInput {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly passages: readonly PassageAnchor[];
}
/** A stored or served group: `palette` is derived from its position, for older readers only. */
export interface NoteEmphasisGroup extends NoteEmphasisGroupInput {
  readonly palette: NoteEmphasisPalette;
}
export interface NoteEmphasis {
  readonly id: string;
  readonly title?: string;
  readonly author: NoteEmphasisAuthor;
  readonly groups: readonly NoteEmphasisGroup[];
}

export interface NoteEmphasisSnapshot {
  readonly schemaVersion: 1;
  readonly notePath: string;
  readonly revision: number;
  readonly emphases: readonly NoteEmphasis[];
}

export interface UpsertNoteEmphasisInput {
  readonly notePath: string;
  readonly id: string;
  readonly title?: string;
  /** An empty list removes this named emphasis. Colours follow this order (teal, violet, coral). */
  readonly groups: readonly NoteEmphasisGroupInput[];
  readonly expectedRevision: number;
}

export interface NoteEmphasisOrphan {
  readonly emphasisId: string;
  readonly groupId: string;
  /** Index into the named group's passages in the unchanged snapshot. */
  readonly passageIndex: number;
}

export type NoteEmphasisRead = {
  readonly snapshot: NoteEmphasisSnapshot;
  readonly orphans: readonly NoteEmphasisOrphan[];
};

export type NoteEmphasisValidation =
  | { readonly ok: true; readonly snapshot: NoteEmphasisSnapshot }
  | { readonly ok: false; readonly problem: string };

export type NoteEmphasisUpsertValidation =
  | { readonly ok: true; readonly input: UpsertNoteEmphasisInput }
  | { readonly ok: false; readonly problem: string };

class InvalidSnapshot extends Error {}

const object = (value: unknown, where: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new InvalidSnapshot(`${where} must be an object`);
  return value as Record<string, unknown>;
};
/** How the note-emphasis limits count characters: Unicode code points, not UTF-16 units. */
export const noteEmphasisCharacters = (value: string): number => [...value].length;
const characters = noteEmphasisCharacters;
const text = (value: unknown, where: string, maximum: number, empty = true): string => {
  if (typeof value !== "string") throw new InvalidSnapshot(`${where} must be text`);
  const length = characters(value);
  if ((!empty && value.trim() === "") || (length === 0 && !empty))
    throw new InvalidSnapshot(`${where} must not be empty`);
  if (length > maximum) throw new InvalidSnapshot(`${where} is over ${maximum} characters`);
  return value;
};
const exact = (value: Record<string, unknown>, fields: readonly string[], where: string): void => {
  for (const key of Object.keys(value))
    if (!fields.includes(key))
      throw new InvalidSnapshot(`${where} has an unknown field ${JSON.stringify(key.slice(0, 32))}`);
};

function passage(value: unknown, where: string): PassageAnchor {
  const item = object(value, where);
  exact(item, ["kind", "quote", "prefix", "suffix"], where);
  if (item["kind"] !== "passage") throw new InvalidSnapshot(`${where}.kind must be "passage"`);
  return {
    kind: "passage",
    quote: text(item["quote"], `${where}.quote`, MAX_NOTE_EMPHASIS_QUOTE_CHARS, false),
    prefix: text(item["prefix"], `${where}.prefix`, MAX_NOTE_EMPHASIS_CONTEXT_CHARS),
    suffix: text(item["suffix"], `${where}.suffix`, MAX_NOTE_EMPHASIS_CONTEXT_CHARS),
  };
}

type Mode = "request" | "stored";
/** Problems a request can have all at once: the legend's text and withdrawn fields. Named together, refused together. */
type Issues = string[];
const words = (value: string): number => value.trim().split(/\s+/).filter(Boolean).length;
const LEGEND_FIX: Readonly<Record<keyof typeof NOTE_EMPHASIS_TEXT_LIMITS, string>> = {
  title: 'A title is 5 words or fewer, e.g. "Checkout and refunds".',
  label: 'A label is the legend row\'s title: 4 words or fewer, e.g. "Refund queue (proposed)".',
  description: "A description is one sentence saying why the group matters.",
};
const PALETTE_FIX =
  "Colours follow group order (1 teal, 2 violet, 3 coral). Remove `palette` and put the most important group first.";

/**
 * Legend text, held to the legend's bounds: in a request refused rather than shortened, with advice; in a
 * stored file, past them, malformed.
 */
function legendText(
  value: unknown,
  key: keyof typeof NOTE_EMPHASIS_TEXT_LIMITS,
  where: string,
  mode: Mode,
  issues: Issues,
  empty: boolean,
): string {
  const at = where === "" ? key : `${where}.${key}`;
  const limit = NOTE_EMPHASIS_TEXT_LIMITS[key];
  const held = text(value, at, mode === "stored" ? limit.chars : MAX_SENT_TEXT_CHARS, empty);
  if (mode === "stored") {
    if (words(held) > limit.words) throw new InvalidSnapshot(`${at} is over ${limit.words} words`);
    return held;
  }
  if (characters(held) > limit.chars)
    issues.push(
      `${at} has ${characters(held)} characters, more than the limit of ${limit.chars}. ${LEGEND_FIX[key]} The text is refused rather than shortened for you.`,
    );
  else if (words(held) > limit.words)
    issues.push(
      `${at} has ${words(held)} words, more than the limit of ${limit.words}. ${LEGEND_FIX[key]} The text is refused rather than shortened for you.`,
    );
  return held;
}

function group(value: unknown, where: string, index: number, mode: Mode, issues: Issues): NoteEmphasisGroup {
  const item = object(value, where);
  if (mode !== "stored" && item["palette"] !== undefined) issues.push(`${where} has a palette. ${PALETTE_FIX}`);
  exact(item, ["id", "label", "description", "palette", "passages"], where);
  const rawPassages = item["passages"];
  if (!Array.isArray(rawPassages)) throw new InvalidSnapshot(`${where}.passages must be a list`);
  if (rawPassages.length > MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP)
    throw new InvalidSnapshot(`${where}.passages has more than ${MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP} passages`);
  // A stored palette is the wire's; it is read and then derived again from position.
  const palette = item["palette"];
  if (
    mode === "stored" &&
    palette !== undefined &&
    (typeof palette !== "string" || !(NOTE_EMPHASIS_PALETTES as readonly string[]).includes(palette))
  )
    throw new InvalidSnapshot(`${where}.palette must be teal, violet or coral`);
  const description =
    item["description"] === undefined
      ? undefined
      : legendText(item["description"], "description", where, mode, issues, true);
  return {
    id: text(item["id"], `${where}.id`, MAX_NOTE_EMPHASIS_ID_CHARS, false),
    label: legendText(item["label"], "label", where, mode, issues, false),
    ...(description === undefined ? {} : { description }),
    palette: NOTE_EMPHASIS_SLOT_PALETTES[index] ?? "teal",
    passages: rawPassages.map((anchor, at) => passage(anchor, `${where}.passages[${at}]`)),
  };
}

/** A stored emphasis: at most three groups (ADR 0030). */
function emphasis(value: unknown, where: string): NoteEmphasis {
  const item = object(value, where);
  exact(item, ["id", "title", "author", "groups"], where);
  const rawGroups = item["groups"];
  if (!Array.isArray(rawGroups)) throw new InvalidSnapshot(`${where}.groups must be a list`);
  if (rawGroups.length === 0 || rawGroups.length > MAX_NOTE_EMPHASIS_GROUPS)
    throw new InvalidSnapshot(`${where}.groups must hold from 1 to ${MAX_NOTE_EMPHASIS_GROUPS} groups`);
  const author = item["author"];
  if (typeof author !== "string" || !(NOTE_EMPHASIS_AUTHORS as readonly string[]).includes(author))
    throw new InvalidSnapshot(`${where}.author must be "person" or "agent"`);
  const groups = rawGroups.map((entry, index) => group(entry, `${where}.groups[${index}]`, index, "stored", []));
  if (new Set(groups.map((entry) => entry.id)).size !== groups.length)
    throw new InvalidSnapshot(`${where} has two groups with one id`);
  const title = item["title"] === undefined ? undefined : legendText(item["title"], "title", where, "stored", [], true);
  const id = text(item["id"], `${where}.id`, MAX_NOTE_EMPHASIS_ID_CHARS, false);
  return {
    id,
    ...(title === undefined ? {} : { title }),
    author: author as NoteEmphasisAuthor,
    groups,
  };
}

/** Strictly validates a persisted note-emphasis snapshot without throwing on malformed input. */
export function validateNoteEmphasisSnapshot(value: unknown): NoteEmphasisValidation {
  try {
    const item = object(value, "the note emphasis file");
    exact(item, ["schemaVersion", "notePath", "revision", "emphases"], "the note emphasis file");
    if (item["schemaVersion"] !== NOTE_EMPHASIS_SCHEMA_VERSION)
      throw new InvalidSnapshot(`schemaVersion must be ${NOTE_EMPHASIS_SCHEMA_VERSION}`);
    const revision = item["revision"];
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)
      throw new InvalidSnapshot("revision must be a non-negative safe integer");
    const rawEmphases = item["emphases"];
    if (!Array.isArray(rawEmphases)) throw new InvalidSnapshot("emphases must be a list");
    if (rawEmphases.length > MAX_NOTE_EMPHASES)
      throw new InvalidSnapshot(`emphases has more than ${MAX_NOTE_EMPHASES} named sets`);
    const emphases = rawEmphases.map((entry, index) => emphasis(entry, `emphases[${index}]`));
    if (new Set(emphases.map((entry) => entry.id)).size !== emphases.length)
      throw new InvalidSnapshot("two named emphases have one id");
    const passages = emphases.reduce(
      (total, entry) => total + entry.groups.reduce((n, g) => n + g.passages.length, 0),
      0,
    );
    if (passages > MAX_NOTE_EMPHASIS_PASSAGES)
      throw new InvalidSnapshot(`the snapshot has more than ${MAX_NOTE_EMPHASIS_PASSAGES} passages`);
    return {
      ok: true,
      snapshot: {
        schemaVersion: NOTE_EMPHASIS_SCHEMA_VERSION,
        notePath: text(item["notePath"], "notePath", 4_096, false),
        revision,
        emphases,
      },
    };
  } catch (error) {
    if (error instanceof InvalidSnapshot) return { ok: false, problem: error.message };
    return { ok: false, problem: "the note emphasis file could not be validated" };
  }
}

/** Strictly validates the public mutation shape. `author` is deliberately not a caller field. */
export function validateNoteEmphasisUpsert(value: unknown): NoteEmphasisUpsertValidation {
  const mode = "request";
  try {
    const item = object(value, "the note emphasis request");
    exact(item, ["notePath", "id", "title", "groups", "expectedRevision"], "the note emphasis request");
    const expectedRevision = item["expectedRevision"];
    if (typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new InvalidSnapshot("expectedRevision must be a non-negative safe integer");
    const rawGroups = item["groups"];
    if (!Array.isArray(rawGroups)) throw new InvalidSnapshot("groups must be a list");
    if (rawGroups.length > MAX_SENT_GROUPS)
      throw new InvalidSnapshot(
        `groups has ${rawGroups.length} groups, more than the limit of ${MAX_NOTE_EMPHASIS_GROUPS}`,
      );
    const issues: Issues = [];
    if (rawGroups.length > MAX_NOTE_EMPHASIS_GROUPS)
      issues.push(
        `groups has ${rawGroups.length} groups, more than the limit of ${MAX_NOTE_EMPHASIS_GROUPS}. Order groups by priority and keep the top ${MAX_NOTE_EMPHASIS_GROUPS}, or publish another named set. Groups are coloured in order (1 teal, 2 violet, 3 coral).`,
      );
    const groups = rawGroups.map((entry, index) => group(entry, `groups[${index}]`, index, mode, issues));
    if (new Set(groups.map((entry) => entry.id)).size !== groups.length)
      throw new InvalidSnapshot("two groups have one id");
    const passages = groups.reduce((total, entry) => total + entry.passages.length, 0);
    if (passages > MAX_NOTE_EMPHASIS_PASSAGES)
      throw new InvalidSnapshot(`the request has more than ${MAX_NOTE_EMPHASIS_PASSAGES} passages`);
    const title = item["title"] === undefined ? undefined : legendText(item["title"], "title", "", mode, issues, true);
    if (issues.length > 0)
      throw new InvalidSnapshot(
        `the note emphasis request has ${issues.length} problem${issues.length === 1 ? "" : "s"}; nothing was written:${issues.map((issue) => `\n- ${issue}`).join("")}`,
      );
    return {
      ok: true,
      input: {
        notePath: text(item["notePath"], "notePath", 4_096, false),
        id: text(item["id"], "id", MAX_NOTE_EMPHASIS_ID_CHARS, false),
        ...(title === undefined ? {} : { title }),
        groups: groups.map(({ palette: _derived, ...input }) => input),
        expectedRevision,
      },
    };
  } catch (error) {
    if (error instanceof InvalidSnapshot) return { ok: false, problem: error.message };
    return { ok: false, problem: "the note emphasis request could not be validated" };
  }
}
