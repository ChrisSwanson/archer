// Comments schema version 2 (phase 2, the feedback loop),
// as the page reads it: the five statuses, the revision, the project-wide
// pending list, and version-1 payloads still read (`submitted` is `sent`).
//
// Every status is enumerated, so a status added to the contract without a
// name, a detail and a pin here fails this file.
import { describe, expect, it } from "vitest";
import { COMMENTS_SCHEMA_VERSION, type Thread, type ThreadStatus } from "../src/comments/contract";
import { parsePending, parseThread, parseThreadList } from "../src/comments/parse";
import {
  commentPins,
  displayStatus,
  isPending,
  STATUS_DETAIL,
  STATUS_LABEL,
  type DisplayStatus,
} from "../src/comments/state";

const STATUSES: readonly ThreadStatus[] = ["draft", "sent", "read", "answered", "resolved"];

const raw = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "t1",
  target: "view:system",
  anchor: { kind: "node", id: "web", label: "Web app" },
  status: "draft",
  revision: 3,
  comments: [{ id: "c1", author: "person", body: "Why?", createdAt: "2026-10-04T10:00:00Z" }],
  ...over,
});

const thread = (over: Partial<Thread> = {}): Thread => parseThread(raw(over as Record<string, unknown>))!;

describe("the contract mirror", () => {
  it("is schema version 2", () => {
    expect(COMMENTS_SCHEMA_VERSION).toBe(2);
  });
});

describe("reading a thread", () => {
  it.each(STATUSES)("reads status %s, with its revision", (status) => {
    expect(parseThread(raw({ status }))).toMatchObject({ status, revision: 3 });
  });

  it("refuses a version-1 thread: a `submitted` status, or no revision", () => {
    expect(parseThread(raw({ status: "submitted" }))).toBeUndefined();
    const unrevised = raw();
    delete unrevised.revision;
    expect(parseThread(unrevised)).toBeUndefined();
  });

  it("refuses a status it does not know, and a revision that is not a whole number", () => {
    expect(parseThread(raw({ status: "queued" }))).toBeUndefined();
    expect(parseThread(raw({ revision: "3" }))).toBeUndefined();
    expect(parseThread(raw({ revision: 1.5 }))).toBeUndefined();
  });

  it("reads a version-2 list, and no other version", () => {
    const list = parseThreadList({ schemaVersion: 2, target: "view:system", threads: [raw()] });
    expect(list).toMatchObject({ schemaVersion: 2, target: "view:system" });
    expect(list?.threads).toHaveLength(1);
    for (const schemaVersion of [1, 3])
      expect(parseThreadList({ schemaVersion, target: "view:system", threads: [] })).toBeUndefined();
  });
});

describe("reading what is pending", () => {
  it("reads the total and where the drafts are", () => {
    expect(
      parsePending({
        total: 3,
        targets: [
          { target: "view:system", title: "The system", drafts: 2 },
          { target: "note:notes/a.md", title: "Auth", drafts: 1 },
        ],
      }),
    ).toEqual({
      total: 3,
      targets: [
        { target: "view:system", title: "The system", drafts: 2 },
        { target: "note:notes/a.md", title: "Auth", drafts: 1 },
      ],
    });
  });

  it("drops a target it cannot read, and refuses a payload without a total", () => {
    expect(parsePending({ total: 1, targets: [{ target: "nowhere", title: "x", drafts: 1 }] })?.targets).toEqual([]);
    expect(parsePending({ targets: [] })).toBeUndefined();
  });
});

describe("a thread's state, as the person is told it", () => {
  const cases: [string, Partial<Thread>, DisplayStatus, string][] = [
    ["a draft", { status: "draft" }, "draft", "Draft"],
    [
      "a draft changed after sending",
      { status: "draft", changedAfterSubmit: true },
      "changed",
      "Changed after sending",
    ],
    ["sent", { status: "sent" }, "sent", "Sent"],
    ["read", { status: "read" }, "read", "Read by the agent"],
    ["answered", { status: "answered" }, "answered", "Answered"],
    ["resolved", { status: "resolved" }, "resolved", "Resolved by the agent"],
  ];

  it.each(cases)("%s", (_name, over, shown, label) => {
    const t = thread(over);
    expect(displayStatus(t)).toBe(shown);
    expect(STATUS_LABEL[shown]).toBe(label);
    expect(STATUS_DETAIL[shown]).not.toBe("");
  });

  it("names every status of the contract", () => {
    for (const status of STATUSES) expect(STATUS_LABEL[displayStatus(thread({ status }))]).toBeTruthy();
  });

  it("counts only drafts, changed or not, as waiting to send", () => {
    expect(STATUSES.filter((status) => isPending(thread({ status })))).toEqual(["draft"]);
  });
});

describe("pins", () => {
  const threads: Thread[] = [
    thread({ id: "a", status: "draft", anchor: { kind: "node", id: "web", label: "Web app" } }),
    thread({ id: "whole", status: "draft", anchor: { kind: "view" } }),
    thread({ id: "b", status: "sent", anchor: { kind: "edge", id: "e1", label: "HTTPS" } }),
    thread({ id: "c", status: "answered", anchor: { kind: "group", id: "backend", label: "Backend" } }),
    thread({ id: "gone", status: "sent", orphaned: true, anchor: { kind: "node", id: "db", label: "Database" } }),
    thread({
      id: "d",
      status: "resolved",
      anchor: {
        kind: "selection",
        nodes: [
          { id: "web", label: "Web app" },
          { id: "api", label: "API" },
        ],
        edges: [],
      },
    }),
    thread({ id: "e", status: "read", anchor: { kind: "node", id: "api", label: "API" } }),
    thread({ id: "f", status: "draft", changedAfterSubmit: true, anchor: { kind: "node", id: "api", label: "API" } }),
  ];
  const pins = commentPins(threads);

  it("numbers the threads on elements in order, skipping the whole diagram and orphans", () => {
    expect([...pins.numbers]).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
      ["d", 4],
      ["e", 5],
      ["f", 6],
    ]);
  });

  it("puts each pin on the elements its thread is about, outlined as a draft and filled once sent", () => {
    expect(pins.nodePins.get("web")).toEqual([
      { threadId: "a", number: 1, state: "draft" },
      { threadId: "d", number: 4, state: "resolved" },
    ]);
    expect(pins.nodePins.get("api")).toEqual([
      { threadId: "d", number: 4, state: "resolved" },
      { threadId: "e", number: 5, state: "sent" },
      { threadId: "f", number: 6, state: "draft" },
    ]);
    expect(pins.edgePins.get("e1")).toEqual([{ threadId: "b", number: 2, state: "sent" }]);
    expect(pins.groupPins.get("backend")).toEqual([{ threadId: "c", number: 3, state: "answered" }]);
    expect(pins.nodePins.has("db")).toBe(false);
    // The id sets every canvas already reads stay in step with the pins.
    expect([...pins.nodeIds].sort()).toEqual(["api", "web"]);
    expect([...pins.edgeIds]).toEqual(["e1"]);
    expect([...pins.groupIds]).toEqual(["backend"]);
  });
});
