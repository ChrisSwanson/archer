/**
 * The wire contract, and the rule that keeps it safe to render.
 *
 * The agent picks from closed enums; this module turns those into class names.
 * If any value the agent sends could reach a CSS property, an agent-authored
 * payload becomes an agent-authored stylesheet -- so the tests below assert on
 * classes, and on the parser refusing anything that is not one of the enums.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPHASIS_PALETTES,
  EMPHASIS_SCHEMA_VERSION,
  EMPHASIS_SPEEDS,
  EMPHASIS_STYLES,
  assignEmphasis,
  paletteClass,
  parseEmphasis,
  sharedParts,
  parseEmphasisSnapshot,
  speedClass,
  styleClass,
  type Emphasis,
} from "../src/emphasis/contract";

const GROUP = {
  id: "write",
  style: "flow",
  palette: "teal",
  state: "existing",
  speed: "slow",
  label: "The write path",
  description: "Source in, envelope out.",
  nodes: ["repo"],
  edges: ["compiles"],
};

const PAYLOAD = {
  id: "write-path",
  viewId: "system-context",
  title: "The write path",
  groups: [GROUP],
};

const snapshot = (emphases: readonly unknown[], viewId = "system-context") => ({
  schemaVersion: 1,
  viewId,
  emphases,
});

describe("reading an emphasis payload", () => {
  it("reads the frozen shape", () => {
    const emphasis = parseEmphasis(PAYLOAD);

    expect(emphasis).toEqual({
      id: "write-path",
      viewId: "system-context",
      title: "The write path",
      groups: [
        {
          id: "write",
          style: "flow",
          palette: "teal",
          state: "existing",
          speed: "slow",
          label: "The write path",
          description: "Source in, envelope out.",
          nodes: ["repo"],
          edges: ["compiles"],
        },
      ],
    });
  });

  it("defaults an absent state and speed rather than dropping the group", () => {
    const emphasis = parseEmphasis({
      ...PAYLOAD,
      groups: [{ id: "write", style: "flow", palette: "teal", edges: ["compiles"] }],
    });

    expect(emphasis?.groups[0].state).toBe("existing");
    expect(emphasis?.groups[0].speed).toBe("normal");
    expect(emphasis?.groups[0].nodes).toEqual([]);
  });

  it("carries no speed on a highlight group, which does not move", () => {
    const emphasis = parseEmphasis({
      ...PAYLOAD,
      groups: [{ ...GROUP, style: "highlight", speed: "fast" }],
    });

    expect(emphasis?.groups[0].speed).toBeNull();
  });

  it("falls back to the group id when no label was sent", () => {
    const emphasis = parseEmphasis({
      ...PAYLOAD,
      groups: [{ ...GROUP, label: undefined }],
    });

    expect(emphasis?.groups[0].label).toBe("write");
  });

  // Atomicity is the design rule: a partially valid emphasis puts a picture on
  // screen that says something the agent did not mean.
  it.each([
    ["an unknown palette", { ...GROUP, palette: "chartreuse" }],
    ["an unknown style", { ...GROUP, style: "shimmer" }],
    ["an unknown state", { ...GROUP, state: "hypothetical" }],
    ["an unknown speed", { ...GROUP, speed: "instant" }],
    ["a colour smuggled in as a palette", { ...GROUP, palette: "#ff0000" }],
    ["a missing group id", { ...GROUP, id: undefined }],
    ["a non-string node id", { ...GROUP, nodes: [{ id: "repo" }] }],
  ])("publishes nothing when a group carries %s", (_name, group) => {
    expect(parseEmphasis({ ...PAYLOAD, groups: [GROUP, group] })).toBeUndefined();
  });

  it.each([
    ["not an object", 42],
    ["missing its id", { ...PAYLOAD, id: undefined }],
    ["missing its viewId", { ...PAYLOAD, viewId: undefined }],
    ["missing its groups", { id: "x", viewId: "v" }],
  ])("rejects a payload that is %s", (_name, payload) => {
    expect(parseEmphasis(payload)).toBeUndefined();
  });

  it("reads an empty group list as a cleared emphasis rather than a fault", () => {
    expect(parseEmphasis({ ...PAYLOAD, groups: [] })).toEqual({
      id: "write-path",
      viewId: "system-context",
      title: "The write path",
      groups: [],
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The same field, the same defect as the inventory's: emitted on all three
// emphasis surfaces, documented at the top of the contract, and never read. A
// snapshot at a version this page does not understand must not be drawn from a
// version-1 reading of it -- for emphasis that is a picture saying something
// its author did not mean, which is the one thing this contract forbids.
describe("the emphasis schema version", () => {
  it("is the version the server emits", () => {
    expect(EMPHASIS_SCHEMA_VERSION).toBe(1);
  });

  it.each([
    ["a later version", 2],
    ["an earlier version", 0],
    ["the right number as a string", "1"],
    ["null", null],
    ["nothing at all", undefined],
  ])("rejects a snapshot carrying %s, and says why", (_label, schemaVersion) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const payload: Record<string, unknown> = { ...snapshot([PAYLOAD]) };
    if (schemaVersion === undefined) {
      delete payload.schemaVersion;
    } else {
      payload.schemaVersion = schemaVersion;
    }

    expect(parseEmphasisSnapshot(payload)).toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain("schemaVersion");
  });

  // On the MCP transport every tool result is offered to this parser, because
  // `set_emphasis` delivers through its own result. Something that is plainly
  // not a snapshot is not a version mismatch and must not be reported as one.
  it("stays quiet about a payload that was never a snapshot", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(parseEmphasisSnapshot({ schemaVersion: 2, presentation: {} })).toBeUndefined();
    expect(parseEmphasisSnapshot({ revision: "sha256:0", status: "compiled" })).toBeUndefined();
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("reading a snapshot of the stored list", () => {
  it("reads every stored emphasis, in the order sent", () => {
    const parsed = parseEmphasisSnapshot(snapshot([PAYLOAD, { ...PAYLOAD, id: "read-path" }]));

    expect(parsed?.viewId).toBe("system-context");
    expect(parsed?.emphases.map((e) => e.id)).toEqual(["write-path", "read-path"]);
  });

  it("reads an unknown view's empty list as an empty list, not a fault", () => {
    expect(parseEmphasisSnapshot(snapshot([], "never-registered"))).toEqual({
      viewId: "never-registered",
      emphases: [],
    });
  });

  // One bad member must not take the others' chips off the row -- but the bad
  // member itself renders nothing, per the atomicity rule above.
  it("drops a malformed member without losing the rest of the list", () => {
    const parsed = parseEmphasisSnapshot(
      snapshot([PAYLOAD, { ...PAYLOAD, id: "broken", groups: [{ ...GROUP, style: "shimmer" }] }]),
    );

    expect(parsed?.emphases.map((e) => e.id)).toEqual(["write-path"]);
  });

  // An explicit `null` means the same as an omitted key, on this side too.
  //
  // The server already holds itself to that rule on the way IN -- a client that
  // serializes its whole struct sends nulls without meaning anything by them --
  // and reading is where the same rule costs the most to get wrong: an optional
  // spelled `null` instead of absent drops the group, which drops the whole
  // emphasis, which shows up as a console line and a diagram with nothing lit
  // up rather than as a failure.
  it.each([["speed"], ["state"], ["label"], ["description"], ["title"]])(
    "reads a payload whose optional %s is an explicit null",
    (field) => {
      const emphasis = parseEmphasis(
        field === "title" ? { ...PAYLOAD, title: null } : { ...PAYLOAD, groups: [{ ...GROUP, [field]: null }] },
      );

      expect(emphasis, `a null ${field} must read as an absent one`).toBeDefined();
      expect(emphasis?.groups).toHaveLength(1);
    },
  );

  it("falls back to the same defaults for a null optional as for an absent one", () => {
    const nulled = parseEmphasis({
      ...PAYLOAD,
      groups: [{ ...GROUP, state: null, speed: null, label: null, description: null }],
    });
    const absent = parseEmphasis({
      ...PAYLOAD,
      groups: [{ id: GROUP.id, style: GROUP.style, palette: GROUP.palette, nodes: GROUP.nodes, edges: GROUP.edges }],
    });

    expect(nulled).toEqual(absent);
  });

  it("drops a member stored against a different view than the snapshot claims", () => {
    const parsed = parseEmphasisSnapshot(snapshot([PAYLOAD, { ...PAYLOAD, id: "elsewhere", viewId: "request-flow" }]));

    expect(parsed?.emphases.map((e) => e.id)).toEqual(["write-path"]);
  });

  it.each([
    ["not an object", null],
    ["missing its viewId", { emphases: [] }],
    ["missing its list", { viewId: "system-context" }],
  ])("rejects a snapshot that is %s", (_name, payload) => {
    expect(parseEmphasisSnapshot(payload)).toBeUndefined();
  });
});

describe("enums become classes, never CSS values", () => {
  it("gives every palette its own class", () => {
    const classes = EMPHASIS_PALETTES.map(paletteClass);

    expect(new Set(classes).size).toBe(EMPHASIS_PALETTES.length);
    expect(classes).toEqual(["archer-emph-palette-teal", "archer-emph-palette-violet", "archer-emph-palette-coral"]);
  });

  it("gives every style and speed its own class", () => {
    expect(EMPHASIS_STYLES.map(styleClass)).toEqual(["archer-emph-style-flow", "archer-emph-style-highlight"]);
    expect(new Set(EMPHASIS_SPEEDS.map(speedClass)).size).toBe(EMPHASIS_SPEEDS.length);
  });

  it("keeps every emphasis class out of the focus namespace", () => {
    // Two channels, and neither may capture the other: focus is the host's
    // published framing, emphasis is the agent pointing.
    const classes = [
      ...EMPHASIS_PALETTES.map(paletteClass),
      ...EMPHASIS_STYLES.map(styleClass),
      ...EMPHASIS_SPEEDS.map(speedClass),
    ];
    for (const name of classes) {
      expect(name.startsWith("archer-emph-")).toBe(true);
      expect(name.startsWith("archer-focus-")).toBe(false);
    }
  });
});

describe("assigning an emphasis to ids", () => {
  const emphasis = parseEmphasis({
    ...PAYLOAD,
    groups: [
      { ...GROUP, id: "write", nodes: ["repo", "compiler"], edges: ["compiles", "emits"] },
      { ...GROUP, id: "read", palette: "coral", style: "highlight", state: "proposed", nodes: ["ui"] },
    ],
  }) as Emphasis;

  it("carries the group's palette, style and state onto each member", () => {
    const assigned = assignEmphasis(emphasis);

    expect(assigned.nodes.get("repo")?.classes).toEqual(
      expect.arrayContaining([
        "archer-emph",
        "archer-emph-style-flow",
        "archer-emph-palette-teal",
        "archer-emph-speed-slow",
      ]),
    );
    expect(assigned.nodes.get("ui")?.classes).toEqual(
      expect.arrayContaining(["archer-emph", "archer-emph-palette-violet"]),
    );
  });

  it("numbers each edge by its place in the group's travel order", () => {
    const assigned = assignEmphasis(emphasis);

    expect(assigned.edges.get("compiles")).toMatchObject({ hop: 0, hops: 2 });
    expect(assigned.edges.get("emits")).toMatchObject({ hop: 1, hops: 2 });
  });

  it("gives an id named twice the first group's treatment, deterministically", () => {
    const overlapping = parseEmphasis({
      ...PAYLOAD,
      groups: [
        { ...GROUP, id: "first", palette: "teal", nodes: ["repo"] },
        { ...GROUP, id: "second", palette: "coral", nodes: ["repo"] },
      ],
    }) as Emphasis;

    expect(assignEmphasis(overlapping).nodes.get("repo")?.groupId).toBe("first");
  });

  it("assigns nothing when there is no emphasis", () => {
    expect(assignEmphasis(null).nodes.size).toBe(0);
    expect(assignEmphasis(null).edges.size).toBe(0);
  });
});

describe("ADR 0030: colour by position, three groups, shared parts", () => {
  it("colours by position and ignores the palette name the wire carries", () => {
    const parsed = parseEmphasis({
      ...PAYLOAD,
      groups: [
        { ...GROUP, id: "a", palette: "coral" },
        { ...GROUP, id: "b", palette: "teal" },
        { ...GROUP, id: "c", palette: undefined },
      ],
    });
    expect(parsed?.groups.map((group) => group.palette)).toEqual(["teal", "violet", "coral"]);
  });

  it("still refuses a palette name it has never heard of", () => {
    expect(parseEmphasis({ ...PAYLOAD, groups: [{ ...GROUP, palette: "red" }] })).toBeUndefined();
  });

  it("refuses a fourth group whole rather than drawing three of four", () => {
    const four = Array.from({ length: 4 }, (_, index) => ({ ...GROUP, id: `g${index}` }));
    expect(parseEmphasis({ ...PAYLOAD, groups: four })).toBeUndefined();
  });

  it("names nothing as shared when the groups are disjoint", () => {
    const disjoint = parseEmphasis({
      ...PAYLOAD,
      groups: [
        { ...GROUP, id: "a", nodes: ["repo"], edges: ["compiles"] },
        { ...GROUP, id: "b", nodes: ["ui"], edges: ["emits"] },
      ],
    });
    expect(sharedParts(disjoint)).toEqual({ nodes: [], edges: [] });
  });

  it("names each part two groups both point at, once, in the order first met", () => {
    const overlapping = parseEmphasis({
      ...PAYLOAD,
      groups: [
        { ...GROUP, id: "a", nodes: ["repo", "ui"], edges: ["compiles"] },
        { ...GROUP, id: "b", nodes: ["ui", "repo"], edges: ["compiles"] },
        { ...GROUP, id: "c", nodes: ["ui"], edges: [] },
      ],
    });
    expect(sharedParts(overlapping)).toEqual({ nodes: ["ui", "repo"], edges: ["compiles"] });
  });

  it("counts two groups landing on one closed boundary as sharing it", () => {
    const apart = parseEmphasis({
      ...PAYLOAD,
      groups: [
        { ...GROUP, id: "a", nodes: ["repo"], edges: [] },
        { ...GROUP, id: "b", nodes: ["ui"], edges: [] },
      ],
    });
    // At a zoom level both ids are drawn as the boundary "system".
    expect(sharedParts(apart, () => "system")).toEqual({ nodes: ["system"], edges: [] });
  });
});
