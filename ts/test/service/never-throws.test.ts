// The service's trust boundaries never throw: a selection body from anyone
// holding the link, an emphasis payload from an agent, and a management
// request line. Each is refused or valid, for arbitrary JSON, JSON built from
// the contract's own vocabulary, and valid input with small edits, from a
// fixed seed so a failure reproduces.
import { expect, test } from "vitest";
import type { DiagramEnvelope, GraphModel, SequenceTrace } from "../../src/model/index.ts";
import { addressable, parseEmphasis } from "../../src/service/emphasis.ts";
import { acceptSelection } from "../../src/service/selection-check.ts";
import { MethodError, parseRequest } from "../../src/service/socket.ts";
import {
  fieldMatches,
  matchCard,
  MAX_EXCERPT_CHARS,
  MAX_MATCHES_PER_RESULT,
  queryWords,
  SearchRefusal,
} from "../../src/service/front-door.ts";

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "id",
  "viewId",
  "groups",
  "title",
  "style",
  "palette",
  "state",
  "speed",
  "label",
  "description",
  "nodes",
  "edges",
  "flow",
  "highlight",
  "teal",
  "red",
  "existing",
  "proposed",
  "fast",
  "a",
  "b",
  "e1",
  "msg-0",
  "frag-0",
  "note-0",
  "schemaVersion",
  "revision",
  "presentationId",
  "reader:v",
  "reader:",
  "p1",
  "v",
  "method",
  "params",
  "root",
  "hello",
  "attach",
  "present",
  "getContext",
  "getModel",
  "setEmphasis",
  "emphases",
  "protocolVersion",
  "__proto__",
  "constructor",
  "",
  "x".repeat(300),
];

function value(next: () => number, depth = 0): unknown {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const roll = next();
  if (depth > 4 || roll < 0.3)
    return pick<unknown>([null, true, 0, -1, 1.5, Number.POSITIVE_INFINITY, "", pick(WORDS), [], {}]);
  if (roll < 0.55) return Array.from({ length: Math.floor(next() * 5) }, () => value(next, depth + 1));
  const object: Record<string, unknown> = {};
  for (let i = Math.floor(next() * 6); i > 0; i--) object[pick(WORDS)] = value(next, depth + 1);
  return object;
}

/** Valid input with one field replaced by something arbitrary, at any depth. */
function mutate(input: unknown, next: () => number): unknown {
  if (typeof input !== "object" || input === null) return value(next);
  const copy: Record<string, unknown> | unknown[] = Array.isArray(input)
    ? [...input]
    : { ...(input as Record<string, unknown>) };
  const keys = Object.keys(copy);
  const key = keys[Math.floor(next() * keys.length)];
  if (key === undefined) return value(next);
  const target = copy as Record<string, unknown>;
  target[key] = next() < 0.5 ? value(next) : mutate(target[key], next);
  return copy;
}

const GRAPH: GraphModel = {
  type: "freeform-graph",
  nodes: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
  edges: [{ id: "e1", source: "a", target: "b" }],
  groups: [],
};
const TRACE: SequenceTrace = {
  type: "sequence-trace",
  participants: [{ id: "a", label: "A" }],
  events: [
    { type: "message", id: "msg-0", from: "a", to: "a", kind: "sync", label: "x" },
    {
      type: "fragment",
      id: "frag-0",
      kind: "loop",
      label: "l",
      sections: [{ events: [{ type: "note", id: "note-0", position: "over", participants: ["a"], text: "n" }] }],
    },
  ],
};
const REV = `sha256:${"0".repeat(64)}` as const;
const ENVELOPE: DiagramEnvelope = {
  schemaVersion: 2,
  view: { id: "v", kind: "freeform", title: "v" },
  revision: REV,
  model: GRAPH,
};
const world = {
  presentation: { presentationId: "p1", viewId: "v", revision: REV, envelope: ENVELOPE },
  served: (id: string) => (id === "v" ? ENVELOPE : null),
};

const VALID_EMPHASIS = {
  id: "x",
  viewId: "v",
  groups: [{ id: "g", label: "g", style: "flow", nodes: ["a"], edges: ["e1"] }],
};
const VALID_SELECTION = {
  schemaVersion: 1,
  viewId: "v",
  revision: REV,
  presentationId: "p1",
  nodes: [{ id: "a" }],
  edges: [{ id: "e1" }],
};
const VALID_REQUEST = { id: 1, method: "setEmphasis", params: { root: "/r", viewId: "v", emphases: [VALID_EMPHASIS] } };

function inputs(seed: number, valid: unknown): unknown[] {
  const next = random(seed);
  return [...Array.from({ length: 400 }, () => value(next)), ...Array.from({ length: 400 }, () => mutate(valid, next))];
}

test("an emphasis payload is refused or valid", () => {
  for (const model of [GRAPH, TRACE]) {
    const known = addressable(model);
    for (const raw of inputs(1, VALID_EMPHASIS)) {
      const result = parseEmphasis(raw, "v", known);
      if (result.ok) expect(result.emphasis.viewId).toBe("v");
      else expect(result.issues.length, JSON.stringify(raw)).toBeGreaterThan(0);
    }
  }
});

test("a selection body is refused or stored as the model's own elements", () => {
  for (const raw of inputs(2, VALID_SELECTION)) {
    const result = acceptSelection(raw, world);
    if (result.ok) for (const node of result.selection.nodes) expect(["a", "b"]).toContain(node.id);
    else expect([409, 422]).toContain(result.status);
  }
});

test("a management request is parsed or refused with a MethodError", () => {
  for (const raw of inputs(3, VALID_REQUEST)) {
    try {
      parseRequest(raw);
    } catch (error) {
      expect(error, JSON.stringify(raw)).toBeInstanceOf(MethodError);
    }
  }
});

test("a recordWrite request is parsed or refused with a MethodError", () => {
  for (const raw of inputs(4, {
    id: 2,
    method: "recordWrite",
    params: { root: "/r", viewId: "v", summary: "merged a into b" },
  })) {
    try {
      parseRequest(raw);
    } catch (error) {
      expect(error, JSON.stringify(raw)).toBeInstanceOf(MethodError);
    }
  }
});

test("a search query is read as words or refused with a SearchRefusal, and matching never throws", () => {
  const next = random(5);
  const alphabet = ["a", "A", " ", "\t", "\n", "é", "ß", "İ", "😀", "\u0000", "​", "%", "*", "(", "\\"];
  for (let i = 0; i < 2000; i++) {
    const length = Math.floor(next() * 260);
    const raw = Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
    let words: string[];
    try {
      words = queryWords(raw);
    } catch (error) {
      expect(error, JSON.stringify(raw)).toBeInstanceOf(SearchRefusal);
      continue;
    }
    expect(words.length).toBeGreaterThan(0);
    expect(matchCard(words, { title: [raw], diagram: ["flowchart LR"] }), JSON.stringify(raw)).toContain("title");
    // The match fields: bounded, short, and the title among them.
    const { matches } = fieldMatches(
      words,
      [
        { field: "title", texts: [raw] },
        { field: "comment", texts: [raw.repeat(3)], threadId: "t" },
      ],
      `${raw}\n${raw}`,
    );
    expect(matches.length, JSON.stringify(raw)).toBeLessThanOrEqual(MAX_MATCHES_PER_RESULT);
    expect(matches[0]?.field, JSON.stringify(raw)).toBe("title");
    for (const m of matches) expect([...m.text].length, JSON.stringify(raw)).toBeLessThanOrEqual(MAX_EXCERPT_CHARS + 2);
  }
});

test.each([
  { id: 3, method: "getContext", params: { root: "/r" } },
  { id: 4, method: "getModel", params: { root: "/r", viewId: "v" } },
])("shared-state snapshot $method is parsed or refused with a MethodError", (valid) => {
  for (const raw of inputs(6, valid)) {
    try {
      parseRequest(raw);
    } catch (error) {
      expect(error, JSON.stringify(raw)).toBeInstanceOf(MethodError);
    }
  }
});
