/**
 * What the page is showing, out of what the agent has stored.
 *
 * Two facts, not one: the stored LIST is the agent's (it arrives whole on every
 * change), and which member is ACTIVE is partly the user's -- they can pick a
 * chip, or dismiss the one that is up. Collapsing the two would mean either the
 * agent's next publish silently undoes a dismissal, or a dismissal outlives the
 * agent's next statement. Both are wrong, so they are kept apart.
 */
import { describe, expect, it } from "vitest";
import { parseEmphasisSnapshot, type EmphasisSnapshot } from "../src/emphasis/contract";
import { activeEmphasis, emphasisReducer, initialEmphasisState, type EmphasisStoreState } from "../src/emphasis/state";

const VIEW = "system-context";

function payload(id: string, viewId = VIEW): unknown {
  return {
    id,
    viewId,
    title: id,
    groups: [
      {
        id: "g",
        style: "highlight",
        palette: "teal",
        label: id,
        nodes: ["repo"],
      },
    ],
  };
}

function snapshot(ids: readonly string[], viewId = VIEW): EmphasisSnapshot {
  const parsed = parseEmphasisSnapshot({
    schemaVersion: 1,
    viewId,
    emphases: ids.map((id) => payload(id, viewId)),
  });
  expect(parsed, "the fixture is not a readable snapshot").toBeDefined();
  return parsed!;
}

function onView(viewId: string | null = VIEW): EmphasisStoreState {
  return emphasisReducer(initialEmphasisState(), { type: "view_change", viewId });
}

function publish(state: EmphasisStoreState, ids: readonly string[], viewId = VIEW): EmphasisStoreState {
  return emphasisReducer(state, { type: "publish", snapshot: snapshot(ids, viewId) });
}

describe("the stored list", () => {
  it("starts with nothing stored and nothing active", () => {
    const state = initialEmphasisState();

    expect(state.emphases).toEqual([]);
    expect(activeEmphasis(state)).toBeNull();
  });

  it("takes the published list whole, oldest-first", () => {
    const state = publish(onView(), ["write-path", "read-path"]);

    expect(state.emphases.map((e) => e.id)).toEqual(["write-path", "read-path"]);
  });

  // The agent just pointed at something. Requiring a click to see it would make
  // `set_emphasis` a tool that does nothing until the user helps.
  it("shows a newly arrived emphasis without being asked", () => {
    const state = publish(onView(), ["write-path"]);

    expect(activeEmphasis(state)?.id).toBe("write-path");
  });

  it("moves to the newest when several arrive at once", () => {
    const state = publish(onView(), ["write-path", "read-path"]);

    expect(activeEmphasis(state)?.id).toBe("read-path");
  });

  it("leaves the user's pick alone when the list is republished unchanged", () => {
    let state = publish(onView(), ["write-path", "read-path"]);
    state = emphasisReducer(state, { type: "select", id: "write-path" });

    state = publish(state, ["write-path", "read-path"]);

    expect(activeEmphasis(state)?.id).toBe("write-path");
  });

  it("drops the active one when the agent stops storing it", () => {
    let state = publish(onView(), ["write-path"]);
    state = publish(state, ["read-path"]);

    // A new arrival, so it takes over -- but the point is the gone one is gone.
    expect(state.emphases.map((e) => e.id)).toEqual(["read-path"]);
    expect(activeEmphasis(state)?.id).toBe("read-path");
  });

  it("shows nothing once the agent's list is empty", () => {
    let state = publish(onView(), ["write-path"]);
    state = publish(state, []);

    expect(state.emphases).toEqual([]);
    expect(activeEmphasis(state)).toBeNull();
  });

  it("reads an emphasis whose only group is empty as a cleared canvas", () => {
    const cleared = parseEmphasisSnapshot({
      schemaVersion: 1,
      viewId: VIEW,
      emphases: [{ id: "write-path", viewId: VIEW, title: "", groups: [] }],
    })!;
    const state = emphasisReducer(onView(), { type: "publish", snapshot: cleared });

    expect(activeEmphasis(state)?.groups).toEqual([]);
  });
});

describe("picking and dismissing", () => {
  it("applies the emphasis a chip names", () => {
    let state = publish(onView(), ["write-path", "read-path"]);
    state = emphasisReducer(state, { type: "select", id: "write-path" });

    expect(activeEmphasis(state)?.id).toBe("write-path");
  });

  it("clears when the active one is picked again", () => {
    let state = publish(onView(), ["write-path"]);
    state = emphasisReducer(state, { type: "select", id: "write-path" });

    expect(activeEmphasis(state)).toBeNull();
    // Dismissed, not deleted: the chip is still there to pick up again.
    expect(state.emphases.map((e) => e.id)).toEqual(["write-path"]);
  });

  it("ignores a pick naming nothing that is stored", () => {
    let state = publish(onView(), ["write-path"]);
    state = emphasisReducer(state, { type: "select", id: "never-published" });

    expect(activeEmphasis(state)?.id).toBe("write-path");
  });

  it("keeps a dismissal until the agent says something new", () => {
    let state = publish(onView(), ["write-path"]);
    state = emphasisReducer(state, { type: "select", id: "write-path" });
    state = publish(state, ["write-path"]);

    expect(activeEmphasis(state)).toBeNull();

    state = publish(state, ["write-path", "read-path"]);
    expect(activeEmphasis(state)?.id).toBe("read-path");
  });
});

describe("emphasis belongs to one view", () => {
  it("ignores a snapshot for a view that is not on screen", () => {
    const state = publish(onView(VIEW), ["elsewhere"], "request-flow");

    expect(state.emphases).toEqual([]);
    expect(activeEmphasis(state)).toBeNull();
  });

  it("forgets everything when the view changes", () => {
    let state = publish(onView(), ["write-path"]);
    state = emphasisReducer(state, { type: "view_change", viewId: "request-flow" });

    // The new view's list is fetched fresh; nothing carries over, because an
    // emphasis names ids in the diagram it was published against.
    expect(state.emphases).toEqual([]);
    expect(activeEmphasis(state)).toBeNull();
    expect(state.viewId).toBe("request-flow");
  });

  it("does not disturb the current state when told the same view again", () => {
    const published = publish(onView(), ["write-path"]);
    const same = emphasisReducer(published, { type: "view_change", viewId: VIEW });

    expect(same).toBe(published);
  });

  it("accepts a snapshot only once its view is the one on screen", () => {
    let state = onView(null);
    state = publish(state, ["write-path"]);
    expect(state.emphases).toEqual([]);

    state = emphasisReducer(state, { type: "view_change", viewId: VIEW });
    state = publish(state, ["write-path"]);
    expect(activeEmphasis(state)?.id).toBe("write-path");
  });
});

describe("the emphasis a link names (`?emphasis=<id>`, the agent's stable link, claude-08)", () => {
  const named = (state: EmphasisStoreState, ids: readonly string[], prefer: string) =>
    emphasisReducer(state, { type: "publish", snapshot: snapshot(ids), prefer });

  it("is the one shown when the view's list first arrives, not the newest", () => {
    expect(named(onView(), ["first", "second"], "first").activeId).toBe("first");
  });

  it("gives way to the newest when the list no longer holds it", () => {
    expect(named(onView(), ["first", "second"], "gone").activeId).toBe("second");
  });

  it("decides nothing once the list is known: an agent's new emphasis still takes the canvas", () => {
    const known = named(onView(), ["first"], "first");
    expect(named(known, ["first", "second"], "first").activeId).toBe("second");
  });
});
