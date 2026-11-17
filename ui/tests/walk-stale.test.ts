// What the page says of a walkthrough that no longer matches the diagram (ADR 0034 §3, slice 7b):
// status in, words and playable copy out. Pure; the wording is the approved prototype's.
import { describe, expect, it } from "vitest";
import type { Walk, WalkStep } from "../src/walkthroughs/contract";
import { canvasNote, dayLabel, flagNotice, oldMark, playableOld, wasLine } from "../src/walkthroughs/walk-stale";

const step = (title: string, over: Partial<WalkStep> = {}): WalkStep => ({
  id: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
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
const walk = (over: Partial<Walk> = {}): Walk => ({
  id: "w",
  title: "W",
  modelRevision: "sha256:1",
  open: [],
  status: "partly-out-of-date",
  outOfDate: [2],
  steps: [
    step("a"),
    step("b", {
      status: "out-of-date",
      missing: ["Browser", "Payment page"],
      edges: [{ id: "x", source: "x", target: "y" }],
    }),
    step("c"),
  ],
  ...over,
});

describe("dayLabel", () => {
  it("is the day and month in UTC, and the year only when it is not this one", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    expect(dayLabel("2026-08-12T23:30:00Z", now)).toBe("12 Aug");
    expect(dayLabel("2025-08-12T10:00:00Z", now)).toBe("12 Aug 2025");
  });
  it("is empty for a date that does not read", () => {
    expect(dayLabel("not a date")).toBe("");
  });
});

describe("wasLine", () => {
  it("says what the step used to point at", () => {
    expect(wasLine(walk().steps[1]!)).toBe("Was Browser and Payment page, which is no longer in this diagram.");
  });
  it("says so plainly when the labels were not kept, and nothing for a step that still matches", () => {
    expect(wasLine(step("b", { status: "out-of-date" }))).toBe(
      "What this step pointed at is no longer in this diagram.",
    );
    expect(wasLine(step("a"))).toBeNull();
  });
});

describe("flagNotice", () => {
  it("tells that the agent was flagged, how many steps, when the diagram changed and how many still match", () => {
    expect(flagNotice(walk(), "2026-10-18T09:00:00Z", new Date("2026-10-23T00:00:00Z"))).toEqual({
      lead: "Archer flagged this to the agent: 1 step out of date.",
      rest: "The diagram changed on 18 Oct; the other 2 steps still match.",
    });
  });
  it("leaves the date out when it is not known", () => {
    expect(flagNotice(walk({ outOfDate: [1, 2] }), undefined)).toEqual({
      lead: "Archer flagged this to the agent: 2 steps out of date.",
      rest: "The diagram changed; the other 1 step still matches.",
    });
  });
});

describe("canvasNote", () => {
  it("names an out-of-date current step, with its line", () => {
    expect(canvasNote(walk(), 2)).toEqual({
      lead: "Step 2 is out of date.",
      rest: "Its line is no longer in this diagram.",
    });
  });
  it("says nothing for a step that matches, or on an archived walkthrough", () => {
    expect(canvasNote(walk(), 1)).toBeNull();
    expect(canvasNote(walk({ status: "archived" }), 2)).toBeNull();
  });
});

describe("playableOld", () => {
  it("is the walkthrough with every step matching, current and marked old, so the player plays it", () => {
    const old = playableOld(
      walk({
        status: "archived",
        outOfDate: [1, 2, 3],
        steps: walk().steps.map((s) => ({ ...s, status: "out-of-date" as const })),
      }),
    );
    expect(old).toMatchObject({ status: "current", outOfDate: [], old: true });
    expect(old.steps.map((s) => s.status)).toEqual(["current", "current", "current"]);
  });
});

describe("oldMark", () => {
  it("is the marker on the canvas", () => {
    expect(oldMark("2026-08-12T10:00:00Z", new Date("2026-10-23T00:00:00Z"))).toBe("Old version · 12 Aug");
  });
});
