/**
 * Diagram types the editor offers, their starter source and their parts bar.
 *
 * Every graph-style type uses the same parts and the same edit operations (add a node,
 * connect two, rename, delete); a part only says which kind of node or connection, in
 * that type's own words. Flowchart and C4 are edited structurally on the service
 * (source-preserving, compiler-checked). Types without a structured editor yet insert
 * small valid snippets into the source, which the preview checks like any typing.
 */
export type Family = "flowchart" | "sequence" | "c4" | "state" | "er";
export type EdgeLine = "solid" | "dotted" | "thick";
export type FlowShape =
  | "rectangle"
  | "diamond"
  | "stadium"
  | "subroutine"
  | "cylinder"
  | "rounded"
  | "hexagon"
  | "circle";
export type C4Element =
  | "Person"
  | "System"
  | "SystemDb"
  | "SystemQueue"
  | "Container"
  | "ContainerDb"
  | "ContainerQueue"
  | "Component"
  | "ComponentDb"
  | "ComponentQueue";

export type ErCardinality = "one-to-many" | "one-to-one" | "many-to-many" | "zero-or-one-to-many";
/** What a node part creates: a flowchart shape, a C4 element, an ER entity, or a state. */
export type NodeCreate =
  | { readonly shape: FlowShape }
  | { readonly element: C4Element; readonly external?: boolean }
  | { readonly entity: true }
  | { readonly state: "state" | "choice" }
  | { readonly participant: "participant" | "actor" };
/** What a connection part creates: a flowchart line, a C4 relationship, an ER relationship, or a state transition. */
export type ConnectionCreate =
  | { readonly line: EdgeLine }
  | { readonly relation: "rel" | "birel" }
  | { readonly cardinality: ErCardinality }
  | { readonly transition: true }
  | { readonly message: "sync" | "reply" | "async" };

export type Part =
  | {
      readonly kind: "node";
      readonly key: string;
      readonly label: string;
      readonly create: NodeCreate;
      readonly idPrefix: string;
      readonly syntax: string;
    }
  /**
   * `label`: `none` connects without a label; `open` opens the label field after connecting;
   * `required` always has one (prefilled with `defaultLabel`, selected to type over).
   */
  | {
      readonly kind: "connection";
      readonly key: string;
      readonly label: string;
      readonly create: ConnectionCreate;
      readonly labelMode: "none" | "open" | "required";
      readonly defaultLabel?: string;
      readonly syntax: string;
    }
  /** A state diagram's start or end: a transition from `[*]` to the selected state, or from it to `[*]`. */
  | {
      readonly kind: "marker";
      readonly key: string;
      readonly label: string;
      readonly which: "start" | "end";
      readonly syntax: string;
    }
  /** Sequence: a note over the selected participant(s). */
  | { readonly kind: "note"; readonly key: string; readonly label: string; readonly syntax: string }
  /** Sequence: wrap the selected messages in a fragment (loop, alt, opt, par). */
  | {
      readonly kind: "wrap";
      readonly key: string;
      readonly label: string;
      readonly fragment: "loop" | "alt" | "opt" | "par";
      readonly defaultLabel: string;
      readonly syntax: string;
    }
  | {
      readonly kind: "group";
      readonly key: string;
      readonly label: string;
      readonly syntax: string;
      readonly unavailable: string;
    }
  | { readonly kind: "snippet"; readonly key: string; readonly label: string; readonly syntax: string };

export type PartGroup = readonly Part[];

export interface FamilyInfo {
  readonly label: string;
  readonly starter: string;
  /** Parts bar, in groups separated by a rule. */
  readonly parts: readonly PartGroup[];
  /** Whether the service edits this type structurally (the shared node/connection operations). */
  readonly structured: boolean;
  /** The canvas gestures, said once on first use (the coach mark): one line, middle dots between steps. */
  readonly howTo: string;
  /** What to do on an empty canvas. */
  readonly emptyHint: string;
}

const flowNode = (key: string, label: string, shape: FlowShape, syntax: string): Part => ({
  kind: "node",
  key,
  label,
  create: { shape },
  idPrefix: "n",
  syntax,
});
const c4Node = (
  key: string,
  label: string,
  element: C4Element,
  idPrefix: string,
  syntax: string,
  external = false,
): Part => ({ kind: "node", key, label, create: external ? { element, external } : { element }, idPrefix, syntax });

export const FAMILIES: Readonly<Record<Family, FamilyInfo>> = {
  flowchart: {
    label: "Flowchart",
    howTo:
      "Click a part to add it · drag from a shape’s edge to another shape to connect them · double-click to rename",
    emptyHint: "Click a part to add it, then drag from its edge to another shape to connect them.",
    starter: "flowchart LR\n",
    structured: true,
    parts: [
      [
        flowNode("process", "Process", "rectangle", "id[Label]"),
        flowNode("decision", "Decision", "diamond", "id{Question?}"),
        flowNode("terminal", "Start / end", "stadium", "id([Label])"),
        flowNode("subroutine", "Subroutine", "subroutine", "id[[Label]]"),
        flowNode("database", "Database", "cylinder", "id[(Label)]"),
      ],
      [
        {
          kind: "connection",
          key: "arrow",
          label: "Arrow",
          create: { line: "solid" },
          labelMode: "none",
          syntax: "a --> b",
        },
        {
          kind: "connection",
          key: "dashed",
          label: "Dashed",
          create: { line: "dotted" },
          labelMode: "none",
          syntax: "a -.-> b",
        },
        {
          kind: "connection",
          key: "thick",
          label: "Thick",
          create: { line: "thick" },
          labelMode: "none",
          syntax: "a ==> b",
        },
        {
          kind: "connection",
          key: "labelled",
          label: "Labelled",
          create: { line: "solid" },
          labelMode: "open",
          syntax: "a -- yes --> b",
        },
      ],
    ],
  },
  c4: {
    label: "C4 container",
    howTo: "Click a part to add it · drag from an element’s edge to another to relate them · double-click to rename",
    emptyHint: "Add a person or a system, then drag from one element’s edge to another to relate them.",
    starter: "C4Container\n",
    structured: true,
    parts: [
      [
        c4Node("person", "Person", "Person", "person", 'Person(id, "Name")'),
        c4Node("system", "System", "System", "system", 'System(id, "Name")'),
        c4Node("external", "External", "System", "external", 'System_Ext(id, "Name")', true),
        c4Node("container", "Container", "Container", "container", 'Container(id, "Name")'),
        c4Node("database", "Database", "ContainerDb", "db", 'ContainerDb(id, "Name")'),
      ],
      [
        {
          kind: "connection",
          key: "rel",
          label: "Relationship",
          create: { relation: "rel" },
          labelMode: "required",
          defaultLabel: "Uses",
          syntax: 'Rel(a, b, "Uses")',
        },
        {
          kind: "connection",
          key: "birel",
          label: "Two-way",
          create: { relation: "birel" },
          labelMode: "required",
          defaultLabel: "Uses",
          syntax: 'BiRel(a, b, "Uses")',
        },
      ],
    ],
  },
  sequence: {
    label: "Sequence",
    howTo: "Drag from one lifeline to another to add a message · drag a header to reorder · double-click to rename",
    emptyHint: "Add two participants, then drag from one lifeline to another to add a message.",
    structured: true,
    starter: "sequenceDiagram\n",
    parts: [
      [
        {
          kind: "node",
          key: "participant",
          label: "Participant",
          create: { participant: "participant" },
          idPrefix: "p",
          syntax: "participant id as Label",
        },
        {
          kind: "node",
          key: "actor",
          label: "Actor",
          create: { participant: "actor" },
          idPrefix: "a",
          syntax: "actor id as Label",
        },
      ],
      [
        {
          kind: "connection",
          key: "message",
          label: "Message",
          create: { message: "sync" },
          labelMode: "open",
          syntax: "a->>b: call",
        },
        {
          kind: "connection",
          key: "reply",
          label: "Reply",
          create: { message: "reply" },
          labelMode: "open",
          syntax: "b-->>a: result",
        },
        {
          kind: "connection",
          key: "async",
          label: "Async",
          create: { message: "async" },
          labelMode: "open",
          syntax: "a-)b: event",
        },
      ],
      [{ kind: "note", key: "note", label: "Note", syntax: "Note over a,b: text" }],
      [
        { kind: "wrap", key: "loop", label: "Loop", fragment: "loop", defaultLabel: "repeat", syntax: "loop … end" },
        {
          kind: "wrap",
          key: "alt",
          label: "If / else",
          fragment: "alt",
          defaultLabel: "condition",
          syntax: "alt … end",
        },
        { kind: "wrap", key: "opt", label: "Optional", fragment: "opt", defaultLabel: "optional", syntax: "opt … end" },
        {
          kind: "wrap",
          key: "par",
          label: "Parallel",
          fragment: "par",
          defaultLabel: "in parallel",
          syntax: "par … end",
        },
      ],
    ],
  },
  state: {
    label: "State",
    howTo:
      "Drag from one state to another for a transition · select a state, then Start or End · double-click to rename",
    emptyHint: "Add a state, select it and click Start; then drag from one state to another for a transition.",
    structured: true,
    starter: "stateDiagram-v2\n",
    parts: [
      [
        {
          kind: "node",
          key: "state",
          label: "State",
          create: { state: "state" },
          idPrefix: "s",
          syntax: 'state "Label" as id',
        },
        {
          kind: "node",
          key: "choice",
          label: "Choice",
          create: { state: "choice" },
          idPrefix: "choice",
          syntax: "state id <<choice>>",
        },
        { kind: "marker", key: "start", label: "Start", which: "start", syntax: "[*] --> selected" },
        { kind: "marker", key: "end", label: "End", which: "end", syntax: "selected --> [*]" },
      ],
      [
        {
          kind: "connection",
          key: "transition",
          label: "Transition",
          create: { transition: true },
          labelMode: "open",
          syntax: "a --> b : event",
        },
      ],
    ],
  },
  er: {
    label: "Entity relationship",
    howTo:
      "Drag from one entity to another to relate them · select a relationship to change its cardinality · double-click to rename",
    emptyHint: "Add two entities, then drag from one to the other to relate them.",
    structured: true,
    starter: "erDiagram\n",
    parts: [
      [
        {
          kind: "node",
          key: "entity",
          label: "Entity",
          create: { entity: true },
          idPrefix: "ENTITY_",
          syntax: 'ENTITY["Label"]',
        },
      ],
      [
        {
          kind: "connection",
          key: "one-many",
          label: "One to many",
          create: { cardinality: "one-to-many" },
          labelMode: "open",
          syntax: "A ||--o{ B : has",
        },
        {
          kind: "connection",
          key: "one-one",
          label: "One to one",
          create: { cardinality: "one-to-one" },
          labelMode: "open",
          syntax: "A ||--|| B : is",
        },
        {
          kind: "connection",
          key: "many-many",
          label: "Many to many",
          create: { cardinality: "many-to-many" },
          labelMode: "open",
          syntax: "A }o--o{ B : links",
        },
      ],
    ],
  },
};

export const FAMILY_ORDER: readonly Family[] = ["flowchart", "sequence", "c4", "state", "er"];

/**
 * The source's lines past its preamble: YAML front matter at the very top, comments, and `%%{…}%%`
 * directives, including a directive whose JSON spans several lines (as the compiler accepts it).
 */
function meaningfulLines(source: string): string[] {
  const lines = source.split(/\r\n|\r|\n/u),
    out: string[] = [];
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && lines[i]!.trim() !== "---") i++;
    i++;
  }
  let directive = false;
  for (; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (directive) {
      const close = line.indexOf("}%%");
      if (close === -1) continue;
      directive = false;
      line = line.slice(close + 3).trim();
    }
    // A directive opening on this line: drop it, or everything up to where it closes.
    while (line.includes("%%{")) {
      const open = line.indexOf("%%{"),
        close = line.indexOf("}%%", open);
      if (close === -1) {
        directive = true;
        line = line.slice(0, open).trim();
        break;
      }
      line = (line.slice(0, open) + line.slice(close + 3)).trim();
    }
    if (line === "" || line.startsWith("%%")) continue;
    out.push(line);
  }
  return out;
}

/** The type a source declares in its header, when it is one the editor offers. */
export function familyOf(source: string): Family | null {
  const line = meaningfulLines(source)[0];
  if (line === undefined) return null;
  if (/^(?:flowchart|graph)\b/u.test(line)) return "flowchart";
  if (/^sequenceDiagram\b/u.test(line)) return "sequence";
  if (/^C4(?:Context|Container|Component)\b/u.test(line)) return "c4";
  if (/^stateDiagram(?:-v2)?\b/u.test(line)) return "state";
  if (/^erDiagram\b/u.test(line)) return "er";
  return null;
}

/** Whether a source holds anything beyond its type header, preamble and comments. */
export function hasContent(source: string): boolean {
  return meaningfulLines(source).length > 1;
}

function fresh(prefix: string, taken: ReadonlySet<string>): string {
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

function collect(source: string, pattern: RegExp): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(pattern)) if (match[1] && !found.includes(match[1])) found.push(match[1]);
  return found;
}

function words(source: string): Set<string> {
  return new Set(source.match(/[A-Za-z0-9_-]+/gu) ?? []);
}

function append(source: string, lines: readonly string[]): string {
  const newline = /\r\n|\r|\n/u.exec(source)?.[0] ?? "\n";
  const body = lines.map((line) => `    ${line}`).join(newline);
  const ended = source === "" || /[\r\n]$/u.test(source);
  return source + (ended ? "" : newline) + body + newline;
}

/** The source with one more part, written in the profile Archer accepts. */
export function insertPart(family: Exclude<Family, "flowchart" | "c4">, key: string, source: string): string {
  const taken = words(source);
  if (family === "sequence") {
    const people = collect(source, /^\s*(?:participant|actor)\s+([A-Za-z0-9_]+)/gmu);
    const lines: string[] = [];
    const need = (count: number): string[] => {
      const ids = [...people];
      while (ids.length < count) {
        const id = fresh("p", new Set([...taken, ...ids]));
        lines.push(`participant ${id} as Participant ${id.slice(1)}`);
        ids.push(id);
      }
      return ids;
    };
    if (key === "participant") {
      const id = fresh("p", taken);
      return append(source, [`participant ${id} as Participant ${id.slice(1)}`]);
    }
    if (key === "actor") {
      const id = fresh("a", taken);
      return append(source, [`actor ${id} as Actor ${id.slice(1)}`]);
    }
    if (key === "note") {
      const [a] = need(1);
      return append(source, [...lines, `Note over ${a}: Note`]);
    }
    const ids = need(2);
    const a = ids.at(-2)!,
      b = ids.at(-1)!;
    if (key === "message") return append(source, [...lines, `${a}->>${b}: Request`]);
    if (key === "reply") return append(source, [...lines, `${b}-->>${a}: Response`]);
    if (key === "async") return append(source, [...lines, `${a}-)${b}: Event`]);
    if (key === "loop") return append(source, [...lines, "loop Every minute", `    ${a}->>${b}: Poll`, "end"]);
    if (key === "alt")
      return append(source, [
        ...lines,
        "alt Succeeds",
        `    ${b}-->>${a}: Done`,
        "else Fails",
        `    ${b}-->>${a}: Error`,
        "end",
      ]);
  }
  if (family === "state") {
    const states = collect(source, /^\s*(?:state\s+"[^"]*"\s+as\s+|state\s+)?([A-Za-z0-9_]+)\s*(?::|$)/gmu).filter(
      (id) => id !== "state" && id !== "direction",
    );
    const lines: string[] = [];
    const need = (count: number): string[] => {
      const ids = [...states];
      while (ids.length < count) {
        const id = fresh("s", new Set([...taken, ...ids]));
        lines.push(`state "State ${id.slice(1)}" as ${id}`);
        ids.push(id);
      }
      return ids;
    };
    if (key === "state") {
      const id = fresh("s", taken);
      return append(source, [`state "State ${id.slice(1)}" as ${id}`]);
    }
    if (key === "start") {
      const [first] = need(1);
      return append(source, [...lines, `[*] --> ${first}`]);
    }
    if (key === "end") {
      const ids = need(1);
      return append(source, [...lines, `${ids.at(-1)} --> [*]`]);
    }
    if (key === "choice") {
      const ids = need(1);
      const id = fresh("choice", taken);
      return append(source, [...lines, `state ${id} <<choice>>`, `${ids.at(-1)} --> ${id}`]);
    }
    if (key === "transition") {
      const ids = need(2);
      const pairs = new Set(
        collect(source, /^\s*([A-Za-z0-9_]+\s*-->\s*[A-Za-z0-9_]+)/gmu).map((pair) => pair.replace(/\s/gu, "")),
      );
      for (let i = ids.length - 1; i > 0; i--)
        for (let j = i - 1; j >= 0; j--) {
          if (!pairs.has(`${ids[j]}-->${ids[i]}`)) return append(source, [...lines, `${ids[j]} --> ${ids[i]} : event`]);
        }
      const id = fresh("s", new Set([...taken, ...ids]));
      return append(source, [...lines, `state "State ${id.slice(1)}" as ${id}`, `${ids.at(-1)} --> ${id} : event`]);
    }
    if (key === "composite") {
      const id = fresh("Composite", taken),
        inner = fresh("s", taken);
      return append(source, [
        `state ${id} {`,
        `    state "State ${inner.slice(1)}" as ${inner}`,
        `    [*] --> ${inner}`,
        "}",
      ]);
    }
  }
  if (family === "er") {
    const entities = collect(source, /^\s*([A-Za-z0-9_-]+)\s*(?:\[[^\]]*\])?\s*\{?\s*$/gmu).filter(
      (id) => id !== "erDiagram" && id !== "}",
    );
    if (key === "entity") {
      const id = fresh("ENTITY_", taken);
      return append(source, [`${id}["Entity ${id.slice(7)}"] {`, "    int id PK", "}"]);
    }
    const marker = key === "one-one" ? "||--||" : key === "many-many" ? "}o--o{" : "||--o{";
    const label = key === "one-one" ? "is" : key === "many-many" ? "links" : "has";
    const lines: string[] = [];
    const ids = [...entities];
    while (ids.length < 2) {
      const id = fresh("ENTITY_", new Set([...taken, ...ids]));
      lines.push(`${id}["Entity ${id.slice(7)}"]`);
      ids.push(id);
    }
    const pairs = new Set(
      collect(source, /^\s*([A-Za-z0-9_-]+\s*[|}][|o](?:--|\.\.)[|o][|{]\s*[A-Za-z0-9_-]+)/gmu).map((pair) =>
        pair.replace(/\s*[|}][|o](?:--|\.\.)[|o][|{]\s*/u, "--"),
      ),
    );
    for (let i = ids.length - 1; i > 0; i--)
      for (let j = i - 1; j >= 0; j--) {
        if (!pairs.has(`${ids[j]}--${ids[i]}`) && !pairs.has(`${ids[i]}--${ids[j]}`))
          return append(source, [...lines, `${ids[j]} ${marker} ${ids[i]} : ${label}`]);
      }
    const id = fresh("ENTITY_", new Set([...taken, ...ids]));
    return append(source, [...lines, `${id}["Entity ${id.slice(7)}"]`, `${ids.at(-1)} ${marker} ${id} : ${label}`]);
  }
  return source;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * The source with one state's name changed (state diagrams have no structured editor yet).
 * Returns null when the element's declaration has a form this cannot rewrite safely.
 */
export function relabelInSource(family: Family, id: string, label: string, source: string): string | null {
  const name = label.replace(/["\r\n]/gu, " ").trim();
  if (name === "") return null;
  const key = escapeRegExp(id);
  if (family === "state") {
    const named = new RegExp(`^(\\s*state\\s+")([^"]*)("\\s+as\\s+${key}\\s*)$`, "mu");
    if (named.test(source))
      return source.replace(named, (_m, open: string, _old: string, close: string) => `${open}${name}${close}`);
    const colon = new RegExp(`^(\\s*${key}\\s*:\\s*)(.*)$`, "mu");
    if (colon.test(source)) return source.replace(colon, (_m, open: string) => `${open}${name.replace(/;/gu, "#59;")}`);
    const bare = new RegExp(`^(\\s*)state\\s+${key}\\s*$`, "mu");
    if (bare.test(source)) return source.replace(bare, (_m, indent: string) => `${indent}state "${name}" as ${id}`);
    return null;
  }
  return null;
}

/** Words Mermaid reads as keywords where an entity or state name stands. */
const RESERVED_IDS = new Set([
  "state",
  "direction",
  "note",
  "end",
  "as",
  "class",
  "classdef",
  "style",
  "click",
  "erdiagram",
  "statediagram",
  "default",
]);

/**
 * A readable ID for a new ER entity or state, made from the name typed for it (`Order line` → `OrderLine`),
 * so the saved source reads `OrderLine` rather than `ENTITY_1`. Taken IDs get a number (`OrderLine2`).
 * Null when the name gives nothing usable (no ASCII letters, a leading digit, a Mermaid keyword).
 */
export function readableId(label: string, taken: Iterable<string>): string | null {
  const words =
    label
      .normalize("NFKD")
      .replace(/[̀-ͯ]/gu, "")
      .match(/[A-Za-z0-9]+/gu) ?? [];
  const base = words
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("")
    .slice(0, 64);
  if (base === "" || /^[0-9]/u.test(base) || RESERVED_IDS.has(base.toLowerCase())) return null;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/**
 * A C4 relationship is drawn as `label [technology]`, and that is what its label field shows. Renaming it sets
 * the label only, so the shown technology is taken off what was typed (`Calls [HTTPS]` → `Calls`).
 */
export function withoutShownTechnology(typed: string, technology: string | undefined): string {
  if (!technology) return typed;
  const suffix = `[${technology}]`,
    text = typed.trimEnd();
  if (text === suffix) return "";
  return text.endsWith(` ${suffix}`) ? text.slice(0, -suffix.length).trimEnd() : typed;
}
