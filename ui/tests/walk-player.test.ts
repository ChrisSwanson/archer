// The walkthrough player's reducer (ADR 0034 §6): pure, so every action and the wheel rule are
// enumerated here rather than read off a rendered panel.
import { describe, expect, it } from "vitest";
import {
  INITIAL_WALK,
  stepStates,
  wheelStep,
  walkReducer,
  type WalkAction,
  type WalkState,
  WHEEL_REST_MS,
} from "../src/walkthroughs/walk-player";

const run = (actions: readonly WalkAction[], from: WalkState = INITIAL_WALK): WalkState =>
  actions.reduce(walkReducer, from);
const open = (id = "checkout", count = 8, step?: number): WalkAction => ({
  type: "open",
  id,
  count,
  ...(step === undefined ? {} : { step }),
});

describe("step states", () => {
  it("step 3 of 8 gives done = steps 1-2, active = 3, the rest future, and End then stays at 8", () => {
    expect(stepStates(3, 8)).toEqual(["done", "done", "active", "future", "future", "future", "future", "future"]);
    const state = run([open(), { type: "go", to: 3 }, { type: "go", to: "last" }, { type: "go", to: "next" }]);
    expect(state.step).toBe(8);
    expect(stepStates(state.step, 8).filter((s) => s === "active")).toHaveLength(1);
  });
});

describe("actions", () => {
  it("show opens the panel on the list with nothing chosen", () => {
    expect(run([{ type: "show" }])).toMatchObject({ open: true, id: null, playing: false });
  });

  it("open starts at step 1 (or the asked step, clamped) and stops any play", () => {
    expect(run([open()])).toMatchObject({ open: true, id: "checkout", step: 1, count: 8 });
    expect(run([open("a", 8, 3)]).step).toBe(3);
    expect(run([open("a", 8, 99)]).step).toBe(8);
    expect(run([open("a", 8, 0)]).step).toBe(1);
    expect(run([open(), { type: "play" }, open("b", 4)]).playing).toBe(false);
  });

  it("go moves by name or number, clamped to 1..count, and does nothing without a walkthrough", () => {
    expect(run([open(), { type: "go", to: "next" }, { type: "go", to: "next" }]).step).toBe(3);
    expect(run([open(), { type: "go", to: "prev" }]).step).toBe(1);
    expect(run([open(), { type: "go", to: "last" }]).step).toBe(8);
    expect(run([open(), { type: "go", to: "last" }, { type: "go", to: "first" }]).step).toBe(1);
    expect(run([open(), { type: "go", to: 0 }]).step).toBe(1);
    expect(run([open(), { type: "go", to: 12 }]).step).toBe(8);
    expect(run([{ type: "show" }, { type: "go", to: "next" }])).toEqual(run([{ type: "show" }]));
  });

  it("a person's step pauses play", () => {
    expect(run([open(), { type: "play" }, { type: "go", to: "next" }]).playing).toBe(false);
  });

  it("play advances on tick and stops at the end", () => {
    const playing = run([open("a", 3), { type: "play" }]);
    expect(playing.playing).toBe(true);
    const mid = run([{ type: "tick" }], playing);
    expect(mid).toMatchObject({ step: 2, playing: true });
    const end = run([{ type: "tick" }], mid);
    expect(end).toMatchObject({ step: 3, playing: false });
    expect(run([{ type: "tick" }], end)).toEqual(end);
  });

  it("play at the last step starts again from step 1", () => {
    expect(run([open("a", 3), { type: "go", to: "last" }, { type: "play" }])).toMatchObject({ step: 1, playing: true });
  });

  it("pause and close", () => {
    expect(run([open(), { type: "play" }, { type: "pause" }]).playing).toBe(false);
    expect(run([open(), { type: "play" }, { type: "close" }])).toEqual(INITIAL_WALK);
  });

  it("a revision change keeps the step, clamps it, or returns to the list when the walkthrough is gone", () => {
    const at5 = run([open("a", 8), { type: "go", to: 5 }]);
    expect(run([{ type: "revision", counts: new Map([["a", 8]]) }], at5).step).toBe(5);
    expect(run([{ type: "revision", counts: new Map([["a", 4]]) }], at5)).toMatchObject({ step: 4, count: 4 });
    expect(run([{ type: "revision", counts: new Map([["b", 4]]) }], at5)).toMatchObject({
      open: true,
      id: null,
      playing: false,
    });
    const playingAtEnd = run([open("a", 8), { type: "play" }, { type: "revision", counts: new Map([["a", 1]]) }]);
    expect(playingAtEnd).toMatchObject({ step: 1, playing: false });
  });

  it("a revision change leaves a closed player closed", () => {
    expect(run([{ type: "revision", counts: new Map() }])).toEqual(INITIAL_WALK);
  });
});

describe("wheel", () => {
  const notch = (state: ReturnType<typeof wheelStep>["state"], dy: number, now: number) =>
    wheelStep(state, { dy, now });
  const fresh = wheelStep({ acc: 0, lastWheel: 0, lastStep: 0 }, { dy: 0, now: 0 }).state;

  it("one notch is one step, down forward and up back", () => {
    expect(notch(fresh, 100, 1000).delta).toBe(1);
    expect(notch(fresh, -100, 1000).delta).toBe(-1);
  });

  it("small deltas accumulate to a step", () => {
    const a = notch(fresh, 12, 1000);
    expect(a.delta).toBe(0);
    const b = notch(a.state, 12, 1010);
    expect(b.delta).toBe(0);
    expect(notch(b.state, 12, 1020).delta).toBe(1);
  });

  it("a fling is one step: events inside the rest are ignored", () => {
    let s = notch(fresh, 100, 1000);
    let steps = s.delta;
    for (let t = 1010; t < 1000 + WHEEL_REST_MS - 10; t += 10) {
      s = notch(s.state, 100, t);
      steps += s.delta;
    }
    expect(steps).toBe(1);
  });

  it("a second notch after a pause is a second step", () => {
    const first = notch(fresh, 100, 1000);
    expect(notch(first.state, 100, 1000 + 200).delta).toBe(1);
  });

  it("accumulation starts over after a quiet gap", () => {
    const a = notch(fresh, 20, 1000);
    expect(notch(a.state, 20, 1500).delta).toBe(0);
  });
});
