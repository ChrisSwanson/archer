import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_NOTE_EMPHASES,
  MAX_NOTE_EMPHASIS_GROUPS,
  MAX_NOTE_EMPHASIS_PASSAGES,
  MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP,
  NOTE_EMPHASIS_TEXT_LIMITS,
  type Anchor,
  type NoteEmphasisGroupInput,
  type NoteEmphasisRead,
  type UpsertNoteEmphasisInput,
} from "./contract";
import type { ReviewEvents } from "./events";
import type { CommentsTransport } from "./transport";

export type NoteEmphasisState =
  | { readonly status: "loading"; readonly read?: NoteEmphasisRead }
  | { readonly status: "ready"; readonly read: NoteEmphasisRead; readonly error?: string }
  | { readonly status: "error"; readonly message: string };

const failureMessage = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "the server did not answer";

export const READER_EMPHASIS_TITLE = "Reader highlights";
const READER_EMPHASIS_ID = "reader-highlights";
const READER_EMPHASIS_ID_PATTERN = /^reader-highlights(?:-[1-9]\d*)?$/;
type PassageAnchor = Extract<Anchor, { kind: "passage" }>;
export type PersonHighlightInput =
  | { readonly ok: true; readonly setId: string; readonly input: UpsertNoteEmphasisInput }
  | { readonly ok: false; readonly problem: string };

const samePassage = (a: PassageAnchor, b: PassageAnchor): boolean =>
  a.quote === b.quote && a.prefix === b.prefix && a.suffix === b.suffix;
export const isReaderEmphasis = (emphasis: {
  readonly id: string;
  readonly title?: string;
  readonly author: string;
}): boolean =>
  emphasis.author === "person" &&
  emphasis.title === READER_EMPHASIS_TITLE &&
  READER_EMPHASIS_ID_PATTERN.test(emphasis.id);
const groupId = (label: string, groups: readonly NoteEmphasisGroupInput[]): string => {
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 112) || "highlight";
  if (!groups.some((group) => group.id === base)) return base;
  for (let suffix = 2; suffix <= MAX_NOTE_EMPHASIS_GROUPS + 1; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!groups.some((group) => group.id === candidate)) return candidate;
  }
  return `${base}-new`;
};

/**
 * Builds one bounded CAS replacement without touching agent-owned named sets.
 * Groups carry no palette: the colour follows the group's order (ADR 0030).
 */
export function appendPersonHighlight(
  read: NoteEmphasisRead,
  labelValue: string,
  passage: PassageAnchor,
): PersonHighlightInput {
  const label = labelValue.trim();
  const limit = NOTE_EMPHASIS_TEXT_LIMITS.label;
  if (label === "") return { ok: false, problem: "Name what the highlight means." };
  if ([...label].length > limit.chars) return { ok: false, problem: `Use at most ${limit.chars} characters.` };
  if (label.split(/\s+/).length > limit.words) return { ok: false, problem: `Use at most ${limit.words} words.` };
  const total = read.snapshot.emphases.reduce(
    (count, emphasis) => count + emphasis.groups.reduce((n, group) => n + group.passages.length, 0),
    0,
  );
  if (total >= MAX_NOTE_EMPHASIS_PASSAGES)
    return { ok: false, problem: `This note already has ${MAX_NOTE_EMPHASIS_PASSAGES} highlighted passages.` };
  const existingPerson = read.snapshot.emphases.find(isReaderEmphasis);
  let setId = existingPerson?.id;
  if (setId === undefined) {
    if (read.snapshot.emphases.length >= MAX_NOTE_EMPHASES)
      return { ok: false, problem: `This note already has ${MAX_NOTE_EMPHASES} named highlight sets.` };
    setId = READER_EMPHASIS_ID;
    for (let suffix = 2; read.snapshot.emphases.some((emphasis) => emphasis.id === setId); suffix++)
      setId = `${READER_EMPHASIS_ID}-${suffix}`;
  }
  const groups: NoteEmphasisGroupInput[] = (existingPerson?.groups ?? []).map(
    ({ palette: _derived, ...group }) => group,
  );
  const at = groups.findIndex((group) => group.label === label);
  if (at >= 0) {
    const group = groups[at]!;
    if (group.passages.some((held) => samePassage(held, passage)))
      return { ok: false, problem: "That passage is already in this highlight group." };
    if (group.passages.length >= MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP)
      return { ok: false, problem: `A group holds at most ${MAX_NOTE_EMPHASIS_PASSAGES_PER_GROUP} passages.` };
    groups[at] = { ...group, passages: [...group.passages, passage] };
  } else {
    if (groups.length >= MAX_NOTE_EMPHASIS_GROUPS)
      return {
        ok: false,
        problem: `Reader highlights hold at most ${MAX_NOTE_EMPHASIS_GROUPS} groups. Add this passage to one of them.`,
      };
    groups.push({ id: groupId(label, groups), label, passages: [passage] });
  }
  return {
    ok: true,
    setId,
    input: {
      notePath: read.snapshot.notePath,
      id: setId,
      title: READER_EMPHASIS_TITLE,
      groups,
      expectedRevision: read.snapshot.revision,
    },
  };
}

/** A highlight save's outcome, as far as the page knows it: saved, refused, or (its answer lost) not known (codex-402). */
export type NoteEmphasisSave = "saved" | "refused" | "uncertain";
const UNCERTAIN_HIGHLIGHT =
  "Archer did not answer, so these highlights may have been saved or not. What Archer holds was reloaded and is shown; save again if it is not what you set.";

/** Whether `read` holds every group and passage the save asked for, in its set. */
function holdsHighlights(read: NoteEmphasisRead, input: UpsertNoteEmphasisInput): boolean {
  const set = read.snapshot.emphases.find((emphasis) => emphasis.id === input.id);
  if (set === undefined) return false;
  return input.groups.every((wanted) =>
    set.groups.some(
      (group) =>
        group.label === wanted.label &&
        wanted.passages.every((p) => group.passages.some((held) => samePassage(held, p))),
    ),
  );
}

/** What the highlight form says for a save's outcome: the same as the legend, never a definite failure for a lost answer. */
export function highlightSaveResult(
  outcome: NoteEmphasisSave,
): { readonly ok: true } | { readonly ok: false; readonly problem: string } {
  if (outcome === "saved") return { ok: true };
  if (outcome === "uncertain") return { ok: false, problem: UNCERTAIN_HIGHLIGHT };
  return { ok: false, problem: "The server did not save this highlight. Review the current highlights and try again." };
}

/** Durable note-emphasis reads and CAS writes, refreshed through the page's one event stream. */
export function useNoteEmphasis(options: {
  readonly enabled: boolean;
  readonly transport: CommentsTransport;
  readonly events: ReviewEvents;
}): {
  readonly states: ReadonlyMap<string, NoteEmphasisState>;
  readonly open: (path: string) => void;
  readonly save: (input: UpsertNoteEmphasisInput) => Promise<NoteEmphasisSave>;
} {
  const { enabled, transport, events } = options;
  const [states, setStates] = useState<ReadonlyMap<string, NoteEmphasisState>>(new Map());
  const statesRef = useRef(states);
  statesRef.current = states;
  const opened = useRef(new Set<string>());
  const sequence = useRef(new Map<string, number>());
  const saveFailures = useRef(new Map<string, string>());
  const saveGeneration = useRef(0);
  const activeSaves = useRef(new Map<string, number>());

  const load = useCallback(
    async (path: string, afterFailure?: string): Promise<NoteEmphasisRead | null> => {
      if (!enabled) return null;
      if (afterFailure !== undefined) saveFailures.current.set(path, afterFailure);
      const mine = (sequence.current.get(path) ?? 0) + 1;
      sequence.current.set(path, mine);
      const loading = (held: ReadonlyMap<string, NoteEmphasisState>): Map<string, NoteEmphasisState> => {
        const next = new Map(held);
        const before = held.get(path);
        next.set(path, before?.status === "ready" ? { status: "loading", read: before.read } : { status: "loading" });
        return next;
      };
      setStates(loading);
      // Said at once, not at the next render: a second open in the same moment waits for this read.
      statesRef.current = loading(statesRef.current);
      try {
        const read = await transport.noteEmphasis(path);
        if (sequence.current.get(path) !== mine) return read;
        const error = saveFailures.current.get(path);
        setStates((held) =>
          new Map(held).set(path, error === undefined ? { status: "ready", read } : { status: "ready", read, error }),
        );
        return read;
      } catch (error) {
        if (sequence.current.get(path) !== mine) return null;
        setStates((held) =>
          new Map(held).set(path, { status: "error", message: `Highlights unavailable: ${failureMessage(error)}` }),
        );
        return null;
      }
    },
    [enabled, transport],
  );

  const open = useCallback(
    (path: string): void => {
      opened.current.add(path);
      const held = statesRef.current.get(path);
      if (held === undefined || held.status === "error") void load(path);
    },
    [load],
  );

  const save = useCallback(
    async (input: UpsertNoteEmphasisInput): Promise<NoteEmphasisSave> => {
      if (!enabled) return "refused";
      const saveMine = ++saveGeneration.current;
      activeSaves.current.set(input.notePath, saveMine);
      const mine = (sequence.current.get(input.notePath) ?? 0) + 1;
      sequence.current.set(input.notePath, mine);
      try {
        const read = await transport.upsertNoteEmphasis(input);
        if (activeSaves.current.get(input.notePath) !== saveMine) return "saved";
        saveFailures.current.delete(input.notePath);
        setStates((held) => {
          if (activeSaves.current.get(input.notePath) !== saveMine) return held;
          const current = held.get(input.notePath);
          if (sequence.current.get(input.notePath) !== mine) {
            if (current?.status !== "ready" || current.error === undefined) return held;
            return new Map(held).set(input.notePath, { status: "ready", read: current.read });
          }
          return new Map(held).set(input.notePath, { status: "ready", read });
        });
        return "saved";
      } catch (error) {
        if (activeSaves.current.get(input.notePath) !== saveMine) return "refused";
        // No answer (the network dropped it): the save may have landed. The reload shows what Archer holds; not "Could not"
        // (write sweep). Reading as the person's highlights, it was saved (codex-402); otherwise it is not known.
        const lost = error instanceof TypeError;
        const problem = lost
          ? UNCERTAIN_HIGHLIGHT
          : `Could not save highlights: ${failureMessage(error).replace(/\.+$/, "")}. The current highlights were reloaded; try again.`;
        const read = await load(input.notePath, problem);
        if (!lost) return "refused";
        if (read !== null && holdsHighlights(read, input)) {
          saveFailures.current.delete(input.notePath);
          setStates((held) => new Map(held).set(input.notePath, { status: "ready", read }));
          return "saved";
        }
        return "uncertain";
      }
    },
    [enabled, load, transport],
  );

  useEffect(
    () =>
      events.subscribe((event) => {
        if (!enabled) return;
        if (event.type === "note-emphasis" && opened.current.has(event.notePath)) void load(event.notePath);
        else if (event.type === "reconnect") for (const path of opened.current) void load(path);
      }),
    [enabled, events, load],
  );

  useEffect(() => {
    if (enabled) return;
    opened.current.clear();
    sequence.current.clear();
    saveFailures.current.clear();
    saveGeneration.current += 1;
    activeSaves.current.clear();
    setStates(new Map());
  }, [enabled]);

  return { states, open, save };
}
