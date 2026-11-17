// Splits one flowchart statement line into tokens, with their offsets, so the
// profile can say where something is. Mermaid remains the parser of record:
// a line this lexer cannot read is left to Mermaid (`opaque`) rather than
// refused, so the lexer never rejects Mermaid that is in the profile.

export type Token =
  | { kind: "id"; text: string; start: number; end: number }
  /** `e1@`: the ID of the edge whose link follows. */
  | { kind: "edge-id"; text: string; start: number; end: number }
  | {
      kind: "shape";
      opener: string;
      closer: string;
      /** The label as written between the delimiters, quotes included. */
      raw: string;
      quoted: boolean;
      start: number;
      end: number;
      labelStart: number;
      labelEnd: number;
    }
  | { kind: "class"; name: string; start: number; end: number }
  | { kind: "link"; op: string; start: number; end: number }
  /** `-- text -->`: link text written inside the link rather than between pipes. */
  | { kind: "text-link"; text: string; op: string; start: number; end: number }
  | { kind: "pipe"; raw: string; quoted: boolean; start: number; end: number }
  | { kind: "amp" | "semi" | "comment" | "metadata"; start: number; end: number };

export type ShapeToken = Extract<Token, { kind: "shape" }>;

export type LexResult = { tokens: Token[]; opaque: false } | { tokens: Token[]; opaque: true; at: number };

/** Shape openers, longest first, and what closes each. */
export const SHAPES: readonly (readonly [string, string])[] = [
  ["(((", ")))"],
  ["((", "))"],
  ["([", "])"],
  ["(", ")"],
  ["[[", "]]"],
  ["[(", ")]"],
  ["[/", "/]"],
  ["[\\", "\\]"],
  ["[", "]"],
  ["{{", "}}"],
  ["{", "}"],
  [">", "]"],
];

const ID_STOP = /[\s[\](){}<>|&;"@:,`%=~]/;
const LINK = /^<?(?:-{2,}|-\.+-|={2,}|~{3,})[>xo]?/;
// Mermaid opens link text with `--`, `==` or `-.` that does not go on to make a whole link (`-->`, `--x`, `===`, `-.-`),
// spaces or not, and two-way (`<-- text -->`): `a--text-->b` is one edge labelled "text", not `a --> text --> b`.
const TEXT_LINK_START = /^<?(?:--(?![-xo>])|==(?![=xo>])|-\.(?![.-]))/;
const TEXT_LINK_END = /-{2,}>|={2,}>|\.+->|-{3,}|={3,}|\.+-/;

function startsLink(text: string, at: number): boolean {
  const two = text.slice(at, at + 2);
  return (
    two === "--" ||
    two === "-." ||
    two === "==" ||
    two === "~~" ||
    (text[at] === "<" && /^<[-=]/.test(text.slice(at, at + 2)))
  );
}

/** The offset just past an ID starting at `at`; `at` itself when there is none. */
export function readId(text: string, at: number): number {
  let end = at;
  while (end < text.length && !ID_STOP.test(text[end] ?? "") && !startsLink(text, end)) end += 1;
  return end;
}

/** The offset just past the closer of an unquoted label opened at `at`, balancing nested delimiters. */
function closeUnquoted(text: string, at: number, opener: string, closer: string): number | undefined {
  const open = opener.at(-1);
  const close = closer[0];
  let depth = 0;
  for (let index = at; index < text.length; index += 1) {
    if (depth === 0 && text.startsWith(closer, index)) return index;
    const character = text[index];
    if (character === open && open !== close) depth += 1;
    else if (character === close && depth > 0) depth -= 1;
  }
  return undefined;
}

export function readShape(text: string, at: number): ShapeToken | undefined {
  const shape = SHAPES.find(([opener]) => text.startsWith(opener, at));
  if (!shape) return undefined;
  const [opener, closer] = shape;
  const labelStart = at + opener.length;
  const firstNonBlank = labelStart + (text.slice(labelStart).length - text.slice(labelStart).trimStart().length);
  if (text[firstNonBlank] === '"') {
    const closingQuote = text.indexOf('"', firstNonBlank + 1);
    if (closingQuote === -1) return undefined;
    const afterQuote = closingQuote + 1;
    const closeAt = afterQuote + (text.slice(afterQuote).length - text.slice(afterQuote).trimStart().length);
    if (!text.startsWith(closer, closeAt)) return undefined;
    return {
      kind: "shape",
      opener,
      closer,
      raw: text.slice(labelStart, closeAt),
      quoted: true,
      start: at,
      end: closeAt + closer.length,
      labelStart,
      labelEnd: closeAt,
    };
  }
  const labelEnd = closeUnquoted(text, labelStart, opener, closer);
  if (labelEnd === undefined) return undefined;
  return {
    kind: "shape",
    opener,
    closer,
    raw: text.slice(labelStart, labelEnd),
    quoted: false,
    start: at,
    end: labelEnd + closer.length,
    labelStart,
    labelEnd,
  };
}

function readPipe(text: string, at: number): Token | undefined {
  const inner = at + 1;
  const firstNonBlank = inner + (text.slice(inner).length - text.slice(inner).trimStart().length);
  if (text[firstNonBlank] === '"') {
    const closingQuote = text.indexOf('"', firstNonBlank + 1);
    if (closingQuote === -1) return undefined;
    const pipe = text.indexOf("|", closingQuote + 1);
    if (pipe === -1 || text.slice(closingQuote + 1, pipe).trim() !== "") return undefined;
    return { kind: "pipe", raw: text.slice(inner, pipe), quoted: true, start: at, end: pipe + 1 };
  }
  const pipe = text.indexOf("|", inner);
  if (pipe === -1) return undefined;
  return { kind: "pipe", raw: text.slice(inner, pipe), quoted: false, start: at, end: pipe + 1 };
}

function readTextLink(text: string, at: number): Token | undefined {
  const start = TEXT_LINK_START.exec(text.slice(at));
  if (!start) return undefined;
  const after = at + start[0].length;
  const end = TEXT_LINK_END.exec(text.slice(after));
  if (!end) return undefined;
  const endAt = after + end.index;
  return {
    kind: "text-link",
    text: text.slice(after, endAt).trim(),
    op: start[0] + end[0],
    start: at,
    end: endAt + end[0].length,
  };
}

/** Skip a `@{ ... }` metadata block opened at `at`, balancing braces. */
function closeMetadata(text: string, at: number): number {
  let depth = 0;
  for (let index = at; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}

export function lexStatement(text: string): LexResult {
  const tokens: Token[] = [];
  let at = 0;
  const opaque = (): LexResult => ({ tokens, opaque: true, at });
  while (at < text.length) {
    const character = text[at] ?? "";
    if (/\s/.test(character)) {
      at += 1;
      continue;
    }
    if (text.startsWith("%%", at)) {
      tokens.push({ kind: "comment", start: at, end: text.length });
      break;
    }
    if (character === "&" || character === ";") {
      tokens.push({ kind: character === "&" ? "amp" : "semi", start: at, end: at + 1 });
      at += 1;
      continue;
    }
    if (text.startsWith(":::", at)) {
      const nameEnd = readId(text, at + 3);
      if (nameEnd === at + 3) return opaque();
      tokens.push({ kind: "class", name: text.slice(at + 3, nameEnd), start: at, end: nameEnd });
      at = nameEnd;
      continue;
    }
    if (character === "|") {
      const pipe = readPipe(text, at);
      if (!pipe) return opaque();
      tokens.push(pipe);
      at = pipe.end;
      continue;
    }
    const previous = tokens.at(-1);
    const afterNode = previous !== undefined && previous.kind === "id" && previous.end === at;
    if (afterNode) {
      const shape = readShape(text, at);
      if (shape) {
        tokens.push(shape);
        at = shape.end;
        continue;
      }
    }
    const textLink = readTextLink(text, at);
    if (textLink) {
      tokens.push(textLink);
      at = textLink.end;
      continue;
    }
    const link = LINK.exec(text.slice(at));
    if (link) {
      tokens.push({ kind: "link", op: link[0], start: at, end: at + link[0].length });
      at += link[0].length;
      continue;
    }
    const idEnd = readId(text, at);
    if (idEnd === at) return opaque();
    if (text[idEnd] === "@") {
      if (text[idEnd + 1] === "{") {
        const end = closeMetadata(text, idEnd + 1);
        tokens.push({ kind: "id", text: text.slice(at, idEnd), start: at, end: idEnd });
        tokens.push({ kind: "metadata", start: idEnd, end });
        at = end;
        continue;
      }
      tokens.push({ kind: "edge-id", text: text.slice(at, idEnd), start: at, end: idEnd + 1 });
      at = idEnd + 1;
      continue;
    }
    tokens.push({ kind: "id", text: text.slice(at, idEnd), start: at, end: idEnd });
    at = idEnd;
  }
  return { tokens, opaque: false };
}
