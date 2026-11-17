// Renaming element ids in one diagram's source (ADR 0036 §10, A14). Pure. The rewrite is by text,
// family by family: ids outside labels, strings and comments change, nothing else. It is checked,
// not trusted: the caller compiles the result and compares it with `renameModel` of the old model,
// so a rewrite that touched a label or missed an id is refused rather than written.
import type { DiagramModel } from "../model/envelope.ts";
import type { DraftWalkthrough, Walkthrough } from "../walkthroughs/contract.ts";

export type Renames = ReadonlyMap<string, string>;

/** Why a family cannot be renamed by text: a journey task's id is its label. */
export function unrenamable(model: DiagramModel): string | null {
  return model.type === "user-journey"
    ? "a journey task's id is made from its text, so renaming it changes what the task says"
    : null;
}

const ID = /[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*/g;

/** `[start, end)` character ranges of a line that hold no ids. */
type Ranges = [number, number][];

function quoted(line: string, out: Ranges): void {
  for (let i = line.indexOf('"'); i >= 0; ) {
    const end = line.indexOf('"', i + 1);
    if (end < 0) {
      out.push([i, line.length]);
      return;
    }
    out.push([i, end + 1]);
    i = line.indexOf('"', end + 1);
  }
}

/** From the first `marker` outside quotes to the line's end. */
function after(line: string, marker: string, out: Ranges, from = 0): void {
  let inQuote = false;
  for (let i = from; i < line.length; i++) {
    if (line[i] === '"') inQuote = !inQuote;
    else if (!inQuote && line.startsWith(marker, i)) {
      out.push([i, line.length]);
      return;
    }
  }
}

/** Every bracketed label: `[…]`, `(…)`, `{…}` (nesting counted), and `|…|` edge text. */
function brackets(line: string, out: Ranges): void {
  const open = "[({",
    close = "])}";
  let depth = 0,
    start = -1,
    inQuote = false,
    pipe = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (depth === 0 && c === "|") {
      if (pipe < 0) pipe = i;
      else {
        out.push([pipe, i + 1]);
        pipe = -1;
      }
      continue;
    }
    if (pipe >= 0) continue;
    // `a@{ shape: … }` is a node's shape, not an id-bearing list.
    if (open.includes(c)) {
      if (depth === 0) start = i;
      depth++;
    } else if (close.includes(c) && depth > 0) {
      depth--;
      if (depth === 0) out.push([start, i + 1]);
    }
  }
  if (depth > 0) out.push([start, line.length]);
}

const HEADER =
  /^\s*(flowchart|graph|sequenceDiagram|stateDiagram(-v2)?|erDiagram|C4Context|C4Container|C4Component|architecture-beta|journey)\b/;
const PROSE_LINE = /^\s*(title|accTitle|accDescr|direction|autonumber)\b/;
const SEQUENCE_FRAGMENT = /^\s*(alt|else|opt|loop|par|and|critical|option|break|rect|box)\b/;

function protectedRanges(line: string, family: DiagramModel["type"]): Ranges | "all" {
  const trimmed = line.trim();
  if (trimmed === "" || HEADER.test(line) || PROSE_LINE.test(line)) return "all";
  if (trimmed.startsWith("%%")) {
    // `%% archer-line dotted: a--b, c--d` names edges, whose derived ids follow their ends.
    const directive = /^\s*%%\s*archer-line\b[^:]*:/.exec(line);
    const derived =
      family === "c4-model" ||
      family === "service-architecture" ||
      family === "state-machine" ||
      family === "entity-relationship";
    return directive === null || !derived ? "all" : [[0, directive[0].length]];
  }
  const out: Ranges = [];
  quoted(line, out);
  switch (family) {
    case "c4-model":
      break;
    case "sequence-trace":
      if (SEQUENCE_FRAGMENT.test(line)) return "all";
      after(line, ":", out);
      after(line, " as ", out);
      break;
    case "state-machine":
      if (/^\s*end note\b/.test(line)) return "all";
      after(line, ":", out);
      break;
    case "entity-relationship":
      after(line, ":", out);
      brackets(line, out);
      break;
    case "service-architecture":
      brackets(line, out);
      break;
    default: {
      // Flowcharts: labels, edge text, classDef and the class name a `class` line ends with.
      if (/^\s*(classDef|linkStyle)\b/.test(line)) return "all";
      brackets(line, out);
      // An edge's own id (`a--b@-->`) is written, never derived: it stays.
      for (const m of line.matchAll(/[A-Za-z0-9_-]+@(?=[-=.<~o])/g)) out.push([m.index!, m.index! + m[0].length]);
      const cls = /^(\s*class\s+\S+\s+)(\S+)\s*$/.exec(line);
      if (cls !== null) out.push([cls[1]!.length, line.length]);
      const style = /^(\s*(style|click)\s+\S+)/.exec(line);
      if (style !== null) out.push([style[1]!.length, line.length]);
    }
  }
  return out;
}

/** `source` with each id in `renames` renamed where it is used as an id. */
export function renameSource(source: string, model: DiagramModel, renames: Renames): string {
  if (renames.size === 0) return source;
  const lines = source.split("\n");
  let inNote = false,
    inEntity = false;
  return lines
    .map((line) => {
      // Multi-line state notes and ER attribute blocks hold text and attributes, never ids.
      if (model.type === "state-machine") {
        if (inNote) {
          if (/^\s*end note\b/.test(line)) inNote = false;
          return line;
        }
        if (/^\s*note\b/.test(line) && !line.includes(":")) {
          inNote = true;
        }
      }
      if (model.type === "entity-relationship") {
        if (inEntity) {
          if (/^\s*}/.test(line)) inEntity = false;
          return line;
        }
        if (/{\s*$/.test(line) && !/\|\||\}o|o\{|\|\{|\}\|/.test(line)) inEntity = true;
      }
      const ranges = protectedRanges(line, model.type);
      if (ranges === "all") return line;
      const free = (at: number, end: number) => !ranges.some(([a, b]) => at < b && end > a);
      return line.replace(ID, (token, at: number) => {
        const to = renames.get(token);
        if (to === undefined || !free(at, at + token.length)) return token;
        const next = line.slice(at + token.length);
        // `e1@-->` is an edge id; `:::container` a class; `x:R` an architecture side.
        if (/^@[-=.<~o]/.test(next) || line.slice(Math.max(0, at - 3), at) === ":::") return token;
        if (
          model.type === "service-architecture" &&
          /^[LRTB]$/.test(token) &&
          (line[at - 1] === ":" || next.startsWith(":"))
        )
          return token;
        return to;
      });
    })
    .join("\n");
}

const ID_KEYS = new Set(["id", "source", "target", "from", "to", "boundaryId", "parentId", "groupId", "participant"]);

/** Families whose relationship ids are made from their ends (`a--b`); a flowchart edge's id is written. */
export const derivesEdgeIds = (model: DiagramModel): boolean =>
  model.type === "c4-model" ||
  model.type === "service-architecture" ||
  model.type === "state-machine" ||
  model.type === "entity-relationship";

/** What `model` should compile to after the rename: every id and derived `a--b` id; labels as written. */
export function renameModel<T extends DiagramModel>(model: T, renames: Renames): T {
  const derives = derivesEdgeIds(model);
  const one = (id: string): string => renames.get(id) ?? id;
  const derived = (id: string): string => {
    if (renames.has(id)) return one(id);
    const ends = id.split("--");
    return derives && ends.length === 2 ? `${one(ends[0]!)}--${one(ends[1]!)}` : id;
  };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(object)) {
      if (ID_KEYS.has(key) && typeof v === "string") out[key] = key === "id" ? derived(v) : one(v);
      else if (key === "participants" && Array.isArray(v) && v.every((p) => typeof p === "string"))
        out[key] = v.map((p) => one(p as string));
      else out[key] = walk(v);
    }
    return out;
  };
  return walk(model) as T;
}

/** A walkthrough's draft (ids only) with the renames applied, and whether it names any renamed id. */
export function renameWalkthrough(
  walkthrough: Walkthrough,
  renames: Renames,
  derivesEdges: boolean,
): { draft: DraftWalkthrough; touched: boolean } {
  let touched = false;
  const one = (id: string): string => {
    const to = renames.get(id);
    if (to !== undefined) touched = true;
    return to ?? id;
  };
  const edge = (id: string): string => {
    if (renames.has(id)) return one(id);
    const ends = id.split("--");
    return derivesEdges && ends.length === 2 && (renames.has(ends[0]!) || renames.has(ends[1]!))
      ? `${one(ends[0]!)}--${one(ends[1]!)}`
      : id;
  };
  const draft: DraftWalkthrough = {
    id: walkthrough.id,
    title: walkthrough.title,
    ...(walkthrough.description === undefined ? {} : { description: walkthrough.description }),
    ...(walkthrough.note === undefined ? {} : { note: walkthrough.note }),
    ...(walkthrough.open === undefined ? {} : { open: walkthrough.open.map(one) }),
    steps: walkthrough.steps.map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind,
      what: s.what,
      ...(s.why === undefined ? {} : { why: s.why }),
      ...(s.code === undefined ? {} : { code: s.code }),
      nodes: (s.nodes ?? []).map((n) => ({ kind: n.kind, id: one(n.id) })),
      // An edge ref keeps its ends (Archer fills them in): a renamed end needs a rewrite, even under the same id.
      edges: (s.edges ?? []).map((e) => {
        if (renames.has(e.source) || renames.has(e.target)) touched = true;
        return { id: edge(e.id) };
      }),
      messages: (s.messages ?? []).map((m) => ({ from: one(m.from), to: one(m.to), label: m.label })),
    })),
  };
  return { draft, touched };
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Keys sorted, and lists of things with ids sorted by id: the compiler orders some lists by id, which a rename moves. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => {
    if (Array.isArray(v))
      return v.every((x) => x !== null && typeof x === "object" && typeof (x as { id?: unknown }).id === "string")
        ? [...v].sort((a, b) => byString(a.id, b.id))
        : v;
    return v !== null && typeof v === "object"
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => byString(a, b)))
      : v;
  });

/**
 * Whether `after` is `before` with the ids renamed and nothing else changed. A label that was never
 * written (a state or participant named by its id alone) moves with its id, so either is accepted.
 */
export function isRenameOf(before: DiagramModel, after: DiagramModel, renames: Renames): boolean {
  const back = new Map([...renames].map(([from, to]) => [to, from]));
  const unbare = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(unbare);
    if (value === null || typeof value !== "object") return value;
    const object = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, unbare(v)]));
    const id = object["id"];
    if (typeof id === "string" && object["label"] === id && back.has(id)) object["label"] = back.get(id);
    return object;
  };
  return stable(unbare(after)) === stable(renameModel(before, renames));
}
