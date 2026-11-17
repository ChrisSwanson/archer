// The set_emphasis contract (ADR 0005), ported from Rust's
// crates/archer-present/src/emphasis.rs: the agent points at ids the compiled
// model declares, with values from closed enums, never a colour or markup.
//
// Validation is atomic: a payload with any problem publishes nothing, and the
// refusal lists every problem with a fix, so one retry can repair them all.
import type { DiagramModel, SequenceEvent } from "../ts/src/model/index.ts";
import { elementsOf } from "../ts/src/model/index.ts";

export const STYLES = ["flow", "highlight"] as const;
/** Group 1, 2 and 3, in priority order. Amber is the agent's voice, never a group. */
export const SLOT_PALETTES = ["teal", "violet", "coral"] as const;
/**
 * The wire's palette names. Since ADR 0030 the agent does not choose one: the
 * service derives it from the group's position (`SLOT_PALETTES`).
 */
export const PALETTES = SLOT_PALETTES;
/** On the wire only; always "existing" since ADR 0030 ("proposed" is said in the label). */
export const STATES = ["existing", "proposed"] as const;
export const SPEEDS = ["slow", "normal", "fast"] as const;
export type Style = (typeof STYLES)[number];
export type Palette = (typeof PALETTES)[number];
export type State = (typeof STATES)[number];
export type Speed = (typeof SPEEDS)[number];

/** ADR 0030: three groups, coloured in order. */
export const MAX_GROUPS = SLOT_PALETTES.length;
/** The legend's text, as ADR 0030 bounds it: words for reading, characters for fitting. */
export const TEXT_LIMITS = {
  title: { words: 5, chars: 40 },
  label: { words: 4, chars: 32 },
  description: { words: Infinity, chars: 90 },
} as const;
/** The longest any of them may be: what the tool schema advertises for a string with no tighter bound. */
export const MAX_TEXT = Math.max(TEXT_LIMITS.title.chars, TEXT_LIMITS.label.chars, TEXT_LIMITS.description.chars);
export const MAX_IDS = 64;
export const MAX_ID_LENGTH = 128;
export const MAX_SUGGESTIONS = 8;
export const MAX_ECHO = 32;
export const MAX_UNKNOWN_FIELDS = 8;
export const MAX_EMPHASES_PER_VIEW = 8;

const PAYLOAD_KEYS = ["id", "viewId", "title", "groups"] as const;
export const GROUP_KEYS = ["id", "style", "speed", "label", "description", "nodes", "edges"] as const;
/** Fields ADR 0030 withdrew: refused with their own fix rather than as unknown. */
const WITHDRAWN: Readonly<Record<"palette" | "state", string>> = {
  palette:
    "Colours follow group order (1 teal, 2 violet, 3 coral). Remove `palette` and put the most important group first.",
  state: 'Proposed is said in the label, e.g. "Refund queue (proposed)". Remove `state`.',
};

const GUIDANCE: Record<"style" | "speed", string> = {
  style:
    'Use "flow" for a directional path (moving arrows, implies travel order) or "highlight" for a set you are pointing at.',
  speed: "Speed is how you say which hop is expensive.",
};
const VOCABULARY = { style: STYLES, speed: SPEEDS } as const;

export interface Issue {
  readonly where: string;
  readonly problem: string;
  readonly fix: string;
}

export interface Group {
  readonly id: string;
  readonly style: Style;
  readonly palette: Palette;
  readonly state: State;
  /** `flow` only. */
  readonly speed?: Speed;
  readonly label?: string;
  readonly description?: string;
  readonly nodes: readonly string[];
  readonly edges: readonly string[];
}

/** One named emphasis, in the wire shape the page reads. */
export interface Emphasis {
  readonly id: string;
  readonly viewId: string;
  readonly title?: string;
  readonly groups: readonly Group[];
}

export interface EmphasisPayload {
  readonly schemaVersion: 1;
  readonly viewId: string;
  readonly emphases: readonly Emphasis[];
}

type Unaddressable = "fragment" | "note";

/** What one compiled model lets an emphasis name. */
export interface Addressable {
  readonly notation: "graph" | "sequence";
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
  /** For each positional id (messages, fragments), what it is apart from where it sits. */
  readonly anchors: ReadonlyMap<string, string>;
  readonly unaddressable: ReadonlyMap<string, Unaddressable>;
}

export function addressable(model: DiagramModel): Addressable {
  if (model.type !== "sequence-trace") {
    const { nodes, links } = elementsOf(model);
    return {
      notation: "graph",
      nodes: new Set(nodes.map((n) => n.id)),
      edges: new Set(links.map((e) => e.id)),
      anchors: new Map(),
      unaddressable: new Map(),
    };
  }
  const edges = new Set<string>();
  const anchors = new Map<string, string>();
  const unaddressable = new Map<string, Unaddressable>();
  const seen = new Map<string, number>();
  const anchor = (what: string): string => {
    const count = seen.get(what) ?? 0;
    seen.set(what, count + 1);
    return `${what}#${count}`;
  };
  // A worklist, not recursion: depth costs heap, not stack.
  const pending: SequenceEvent[][] = [[...model.events].reverse()];
  for (let events = pending.pop(); events !== undefined; events = pending.pop()) {
    const event = events.pop();
    if (event === undefined) continue;
    pending.push(events);
    if (event.type === "message") {
      anchors.set(event.id, anchor(JSON.stringify(["message", event.from, event.to, event.kind, event.label ?? ""])));
      edges.add(event.id);
    } else if (event.type === "fragment") {
      anchors.set(event.id, anchor(JSON.stringify(["fragment", event.kind, event.label])));
      unaddressable.set(event.id, "fragment");
      for (const section of [...event.sections].reverse()) pending.push([...section.events].reverse());
    } else if (event.type === "note") {
      unaddressable.set(event.id, "note");
    }
  }
  return { notation: "sequence", nodes: new Set(model.participants.map((p) => p.id)), edges, anchors, unaddressable };
}

export type ParsedEmphasis =
  | { readonly ok: true; readonly emphasis: Emphasis }
  | { readonly ok: false; readonly issues: Issue[] };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const chars = (text: string): number => [...text].length;
const quoted = (text: string): string => JSON.stringify(text);
const quotedPrefix = (text: string): string => {
  const all = [...text];
  return all.length <= MAX_ECHO ? quoted(text) : `${quoted(all.slice(0, MAX_ECHO).join(""))}…`;
};
function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  switch (typeof value) {
    case "string":
      return "a string";
    case "number":
      return "a number";
    case "boolean":
      return "a boolean";
    case "object":
      return "an object";
    default:
      return typeof value;
  }
}

/** A payload read whole but not yet checked against a model. */
export interface Draft {
  readonly id: string | null;
  /** As sent: absent, or whatever the caller put there. */
  readonly viewId: unknown;
  readonly title: string | null;
  readonly groups: readonly DraftGroup[];
  readonly issues: readonly Issue[];
}

/**
 * Read one `set_emphasis` payload, collecting every problem that needs no
 * model. With `viewId`, the payload's own may be left out, and if given must
 * be that one.
 */
export function parseDraft(raw: unknown, viewId?: string, mode: Mode = "request"): Draft {
  const issues: Issue[] = [];
  const issue = (where: string, problem: string, fix: string) => issues.push({ where, problem, fix });
  if (!isObject(raw)) {
    issue(
      "payload",
      `is ${typeName(raw)}, not an object`,
      "Send an object with id, groups and optionally viewId and title.",
    );
    return { id: null, viewId: undefined, title: null, groups: [], issues };
  }
  const id = requiredString(
    raw,
    "id",
    issues,
    'Give the emphasis a short stable id such as "dataflow"; sending it again with the same id replaces it in place.',
  );
  if (viewId !== undefined && raw["viewId"] !== undefined && raw["viewId"] !== viewId)
    issue(
      "viewId",
      typeof raw["viewId"] === "string"
        ? `names view ${quotedPrefix(raw["viewId"])}, not ${quoted(viewId)}`
        : `is ${typeName(raw["viewId"])}, not a string`,
      "Leave viewId out, or make it the view the request names.",
    );
  const title = text(raw, "title", "title", issues);
  unknownFields(raw, PAYLOAD_KEYS, "payload", `An emphasis accepts only: ${PAYLOAD_KEYS.join(", ")}.`, issues);

  const drafts: DraftGroup[] = [];
  const groups = raw["groups"];
  if (Array.isArray(groups)) {
    if (groups.length > MAX_GROUPS)
      issue(
        "groups",
        `has ${groups.length} groups, more than the limit of ${MAX_GROUPS}`,
        `Order groups by priority and keep the top ${MAX_GROUPS}, or publish another named emphasis. Groups are coloured in order (1 teal, 2 violet, 3 coral); a fourth colour would stop pointing and start recolouring.`,
      );
    const seen = new Set<string>();
    groups.slice(0, MAX_GROUPS).forEach((value, index) => {
      const draft = parseGroup(value, index, seen, mode, issues);
      if (draft !== null) drafts.push(draft);
    });
  } else {
    issue(
      "groups",
      groups === undefined ? "is missing" : `is ${typeName(groups)}, not an array`,
      "Send an array of groups, or an empty array to clear this emphasis.",
    );
  }
  return { id, viewId: raw["viewId"], title, groups: drafts, issues };
}

/** Check a draft's ids against the view's model; publishes nothing unless all of it holds. */
export function resolveDraft(draft: Draft, viewId: string, known: Addressable): ParsedEmphasis {
  const issues = [...draft.issues];
  resolveIds(draft.groups, known, issues);
  if (issues.length > 0 || draft.id === null) return { ok: false, issues };
  const resolved: Group[] = draft.groups.map((d, index) => {
    const style = d.style as Style;
    return {
      id: d.id as string,
      style,
      // Derived, never chosen: the wire keeps the name for pages from before ADR 0030.
      palette: SLOT_PALETTES[index] ?? "teal",
      state: "existing",
      ...(style === "flow" ? { speed: d.speed ?? "normal" } : {}),
      ...(d.label === null ? {} : { label: d.label }),
      ...(d.description === null ? {} : { description: d.description }),
      nodes: d.nodes,
      edges: d.edges,
    };
  });
  return {
    ok: true,
    emphasis: { id: draft.id, viewId, ...(draft.title === null ? {} : { title: draft.title }), groups: resolved },
  };
}

/**
 * Parse one `set_emphasis` payload for `viewId` and resolve its ids against
 * the view's model. Its own `viewId` may be left out; if given it must be the
 * request's. `mode: "stored"` reads an emphasis already in the wire shape
 * (export, restore), whose derived `palette` and `state` are not the agent's.
 */
export function parseEmphasis(
  raw: unknown,
  viewId: string,
  known: Addressable,
  mode: Mode = "request",
): ParsedEmphasis {
  const draft = parseDraft(raw, viewId, mode);
  if (!isObject(raw)) return { ok: false, issues: [...draft.issues] };
  return resolveDraft(draft, viewId, known);
}

/** Who refused an emphasis: set_emphasis, or present_diagram's `emphasis` argument (nothing is presented then). */
export type EmphasisCaller = "set_emphasis" | "present_diagram";

/** One refusal text naming every problem, for the agent to fix in one retry, in the terms of the call it made. */
export function rejection(issues: readonly Issue[], caller: EmphasisCaller = "set_emphasis"): string {
  const count = issues.length;
  const problems = `${count} ${count === 1 ? "problem" : "problems"}`;
  let text =
    caller === "present_diagram"
      ? `present_diagram's emphasis argument was rejected: ${problems}. Nothing was presented and the view is unchanged. Fix all of them and retry.`
      : `set_emphasis rejected: ${problems}. Nothing was published and the view is unchanged. Fix all of them and retry.`;
  for (const issue of issues) text += `\n- ${issue.where}: ${issue.problem}. ${issue.fix}`;
  return text;
}

/** The issue for a payload naming a view the project does not have, with a "Did you mean". */
export function unknownView(named: string, views: readonly string[]): Issue {
  const hint = nearest(named, new Set(views));
  return {
    where: "viewId",
    problem: `no diagram view is named ${quoted(named)}`,
    fix: hint === null ? "Call list_diagrams to see the views." : `Did you mean ${quoted(hint)}?`,
  };
}

export interface DraftGroup {
  readonly location: string;
  readonly id: string | null;
  readonly style: Style | null;
  readonly speed: Speed | null;
  readonly label: string | null;
  readonly description: string | null;
  readonly nodes: string[];
  readonly edges: string[];
}

/**
 * "request" is an agent's call, held to ADR 0030. "stored" is an emphasis in the
 * wire shape (export, restore): held to the same rules, except that its derived
 * `palette` and `state` are not the agent's and are ignored, and its label is optional.
 */
export type Mode = "request" | "stored";

function parseGroup(value: unknown, index: number, seen: Set<string>, mode: Mode, issues: Issue[]): DraftGroup | null {
  if (!isObject(value)) {
    issues.push({
      where: `groups[${index}]`,
      problem: `is ${typeName(value)}, not an object`,
      fix: "Each group is an object with an id, a style, a label, and the ids it points at.",
    });
    return null;
  }
  const rawId = typeof value["id"] === "string" && value["id"] !== "" ? value["id"] : null;
  const overLength = rawId !== null && chars(rawId) > MAX_ID_LENGTH ? chars(rawId) : null;
  const id = overLength === null ? rawId : null;
  const location = id === null ? `groups[${index}]` : `group ${quoted(id)}`;
  const issue = (problem: string, fix: string) => issues.push({ where: location, problem, fix });
  if (id === null && overLength !== null)
    issue(
      `has an id of ${overLength} characters, more than the limit of ${MAX_ID_LENGTH}`,
      `Give the group a short stable id of ${MAX_ID_LENGTH} characters or fewer.`,
    );
  else if (id === null) issue("has no id", "Give every group a short stable id — an empty string is not one.");
  else if (seen.has(id))
    issue("repeats an id used earlier in this call", "Group ids must be unique within one emphasis.");
  else seen.add(id);

  const style = enumField(value, "style", true, location, issues);
  const speed = enumField(value, "speed", false, location, issues);
  const namesSpeed = value["speed"] !== undefined && value["speed"] !== null;
  if (namesSpeed && style === "highlight")
    issue(
      "sets a speed on a highlight group",
      'Speed applies only to style "flow", where it paces the moving arrows. Drop it, or switch the group to "flow".',
    );
  const nodes = idArray(value, "nodes", location, issues);
  const edges = idArray(value, "edges", location, issues);
  if (nodes.ids.length === 0 && edges.ids.length === 0 && !nodes.refused && !edges.refused)
    issue(
      "names neither a node nor an edge",
      "Every group must point at something. Drop the group, or add the ids you meant.",
    );
  if (mode === "request")
    for (const key of ["palette", "state"] as const)
      if (value[key] !== undefined) issue(`sets ${key}, which an emphasis no longer accepts`, WITHDRAWN[key]);
  // The withdrawn fields have their own issue above (or are the wire's, ignored), never a second "unknown".
  unknownFields(
    value,
    [...GROUP_KEYS, "palette", "state"],
    location,
    `A group accepts only: ${GROUP_KEYS.join(", ")}.`,
    issues,
  );
  const label = text(value, "label", location, issues);
  // The wire's label is optional (a stored or exported group may have none); a call must name one.
  if (label === null && mode === "request" && (value["label"] === undefined || value["label"] === null))
    issue("has no label", 'Give every group a label: the legend row\'s title, 4 words or fewer, e.g. "Checkout path".');
  const description = text(value, "description", location, issues);
  return {
    location,
    id,
    style: style as Style | null,
    speed: speed as Speed | null,
    label,
    description,
    nodes: nodes.ids,
    edges: edges.ids,
  };
}

function resolveIds(groups: readonly DraftGroup[], known: Addressable, issues: Issue[]): void {
  const words =
    known.notation === "graph"
      ? {
          node: "node",
          edge: "edge",
          nodeFix: "Call read_diagram to list the ids this diagram declares.",
          edgeFix: "Edge ids are the ones declared in the Mermaid source as `source id@--> target`.",
        }
      : {
          node: "participant",
          edge: "message",
          nodeFix: "Call read_diagram to list the participants this diagram declares.",
          edgeFix:
            "Message ids are positional: msg-0 is the first message in the source, msg-1 the next. Call read_diagram to list them.",
        };
  let budget = MAX_SUGGESTIONS;
  const suggest = (id: string, among: ReadonlySet<string>): string | null => (budget-- > 0 ? nearest(id, among) : null);
  for (const group of groups) {
    const named = [...group.nodes.map((id) => [id, true] as const), ...group.edges.map((id) => [id, false] as const)];
    for (const [id, asNode] of named) {
      const [noun, key, mine, otherNoun, otherKey, theirs] = asNode
        ? [words.node, "nodes", known.nodes, words.edge, "edges", known.edges]
        : [words.edge, "edges", known.edges, words.node, "nodes", known.nodes];
      if (mine.has(id)) continue;
      const kind = known.unaddressable.get(id);
      if (kind !== undefined) {
        issues.push({
          where: group.location,
          problem: `names ${quoted(id)}, which is a ${kind} and cannot be emphasised`,
          fix: `Emphasis points at ${words.node}s (\`nodes\`) and ${words.edge}s (\`edges\`). ${
            kind === "fragment"
              ? "Name the messages inside the fragment instead."
              : "Name the participant or message the note is about instead."
          }`,
        });
      } else if (theirs.has(id)) {
        issues.push({
          where: group.location,
          problem: `lists ${quoted(id)} under \`${key}\`, but it is a ${otherNoun}`,
          fix: `Move it to \`${otherKey}\`.`,
        });
      } else {
        const hint = suggest(id, mine);
        issues.push({
          where: group.location,
          problem: `no ${noun} ${quoted(id)} in this diagram`,
          fix: hint === null ? (asNode ? words.nodeFix : words.edgeFix) : `Did you mean ${quoted(hint)}?`,
        });
      }
    }
  }
}

function requiredString(object: Json, key: string, issues: Issue[], fix: string): string | null {
  const value = object[key];
  if (typeof value === "string") {
    if (value === "") issues.push({ where: key, problem: "is empty", fix });
    else if (chars(value) > MAX_ID_LENGTH)
      issues.push({
        where: key,
        problem: `has ${chars(value)} characters, more than the limit of ${MAX_ID_LENGTH}`,
        fix: `An id is ${MAX_ID_LENGTH} characters or fewer. ${fix}`,
      });
    else return value;
    return null;
  }
  issues.push({ where: key, problem: value === undefined ? "is missing" : `is ${typeName(value)}, not a string`, fix });
  return null;
}

const words = (value: string): number => value.trim().split(/\s+/).filter(Boolean).length;
/**
 * More than one sentence: a terminator, then space, then more text. The space
 * is required so that "Node.js", "v2.1" and "e.g." stay one sentence.
 */
const sentences = (value: string): boolean => /[.!?]\s+\S/.test(value.trim());

/** Legend text, refused rather than shortened: a caption cut mid-clause says something the agent did not mean. */
function text(object: Json, key: "title" | "label" | "description", location: string, issues: Issue[]): string | null {
  const value = object[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    issues.push({
      where: location,
      problem: `has a ${key} that is ${typeName(value)}, not a string`,
      fix: `Send ${key} as plain text, or leave it out.`,
    });
    return null;
  }
  const say = (problem: string, fix: string): null => {
    issues.push({ where: location, problem, fix: `${fix} The text is refused rather than shortened for you.` });
    return null;
  };
  const limit = TEXT_LIMITS[key];
  const advice = {
    title: 'A title is 5 words or fewer, e.g. "Checkout and refunds".',
    label: 'A label is the legend row\'s title: 4 words or fewer, e.g. "Refund queue (proposed)".',
    description: "A description is one short sentence saying why this group matters.",
  }[key];
  if (key === "label" && value.replace(/[\p{White_Space}\p{Cf}]/gu, "") === "")
    return say("has an empty label", advice);
  if (chars(value) > limit.chars)
    return say(`has a ${key} of ${chars(value)} characters, more than the limit of ${limit.chars}`, advice);
  if (words(value) > limit.words)
    return say(`has a ${key} of ${words(value)} words, more than the limit of ${limit.words}`, advice);
  if (key === "description" && sentences(value)) return say("has a description of more than one sentence", advice);
  return value;
}

function enumField(
  object: Json,
  key: keyof typeof VOCABULARY,
  required: boolean,
  location: string,
  issues: Issue[],
): string | null {
  const value = object[key];
  const names = VOCABULARY[key].join(", ");
  if (value === undefined || value === null) {
    if (required)
      issues.push({
        where: location,
        problem: `has no ${key}`,
        fix: `Set ${key} to one of: ${names}. ${GUIDANCE[key]}`,
      });
    return null;
  }
  if (typeof value === "string" && (VOCABULARY[key] as readonly string[]).includes(value)) return value;
  issues.push({
    where: location,
    problem: `has an unknown ${key} ${typeof value === "string" ? quotedPrefix(value) : typeName(value)}`,
    fix: `Use one of: ${names}. ${GUIDANCE[key]}`,
  });
  return null;
}

function idArray(
  object: Json,
  key: "nodes" | "edges",
  location: string,
  issues: Issue[],
): { ids: string[]; refused: boolean } {
  const value = object[key];
  if (value === undefined || value === null) return { ids: [], refused: false };
  if (!Array.isArray(value)) {
    issues.push({
      where: location,
      problem: `has a ${key} that is ${typeName(value)}, not an array`,
      fix: `Send ${key} as an array of stable ids.`,
    });
    return { ids: [], refused: false };
  }
  if (value.length > MAX_IDS) {
    issues.push({
      where: location,
      problem: `has ${value.length} ${key}, more than the limit of ${MAX_IDS}`,
      fix: `Point at ${MAX_IDS} ${key} or fewer in one group, or split them across groups. None of these were checked against the diagram.`,
    });
    return { ids: [], refused: true };
  }
  const ids: string[] = [];
  let refused = false;
  for (const entry of value) {
    if (typeof entry !== "string") {
      issues.push({
        where: location,
        problem: `has a ${key} entry that is ${typeName(entry)}, not a string`,
        fix: `Every ${key} entry is a stable id from the compiled model.`,
      });
    } else if (chars(entry) > MAX_ID_LENGTH) {
      refused = true;
      issues.push({
        where: location,
        problem: `has ${key === "edges" ? "an" : "a"} ${key} entry of ${chars(entry)} characters, more than the limit of ${MAX_ID_LENGTH}`,
        fix: `No id in a compiled model is longer than ${MAX_ID_LENGTH} characters, so this cannot name one. Call read_diagram to list the ids this diagram declares.`,
      });
    } else ids.push(entry);
  }
  return { ids, refused };
}

function unknownFields(object: Json, allowed: readonly string[], location: string, fix: string, issues: Issue[]): void {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  for (const key of unknown.slice(0, MAX_UNKNOWN_FIELDS))
    issues.push({ where: location, problem: `has an unknown field ${quotedPrefix(key)}`, fix });
  if (unknown.length > MAX_UNKNOWN_FIELDS)
    issues.push({
      where: location,
      problem: `has ${unknown.length - MAX_UNKNOWN_FIELDS} more unknown fields, not listed here`,
      fix,
    });
}

/**
 * The closest id by edit distance over code points, if it is close enough to
 * be a likely typo. Candidates are tried in sorted order, so a tie resolves
 * the same way whatever order the model declared them in.
 */
export function nearest(id: string, among: ReadonlySet<string>): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  const limit = Math.max(2, Math.floor(chars(id) / 3));
  const lowered = id.toLowerCase();
  for (const candidate of [...among].sort()) {
    const distance = editDistance(lowered, candidate.toLowerCase());
    if (distance <= limit && distance < bestDistance) [best, bestDistance] = [candidate, distance];
  }
  return best;
}

function editDistance(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const swap =
        i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1] ? (previous[j - 2] ?? Infinity) : Infinity;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
        swap,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

interface Held {
  emphasis: Emphasis;
  /** For each positional edge id it names, that message's anchor when published. */
  anchors: Map<string, string>;
}

/** Named emphases per view, oldest first; the page reads the whole list. */
export class EmphasisStore {
  #views = new Map<string, Held[]>();

  /** Internal recovery includes positional message anchors, not just public payloads. */
  snapshot(): unknown[] {
    return [...this.#views].map(([viewId, named]) => ({
      viewId,
      named: named.map((held) => ({ emphasis: structuredClone(held.emphasis), anchors: [...held.anchors] })),
    }));
  }
  restore(snapshot: unknown, models: ReadonlyMap<string, Addressable>): void {
    if (!Array.isArray(snapshot) || snapshot.length > 256) throw new Error("invalid saved emphasis collection");
    const next = new Map<string, Held[]>();
    for (const raw of snapshot) {
      if (typeof raw !== "object" || raw === null) throw new Error("invalid saved emphasis view");
      const item = raw as { viewId: unknown; named: unknown };
      if (typeof item.viewId !== "string" || !Array.isArray(item.named) || item.named.length > MAX_EMPHASES_PER_VIEW)
        throw new Error("invalid saved emphasis records");
      const known = models.get(item.viewId);
      if (known === undefined) continue;
      const held: Held[] = [];
      for (const record of item.named) {
        if (typeof record !== "object" || record === null) throw new Error("invalid saved emphasis");
        const r = record as { emphasis: unknown; anchors: unknown };
        const parsed = resolveDraft(parseDraft(r.emphasis, item.viewId, "stored"), item.viewId, known);
        if (!parsed.ok || !Array.isArray(r.anchors) || r.anchors.length > MAX_GROUPS * MAX_IDS)
          throw new Error("invalid saved emphasis anchors");
        const anchors = new Map<string, string>();
        for (const pair of r.anchors) {
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            typeof pair[0] !== "string" ||
            typeof pair[1] !== "string" ||
            pair[1].length > 256 * 1024
          )
            throw new Error("invalid saved message anchor");
          if (known.anchors.get(pair[0]) !== pair[1])
            throw new Error("saved message anchor does not match its original model");
          anchors.set(pair[0], pair[1]);
        }
        const expected = anchorsOf(parsed.emphasis, known);
        if (anchors.size !== expected.size || [...expected].some(([id, anchor]) => anchors.get(id) !== anchor))
          throw new Error("saved message anchors are incomplete or unsupported");
        if (held.some((h) => h.emphasis.id === parsed.emphasis.id))
          throw new Error("duplicate saved emphasis identifier");
        held.push({ emphasis: parsed.emphasis, anchors });
      }
      if (next.has(item.viewId)) throw new Error("duplicate saved emphasis view");
      next.set(item.viewId, held);
    }
    this.#views = next;
  }
  /** Store (or with no groups, clear) one emphasis; returns the view's payload. */
  apply(emphasis: Emphasis, known: Addressable): EmphasisPayload {
    const named = this.#views.get(emphasis.viewId) ?? [];
    this.#views.set(emphasis.viewId, named);
    const index = named.findIndex((held) => held.emphasis.id === emphasis.id);
    const held: Held = { emphasis, anchors: anchorsOf(emphasis, known) };
    if (emphasis.groups.length === 0) {
      if (index >= 0) named.splice(index, 1);
    } else if (index >= 0) {
      named[index] = held;
    } else {
      named.push(held);
      if (named.length > MAX_EMPHASES_PER_VIEW) named.shift();
    }
    return this.payload(emphasis.viewId);
  }

  payload(viewId: string): EmphasisPayload {
    return { schemaVersion: 1, viewId, emphases: (this.#views.get(viewId) ?? []).map((held) => held.emphasis) };
  }

  /**
   * Check a view's emphases against the model that replaced theirs: an id
   * that is gone leaves its group, an empty group leaves its emphasis, and an
   * emphasis with no groups is cleared. A message id follows its message by
   * anchor. Returns whether anything changed.
   */
  revalidate(viewId: string, known: Addressable): boolean {
    const named = this.#views.get(viewId);
    if (named === undefined) return false;
    const byAnchor = new Map<string, string>();
    for (const [id, anchor] of known.anchors) byAnchor.set(anchor, id);
    let changed = false;
    for (const held of named) {
      const groups: Group[] = [];
      for (const group of held.emphasis.groups) {
        const nodes = group.nodes.filter((id) => known.nodes.has(id));
        const edges: string[] = [];
        for (const id of group.edges) {
          const anchor = held.anchors.get(id);
          const now = anchor === undefined ? (known.edges.has(id) ? id : undefined) : byAnchor.get(anchor);
          if (now !== undefined && known.edges.has(now)) edges.push(now);
        }
        if (nodes.length !== group.nodes.length || edges.join("\0") !== group.edges.join("\0")) changed = true;
        if (nodes.length > 0 || edges.length > 0) groups.push({ ...group, nodes, edges });
      }
      // A group that left takes its colour with it: the rest move up a slot,
      // and the wire's derived palette must say so for a page from before ADR 0030.
      groups.forEach((group, index) => {
        const palette = SLOT_PALETTES[index] ?? "teal";
        if (group.palette !== palette) groups[index] = { ...group, palette };
      });
      held.emphasis = { ...held.emphasis, groups };
      held.anchors = anchorsOf(held.emphasis, known);
    }
    if (!changed) return false;
    const kept = named.filter((held) => held.emphasis.groups.length > 0);
    this.#views.set(viewId, kept);
    return true;
  }

  /** Forget a view's emphases; true if it had any. */
  clear(viewId: string): boolean {
    const had = (this.#views.get(viewId)?.length ?? 0) > 0;
    this.#views.delete(viewId);
    return had;
  }
}

function anchorsOf(emphasis: Emphasis, known: Addressable): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const group of emphasis.groups)
    for (const id of group.edges) {
      const anchor = known.anchors.get(id);
      if (anchor !== undefined) anchors.set(id, anchor);
    }
  return anchors;
}
