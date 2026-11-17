/**
 * Colouring for Mermaid source: a line tokenizer, not a parser.
 *
 * Archer's compiler on the server is the one reader of Mermaid (it reports the problems); this only
 * names the pieces a person scans for, so a mistake is easier to see: the header and each family's
 * keywords, arrows, IDs, labels, `%%` comments and Archer's own `%% archer-id:` directives. A line it
 * does not understand still colours as IDs and text; nothing here refuses anything.
 */
import type { StreamParser, StringStream } from "@codemirror/language";

export type MermaidFamily =
  | "flowchart"
  | "sequence"
  | "state"
  | "er"
  | "c4"
  | "architecture"
  | "journey"
  | "class"
  | "other";

export interface MermaidState {
  family: MermaidFamily | null;
  /** Closing characters of the labels open at this point, innermost last (`[(`…`)]`). */
  closers: string[];
  /** The rest of the line is text: after `:` in a message, a transition, a task, a relationship. */
  restIsText: boolean;
  /** Inside a `"…"` that a line break did not close (a multi-line label). */
  inString: boolean;
  /** Just after the `--` of `a -- text --> b`: the text up to the arrow is the link's label. */
  linkText: boolean;
}

const HEADERS: ReadonlyArray<readonly [RegExp, MermaidFamily]> = [
  [/^(?:flowchart|graph)\b/u, "flowchart"],
  [/^sequenceDiagram\b/u, "sequence"],
  [/^stateDiagram(?:-v2)?\b/u, "state"],
  [/^erDiagram\b/u, "er"],
  [/^C4(?:Context|Container|Component|Dynamic|Deployment)\b/u, "c4"],
  [/^architecture(?:-beta)?\b/u, "architecture"],
  [/^journey\b/u, "journey"],
  [/^classDiagram(?:-v2)?\b/u, "class"],
  [
    /^(?:gantt|pie|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|xychart-beta|sankey-beta|block-beta|packet-beta|kanban|radar-beta)\b/u,
    "other",
  ],
];

const KEYWORDS: Readonly<Record<MermaidFamily, ReadonlySet<string>>> = {
  flowchart: new Set([
    "subgraph",
    "end",
    "direction",
    "classDef",
    "class",
    "style",
    "linkStyle",
    "click",
    "call",
    "href",
    "default",
    "TB",
    "TD",
    "BT",
    "RL",
    "LR",
  ]),
  sequence: new Set([
    "participant",
    "actor",
    "as",
    "autonumber",
    "activate",
    "deactivate",
    "Note",
    "note",
    "over",
    "left",
    "right",
    "of",
    "loop",
    "alt",
    "else",
    "opt",
    "par",
    "and",
    "critical",
    "option",
    "break",
    "rect",
    "end",
    "box",
    "create",
    "destroy",
    "title",
    "links",
    "link",
    "off",
  ]),
  state: new Set([
    "state",
    "as",
    "note",
    "end",
    "direction",
    "classDef",
    "class",
    "style",
    "left",
    "right",
    "of",
    "TB",
    "TD",
    "BT",
    "RL",
    "LR",
  ]),
  er: new Set(["title", "direction", "PK", "FK", "UK", "classDef", "class", "style", "TB", "TD", "BT", "RL", "LR"]),
  c4: new Set([
    "title",
    "Person",
    "Person_Ext",
    "System",
    "System_Ext",
    "SystemDb",
    "SystemDb_Ext",
    "SystemQueue",
    "SystemQueue_Ext",
    "Container",
    "Container_Ext",
    "ContainerDb",
    "ContainerDb_Ext",
    "ContainerQueue",
    "ContainerQueue_Ext",
    "Component",
    "Component_Ext",
    "ComponentDb",
    "ComponentDb_Ext",
    "ComponentQueue",
    "ComponentQueue_Ext",
    "Boundary",
    "Enterprise_Boundary",
    "System_Boundary",
    "Container_Boundary",
    "Deployment_Node",
    "Node",
    "Node_L",
    "Node_R",
    "Rel",
    "BiRel",
    "Rel_U",
    "Rel_Up",
    "Rel_D",
    "Rel_Down",
    "Rel_L",
    "Rel_Left",
    "Rel_R",
    "Rel_Right",
    "Rel_Back",
    "RelIndex",
    "UpdateElementStyle",
    "UpdateRelStyle",
    "UpdateBoundaryStyle",
    "UpdateLayoutConfig",
  ]),
  architecture: new Set(["group", "service", "junction", "in", "title"]),
  journey: new Set(["title", "section"]),
  class: new Set([
    "class",
    "namespace",
    "direction",
    "note",
    "for",
    "classDef",
    "style",
    "cssClass",
    "link",
    "click",
    "callback",
    "TB",
    "TD",
    "BT",
    "RL",
    "LR",
  ]),
  other: new Set(["title", "section", "dateFormat", "axisFormat", "excludes", "includes", "todayMarker", "showData"]),
};

const ARROW_ER = /^[|}][|o](?:--|\.\.)[|o][|{]/u;
// Sequence arrows (`->>`, `-->>`, `-x`, `--)`, `<<->>`) and flowchart/state/architecture links
// (`-->`, `---`, `-.->`, `==>`, `--o`, `--x`, `<-->`, `~~~`), with an optional head on either end.
const ARROW = /^(?:<<|<|[xo](?=[-=.]))?(?:-[-.]*-|=[=]+|-\.+-?|~{3,}|-)(?:>>|[>)]|[xo](?![\w])|\+|-)?/u;
const LINK_TEXT = /^[^|]+?(?=\s*(?:-->|---|-\.->|-\.-|==>|===|--x|--o))/u;
const LINK_TEXT_AHEAD = /^\s+[^|\s][^|]*?\s*(?:-->|---|-\.->|-\.-|==>|===|--x|--o)/u;
const DIRECTIVE = /^%%\s*(?:archer-id|description)\s*:/u;

function startState(): MermaidState {
  return { family: null, closers: [], restIsText: false, inString: false, linkText: false };
}

function copyState(state: MermaidState): MermaidState {
  return {
    family: state.family,
    closers: [...state.closers],
    restIsText: state.restIsText,
    inString: state.inString,
    linkText: state.linkText,
  };
}

/** Whether `(`, `[`, `{` and `>` open a label in this family (they are arguments in C4). */
function bracketsAreLabels(family: MermaidFamily | null): boolean {
  return family === "flowchart" || family === "architecture" || family === "state" || family === "class";
}

const OPENERS: Readonly<Record<string, string>> = { "[": "]", "(": ")", "{": "}" };

/** The characters that close an opening run: `[(` closes with `)]`, `[/` with `/]`, `>` with `]`. */
function closingRun(open: string): string {
  if (open === ">") return "]";
  return [...open]
    .reverse()
    .map((c) => OPENERS[c] ?? c)
    .join("");
}

function escapeClass(ch: string): string {
  return /[\\\]^-]/u.test(ch) ? `\\${ch}` : ch;
}

function token(stream: StringStream, state: MermaidState): string | null {
  if (stream.sol()) {
    state.restIsText = false;
    state.linkText = false;
    // A label's brackets close on their line, unless a quote inside it runs on to the next.
    if (!state.inString) state.closers = [];
  }
  if (state.inString) {
    if (stream.skipTo('"')) {
      stream.next();
      state.inString = false;
    } else stream.skipToEnd();
    return "string";
  }
  if (stream.eatSpace()) return null;
  if (state.linkText) {
    state.linkText = false;
    if (stream.match(LINK_TEXT)) return "string";
  }

  if (stream.match("%%{")) {
    stream.skipTo("}%%") ? stream.match("}%%") : stream.skipToEnd();
    return "meta";
  }
  if (stream.match(DIRECTIVE, false)) {
    stream.skipToEnd();
    return "meta";
  }
  if (stream.match("%%")) {
    stream.skipToEnd();
    return "comment";
  }

  if (state.family === null) {
    for (const [pattern, family] of HEADERS) {
      if (stream.match(pattern)) {
        state.family = family;
        return "heading";
      }
    }
  }

  if (stream.peek() === '"') {
    stream.next();
    if (stream.skipTo('"')) stream.next();
    else {
      stream.skipToEnd();
      state.inString = true;
    }
    return "string";
  }
  if (state.restIsText) {
    // Up to the next quote or comment, so those still colour on their own.
    if (!stream.match(/^[^"%]+/u)) stream.next();
    return "string";
  }
  if (state.closers.length > 0) {
    const closer = state.closers[state.closers.length - 1];
    if (stream.match(closer)) {
      state.closers.pop();
      return "bracket";
    }
    // Text up to the closer's first character or a quote; a lone one of those is text too.
    if (!stream.match(new RegExp(`^[^"${escapeClass(closer[0])}]+`, "u"))) stream.next();
    return "string";
  }

  const family = state.family;
  if (family === "er" && stream.match(ARROW_ER)) return "operator";
  if (family === "state" && stream.match("[*]")) return "atom";
  if (stream.match(/^<<\w+>>/u)) return "typeName";
  if (stream.match(":::")) {
    stream.match(/^[\w-]+/u);
    return "typeName";
  }
  if (stream.match(ARROW)) {
    // `-- text -->`: the text between the two halves of a flowchart link.
    if (
      family === "flowchart" &&
      /^(?:--|==|-\.)$/u.test(stream.current()) &&
      stream.match(/^\s*/u, false) &&
      LINK_TEXT_AHEAD.test(stream.string.slice(stream.pos))
    )
      state.linkText = true;
    return "operator";
  }
  if (family === "flowchart" && stream.eat("|")) {
    state.closers.push("|");
    return "bracket";
  }
  const ch = stream.peek() ?? "";
  // A shape's opening run (`[`, `([`, `[(`, `((`, `{{`, `[/`, `>`) and the run that closes it.
  if (bracketsAreLabels(family) && (OPENERS[ch] || (family === "flowchart" && ch === ">"))) {
    const run = stream.match(/^(?:>|[[({]{1,3}[/\\]?)/u) as RegExpMatchArray;
    state.closers.push(closingRun(run[0]));
    return "bracket";
  }
  if (ch === ":") {
    stream.next();
    // `a:R --> L:b` names a side in architecture; elsewhere `:` starts the line's text.
    if (family !== "architecture" && family !== "c4") state.restIsText = true;
    return "punctuation";
  }
  if (stream.match(/^\d+(?:\.\d+)?\b/u)) return "number";
  // A hyphen stays inside an ID (`api-gateway`) unless it starts an arrow (`A-->B`, `A-xB` aside).
  if (stream.match(/^[A-Za-z_]\w*(?:-(?![-.=>)x])\w+)*/u)) {
    const word = stream.current();
    // An edge id (`e1@-->`) is an ID; a keyword is one only where the family has it.
    if (stream.peek() === "@") return "labelName";
    if (family !== null && KEYWORDS[family].has(word)) return "keyword";
    return "variableName";
  }
  if (stream.match(/^[,;@&()[\]{}]/u)) return "punctuation";
  stream.next();
  return null;
}

/** The StreamLanguage parser for Mermaid source (pure: exercised directly in tests). */
export const mermaidStreamParser: StreamParser<MermaidState> = {
  name: "mermaid",
  startState,
  copyState,
  token,
  blankLine(state) {
    state.restIsText = false;
    state.closers = [];
  },
  languageData: { commentTokens: { line: "%%" } },
};
