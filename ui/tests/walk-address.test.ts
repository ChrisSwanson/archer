// @vitest-environment jsdom
// The walkthrough's place in the address (ADR 0034 §6): ?walkthrough=<id>&step=<n>, read when a
// diagram is opened and kept current with replaceState: no history entries, other parameters kept.
import { afterEach, describe, expect, it } from "vitest";
import { readWalkAddress, withWalkAddress, writeWalkAddress } from "../src/walkthroughs/walk-address";

describe("reading", () => {
  it("?walkthrough=declined-card&step=3 names step 3", () => {
    expect(readWalkAddress("?walkthrough=declined-card&step=3")).toEqual({ id: "declined-card", step: 3 });
  });
  it("a missing or bad step is step 1; a bad or missing id is nothing", () => {
    expect(readWalkAddress("?walkthrough=ask")).toEqual({ id: "ask", step: 1 });
    for (const step of ["0", "-2", "x", "1.5", "99999999", ""])
      expect(readWalkAddress(`?walkthrough=ask&step=${step}`)).toEqual({ id: "ask", step: 1 });
    for (const search of [
      "",
      "?step=3",
      "?walkthrough=",
      "?walkthrough=Ask",
      "?walkthrough=a%20b",
      "?walkthrough=-a",
      `?walkthrough=${"a".repeat(49)}`,
    ])
      expect(readWalkAddress(search)).toBeNull();
  });
});

describe("writing", () => {
  const base = "https://h.example/projects/p/diagrams/flow?zoom=full&open=a,b#frag";
  it("sets both, keeping the other parameters and the fragment; and removes both", () => {
    const set = withWalkAddress(base, { id: "ask", step: 2 });
    const url = new URL(set);
    expect([
      url.searchParams.get("walkthrough"),
      url.searchParams.get("step"),
      url.searchParams.get("zoom"),
      url.searchParams.get("open"),
      url.hash,
    ]).toEqual(["ask", "2", "full", "a,b", "#frag"]);
    expect(withWalkAddress(set, null)).toBe(base);
    expect(withWalkAddress(base, null)).toBe(base);
  });
});

describe("an archived or old-version walkthrough", () => {
  it("is linked by its id alone: it has no step to return to", () => {
    expect(withWalkAddress("http://x/p/flow?zoom=full&walkthrough=ask&step=3", { id: "pay" })).toBe(
      "http://x/p/flow?zoom=full&walkthrough=pay",
    );
    expect(readWalkAddress("?walkthrough=pay")).toEqual({ id: "pay", step: 1 });
  });
});

describe("the live address", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));
  it("replaces the entry: history.length never moves, and closing removes the parameters", () => {
    window.history.replaceState(null, "", "/p/flow?zoom=full");
    const length = window.history.length;
    writeWalkAddress({ id: "ask", step: 1 });
    writeWalkAddress({ id: "ask", step: 3 });
    expect(window.location.search).toBe("?zoom=full&walkthrough=ask&step=3");
    writeWalkAddress(null);
    expect(window.location.search).toBe("?zoom=full");
    expect(window.history.length).toBe(length);
  });
});
