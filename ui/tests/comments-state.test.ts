// The pure half of comments and notes: what a server payload is allowed to
// say (`parse.ts`), what the page makes of a thread (`state.ts`), and how a
// passage of a note is found again after the note is edited around it.
import { describe, expect, it } from "vitest";
import {
  parseCapabilities,
  parseDeleteResult,
  parseNoteContent,
  parseNotesForView,
  parseThread,
  parseThreadList,
} from "../src/comments/parse";
import {
  anchorForSelection,
  anchorLabel,
  locatePassage,
  passageAnchor,
  isPending,
  displayStatus,
  threadOrigin,
  threadStatusLabel,
  threadsReducer,
  STATUS_LABEL,
  type DisplayStatus,
} from "../src/comments/state";
import { NO_CAPABILITIES, type Anchor, type Thread, type ThreadStatus } from "../src/comments/contract";

const T0 = "2026-10-03T10:00:00.000Z";

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    target: "view:alpha",
    anchor: { kind: "node", id: "web", label: "Web" },
    status: "draft",
    revision: 1,
    comments: [{ id: "c1", author: "person", body: "Why two hops?", createdAt: T0 }],
    ...overrides,
  };
}

describe("parseCapabilities", () => {
  it.each([
    [null, { comments: false, notes: false }],
    [{}, { comments: false, notes: false }],
    [{ presentation: {} }, { comments: false, notes: false }],
    [{ capabilities: { comments: true } }, { comments: true, notes: false }],
    [{ capabilities: { notes: true } }, { comments: false, notes: true }],
    [{ capabilities: { comments: true, notes: true } }, { comments: true, notes: true }],
    [
      { capabilities: { comments: true, notes: true, noteEmphasis: true } },
      { comments: true, notes: true, noteEmphasis: true },
    ],
    // Only `true` turns a feature on: a truthy string is not the contract.
    [{ capabilities: { comments: "yes", notes: 1 } }, { comments: false, notes: false }],
    [{ capabilities: [] }, { comments: false, notes: false }],
    // archer.toml `nested_view = false` (ADR 0029): only `false` is carried; anything else is the default.
    [{ project: { nestedView: false } }, { comments: false, notes: false, nestedView: false }],
    [{ project: { nestedView: true } }, { comments: false, notes: false }],
    [{ project: { nestedView: "false" } }, { comments: false, notes: false }],
    // What the service sends (project-state.ts CAPABILITIES): every flag is named, off unless `true`.
    [
      {
        capabilities: {
          comments: true,
          notes: true,
          noteEmphasis: true,
          instanceSettings: true,
          listeners: true,
          commentOperations: 1,
        },
      },
      { comments: true, notes: true, noteEmphasis: true, instanceSettings: true, listeners: true },
    ],
  ])("reads %j as %j", (snapshot, expected) => {
    expect(parseCapabilities(snapshot)).toEqual({ ...NO_CAPABILITIES, ...expected });
  });
});

describe("parseThread", () => {
  it("accepts every anchor kind the contract names", () => {
    const anchors: Anchor[] = [
      { kind: "view" },
      { kind: "node", id: "a", label: "A" },
      { kind: "edge", id: "e", label: "calls" },
      { kind: "group", id: "g", label: "Zone" },
      { kind: "selection", nodes: [{ id: "a", label: "A" }], edges: [{ id: "e", label: "calls" }] },
      { kind: "passage", quote: "two hops", prefix: "Why ", suffix: "?" },
    ];
    for (const anchor of anchors) {
      expect(parseThread(thread({ anchor }))?.anchor).toEqual(anchor);
    }
  });

  it("accepts every status, and the two flags", () => {
    const statuses: ThreadStatus[] = ["draft", "sent", "read", "answered", "resolved"];
    for (const status of statuses) {
      expect(parseThread(thread({ status, changedAfterSubmit: true, orphaned: true }))).toMatchObject({
        status,
        changedAfterSubmit: true,
        orphaned: true,
      });
    }
  });

  it.each([
    ["no id", { id: 1 }],
    ["a target of another kind", { target: "file:alpha" }],
    ["an unknown status", { status: "open" }],
    ["an unknown anchor", { anchor: { kind: "region" } }],
    ["a node anchor without an id", { anchor: { kind: "node", label: "A" } }],
    ["a passage without its context", { anchor: { kind: "passage", quote: "x" } }],
    ["a comment by somebody else", { comments: [{ id: "c", author: "bot", body: "x", createdAt: T0 }] }],
    ["a comment with no body", { comments: [{ id: "c", author: "person", createdAt: T0 }] }],
    ["no comments array", { comments: "x" }],
  ])("refuses %s", (_name, overrides) => {
    expect(parseThread({ ...thread(), ...overrides })).toBeUndefined();
  });
});

describe("parseThreadList", () => {
  it("keeps the threads it can read and drops the rest", () => {
    const list = parseThreadList({
      schemaVersion: 2,
      target: "view:alpha",
      threads: [thread(), { id: "broken" }],
    });
    expect(list?.threads.map((t) => t.id)).toEqual(["t1"]);
  });

  it("refuses another schema version or a missing target", () => {
    expect(parseThreadList({ schemaVersion: 3, target: "view:alpha", threads: [] })).toBeUndefined();
    expect(parseThreadList({ schemaVersion: 2, threads: [] })).toBeUndefined();
  });
});

describe("parseDeleteResult", () => {
  it("reads a thread, or the thread's deletion", () => {
    expect(parseDeleteResult({ deleted: true })).toEqual({ deleted: true });
    expect(parseDeleteResult(thread())).toEqual({ deleted: false, thread: thread() });
    expect(parseDeleteResult({ deleted: false })).toBeUndefined();
  });
});

describe("notes payloads", () => {
  it("reads a view's notes", () => {
    expect(
      parseNotesForView({
        viewId: "alpha",
        notes: [{ path: "notes/auth.md", title: "Auth", type: "decision" }, { path: 3 }],
      }),
    ).toEqual({ viewId: "alpha", notes: [{ path: "notes/auth.md", title: "Auth", type: "decision" }] });
  });

  it("reads a note's content", () => {
    expect(
      parseNoteContent({ path: "a.md", frontMatter: { status: "draft" }, markdown: "# A", revision: "r1" }),
    ).toEqual({ path: "a.md", frontMatter: { status: "draft" }, markdown: "# A", revision: "r1" });
    expect(parseNoteContent({ path: "a.md", markdown: 3, revision: "r1" })).toBeUndefined();
  });
});

describe("displayStatus", () => {
  // Every combination the contract can express, so a new status fails here.
  const table: [ThreadStatus, boolean, DisplayStatus][] = [
    ["draft", false, "draft"],
    ["draft", true, "changed"],
    ["sent", false, "sent"],
    ["sent", true, "sent"],
    ["read", false, "read"],
    ["read", true, "read"],
    ["answered", false, "answered"],
    ["answered", true, "answered"],
    ["resolved", false, "resolved"],
    ["resolved", true, "resolved"],
  ];
  it.each(table)("%s with changedAfterSubmit=%s reads as %s", (status, changed, expected) => {
    expect(displayStatus(thread({ status, changedAfterSubmit: changed }))).toBe(expected);
    expect(STATUS_LABEL[expected]).toMatch(/\S/);
  });

  it("counts drafts, changed or not, as pending", () => {
    expect(
      [
        thread({ id: "a", status: "draft" }),
        thread({ id: "b", status: "draft", changedAfterSubmit: true }),
        thread({ id: "c", status: "sent" }),
        thread({ id: "d", status: "answered" }),
      ].filter(isPending),
    ).toHaveLength(2);
  });

  it("names an answered thread by who opened it, even after replies", () => {
    const agentOpened = thread({
      status: "answered",
      comments: [
        { id: "a", author: "agent", body: "Please review this.", createdAt: T0 },
        { id: "p", author: "person", body: "On it.", createdAt: T0 },
      ],
    });
    const personOpened = thread({
      status: "answered",
      comments: [
        { id: "p", author: "person", body: "Can you review this?", createdAt: T0 },
        { id: "a", author: "agent", body: "Yes.", createdAt: T0 },
      ],
    });
    expect(threadOrigin(agentOpened)).toBe("agent");
    expect(threadStatusLabel(agentOpened)).toBe("Agent opened");
    expect(threadOrigin(personOpened)).toBe("person");
    expect(threadStatusLabel(personOpened)).toBe("Answered");
  });
});

describe("anchors", () => {
  it("names each anchor kind for a reader", () => {
    expect(anchorLabel({ kind: "view" }, "note")).toBe("Whole note");
    expect(anchorLabel({ kind: "view" }, "view")).toBe("Whole diagram");
    expect(anchorLabel({ kind: "node", id: "a", label: "Web" }, "view")).toBe("Node: Web");
    expect(anchorLabel({ kind: "edge", id: "e", label: "calls" }, "view")).toBe("Edge: calls");
    expect(anchorLabel({ kind: "group", id: "g", label: "Zone" }, "view")).toBe("Group: Zone");
    expect(
      anchorLabel(
        {
          kind: "selection",
          nodes: [
            { id: "a", label: "Web" },
            { id: "b", label: "API" },
          ],
          edges: [{ id: "e", label: "calls" }],
        },
        "view",
      ),
    ).toBe("3 elements: Web, API, calls");
    expect(anchorLabel({ kind: "passage", quote: "two hops", prefix: "", suffix: "" }, "note")).toBe(
      "Passage: “two hops”",
    );
  });

  it("derives the anchor from what is selected", () => {
    expect(anchorForSelection([], [])).toEqual({ kind: "view" });
    expect(anchorForSelection([{ id: "a", label: "Web" }], [])).toEqual({ kind: "node", id: "a", label: "Web" });
    expect(anchorForSelection([], [{ id: "e", label: "calls" }])).toEqual({ kind: "edge", id: "e", label: "calls" });
    expect(anchorForSelection([{ id: "a", label: "Web" }], [{ id: "e", label: "calls" }])).toEqual({
      kind: "selection",
      nodes: [{ id: "a", label: "Web" }],
      edges: [{ id: "e", label: "calls" }],
    });
  });
});

describe("threadsReducer", () => {
  it("loads a target, upserts a thread in place, and removes one", () => {
    let state = threadsReducer(new Map(), { type: "loaded", target: "view:alpha", threads: [thread()] });
    state = threadsReducer(state, { type: "upsert", thread: thread({ status: "sent" }) });
    expect(state.get("view:alpha")?.[0]?.status).toBe("sent");
    state = threadsReducer(state, { type: "upsert", thread: thread({ id: "t2" }) });
    expect(state.get("view:alpha")?.map((t) => t.id)).toEqual(["t1", "t2"]);
    state = threadsReducer(state, { type: "remove", threadId: "t1" });
    expect(state.get("view:alpha")?.map((t) => t.id)).toEqual(["t2"]);
  });

  it("keeps a thread held at a later revision over a write's older answer (O208), not over a newer one", () => {
    let state = threadsReducer(new Map(), {
      type: "loaded",
      target: "view:alpha",
      threads: [thread({ revision: 3, status: "draft" })],
    });
    state = threadsReducer(state, { type: "upsert", thread: thread({ revision: 2, status: "sent" }), answer: true });
    expect(state.get("view:alpha")?.[0]).toMatchObject({ revision: 3, status: "draft" });
    state = threadsReducer(state, { type: "upsert", thread: thread({ revision: 4, status: "sent" }), answer: true });
    expect(state.get("view:alpha")?.[0]).toMatchObject({ revision: 4, status: "sent" });
    // Heard from the service (not an answer), the thread is taken as it is.
    state = threadsReducer(state, { type: "upsert", thread: thread({ revision: 1 }) });
    expect(state.get("view:alpha")?.[0]?.revision).toBe(1);
  });

  it("keeps an agent reply heard at the same revision over a write's older answer (O210)", () => {
    const person = { id: "c2", author: "person" as const, body: "Still two?", createdAt: T0 };
    const agent = { id: "c3", author: "agent" as const, body: "Yes, the proxy.", createdAt: T0 };
    const opening = thread().comments[0]!;
    // The agent's reply reached the page first; it leaves the person's revision where it was.
    let state = threadsReducer(new Map(), {
      type: "loaded",
      target: "view:alpha",
      threads: [thread({ revision: 2, status: "answered", comments: [opening, person, agent] })],
    });
    state = threadsReducer(state, {
      type: "upsert",
      thread: thread({ revision: 2, status: "sent", comments: [opening, person] }),
      answer: true,
    });
    expect(state.get("view:alpha")?.[0]).toMatchObject({ revision: 2, status: "answered" });
    expect(state.get("view:alpha")?.[0]?.comments.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    // The agent read it (no reply yet): a sent answer at that revision does not undo it either.
    state = threadsReducer(new Map(), {
      type: "loaded",
      target: "view:alpha",
      threads: [thread({ revision: 2, status: "read" })],
    });
    state = threadsReducer(state, { type: "upsert", thread: thread({ revision: 2, status: "sent" }), answer: true });
    expect(state.get("view:alpha")?.[0]?.status).toBe("read");
    // An answer that is itself further on at that revision is taken.
    state = threadsReducer(state, {
      type: "upsert",
      thread: thread({ revision: 2, status: "answered", comments: [opening, agent] }),
      answer: true,
    });
    expect(state.get("view:alpha")?.[0]).toMatchObject({ status: "answered" });
  });

  it("does not invent a target it has not loaded", () => {
    const state = threadsReducer(new Map(), { type: "upsert", thread: thread({ target: "note:a.md" }) });
    expect(state.get("note:a.md")?.map((t) => t.id)).toEqual(["t1"]);
  });
});

describe("passages", () => {
  const text = "Tokens expire after an hour. Refresh tokens expire after a week.";

  it("anchors a selection by its text and some of what surrounds it", () => {
    const start = text.indexOf("expire after a week");
    const anchor = passageAnchor(text, start, start + "expire after a week".length);
    expect(anchor).toEqual({
      kind: "passage",
      quote: "expire after a week",
      prefix: text.slice(Math.max(0, start - 32), start),
      suffix: ".",
    });
  });

  it("keeps its context inside the block the passage is in", () => {
    // A rendered list: the source has `- ` before each item, so context that
    // ran into the next item would not be found in it.
    const list = "\none\ntwo items here\nthree\n";
    const start = list.indexOf("items");
    expect(passageAnchor(list, start, start + "items".length)).toEqual({
      kind: "passage",
      quote: "items",
      prefix: "two ",
      suffix: " here",
    });
  });

  it("finds the occurrence its context names, not the first one", () => {
    const start = text.lastIndexOf("expire after");
    const anchor = passageAnchor(text, start, start + "expire after".length);
    expect(locatePassage(text, anchor)).toEqual({ start, end: start + "expire after".length });
  });

  it("survives an edit around it", () => {
    const start = text.lastIndexOf("expire after");
    const anchor = passageAnchor(text, start, start + "expire after".length);
    const edited = `Intro.\n\n${text}`;
    expect(locatePassage(edited, anchor)).toEqual({
      start: edited.lastIndexOf("expire after"),
      end: edited.lastIndexOf("expire after") + "expire after".length,
    });
  });

  it("finds nothing when the passage is gone", () => {
    const anchor = passageAnchor(text, 0, 6);
    expect(locatePassage("Something else entirely.", anchor)).toBeNull();
  });
});
