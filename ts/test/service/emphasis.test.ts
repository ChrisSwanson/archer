// The set_emphasis contract (ADR 0005), as the service checks it: every
// problem in one refusal, nothing published unless everything resolves, and a
// recompile that drops what no longer exists.
import { describe, expect, test } from "vitest";
import type { DiagramModel, GraphModel, SequenceTrace } from "../../src/model/index.ts";
import {
  addressable,
  EmphasisStore,
  MAX_EMPHASES_PER_VIEW,
  parseEmphasis,
  type Issue,
} from "../../src/service/emphasis.ts";

const GRAPH: GraphModel = {
  type: "freeform-graph",
  nodes: [
    { id: "web", label: "Web" },
    { id: "api", label: "API" },
    { id: "db", label: "DB" },
  ],
  edges: [
    { id: "e1", source: "web", target: "api" },
    { id: "e2", source: "api", target: "db" },
  ],
  groups: [],
};

const TRACE = (labels: string[]): SequenceTrace => ({
  type: "sequence-trace",
  participants: [
    { id: "A", label: "Alice" },
    { id: "B", label: "Bob" },
  ],
  events: [
    ...labels.map((label, index) => ({
      type: "message" as const,
      id: `msg-${index}`,
      from: "A",
      to: "B",
      label,
      kind: "sync" as const,
    })),
    { type: "fragment", id: "frag-0", kind: "loop", label: "retry", sections: [{ events: [] }] },
    { type: "note", id: "note-0", position: "over", participants: ["A"], text: "n" },
  ],
});

const group = (extra: Record<string, unknown> = {}) => ({
  id: "g",
  label: "g",
  style: "highlight",
  nodes: ["web"],
  ...extra,
});
const payload = (groups: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "x",
  viewId: "v",
  groups,
  ...extra,
});

function issues(raw: unknown, model: DiagramModel = GRAPH): Issue[] {
  const result = parseEmphasis(raw, "v", addressable(model));
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.emphasis)}`);
  return result.issues;
}

describe("parseEmphasis", () => {
  test("a valid highlight resolves to the wire shape the page reads", () => {
    const result = parseEmphasis(payload([group({ label: "Front" })], { title: "Path" }), "v", addressable(GRAPH));
    expect(result).toEqual({
      ok: true,
      emphasis: {
        id: "x",
        viewId: "v",
        title: "Path",
        groups: [
          {
            id: "g",
            style: "highlight",
            palette: "teal",
            state: "existing",
            label: "Front",
            nodes: ["web"],
            edges: [],
          },
        ],
      },
    });
  });

  test("a flow group gets the normal speed when none is named", () => {
    const result = parseEmphasis(
      payload([group({ style: "flow", edges: ["e1"], nodes: [] })]),
      "v",
      addressable(GRAPH),
    );
    expect(result.ok && result.emphasis.groups[0]?.speed).toBe("normal");
  });

  test("the viewId may be left out, since the request names the view", () => {
    const result = parseEmphasis({ id: "x", groups: [group()] }, "v", addressable(GRAPH));
    expect(result.ok).toBe(true);
  });

  test("an empty group list is a clear", () => {
    const result = parseEmphasis(payload([]), "v", addressable(GRAPH));
    expect(result).toMatchObject({ ok: true, emphasis: { groups: [] } });
  });

  test("every problem is reported at once: a palette and a misspelled node", () => {
    const found = issues(payload([group({ palette: "red", nodes: ["wbe"] })]));
    expect(found.map((i) => i.problem)).toEqual([
      "sets palette, which an emphasis no longer accepts",
      'no node "wbe" in this diagram',
    ]);
    expect(found[0]?.fix).toContain("Colours follow group order (1 teal, 2 violet, 3 coral)");
    expect(found[1]?.fix).toBe('Did you mean "web"?');
  });

  test("colours follow group order, whatever the agent might have meant", () => {
    const result = parseEmphasis(
      payload(["web", "api", "db"].map((node, i) => group({ id: `g${i}`, label: `Group ${i}`, nodes: [node] }))),
      "v",
      addressable(GRAPH),
    );
    expect(result.ok && result.emphasis.groups.map((g) => [g.palette, g.state])).toEqual([
      ["teal", "existing"],
      ["violet", "existing"],
      ["coral", "existing"],
    ]);
  });

  test.each<[string, Record<string, unknown>, string]>([
    ["palette", { palette: "teal" }, "Remove `palette`"],
    ["an amber palette", { palette: "amber" }, "Remove `palette`"],
    ["state existing", { state: "existing" }, "Remove `state`"],
    ["state proposed", { state: "proposed" }, 'Proposed is said in the label, e.g. "Refund queue (proposed)"'],
  ])("refuses a withdrawn field: %s", (_name, extra, fix) => {
    const found = issues(payload([group(extra)]));
    expect(found).toHaveLength(1);
    expect(found[0]?.fix).toContain(fix);
  });

  test.each<[string, Record<string, unknown>, string]>([
    ["a label of 5 words", { label: "one two three four five" }, "has a label of 5 words, more than the limit of 4"],
    ["a label of 33 characters", { label: "x".repeat(33) }, "has a label of 33 characters, more than the limit of 32"],
    ["an empty label", { label: " " }, "has an empty label"],
    [
      "a description of 91 characters",
      { description: "x".repeat(91) },
      "has a description of 91 characters, more than the limit of 90",
    ],
    [
      "two sentences",
      { description: "Takes refunds off the path. Then mails." },
      "has a description of more than one sentence",
    ],
  ])("refuses legend text: %s", (_name, extra, problem) => {
    expect(issues(payload([group(extra)])).map((i) => i.problem)).toEqual([problem]);
  });

  test.each<[string, Record<string, unknown>]>([
    ["a label of 4 words and 32 characters", { label: "Refund queue path (proposed)xxxx" }],
    ["a one-sentence description of 90 characters", { description: `${"x".repeat(89)}.` }],
    ["a question as one sentence", { description: "Why does checkout wait on the bank?" }],
  ])("accepts legend text at the limit: %s", (_name, extra) => {
    expect(parseEmphasis(payload([group(extra)]), "v", addressable(GRAPH)).ok).toBe(true);
  });

  test("a title is 5 words and 40 characters at most", () => {
    expect(issues(payload([group()], { title: "one two three four five six" })).map((i) => i.problem)).toEqual([
      "has a title of 6 words, more than the limit of 5",
    ]);
    expect(parseEmphasis(payload([group()], { title: "Checkout and refunds today" }), "v", addressable(GRAPH)).ok).toBe(
      true,
    );
  });

  test("a group needs a label", () => {
    const found = issues(payload([{ id: "g", style: "highlight", nodes: ["web"] }]));
    expect(found.map((i) => i.problem)).toEqual(["has no label"]);
  });

  test("three groups are accepted and a fourth is refused with the priority fix", () => {
    const three = payload(["web", "api", "db"].map((node, i) => group({ id: `g${i}`, nodes: [node] })));
    expect(parseEmphasis(three, "v", addressable(GRAPH)).ok).toBe(true);
    const four = issues(payload(Array.from({ length: 4 }, (_, i) => group({ id: `g${i}` }))));
    expect(four[0]).toMatchObject({
      problem: "has 4 groups, more than the limit of 3",
      fix: expect.stringContaining("Order groups by priority"),
    });
  });

  test.each<[string, unknown, string]>([
    ["a payload that is not an object", 3, "is a number, not an object"],
    ["a missing id", { viewId: "v", groups: [] }, "is missing"],
    ["groups that are not an array", payload("g" as unknown as unknown[]), "is a string, not an array"],
    ["an unknown field", payload([], { colour: "red" }), 'has an unknown field "colour"'],
    ["a view that is not the request's", payload([], { viewId: "other" }), 'names view "other"'],
    ["a group with no id", payload([group({ id: "" })]), "has no id"],
    ["a repeated group id", payload([group(), group()]), "repeats an id used earlier in this call"],
    ["a speed on a highlight", payload([group({ speed: "fast" })]), "sets a speed on a highlight group"],
    ["a group naming nothing", payload([group({ nodes: [] })]), "names neither a node nor an edge"],
    ["an edge listed as a node", payload([group({ nodes: ["e1"] })]), 'lists "e1" under `nodes`, but it is a edge'],
    [
      "too many groups",
      payload(Array.from({ length: 7 }, (_, i) => group({ id: `g${i}` }))),
      "has 7 groups, more than the limit of 3",
    ],
    [
      "too many ids",
      payload([group({ nodes: Array.from({ length: 65 }, () => "web") })]),
      "has 65 nodes, more than the limit of 64",
    ],
    [
      "an over-long label",
      payload([group({ label: "x".repeat(241) })]),
      "has a label of 241 characters, more than the limit of 32",
    ],
  ])("refuses %s", (_name, raw, problem) => {
    expect(issues(raw).map((i) => i.problem)).toContainEqual(expect.stringContaining(problem));
  });

  test("on a sequence, fragments and notes are named as such, and the words are participant and message", () => {
    const found = issues(payload([group({ nodes: ["C"], edges: ["frag-0", "note-0", "msg-9"] })]), TRACE(["hi"]));
    expect(found.map((i) => i.problem)).toEqual([
      'no participant "C" in this diagram',
      'names "frag-0", which is a fragment and cannot be emphasised',
      'names "note-0", which is a note and cannot be emphasised',
      'no message "msg-9" in this diagram',
    ]);
  });
});

describe("a stored emphasis", () => {
  const stored = (groups: Record<string, unknown>[]) => [
    { viewId: "v", named: [{ emphasis: { id: "old", viewId: "v", groups }, anchors: [] }] },
  ];
  const models = new Map([["v", addressable(GRAPH)]]);

  test("restores: its wire palette and state are ignored and colours follow order", () => {
    const store = new EmphasisStore();
    store.restore(
      stored([{ id: "a", style: "highlight", palette: "violet", state: "existing", label: "Web", nodes: ["web"] }]),
      models,
    );
    expect(store.payload("v").emphases[0]?.groups[0]).toMatchObject({
      palette: "teal",
      state: "existing",
      label: "Web",
    });
  });

  test.each([
    [
      "more than three groups",
      Array.from({ length: 4 }, (_, i) => ({ id: `g${i}`, style: "highlight", label: `G${i}`, nodes: ["web"] })),
    ],
    [
      "a label a call would refuse",
      [{ id: "a", style: "highlight", label: "a label far longer than four words allows", nodes: ["web"] }],
    ],
  ])("with %s is refused, not drawn in part", (_name, groups) => {
    expect(() => new EmphasisStore().restore(stored(groups), models)).toThrow();
  });
});

describe("EmphasisStore", () => {
  const resolved = (id: string, nodes: string[], model: DiagramModel = GRAPH) => {
    const result = parseEmphasis(
      payload(nodes.length === 0 ? [] : [group({ nodes })], { id }),
      "v",
      addressable(model),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    return result.emphasis;
  };

  test("a repeat id replaces in place, a clear removes, and the oldest goes past the limit", () => {
    const store = new EmphasisStore();
    store.apply(resolved("a", ["web"]), addressable(GRAPH));
    store.apply(resolved("b", ["api"]), addressable(GRAPH));
    store.apply(resolved("a", ["db"]), addressable(GRAPH));
    expect(store.payload("v").emphases.map((e) => [e.id, e.groups[0]?.nodes])).toEqual([
      ["a", ["db"]],
      ["b", ["api"]],
    ]);
    store.apply(resolved("a", []), addressable(GRAPH));
    expect(store.payload("v").emphases.map((e) => e.id)).toEqual(["b"]);
    for (let i = 0; i < MAX_EMPHASES_PER_VIEW; i++) store.apply(resolved(`n${i}`, ["web"]), addressable(GRAPH));
    expect(store.payload("v").emphases.map((e) => e.id)).toEqual(Array.from({ length: 8 }, (_, i) => `n${i}`));
  });

  test("a view nobody emphasised has an empty list", () => {
    expect(new EmphasisStore().payload("nothing")).toEqual({ schemaVersion: 1, viewId: "nothing", emphases: [] });
  });

  test("a recompile drops ids that are gone, and groups and emphases left empty", () => {
    const store = new EmphasisStore();
    store.apply(resolved("a", ["web", "api"]), addressable(GRAPH));
    store.apply(resolved("b", ["db"]), addressable(GRAPH));
    const smaller: GraphModel = { ...GRAPH, nodes: GRAPH.nodes.filter((n) => n.id !== "db" && n.id !== "web") };
    expect(store.revalidate("v", addressable(smaller))).toBe(true);
    expect(store.payload("v").emphases).toEqual([
      expect.objectContaining({ id: "a", groups: [expect.objectContaining({ nodes: ["api"] })] }),
    ]);
    expect(store.revalidate("v", addressable(smaller))).toBe(false);
  });

  test("a message id follows its message when one is inserted above it, and is dropped when it is edited", () => {
    const store = new EmphasisStore();
    const before = TRACE(["first", "second"]);
    const result = parseEmphasis(payload([group({ nodes: [], edges: ["msg-1"] })]), "v", addressable(before));
    if (!result.ok) throw new Error("expected a valid emphasis");
    store.apply(result.emphasis, addressable(before));
    expect(store.revalidate("v", addressable(TRACE(["zero", "first", "second"])))).toBe(true);
    expect(store.payload("v").emphases[0]?.groups[0]?.edges).toEqual(["msg-2"]);
    expect(store.revalidate("v", addressable(TRACE(["zero", "first", "changed"])))).toBe(true);
    expect(store.payload("v").emphases).toEqual([]);
  });
});

describe("C1 review regressions", () => {
  test("a group that a recompile empties gives its slot to the next", () => {
    const store = new EmphasisStore();
    const parsed = parseEmphasis(
      payload([group({ id: "a", nodes: ["db"] }), group({ id: "b", nodes: ["api"] })]),
      "v",
      addressable(GRAPH),
    );
    if (!parsed.ok) throw new Error("expected valid");
    store.apply(parsed.emphasis, addressable(GRAPH));
    store.revalidate("v", addressable({ ...GRAPH, nodes: GRAPH.nodes.filter((n) => n.id !== "db") }));
    expect(store.payload("v").emphases[0]?.groups.map((g) => [g.id, g.palette])).toEqual([["b", "teal"]]);
  });

  test.each([null, "​", " \t"])("refuses a label of %j as missing or empty", (label) => {
    expect(issues(payload([group({ label })])).map((i) => i.problem)).toEqual([
      label === null ? "has no label" : "has an empty label",
    ]);
  });

  test("a description with a version or a file name is still one sentence", () => {
    expect(
      parseEmphasis(payload([group({ description: "Runs on Node.js v2.1 today." })]), "v", addressable(GRAPH)).ok,
    ).toBe(true);
  });
});
