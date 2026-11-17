import { describe, expect, it } from "vitest";
import {
  activeHeadingId,
  buildTocTree,
  initialTocState,
  isOpen,
  type TocHeading,
  tocReducer,
} from "../../../site/.vitepress/theme/toc.mts";

// The shape the CLI reference will take: h2 = command, h3 = subcommand, h4 = an option group.
const headings: TocHeading[] = [
  { id: "overview", level: 2, title: "Overview" },
  { id: "emphasis", level: 2, title: "emphasis" },
  { id: "emphasis-list", level: 3, title: "emphasis list" },
  { id: "emphasis-set", level: 3, title: "emphasis set" },
  { id: "emphasis-set-input", level: 4, title: "Input" },
  { id: "emphasis-set-output", level: 4, title: "Output" },
  { id: "emphasis-clear", level: 3, title: "emphasis clear" },
  { id: "walkthrough", level: 2, title: "walkthrough" },
  { id: "walkthrough-list", level: 3, title: "walkthrough list" },
  { id: "walkthrough-show", level: 3, title: "walkthrough show" },
];
const tree = buildTocTree(headings);
const scroll = (id: string | null) => ({ type: "scroll", id }) as const;
const toggle = (id: string) => ({ type: "toggle", id }) as const;
const openIds = (state: ReturnType<typeof initialTocState>) =>
  headings.map((h) => h.id).filter((id) => isOpen(state, id));

describe("buildTocTree", () => {
  it("nests h3 under h2 and h4 under h3", () => {
    expect(tree.map((n) => n.id)).toEqual(["overview", "emphasis", "walkthrough"]);
    expect(tree[1]!.children.map((n) => n.id)).toEqual(["emphasis-list", "emphasis-set", "emphasis-clear"]);
    expect(tree[1]!.children[1]!.children.map((n) => n.id)).toEqual(["emphasis-set-input", "emphasis-set-output"]);
  });

  it("keeps headings outside the range out, and lifts an orphan h3 to the top level", () => {
    const shaped = buildTocTree([
      { id: "lead", level: 3, title: "Lead" },
      { id: "a", level: 2, title: "A" },
      { id: "deep", level: 5, title: "Too deep" },
      { id: "a1", level: 3, title: "A1" },
    ]);
    expect(shaped.map((n) => n.id)).toEqual(["lead", "a"]);
    expect(shaped[1]!.children.map((n) => n.id)).toEqual(["a1"]);
    expect(shaped[1]!.children[0]!.children).toEqual([]);
  });
});

describe("activeHeadingId", () => {
  const positions = [
    { id: "overview", top: 100 },
    { id: "emphasis", top: 900 },
    { id: "emphasis-list", top: 1300 },
    { id: "walkthrough", top: 2600 },
  ];
  const view = { offset: 64, viewportHeight: 800, documentHeight: 4000 };

  it("is none at the very top of the page", () => {
    expect(activeHeadingId(positions, { ...view, scrollY: 0 })).toBeNull();
  });

  it("is the last heading at or above the reading line (scroll plus the fixed nav offset)", () => {
    expect(activeHeadingId(positions, { ...view, scrollY: 50 })).toBe("overview");
    expect(activeHeadingId(positions, { ...view, scrollY: 900 - 64 })).toBe("emphasis");
    expect(activeHeadingId(positions, { ...view, scrollY: 1250 })).toBe("emphasis-list");
  });

  it("is the last heading once the page is scrolled to its bottom, even if it cannot reach the top", () => {
    expect(activeHeadingId(positions, { ...view, scrollY: 4000 - 800 })).toBe("walkthrough");
  });

  it("ignores headings with no position (hidden) and sorts by position", () => {
    expect(
      activeHeadingId(
        [
          { id: "b", top: 500 },
          { id: "hidden", top: Number.NaN },
          { id: "a", top: 200 },
        ],
        { ...view, scrollY: 300 },
      ),
    ).toBe("a");
  });
});

describe("tocReducer", () => {
  it("starts with everything collapsed and nothing active", () => {
    const state = initialTocState();
    expect(state.active).toBeNull();
    expect(openIds(state)).toEqual([]);
  });

  it("expands the h2 the reader scrolls into and collapses the others", () => {
    let state = tocReducer(tree, initialTocState(), scroll("emphasis"));
    expect(state.active).toBe("emphasis");
    expect(openIds(state)).toEqual(["emphasis"]);
    state = tocReducer(tree, state, scroll("walkthrough-list"));
    expect(state.active).toBe("walkthrough-list");
    expect(openIds(state)).toEqual(["walkthrough"]);
  });

  it("drills down: an active h4 opens its h3 and the h2 above it", () => {
    const state = tocReducer(tree, initialTocState(), scroll("emphasis-set-output"));
    expect(openIds(state)).toEqual(["emphasis", "emphasis-set"]);
  });

  it("an active h3 with h4 children opens too", () => {
    const state = tocReducer(tree, initialTocState(), scroll("emphasis-set"));
    expect(openIds(state)).toEqual(["emphasis", "emphasis-set"]);
  });

  it("a leaf h2 opens nothing", () => {
    expect(openIds(tocReducer(tree, initialTocState(), scroll("overview")))).toEqual([]);
  });

  it("opening a collapsed h2 by its button collapses the open one (accordion)", () => {
    let state = tocReducer(tree, initialTocState(), scroll("emphasis-set"));
    state = tocReducer(tree, state, toggle("walkthrough"));
    expect(openIds(state)).toEqual(["walkthrough"]);
    expect(state.active).toBe("emphasis-set"); // Toggling expands; it does not move the reader.
  });

  it("closing an open h2 by its button also closes its open descendants", () => {
    let state = tocReducer(tree, initialTocState(), scroll("emphasis-set-input"));
    state = tocReducer(tree, state, toggle("emphasis"));
    expect(openIds(state)).toEqual([]);
    state = tocReducer(tree, state, toggle("emphasis"));
    expect(openIds(state)).toEqual(["emphasis"]);
  });

  it("an h3 button opens it inside its h2 and collapses other sections", () => {
    let state = tocReducer(tree, initialTocState(), scroll("walkthrough"));
    state = tocReducer(tree, state, toggle("emphasis-set"));
    expect(openIds(state)).toEqual(["emphasis", "emphasis-set"]);
  });

  it("keeps a reader's toggle while the active heading is unchanged, and resets when it changes", () => {
    let state = tocReducer(tree, initialTocState(), scroll("emphasis-list"));
    state = tocReducer(tree, state, toggle("walkthrough"));
    state = tocReducer(tree, state, scroll("emphasis-list"));
    expect(openIds(state)).toEqual(["walkthrough"]);
    state = tocReducer(tree, state, scroll("emphasis-set"));
    expect(openIds(state)).toEqual(["emphasis", "emphasis-set"]);
  });

  it("navigating to a collapsed h2 makes it active and expands it, even if it was already active", () => {
    let state = tocReducer(tree, initialTocState(), scroll("emphasis-list"));
    state = tocReducer(tree, state, { type: "navigate", id: "walkthrough" });
    expect(state.active).toBe("walkthrough");
    expect(openIds(state)).toEqual(["walkthrough"]);
    state = tocReducer(tree, state, toggle("walkthrough"));
    state = tocReducer(tree, state, { type: "navigate", id: "walkthrough" });
    expect(openIds(state)).toEqual(["walkthrough"]);
  });

  it("scrolling back above the first heading collapses everything", () => {
    let state = tocReducer(tree, initialTocState(), scroll("emphasis-list"));
    state = tocReducer(tree, state, scroll(null));
    expect(state.active).toBeNull();
    expect(openIds(state)).toEqual([]);
  });

  it("ignores an unknown id rather than losing the reader's place", () => {
    const state = tocReducer(tree, initialTocState(), scroll("emphasis-list"));
    expect(tocReducer(tree, state, toggle("nope"))).toBe(state);
    expect(tocReducer(tree, state, scroll("nope"))).toBe(state);
  });

  it("reports which collapsed section holds the reader", () => {
    let state = tocReducer(tree, initialTocState(), scroll("emphasis-set-input"));
    state = tocReducer(tree, state, toggle("emphasis"));
    expect(state.trail).toEqual(["emphasis", "emphasis-set", "emphasis-set-input"]);
  });
});
