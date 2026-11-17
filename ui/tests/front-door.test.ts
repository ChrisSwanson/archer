// The front door's rules, as pure functions (phase3-front-door.md): what the
// inventory's new fields say, what the service's search answers, what the
// presence line says, and how a `change` event is read and told. (The project
// and search pages' rules are file-index.test.ts's.)
import { describe, expect, it } from "vitest";
import { parseInventory, type DiagramView } from "../src/app/inventory";
import { parseSearch, searchHits } from "../src/app/search";
import { CAPTION_IN_HEADER_MAX_CHARS, clockTime, presenceLine, timeAgo } from "../src/app/presence";
import { changeHeadline, changedCount, parseChange } from "../src/app/change";
import { cssString, pulseRule, pulseSelector } from "../src/diagrams/ChangePulse";

const base = { registration: "durable" } as const;
const view = (id: string, kind: string, title: string, extra: Partial<DiagramView> = {}): DiagramView => ({
  id,
  kind,
  title,
  ...base,
  ...extra,
});

describe("the inventory's phase 3 fields", () => {
  const full = {
    id: "pipeline",
    kind: "freeform",
    title: "Compile pipeline",
    registration: "durable",
    lastChange: { at: "2026-10-04T10:42:00.000Z", by: "agent", summary: "merged Lexer into Parser" },
    threads: { draft: 1, sent: 2, read: 0, answered: 1, resolved: 0 },
    caption: "The parser now owns lexing.",
    group: "system",
    counts: { elements: 7, links: 6 },
  };

  it("reads every new field", () => {
    expect(parseInventory({ schemaVersion: 1, views: [full] })).toEqual([full]);
  });

  it("drops a malformed field, not the diagram", () => {
    const [read] = parseInventory({
      schemaVersion: 1,
      views: [
        {
          ...full,
          lastChange: { at: 7, by: "agent" },
          threads: { draft: "1" },
          caption: 3,
          group: "elsewhere",
          counts: { elements: -1, links: 2 },
        },
      ],
    })!;
    expect(read).toEqual({ id: "pipeline", kind: "freeform", title: "Compile pipeline", registration: "durable" });
  });

  it("reads a change by someone it does not know as no change at all", () => {
    const [read] = parseInventory({
      schemaVersion: 1,
      views: [{ ...full, lastChange: { at: full.lastChange.at, by: "robot" } }],
    })!;
    expect(read!.lastChange).toBeUndefined();
  });
});

describe("api/search", () => {
  const answer = {
    query: "lexer",
    results: [
      { target: "view:pipeline", title: "Compile pipeline", where: ["diagram", "comment"], matches: [] },
      { target: "note:notes/parsing.md", title: "Parsing", where: ["note"], matches: [] },
      { target: "elsewhere:x", title: "Bad", where: ["note"], matches: [] },
      { target: "view:other", title: "Other", where: ["somewhere"], matches: [] },
    ],
  };

  it("reads the results it can, and drops the rest", () => {
    expect(parseSearch(answer)).toEqual({
      query: "lexer",
      results: [
        { target: "view:pipeline", title: "Compile pipeline", where: ["diagram", "comment"], matches: [] },
        { target: "note:notes/parsing.md", title: "Parsing", where: ["note"], matches: [] },
        { target: "view:other", title: "Other", where: [], matches: [] },
      ],
    });
    expect(parseSearch({ results: [] })).toBeUndefined();
    expect(parseSearch(null)).toBeUndefined();
  });

  it("indexes the places by target", () => {
    const hits = searchHits(parseSearch(answer)!);
    expect(hits.query).toBe("lexer");
    expect(hits.places.get("view:pipeline")).toEqual(["diagram", "comment"]);
    expect(hits.places.get("note:notes/parsing.md")).toEqual(["note"]);
  });
});

describe("the pulse's stylesheet", () => {
  it("names each element on every canvas, scoped to the stage", () => {
    const selector = pulseSelector(["n1"]);
    for (const part of [
      '.react-flow__node[data-id="n1"]',
      '.react-flow__node[data-id="group:n1"]',
      '.react-flow__edge[data-id="n1"]',
      '[data-seq-id="n1"]',
      '[data-journey-id="n1"]',
    ]) {
      expect(selector).toContain(`.archer-stage ${part}`);
    }
  });

  it("cannot be broken out of by an id", () => {
    expect(cssString('a"] { color: red } [x="')).toBe('a\\"] { color: red } [x=\\"');
    expect(cssString("a\\b\nc")).toBe("a\\\\b\\a c");
  });

  it("runs once in motion, alternating names so it can run again, and holds still otherwise", () => {
    expect(pulseRule(["n"], 1, false)).toContain("archer-change-pulse-1");
    expect(pulseRule(["n"], 2, false)).toContain("archer-change-pulse-0");
    expect(pulseRule(["n"], 1, false)).toMatch(/ 1;/);
    expect(pulseRule(["n"], 1, true)).not.toContain("animation");
    expect(pulseRule([], 1, false)).toBe("");
  });
});

describe("the presence line", () => {
  const now = Date.parse("2026-10-04T10:44:00.000Z");
  const tz = { timeZone: "UTC" } as const;

  it("says the agent presented it, how long ago, and its caption", () => {
    expect(
      presenceLine({ origin: "agent", presentedAt: now - 2 * 60_000, caption: "The parser owns lexing.", now, ...tz }),
    ).toEqual({
      lead: "Presented by the agent",
      voice: "agent",
      time: { iso: "2026-10-04T10:42:00.000Z", text: "2 min ago" },
      detail: "The parser owns lexing.",
      detailIsCaption: true,
    });
    // A caption longer than a header line holds is left to the bar under the drawing.
    const long = "x".repeat(CAPTION_IN_HEADER_MAX_CHARS + 1);
    expect(presenceLine({ origin: "agent", caption: long, now, ...tz })).toEqual({
      lead: "Presented by the agent",
      voice: "agent",
    });
    expect(presenceLine({ origin: "agent", caption: long.slice(1), now, ...tz })?.detail).toBe(long.slice(1));
  });

  it("takes the service's presentedAt over the moment the page saw it", () => {
    const presented = view("a", "freeform", "A", { presentedAt: "2026-10-04T10:39:00.000Z" });
    expect(presenceLine({ origin: "agent", view: presented, presentedAt: now, now, ...tz })?.time).toEqual({
      iso: "2026-10-04T10:39:00.000Z",
      text: "5 min ago",
    });
  });

  it("does not claim a time it does not know", () => {
    expect(presenceLine({ origin: "agent", now, ...tz })).toEqual({ lead: "Presented by the agent", voice: "agent" });
  });

  it("says who last changed a diagram the reader opened, and when", () => {
    const agent = view("a", "freeform", "A", {
      lastChange: { at: "2026-10-04T10:42:00.000Z", by: "agent", summary: "merged Lexer into Parser" },
    });
    expect(presenceLine({ origin: "reader", view: agent, now, ...tz })).toEqual({
      lead: "Changed by the agent",
      voice: "agent",
      time: { iso: "2026-10-04T10:42:00.000Z", text: "10:42" },
      detail: "merged Lexer into Parser",
    });
  });

  // flows-r1 claude-206: "Saved" only for this person's own save; a write Archer did not make for them says it changed on disk.
  it("says Saved only for the person's own save, and Changed on disk for any other write", () => {
    const person = view("a", "freeform", "A", {
      modelRevision: `sha256:${"2".repeat(64)}`,
      lastChange: { at: "2026-10-04T10:42:00.000Z", by: "person" },
    });
    const time = { iso: "2026-10-04T10:42:00.000Z", text: "10:42" };
    expect(presenceLine({ origin: "reader", view: person, now, ...tz })).toEqual({
      lead: "Changed on disk",
      voice: "other",
      time,
    });
    const mine = { prior: `sha256:${"1".repeat(64)}`, savedAt: Date.parse("2026-10-04T10:41:58.000Z") };
    expect(presenceLine({ origin: "reader", view: person, ownSave: mine, now, ...tz })).toEqual({
      lead: "Saved",
      voice: "you",
      time,
    });
    // Claimed for the revision it made: a later write (another revision) is not the person's.
    expect(
      presenceLine({
        origin: "reader",
        view: person,
        ownSave: { ...mine, claimed: `sha256:${"2".repeat(64)}` },
        now,
        ...tz,
      })?.lead,
    ).toBe("Saved");
    expect(
      presenceLine({
        origin: "reader",
        view: person,
        ownSave: { ...mine, claimed: `sha256:${"3".repeat(64)}` },
        now,
        ...tz,
      })?.lead,
    ).toBe("Changed on disk");
    // Not yet recompiled: the view still shows the revision the save started from.
    expect(
      presenceLine({
        origin: "reader",
        view: person,
        ownSave: { ...mine, prior: `sha256:${"2".repeat(64)}` },
        now,
        ...tz,
      })?.lead,
    ).toBe("Changed on disk");
    // While the editor is open over it, the header never says Saved (unsaved or refused work below it).
    expect(presenceLine({ origin: "reader", view: person, ownSave: mine, editing: true, now, ...tz })).toBeNull();
    expect(presenceLine({ origin: "reader", view: person, editing: true, now, ...tz })?.lead).toBe("Changed on disk");
  });

  it("says nothing about a diagram it knows nothing about", () => {
    expect(presenceLine({ origin: "reader", view: view("a", "freeform", "A"), now })).toBeNull();
  });

  it.each([
    [10_000, "just now"],
    [61_000, "1 min ago"],
    [59 * 60_000, "59 min ago"],
    [2 * 3_600_000, "2 h ago"],
  ])("says %d ms ago as %s", (ago, text) => {
    expect(timeAgo(now - ago, now)).toBe(text);
  });

  it("gives an older change its date as well as its time", () => {
    expect(clockTime("2026-10-02T09:05:00.000Z", now, "UTC")).toBe("2 Oct, 09:05");
    expect(clockTime("2026-10-04T09:05:00.000Z", now, "UTC")).toBe("09:05");
  });
});

describe("the change event", () => {
  const event = {
    viewId: "pipeline",
    at: "2026-10-04T10:42:00.000Z",
    by: "agent",
    summary: "merged Lexer into Parser",
    added: ["parser"],
    changed: ["e1", "e2"],
    removed: [{ id: "lexer", label: "Lexer" }],
  };

  it("reads the contract's shape", () => {
    expect(parseChange(event)).toEqual(event);
    expect(parseChange({ ...event, summary: undefined })).toEqual({ ...event, summary: undefined });
  });

  it("refuses what is not a change", () => {
    for (const bad of [
      null,
      {},
      { ...event, by: "robot" },
      { ...event, added: "parser" },
      { ...event, removed: [{ id: 1 }] },
    ]) {
      expect(parseChange(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("counts what was added and changed, and names what went", () => {
    const change = parseChange(event)!;
    expect(changedCount(change)).toBe(3);
    expect(changeHeadline(change)).toBe("The agent changed 3 elements");
    expect(changeHeadline({ ...change, added: [], changed: ["x"] })).toBe("The agent changed 1 element");
    expect(changeHeadline({ ...change, added: [], changed: [] })).toBe("The agent removed 1 element");
    // A change of shape or style only: every list empty, still a change.
    expect(changeHeadline({ ...change, added: [], changed: [], removed: [] })).toBe("The agent changed this diagram");
  });
});
