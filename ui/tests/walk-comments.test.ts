// Comments on walkthroughs, the pure half (ADR 0034 §9, page): what the page reads of the new anchors,
// what it says of them, and how a walkthrough's state becomes anchors, context, picker choices and
// the count on a step row.
import { describe, expect, it } from "vitest";
import { parseAnchor, parseThreadList } from "../src/comments/parse";
import { anchorLabel, commentPins } from "../src/comments/state";
import {
  contextOf,
  defaultAnchor,
  stepAnchor,
  stepBadges,
  walkAnchor,
  walkChoices,
  walkFacts,
  withContext,
} from "../src/comments/walk-anchors";
import { parseWalkthroughs } from "../src/walkthroughs/parse";
import type { Walk, WalkStep } from "../src/walkthroughs/contract";
import type { Anchor, Thread } from "../src/comments/contract";

const step = (id: string, title: string, over: Partial<WalkStep> = {}): WalkStep => ({
  id,
  title,
  kind: "sends",
  what: "w",
  code: [],
  nodes: [],
  edges: [],
  messages: [],
  status: "current",
  ...over,
});
const declined: Walk = {
  id: "declined-card",
  title: "Declined card",
  modelRevision: "sha256:1",
  open: [],
  status: "current",
  outOfDate: [],
  steps: [
    step("amira-checks-out", "Amira checks out"),
    step("the-card-is-declined", "The card is declined"),
    step("try-another-card", "Try another card"),
  ],
};
const archived: Walk = {
  ...declined,
  id: "old",
  title: "Old",
  status: "archived",
  steps: declined.steps.map((s) => ({ ...s, status: "out-of-date" as const })),
};
const thread = (
  id: string,
  anchor: Anchor,
  status: Thread["status"] = "draft",
  over: Partial<Thread> = {},
): Thread => ({
  id,
  target: "view:alpha",
  anchor,
  status,
  revision: 1,
  comments: [{ id: `${id}-c`, author: "person", body: "b", createdAt: "2026-10-23T10:00:00.000Z" }],
  ...over,
});
const STEP: Anchor = {
  kind: "step",
  walkthrough: "declined-card",
  step: "the-card-is-declined",
  label: "2. The card is declined",
};

describe("the step id", () => {
  it("is read off the wire, and a step without one leaves its walkthrough out", () => {
    const wire = (id: unknown) => ({
      schemaVersion: 1,
      viewId: "v",
      walkthroughs: [
        {
          id: "w",
          title: "W",
          modelRevision: "r",
          steps: [{ ...(id === undefined ? {} : { id }), title: "Ask", kind: "sends", what: "x" }],
        },
      ],
      resolution: null,
    });
    expect(parseWalkthroughs(wire("ask"))?.walks[0]?.steps[0]?.id).toBe("ask");
    expect(parseWalkthroughs(wire(undefined))?.walks).toEqual([]);
  });
});

describe("reading the anchors", () => {
  it("reads a walkthrough and a step anchor", () => {
    expect(parseAnchor({ kind: "walkthrough", walkthrough: "declined-card", label: "Declined card" })).toEqual({
      kind: "walkthrough",
      walkthrough: "declined-card",
      label: "Declined card",
    });
    expect(parseAnchor(STEP)).toEqual(STEP);
    expect(parseAnchor({ kind: "step", walkthrough: "declined-card", label: "x" })).toBeUndefined();
  });

  it("keeps the context on an element, and reads none as none", () => {
    const context = { walkthrough: "declined-card", step: "the-card-is-declined" };
    expect(parseAnchor({ kind: "node", id: "api", label: "API", context })).toEqual({
      kind: "node",
      id: "api",
      label: "API",
      context,
    });
    expect(parseAnchor({ kind: "edge", id: "e", label: "E", context })).toMatchObject({ context });
    expect(parseAnchor({ kind: "group", id: "g", label: "G", context })).toMatchObject({ context });
    expect(parseAnchor({ kind: "selection", nodes: [], edges: [{ id: "e", label: "E" }], context })).toMatchObject({
      context,
    });
    expect(parseAnchor({ kind: "node", id: "api", label: "API" })).toEqual({ kind: "node", id: "api", label: "API" });
    expect(parseAnchor({ kind: "node", id: "api", label: "API", context: { walkthrough: "x" } })).toBeUndefined();
  });

  it("drops a thread it cannot read and keeps the rest", () => {
    const list = {
      schemaVersion: 2,
      target: "view:alpha",
      threads: [
        thread("a", STEP),
        { ...thread("b", STEP), anchor: { kind: "teleport" } },
        thread("c", { kind: "view" }),
      ],
    };
    expect(parseThreadList(list)?.threads.map((t) => t.id)).toEqual(["a", "c"]);
  });
});

describe("saying them", () => {
  it("names a step and a walkthrough as the prototype does", () => {
    expect(anchorLabel(STEP, "view")).toBe("Step 2 · The card is declined");
    expect(anchorLabel({ kind: "walkthrough", walkthrough: "declined-card", label: "Declined card" }, "view")).toBe(
      "This walkthrough · Declined card",
    );
    expect(anchorLabel({ kind: "step", walkthrough: "w", step: "s", label: "" }, "view")).toBe("Step · s");
  });
});

describe("pins", () => {
  it("numbers only what sits on an element, so step and walkthrough threads leave no gap", () => {
    const pins = commentPins([
      thread("a", STEP),
      thread("b", {
        kind: "node",
        id: "api",
        label: "API",
        context: { walkthrough: "declined-card", step: "the-card-is-declined" },
      }),
      thread("c", walkAnchor(declined)),
    ]);
    expect([...pins.numbers]).toEqual([["b", 1]]);
    expect([...pins.nodePins.keys()]).toEqual(["api"]);
  });
});

describe("anchors from the open walkthrough", () => {
  it("builds the step's and the walkthrough's, labelled as Archer writes them", () => {
    expect(stepAnchor(declined, 2)).toEqual(STEP);
    expect(walkAnchor(declined)).toEqual({ kind: "walkthrough", walkthrough: "declined-card", label: "Declined card" });
  });

  it("gives an element the context of the step being seen, and nothing else", () => {
    expect(contextOf(declined, 2)).toEqual({ walkthrough: "declined-card", step: "the-card-is-declined" });
    expect(withContext({ kind: "node", id: "api", label: "API" }, contextOf(declined, 2))).toEqual({
      kind: "node",
      id: "api",
      label: "API",
      context: { walkthrough: "declined-card", step: "the-card-is-declined" },
    });
    expect(withContext({ kind: "view" }, contextOf(declined, 2))).toEqual({ kind: "view" });
    expect(withContext(STEP, contextOf(declined, 2))).toEqual(STEP);
    expect(withContext({ kind: "node", id: "api", label: "API" }, null)).toEqual({
      kind: "node",
      id: "api",
      label: "API",
    });
  });

  it("has no context for an archived walkthrough, which is not stepped, or no walkthrough", () => {
    expect(contextOf(archived, 1)).toBeNull();
    expect(contextOf(null, 1)).toBeNull();
    expect(contextOf(declined, 9)).toBeNull();
  });

  it("offers the selection (with context), the walkthrough, the step, then the whole diagram and the rest", () => {
    const whole: Anchor = { kind: "view" };
    const base = [
      { anchor: { kind: "node", id: "api", label: "API" } as Anchor, label: "Node: API" },
      { anchor: whole, label: "Whole diagram" },
    ];
    const choices = walkChoices(base, declined, 2);
    expect(choices.map((c) => c.label)).toEqual([
      "Node: API",
      "This walkthrough · Declined card",
      "Step 2 · The card is declined",
      "Whole diagram",
    ]);
    expect(choices[0]!.anchor).toMatchObject({ context: { step: "the-card-is-declined" } });
    expect(walkChoices([base[1]!], declined, 2).map((c) => c.label)).toEqual([
      "This walkthrough · Declined card",
      "Step 2 · The card is declined",
      "Whole diagram",
    ]);
    expect(walkChoices(base, null, 1)).toBe(base);
  });
});

describe("the default target", () => {
  it("is the selection with its step, the walkthrough when nothing is selected, the diagram with none open", () => {
    const node: Anchor = { kind: "node", id: "api", label: "API" };
    expect(defaultAnchor(node, declined, 2)).toEqual({
      ...node,
      context: { walkthrough: "declined-card", step: "the-card-is-declined" },
    });
    expect(defaultAnchor({ kind: "view" }, declined, 2)).toEqual(walkAnchor(declined));
    expect(defaultAnchor({ kind: "view" }, null, 1)).toEqual({ kind: "view" });
    expect(defaultAnchor(node, null, 1)).toBe(node);
    expect(defaultAnchor(node, archived, 1)).toBe(node);
  });
});

describe("what a thread says of its walkthrough", () => {
  it("names the step's number now, and what is wrong with it", () => {
    expect(walkFacts(STEP, [declined])).toEqual({
      walkthrough: "declined-card",
      title: "Declined card",
      step: "the-card-is-declined",
      number: 2,
      state: "ok",
    });
    const stale = {
      ...declined,
      steps: declined.steps.map((s, i) => (i === 1 ? { ...s, status: "out-of-date" as const } : s)),
    };
    expect(walkFacts(STEP, [stale])).toMatchObject({ number: 2, state: "out-of-date" });
    expect(
      walkFacts({ kind: "step", walkthrough: "old", step: "the-card-is-declined", label: "2. x" }, [archived]),
    ).toMatchObject({ state: "archived" });
    expect(walkFacts(STEP, [])).toMatchObject({ state: "gone", title: "declined-card" });
    expect(walkFacts({ ...STEP, step: "removed" }, [declined])).toEqual({
      walkthrough: "declined-card",
      title: "Declined card",
      step: "removed",
      state: "gone",
    });
  });

  it("reads an element's context too, and a walkthrough anchor has no step", () => {
    expect(
      walkFacts(
        { kind: "node", id: "api", label: "API", context: { walkthrough: "declined-card", step: "try-another-card" } },
        [declined],
      ),
    ).toMatchObject({ number: 3, state: "ok" });
    expect(walkFacts({ kind: "node", id: "api", label: "API" }, [declined])).toBeNull();
    expect(walkFacts({ kind: "walkthrough", walkthrough: "declined-card", label: "x" }, [declined])).toEqual({
      walkthrough: "declined-card",
      title: "Declined card",
      state: "ok",
    });
    expect(walkFacts({ kind: "walkthrough", walkthrough: "old", label: "x" }, [archived])).toMatchObject({
      state: "archived",
    });
  });
});

describe("the count on a step row", () => {
  it("opens the thread that most needs the person, whichever came first", () => {
    const at = (threads: Thread[]) => stepBadges(threads, "declined-card").get("the-card-is-declined");
    expect(at([thread("a", STEP, "resolved"), thread("b", STEP, "answered"), thread("c", STEP, "sent")])?.thread).toBe(
      "c",
    );
    expect(at([thread("a", STEP, "sent"), thread("b", STEP, "draft")])).toMatchObject({ thread: "b", state: "draft" });
    expect(at([thread("a", STEP, "draft"), thread("b", STEP, "draft")])?.thread).toBe("a");
  });
  it("styles a plain chip (a span, not a control) as text, not as a button", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const rule = /\.archer-thread-chip\[data-plain\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/border:\s*(0|none)/);
    expect(rule).toMatch(/padding:\s*0/);
    expect(rule).not.toMatch(/color:\s*var\(--you\)/);
  });
  it("counts the walkthrough's live step threads, in the state that most needs the person", () => {
    const badges = stepBadges(
      [
        thread("a", STEP, "sent"),
        thread("b", STEP, "draft"),
        thread("c", { ...STEP, step: "try-another-card" }, "answered"),
        thread("d", { ...STEP, walkthrough: "other" }, "draft"),
        thread("e", STEP, "draft", { orphaned: true }),
        thread("f", {
          kind: "node",
          id: "api",
          label: "API",
          context: { walkthrough: "declined-card", step: "the-card-is-declined" },
        }),
      ],
      "declined-card",
    );
    expect([...badges]).toEqual([
      ["the-card-is-declined", { count: 2, state: "draft", thread: "b" }],
      ["try-another-card", { count: 1, state: "answered", thread: "c" }],
    ]);
  });
});
