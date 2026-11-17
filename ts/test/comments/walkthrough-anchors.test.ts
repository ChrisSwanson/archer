// Comments on walkthroughs (ADR 0034 §9): the `walkthrough` and `step` anchors,
// `context` on element anchors, orphaning against the walkthroughs file, and
// the file version (3 only when a thread uses them).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Thread } from "../../src/comments/contract.ts";
import {
  CommentsError,
  CommentsStore,
  elementsOf,
  type Place,
  type WalkthroughSubject,
} from "../../src/comments/store.ts";
import { findProject } from "../../src/project/index.ts";
import type { GraphModel } from "../../src/model/index.ts";
import { FLOW, removeTempDirs, tempDir } from "../project/support.ts";

afterEach(removeTempDirs);

const GRAPH: GraphModel = {
  type: "freeform-graph",
  nodes: [
    { id: "a", label: "Client" },
    { id: "b", label: "API" },
  ],
  edges: [{ id: "e1", source: "a", target: "b", label: "calls" }],
  groups: [],
};

const walk = (id: string, title: string, steps: [string, string][]): [string, WalkthroughSubject] => [
  id,
  { title, steps: steps.map(([sid, stitle]) => ({ id: sid, title: stitle })) },
];
const DECLINED = walk("declined-card", "Declined card", [
  ["the-card-is-declined", "The card is declined"],
  ["retry", "Retry"],
]);

function setup() {
  const root = tempDir({ ".archer/flow.mmd": FLOW });
  const project = findProject(root);
  const store = new CommentsStore(project);
  const place = (
    walkthroughs: [string, WalkthroughSubject][] | null = [DECLINED],
    elements = elementsOf(GRAPH),
  ): Place => ({
    target: "view:flow",
    path: "flow.comments.json",
    subject: { kind: "view", elements, walkthroughs: walkthroughs === null ? null : new Map(walkthroughs) },
  });
  const file = join(project.folder, "flow.comments.json");
  const onDisk = () => JSON.parse(readFileSync(file, "utf8")) as { version: number; threads: Thread[] };
  return { store, place, file, onDisk };
}

const stepAnchor = { kind: "step", walkthrough: "declined-card", step: "the-card-is-declined", label: "ignored" };

describe("grounding", () => {
  test("labels come from the walkthroughs file, never from the caller", () => {
    const { store, place } = setup();
    const w = store.create(place(), {
      anchor: { kind: "walkthrough", walkthrough: "declined-card", label: "lies" },
      body: "Too long.",
    });
    expect(w.value.anchor).toEqual({ kind: "walkthrough", walkthrough: "declined-card", label: "Declined card" });
    const s = store.create(place(), { anchor: stepAnchor, body: "Reword." });
    expect(s.value.anchor).toEqual({
      kind: "step",
      walkthrough: "declined-card",
      step: "the-card-is-declined",
      label: "1. The card is declined",
    });
  });

  test("an unknown walkthrough or step is refused", () => {
    const { store, place } = setup();
    expect(() =>
      store.create(place(), { anchor: { kind: "walkthrough", walkthrough: "nope", label: "" }, body: "x" }),
    ).toThrow(/no walkthrough "nope"; it has "declined-card"/);
    expect(() => store.create(place(), { anchor: { ...stepAnchor, step: "nope" }, body: "x" })).toThrow(
      /has no step "nope"/,
    );
    expect(() => store.create(place(null), { anchor: stepAnchor, body: "x" })).toThrow(/cannot be read/);
  });

  test("an element anchor keeps its context and its own grounding", () => {
    const { store, place } = setup();
    const made = store.create(place(), {
      anchor: { kind: "node", id: "a", label: "x", context: { walkthrough: "declined-card", step: "retry" } },
      body: "Why?",
    });
    expect(made.value.anchor).toEqual({
      kind: "node",
      id: "a",
      label: "Client",
      context: { walkthrough: "declined-card", step: "retry" },
    });
    expect(() =>
      store.create(place(), {
        anchor: { kind: "node", id: "zz", label: "x", context: { walkthrough: "declined-card", step: "retry" } },
        body: "x",
      }),
    ).toThrow(CommentsError);
    expect(() =>
      store.create(place(), {
        anchor: { kind: "node", id: "a", label: "x", context: { walkthrough: "Bad Id", step: "retry" } },
        body: "x",
      }),
    ).toThrow(CommentsError);
  });
});

describe("orphaning", () => {
  test("a thread survives inserting a step before it, relabelled, and is orphaned when the step is removed", () => {
    const { store, place, onDisk } = setup();
    store.create(place(), { anchor: stepAnchor, body: "Reword." });
    const inserted = walk("declined-card", "Declined card", [
      ["new", "New"],
      ["the-card-is-declined", "The card is declined"],
    ]);
    expect(store.reconcile(place([inserted]))).toBe(true);
    expect(onDisk().threads[0]).toMatchObject({ anchor: { label: "2. The card is declined" } });
    expect(onDisk().threads[0]?.orphaned).toBeUndefined();

    store.reconcile(place([walk("declined-card", "Declined card", [["new", "New"]])]));
    expect(onDisk().threads[0]).toMatchObject({ orphaned: true, anchor: { label: "2. The card is declined" } });

    store.reconcile(place());
    expect(onDisk().threads[0]?.orphaned).toBeUndefined();
  });

  test("a deleted walkthrough orphans its threads, and they are kept", () => {
    const { store, place, onDisk } = setup();
    store.create(place(), { anchor: { kind: "walkthrough", walkthrough: "declined-card", label: "" }, body: "x" });
    store.reconcile(place([]));
    expect(onDisk().threads).toHaveLength(1);
    expect(onDisk().threads[0]).toMatchObject({ orphaned: true });
  });

  test("a walkthroughs file that cannot be read leaves the thread as it is", () => {
    const { store, place, onDisk } = setup();
    store.create(place(), { anchor: stepAnchor, body: "x" });
    expect(store.reconcile(place(null))).toBe(false);
    expect(onDisk().threads[0]?.orphaned).toBeUndefined();
  });

  test("a context whose step is gone is kept as written, and the element anchor is judged alone", () => {
    const { store, place, onDisk } = setup();
    const context = { walkthrough: "declined-card", step: "retry" };
    store.create(place(), { anchor: { kind: "edge", id: "e1", label: "", context }, body: "x" });
    store.reconcile(place([]));
    expect(onDisk().threads[0]).toMatchObject({ anchor: { kind: "edge", id: "e1", label: "calls", context } });
    expect(onDisk().threads[0]?.orphaned).toBeUndefined();
  });
});

describe("file version", () => {
  test("a file stays version 2 until a walkthrough anchor or a context arrives, and drops back when none is left", () => {
    const { store, place, onDisk } = setup();
    store.create(place(), { anchor: { kind: "node", id: "a", label: "" }, body: "plain" });
    expect(onDisk().version).toBe(2);
    const s = store.create(place(), { anchor: stepAnchor, body: "step" });
    expect(onDisk().version).toBe(3);
    store.resolve(s.value.id, "person");
    expect(onDisk().version).toBe(2);
    store.create(place(), {
      anchor: { kind: "node", id: "a", label: "", context: { walkthrough: "declined-card", step: "retry" } },
      body: "ctx",
    });
    expect(onDisk().version).toBe(3);
  });

  test("a version 2 file without the new anchors round-trips byte-identical", () => {
    const { store, place, file } = setup();
    store.create(place(), { anchor: { kind: "view" }, body: "a" });
    store.create(place(), { anchor: { kind: "node", id: "a", label: "" }, body: "b" });
    store.submit();
    const before = readFileSync(file);
    expect(JSON.parse(before.toString()).version).toBe(2);
    expect(store.reconcile(place())).toBe(false);
    expect(store.submit().submitted).toBe(0);
    expect(readFileSync(file).equals(before)).toBe(true);
    // A rewrite from the parsed content (what any change does) yields the same bytes.
    writeFileSync(file, `${JSON.stringify(JSON.parse(before.toString()), null, 2)}\n`);
    expect(readFileSync(file).equals(before)).toBe(true);
  });
});
